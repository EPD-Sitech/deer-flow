"use client";

import { SafeStreamdown } from "@/core/streamdown/components";

import { brandedAboutMarkdown } from "./branded-about-content";

export function AboutSettingsPage() {
  return <SafeStreamdown>{brandedAboutMarkdown}</SafeStreamdown>;
}
