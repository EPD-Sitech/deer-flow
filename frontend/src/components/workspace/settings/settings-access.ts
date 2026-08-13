export type SettingsSection =
  | "account"
  | "appearance"
  | "channels"
  | "integrations"
  | "memory"
  | "tools"
  | "skills"
  | "notification"
  | "about";

const REGULAR_USER_SETTINGS_SECTIONS: SettingsSection[] = [
  "account",
  "appearance",
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
