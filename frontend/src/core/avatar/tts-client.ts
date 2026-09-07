import { TTS_ENDPOINT } from "./constants";
import { LipSyncEngine } from "./lip-sync";
import { estimateSpeechSeconds, toSpeechChunks } from "./markdown-to-speech";

export type SpeechState =
  | "idle"
  | "loading"
  | "speaking"
  /** Playback was paused by the user; call `resume()` to continue. */
  | "paused"
  /** Autoplay was blocked and a user gesture is required. */
  | "blocked"
  | "error";

export interface SpeechSettings {
  voice: string;
  rate: number;
}

export interface SpeechQueueCallbacks {
  onStateChange?: (state: SpeechState) => void;
  onError?: (message: string) => void;
}

const UNLOCK_TIMEOUT_MS = 30_000;
const PLAYBACK_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];

/**
 * Synthesizes an answer chunk by chunk and plays it back in order.
 *
 * Two entry points:
 * - `speak(text)` clears whatever is queued and plays the (markdown) text from
 *   scratch — used for a one-shot answer.
 * - `append(text)` queues more text *without* interrupting what is currently
 *   playing. This is what makes streaming work: the caller feeds completed
 *   sentences as the model generates them, and they are spoken in turn.
 */
export class SpeechQueue {
  private readonly engine = new LipSyncEngine();
  private readonly callbacks: SpeechQueueCallbacks;
  private audio: HTMLAudioElement | null = null;
  private controller: AbortController | null = null;
  private objectUrls = new Set<string>();
  private unlockWaiters: Array<() => void> = [];
  private generation = 0;
  /**
   * Bumped only by `stop()` to invalidate a running drain loop. Deliberately
   * *not* bumped by `drain()`/`append()`: streaming appends arrive many times
   * per turn, and superseding the loop each time would leave every superseded
   * fetch in flight, blowing past the endpoint's concurrency cap.
   */
  private drainToken = 0;
  /** Token of the loop currently draining, or -1 when none is running. */
  private activeLoopToken = -1;
  private settings: SpeechSettings | null = null;
  private pending: string[] = [];
  private state: SpeechState = "idle";
  private fallbackSeconds = 0;
  private fallbackStartedAt = 0;
  /**
   * Handle for the guard timer of the chunk currently being played. Cleared
   * while paused so a long pause cannot resolve the finished promise and let
   * the drain loop (and the revoke of the current URL) continue on its own.
   */
  private playTimer: number | null = null;
  /** `finish` resolver for the chunk currently being played, if any. */
  private playFinish: (() => void) | null = null;

  constructor(callbacks: SpeechQueueCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getState(): SpeechState {
    return this.state;
  }

  /**
   * Speak the given (markdown) text from scratch, cancelling anything playing.
   */
  async speak(text: string, settings: SpeechSettings): Promise<void> {
    this.stop();
    this.append(text, settings);
  }

  /**
   * Queue more text to be spoken after the current playback. Safe to call many
   * times as the answer streams in.
   */
  append(text: string, settings: SpeechSettings): void {
    this.settings = settings;
    const chunks = toSpeechChunks(text);
    if (chunks.length === 0) {
      return;
    }
    this.pending.push(...chunks);
    if (this.state === "idle") {
      this.setState("loading");
    }
    this.drain();
  }

  /** Call from a user gesture to unblock a suspended audio context. */
  async unlock(): Promise<void> {
    await this.engine.resume();
    const waiters = this.unlockWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  stop(): void {
    this.generation += 1;
    this.drainToken += 1;
    this.controller?.abort();
    this.controller = null;
    this.pending = [];
    this.fallbackSeconds = 0;

    this.clearPlayTimer();

    // Release anyone parked on the unlock prompt.
    const waiters = this.unlockWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }

    const audio = this.audio;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    this.revokeAll();
    this.setState("idle");
  }

  /**
   * Pause playback and hold the position so a later `resume()` continues from
   * where it stopped instead of restarting from scratch.
   *
   * If audio for the current chunk is already loaded, the element is paused in
   * place (HTMLAudioElement remembers `currentTime`), the drain loop keeps its
   * connection and `resume()` simply calls `play()` again. If we paused while
   * a chunk was still being fetched (`loading`), there is no in-flight audio to
   * restore, so the current fetch chain is stopped instead (keeping `pending`
   * intact) and `resume()` restarts draining.
   */
  pause(): void {
    if (this.state !== "speaking" && this.state !== "loading") {
      return;
    }
    const audio = this.audio;
    const hasLiveAudio =
      !!audio &&
      !!audio.src &&
      !audio.ended &&
      audio.currentTime > 0 &&
      audio.currentTime < (audio.duration || Infinity);
    if (hasLiveAudio) {
      this.clearPlayTimer();
      audio.pause();
      this.setState("paused");
      return;
    }
    // No playable audio yet (still fetching): stop this fetch chain but keep
    // the queued chunks for `resume()`.
    this.drainToken += 1;
    this.controller?.abort();
    this.controller = null;
    this.setState("paused");
  }

  /** Resume playback after `pause()`, continuing from the paused position. */
  resume(): void {
    if (this.state !== "paused") {
      return;
    }
    const audio = this.audio;
    if (audio?.src && !audio.ended) {
      void audio.play().catch(() => undefined);
      void this.engine.resume();
      // Re-arm the guard timer for the chunk we just resumed.
      if (this.playTimer === null && this.playFinish) {
        this.playTimer = window.setTimeout(
          this.playFinish,
          PLAYBACK_TIMEOUT_MS,
        );
      }
      this.setState("speaking");
      return;
    }
    this.drain();
  }

  private clearPlayTimer(): void {
    if (this.playTimer !== null) {
      window.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.engine.dispose();
    this.audio = null;
  }

  /**
   * Mouth openness for the current frame, 0..1.
   *
   * Normally this is the live loudness of the playing audio. When the browser
   * blocks autoplay there is no audio to analyse, so a synthetic envelope is
   * used instead — the avatar still moves instead of freezing mid-sentence.
   */
  getMouthOpen(): number {
    const loudness = this.engine.read();
    if (loudness > 0.02) {
      return loudness;
    }

    if (this.state === "blocked" && this.fallbackSeconds > 0) {
      const elapsed = (performance.now() - this.fallbackStartedAt) / 1000;
      if (elapsed >= this.fallbackSeconds) {
        return 0;
      }
      // Syllable-ish oscillation with a slower drift so it does not look
      // mechanical.
      const syllable = Math.sin(((elapsed % 0.28) / 0.28) * Math.PI) * 0.7;
      const drift = Math.sin(elapsed * 1.7) * 0.1;
      return Math.max(0, Math.min(0.8, syllable + drift));
    }

    return 0;
  }

  /**
   * Drains `pending` in order, one request at a time.
   *
   * Only one loop ever runs per token: when a loop is already draining it picks
   * up newly appended chunks on its next iteration, so `append()` during
   * playback does not spawn a second concurrent fetch (that would trip the
   * endpoint's concurrency cap). `stop()` bumps `drainToken`, which makes the
   * running loop exit as soon as it returns from whatever it was awaiting.
   */
  private drain(): void {
    if (this.state === "paused") {
      return;
    }
    if (this.activeLoopToken === this.drainToken) {
      return;
    }
    const token = this.drainToken;
    this.activeLoopToken = token;
    const gen = this.generation;
    const signal = this.ensureController().signal;

    void (async () => {
      try {
        while (true) {
          if (token !== this.drainToken) {
            return;
          }
          const chunk = this.pending.shift();
          if (!chunk) {
            return;
          }

          const url = await this.synthesize(chunk, this.settings!, signal);
          if (token !== this.drainToken) {
            this.revoke(url);
            return;
          }
          if (!url) {
            continue;
          }

          const ok = await this.play(url, chunk, this.settings!, gen);
          this.revoke(url);
          if (token !== this.drainToken) {
            return;
          }
          if (!ok) {
            this.stop();
            return;
          }
        }
      } finally {
        if (this.activeLoopToken === token) {
          this.activeLoopToken = -1;
        }
        if (token === this.drainToken) {
          if (this.pending.length > 0) {
            this.drain();
          } else if (this.state !== "blocked") {
            this.setState("idle");
          }
        }
      }
    })();
  }

  private async play(
    url: string,
    text: string,
    settings: SpeechSettings,
    generation: number,
  ): Promise<boolean> {
    const audio = this.ensureAudio();
    audio.src = url;
    this.setState("speaking");

    const started = await this.attemptPlay(audio, generation);
    if (!started || generation !== this.generation) {
      return false;
    }

    this.fallbackSeconds = estimateSpeechSeconds(text, settings.rate);
    this.fallbackStartedAt = performance.now();

    await this.waitFinished(audio);

    this.fallbackSeconds = 0;
    return true;
  }

  /**
   * Waits for the current chunk to finish playing (or be aborted). Unlike a
   * plain local timer, the guard timer's handle is kept on the instance so
   * `pause()` can suspend it — otherwise a long pause would resolve this
   * promise via the timeout and let the drain loop (and the URL revoke)
   * proceed on its own.
   */
  private waitFinished(audio: HTMLAudioElement): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", finish);
        this.clearPlayTimer();
        if (this.playFinish === finish) {
          this.playFinish = null;
        }
        resolve();
      };
      this.playFinish = finish;
      const armTimer = () => {
        if (this.playTimer !== null) {
          window.clearTimeout(this.playTimer);
        }
        this.playTimer = window.setTimeout(finish, PLAYBACK_TIMEOUT_MS);
      };
      audio.addEventListener("ended", finish);
      audio.addEventListener("error", finish);
      armTimer();
    });
  }

  private async attemptPlay(
    audio: HTMLAudioElement,
    generation: number,
  ): Promise<boolean> {
    try {
      await audio.play();
      await this.engine.resume();
      return true;
    } catch (error) {
      if ((error as DOMException | undefined)?.name !== "NotAllowedError") {
        return false;
      }
    }

    // Browser autoplay policy: wait for a real user gesture, then retry once.
    this.setState("blocked");
    const unlocked = await this.waitForUnlock();
    if (!unlocked || generation !== this.generation) {
      return false;
    }
    try {
      await audio.play();
      await this.engine.resume();
      this.setState("speaking");
      return true;
    } catch {
      return false;
    }
  }

  private waitForUnlock(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (unlocked: boolean) => {
        window.clearTimeout(timer);
        this.unlockWaiters = this.unlockWaiters.filter(
          (waiter) => waiter !== onUnlock,
        );
        resolve(unlocked);
      };
      const onUnlock = () => finish(true);
      const timer = window.setTimeout(() => finish(false), UNLOCK_TIMEOUT_MS);
      this.unlockWaiters.push(onUnlock);
    });
  }

  private async synthesize(
    text: string,
    settings: SpeechSettings,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(TTS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: settings.voice,
            rate: settings.rate,
          }),
          signal,
        });
        if (!response.ok) {
          throw new Error(`TTS request failed with ${response.status}`);
        }
        return this.track(URL.createObjectURL(await response.blob()));
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return null;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          await delay(RETRY_DELAYS_MS[attempt] ?? 3000, signal);
          continue;
        }
        this.callbacks.onError?.(describe(error));
        return null;
      }
    }
    return null;
  }

  private ensureAudio(): HTMLAudioElement {
    this.audio ??= new Audio();
    this.engine.attach(this.audio);
    return this.audio;
  }

  private ensureController(): AbortController {
    this.controller ??= new AbortController();
    return this.controller;
  }

  private track(url: string): string {
    this.objectUrls.add(url);
    return url;
  }

  private revoke(url: string | null): void {
    if (!url) {
      return;
    }
    this.objectUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  private revokeAll(): void {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls.clear();
  }

  private setState(state: SpeechState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error as DOMException | undefined)?.name === "AbortError" ||
    (error as Error | undefined)?.name === "AbortError"
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
