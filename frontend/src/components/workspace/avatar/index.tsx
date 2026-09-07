"use client";

import dynamic from "next/dynamic";

/**
 * Lazily loaded and client-only: the dock pulls in three.js, WebGL and
 * IndexedDB, none of which belong in the server render or the initial bundle.
 */
export const AvatarDock = dynamic(
  () => import("./avatar-dock").then((module) => module.default),
  { ssr: false },
);
