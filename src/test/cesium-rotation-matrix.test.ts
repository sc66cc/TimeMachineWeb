import { Cartesian3, Matrix4 } from "cesium";
import { describe, expect, it } from "vitest";

import {
  lonLatToUnitVector,
  quaternionFromEulerPole,
  rotateVector,
} from "@timemachine/reconstruction-core";
import { quaternionToCesiumMatrix } from "@timemachine/cesium-runtime";

describe("Cesium model matrix convention", () => {
  it("matches the GPlates quaternion-vector formula", () => {
    const quaternion = quaternionFromEulerPole(42, -75, 63);
    const input = lonLatToUnitVector(130, -18);
    const expected = rotateVector(quaternion, input);
    const actual = Matrix4.multiplyByPoint(
      quaternionToCesiumMatrix(quaternion),
      new Cartesian3(input.x, input.y, input.z),
      new Cartesian3(),
    );

    expect(actual.x).toBeCloseTo(expected.x, 12);
    expect(actual.y).toBeCloseTo(expected.y, 12);
    expect(actual.z).toBeCloseTo(expected.z, 12);
  });
});
