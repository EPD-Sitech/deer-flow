"use client";

import { useEffect, useRef, useState } from "react";

import { FALLBACK_MODEL_URL } from "@/core/avatar/constants";
import type { VrmScene } from "@/core/avatar/vrm-scene";
import { cn } from "@/lib/utils";

export type AvatarModelStatus = "loading" | "ready" | "missing" | "error";

interface AvatarCanvasProps {
  /** Uploaded model, or `null` to fall back to `public/images/models/avatar.vrm`. */
  model: Blob | null;
  /** Bump to force a reload after a new upload. */
  modelVersion: number;
  /** Bundled VRMA motion URL, or `null`/empty to stop any playing motion. */
  animationUrl: string | null;
  mouthProvider: () => number;
  onStatus: (status: AvatarModelStatus, mouthSupported: boolean) => void;
  onActivate?: () => void;
  className?: string;
}

/**
 * Owns the VRM stage lifecycle.
 *
 * `three` is imported dynamically inside the mount effect so the 3D stack is
 * only downloaded when the avatar is actually rendered — the workspace route
 * has a first-load JS budget and three.js would blow straight through it.
 */
export function AvatarCanvas({
  model,
  modelVersion,
  animationUrl,
  mouthProvider,
  onStatus,
  onActivate,
  className,
}: AvatarCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<VrmScene | null>(null);
  const [mounted, setMounted] = useState(false);
  const latest = useRef({
    mouthProvider,
    onStatus,
    animationUrl,
    onActivate,
  });

  useEffect(() => {
    latest.current = {
      mouthProvider,
      onStatus,
      animationUrl,
      onActivate,
    };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let scene: VrmScene | null = null;

    void (async () => {
      const { VrmScene } = await import("@/core/avatar/vrm-scene");
      if (cancelled || !containerRef.current) {
        return;
      }
      scene = new VrmScene();
      sceneRef.current = scene;
      scene.setMouthProvider(() => latest.current.mouthProvider());
      scene.setActivationHandler(() => latest.current.onActivate?.());
      scene.mount(container);
      setMounted(true);
    })();

    return () => {
      cancelled = true;
      setMounted(false);
      scene?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    let cancelled = false;
    void (async () => {
      const source = model ?? (await resolveFallbackModel());
      if (cancelled) {
        return;
      }
      if (!source) {
        latest.current.onStatus("missing", false);
        return;
      }

      latest.current.onStatus("loading", false);
      await scene.loadModel(source);
      if (cancelled) {
        return;
      }
      const status = scene.getStatus();
      latest.current.onStatus(
        status.ready ? "ready" : "error",
        status.mouthSupported,
      );
      if (status.ready) {
        // A motion chosen while the model was still loading must start once
        // the VRM is ready (`setAnimation` no-ops before the model exists).
        const url = latest.current.animationUrl;
        await scene.setAnimation(url && url.length > 0 ? url : null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [model, modelVersion, mounted]);

  // Apply the selected motion. Keyed on modelVersion too so a swapped model
  // re-applies the chosen animation once it is ready.
  useEffect(() => {
    if (!mounted) {
      return;
    }
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    void scene.setAnimation(
      animationUrl && animationUrl.length > 0 ? animationUrl : null,
    );
  }, [mounted, animationUrl, modelVersion]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={cn("size-full overflow-hidden", className)}
    />
  );
}

/**
 * `public/images/models/avatar.vrm` is optional, so probe before handing a URL to the
 * loader. A dev server answers unknown paths with HTML rather than a 404.
 */
async function resolveFallbackModel(): Promise<string | null> {
  try {
    const response = await fetch(FALLBACK_MODEL_URL, { method: "HEAD" });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return null;
    }
    return FALLBACK_MODEL_URL;
  } catch {
    return null;
  }
}
