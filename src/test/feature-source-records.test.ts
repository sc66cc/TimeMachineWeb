import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlateFeature } from "@timemachine/reconstruction-core";
import type { LoadedPointDataset } from "../../packages/point-runtime/src/types";
import * as wgp from "../../packages/point-runtime/src/wgp-format";
import { AgentActionValidationError } from "../agent-actions/registry";
import { summarizeFeatureAttributes } from "../layers/feature-attributes";
import {
  createPointFeatureId,
  parsePointFeatureId,
  projectPlateFeatureAttributes,
  readPointFeatureAttributes,
} from "../layers/feature-source-records";

// Independent, in-memory WGP1 fixture: 64-byte header and two 20-byte records.
// No generator, external dataset or service is used to prepare these bytes.
function tinyDataset(datasetId = "synthetic:古生物/row:测试"): LoadedPointDataset {
  const buffer = new ArrayBuffer(104);
  new Uint8Array(buffer, 0, 4).set([87, 71, 80, 49]);
  const view = new DataView(buffer);
  for (const [offset, value] of [[4, 1], [8, 64], [12, 20], [16, 2], [20, 2], [24, 9], [28, 11000]]) {
    view.setUint32(offset!, value!, true);
  }
  view.setFloat32(64, 1, true);
  view.setFloat32(68, 0, true);
  view.setFloat32(72, 0, true);
  view.setUint16(76, 11000, true);
  view.setUint16(78, 125, true);
  view.setUint16(80, 7, true);
  view.setUint16(82, 11, true);
  view.setFloat32(84, -0.5, true);
  view.setFloat32(88, 0.5, true);
  view.setFloat32(92, 0.75, true);
  view.setUint16(96, 875, true);
  view.setUint16(98, 0, true);
  view.setUint16(100, 9, true);
  view.setUint16(102, 65535, true);
  return {
    datasetId, buffer, header: wgp.parsePointBinaryHeader(buffer),
    timings: { cacheHit: false, fetchMs: 0, decodeMs: 0, totalMs: 0 },
  };
}

function plate(overrides: Partial<PlateFeature> = {}): PlateFeature {
  return {
    id: "feature-A", plateId: 101, name: "A", description: "Source description",
    validFromMa: Infinity, validToMa: -Infinity, sourceIndex: 3,
    polygons: [{ exterior: [[0, 0], [1, 0], [0, 1]], holes: [] }], ...overrides,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("stable GPU feature identity", () => {
  it("encodes colon, Unicode and reserved text exactly once and round-trips row zero/last", () => {
    const dataset = tinyDataset();
    const expected = "wgp:synthetic%3A%E5%8F%A4%E7%94%9F%E7%89%A9%2Frow%3A%E6%B5%8B%E8%AF%95:row:";
    expect(createPointFeatureId(dataset.datasetId, 0)).toBe(expected + "0");
    expect(createPointFeatureId(dataset.datasetId, 1)).toBe(expected + "1");
    expect(parsePointFeatureId(expected + "0", dataset)).toBe(0);
    expect(parsePointFeatureId(expected + "1", dataset)).toBe(1);
    const literalEscape = tinyDataset("source%3Araw");
    expect(createPointFeatureId(literalEscape.datasetId, 1)).toBe("wgp:source%253Araw:row:1");
    expect(parsePointFeatureId("wgp:source%253Araw:row:1", literalEscape)).toBe(1);
  });

  it("does not silently normalize distinct dataset identities", () => {
    const dataset = tinyDataset(" source ");
    expect(createPointFeatureId(dataset.datasetId, 1)).toBe("wgp:%20source%20:row:1");
    expect(() => parsePointFeatureId("wgp:source:row:1", dataset)).toThrow(AgentActionValidationError);
    expect(createPointFeatureId("é", 0)).not.toBe(createPointFeatureId("e\u0301", 0));
  });

  it.each(["", "  ", "\uD800", undefined, 4])("rejects an invalid dataset ID without URIError leakage: %j", datasetId => {
    expect(() => createPointFeatureId(datasetId as string, 0)).toThrow(AgentActionValidationError);
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects unsafe row ID: %s", rowId => {
    expect(() => createPointFeatureId("source", rowId as number)).toThrow(AgentActionValidationError);
  });

  it.each([
    "wgp:source:row:00", "wgp:source:row:01", "wgp:source:row:-0", "wgp:source:row:+1",
    "wgp:source:row:1.0", "wgp:source:row:1e0", "wgp:source:row: 1", "wgp:source:row:1 ",
    "wgp:source:row:1\n", "wgp:source:row:1:extra", "wgp:source:row:NaN", "wgp:source:row:Infinity",
    "wgp:source:row:9007199254740992", "wgp:source:row:", "WGP:source:row:1", "wgp:other:row:1",
    "wgp:%73ource:row:1", "wgp:%source:row:1",
  ])("rejects noncanonical/mismatched ID before touching a point record: %s", featureId => {
    const dataset = tinyDataset("source");
    const read = vi.spyOn(wgp, "readPointRecord");
    expect(() => readPointFeatureAttributes(dataset, featureId)).toThrow(AgentActionValidationError);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects lowercase escapes or raw Unicode even when they decode to the same dataset", () => {
    const dataset = tinyDataset("source:é");
    expect(() => parsePointFeatureId("wgp:source%3a%C3%A9:row:1", dataset)).toThrow(AgentActionValidationError);
    expect(() => parsePointFeatureId("wgp:source%3Aé:row:1", dataset)).toThrow(AgentActionValidationError);
  });

  it("bounds rows by this loaded header's count, including an empty dataset", () => {
    const dataset = tinyDataset("source");
    const read = vi.spyOn(wgp, "readPointRecord");
    expect(() => readPointFeatureAttributes(dataset, "wgp:source:row:2")).toThrow(AgentActionValidationError);
    expect(read).not.toHaveBeenCalled();
    expect(() => parsePointFeatureId("wgp:source:row:0", { ...dataset, header: { ...dataset.header, pointCount: 0 } })).toThrow(AgentActionValidationError);
  });

  it("rejects mismatch and invalid/out-of-range rows before accessing the source buffer", () => {
    const dataset = tinyDataset("source");
    const readBuffer = vi.fn(() => { throw new Error("must validate before buffer access"); });
    Object.defineProperty(dataset, "buffer", { get: readBuffer });
    for (const id of ["wgp:other:row:0", "wgp:source:row:2", "wgp:source:row:01", undefined, 1]) {
      expect(() => readPointFeatureAttributes(dataset, id as string)).toThrow(AgentActionValidationError);
    }
    expect(readBuffer).not.toHaveBeenCalled();
  });

  it("rejects a malformed loaded header instead of treating an unbounded count as valid", () => {
    const dataset = tinyDataset("source");
    for (const count of [-1, NaN, Infinity, 0.5]) {
      expect(() => parsePointFeatureId("wgp:source:row:0", { ...dataset, header: { ...dataset.header, pointCount: count } })).toThrow(/point count/);
    }
  });
});

describe("source record projection", () => {
  it("reads actual WGP record bytes through readPointRecord and exposes only the small source record", () => {
    const dataset = tinyDataset();
    const read = vi.spyOn(wgp, "readPointRecord");
    expect(readPointFeatureAttributes(dataset, createPointFeatureId(dataset.datasetId, 0))).toEqual({
      datasetId: dataset.datasetId, rowId: 0, unitPosition: [1, 0, 0],
      plateId: 7, occurrenceCount: 11, validFromMa: 1100, validToMa: 12.5,
    });
    expect(readPointFeatureAttributes(dataset, createPointFeatureId(dataset.datasetId, 1))).toEqual({
      datasetId: dataset.datasetId, rowId: 1, unitPosition: [-0.5, 0.5, 0.75],
      plateId: 9, occurrenceCount: 65535, validFromMa: 87.5, validToMa: 0,
    });
    expect(read).toHaveBeenNthCalledWith(1, dataset.buffer, 0);
    expect(read).toHaveBeenNthCalledWith(2, dataset.buffer, 1);
  });

  it("leaves the original WGP buffer/header unchanged and returns independent position arrays", () => {
    const dataset = tinyDataset();
    const before = new Uint8Array(dataset.buffer).slice();
    const header = { ...dataset.header };
    const first = readPointFeatureAttributes(dataset, createPointFeatureId(dataset.datasetId, 0));
    Reflect.set(first.unitPosition, "0", 99);
    first.plateId = 900;
    expect(new Uint8Array(dataset.buffer)).toEqual(before);
    expect(dataset.header).toEqual(header);
    expect(readPointFeatureAttributes(dataset, createPointFeatureId(dataset.datasetId, 0))).toMatchObject({ unitPosition: [1, 0, 0], plateId: 7 });
  });

  it("preserves genuine WGP corruption errors instead of treating malformed data as an empty record", () => {
    const dataset = tinyDataset("source");
    new Uint8Array(dataset.buffer)[0] = 88;
    expect(() => readPointFeatureAttributes(dataset, "wgp:source:row:0")).toThrow(/Unsupported point file magic/);
  });

  it("uses feature identity, not plate identity, for duplicate plate IDs", () => {
    const first = projectPlateFeatureAttributes(plate());
    const second = projectPlateFeatureAttributes(plate({ id: "feature-B", sourceIndex: 8 }));
    expect(first.plateId).toBe(second.plateId);
    expect(first.id).toBe("feature-A");
    expect(second.id).toBe("feature-B");
    expect(second.sourceIndex).toBe(8);
  });

  it("projects exactly the seven plate fields without reading or cloning geometry", () => {
    const feature = plate();
    const geometry = vi.fn(() => { throw new Error("Geometry must not be read"); });
    Object.defineProperty(feature, "polygons", { get: geometry });
    expect(projectPlateFeatureAttributes(feature)).toEqual({
      id: "feature-A", name: "A", description: "Source description", plateId: 101,
      validFromMa: Infinity, validToMa: -Infinity, sourceIndex: 3,
    });
    expect(geometry).not.toHaveBeenCalled();
  });

  it("preserves original nonfinite ages for the bounded summary and does not mutate the plate", () => {
    const feature = plate({ validToMa: NaN });
    const projection = projectPlateFeatureAttributes(feature);
    expect(projection.validFromMa).toBe(Infinity);
    expect(projection.validToMa).toBeNaN();
    projection.name = "edited output";
    expect(feature.name).toBe("A");
    expect(summarizeFeatureAttributes(projectPlateFeatureAttributes(feature)).attributes).toMatchObject({
      validFromMa: "[Infinity]", validToMa: "[NaN]",
    });
    expect(feature.validFromMa).toBe(Infinity);
    expect(feature.validToMa).toBeNaN();
  });
});
