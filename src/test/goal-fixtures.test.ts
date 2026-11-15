import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Cartesian3, Matrix4 } from "cesium";
import {
  inverseQuaternion,
  lonLatToUnitVector,
  multiplyQuaternions,
  parsePlatesRotationFile,
  rotateLonLat,
  rotateVector,
  RotationModel,
} from "@timemachine/reconstruction-core";
import { quaternionToCesiumMatrix } from "@timemachine/cesium-runtime";
import { LOCAL_PROJECT_DRAFT_KEY, ProjectSession } from "../project/project-session";

const fixtureDirectory = resolve(process.cwd(), "data/goal-fixtures");
const text = (name: string): string => readFileSync(resolve(fixtureDirectory, name), "utf8");
const restore = (name: string) => ProjectSession.restore({
  getItem: (key: string) => key === LOCAL_PROJECT_DRAFT_KEY ? text(name) : null,
  setItem: () => undefined,
});

interface RotationOracle {
  toleranceDegrees: number;
  cases: Array<{
    id: string;
    model: string;
    timeMa: number;
    plateId: number;
    anchorPlateId: number;
    sourceLonLat: [number, number];
    expectedLonLat: [number, number];
  }>;
}

interface NoncoaxialOracle {
  model: string;
  timeMa: number;
  plateId: number;
  anchorPlateId: number;
  sourceLonLat: [number, number];
  expectedLonLat: [number, number];
  reversedOrderLonLat: [number, number];
  toleranceDegrees: number;
}

describe("portable synthetic Goal fixtures", () => {
  it("validates frozen hashes, geometry, NoData and independently listed sample values", () => {
    const result = JSON.parse(execFileSync(process.execPath, ["scripts/validate-goal-fixtures.mjs"], { encoding: "utf8" }));
    expect(result.status).toBe("PASS");
    expect(result.features).toBe(12);
    expect(result.shiftedSeamFeatures).toBe(2);
    expect(result.rejectedGeometries).toBe(5);
    expect(result.liveServiceEvidence).toBe(false);
  });

  it("rejects the deliberate unclosed-ring fixture through the CLI", () => {
    expect(() => execFileSync(process.execPath, ["scripts/validate-goal-fixtures.mjs", "--negative-case", "unclosed-ring"], { encoding: "utf8", stdio: "pipe" })).toThrow(/RING_CLOSED/);
  });

  const oracle = JSON.parse(text("rotation-oracle.json")) as RotationOracle;
  it.each(oracle.cases)("matches hand-derived north-pole rotation: $id", (entry) => {
    const parsed = parsePlatesRotationFile(text(entry.model));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.sequences).toHaveLength(2);
    const model = new RotationModel(parsed.sequences, { extendToDistantPast: false });
    const rotation = model.getRotation(entry.timeMa, entry.plateId, entry.anchorPlateId);
    expect(rotation).toBeDefined();
    const actual = rotateLonLat(rotation!, ...entry.sourceLonLat);
    expect(Math.abs(actual[0] - entry.expectedLonLat[0])).toBeLessThanOrEqual(oracle.toleranceDegrees);
    expect(Math.abs(actual[1] - entry.expectedLonLat[1])).toBeLessThanOrEqual(oracle.toleranceDegrees);
  });

  it("honors the tiny rotation model endpoints when distant-past extension is explicitly disabled", () => {
    const model = new RotationModel(parsePlatesRotationFile(text("model-b.rot")).sequences, { extendToDistantPast: false });
    expect(model.getRotation(0, 101, 0)).toBeDefined();
    expect(model.getRotation(100, 101, 0)).toBeDefined();
    expect(model.getRotation(-1, 101, 0)).toBeUndefined();
    expect(model.getRotation(101, 101, 0)).toBeUndefined();
  });

  it("matches the hand-derived noncoaxial anchor result in geographic and Cesium coordinates", () => {
    const expected = JSON.parse(text("rotation-noncoaxial-oracle.json")) as NoncoaxialOracle;
    const parsed = parsePlatesRotationFile(text(expected.model));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.sequences).toHaveLength(2);
    const model = new RotationModel(parsed.sequences, { extendToDistantPast: false });
    const rotation = model.getRotation(expected.timeMa, expected.plateId, expected.anchorPlateId);
    expect(rotation).toBeDefined();
    const actual = rotateLonLat(rotation!, ...expected.sourceLonLat);
    expect(Math.abs(actual[0] - expected.expectedLonLat[0])).toBeLessThanOrEqual(expected.toleranceDegrees);
    expect(Math.abs(actual[1] - expected.expectedLonLat[1])).toBeLessThanOrEqual(expected.toleranceDegrees);

    // Independent right-handed basis: X=(lon0,lat0), Y=(lon90,lat0), Z=north.
    // p=(s,0,s), Rz(+90)p=(0,s,s), Rx(-90)Rz(+90)p=(0,s,-s).
    // The current project/Cesium basis is the same basis: no Unity-axis swap.
    const s = Math.SQRT1_2;
    const source = lonLatToUnitVector(...expected.sourceLonLat);
    expect(source.x).toBeCloseTo(s, 14);
    expect(source.y).toBeCloseTo(0, 14);
    expect(source.z).toBeCloseTo(s, 14);
    const vector = rotateVector(rotation!, source);
    expect(vector.x).toBeCloseTo(0, 12);
    expect(vector.y).toBeCloseTo(s, 12);
    expect(vector.z).toBeCloseTo(-s, 12);
    const cesium = Matrix4.multiplyByPoint(
      quaternionToCesiumMatrix(rotation!),
      new Cartesian3(s, 0, s),
      new Cartesian3(),
    );
    expect(cesium.x).toBeCloseTo(0, 12);
    expect(cesium.y).toBeCloseTo(s, 12);
    expect(cesium.z).toBeCloseTo(-s, 12);
  });

  it("distinguishes the deliberately reversed noncoaxial composition from the independent oracle", () => {
    const expected = JSON.parse(text("rotation-noncoaxial-oracle.json")) as NoncoaxialOracle;
    const model = new RotationModel(parsePlatesRotationFile(text(expected.model)).sequences);
    const moving = model.getRotation(expected.timeMa, expected.plateId, 0)!;
    const anchor = model.getRotation(expected.timeMa, expected.anchorPlateId, 0)!;
    // Negative control only; neither this result nor any production result creates expected values.
    const reversed = multiplyQuaternions(moving, inverseQuaternion(anchor));
    const actual = rotateLonLat(reversed, ...expected.sourceLonLat);
    expect(Math.abs(actual[0] - expected.reversedOrderLonLat[0])).toBeLessThanOrEqual(expected.toleranceDegrees);
    expect(Math.abs(actual[1] - expected.reversedOrderLonLat[1])).toBeLessThanOrEqual(expected.toleranceDegrees);
    expect(Math.abs(actual[0] - expected.expectedLonLat[0])).toBeGreaterThan(40);
    expect(Math.abs(actual[1] - expected.expectedLonLat[1])).toBeGreaterThan(40);
  });

  it("restores the currently supported legacy four-layer snapshot", () => {
    const session = restore("project-v2.json");
    expect(session).toBeDefined();
    expect(session!.timeMa).toBe(50);
    expect(session!.groupList.map((group) => group.id)).toEqual([101, 102]);
    expect(session!.layerList.map((layer) => [layer.id, layer.type])).toEqual([[1, 4], [2, 0], [3, 3], [4, 5]]);
  });

  it("preserves unknown local fixture fields through saving and refresh with an explicit cloud compatibility report", () => {
    const session = restore("project-v2-unknown.json");
    expect(session).toBeDefined();
    let serialized = text("project-v2-unknown.json");
    const storage = { getItem: () => serialized, setItem: (_key: string, value: string) => { serialized = value; } };
    session!.setTime(110);
    session!.save(storage);
    const restored = ProjectSession.restore(storage)!;
    const roundTrip = JSON.stringify(restored.toSnapshot());
    expect(roundTrip).toContain("preserve-me");
    expect(roundTrip).toContain("group-marker");
    expect(roundTrip).toContain("future-instance-a");
    expect(restored.timeMa).toBe(110);
    expect(restored.compatibilityReport).toMatchObject({ writable: true, cloudWritable: false });
    expect(restored.compatibilityReport.issues.some(issue => issue.code === "preserved-field" && issue.preserved)).toBe(true);
    expect(() => restored.toDocument()).toThrow();
  });

  it("rejects unsupported versions and corrupted JSON", () => {
    expect(() => restore("project-unsupported-version.json")).toThrow(/schema version 2/);
    expect(() => restore("project-corrupt.json.txt")).toThrow(SyntaxError);
  });
});
