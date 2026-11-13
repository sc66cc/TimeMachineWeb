// @vitest-environment jsdom

import { Cartesian3, Matrix4 } from "cesium";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IDENTITY_QUATERNION,
  lonLatToUnitVector,
  quaternionFromEulerPole,
  rotateVector,
  type LonLat,
  type PlateFeature,
  type Quaternion,
} from "@timemachine/reconstruction-core";
import {
  buildRectanglePlateCpuFrame,
  type RectanglePlateCpuFrame,
} from "../../packages/cesium-runtime/src/plate-rectangle-frame";
import {
  OUTLINE_ELLIPSOID,
  lonLatToCartesian,
  triangulatePlatePolygon,
} from "../../packages/cesium-runtime/src/geometry";
import {
  capturePlatePolygonMesh,
  type PlatePolygonMeshSnapshot,
} from "../../packages/cesium-runtime/src/plate-mesh-snapshot";
import { quaternionToCesiumMatrix } from "../../packages/cesium-runtime/src/plate-rotation-matrix";

// Advance posted messages explicitly with Vitest's macrotask clock. Each build
// must reuse its channel and close both ports, including cancellation paths.
const channels: TestMessageChannel[] = [];
class TestMessageChannel {
  timer: ReturnType<typeof setTimeout> | undefined;
  port1 = { onmessage: null as (() => void) | null, close: vi.fn(() => {
    clearTimeout(this.timer);
  }) };
  port2 = { postMessage: () => {
    this.timer = setTimeout(() => this.port1.onmessage?.(), 0);
  }, close: vi.fn() };
  constructor() { channels.push(this); }
}
beforeEach(() => {
  channels.length = 0;
  vi.stubGlobal("MessageChannel", TestMessageChannel);
});
afterEach(() => {
  for (const channel of channels) {
    expect(channel.port1.onmessage).toBeNull();
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port2.close).toHaveBeenCalledOnce();
  }
  vi.unstubAllGlobals();
});

const HOLE: LonLat[] = [
  [4, 4],
  [8, 4],
  [8, 8],
  [4, 8],
];

interface FeatureOptions {
  validFromMa?: number;
  validToMa?: number;
  holes?: LonLat[][];
  polygonCount?: number;
}

function createFeature(
  id: string,
  plateId: number,
  options: FeatureOptions = {},
): PlateFeature {
  const polygonCount = options.polygonCount ?? 1;
  const polygons = [];
  for (let index = 0; index < polygonCount; index += 1) {
    const west = index * 20;
    const south = index * 15;
    const exterior: LonLat[] = [
      [west, south],
      [west + 12, south],
      [west + 12, south + 12],
      [west, south + 12],
    ];
    polygons.push({ exterior, holes: options.holes ?? [] });
  }
  return {
    id,
    plateId,
    name: id,
    description: "",
    validFromMa: options.validFromMa ?? 100,
    validToMa: options.validToMa ?? 0,
    polygons,
    sourceIndex: 0,
  };
}

function snapshotOf(
  feature: PlateFeature,
  polygonIndex = 0,
): PlatePolygonMeshSnapshot {
  return capturePlatePolygonMesh(
    feature,
    polygonIndex,
    triangulatePlatePolygon(feature.polygons[polygonIndex]!).geometry,
  );
}

function fillPositions(
  frame: RectanglePlateCpuFrame,
  plateIndex = 0,
  polygonIndex = 0,
): number[] {
  return Array.from(
    frame.plates[plateIndex]!.polygons[polygonIndex]!.geometry.attributes
      .position!.values as Float64Array,
  );
}

/** Rotation about the z axis, i.e. an Euler pole at the north pole. */
function zRotation(angleDeg: number): Quaternion {
  return quaternionFromEulerPole(90, 0, angleDeg);
}

describe("rectangle plate CPU frame builder", () => {
  it("falls back to cancellable timers when MessageChannel is unavailable", async () => {
    vi.stubGlobal("MessageChannel", undefined);
    vi.useFakeTimers();
    try {
      const feature = createFeature("fallback", 101);
      const snapshots = Array.from({ length: 8 }, () => snapshotOf(feature));
      const abort = new AbortController();
      const frame = buildRectanglePlateCpuFrame(snapshots, 50, new Map(), abort.signal);
      expect(vi.getTimerCount()).toBe(1);
      abort.abort();
      await expect(frame).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the channel when polygon preparation fails after a yield", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = snapshotOf(createFeature("failure", 101));
      const broken = { ...snapshot, get positions(): Float64Array {
        throw new Error("broken retained mesh");
      } };
      const result = buildRectanglePlateCpuFrame(
        [...Array.from({ length: 8 }, () => snapshot), broken],
        50, new Map(), new AbortController().signal,
      ).catch((error) => error);
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ message: "broken retained mesh" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses one channel across multiple batches and releases it on success", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = snapshotOf(createFeature("reuse", 101));
      const frame = buildRectanglePlateCpuFrame(
        Array.from({ length: 24 }, () => snapshot), 50, new Map(),
        new AbortController().signal,
      );
      await vi.runAllTimersAsync();
      expect((await frame).stats.polygonCount).toBe(24);
      expect(channels).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores the identity matrix and keeps outline geography for a plate without rotation", async () => {
    // Cesium's `new Matrix4()` is the zero matrix, so the identity has to be
    // explicit: a zero matrix would collapse every outline point onto the
    // origin while the fill positions stayed put.
    const feature = createFeature("plate-a0", 1501);
    const snapshot = snapshotOf(feature);

    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map(),
      new AbortController().signal,
    );

    const group = frame.plates[0]!;
    expect(group.hasRotation).toBe(false);
    expect(Array.from(group.rotationMatrix)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    // Outline points keep the source geography instead of collapsing.
    const ring = group.polygons[0]!.outlineRings[0]!;
    for (const [pointIndex, coordinate] of feature.polygons[0]!
      .exterior.entries()) {
      const expected = lonLatToCartesian(coordinate, OUTLINE_ELLIPSOID);
      expect(ring[pointIndex]!.x).toBeCloseTo(expected.x, 6);
      expect(ring[pointIndex]!.y).toBeCloseTo(expected.y, 6);
      expect(ring[pointIndex]!.z).toBeCloseTo(expected.z, 6);
    }
    // Fill working positions are untouched and the plate still counts as
    // disconnected rather than silently active.
    expect(fillPositions(frame)).toEqual(Array.from(snapshot.positions));
    expect(frame.timeState).toEqual({
      activeFeatureCount: 0,
      activePlateCount: 0,
      disconnectedFeatureCount: 1,
    });
  });

  it("keeps fill positions unrotated and stores the identity matrix for an identity rotation", async () => {
    const feature = createFeature("plate-a", 101);
    const snapshot = snapshotOf(feature);

    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map([[101, IDENTITY_QUATERNION]]),
      new AbortController().signal,
    );

    const group = frame.plates[0]!;
    expect(frame.plates).toHaveLength(1);
    expect(group.plateId).toBe(101);
    expect(group.hasRotation).toBe(true);
    expect(group.rotationMatrix).toEqual(
      quaternionToCesiumMatrix(IDENTITY_QUATERNION),
    );
    // Fill positions stay the retained globe ECEF positions: nothing was
    // rotated on the CPU before a future GeometryInstance bakes the matrix.
    expect(fillPositions(frame)).toEqual(Array.from(snapshot.positions));
    expect(frame.timeMa).toBe(50);
    expect(frame.timeState).toEqual({
      activeFeatureCount: 1,
      activePlateCount: 1,
      disconnectedFeatureCount: 0,
    });
    expect(group.polygons[0]!.timeValid).toBe(true);
  });

  it("stores 30 and 180 degree matrices that match the GPlates formula without pre-rotating fill positions", async () => {
    for (const angleDeg of [30, 180]) {
      const feature = createFeature(`plate-b-${angleDeg}`, 202);
      const snapshot = snapshotOf(feature);
      const quaternion = zRotation(angleDeg);

      const frame = await buildRectanglePlateCpuFrame(
        [snapshot],
        50,
        new Map([[202, quaternion]]),
        new AbortController().signal,
      );
      const group = frame.plates[0]!;

      // The stored matrix is the globe fast path's matrix, i.e. the GPlates
      // quaternion-vector formula.
      const input = lonLatToUnitVector(130, -18);
      const expected = rotateVector(quaternion, input);
      const actual = Matrix4.multiplyByPoint(
        group.rotationMatrix,
        new Cartesian3(input.x, input.y, input.z),
        new Cartesian3(),
      );
      expect(actual.x).toBeCloseTo(expected.x, 12);
      expect(actual.y).toBeCloseTo(expected.y, 12);
      expect(actual.z).toBeCloseTo(expected.z, 12);

      // The fill positions themselves are untouched; baking the matrix onto a
      // fill vertex is what reproduces the GPlates rotation later.
      expect(fillPositions(frame)).toEqual(Array.from(snapshot.positions));
      const vertex = {
        x: snapshot.positions[0]!,
        y: snapshot.positions[1]!,
        z: snapshot.positions[2]!,
      };
      const baked = Matrix4.multiplyByPoint(
        group.rotationMatrix,
        new Cartesian3(vertex.x, vertex.y, vertex.z),
        new Cartesian3(),
      );
      // rotateVector returns a unit vector, so compare directions.
      const bakedUnit = Cartesian3.normalize(baked, new Cartesian3());
      const rotated = rotateVector(quaternion, vertex);
      expect(bakedUnit.x).toBeCloseTo(rotated.x, 9);
      expect(bakedUnit.y).toBeCloseTo(rotated.y, 9);
      expect(bakedUnit.z).toBeCloseTo(rotated.z, 9);
    }
  });

  it("builds closed outline rings rotated once by the plate matrix", async () => {
    const feature = createFeature("plate-c", 303, { holes: [HOLE] });
    const snapshot = snapshotOf(feature);
    const quaternion = zRotation(30);

    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map([[303, quaternion]]),
      new AbortController().signal,
    );
    const polygon = frame.plates[0]!.polygons[0]!;
    expect(polygon.outlineRings).toHaveLength(2);

    const matrix = quaternionToCesiumMatrix(quaternion);
    const sourceRings = [feature.polygons[0]!.exterior, HOLE];
    for (const [ringIndex, ring] of sourceRings.entries()) {
      const built = polygon.outlineRings[ringIndex]!;
      expect(built).toHaveLength(ring.length + 1);
      for (const [pointIndex, coordinate] of ring.entries()) {
        const expected = Matrix4.multiplyByPoint(
          matrix,
          lonLatToCartesian(coordinate, OUTLINE_ELLIPSOID),
          new Cartesian3(),
        );
        expect(built[pointIndex]!.x).toBeCloseTo(expected.x, 6);
        expect(built[pointIndex]!.y).toBeCloseTo(expected.y, 6);
        expect(built[pointIndex]!.z).toBeCloseTo(expected.z, 6);
      }
      // Closed by repeating the first point, not by a second matrix pass.
      const last = built[built.length - 1]!;
      const first = built[0]!;
      expect(last.x).toBeCloseTo(first.x, 12);
      expect(last.y).toBeCloseTo(first.y, 12);
      expect(last.z).toBeCloseTo(first.z, 12);
    }
  });

  it("skips an empty hole and still closes the remaining rings", async () => {
    const feature = createFeature("plate-d", 404, { holes: [[], HOLE] });
    const snapshot = snapshotOf(feature);

    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map([[404, IDENTITY_QUATERNION]]),
      new AbortController().signal,
    );

    const rings = frame.plates[0]!.polygons[0]!.outlineRings;
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveLength(5);
    expect(rings[1]).toHaveLength(5);
  });

  it("leaves the retained snapshot cache untouched", async () => {
    const feature = createFeature("plate-e", 505, { holes: [HOLE] });
    const snapshot = snapshotOf(feature);
    const positionsBefore = Array.from(snapshot.positions);
    const exteriorBefore = snapshot.exterior.map(
      ([longitude, latitude]) => [longitude, latitude] as LonLat,
    );
    const signal = new AbortController().signal;

    await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map([[505, IDENTITY_QUATERNION]]),
      signal,
    );
    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      60,
      new Map([[505, zRotation(30)]]),
      signal,
    );

    expect(Array.from(snapshot.positions)).toEqual(positionsBefore);
    expect(snapshot.exterior).toEqual(exteriorBefore);

    const polygon = frame.plates[0]!.polygons[0]!;
    // The working geometry is an exclusive copy, never the snapshot's arrays.
    expect(polygon.geometry.attributes.position!.values).not.toBe(
      snapshot.positions,
    );
    expect(polygon.geometry.indices).not.toBe(snapshot.indices);
  });

  it("consumes retained snapshots without re-triangulating across eras", async () => {
    const feature = createFeature("plate-f", 606);
    const snapshot = snapshotOf(feature);
    const signal = new AbortController().signal;
    const eras: Quaternion[] = [
      IDENTITY_QUATERNION,
      zRotation(30),
      zRotation(180),
    ];
    const expectedPositions = Array.from(snapshot.positions);

    const frames: RectanglePlateCpuFrame[] = [];
    for (const quaternion of eras) {
      frames.push(
        await buildRectanglePlateCpuFrame(
          [snapshot],
          50,
          new Map([[606, quaternion]]),
          signal,
        ),
      );
    }

    for (const frame of frames) {
      expect(fillPositions(frame)).toEqual(expectedPositions);
      expect(frame.stats.triangleCount).toBe(snapshot.triangleCount);
      expect(frame.stats.vertexCount).toBe(snapshot.vertexCount);
    }
    // The eras are only distinguishable through the matrix, never through a
    // re-triangulated mesh.
    const matrices = frames.map(
      (frame) => frame.plates[0]!.rotationMatrix,
    );
    expect(
      Matrix4.equalsEpsilon(matrices[0]!, matrices[1]!, 1e-12),
    ).toBe(false);
    expect(
      Matrix4.equalsEpsilon(matrices[1]!, matrices[2]!, 1e-12),
    ).toBe(false);
  });

  it("takes fill positions from the retained snapshot instead of triangulating again", async () => {
    const feature = createFeature("plate-g", 707);
    const snapshot = snapshotOf(feature);
    // A fresh triangulation would reproduce the original positions; the scaled
    // retained copy proves the builder reads the snapshot instead.
    for (let index = 0; index < snapshot.positions.length; index += 1) {
      snapshot.positions[index] = snapshot.positions[index]! * 2;
    }

    const frame = await buildRectanglePlateCpuFrame(
      [snapshot],
      50,
      new Map([[707, IDENTITY_QUATERNION]]),
      new AbortController().signal,
    );

    const built = frame.plates[0]!.polygons[0]!.geometry.attributes.position!
      .values as Float64Array;
    expect(Array.from(built)).toEqual(Array.from(snapshot.positions));

    const fresh = triangulatePlatePolygon(feature.polygons[0]!).geometry
      .attributes.position!.values as Float64Array;
    expect(built[0]).not.toBeCloseTo(fresh[0]!, 3);
  });

  it("counts active features and plates with deduplication and disconnection per polygon", async () => {
    const validA = createFeature("plate-h", 801, { polygonCount: 2 });
    const validB = createFeature("plate-i", 801);
    const disconnected = createFeature("plate-j", 802);
    const invalid = createFeature("plate-k", 803, { validFromMa: 10 });
    const snapshots = [
      snapshotOf(validA, 0),
      snapshotOf(validA, 1),
      snapshotOf(validB),
      snapshotOf(disconnected),
      snapshotOf(invalid),
    ];
    const rotationMap = new Map<number, Quaternion>([
      [801, IDENTITY_QUATERNION],
      [803, IDENTITY_QUATERNION],
    ]);

    const frame = await buildRectanglePlateCpuFrame(
      snapshots,
      50,
      rotationMap,
      new AbortController().signal,
    );

    expect(frame.timeState).toEqual({
      activeFeatureCount: 2,
      activePlateCount: 1,
      disconnectedFeatureCount: 1,
    });
    expect(frame.plates.map((plate) => plate.plateId)).toEqual([
      801, 802, 803,
    ]);
    expect(frame.plates.map((plate) => plate.hasRotation)).toEqual([
      true, false, true,
    ]);
    expect(
      frame.plates[0]!.polygons.map((polygon) => polygon.timeValid),
    ).toEqual([true, true, true]);
    expect(frame.plates[2]!.polygons[0]!.timeValid).toBe(false);

    const picks = frame.plates[0]!.polygons;
    expect(picks[0]!.pick).toEqual({
      kind: "plate-feature",
      feature: validA,
      polygonIndex: 0,
    });
    expect(picks[1]!.pick.feature).toBe(validA);
    expect(picks[1]!.pick.polygonIndex).toBe(1);
    expect(picks[2]!.pick.feature).toBe(validB);
  });

  it("reports CPU preparation accounting, not GPU uploads", async () => {
    const feature = createFeature("plate-l", 904, {
      polygonCount: 2,
      holes: [HOLE],
    });
    const snapshots = [snapshotOf(feature, 0), snapshotOf(feature, 1)];

    const frame = await buildRectanglePlateCpuFrame(
      snapshots,
      50,
      new Map([[904, IDENTITY_QUATERNION]]),
      new AbortController().signal,
    );

    expect(frame.stats.plateCount).toBe(1);
    expect(frame.stats.polygonCount).toBe(2);
    expect(frame.stats.vertexCount).toBe(
      snapshots[0]!.vertexCount + snapshots[1]!.vertexCount,
    );
    expect(frame.stats.triangleCount).toBe(
      snapshots[0]!.triangleCount + snapshots[1]!.triangleCount,
    );
    expect(frame.stats.workingPositionByteLength).toBe(
      snapshots[0]!.positionByteLength + snapshots[1]!.positionByteLength,
    );
    expect(frame.stats.workingIndexByteLength).toBe(
      snapshots[0]!.indexByteLength + snapshots[1]!.indexByteLength,
    );
    // Two polygons, each with an exterior plus one hole.
    expect(frame.stats.outlineRingCount).toBe(4);
    expect(frame.stats.outlinePointCount).toBe(20);
    expect(frame.stats.prepareMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(frame.stats).sort()).toEqual(
      [
        "outlinePointCount",
        "outlineRingCount",
        "plateCount",
        "polygonCount",
        "prepareMs",
        "triangleCount",
        "vertexCount",
        "workingIndexByteLength",
        "workingPositionByteLength",
      ].sort(),
    );
  });

  it("rejects a non-finite time", async () => {
    const snapshot = snapshotOf(createFeature("plate-m", 1001));
    const signal = new AbortController().signal;
    for (const timeMa of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        buildRectanglePlateCpuFrame([snapshot], timeMa, new Map(), signal),
      ).rejects.toThrow(/finite time in Ma/);
    }
  });

  it("settles with an AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await buildRectanglePlateCpuFrame(
      [],
      50,
      new Map(),
      controller.signal,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("aborts between batches and clears the posted message and listener", async () => {
    vi.useFakeTimers();
    try {
      const feature = createFeature("plate-n", 1101, { polygonCount: 12 });
      const snapshots = [];
      for (let polygonIndex = 0; polygonIndex < 12; polygonIndex += 1) {
        snapshots.push(snapshotOf(feature, polygonIndex));
      }
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      const promise = buildRectanglePlateCpuFrame(
        snapshots,
        50,
        new Map([[1101, IDENTITY_QUATERNION]]),
        controller.signal,
      );

      // The first batch ran synchronously; the build is parked in a yield.
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();

      const error = await promise.catch((caught: unknown) => caught);
      expect((error as DOMException).name).toBe("AbortError");
      expect(vi.getTimerCount()).toBe(0);
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("settles with an AbortError when the signal aborts after the final yield resolves", async () => {
    // The yield timer can resolve and the abort can land before the builder's
    // continuation runs; without a check past the last yield the promise would
    // resolve with a frame the caller already cancelled.
    for (const polygonCount of [8, 16]) {
      vi.useFakeTimers();
      try {
        const feature = createFeature(`plate-p-${polygonCount}`, 1601, {
          polygonCount,
        });
        const snapshots = [];
        for (let polygonIndex = 0; polygonIndex < polygonCount; polygonIndex += 1) {
          snapshots.push(snapshotOf(feature, polygonIndex));
        }
        const controller = new AbortController();
        const promise = buildRectanglePlateCpuFrame(
          snapshots,
          50,
          new Map([[1601, IDENTITY_QUATERNION]]),
          controller.signal,
        );

        if (polygonCount === 16) {
          // Finish the first batch yield; park specifically on the final one.
          vi.advanceTimersByTime(0);
          await Promise.resolve();
        }
        // Fire the final yield without running the continuation, then abort
        // before the builder can inspect the signal again.
        vi.advanceTimersByTime(0);
        controller.abort();

        const error = await promise.catch((caught: unknown) => caught);
        expect((error as DOMException).name).toBe("AbortError");
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("pins feature validity so a mid-preparation edit cannot mix eras", async () => {
    vi.useFakeTimers();
    try {
      // Nine polygons share one feature object: the batch boundary falls in
      // the middle of that feature, exactly where unpinned metadata would leak
      // into the second half of the frame.
      const feature = createFeature("plate-r", 1701, { polygonCount: 9 });
      const snapshots = [];
      for (let polygonIndex = 0; polygonIndex < 9; polygonIndex += 1) {
        snapshots.push(snapshotOf(feature, polygonIndex));
      }
      const controller = new AbortController();
      const promise = buildRectanglePlateCpuFrame(
        snapshots,
        50,
        new Map([[1701, IDENTITY_QUATERNION]]),
        controller.signal,
      );

      expect(vi.getTimerCount()).toBe(1);
      // Caller-side metadata edit while the build is parked in its yield.
      feature.validFromMa = 10;

      await vi.advanceTimersByTimeAsync(10);
      const frame = await promise;

      expect(frame.plates[0]!.polygons).toHaveLength(9);
      for (const polygon of frame.plates[0]!.polygons) {
        expect(polygon.timeValid).toBe(true);
      }
      expect(frame.timeState).toEqual({
        activeFeatureCount: 1,
        activePlateCount: 1,
        disconnectedFeatureCount: 0,
      });

      // The next preparation sees the updated metadata.
      const second = buildRectanglePlateCpuFrame(
        snapshots,
        50,
        new Map([[1701, IDENTITY_QUATERNION]]),
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(10);
      const next = await second;
      expect(next.plates[0]!.polygons[0]!.timeValid).toBe(false);
      expect(next.timeState.activeFeatureCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the abort listener when a yield resolves", async () => {
    vi.useFakeTimers();
    try {
      const feature = createFeature("plate-o", 1201, { polygonCount: 10 });
      const snapshots = [];
      for (let polygonIndex = 0; polygonIndex < 10; polygonIndex += 1) {
        snapshots.push(snapshotOf(feature, polygonIndex));
      }
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

      const promise = buildRectanglePlateCpuFrame(
        snapshots,
        50,
        new Map([[1201, IDENTITY_QUATERNION]]),
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(1);
      const frame = await promise;

      expect(frame.stats.polygonCount).toBe(10);
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
