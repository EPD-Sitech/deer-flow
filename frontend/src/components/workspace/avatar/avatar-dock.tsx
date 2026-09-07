"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  DramaIcon,
  PauseIcon,
  RotateCcwIcon,
  SparklesIcon,
  UploadIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/workspace/tooltip";
import {
  ANIMATION_NONE,
  AVATAR_ANIMATIONS,
  type AvatarAnimationKey,
  DOCK_SIZE,
  MAX_MODEL_BYTES,
} from "@/core/avatar/constants";
import {
  clearModel,
  getStoredModel,
  isGlbContainer,
  putModel,
} from "@/core/avatar/vrm-storage";
import { useI18n } from "@/core/i18n/hooks";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

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
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [animationKey, setAnimationKey] = useState<AvatarAnimationKey | typeof ANIMATION_NONE>("fullbody");
  const animationUrl =
    AVATAR_ANIMATIONS.find((animation) => animation.key === animationKey)?.url ??
    null;

  const { state, error, stop, unlock, getMouthOpen } = useAvatarSpeaker({
    voice: dock.voice,
    rate: dock.rate,
    muted: dock.muted,
  });

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

  const handleModelUpload = useCallback(
    async (file: File) => {
      if (file.size > MAX_MODEL_BYTES) {
        setNotice(t.avatar.tooLarge);
        return;
      }
      if (!(await isGlbContainer(file))) {
        setNotice(t.avatar.invalidModel);
        return;
      }
      try {
        await putModel(file);
      } catch {
        // Storage may be unavailable; the model still works for this session.
      }
      setModel(file);
      setModelVersion((version) => version + 1);
      setNotice(null);
    },
    [t],
  );

  const handleResetModel = useCallback(async () => {
    try {
      await clearModel();
    } catch {
      // Storage may be unavailable; dropping the in-memory model still works.
    }
    setModel(null);
    setModelVersion((version) => version + 1);
    setNotice(null);
  }, []);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      // Buttons (upload, motion menu, collapse, …) live in the draggable
      // header. Capturing the pointer on their press retargets the derived
      // click away from the button (and out of a Radix portal menu), so don't
      // start a drag when the press lands on an interactive element.
      //
      // The motion menu content is rendered in a Radix portal: it is *not* a
      // DOM child of the header, but React still routes portal events up the
      // React tree to this handler. Capturing here would steal the pointerup /
      // click away from the menu item, so a menu selection would never fire.
      // Requiring the press to be inside the header's own DOM subtree (via
      // `contains`) excludes those portaled menu items; `closest("button")`
      // additionally covers the header's own interactive buttons.
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

  const isSpeaking = state === "speaking" || state === "loading";

  return (
    <div
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl"
      style={{
        right: dock.right,
        bottom: dock.bottom,
        width: DOCK_SIZE.width,
        height: DOCK_SIZE.height,
      }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-0.5 px-1.5 py-1 active:cursor-grabbing"
        onPointerDown={startDrag}
      >
        <span className="text-muted-foreground grow pl-1 text-xs font-medium">
          {t.avatar.title}
        </span>
        <Tooltip content={t.avatar.upload}>
          <Button
            aria-label={t.avatar.upload}
            size="icon-sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon />
          </Button>
        </Tooltip>
        {model ? (
          <Tooltip content={t.avatar.resetModel}>
            <Button
              aria-label={t.avatar.resetModel}
              size="icon-sm"
              variant="ghost"
              onClick={handleResetModel}
            >
              <RotateCcwIcon />
            </Button>
          </Tooltip>
        ) : null}
        {isSpeaking ? (
          <Tooltip content={t.avatar.stop}>
            <Button
              aria-label={t.avatar.stop}
              size="icon-sm"
              variant="ghost"
              onClick={stop}
            >
              <PauseIcon />
            </Button>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <Tooltip content={t.avatar.animationLabel}>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t.avatar.animationLabel}
                size="icon-sm"
                variant="ghost"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DramaIcon />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => setAnimationKey(ANIMATION_NONE)}
            >
              <CheckIcon
                className={cn(
                  "size-3.5",
                  animationKey === ANIMATION_NONE
                    ? "opacity-100"
                    : "opacity-0",
                )}
              />
              {t.avatar.animationNone}
            </DropdownMenuItem>
            {AVATAR_ANIMATIONS.map((animation) => (
              <DropdownMenuItem
                key={animation.key}
                onClick={() => setAnimationKey(animation.key)}
              >
                <CheckIcon
                  className={cn(
                    "size-3.5",
                    animationKey === animation.key
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                {t.avatar.animationNames[animation.key]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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

      <div className="relative min-h-0 grow">
        <AvatarCanvas
          model={model}
          modelVersion={modelVersion}
          animationUrl={animationUrl}
          mouthProvider={getMouthOpen}
          onStatus={(nextStatus, nextMouthSupported) => {
            setStatus(nextStatus);
            setMouthSupported(nextMouthSupported);
          }}
        />
        {status !== "ready" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-muted-foreground text-xs">
              {status === "missing"
                ? t.avatar.modelMissing
                : status === "loading"
                  ? t.avatar.loading
                  : t.avatar.loadFailed}
            </p>
            <Button
              className="h-7 text-xs"
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              {t.avatar.upload}
            </Button>
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
        {notice ? (
          <p className="text-destructive text-[11px]">{notice}</p>
        ) : null}
        {error ? (
          <p className="text-destructive text-[11px]">{t.avatar.ttsFailed}</p>
        ) : null}
        {isSpeaking ? (
          <p className={cn("text-muted-foreground text-[11px]")} role="status">
            {t.avatar.speaking}
          </p>
        ) : null}
      </div>

      <input
        accept=".vrm"
        className="hidden"
        ref={fileInputRef}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            void handleModelUpload(file);
          }
        }}
      />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
