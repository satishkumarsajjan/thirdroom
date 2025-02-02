// typedefs: https://github.com/facebook/yoga/blob/main/javascript/src_js/wrapAsm.d.ts
import Yoga from "@react-pdf/yoga";
import { CanvasTexture, Material, Mesh, MeshBasicMaterial, PlaneGeometry, Texture } from "three";
import { Scene } from "three";
import { vec3 } from "gl-matrix";

import { defineModule, getModule, registerMessageHandler, Thread } from "../module/module.common";
import { RenderThreadState } from "../renderer/renderer.render";
import {
  RenderImage,
  RenderNode,
  RenderUIButton,
  RenderUICanvas,
  RenderUIFlex,
  RenderUIText,
} from "../resource/resource.render";
import { createDisposables } from "../utils/createDisposables";
import { updateTransformFromNode } from "../node/node.render";
import {
  UIButtonFocusMessage,
  UIButtonPressMessage,
  UIButtonUnfocusMessage,
  UICanvasFocusMessage,
  UICanvasPressMessage,
  WebSGUIMessage,
} from "./ui.common";
import { getLocalResource } from "../resource/resource.render";
import { RenderImageDataType } from "../utils/textures";
import { LoadStatus } from "../resource/resource.common";
import { FlexEdge } from "../resource/schema";

export const WebSGUIModule = defineModule<
  RenderThreadState,
  {
    loadingImages: Set<RenderImage>;
    loadingText: Set<RenderUIText>;
  }
>({
  name: "MainWebSGUI",
  create: async () => {
    return {
      loadingImages: new Set(),
      // HACK: figure out why sometimes text.value is undefined
      loadingText: new Set(),
    };
  },
  async init(ctx: RenderThreadState) {
    return createDisposables([
      registerMessageHandler(ctx, WebSGUIMessage.CanvasPress, onCanvasPressed),
      registerMessageHandler(ctx, WebSGUIMessage.CanvasFocus, onCanvasFocused),
    ]);
  },
});

export function traverseUIFlex(node: RenderUIFlex, callback: (child: RenderUIFlex, index: number) => boolean | void) {
  let curChild = node.firstChild;
  let i = 0;

  while (curChild) {
    const continueTraversal = callback(curChild, i++) !== false;
    if (continueTraversal) {
      traverseUIFlex(curChild, callback);
      curChild = curChild.nextSibling;
    } else {
      return;
    }
  }
}

function findHitButton(uiCanvas: RenderUICanvas, hitPoint: vec3): RenderUIButton | undefined {
  const { pixelDensity, width, height, root } = uiCanvas;

  const x = hitPoint[0] * pixelDensity + (width * pixelDensity) / 2;
  const y = -(hitPoint[1] * pixelDensity - (height * pixelDensity) / 2);

  let button;

  traverseUIFlex(root, (child) => {
    // TODO: iterate over array of buttons instead of traversing entire graph looking for buttons
    if (!child.button) return true;

    // if x and y is within this button's bounds, register a hit
    const layout = child.yogaNode.getComputedLayout();

    let parent = child.parent;
    while (parent) {
      const parentLayout = parent.yogaNode.getComputedLayout();
      layout.top += parentLayout.top;
      layout.left += parentLayout.left;
      parent = parent.parent;
    }

    if (x > layout.left && x < layout.left + layout.width && y > layout.top && y < layout.top + layout.height) {
      button = child.button;
      return false;
    }
  });

  return button;
}

function onCanvasFocused(ctx: RenderThreadState, message: UICanvasFocusMessage): void {
  const uiCanvas = getLocalResource<RenderUICanvas>(ctx, message.uiCanvasEid);
  if (!uiCanvas) {
    console.warn("Could not find UI canvas for eid", message.uiCanvasEid);
    return;
  }

  const button = findHitButton(uiCanvas, message.hitPoint);
  if (!button) {
    ctx.sendMessage<UIButtonUnfocusMessage>(Thread.Game, {
      type: WebSGUIMessage.ButtonUnfocus,
    });
    return;
  }

  ctx.sendMessage<UIButtonFocusMessage>(Thread.Game, {
    type: WebSGUIMessage.ButtonFocus,
    buttonEid: button.eid,
  });
}

function onCanvasPressed(ctx: RenderThreadState, message: UICanvasPressMessage): void {
  const uiCanvas = getLocalResource<RenderUICanvas>(ctx, message.uiCanvasEid);
  if (!uiCanvas) {
    console.warn("Could not find UI canvas for eid", message.uiCanvasEid);
    return;
  }

  const button = findHitButton(uiCanvas, message.hitPoint);
  if (!button) return;

  ctx.sendMessage<UIButtonPressMessage>(Thread.Game, {
    type: WebSGUIMessage.ButtonPress,
    buttonEid: button.eid,
  });
}

const rgbaToString = ([r, g, b, a]: Float32Array) => `rgba(${r * 255},${g * 255},${b * 255},${a})`;

function drawNode(
  ctx2d: OffscreenCanvasRenderingContext2D,
  loadingImages: Set<RenderImage>,
  loadingText: Set<RenderUIText>,
  node: RenderUIFlex
) {
  if (!node.yogaNode) {
    console.warn("yoga node not found for eid", node.eid);
    return;
  }

  // setup brush
  ctx2d.fillStyle = rgbaToString(node.backgroundColor);
  ctx2d.strokeStyle = rgbaToString(node.borderColor);

  // draw layout
  const layout = node.yogaNode.getComputedLayout();

  // HACK?: crawl up the parent chain to calculate global top & left values, unsure if necessary or bug in yoga
  let parent = node.parent;
  while (parent) {
    const parentLayout = parent.yogaNode.getComputedLayout();
    layout.top += parentLayout.top;
    layout.left += parentLayout.left;
    parent = parent.parent;
  }

  if (node.backgroundColor) ctx2d.fillRect(layout.left, layout.top, layout.width, layout.height);
  if (node.borderColor) ctx2d.strokeRect(layout.left, layout.top, layout.width, layout.height);

  // draw image
  if (node.image) {
    if (!node.image.source.imageData || node.image.source.loadStatus !== LoadStatus.Loaded) {
      loadingImages.add(node.image.source);
    } else if (node.image.source.imageData.type === RenderImageDataType.ImageBitmap) {
      loadingImages.delete(node.image.source);
      ctx2d.drawImage(
        node.image.source.imageData.data as ImageBitmap,
        layout.left,
        layout.top,
        layout.width,
        layout.height
      );
    }
  }

  // draw text
  if (node.text) {
    if (node.text.value === undefined) {
      loadingText.add(node.text);
    } else {
      loadingText.delete(node.text);
      ctx2d.textBaseline = "top";
      ctx2d.font = `${node.text.fontStyle} ${node.text.fontWeight} ${node.text.fontSize || 12}px ${
        node.text.fontFamily || "sans-serif"
      }`.trim();
      ctx2d.fillStyle = rgbaToString(node.text.color);
      ctx2d.fillText(
        node.text.value,
        layout.left + node.padding[FlexEdge.LEFT],
        layout.top + node.padding[FlexEdge.TOP]
      );
    }
  }

  // TODO
  // if (node.button) {
  // }

  return ctx2d;
}

function updateYogaNode(child: RenderUIFlex) {
  child.yogaNode.setFlexDirection(child.flexDirection);

  child.yogaNode.setWidth(child.width);
  child.yogaNode.setHeight(child.height);

  child.yogaNode.setPadding(FlexEdge.LEFT, child.padding[FlexEdge.LEFT]);
  child.yogaNode.setPadding(FlexEdge.TOP, child.padding[FlexEdge.TOP]);
  child.yogaNode.setPadding(FlexEdge.RIGHT, child.padding[FlexEdge.RIGHT]);
  child.yogaNode.setPadding(FlexEdge.BOTTOM, child.padding[FlexEdge.BOTTOM]);

  child.yogaNode.setMargin(FlexEdge.LEFT, child.margin[FlexEdge.LEFT]);
  child.yogaNode.setMargin(FlexEdge.TOP, child.margin[FlexEdge.TOP]);
  child.yogaNode.setMargin(FlexEdge.RIGHT, child.margin[FlexEdge.RIGHT]);
  child.yogaNode.setMargin(FlexEdge.BOTTOM, child.margin[FlexEdge.BOTTOM]);

  // TODO: add remainder of Yoga.Node API
  child.yogaNode.setPositionType(Yoga.POSITION_TYPE_RELATIVE);
  child.yogaNode.setJustifyContent(Yoga.JUSTIFY_FLEX_START);
}

export function updateNodeUICanvas(ctx: RenderThreadState, scene: Scene, node: RenderNode) {
  const currentUICanvasResourceId = node.currentUICanvasResourceId;
  const nextUICanvasResourceId = node.uiCanvas?.eid || 0;

  // if uiCanvas changed
  if (currentUICanvasResourceId !== nextUICanvasResourceId && node.uiCanvas) {
    // teardown
    if (node.uiCanvas.root) {
      if (node.uiCanvas.root.yogaNode) Yoga.Node.destroy(node.uiCanvas.root.yogaNode);
      traverseUIFlex(node.uiCanvas.root, (child) => {
        if (child.yogaNode) {
          Yoga.Node.destroy(child.yogaNode);
        }
      });
    }
    if (node.uiCanvasMesh) {
      scene.remove(node.uiCanvasMesh);
      node.uiCanvasMesh.geometry.dispose();
      (node.uiCanvasMesh.material as MeshBasicMaterial & { map: Texture }).map.dispose();
      (node.uiCanvasMesh.material as Material).dispose();
      node.uiCanvasMesh = undefined;
    }
  }

  node.currentUICanvasResourceId = nextUICanvasResourceId;

  if (!node.uiCanvas || !node.uiCanvas.root) {
    return;
  }

  // create

  const uiCanvas = node.uiCanvas;

  if (!node.uiCanvasMesh || !uiCanvas.canvas) {
    uiCanvas.canvas = new OffscreenCanvas(uiCanvas.root.width, uiCanvas.root.height);

    // create & update root yoga node
    uiCanvas.root.yogaNode = Yoga.Node.create();
    updateYogaNode(uiCanvas.root);

    // traverse root, create & update yoga nodes
    traverseUIFlex(uiCanvas.root, (child, i) => {
      child.yogaNode = Yoga.Node.create();

      // if not root
      if (child.parent) {
        // attach to parent
        child.parent.yogaNode.insertChild(child.yogaNode, i);
      }

      updateYogaNode(child);
    });

    uiCanvas.canvasTexture = new CanvasTexture(uiCanvas.canvas);

    node.uiCanvasMesh = new Mesh(
      new PlaneGeometry(uiCanvas.width, uiCanvas.height),
      new MeshBasicMaterial({ map: uiCanvas.canvasTexture, transparent: true })
    );

    scene.add(node.uiCanvasMesh);
  }

  // update

  const { loadingImages, loadingText } = getModule(ctx, WebSGUIModule);

  if (uiCanvas.redraw > uiCanvas.lastRedraw) {
    const ctx2d = uiCanvas.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

    ctx2d.clearRect(0, 0, uiCanvas.root.width, uiCanvas.root.height);

    // calculate layout
    uiCanvas.root.yogaNode.calculateLayout(uiCanvas.root.width, uiCanvas.root.height, Yoga.DIRECTION_LTR);

    // draw root
    drawNode(ctx2d, loadingImages, loadingText, uiCanvas.root);

    // draw children
    traverseUIFlex(uiCanvas.root, (child) => {
      drawNode(ctx2d, loadingImages, loadingText, child);
    });

    (node.uiCanvasMesh.material as MeshBasicMaterial & { map: Texture }).map.needsUpdate = true;

    // only stop rendering when all images have loaded
    if (loadingImages.size === 0 && loadingText.size === 0) {
      uiCanvas.lastRedraw = uiCanvas.redraw;
    }
  }

  // update the canvas mesh transform with the node's
  updateTransformFromNode(ctx, node, node.uiCanvasMesh);
}
