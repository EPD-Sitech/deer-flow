type AudioContextConstructor = new () => AudioContext;

/**
 * Cached WebAudio sources, keyed by media element.
 *
 * `createMediaElementSource` may only be called once per element — a second
 * call throws `InvalidStateError`. The app reuses a single `<audio>` element,
 * but the cache keeps the engine safe regardless.
 */
const sourceCache = new WeakMap<
  HTMLMediaElement,
  MediaElementAudioSourceNode
>();

/**
 * Reads the loudness of the currently playing audio so the VRM mouth can follow
 * it. This is amplitude-driven lip sync, not phoneme-accurate visemes: the jaw
 * tracks the volume envelope, which is convincing enough at conversation speed
 * and needs no GPU or model inference.
 */
export class LipSyncEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Uint8Array<ArrayBuffer> | null = null;

  /**
   * Wire a media element into the analyser graph. Safe to call repeatedly with
   * the same element.
   */
  attach(element: HTMLAudioElement): void {
    const Constructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextConstructor })
        .webkitAudioContext;
    if (!Constructor) {
      return;
    }

    this.context ??= new Constructor();

    let source = sourceCache.get(element);
    if (!source) {
      source = this.context.createMediaElementSource(element);
      sourceCache.set(element, source);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6;
      source.connect(this.analyser);
      // Without this the element's audio is consumed and never reaches the
      // speakers: once routed through WebAudio the graph owns the output.
      this.analyser.connect(this.context.destination);
    }

    if (this.analyser && !this.buffer) {
      this.buffer = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  /** Must be called from a user gesture, otherwise the context stays suspended. */
  async resume(): Promise<void> {
    if (this.context?.state === "suspended") {
      await this.context.resume();
    }
  }

  /** Normalized loudness of the current frame, 0 (silent) to 1 (loud). */
  read(): number {
    if (!this.analyser || !this.buffer) {
      return 0;
    }
    this.analyser.getByteFrequencyData(this.buffer);
    let sum = 0;
    for (const value of this.buffer) {
      sum += value * value;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    return Math.min(1, rms / 90);
  }

  dispose(): void {
    this.analyser?.disconnect();
    this.analyser = null;
    this.buffer = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
