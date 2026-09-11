import { describe, expect, it } from "@rstest/core";

import {
  AVATAR_CLICK_MOTIONS,
  AVATAR_IDLE_MOTIONS,
  AVATAR_SPEAKING_MOTION,
  animationUrlForMotion,
  nextMotionIndex,
} from "@/core/avatar/motion-choreography";

describe("avatar motion choreography", () => {
  it("uses peace, greeting, and full body for idle playback", () => {
    expect(AVATAR_IDLE_MOTIONS).toEqual(["peace", "greeting", "fullbody"]);
    expect(animationUrlForMotion("fullbody")).toContain("VRMA_01.vrma");
  });

  it("uses pose, peace, and spin for successive clicks", () => {
    expect(AVATAR_CLICK_MOTIONS).toEqual(["modelPose", "peace", "spin"]);
    expect(nextMotionIndex(0, AVATAR_CLICK_MOTIONS)).toBe(1);
    expect(nextMotionIndex(2, AVATAR_CLICK_MOTIONS)).toBe(0);
  });

  it("uses the posing motion while speaking", () => {
    expect(AVATAR_SPEAKING_MOTION).toBe("modelPose");
    expect(animationUrlForMotion("modelPose")).toContain("VRMA_06.vrma");
  });
});
