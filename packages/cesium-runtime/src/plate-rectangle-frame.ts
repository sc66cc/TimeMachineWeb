import { Cartesian3, type Geometry, Matrix4 } from "cesium";

import {
  isFeatureValidAtTime,
  type PlateFeature,
  type Quaternion,
} from "@timemachine/reconstruction-core";

import { OUTLINE_ELLIPSOID, lonLatToCartesian } from "./geometry";
import {
  createWorkingPlateGeometry,
  type PlatePolygonMeshSnapshot,
} from "./plate-mesh-snapshot";
import { quaternionToCesiumMatrix } from "./plate-rotation-matrix";
import type { PlatePick } from "./plate-renderer";

/**
 * Polygons prepared between cooperative yields. Small and fixed on purpose:
 * the preparation must stay responsive to cancellation without turning into a
 * configurable scheduling framework.
 */
const POLYGONS_PER_YIELD = 8;

/** Visibility accounting shared with `PlateRenderer#updateTime`. */
export interface RectanglePlateTimeState {
  readonly activeFeatureCount: number;
  readonly activePlateCount: number;
  readonly disconnectedFeatureCount: number;
}

/**
 * One polygon of a future rectangle frame.
 *
 * `geometry` is the exclusive working copy produced by
 * `createWorkingPlateGeometry`: its fill positions are still the globe ECEF
 * positions of the retained snapshot. They are deliberately *not* rotated on
 * the CPU; the rotation is baked later, at `GeometryInstance` build time, from
 * the owning group's `rotationMatrix` while the primitive itself stays
 * identity. `timeValid` is captured for this preparation's time only.
 */
export interface RectanglePlateCpuPolygon {
  readonly pick: PlatePick;
  readonly feature: PlateFeature;
  readonly geometry: Geometry;
  readonly timeValid: boolean;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Closed rings: source ring converted on `OUTLINE_ELLIPSOID`, rotated once. */
  readonly outlineRings: readonly (readonly Cartesian3[])[];
}

/** All polygons of one plate, sharing one rotation matrix. */
export interface RectanglePlateCpuGroup {
  readonly plateId: number;
  /** False when the pinned rotation map has no entry for this plate. */
  readonly hasRotation: boolean;
  /**
   * Rotation for this plate, or the identity when `hasRotation` is false, so a
   * future `GeometryInstance` can bake it as-is.
   */
  readonly rotationMatrix: Matrix4;
  readonly polygons: readonly RectanglePlateCpuPolygon[];
}

/**
 * CPU-side accounting of one preparation.
 *
 * The byte counts are the working copies this frame allocated (positions and
 * indices handed to a future primitive), not GPU upload sizes and not a claim
 * about total process memory: no GPU object exists yet.
 */
export interface RectanglePlateCpuFrameStats {
  readonly plateCount: number;
  readonly polygonCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly workingPositionByteLength: number;
  readonly workingIndexByteLength: number;
  readonly outlineRingCount: number;
  /** Closed ring points, so each ring counts its repeated first point. */
  readonly outlinePointCount: number;
  readonly prepareMs: number;
}

/**
 * CPU preparation result for a future rectangle projection.
 *
 * This is preparation only: there is no primitive, no polyline collection and
 * no committed view. Style opacity and overall visibility are intentionally
 * absent - staging and commit must read the latest values instead of a frame
 * frozen at preparation time.
 */
export interface RectanglePlateCpuFrame {
  readonly timeMa: number;
  readonly plates: readonly RectanglePlateCpuGroup[];
  readonly timeState: RectanglePlateTimeState;
  readonly stats: RectanglePlateCpuFrameStats;
}

/** One snapshot with this preparation's pinned validity, fixed at entry. */
interface PinnedSnapshot {
  readonly snapshot: PlatePolygonMeshSnapshot;
  readonly featureId: string;
  readonly timeValid: boolean;
}

/**
 * AbortError used to settle every cancelled preparation. Cancellation is not a
 * failure, so callers can tell the two apart by the `name`.
 */
export function createRectanglePlateAbortError(): DOMException {
  return new DOMException(
    "Rectangle plate CPU preparation aborted.",
    "AbortError",
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createRectanglePlateAbortError();
  }
}

/** One channel per build: real macrotasks without nested timer clamping. */
function createFrameYield(signal: AbortSignal): {
  yield: () => Promise<void>;
  dispose: () => void;
} {
  const channel = typeof window !== "undefined" &&
    typeof window.MessageChannel === "function"
    ? new window.MessageChannel()
    : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => void) | undefined;
  return {
    yield: () => {
      if (signal.aborted) {
        return Promise.reject(createRectanglePlateAbortError());
      }
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: Error): void => {
          cleanup?.();
          if (error) reject(error);
          else resolve();
        };
        const onAbort = (): void => settle(createRectanglePlateAbortError());
        cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (channel) channel.port1.onmessage = null;
          signal.removeEventListener("abort", onAbort);
          cleanup = undefined;
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (channel) {
          channel.port1.onmessage = () => settle();
          channel.port2.postMessage(null);
        } else {
          timer = setTimeout(() => settle(), 0);
        }
      });
    },
    dispose: () => {
      cleanup?.();
      channel?.port1.close();
      channel?.port2.close();
    },
  };
}

/**
 * Outline rings for one polygon, in the same order the renderer draws them:
 * exterior first, then the holes. Every coordinate is converted once on
 * `OUTLINE_ELLIPSOID`, rotated once by the plate matrix, and the ring is closed
 * by repeating its first point. Empty holes are skipped; the matrix is never
 * applied a second time.
 */
function buildOutlineRings(
  snapshot: PlatePolygonMeshSnapshot,
  rotationMatrix: Matrix4,
): Cartesian3[][] {
  const rings: Cartesian3[][] = [];
  for (const ring of [snapshot.exterior, ...snapshot.holes]) {
    if (ring.length === 0) {
      continue;
    }
    const points: Cartesian3[] = [];
    for (const coordinate of ring) {
      points.push(
        Matrix4.multiplyByPoint(
          rotationMatrix,
          lonLatToCartesian(coordinate, OUTLINE_ELLIPSOID),
          new Cartesian3(),
        ),
      );
    }
    points.push(points[0]!);
    rings.push(points);
  }
  return rings;
}

/**
 * Builds the CPU-side plate frame for a future rectangle projection.
 *
 * The retained snapshots are consumed read-only: nothing is triangulated,
 * parsed or downloaded here, no GPU object is created, and the snapshot's own
 * arrays are never lent to Cesium - `createWorkingPlateGeometry` allocates the
 * working copies this frame owns.
 *
 * Rotations and per-feature validity are pinned once, before the first yield,
 * so one frame never mixes two reconstruction states. Cancellation is checked
 * at every polygon boundary and once more before the frame is returned, and the
 * periodic yield is a cancellable macrotask, so an aborted preparation settles
 * with an AbortError instead of hanging.
 */
export async function buildRectanglePlateCpuFrame(
  snapshots: readonly PlatePolygonMeshSnapshot[],
  timeMa: number,
  rotationMap: ReadonlyMap<number, Quaternion>,
  signal: AbortSignal,
): Promise<RectanglePlateCpuFrame> {
  if (!Number.isFinite(timeMa)) {
    throw new Error(
      "buildRectanglePlateCpuFrame requires a finite time in Ma.",
    );
  }
  const prepareStartedAt = performance.now();
  throwIfAborted(signal);

  // Pin this preparation's rotations up front. The caller's map - and the
  // quaternion objects inside it - may change while this build yields, and a
  // frame mixing two reconstruction times is exactly what a later commit must
  // never see.
  const pinnedRotations = new Map<number, Quaternion>();
  for (const [plateId, quaternion] of rotationMap) {
    pinnedRotations.set(plateId, { ...quaternion });
  }

  // Pin each feature's validity once, keyed by the feature object itself. The
  // build yields, so a caller that edits feature metadata mid-preparation must
  // not produce a frame that mixes two validity states, nor two identities for
  // the same feature in the active accounting. The feature reference itself is
  // kept as-is: the picks below must stay the very object the renderer handed
  // out. Only the small {id, timeValid} pair is fixed here - no feature, ring
  // or buffer is copied.
  const pinnedFeatures = new Map<
    PlateFeature,
    { readonly id: string; readonly timeValid: boolean }
  >();
  const pinnedSnapshots: PinnedSnapshot[] = [];
  for (const snapshot of snapshots) {
    let pinned = pinnedFeatures.get(snapshot.feature);
    if (!pinned) {
      pinned = {
        id: snapshot.feature.id,
        timeValid: isFeatureValidAtTime(snapshot.feature, timeMa),
      };
      pinnedFeatures.set(snapshot.feature, pinned);
    }
    pinnedSnapshots.push({
      snapshot,
      featureId: pinned.id,
      timeValid: pinned.timeValid,
    });
  }

  const snapshotsByPlate = new Map<number, PinnedSnapshot[]>();
  for (const pinned of pinnedSnapshots) {
    const plateSnapshots = snapshotsByPlate.get(pinned.snapshot.plateId);
    if (plateSnapshots) {
      plateSnapshots.push(pinned);
    } else {
      snapshotsByPlate.set(pinned.snapshot.plateId, [pinned]);
    }
  }

  const plates: RectanglePlateCpuGroup[] = [];
  const activeFeatureIds = new Set<string>();
  const activePlateIds = new Set<number>();
  let disconnectedFeatureCount = 0;
  let polygonCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let workingPositionByteLength = 0;
  let workingIndexByteLength = 0;
  let outlineRingCount = 0;
  let outlinePointCount = 0;

  const frameYield = createFrameYield(signal);
  try {
  for (const [plateId, plateSnapshots] of snapshotsByPlate) {
    // Explicit identity copy: Cesium's `new Matrix4()` is the zero matrix, and
    // a zero matrix would collapse every outline point onto the origin. Plates
    // without a rotation keep the identity so a future GeometryInstance can
    // bake this matrix unchanged.
    const rotationMatrix = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
    const rotation = pinnedRotations.get(plateId);
    const hasRotation = rotation !== undefined;
    if (rotation) {
      quaternionToCesiumMatrix(rotation, rotationMatrix);
    }

    const polygons: RectanglePlateCpuPolygon[] = [];
    for (const pinned of plateSnapshots) {
      throwIfAborted(signal);
      const snapshot = pinned.snapshot;

      const geometry = createWorkingPlateGeometry(snapshot);
      const positionValues = geometry.attributes.position?.values;
      const indexValues = geometry.indices;
      if (
        !ArrayBuffer.isView(positionValues) ||
        !ArrayBuffer.isView(indexValues)
      ) {
        throw new Error(
          "createWorkingPlateGeometry produced buffers this frame cannot account for.",
        );
      }
      const timeValid = pinned.timeValid;
      const outlineRings = buildOutlineRings(snapshot, rotationMatrix);

      polygons.push({
        pick: {
          kind: "plate-feature",
          feature: snapshot.feature,
          polygonIndex: snapshot.polygonIndex,
        },
        feature: snapshot.feature,
        geometry,
        timeValid,
        vertexCount: positionValues.length / 3,
        triangleCount: indexValues.length / 3,
        outlineRings,
      });

      polygonCount += 1;
      vertexCount += positionValues.length / 3;
      triangleCount += indexValues.length / 3;
      workingPositionByteLength += positionValues.byteLength;
      workingIndexByteLength += indexValues.byteLength;
      outlineRingCount += outlineRings.length;
      for (const ring of outlineRings) {
        outlinePointCount += ring.length;
      }

      if (hasRotation && timeValid) {
        activeFeatureIds.add(pinned.featureId);
        activePlateIds.add(plateId);
      } else if (timeValid && !hasRotation) {
        // Same accounting as PlateRenderer#updateTime: one disconnected
        // polygon per rendered instance, never one per feature.
        disconnectedFeatureCount += 1;
      }

      if (polygonCount % POLYGONS_PER_YIELD === 0) {
        await frameYield.yield();
      }
    }

    plates.push({
      plateId,
      hasRotation,
      rotationMatrix,
      polygons,
    });
  }

  // The last yield may already have resolved while the signal was aborted, so
  // the tail is checked even when no further polygon boundary follows.
  throwIfAborted(signal);
  return {
    timeMa,
    plates,
    timeState: {
      activeFeatureCount: activeFeatureIds.size,
      activePlateCount: activePlateIds.size,
      disconnectedFeatureCount,
    },
    stats: {
      plateCount: plates.length,
      polygonCount,
      vertexCount,
      triangleCount,
      workingPositionByteLength,
      workingIndexByteLength,
      outlineRingCount,
      outlinePointCount,
      prepareMs: performance.now() - prepareStartedAt,
    },
  };
  } finally {
    frameYield.dispose();
  }
}
