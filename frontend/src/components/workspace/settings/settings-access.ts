export type SettingsSection =
  | "account"
  | "appearance"
  | "channels"
  | "integrations"
  | "memory"
  | "tools"
  | "skills"
  | "subagents"
  | "notification"
  | "about";

const REGULAR_USER_SETTINGS_SECTIONS: SettingsSection[] = [
  "account",
  "appearance",
  // 渠道页是嵌入 im-bridge 管理 UI 的 iframe；普通用户进入后只能走
  // requireBindAuth 绑定自己的微信，运维写操作仍受 IM_BRIDGE_ADMIN_TOKEN 保护。
  "channels",
];

export function getVisibleSettingsSections(isAdmin: boolean) {
  return isAdmin ? null : REGULAR_USER_SETTINGS_SECTIONS;
}

export function resolveVisibleSettingsSection(
  section: SettingsSection,
  isAdmin: boolean,
): SettingsSection {
  if (isAdmin || REGULAR_USER_SETTINGS_SECTIONS.includes(section)) {
    return section;
  }
  return "appearance";
}
