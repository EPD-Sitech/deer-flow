"use client";

import type { Message } from "@langchain/langgraph-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { useThread } from "@/components/workspace/messages/context";
import { SpeechQueue, type SpeechState } from "@/core/avatar/tts-client";
import { extractContentFromMessage } from "@/core/messages/utils";

interface SpeakerOptions {
  voice: string;
  rate: number;
  muted: boolean;
}

/**
 * How many unspoken characters may accumulate before a sentence without a
 * terminator is flushed, so long answers still read aloud progressively.
 */
const MAX_STREAM_CHARS = 40;

/**
 * Streams the agent's answer to speech as it is generated.
 *
 * Instead of waiting for the whole turn to finish, completed sentences are fed
 * to the queue the moment they appear in the streaming message. The trailing
 * (incomplete) fragment is held back until the turn ends, then flushed once.
 */
export function useAvatarSpeaker({ voice, rate, muted }: SpeakerOptions) {
  const { thread } = useThread();
  const queueRef = useRef<SpeechQueue | null>(null);
  const optionsRef = useRef({ voice, rate, muted });
  const [state, setState] = useState<SpeechState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Kept in sync before the trigger effect below runs so the speak call always
  // reads the current voice/rate/mute choice.
  useEffect(() => {
    optionsRef.current = { voice, rate, muted };
  }, [voice, rate, muted]);

  const getQueue = useCallback(() => {
    queueRef.current ??= new SpeechQueue({
      onStateChange: setState,
      onError: setError,
    });
    return queueRef.current;
  }, []);

  useEffect(() => {
    return () => {
      queueRef.current?.dispose();
      queueRef.current = null;
    };
  }, []);

  const lastAi = findLastAi(thread.messages);
  const isLoading = thread.isLoading;

  // `spokenLenRef` is how far into the current answer we have already queued;
  // `streamingKeyRef` is the answer we are actively streaming (so we never
  // read a finished historical message aloud on first paint).
  const spokenLenRef = useRef(0);
  const streamingKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lastAi) {
      return;
    }
    const { message, key } = lastAi;
    const full = extractContentFromMessage(message).trim();
    const queue = getQueue();
    const { muted: isMuted, ...settings } = optionsRef.current;

    if (key !== streamingKeyRef.current) {
      // A new answer began: drop anything queued from the previous turn, and
      // clear any stale failure so one transient error does not stick forever.
      streamingKeyRef.current = key;
      spokenLenRef.current = 0;
      setError(null);
      if (isMuted) {
        return;
      }
      queue.stop();
    }

    if (isMuted) {
      // Halt speech and skip the rest of this answer.
      spokenLenRef.current = full.length;
      queue.stop();
      return;
    }

    if (isLoading) {
      streamingKeyRef.current = key;
      let spoken = spokenLenRef.current;
      let chunk = nextSpeakable(full, spoken);
      while (chunk) {
        queue.append(chunk, settings);
        spoken += chunk.length;
        chunk = nextSpeakable(full, spoken);
      }
      spokenLenRef.current = spoken;
    } else if (key === streamingKeyRef.current) {
      // Turn finished: flush the trailing fragment (if any) exactly once.
      const remaining = full.slice(spokenLenRef.current);
      if (remaining.trim()) {
        queue.append(remaining, settings);
      }
      spokenLenRef.current = full.length;
    }
  }, [getQueue, isLoading, lastAi]);

  const pause = useCallback(() => {
    getQueue().pause();
  }, [getQueue]);

  const resume = useCallback(() => {
    getQueue().resume();
  }, [getQueue]);

  const stop = useCallback(() => {
    getQueue().stop();
  }, [getQueue]);

  const unlock = useCallback(() => {
    void getQueue().unlock();
  }, [getQueue]);

  const getMouthOpen = useCallback(
    () => queueRef.current?.getMouthOpen() ?? 0,
    [],
  );

  return { state, error, pause, resume, stop, unlock, getMouthOpen };
}

/**
 * Returns the last AI message that actually carries spoken text, plus a stable
 * key for detecting when a brand new answer starts.
 */
function findLastAi(
  messages: Message[],
): { message: Message; key: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "ai") {
      continue;
    }
    const text = extractContentFromMessage(message).trim();
    if (text) {
      return { message, key: message.id ?? `idx:${index}` };
    }
  }
  return null;
}

/**
 * The next slice of `full` (beyond `spokenLen`) that is safe to speak now:
 * up to and including the next sentence terminator, or — for a long run with
 * no terminator — up to the next comma, or the whole pending run if it has
 * grown past `MAX_STREAM_CHARS`. Returns "" when nothing is ready yet.
 */
function nextSpeakable(full: string, spokenLen: number): string {
  const rest = full.slice(spokenLen);
  if (!rest) {
    return "";
  }
  const term = /[。！？；\n]/;
  const comma = /[，、：,:]/;

  const termIdx = rest.search(term);
  if (termIdx >= 0) {
    return rest.slice(0, termIdx + 1);
  }
  if (rest.length >= MAX_STREAM_CHARS) {
    const commaIdx = rest.search(comma);
    if (commaIdx >= 0) {
      return rest.slice(0, commaIdx + 1);
    }
    return rest;
  }
  return "";
}
