"use client";

import {
  ChevronDownIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  SparklesIcon,
  SquareIcon,
  VolumeIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/workspace/tooltip";
import { DOCK_SIZE } from "@/core/avatar/constants";
import {
  AVATAR_CLICK_MOTIONS,
  AVATAR_IDLE_MOTIONS,
  AVATAR_SPEAKING_MOTION,
  animationUrlForMotion,
  nextMotionIndex,
} from "@/core/avatar/motion-choreography";
import { getStoredModel } from "@/core/avatar/vrm-storage";
import { useI18n } from "@/core/i18n/hooks";
import { useIsMobile } from "@/hooks/use-mobile";

import { AvatarCanvas, type AvatarModelStatus } from "./avatar-canvas";
import { useDockState } from "./dock-storage";
import { useAvatarSpeaker } from "./use-avatar-speaker";

const MIN_EDGE_OFFSET = 8;

export default function AvatarDock() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [dock, updateDock] = useDockState();
  const [model, setModel] = useState<Blob | null>(null);
  const [modelVersion, setModelVersion] = useState(0);
  const [status, setStatus] = useState<AvatarModelStatus>("loading");
  const [mouthSupported, setMouthSupported] = useState(true);
  const [idleIndex, setIdleIndex] = useState(0);
  const [clickIndex, setClickIndex] = useState<number | null>(null);
  const wasSpeaking = useRef(false);

  const { state, error, pause, resume, stop, replay, unlock, getMouthOpen } =
    useAvatarSpeaker({
      voice: dock.voice,
      rate: dock.rate,
      muted: dock.muted,
    });

  const isSpeaking = state === "speaking" || state === "loading";

  useEffect(() => {
    if (isSpeaking) {
      wasSpeaking.current = true;
      setClickIndex(null);
      return;
    }
    if (wasSpeaking.current) {
      wasSpeaking.current = false;
      setIdleIndex(0);
      setClickIndex(null);
    }
  }, [isSpeaking]);

  useEffect(() => {
    if (isSpeaking || clickIndex !== null) {
      return;
    }
    const timer = window.setInterval(() => {
      setIdleIndex((index) => nextMotionIndex(index, AVATAR_IDLE_MOTIONS));
    }, 7000);
    return () => window.clearInterval(timer);
  }, [clickIndex, isSpeaking]);

  useEffect(() => {
    let cancelled = false;
    void getStoredModel().then((stored) => {
      if (cancelled || !stored) {
        return;
      }
      setModel(stored);
      setModelVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      // Keep header buttons clickable instead of starting a drag on their
      // pointerdown event.
      const handle = event.currentTarget;
      const target = event.target as HTMLElement | null;
      if (!target || !handle.contains(target) || target.closest("button")) {
        return;
      }
      const startX = event.clientX;
      const startY = event.clientY;
      const startRight = dock.right;
      const startBottom = dock.bottom;
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        updateDock({
          right: clamp(
            startRight - (moveEvent.clientX - startX),
            MIN_EDGE_OFFSET,
            Math.max(
              MIN_EDGE_OFFSET,
              window.innerWidth - DOCK_SIZE.width - MIN_EDGE_OFFSET,
            ),
          ),
          bottom: clamp(
            startBottom - (moveEvent.clientY - startY),
            MIN_EDGE_OFFSET,
            Math.max(MIN_EDGE_OFFSET, window.innerHeight - 140),
          ),
        });
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [dock.bottom, dock.right, updateDock],
  );

  if (isMobile) {
    return null;
  }

  if (dock.collapsed) {
    return (
      <Tooltip content={t.avatar.expand}>
        <Button
          aria-label={t.avatar.expand}
          className="fixed z-40 rounded-full shadow-lg"
          size="icon"
          style={{ right: dock.right, bottom: dock.bottom }}
          variant="secondary"
          onClick={() => updateDock({ collapsed: false })}
        >
          <SparklesIcon />
        </Button>
      </Tooltip>
    );
  }

  const motionKey = isSpeaking
    ? AVATAR_SPEAKING_MOTION
    : clickIndex === null
      ? (AVATAR_IDLE_MOTIONS[idleIndex] ?? AVATAR_IDLE_MOTIONS[0])
      : (AVATAR_CLICK_MOTIONS[clickIndex] ?? AVATAR_CLICK_MOTIONS[0]);
  const animationUrl = animationUrlForMotion(motionKey);

  return (
    <div
      className="fixed z-40 flex flex-col overflow-visible"
      style={{
        right: dock.right,
        bottom: dock.bottom,
        width: DOCK_SIZE.width,
        height: DOCK_SIZE.height,
      }}
    >
      <div
        className="relative flex shrink-0 cursor-grab items-center gap-0.5 px-1.5 py-1 active:cursor-grabbing"
        onPointerDown={startDrag}
      >
        {isSpeaking ? (
          <p
            className="text-muted-foreground pointer-events-none absolute inset-x-12 text-center text-[11px]"
            role="status"
          >
            {t.avatar.speaking}
          </p>
        ) : state === "paused" ? (
          <p
            className="text-muted-foreground pointer-events-none absolute inset-x-12 text-center text-[11px]"
            role="status"
          >
            {t.avatar.paused}
          </p>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {isSpeaking ? (
            <Tooltip content={t.avatar.pause}>
              <Button
                aria-label={t.avatar.pause}
                size="icon-sm"
                variant="ghost"
                onClick={pause}
              >
                <PauseIcon />
              </Button>
            </Tooltip>
          ) : state === "paused" ? (
            <Tooltip content={t.avatar.resume}>
              <Button
                aria-label={t.avatar.resume}
                size="icon-sm"
                variant="ghost"
                onClick={resume}
              >
                <PlayIcon />
              </Button>
            </Tooltip>
          ) : null}
          {isSpeaking || state === "paused" ? (
            <Tooltip content={t.avatar.stop}>
              <Button
                aria-label={t.avatar.stop}
                size="icon-sm"
                variant="ghost"
                onClick={stop}
              >
                <SquareIcon />
              </Button>
            </Tooltip>
          ) : state === "stopped" ? (
            <Tooltip content={t.avatar.replay}>
              <Button
                aria-label={t.avatar.replay}
                className="rounded-full"
                size="icon-sm"
                variant="ghost"
                onClick={replay}
              >
                <RotateCwIcon />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={t.avatar.collapse}>
            <Button
              aria-label={t.avatar.collapse}
              size="icon-sm"
              variant="ghost"
              onClick={() => updateDock({ collapsed: true })}
            >
              <ChevronDownIcon />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div
        className="relative min-h-0 grow"
        style={{
          WebkitMaskImage:
            "radial-gradient(ellipse 72% 80% at center, #000 28%, rgb(0 0 0 / 0.9) 48%, rgb(0 0 0 / 0.45) 72%, transparent 100%)",
          maskImage:
            "radial-gradient(ellipse 72% 80% at center, #000 28%, rgb(0 0 0 / 0.9) 48%, rgb(0 0 0 / 0.45) 72%, transparent 100%)",
        }}
      >
        <AvatarCanvas
          model={model}
          modelVersion={modelVersion}
          animationUrl={animationUrl}
          mouthProvider={getMouthOpen}
          onActivate={() => {
            if (!isSpeaking) {
              setClickIndex((index) =>
                index === null
                  ? 0
                  : nextMotionIndex(index, AVATAR_CLICK_MOTIONS),
              );
            }
          }}
          onStatus={(nextStatus, nextMouthSupported) => {
            setStatus(nextStatus);
            setMouthSupported(nextMouthSupported);
          }}
        />
        {status !== "ready" ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
            <p className="text-muted-foreground text-xs">
              {status === "missing"
                ? t.avatar.modelMissing
                : status === "loading"
                  ? t.avatar.loading
                  : t.avatar.loadFailed}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-2 py-1.5">
        {state === "blocked" ? (
          <Button
            className="h-7 w-full text-xs"
            size="sm"
            variant="secondary"
            onClick={unlock}
          >
            <VolumeIcon />
            {t.avatar.enableAudio}
          </Button>
        ) : null}
        {status === "ready" && !mouthSupported ? (
          <p className="text-muted-foreground text-[11px]">
            {t.avatar.mouthUnsupported}
          </p>
        ) : null}
        {error ? (
          <p className="text-destructive text-[11px]">{t.avatar.ttsFailed}</p>
        ) : null}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
