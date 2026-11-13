import { describe, expect, it } from "vitest";

import type { Quaternion } from "@timemachine/reconstruction-core";
import { buildQuaternionTextureData } from "@timemachine/point-runtime";

describe("GPU quaternion texture layout", () => {
  it("stores Hamilton quaternions as shader-compatible xyzw texels", () => {
    const quaternion: Quaternion = {
      w: 0.5,
      x: -0.25,
      y: 0.75,
      z: -0.125,
    };
    const data = buildQuaternionTextureData(
      4,
      new Map([[2, quaternion]]),
    );

    expect([...data.slice(0, 8)]).toEqual(new Array(8).fill(0));
    expect([...data.slice(8, 12)]).toEqual([
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ]);
    expect([...data.slice(12, 16)]).toEqual(new Array(4).fill(0));
  });

  it("ignores Plate IDs outside the allocated lookup texture", () => {
    const identity: Quaternion = { w: 1, x: 0, y: 0, z: 0 };
    const data = buildQuaternionTextureData(
      2,
      new Map([
        [-1, identity],
        [2, identity],
      ]),
    );

    expect([...data]).toEqual(new Array(8).fill(0));
  });
});
