import { describe, expect, it } from "vitest";

import {
  normalizePointStyleExpression,
  PointDatasetCache,
  type LoadedPointDataset,
} from "@timemachine/point-runtime";

function dataset(id: string, byteLength: number): LoadedPointDataset {
  return {
    buffer: new ArrayBuffer(byteLength),
    datasetId: id,
    header: {
      headerBytes: 64,
      magic: "WGP1",
      maxPlateId: 0,
      maxTimeDeciMa: 0,
      pointCount: 0,
      recordStrideBytes: 20,
      sourcePointCount: 0,
      version: 1,
    },
    timings: {
      cacheHit: false,
      decodeMs: 2,
      fetchMs: 4,
      totalMs: 6,
    },
  };
}

describe("point style expression", () => {
  it("normalizes the supported declarative style fields", () => {
    const style = normalizePointStyleExpression({
      colorMode: "occurrence",
      filter: {
        maximumOccurrence: 20,
        minimumOccurrence: 5,
        plateId: 101,
      },
      occurrenceSizeScale: 1.8,
      pointSize: 3.4,
      schemaVersion: 99,
      shape: "square",
      singleColor: "#AABBCC",
      sizeMode: "fixed",
      arbitraryJavaScript: "alert(1)",
    });

    expect(style).toEqual({
      colorMode: "occurrence",
      filter: {
        maximumOccurrence: 20,
        minimumOccurrence: 5,
        plateId: 101,
      },
      occurrenceSizeScale: 1.8,
      pointSize: 3.4,
      schemaVersion: 1,
      shape: "square",
      singleColor: "#aabbcc",
      sizeMode: "fixed",
    });
    expect("arbitraryJavaScript" in style).toBe(false);
  });

  it("clamps invalid numeric filters and rejects invalid colors", () => {
    const style = normalizePointStyleExpression({
      filter: {
        maximumOccurrence: 2,
        minimumOccurrence: 10,
        plateId: -1,
      },
      occurrenceSizeScale: 99,
      pointSize: -4,
      singleColor: "javascript:alert(1)",
    });

    expect(style.pointSize).toBe(0.5);
    expect(style.occurrenceSizeScale).toBe(4);
    expect(style.filter).toEqual({
      maximumOccurrence: 10,
      minimumOccurrence: 10,
      plateId: null,
    });
    expect(style.singleColor).toBe("#f29d38");
  });
});

describe("point dataset LRU cache", () => {
  it("promotes hits and evicts the least recently used buffers", () => {
    const cache = new PointDatasetCache(10);
    cache.set("a", "/a", dataset("a", 4));
    cache.set("b", "/b", dataset("b", 4));
    expect(cache.get("a", "/a")?.timings.cacheHit).toBe(true);

    cache.set("c", "/c", dataset("c", 4));

    expect(cache.get("a", "/a")).toBeDefined();
    expect(cache.get("b", "/b")).toBeUndefined();
    expect(cache.get("c", "/c")).toBeDefined();
    expect(cache.sizeBytes).toBe(8);
  });

  it("does not retain one buffer larger than the cache budget", () => {
    const cache = new PointDatasetCache(4);
    cache.set("large", "/large", dataset("large", 8));

    expect(cache.get("large", "/large")).toBeUndefined();
    expect(cache.sizeBytes).toBe(0);
  });
});
