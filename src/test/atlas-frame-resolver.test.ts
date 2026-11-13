import { describe, expect, it } from "vitest";

import {
  AtlasFrameResolver,
  parsePaleoAtlasManifest,
} from "@timemachine/raster-runtime";

function manifestValue(): unknown {
  return {
    schemaVersion: 1,
    id: "atlas-test",
    label: "Atlas test",
    attribution: "Test",
    frameSelection: "nearest",
    outOfRangePolicy: "hide",
    tiles: {
      crs: "EPSG:3857",
      tileMatrixSet: "WebMercatorQuad",
      tileSize: 256,
      format: "image/jpeg",
      minimumLevel: 0,
      maximumLevel: 4,
      bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
    },
    frames: [200, 0, 100].map((timeMa) => ({
      timeMa,
      label: `${timeMa} Ma`,
      sourceId: `frame_${timeMa}`,
      sourceFile: `${timeMa}.jpg`,
      sourceSha256: `${timeMa}`.padStart(64, "0"),
      tileUrl: `/tiles/frame_${timeMa}/{z}/{x}/{y}`,
      byteLength: 1024,
    })),
  };
}

describe("PaleoAtlas frame resolution", () => {
  it("sorts frames and resolves exact or nearest ages", () => {
    const resolver = new AtlasFrameResolver(
      parsePaleoAtlasManifest(manifestValue()),
    );

    expect(resolver.resolve(100)?.timeMa).toBe(100);
    expect(resolver.resolve(74)?.timeMa).toBe(100);
    expect(resolver.resolve(50)?.timeMa).toBe(0);
    expect(resolver.resolve(151)?.timeMa).toBe(200);
  });

  it("hides the atlas outside the manifest range", () => {
    const resolver = new AtlasFrameResolver(
      parsePaleoAtlasManifest(manifestValue()),
    );

    expect(resolver.resolve(-1)).toBeUndefined();
    expect(resolver.resolve(201)).toBeUndefined();
  });

  it("rejects duplicate frame ages", () => {
    const value = manifestValue() as {
      frames: Array<Record<string, unknown>>;
    };
    value.frames[1] = { ...value.frames[0], sourceId: "other" };

    expect(() => parsePaleoAtlasManifest(value)).toThrow(/unique/);
  });
});
