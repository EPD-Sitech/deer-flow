"use client";

import { useCallback, useState } from "react";

import {
  DOCK_DEFAULT,
  DOCK_STORAGE_KEY,
  type DockState,
} from "@/core/avatar/constants";
import { safeLocalStorage } from "@/core/settings/local";

/**
 * Dock preferences live in their own localStorage key instead of the shared
 * `LocalSettings` store: the avatar is an optional front-end extra, and wiring
 * it into the settings schema would touch the settings types, the merge helper
 * and the settings dialog for no functional gain.
 */

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readDockState(): DockState {
  const raw = safeLocalStorage.getItem(DOCK_STORAGE_KEY);
  if (!raw) {
    return { ...DOCK_DEFAULT };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DockState>;
    return {
      right: numberOr(parsed.right, DOCK_DEFAULT.right),
      bottom: numberOr(parsed.bottom, DOCK_DEFAULT.bottom),
      collapsed: boolOr(parsed.collapsed, DOCK_DEFAULT.collapsed),
      voice:
        typeof parsed.voice === "string" && parsed.voice.length > 0
          ? parsed.voice
          : DOCK_DEFAULT.voice,
      rate: numberOr(parsed.rate, DOCK_DEFAULT.rate),
      muted: boolOr(parsed.muted, DOCK_DEFAULT.muted),
    };
  } catch {
    return { ...DOCK_DEFAULT };
  }
}

export function useDockState() {
  const [state, setState] = useState<DockState>(readDockState);

  const update = useCallback((patch: Partial<DockState>) => {
    setState((previous) => {
      const next = { ...previous, ...patch };
      safeLocalStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return [state, update] as const;
}
