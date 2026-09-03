"use client";

import { useI18n } from "@/core/i18n/hooks";

import { SettingsSection } from "./settings-section";

// The IM channel management surface is the standalone im-bridge service (a
// dsh-im-style multi-bot manager for personal WeChat + Feishu).
//
// Target resolution:
// - Docker / production: DeerFlow's nginx proxies /im-bridge/ -> im-bridge, so the
//   same-origin default works (NEXT_PUBLIC_IM_BRIDGE_URL unset).
// - Local dev: the Next.js dev server ( :3000 ) does NOT proxy /im-bridge/, so point
//   this at the im-bridge origin directly, e.g. in frontend/.env.local:
//   NEXT_PUBLIC_IM_BRIDGE_URL=http://localhost:10010
const IM_BRIDGE_URL = process.env.NEXT_PUBLIC_IM_BRIDGE_URL ?? "/im-bridge/";

export function ChannelsSettingsPage() {
  const { t } = useI18n();
  return (
    <SettingsSection
      title={t.settings.channels.title}
      description={t.settings.channels.description}
    >
      <iframe
        src={IM_BRIDGE_URL}
        title={t.settings.channels.title}
        className="h-[64vh] w-full rounded-lg border bg-background"
      />
    </SettingsSection>
  );
}
