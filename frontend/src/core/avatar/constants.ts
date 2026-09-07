/**
 * Shared constants for the browser-side VRM avatar.
 *
 * Everything here is intentionally dependency-free so it can be imported from
 * both the client components and the server route without pulling in three.js
 * or the DOM.
 */

/**
 * The TTS endpoint is served by a Next.js route handler at `src/app/tts` and
 * deliberately sits OUTSIDE `/api/**`: nginx forwards `/api/` to the Python
 * gateway (see `docker/nginx/nginx.conf`), which would 404 it in the Docker
 * stack. Any path here must keep avoiding that prefix.
 */
export const TTS_ENDPOINT = "/tts";

export const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

export const VOICE_OPTIONS = [
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 (中文女声)" },
  { value: "zh-CN-YunxiNeural", label: "云希 (中文男声)" },
  { value: "zh-CN-YunyangNeural", label: "云扬 (中文男声·播报)" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊 (中文女声)" },
  { value: "zh-HK-HiuGaaiNeural", label: "曉佳 (粵語女聲)" },
  { value: "zh-TW-HsiaoChenNeural", label: "曉臻 (國語女聲)" },
  { value: "en-US-AriaNeural", label: "Aria (English)" },
  { value: "en-US-GuyNeural", label: "Guy (English)" },
  { value: "ja-JP-NanamiNeural", label: "七海 (日本語)" },
] as const;

/** VRM lip-sync expression names, ordered by how much they contribute. */
export const MOUTH_KEYS = ["aa", "ih", "ou", "ee", "oh"] as const;

/** Relative weight applied to each mouth key so the shape is not uniform. */
export const MOUTH_WEIGHTS: Record<string, number> = {
  aa: 1,
  ih: 0.6,
  ou: 0.35,
  ee: 0.25,
  oh: 0.25,
};

/** Max characters sent to the TTS endpoint per request. */
export const MAX_CHUNK_CHARS = 120;

/** Hard ceiling for a single answer; longer reports are truncated. */
export const MAX_TOTAL_CHARS = 8000;

/** Max characters the `/tts` route will synthesize (server-side guard). */
export const TTS_MAX_CHARS = 2000;

/**
 * Model used when the user has not uploaded one. Drop a file at
 * `public/images/models/avatar.vrm`; binaries are gitignored on purpose.
 */
export const FALLBACK_MODEL_URL = "/images/models/avatar.vrm";

/** Largest VRM file accepted by the upload picker. */
export const MAX_MODEL_BYTES = 80 * 1024 * 1024;

/**
 * Built-in VRMA motions bundled under `public/images/animations/`. The `key`
 * maps to a translation in the `avatar.animationNames` dictionary.
 */
export const AVATAR_ANIMATIONS = [
  { key: "fullbody", url: "/images/animations/VRMA_01.vrma" },
  { key: "greeting", url: "/images/animations/VRMA_02.vrma" },
  { key: "peace", url: "/images/animations/VRMA_03.vrma" },
  { key: "shoot", url: "/images/animations/VRMA_04.vrma" },
  { key: "spin", url: "/images/animations/VRMA_05.vrma" },
  { key: "modelPose", url: "/images/animations/VRMA_06.vrma" },
  { key: "squat", url: "/images/animations/VRMA_07.vrma" },
] as const;

export type AvatarAnimationKey = (typeof AVATAR_ANIMATIONS)[number]["key"];

/** Select value that means "no animation playing". */
export const ANIMATION_NONE = "none" as const;

export const DOCK_STORAGE_KEY = "deerflow.avatar-dock";

export const DOCK_DEFAULT = {
  /** Distance from the viewport edges, in px. */
  right: 16,
  bottom: 16,
  collapsed: false,
  voice: DEFAULT_VOICE,
  rate: 0,
  muted: false,
} as const;

export const DOCK_SIZE = {
  width: 280,
  height: 400,
} as const;

export type DockState = {
  right: number;
  bottom: number;
  collapsed: boolean;
  voice: string;
  rate: number;
  muted: boolean;
};
