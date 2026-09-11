import { describe, expect, it } from "@rstest/core";

import {
  getVisibleSettingsSections,
  resolveVisibleSettingsSection,
} from "@/components/workspace/settings/settings-access";

describe("settings access", () => {
  it("limits regular users to account, appearance, and channels", () => {
    expect(getVisibleSettingsSections(false)).toEqual([
      "account",
      "appearance",
      "channels",
    ]);
    expect(resolveVisibleSettingsSection("tools", false)).toBe("appearance");
    expect(resolveVisibleSettingsSection("account", false)).toBe("account");
  });

  it("keeps all settings available to administrators", () => {
    expect(getVisibleSettingsSections(true)).toBeNull();
    expect(resolveVisibleSettingsSection("tools", true)).toBe("tools");
  });
});
