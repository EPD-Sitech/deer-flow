import { AVATAR_ANIMATIONS, type AvatarAnimationKey } from "./constants";

export const AVATAR_IDLE_MOTIONS = ["peace", "greeting", "fullbody"] as const;

export const AVATAR_CLICK_MOTIONS = ["modelPose", "peace", "spin"] as const;

export const AVATAR_SPEAKING_MOTION = "modelPose" as const;

export type AvatarMotionKey = AvatarAnimationKey;

export function animationUrlForMotion(key: AvatarMotionKey): string | null {
  return (
    AVATAR_ANIMATIONS.find((animation) => animation.key === key)?.url ?? null
  );
}

export function nextMotionIndex(
  index: number,
  motions: readonly unknown[],
): number {
  return motions.length === 0
    ? 0
    : ((index % motions.length) + motions.length + 1) % motions.length;
}
