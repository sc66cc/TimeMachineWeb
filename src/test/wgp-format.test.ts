import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type PointFixtureManifest,
  WGP_HEADER_BYTES,
  WGP_RECORD_STRIDE_BYTES,
  parsePointBinaryHeader,
  readPointRecord,
} from "@timemachine/point-runtime";

const fixtureDirectory = resolve("data/generated/points");

function readArrayBuffer(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("WGP1 point fixtures", () => {
  it("matches every manifest count and exact byte length", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(fixtureDirectory, "manifest.json"), "utf8"),
    ) as PointFixtureManifest;

    expect(manifest.format.magic).toBe("WGP1");
    expect(manifest.validityPolicy).toBe("permanent_0_1100_ma");
    expect(manifest.unassignedPointPolicy).toBe(
      "anchor_plate_0_for_benchmark",
    );
    expect(manifest.datasets.map((entry) => entry.pointCount)).toEqual([
      10_000,
      100_000,
      275_000,
      275_291,
      1_000_000,
      3_000_000,
      5_000_000,
    ]);

    for (const entry of manifest.datasets) {
      const buffer = readArrayBuffer(resolve(fixtureDirectory, entry.fileName));
      const header = parsePointBinaryHeader(buffer);
      expect(header.pointCount).toBe(entry.pointCount);
      expect(buffer.byteLength).toBe(
        WGP_HEADER_BYTES + entry.pointCount * WGP_RECORD_STRIDE_BYTES,
      );
      expect(buffer.byteLength).toBe(entry.byteLength);
    }
  });

  it("encodes normalized positions with permanent benchmark validity", () => {
    const buffer = readArrayBuffer(
      resolve(fixtureDirectory, "pbdb-10k.wgp"),
    );
    const header = parsePointBinaryHeader(buffer);
    const view = new DataView(buffer);

    for (let index = 0; index < header.pointCount; index += 1) {
      const offset =
        header.headerBytes + index * header.recordStrideBytes;
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      const validFrom = view.getUint16(offset + 12, true);
      const validTo = view.getUint16(offset + 14, true);
      const plateId = view.getUint16(offset + 16, true);
      const magnitude = Math.hypot(x, y, z);

      expect(magnitude).toBeCloseTo(1, 5);
      expect(validFrom).toBe(header.maxTimeDeciMa);
      expect(validTo).toBe(0);
      expect(plateId).toBeLessThanOrEqual(header.maxPlateId);
    }
  });

  it("reports a constant resident count at every timeline age", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(fixtureDirectory, "manifest.json"), "utf8"),
    ) as PointFixtureManifest;

    for (const entry of manifest.datasets) {
      expect(new Set(entry.activeCountsByIntegerMa).size).toBe(1);
      expect(entry.activeCountsByIntegerMa).toHaveLength(1_101);
      expect(entry.activeCountsByIntegerMa[0]).toBe(entry.pointCount);
    }
  });

  it("decodes one attribute record by its implicit row ID", () => {
    const buffer = readArrayBuffer(
      resolve(fixtureDirectory, "pbdb-10k.wgp"),
    );
    const record = readPointRecord(buffer, 17);

    expect(record.rowId).toBe(17);
    expect(Math.hypot(...record.unitPosition)).toBeCloseTo(1, 5);
    expect(record.validFromMa).toBe(1_100);
    expect(record.validToMa).toBe(0);
    expect(record.plateId).toBeGreaterThanOrEqual(0);
    expect(record.occurrenceCount).toBeGreaterThanOrEqual(0);
    expect(() => readPointRecord(buffer, 10_000)).toThrow(
      "outside this WGP dataset",
    );
  });

  it("rejects corrupted magic and truncated payloads", () => {
    const buffer = readArrayBuffer(
      resolve(fixtureDirectory, "pbdb-10k.wgp"),
    );
    const corruptMagic = buffer.slice(0);
    new Uint8Array(corruptMagic)[0] = "X".charCodeAt(0);

    expect(() => parsePointBinaryHeader(corruptMagic)).toThrow(
      /Unsupported point file magic/,
    );
    expect(() =>
      parsePointBinaryHeader(buffer.slice(0, buffer.byteLength - 1)),
    ).toThrow(/expected/);
  });
});
