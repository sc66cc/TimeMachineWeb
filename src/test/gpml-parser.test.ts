// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isFeatureValidAtTime,
  parseGpmlPlatePolygons,
} from "@timemachine/reconstruction-core";

describe("GPML plate polygon parser", () => {
  it("parses the supplied feature and polygon counts", () => {
    const xml = readFileSync(
      resolve("data/PlateModelData/PALEOMAP_PlatePolygons.gpml"),
      "utf8",
    );
    const result = parseGpmlPlatePolygons(xml);
    expect(result.features).toHaveLength(471);
    expect(result.polygonCount).toBe(503);
    expect(result.unsupportedGeometryCount).toBe(2);
    expect(new Set(result.features.map((feature) => feature.plateId)).size).toBe(
      241,
    );
  });

  it("uses GPlates geological-time ordering", () => {
    expect(
      isFeatureValidAtTime(
        { validFromMa: 140, validToMa: 0 },
        100,
      ),
    ).toBe(true);
    expect(
      isFeatureValidAtTime(
        { validFromMa: 140, validToMa: 0 },
        200,
      ),
    ).toBe(false);
  });
});
