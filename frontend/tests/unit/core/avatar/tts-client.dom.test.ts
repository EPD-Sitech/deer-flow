import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";

import { SpeechQueue, type SpeechSettings } from "@/core/avatar/tts-client";

const settings: SpeechSettings = { voice: "zh-CN-XiaoxiaoNeural", rate: 0 };

/**
 * Minimal media element: `play()` resolves, then fires `ended` on the next
 * macrotask — by which point the queue has already attached its listeners.
 */
class FakeAudio {
  src = "";
  private ended: Array<() => void> = [];

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended" || type === "error") {
      this.ended.push(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    this.ended = this.ended.filter((entry) => entry !== listener);
  }

  play(): Promise<void> {
    return Promise.resolve().then(() => {
      setTimeout(() => {
        for (const listener of [...this.ended]) {
          listener();
        }
      }, 0);
    });
  }

  // Stubs for the HTMLAudioElement members SpeechQueue.stop() touches. They are
  // intentionally no-ops in the fake element.
  /* eslint-disable @typescript-eslint/no-empty-function */
  pause(): void {}
  load(): void {}
  removeAttribute(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */
}

interface FetchState {
  inFlight: number;
  maxInFlight: number;
  texts: string[];
}

let fetchState: FetchState = { inFlight: 0, maxInFlight: 0, texts: [] };

function installStubs(): void {
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  URL.createObjectURL = () => "blob:stub";
  URL.revokeObjectURL = () => undefined;

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchState.inFlight += 1;
    fetchState.maxInFlight = Math.max(
      fetchState.maxInFlight,
      fetchState.inFlight,
    );
    fetchState.texts.push(JSON.parse((init?.body as string) ?? "{}").text);
    // Real latency, so appends land while a request is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fetchState.inFlight -= 1;
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
    } as unknown as Response;
  }) as typeof fetch;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("SpeechQueue streaming", () => {
  let queue: SpeechQueue;

  beforeEach(() => {
    fetchState = { inFlight: 0, maxInFlight: 0, texts: [] };
    installStubs();
    queue = new SpeechQueue();
  });

  afterEach(() => {
    queue.dispose();
  });

  it("serializes requests when chunks are appended mid-playback", async () => {
    // Mirrors streaming: sentences arrive while the previous one is still
    // being synthesized. Each append must not spawn a second in-flight request,
    // otherwise the endpoint's concurrency cap returns 429 for all of them.
    for (let index = 0; index < 6; index += 1) {
      queue.append(`第 ${index} 句话。`, settings);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await waitFor(() => fetchState.texts.length === 6);

    expect(fetchState.maxInFlight).toBeLessThanOrEqual(1);
    expect(fetchState.texts.length).toBe(6);
    await waitFor(() => queue.getState() === "idle");
  });

  it("stops cleanly and drops queued chunks", async () => {
    for (let index = 0; index < 4; index += 1) {
      queue.append(`第 ${index} 句话。`, settings);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.stop();

    expect(queue.getState()).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchState.inFlight).toBe(0);
  });
});
