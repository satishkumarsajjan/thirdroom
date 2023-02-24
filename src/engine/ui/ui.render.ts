// typedefs: https://github.com/facebook/yoga/blob/main/javascript/src_js/wrapAsm.d.ts
import Yoga from "@react-pdf/yoga";
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { Scene } from "three";

import { defineModule, getModule, registerMessageHandler, Thread } from "../module/module.common";
import { RenderThreadState } from "../renderer/renderer.render";
import { RenderNode, RenderUICanvas, RenderUIFlex } from "../resource/resource.render";
import { createDisposables } from "../utils/createDisposables";
import { updateTransformFromNode } from "../node/node.render";
import {
  UICanvasInteractionMessage,
  UIDoneDrawingMessage,
  traverseUIFlex,
  WebSGUIMessage,
  UIButtonPressMessage,
} from "./ui.common";
import { getLocalResource } from "../resource/resource.render";

export const WebSGUIModule = defineModule<
  RenderThreadState,
  {
    imgCache: Map<number, HTMLImageElement>;
  }
>({
  name: "MainWebSGUI",
  create: async () => {
    return {
      imgCache: new Map(),
    };
  },
  async init(ctx: RenderThreadState) {
    return createDisposables([registerMessageHandler(ctx, WebSGUIMessage.CanvasInteraction, onButtonPress)]);
  },
});

function onButtonPress(ctx: RenderThreadState, message: UICanvasInteractionMessage): void {
  const uiCanvas = getLocalResource<RenderUICanvas>(ctx, message.uiCanvasEid);
  if (uiCanvas) {
    const { pixelDensity, width, height, root } = uiCanvas;

    const x = message.hitPoint[0] * pixelDensity + (width * pixelDensity) / 2;
    const y = -(message.hitPoint[1] * pixelDensity - (height * pixelDensity) / 2);

    // TODO: optimize
    traverseUIFlex(root, (child) => {
      const layout = child.yogaNode.getComputedLayout();

      // if x and y is within this button's bounds, register a hit
      if (
        child.button &&
        x > layout.left &&
        x < layout.left + layout.width &&
        y > layout.top &&
        y < layout.top + layout.height
      ) {
        ctx.sendMessage<UIButtonPressMessage>(Thread.Game, {
          type: WebSGUIMessage.ButtonPress,
          buttonEid: child.button.eid,
        });

        return false;
      }
    });
  }
}

function drawNode(ctx2d: CanvasRenderingContext2D, imgCache: Map<number, HTMLImageElement>, node: RenderUIFlex) {
  if (!node.yogaNode) {
    console.warn("yoga node not found for eid", node.eid);
    return;
  }

  // setup brush
  ctx2d.fillStyle = node.backgroundColor || "white";
  ctx2d.strokeStyle = node.strokeColor || "black";
  ctx2d.globalAlpha = node.opacity !== undefined ? node.opacity : 1;

  // draw layout
  const layout = node.yogaNode.getComputedLayout();
  if (node.backgroundColor) ctx2d.fillRect(layout.left, layout.top, layout.width, layout.height);
  if (node.strokeColor) ctx2d.strokeRect(layout.left, layout.top, layout.width, layout.height);

  // draw image
  if (node.image && node.image.source && node.image.source.bufferView) {
    let img = node.image.domElement;

    if (!img) {
      img = new Image();

      const ab = new ArrayBuffer(node.image.source.bufferView.byteLength);
      const view = new Uint8ClampedArray(ab);
      view.set(new Uint8ClampedArray(node.image.source.bufferView.buffer.data));

      const blob = new Blob([ab]);

      img.src = URL.createObjectURL(blob);
      node.image.domElement = img;
      imgCache.set(node.image.eid, img);
    }

    if (img && img.complete) {
      ctx2d.drawImage(img, layout.left, layout.top, layout.width, layout.height);
    }
  }

  // draw text
  if (node.text) {
    ctx2d.textBaseline = "top";
    ctx2d.font = `${node.text.fontStyle} ${node.text.fontWeight} ${node.text.fontSize || 12}px ${
      node.text.fontFamily || "sans-serif"
    }`.trim();
    ctx2d.fillStyle = node.text.color || "black";
    ctx2d.fillText(node.text.value, layout.left + node.paddingLeft, layout.top + node.paddingTop);
  }

  // TODO
  // if (node.button) {
  // }

  ctx2d.globalAlpha = 1;

  return ctx2d;
}

function updateYogaNode(child: RenderUIFlex) {
  child.yogaNode.setFlexDirection(child.flexDirection);

  child.yogaNode.setWidth(child.width);
  child.yogaNode.setHeight(child.height);

  child.yogaNode.setPadding(Yoga.EDGE_TOP, child.paddingTop);
  child.yogaNode.setPadding(Yoga.EDGE_BOTTOM, child.paddingBottom);
  child.yogaNode.setPadding(Yoga.EDGE_LEFT, child.paddingLeft);
  child.yogaNode.setPadding(Yoga.EDGE_RIGHT, child.paddingRight);

  child.yogaNode.setMargin(Yoga.EDGE_TOP, child.marginTop);
  child.yogaNode.setMargin(Yoga.EDGE_BOTTOM, child.marginBottom);
  child.yogaNode.setMargin(Yoga.EDGE_LEFT, child.marginLeft);
  child.yogaNode.setMargin(Yoga.EDGE_RIGHT, child.marginRight);
}

export function updateNodeUICanvas(ctx: RenderThreadState, scene: Scene, node: RenderNode) {
  const { imgCache } = getModule(ctx, WebSGUIModule);

  const currentUICanvasResourceId = node.currentUICanvasResourceId;
  const nextUICanvasResourceId = node.uiCanvas?.eid || 0;

  // if uiCanvas changed
  if (currentUICanvasResourceId !== nextUICanvasResourceId && node.uiCanvas) {
    // teardown
    if (node.uiCanvas.root.yogaNode) {
      if (node.uiCanvas.root.yogaNode) Yoga.Node.destroy(node.uiCanvas.root.yogaNode);
      traverseUIFlex(node.uiCanvas.root, (child) => {
        if (child.yogaNode) {
          Yoga.Node.destroy(child.yogaNode);
        }
        imgCache.delete(child.eid);
      });
    }
  }

  node.currentUICanvasResourceId = nextUICanvasResourceId;

  if (!node.uiCanvas) {
    return;
  }

  // create

  const uiCanvas = node.uiCanvas;

  if (!node.uiCanvasMesh || !uiCanvas.canvas) {
    uiCanvas.canvas = document.createElement("canvas");
    uiCanvas.canvas.width = uiCanvas.root.width;
    uiCanvas.canvas.height = uiCanvas.root.height;

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

  if (uiCanvas.needsRedraw) {
    const ctx2d = uiCanvas.canvas.getContext("2d")!;

    ctx2d.clearRect(0, 0, uiCanvas.root.width, uiCanvas.root.height);

    // calculate layout
    uiCanvas.root.yogaNode.calculateLayout(uiCanvas.root.width, uiCanvas.root.height, Yoga.DIRECTION_LTR);

    // draw root
    drawNode(ctx2d, imgCache, uiCanvas.root);

    // draw children
    traverseUIFlex(uiCanvas.root, (child) => {
      drawNode(ctx2d, imgCache, child);
    });

    (node.uiCanvasMesh.material as MeshBasicMaterial).map!.needsUpdate = true;

    // flip needsRedraw to false only after all images have loaded to ensure they are drawn
    let allImagesLoaded = true;
    for (const [, img] of imgCache) {
      if (!img.complete) {
        allImagesLoaded = false;
        break;
      }
    }
    if (allImagesLoaded) {
      ctx.sendMessage<UIDoneDrawingMessage>(Thread.Game, {
        type: WebSGUIMessage.DoneDrawing,
        uiCanvasEid: uiCanvas.eid,
      });
    }
  }

  // update the canvas mesh transform with the node's
  updateTransformFromNode(ctx, node, node.uiCanvasMesh);
}
