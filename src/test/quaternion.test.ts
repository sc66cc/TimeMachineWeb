import { describe, expect, it } from "vitest";

import {
  IDENTITY_QUATERNION,
  multiplyQuaternions,
  quaternionFromEulerPole,
  rotateLonLat,
  slerp,
} from "@timemachine/reconstruction-core";

describe("GPlates-compatible quaternion math", () => {
  it("rotates eastward around the north pole with a positive angle", () => {
    const rotation = quaternionFromEulerPole(90, 0, 90);
    const [longitude, latitude] = rotateLonLat(rotation, 0, 0);
    expect(longitude).toBeCloseTo(90, 12);
    expect(latitude).toBeCloseTo(0, 12);
  });

  it("composes parent rotation before child rotation", () => {
    const child = quaternionFromEulerPole(90, 0, 30);
    const parent = quaternionFromEulerPole(90, 0, 40);
    const composed = multiplyQuaternions(parent, child);
    const [longitude] = rotateLonLat(composed, 0, 0);
    expect(longitude).toBeCloseTo(70, 12);
  });

  it("uses shortest-path SLERP", () => {
    const halfTurn = quaternionFromEulerPole(90, 0, 180);
    const halfway = slerp(IDENTITY_QUATERNION, halfTurn, 0.5);
    const [longitude, latitude] = rotateLonLat(halfway, 0, 0);
    expect(longitude).toBeCloseTo(90, 12);
    expect(latitude).toBeCloseTo(0, 12);
  });
});
