import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  type VRMAnimation,
  VRMAnimationLoaderPlugin,
} from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { MOUTH_KEYS, MOUTH_WEIGHTS } from "./constants";

export interface VrmSceneStatus {
  ready: boolean;
  loading: boolean;
  /** False when the model exposes none of the VRM mouth expressions. */
  mouthSupported: boolean;
  error: string | null;
}

const IDLE_SWAY_RADIANS = 0.05;
const IDLE_BOB_METERS = 0.008;
const MOUTH_SMOOTHING = 18;
const BLINK_MIN_INTERVAL_MS = 2600;
const BLINK_MAX_INTERVAL_MS = 6200;
const BLINK_DURATION_MS = 130;

/**
 * Arms-down relaxation steps. Many VRM tools (notably VRoid) export a default
 * "presentation" rest pose with the arms held out horizontally. We rotate each
 * upper arm down until the hand hangs vertically under its own shoulder, so the
 * arms lie straight and close to the body instead of a "八" spread.
 */
const RELAX_ARM_STEP_RADIANS = (2 * Math.PI) / 180;
const RELAX_ARM_MAX_STEPS = 90;
/**
 * Stops once the hand's horizontal distance from the vertical plane through its
 * shoulder is within this many metres (i.e. the arm is hanging straight down).
 */
const RELAX_ARM_SPREAD_TOLERANCE = 0.05;

/**
 * Procedural pose motion tuning.
 *
 * Mechanical stiffness comes from waypoint-stepping (ease to a fixed target,
 * plateau, then jump to the next). To read as organic we instead drive every
 * joint with two low-frequency sines at independent phases: the motion is
 * continuous and never snaps. A slow breathing term is layered onto the torso.
 * `GESTURE_SPEAK_BOOST` scales every joint while the avatar is talking.
 */
const GESTURE_SPEAK_BOOST = 1.6;
const GESTURE_FREQ_1_MIN = 0.35;
const GESTURE_FREQ_1_MAX = 0.7;
const GESTURE_FREQ_2_MIN = 1.1;
const GESTURE_FREQ_2_MAX = 1.9;
/** Relative weight of the slow sine vs the faster one (sums to 1). */
const GESTURE_SLOW_WEIGHT = 0.6;
/** Breathing: gentle chest/spine rise-and-fall (rad/s and amplitude). */
const BREATH_FREQ = 1.5;
const BREATH_CHEST_AMP = 0.035;
const BREATH_SPINE_AMP = 0.02;

/** Wheel-to-zoom. 1 = 100% zoomed in, derived from the model's framing. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
/** `zoom` factor applied to the camera distance per wheel unit. */
const ZOOM_WHEEL_SENSITIVITY = 0.0012;
/** Radarians the model turns per pixel of horizontal drag. */
const DRAG_ROTATION_SENSITIVITY = 0.01;
/** World-metres the model moves per pixel, at zoom = 1. */
const DRAG_PAN_SENSITIVITY = 0.006;

interface GestureBone {
  node: THREE.Object3D;
  /** Relaxed base rotation to compose gesture offsets on top of. */
  base: THREE.Euler;
  /** Local axes act as "pose dials"; each entry is [index, amplitude]. */
  axes: Array<[0 | 1 | 2, number]>;
  /** Extra sine amplitude applied to the X axis as a breathing motion. */
  breath: number;
  speaking: boolean;
  phase1: number;
  phase2: number;
  freq1: number;
  freq2: number;
}

function rangeEngine(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeGestureBone(
  node: THREE.Object3D,
  axes: Array<[0 | 1 | 2, number]>,
  options: { speaking?: boolean; breath?: number },
): GestureBone {
  return {
    node,
    base: node.rotation.clone(),
    axes,
    breath: options.breath ?? 0,
    speaking: options.speaking ?? false,
    phase1: Math.random() * Math.PI * 2,
    phase2: Math.random() * Math.PI * 2,
    freq1: rangeEngine(GESTURE_FREQ_1_MIN, GESTURE_FREQ_1_MAX),
    freq2: rangeEngine(GESTURE_FREQ_2_MIN, GESTURE_FREQ_2_MAX),
  };
}

/**
 * A minimal three.js stage for a single VRM model.
 *
 * Deliberately free of React: the component layer only mounts a container and
 * feeds a mouth value, which keeps the render loop, the WebGL context and the
 * model lifecycle out of React's re-render cycle.
 */
export class VrmScene {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 80);
  private readonly clock = new THREE.Clock();
  private readonly rig = new THREE.Group();
  /** Holds the model; rotated by drag so idle sway (on `rig`) never fights it. */
  private readonly modelGroup = new THREE.Group();
  private resizeObserver: ResizeObserver | null = null;
  private container: HTMLElement | null = null;
  private frame = 0;
  private disposed = false;

  private vrm: VRM | null = null;
  private mouthKeys: string[] = [];
  private mouthValue = 0;
  private mouthProvider: (() => number) | null = null;

  private gestures: GestureBone[] = [];

  /** VRMA motion playback state. */
  private animationMixer: THREE.AnimationMixer | null = null;
  private animationAction: THREE.AnimationAction | null = null;
  private animationPlaying = false;
  private currentAnimationUrl: string | null = null;
  private loadAnimationSeq = 0;
  private animationLoadFailed = false;
  /**
   * Local rotation of every humanoid raw bone captured right after load (i.e.
   * the relaxed arms-down rest pose). Storing it lets stopping an animation
   * restore the idle baseline before gestures/sway resume.
   */
  private restPoseBones: Array<{ node: THREE.Object3D; euler: THREE.Euler }> = [];

  private zoom = 1;
  private camCenterY = 0;
  private camHeight = 1.6;
  private camBaseDistance = 2;

  /** Active drag mode: left button pans, right button rotates. */
  private dragMode: "pan" | "rotate" | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartRotationY = 0;
  private dragStartOffsetX = 0;
  private dragStartOffsetY = 0;

  private nextBlinkAt = 0;
  private blinkEndsAt = 0;

  private status: VrmSceneStatus = {
    ready: false,
    loading: false,
    mouthSupported: false,
    error: null,
  };

  constructor(
    private readonly onStatusChange?: (status: VrmSceneStatus) => void,
  ) {
    this.scene.add(this.rig);
    this.rig.add(this.modelGroup);
  }

  getStatus(): VrmSceneStatus {
    return this.status;
  }

  /** True while a VRMA motion is playing. */
  isAnimationPlaying(): boolean {
    return this.animationPlaying;
  }

  /** True if the last requested motion failed to load and playback stopped. */
  isAnimationFailed(): boolean {
    return this.animationLoadFailed;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    try {
      const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      this.renderer = renderer;
    } catch (error) {
      this.patch({ error: describe(error) });
      return;
    }

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(0.4, 1.4, 1.6);
    this.scene.add(key);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    container.addEventListener("wheel", this.handleWheel, { passive: false });
    container.addEventListener("pointerdown", this.handlePointerDown);
    container.addEventListener("pointermove", this.handlePointerMove);
    container.addEventListener("pointerup", this.handlePointerUp);
    container.addEventListener("pointercancel", this.handlePointerUp);
    container.addEventListener("contextmenu", this.handleContextMenu);

    this.scheduleBlink();
    this.loop();
  }

  /**
   * Wheel-to-zoom. `preventDefault` keeps the page from scrolling while the
   * cursor is over the avatar panel; the model is magnified instead.
   */
  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoom = clamp(
      this.zoom * Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY),
      ZOOM_MIN,
      ZOOM_MAX,
    );
    this.applyCamera();
  };

  /** Left-drag pans the model; right-drag rotates it about its vertical axis. */
  private readonly handlePointerDown = (event: PointerEvent): void => {
    const mode = event.button === 2 ? "rotate" : event.button === 0 ? "pan" : null;
    if (!mode) {
      return;
    }
    this.dragMode = mode;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragStartRotationY = this.modelGroup.rotation.y;
    this.dragStartOffsetX = this.modelGroup.position.x;
    this.dragStartOffsetY = this.modelGroup.position.y;
    this.container?.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragMode) {
      return;
    }
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    if (this.dragMode === "rotate") {
      this.modelGroup.rotation.y =
        this.dragStartRotationY + dx * DRAG_ROTATION_SENSITIVITY;
      return;
    }
    // Pan in world space; scale by 1/zoom so the drag stays under the cursor.
    const pan = DRAG_PAN_SENSITIVITY / this.zoom;
    this.modelGroup.position.x = this.dragStartOffsetX + dx * pan;
    this.modelGroup.position.y = this.dragStartOffsetY - dy * pan;
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragMode) {
      return;
    }
    this.dragMode = null;
    try {
      this.container?.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone; nothing to release.
    }
  };

  /** Right-click drag must not open the browser context menu. */
  private readonly handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  /** `source` is either a URL or an uploaded file already read into a Blob. */
  async loadModel(source: string | Blob): Promise<void> {
    let url: string;
    let objectUrl: string | null = null;
    if (typeof source === "string") {
      url = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      url = objectUrl;
    }

    this.patch({ loading: true, error: null });
    try {
      const loader = new GLTFLoader();
      // Must be registered before `loadAsync`.
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      if (this.disposed) {
        return;
      }

      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        throw new Error("not a vrm model");
      }

      // VRM 0.x faces -Z; without this the model shows its back.
      if (vrm.meta?.metaVersion === "0") {
        VRMUtils.rotateVRM0(vrm);
      }
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      // combineSkeletons collapses the skinned meshes into one, after which
      // three's default culling clips the model.
      vrm.scene.traverse((object) => {
        object.frustumCulled = false;
      });

      this.disposeModel();
      this.modelGroup.position.set(0, 0, 0);
      this.modelGroup.rotation.y = 0;
      this.modelGroup.add(vrm.scene);
      this.vrm = vrm;
      this.mouthKeys = detectMouthKeys(vrm);
      this.frameCamera(vrm);
      this.relaxArms(vrm);
      this.snapshotRestPose(vrm);
      this.initGestures(vrm);
      this.patch({
        ready: true,
        loading: false,
        mouthSupported: this.mouthKeys.length > 0,
        error: null,
      });
    } catch (error) {
      this.patch({ loading: false, error: describe(error) });
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  /**
   * Play a bundled VRMA motion by URL, or stop playback when `url` is `null`.
   * Swapping between two motions loads the new clip and starts it immediately.
   * While a motion plays, the procedural gestures and idle sway are paused so
   * the animation reads as authored.
   */
  async setAnimation(url: string | null): Promise<void> {
    if (!url) {
      this.stopAnimation();
      return;
    }
    if (url === this.currentAnimationUrl) {
      return;
    }
    const seq = ++this.loadAnimationSeq;
    // The model may not be ready yet (setAnimation can be called before the
    // VRM finishes loading); defer by returning, the caller re-applies on load.
    if (!this.vrm) {
      return;
    }
    this.animationLoadFailed = false;
    try {
      const animation = await this.loadVRMA(url);
      if (seq !== this.loadAnimationSeq || this.disposed || !this.vrm) {
        return;
      }
      this.playAnimationClip(animation, url);
    } catch (error) {
      if (seq !== this.loadAnimationSeq) {
        return;
      }
      this.animationLoadFailed = true;
      this.stopAnimation();
      console.error("Failed to load avatar motion", url, describe(error));
    }
  }

  private async loadVRMA(url: string): Promise<VRMAnimation> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const loadSeq = this.loadAnimationSeq;
    const gltf = await loader.loadAsync(url);
    if (this.disposed || loadSeq !== this.loadAnimationSeq) {
      throw new Error("aborted");
    }
    const animations = (gltf.userData as { vrmAnimations?: VRMAnimation[] })
      .vrmAnimations;
    const animation = animations?.[0];
    if (!animation) {
      throw new Error("no motion in vrma");
    }
    return animation;
  }

  /**
   * Bind the just-loaded motion to the model and start it. Only humanoid bone
   * tracks are used so the existing blink/mouth expression pipeline is not
   * clobbered by the animation (these motion packs carry no facial tracks).
   *
   * The VRMA motion is applied straight onto the RAW humanoid bones (the model
   * is driven without `autoUpdateHumanBones` so gestures may touch the same
   * bones), so the keyframe tracks are re-targeted from the throw-away
   * `Normalized_*` rig nodes to their raw counterparts.
   */
  private playAnimationClip(animation: VRMAnimation, url: string): void {
    const vrm = this.vrm;
    const humanoid = vrm?.humanoid;
    if (!vrm || !humanoid) {
      return;
    }
    const metaVersion = vrm.meta.metaVersion;
    const tracks: THREE.KeyframeTrack[] = [];

    for (const [name, track] of animation.humanoidTracks.translation) {
      const raw = humanoid.getRawBoneNode(name);
      if (!raw) {
        continue;
      }
      const animationHipsY = animation.restHipsPosition.y;
      const humanoidHipsY = humanoid.normalizedRestPose.hips?.position?.[1];
      const scale =
        animationHipsY > 0 && humanoidHipsY ? humanoidHipsY / animationHipsY : 1;
      const values = track.values.map((value, index) =>
        (metaVersion === "0" && index % 3 !== 1 ? -value : value) * scale,
      );
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${raw.name}.position`,
          track.times,
          values,
        ),
      );
    }

    for (const [name, track] of animation.humanoidTracks.rotation) {
      const raw = humanoid.getRawBoneNode(name);
      if (!raw) {
        continue;
      }
      const values = track.values.map((value, index) =>
        metaVersion === "0" && index % 2 === 0 ? -value : value,
      );
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${raw.name}.quaternion`,
          track.times,
          values,
        ),
      );
    }

    if (tracks.length === 0) {
      throw new Error("motion has no bindable bone tracks");
    }

    const clip = new THREE.AnimationClip("avatarMotion", animation.duration, tracks);
    this.stopAnimationObjects();
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const action = mixer.clipAction(clip);
    action.reset();
    action.play();
    this.animationMixer = mixer;
    this.animationAction = action;
    this.animationPlaying = true;
    this.currentAnimationUrl = url;
  }

  private stopAnimation(): void {
    if (this.animationPlaying) {
      this.restorePose();
    }
    this.stopAnimationObjects();
    this.currentAnimationUrl = null;
  }

  private stopAnimationObjects(): void {
    this.animationAction?.stop();
    this.animationAction = null;
    this.animationMixer?.stopAllAction();
    this.animationMixer = null;
    this.animationPlaying = false;
  }

  /** Reset every humanoid raw bone to its post-load rest rotation. */
  private restorePose(): void {
    for (const { node, euler } of this.restPoseBones) {
      node.rotation.copy(euler);
      node.updateMatrix();
    }
  }

  private snapshotRestPose(vrm: VRM): void {
    this.restPoseBones = [];
    vrm.scene.traverse((node) => {
      if (node instanceof THREE.Bone) {
        this.restPoseBones.push({ node, euler: node.rotation.clone() });
      }
    });
  }

  /**
   * Supply the per-frame mouth openness (0..1). Read inside the render loop so
   * the caller never has to run its own animation frame.
   */
  setMouthProvider(provider: (() => number) | null): void {
    this.mouthProvider = provider;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container?.removeEventListener("wheel", this.handleWheel);
    this.container?.removeEventListener("pointerdown", this.handlePointerDown);
    this.container?.removeEventListener("pointermove", this.handlePointerMove);
    this.container?.removeEventListener("pointerup", this.handlePointerUp);
    this.container?.removeEventListener("pointercancel", this.handlePointerUp);
    this.container?.removeEventListener("contextmenu", this.handleContextMenu);
    this.disposeModel();
    const renderer = this.renderer;
    this.renderer = null;
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
    this.container = null;
  }

  private disposeModel(): void {
    const vrm = this.vrm;
    this.vrm = null;
    this.mouthKeys = [];
    this.stopAnimationObjects();
    this.animationLoadFailed = false;
    this.currentAnimationUrl = null;
    this.loadAnimationSeq += 1;
    this.restPoseBones = [];
    if (!vrm) {
      return;
    }
    this.modelGroup.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
  }

  private frameCamera(vrm: VRM): void {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    const height = size.y > 0 ? size.y : 1.6;
    // Full-body framing: centre the whole model vertically and pull the camera
    // back far enough that the head and feet both stay inside the view. The
    // base distance is stored and scaled by `zoom` (mouse wheel) each frame.
    this.camCenterY = box.min.y + height / 2;
    this.camHeight = height;
    this.camBaseDistance = Math.max(height * 1.35, 1.6);
    this.applyCamera();
  }

  /** Move the camera to match `zoom` around the model's vertical centre. */
  private applyCamera(): void {
    const distance = this.camBaseDistance / this.zoom;
    this.camera.position.set(
      0,
      this.camCenterY + this.camHeight * 0.05,
      distance,
    );
    this.camera.lookAt(0, this.camCenterY, 0);
  }

  /**
   * Correct the arms-down rest pose. Many VRM exporters (VRoid first among
   * them) bake an arms-out "presentation" rest pose into the model, which is
   * why every imported avatar appears with its arms spread. We rotate each
   * upper arm on its local Z axis so the hand hangs vertically under its own
   * shoulder, tucking the arms flat against the body rather than leaving a
   * "八" spread.
   *
   * The raw skeleton is driven directly, so `autoUpdateHumanBones` is disabled
   * to stop the per-frame normalized -> raw copy from overwriting the pose.
   * Each step rotates in whichever local-Z direction lowers the hand; it stops
   * once the hand is horizontally aligned under the shoulder.
   */
  private relaxArms(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) {
      return;
    }
    humanoid.autoUpdateHumanBones = false;

    for (const side of ["left", "right"] as const) {
      const hand = humanoid.getRawBoneNode(`${side}Hand`);
      const upper = humanoid.getRawBoneNode(`${side}UpperArm`);
      const shoulder = humanoid.getRawBoneNode(`${side}Shoulder`);
      if (!hand || !upper || !shoulder) {
        continue;
      }

      for (let step = 0; step < RELAX_ARM_MAX_STEPS; step += 1) {
        upper.updateWorldMatrix(true, false);
        hand.updateWorldMatrix(true, false);
        shoulder.updateWorldMatrix(true, false);
        const spread = Math.abs(
          hand.getWorldPosition(new THREE.Vector3()).x -
            shoulder.getWorldPosition(new THREE.Vector3()).x,
        );
        if (spread <= RELAX_ARM_SPREAD_TOLERANCE) {
          break;
        }

        upper.updateWorldMatrix(true, false);
        hand.updateWorldMatrix(true, false);
        const before = hand.getWorldPosition(new THREE.Vector3()).y;

        const saved = upper.rotation.clone();
        upper.rotation.z += RELAX_ARM_STEP_RADIANS;
        upper.updateMatrix();
        hand.updateWorldMatrix(true, false);
        const plus = hand.getWorldPosition(new THREE.Vector3()).y;

        upper.rotation.copy(saved);
        upper.updateMatrix();
        upper.rotation.z -= RELAX_ARM_STEP_RADIANS;
        upper.updateMatrix();
        hand.updateWorldMatrix(true, false);
        const minus = hand.getWorldPosition(new THREE.Vector3()).y;

        upper.rotation.copy(saved);
        if (plus >= before && minus >= before) {
          break;
        }
        upper.rotation.z +=
          plus < minus ? RELAX_ARM_STEP_RADIANS : -RELAX_ARM_STEP_RADIANS;
        upper.updateMatrix();
      }
    }
  }

  /**
   * Build the procedural-gesture rig on top of the relaxed rest pose. Each
   * joint is driven by one eased random walker; the whole pose wanders between
   * waypoints instead of sitting frozen, and amplifies while talking.
   */
  private initGestures(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) {
      return;
    }

    const definitions: Array<{
      bone: string;
      axes: Array<[0 | 1 | 2, number]>;
      speaking?: boolean;
      breath?: number;
    }> = [
      // Arms lead the pose and liven up while speaking.
      { bone: "leftUpperArm", axes: [[1, 0.45], [2, 0.28]], speaking: true },
      { bone: "rightUpperArm", axes: [[1, 0.45], [2, 0.28]], speaking: true },
      { bone: "leftLowerArm", axes: [[1, 0.35]] },
      { bone: "rightLowerArm", axes: [[1, 0.35]] },
      // Torso sways and breathes (chest rises and falls on the X axis).
      { bone: "spine", axes: [[0, 0.03], [1, 0.025]], breath: BREATH_SPINE_AMP },
      { bone: "chest", axes: [[0, 0.03], [1, 0.02]], breath: BREATH_CHEST_AMP },
      // Head nods and turns a little, more while speaking.
      { bone: "head", axes: [[0, 0.04], [1, 0.035]], speaking: true },
    ];

    const gestures: GestureBone[] = [];
    for (const { bone, axes, speaking, breath } of definitions) {
      const node = humanoid.getRawBoneNode(
        bone as Parameters<typeof humanoid.getRawBoneNode>[0],
      );
      if (!node) {
        continue;
      }
      gestures.push(
        makeGestureBone(node, axes, { speaking: speaking ?? false, breath }),
      );
    }
    this.gestures = gestures;
  }

  /**
   * Slide the gesture walkers and write them onto the raw bones. Called every
   * frame before `vrm.update()`.
   */
  private updateGestures(now: number): void {
    if (this.gestures.length === 0) {
      return;
    }

    const speaking = this.mouthValue > 0.05;
    const boost = 1 + (speaking ? GESTURE_SPEAK_BOOST - 1 : 0);
    const t = now / 1000;

    for (const gesture of this.gestures) {
      // Two low-frequency sines compose a smooth, ever-flowing offset. Both
      // sines stay in [-1, 1], so the weighted sum is bounded around ±1.
      const wander =
        Math.sin(t * gesture.freq1 + gesture.phase1) * GESTURE_SLOW_WEIGHT +
        Math.sin(t * gesture.freq2 + gesture.phase2) * (1 - GESTURE_SLOW_WEIGHT);
      const value = wander * boost;

      const base = gesture.base;
      for (const [axis, amplitude] of gesture.axes) {
        let offset = value * amplitude;
        if (gesture.breath && axis === 0) {
          offset += Math.sin(t * BREATH_FREQ) * gesture.breath;
        }
        if (axis === 0) {
          gesture.node.rotation.x = base.x + offset;
        } else if (axis === 1) {
          gesture.node.rotation.y = base.y + offset;
        } else {
          gesture.node.rotation.z = base.z + offset;
        }
      }
      gesture.node.updateMatrix();
    }
  }

  private resize(): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer) {
      return;
    }
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private scheduleBlink(): void {
    const delay =
      BLINK_MIN_INTERVAL_MS +
      Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS);
    this.nextBlinkAt = performance.now() + delay;
  }

  private readonly loop = (): void => {
    if (this.disposed) {
      return;
    }
    this.frame = requestAnimationFrame(this.loop);

    // Clamp: a backgrounded tab produces a huge delta on return.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();

    this.updateMouth(delta);
    this.updateBlink(now);
    if (this.animationPlaying) {
      // A VRMA motion is authoritative: pause the procedural gestures and the
      // idle sway so the animation reads exactly as authored.
      this.animationMixer?.update(delta);
    } else {
      this.updateIdle(now);
      this.updateGestures(now);
    }

    // Expressions and idle poses must be applied before `update`, which pushes
    // them onto the morph targets and normalized bones.
    this.vrm?.update(delta);
    this.renderer?.render(this.scene, this.camera);
  };

  private updateMouth(delta: number): void {
    const target = this.mouthProvider?.() ?? 0;
    this.mouthValue +=
      (target - this.mouthValue) * Math.min(1, delta * MOUTH_SMOOTHING);

    const manager = this.vrm?.expressionManager;
    if (!manager) {
      return;
    }
    for (const key of this.mouthKeys) {
      manager.setValue(key, this.mouthValue * MOUTH_WEIGHTS[key]!);
    }
  }

  private updateBlink(now: number): void {
    const manager = this.vrm?.expressionManager;
    if (!manager) {
      return;
    }
    if (manager.getExpression("blink") === null) {
      return;
    }

    if (this.nextBlinkAt === 0) {
      this.scheduleBlink();
      return;
    }
    if (now >= this.nextBlinkAt && this.blinkEndsAt === 0) {
      this.blinkEndsAt = now + BLINK_DURATION_MS;
    }

    if (this.blinkEndsAt > 0) {
      const progress = 1 - (this.blinkEndsAt - now) / BLINK_DURATION_MS;
      manager.setValue("blink", Math.sin(progress * Math.PI));
      if (now >= this.blinkEndsAt) {
        manager.setValue("blink", 0);
        this.blinkEndsAt = 0;
        this.scheduleBlink();
      }
      return;
    }

    manager.setValue("blink", 0);
  }

  private updateIdle(now: number): void {
    const seconds = now / 1000;
    this.rig.rotation.y = Math.sin(seconds * 0.5) * IDLE_SWAY_RADIANS;
    this.rig.position.y = Math.sin(seconds * 1.2) * IDLE_BOB_METERS;
  }

  private patch(status: Partial<VrmSceneStatus>): void {
    this.status = { ...this.status, ...status };
    this.onStatusChange?.(this.status);
  }
}

/**
 * Not every model ships the full set of VRM mouth expressions, so only the ones
 * that actually resolve on this model are driven.
 */
function detectMouthKeys(vrm: VRM): string[] {
  const manager = vrm.expressionManager;
  if (!manager) {
    return [];
  }
  return MOUTH_KEYS.filter((key) => manager.getExpression(key) !== null);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
