import type { Message } from "@langchain/langgraph-sdk";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";

const threadState = rs.hoisted(() => ({
  isLoading: false,
  messages: [] as Message[],
}));

const queueState = rs.hoisted(() => ({
  instances: [] as Array<{
    append: ReturnType<typeof rs.fn>;
    stop: ReturnType<typeof rs.fn>;
    speak: ReturnType<typeof rs.fn>;
    callbacks: {
      onStateChange?: (state: string) => void;
    };
  }>,
}));

rs.mock("@/components/workspace/messages/context", () => ({
  useThread: () => ({ thread: threadState }),
}));

rs.mock("@/core/avatar/tts-client", () => ({
  SpeechQueue: class {
    readonly append = rs.fn();
    readonly stop = rs.fn();
    readonly speak = rs.fn(
      async (text: string, settings: { voice: string; rate: number }) => {
        this.callbacks.onStateChange?.("loading");
        return { text, settings };
      },
    );
    readonly callbacks: {
      onStateChange?: (state: string) => void;
    };

    constructor(callbacks: { onStateChange?: (state: string) => void }) {
      this.callbacks = callbacks;
      queueState.instances.push(this);
    }

    pause = rs.fn();
    resume = rs.fn();
    unlock = rs.fn();
    dispose = rs.fn();
    getMouthOpen = rs.fn(() => 0);
  },
}));

import { useAvatarSpeaker } from "@/components/workspace/avatar/use-avatar-speaker";

afterEach(() => {
  cleanup();
  queueState.instances.length = 0;
  threadState.messages = [];
  threadState.isLoading = false;
});

describe("useAvatarSpeaker replay", () => {
  beforeEach(() => {
    threadState.messages = [
      {
        id: "answer-1",
        type: "ai",
        content: "第一句。第二句。",
      } as Message,
    ];
  });

  it("keeps the replay action after stopping a still-streaming answer", () => {
    const { result, rerender } = renderHook(() =>
      useAvatarSpeaker({
        voice: "zh-CN-XiaoxiaoNeural",
        rate: 0,
        muted: false,
      }),
    );
    const queue = queueState.instances[0]!;
    const initialAppendCount = queue.append.mock.calls.length;

    act(() => {
      result.current.stop();
    });

    expect(result.current.state).toBe("stopped");

    threadState.isLoading = true;
    threadState.messages = [
      {
        id: "answer-1",
        type: "ai",
        content: "第一句。第二句。后续内容仍在生成。",
      } as Message,
    ];
    rerender();

    expect(queue.append).toHaveBeenCalledTimes(initialAppendCount);

    act(() => {
      result.current.replay();
    });

    expect(queue.speak).toHaveBeenCalledWith(
      "第一句。第二句。后续内容仍在生成。",
      { voice: "zh-CN-XiaoxiaoNeural", rate: 0 },
    );
    expect(result.current.state).toBe("loading");
  });
});
