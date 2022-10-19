import { addComponent, addEntity, defineComponent, defineQuery, enterQuery, Types } from "bitecs";
import { mat4, vec3 } from "gl-matrix";
import { radToDeg } from "three/src/math/MathUtils";

import {
  addChild,
  addTransformComponent,
  getForwardVector,
  getPitch,
  getRoll,
  Transform,
} from "../../engine/component/transform";
import { GameState } from "../../engine/GameTypes";
import { defineModule, getModule, registerMessageHandler } from "../../engine/module/module.common";
import { projectPerspective } from "../../engine/camera/camera.game";
import { NetworkModule, ownedPlayerQuery } from "../../engine/network/network.game";
import { RendererModule } from "../../engine/renderer/renderer.game";
import { addRemoteNodeComponent, RemoteNodeComponent } from "../../engine/node/node.game";
import { NametagsEnableMessage, NametagsEnableMessageType } from "./nametags.common";
import { createRemoteNametag } from "../../engine/nametag/nametag.game";

type NametagState = {
  enabled: boolean;
};

export const NametagModule = defineModule<GameState, NametagState>({
  name: "nametags",
  create() {
    return {
      enabled: false,
    };
  },
  init(ctx) {
    return registerMessageHandler(ctx, NametagsEnableMessage, onNametagsEnabledMessage);
  },
});

function onNametagsEnabledMessage(ctx: GameState, message: NametagsEnableMessageType) {
  const nametagModule = getModule(ctx, NametagModule);
  nametagModule.enabled = message.enabled;
}
export const NametagComponent = defineComponent({
  entity: Types.eid,
});
const nametagQuery = defineQuery([NametagComponent]);
const enteredNametagQuery = enterQuery(nametagQuery);

const _v = vec3.create();
const _t = vec3.create();
const _forward = vec3.create();

export function NametagSystem(ctx: GameState) {
  const network = getModule(ctx, NetworkModule);
  const renderer = getModule(ctx, RendererModule);
  const nametagModule = getModule(ctx, NametagModule);

  if (nametagModule.enabled) {
    const ourPlayer = ownedPlayerQuery(ctx.world)[0];
    const ourWorldPosition = Transform.position[ourPlayer];

    const entered = enteredNametagQuery(ctx.world);
    for (let i = 0; i < entered.length; i++) {
      const eid = entered[i];
      const player = NametagComponent.entity[eid];

      const peerId = network.entityIdToPeerId.get(player);

      if (!peerId) {
        console.warn("could not add nametag resource, no peerId for entity: ", eid);
        continue;
      }

      console.log("addRemoteNodeComponent createRemoteNametag", peerId);
      addRemoteNodeComponent(ctx, player, {
        nametag: createRemoteNametag(ctx, {
          name: peerId,
        }),
      });
    }

    const nametagEnts = nametagQuery(ctx.world);
    for (let i = 0; i < nametagEnts.length; i++) {
      const nametag = nametagEnts[i];
      const player = NametagComponent.entity[nametag];

      // projection to camera space
      const nametagWorldPosition = mat4.getTranslation(_v, Transform.worldMatrix[nametag]);
      const projected = projectPerspective(ctx, ctx.activeCamera, nametagWorldPosition);

      const peerId = network.entityIdToPeerId.get(player);
      if (peerId === undefined) {
        console.warn("could not find peerId for entityId " + nametag);
        continue;
      }

      const dist = vec3.dist(nametagWorldPosition, ourWorldPosition);

      const quaternion = Transform.quaternion[ourPlayer];
      const pitch = getPitch(quaternion);
      const roll = getRoll(quaternion);
      const forward = getForwardVector(_forward, pitch, roll);

      const target = vec3.sub(_t, nametagWorldPosition, ourWorldPosition);
      vec3.normalize(target, target);

      const dot = vec3.dot(target, forward);
      const angle = radToDeg(Math.acos(dot));

      const remoteNode = RemoteNodeComponent.get(player);
      if (remoteNode === undefined) throw new Error("could not find remote node for player " + peerId);
      if (remoteNode.nametag === undefined) throw new Error("could not find nametag resource for player " + peerId);

      if (angle < 100) {
        // projection to screenspace
        const screenX = Math.round((0.5 + projected[0] / 2) * renderer.canvasWidth);
        const screenY = Math.round((0.5 - projected[1] / 2) * renderer.canvasHeight);

        remoteNode.nametag.screenX = screenX;
        remoteNode.nametag.screenY = screenY;
        remoteNode.nametag.distanceFromCamera = dist;
        remoteNode.nametag.inFrustum = true;
      } else {
        remoteNode.nametag.screenX = NaN;
        remoteNode.nametag.screenY = NaN;
        remoteNode.nametag.distanceFromCamera = dist;
        remoteNode.nametag.inFrustum = false;
      }
    }
  }
}

export function addNametag(ctx: GameState, height: number, container: number) {
  const nametagAnchor = addEntity(ctx.world);
  addTransformComponent(ctx.world, nametagAnchor);
  addComponent(ctx.world, NametagComponent, nametagAnchor);
  Transform.position[nametagAnchor].set([0, height + height / 1.5, 0]);
  addChild(container, nametagAnchor);
  NametagComponent.entity[nametagAnchor] = container;
}
