import { Matrix4, Quaternion, Vector3 } from "three";

import { NOOP } from "../config.common";
import { IMainThreadContext } from "../MainThread";
import { defineModule, getModule, registerMessageHandler, Thread } from "../module/module.common";
import {
  AudioMessageType,
  InitializeAudioTransformsMessage,
  PlayAudioMessage,
  SetAudioListenerMessage,
  SetAudioPeerEntityMessage,
  SharedAudioTransforms,
} from "./audio.common";
import { getReadObjectBufferView } from "../allocator/ObjectBufferView";

/*********
 * Types *
 ********/

export interface AudioModuleState {
  context: AudioContext;
  sharedAudioTransforms: SharedAudioTransforms;
  entityPanners: Map<number, PannerNode>;
  listenerEntity: number;
  peerEntities: Map<string, number>;
  peerMediaStreamSourceMap: Map<string, MediaStreamAudioSourceNode>;
  main: {
    gain: GainNode;
  };
  sample: {
    gain: GainNode;
    cache: Map<string, AudioBuffer>;
    queue: [string, number?][];
  };
}

/******************
 * Initialization *
 *****************/

// todo: MixerTrack/MixerInsert interface
/*
┌────────┐
│  out   │ audio context destination
│        │
└─L────R─┘
  ▲    ▲
┌────────┐
│ main   │ main channel volume
│ gain   │ todo: connect to reverb send track
└─L────R─┘
  ▲    ▲
┌────────┐
│ sample │ sample channel volume
│ gain   │
└─L────R─┘
 */

export const AudioModule = defineModule<IMainThreadContext, AudioModuleState>({
  name: "audio",
  async create(ctx, { waitForMessage }) {
    const audioCtx = new AudioContext();

    const mainGain = new GainNode(audioCtx);
    mainGain.connect(audioCtx.destination);

    const sampleGain = new GainNode(audioCtx);
    sampleGain.connect(mainGain);

    const sampleCache = new Map<string, AudioBuffer>();

    const entityPanners = new Map<number, PannerNode>();

    const sampleQueue: [string, number][] = [];

    const { sharedAudioTransforms } = await waitForMessage<InitializeAudioTransformsMessage>(
      Thread.Game,
      AudioMessageType.InitializeAudioTransforms
    );

    return {
      context: audioCtx,
      sharedAudioTransforms,
      entityPanners,
      listenerEntity: NOOP,
      peerEntities: new Map(),
      peerMediaStreamSourceMap: new Map(),
      main: {
        gain: mainGain,
      },
      sample: {
        gain: sampleGain,
        cache: sampleCache,
        queue: sampleQueue,
      },
    };
  },
  init(ctx) {
    const audio = getModule(ctx, AudioModule);

    preloadDefaultAudio(audio);

    const disposables = [
      registerMessageHandler(ctx, AudioMessageType.PlayAudio, onPlayAudio),
      registerMessageHandler(ctx, AudioMessageType.SetAudioListener, onSetAudioListener),
      registerMessageHandler(ctx, AudioMessageType.SetAudioPeerEntity, onSetAudioPeerEntity),
    ];

    return () => {
      audio.context.close();

      for (const dispose of disposables) {
        dispose();
      }
    };
  },
});

/*********
 * Utils *
 ********/

/* 
Adds a new PannerNode for an entity to enable audio emissions from that particular entity.

┌────────┐
│ sample │
│ gain   │
└─L────R─┘
  ▲    ▲
┌────────┐
│ panner │
│ node   │
└─L────R─┘
 */
export const addEntityPanner = (
  audioState: AudioModuleState,
  eid: number,
  panner: PannerNode = new PannerNode(audioState.context)
) => {
  panner.panningModel = "HRTF";
  panner.connect(audioState.sample.gain);
  audioState.entityPanners.set(eid, panner);
  return panner;
};

export const preloadDefaultAudio = async (
  audioState: AudioModuleState,
  defaultAudioFiles: string[] = ["/audio/bach.mp3", "/audio/hit.wav"]
) => {
  defaultAudioFiles.forEach(async (file) => await getAudioBuffer(audioState, file));
};

const isChrome = !!window.chrome;

export const setPeerMediaStream = (audioState: AudioModuleState, peerId: string, mediaStream: MediaStream) => {
  // https://bugs.chromium.org/p/chromium/issues/detail?id=933677
  if (isChrome) {
    const audioEl = new Audio();
    audioEl.srcObject = mediaStream;
    audioEl.setAttribute("autoplay", "autoplay");
    audioEl.muted = true;
  }

  const mediaStreamSource = audioState.context.createMediaStreamSource(mediaStream);
  audioState.peerMediaStreamSourceMap.set(peerId, mediaStreamSource);
};

export const fetchAudioBuffer = async (ctx: AudioContext, filepath: string) => {
  const response = await fetch(filepath);
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return audioBuffer;
};

export const getAudioBuffer = async (
  { context, sample: { cache } }: AudioModuleState,
  filepath: string
): Promise<AudioBuffer> => {
  if (cache.has(filepath)) return cache.get(filepath) as AudioBuffer;

  const audioBuffer = await fetchAudioBuffer(context, filepath);
  cache.set(filepath, audioBuffer);

  return audioBuffer;
};

const rndRange = (min: number, max: number) => Math.random() * (max - min) + min;

export const playAudioBuffer = (
  { context, sample: { gain } }: AudioModuleState,
  audioBuffer: AudioBuffer,
  out: AudioNode = gain
) => {
  const sampleSource = context.createBufferSource();
  sampleSource.buffer = audioBuffer;
  sampleSource.playbackRate.value = rndRange(0.25, 0.75);
  sampleSource.connect(out);
  sampleSource.start();
  return sampleSource;
};

export const playAudioAtEntity = async (audioState: AudioModuleState, filepath: string, eid: number) => {
  const audioBuffer = await getAudioBuffer(audioState, filepath);
  if (audioBuffer) {
    let panner = audioState.entityPanners.get(eid);
    if (!panner) panner = addEntityPanner(audioState, eid);
    playAudioBuffer(audioState, audioBuffer, panner);
  } else console.error(`error: could not play audio ${filepath} - audio buffer not found`);
};

/********************
 * Message Handlers *
 *******************/

export const onPlayAudio = async (mainThread: IMainThreadContext, message: PlayAudioMessage) => {
  const audio = getModule(mainThread, AudioModule);
  const { filepath, eid } = message;

  if (eid !== NOOP) {
    playAudioAtEntity(audio, filepath, eid);
    return;
  }
  const audioBuffer = await getAudioBuffer(audio, filepath);
  if (audioBuffer) playAudioBuffer(audio, audioBuffer);
  else console.error(`error: could not play audio ${filepath} - audio buffer not found`);
};

// sets the entity that the listener is positioned at
export const onSetAudioListener = (mainThread: IMainThreadContext, message: SetAudioListenerMessage) => {
  const audio = getModule(mainThread, AudioModule);
  audio.listenerEntity = message.eid;
};

/*
Connects a MediaStream to an entity's PannerNode to enable spatial VoIP

┌────────┐
│ panner │
│ node   │
└─L────R─┘
  ▲    ▲
┌────────┐
│ media  │
│ stream │
└─L────R─┘
 */
export const onSetAudioPeerEntity = (mainThread: IMainThreadContext, message: SetAudioPeerEntityMessage) => {
  const audioModule = getModule(mainThread, AudioModule);
  const { peerId, eid } = message;

  audioModule.peerEntities.set(peerId, eid);

  const mediaStreamSource = audioModule.peerMediaStreamSourceMap.get(peerId);
  if (!mediaStreamSource)
    return console.error("could not setAudioPeerEntity - mediaStreamSource not found for peer", peerId);

  let panner = audioModule.entityPanners.get(eid);
  if (!panner) panner = addEntityPanner(audioModule, eid);

  mediaStreamSource.connect(panner);
};

/***********
 * Systems *
 **********/

const tempMatrix4 = new Matrix4();
const tempPosition = new Vector3();
const tempQuaternion = new Quaternion();
const tempScale = new Vector3();
export function MainThreadAudioSystem(mainThread: IMainThreadContext) {
  const audioModule = getModule(mainThread, AudioModule);

  if (audioModule.listenerEntity === NOOP) {
    return audioModule;
  }

  const Transform = getReadObjectBufferView(audioModule.sharedAudioTransforms);

  tempMatrix4
    .fromArray(Transform.worldMatrix[audioModule.listenerEntity])
    .decompose(tempPosition, tempQuaternion, tempScale);

  if (isNaN(tempQuaternion.x)) {
    return audioModule;
  }

  const { listener } = audioModule.context;

  if (listener.upX) {
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;
  }

  if (listener.positionX) {
    listener.positionX.value = tempPosition.x;
    listener.positionY.value = tempPosition.y;
    listener.positionZ.value = tempPosition.z;
  } else {
    listener.setPosition(tempPosition.x, tempPosition.y, tempPosition.z);
  }

  const e = tempMatrix4.elements;
  const v = tempPosition.set(-e[8], -e[9], -e[10]).normalize();
  if (listener.forwardX) {
    listener.forwardX.value = v.x;
    listener.forwardY.value = v.y;
    listener.forwardZ.value = v.z;
  } else {
    listener.setOrientation(v.x, v.y, v.z, 0, 1, 0);
  }

  audioModule.entityPanners.forEach((panner, eid) => {
    const { currentTime } = audioModule.context;

    tempMatrix4.fromArray(Transform.worldMatrix[eid]).decompose(tempPosition, tempQuaternion, tempScale);

    panner.positionX.setValueAtTime(tempPosition.x, currentTime);
    panner.positionY.setValueAtTime(tempPosition.y, currentTime);
    panner.positionZ.setValueAtTime(tempPosition.z, currentTime);
  });
}
