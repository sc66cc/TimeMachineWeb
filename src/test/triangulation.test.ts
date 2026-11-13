// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseGpmlPlatePolygons } from "@timemachine/reconstruction-core";
import { triangulatePlatePolygon } from "@timemachine/cesium-runtime";

describe("Cesium spherical triangulation", () => {
  it("triangulates every supplied GPML polygon", () => {
    const xml = readFileSync(
      resolve("data/PlateModelData/PALEOMAP_PlatePolygons.gpml"),
      "utf8",
    );
    const parsed = parseGpmlPlatePolygons(xml);
    let polygonCount = 0;
    let triangleCount = 0;

    for (const feature of parsed.features) {
      for (const polygon of feature.polygons) {
        const result = triangulatePlatePolygon(polygon);
        polygonCount += 1;
        triangleCount += result.triangleCount;
        expect(result.triangleCount).toBeGreaterThan(0);
      }
    }

    expect(polygonCount).toBe(503);
    expect(triangleCount).toBeGreaterThan(20_000);
  });
});
