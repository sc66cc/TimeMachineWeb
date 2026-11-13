import {
  BoundingSphere,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  PrimitiveType,
} from "cesium";

import type {
  LonLat,
  PlateFeature,
} from "@timemachine/reconstruction-core";

/**
 * CPU-side copy of a single triangulated plate polygon.
 *
 * `PlateRenderer` hands the geometry produced by `triangulatePlatePolygon`
 * straight to a `Primitive` with `releaseGeometryInstances: true`, so Cesium is
 * free to drop or transform whatever it was handed. A future projection runtime
 * needs the source mesh back when switching between the globe and a 2D view,
 * therefore the polygon is captured *before* the hand-off.
 *
 * Ownership: the typed arrays and outline copies below belong to whoever
 * captured this snapshot (currently the renderer). They are deliberately not
 * frozen - `Object.freeze` on a non-empty typed array does not make its contents
 * immutable and would only suggest an isolation this module cannot guarantee.
 * Mutating them from outside the owner is a programming error, not a supported
 * operation, and they must never be lent to the Cesium pipeline by reference:
 * `createWorkingPlateGeometry` always allocates fresh buffers.
 */
export interface PlatePolygonMeshSnapshot {
  /** Same readonly reference as the rendered feature; pick metadata stays shared. */
  readonly feature: PlateFeature;
  readonly plateId: number;
  readonly polygonIndex: number;
  /** Private copy of the triangulated positions (x, y, z per vertex). */
  readonly positions: Float64Array;
  /** Private copy of the triangle indices; width follows the source geometry. */
  readonly indices: Uint16Array | Uint32Array;
  /** Private copy of the original exterior ring in lon/lat degrees. */
  readonly exterior: readonly LonLat[];
  /** Private copy of the original hole rings in lon/lat degrees. */
  readonly holes: readonly (readonly LonLat[])[];
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Byte size of `positions` alone; not a claim about total object memory. */
  readonly positionByteLength: number;
  /** Byte size of `indices` alone; not a claim about total object memory. */
  readonly indexByteLength: number;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function copyRing(ring: readonly LonLat[], label: string): LonLat[] {
  if (ring.length === 0) {
    throw new Error(`${label} must contain at least one coordinate.`);
  }
  return ring.map((coordinate, coordinateIndex) => {
    const coordinateLabel = `${label}[${coordinateIndex}]`;
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      throw new Error(
        `${coordinateLabel} must be a [longitude, latitude] pair.`,
      );
    }
    const longitude = assertFiniteNumber(
      coordinate[0],
      `${coordinateLabel} longitude`,
    );
    const latitude = assertFiniteNumber(
      coordinate[1],
      `${coordinateLabel} latitude`,
    );
    return [longitude, latitude] as LonLat;
  });
}

/**
 * Copies one hole ring. A hole may be empty: Cesium itself skips any hole
 * with fewer than three vertices, so an empty hole costs nothing and must not
 * make a perfectly renderable polygon uncapturable. Non-finite coordinates are
 * rejected exactly as in an exterior ring.
 */
function copyHoleRing(ring: readonly LonLat[], label: string): LonLat[] {
  return ring.length === 0 ? [] : copyRing(ring, label);
}

/**
 * Copies the triangulated mesh of one polygon out of Cesium before the renderer
 * gives the geometry away.
 *
 * Only the shape `triangulatePlatePolygon` actually produces is supported: an
 * indexed triangle geometry carrying a `position` attribute. Building a generic
 * any-geometry snapshot system is out of scope here.
 */
export function capturePlatePolygonMesh(
  feature: PlateFeature,
  polygonIndex: number,
  geometry: Geometry,
): PlatePolygonMeshSnapshot {
  if (!feature || typeof feature !== "object") {
    throw new Error("capturePlatePolygonMesh requires a plate feature.");
  }
  if (!Number.isInteger(polygonIndex) || polygonIndex < 0) {
    throw new Error(
      `capturePlatePolygonMesh requires a polygon index >= 0, received ${String(
        polygonIndex,
      )}.`,
    );
  }
  const polygon = feature.polygons[polygonIndex];
  if (!polygon) {
    throw new Error(
      `Feature ${feature.id} has no polygon at index ${polygonIndex}.`,
    );
  }
  const plateId = assertFiniteNumber(
    feature.plateId,
    `Feature ${feature.id} plateId`,
  );
  if (!geometry || geometry.primitiveType !== PrimitiveType.TRIANGLES) {
    throw new Error(
      "capturePlatePolygonMesh only supports indexed triangle geometry.",
    );
  }

  const positionValues: unknown = geometry.attributes?.position?.values;
  if (
    !ArrayBuffer.isView(positionValues) &&
    !Array.isArray(positionValues)
  ) {
    throw new Error(
      "capturePlatePolygonMesh expects a geometry with a position attribute.",
    );
  }
  const positions = new Float64Array(positionValues as ArrayLike<number>);
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error(
      `Position attribute length ${positions.length} is not a non-zero multiple of 3.`,
    );
  }
  for (const value of positions) {
    if (!Number.isFinite(value)) {
      throw new Error("Position attribute contains a non-finite component.");
    }
  }

  const sourceIndices: unknown = geometry.indices;
  if (
    !(sourceIndices instanceof Uint16Array) &&
    !(sourceIndices instanceof Uint32Array)
  ) {
    throw new Error(
      "capturePlatePolygonMesh only supports Uint16 or Uint32 index buffers.",
    );
  }
  if (sourceIndices.length === 0 || sourceIndices.length % 3 !== 0) {
    throw new Error(
      `Index buffer length ${sourceIndices.length} is not a non-zero multiple of 3.`,
    );
  }
  const indices = sourceIndices.slice();
  const vertexCount = positions.length / 3;
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      throw new Error(
        `Triangle index ${index} is out of range for ${vertexCount} vertices.`,
      );
    }
  }

  const exterior = copyRing(
    polygon.exterior,
    `Feature ${feature.id} polygon ${polygonIndex} exterior`,
  );
  const holes = polygon.holes.map((hole, holeIndex) =>
    copyHoleRing(
      hole,
      `Feature ${feature.id} polygon ${polygonIndex} hole ${holeIndex}`,
    ),
  );

  return {
    feature,
    plateId,
    polygonIndex,
    positions,
    indices,
    exterior,
    holes,
    vertexCount,
    triangleCount: indices.length / 3,
    positionByteLength: positions.byteLength,
    indexByteLength: indices.byteLength,
  };
}

/** Alias for the renderer-side "retain" wording; same function. */
export const retainPlatePolygonMesh = capturePlatePolygonMesh;

/**
 * Builds a fresh Cesium geometry from a captured snapshot.
 *
 * The buffers handed to Cesium are new allocations: Cesium may transform or
 * compress geometry it receives, so the snapshot's arrays stay untouched. The
 * bounding sphere is recomputed from the copied positions because culling needs
 * one.
 */
export function createWorkingPlateGeometry(
  snapshot: PlatePolygonMeshSnapshot,
): Geometry {
  if (!snapshot || !(snapshot.positions instanceof Float64Array)) {
    throw new Error(
      "createWorkingPlateGeometry requires a captured mesh snapshot.",
    );
  }
  const sourceIndices = snapshot.indices;
  if (
    !(sourceIndices instanceof Uint16Array) &&
    !(sourceIndices instanceof Uint32Array)
  ) {
    throw new Error(
      "createWorkingPlateGeometry requires a captured mesh snapshot.",
    );
  }
  if (
    snapshot.positions.length === 0 ||
    snapshot.positions.length % 3 !== 0 ||
    sourceIndices.length === 0 ||
    sourceIndices.length % 3 !== 0
  ) {
    throw new Error("Snapshot buffers are not triangle-aligned.");
  }

  const positions = new Float64Array(snapshot.positions);
  const indices = sourceIndices.slice();
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  });
  return new Geometry({
    attributes,
    primitiveType: PrimitiveType.TRIANGLES,
    indices,
    boundingSphere: BoundingSphere.fromVertices(positions),
  });
}

/**
 * Stable per-triangle source id, generated on demand so that large meshes do
 * not pay for one string per triangle up front.
 */
export function plateTriangleSourceId(
  snapshot: PlatePolygonMeshSnapshot,
  triangleIndex: number,
): string {
  if (
    !snapshot ||
    !Number.isInteger(triangleIndex) ||
    triangleIndex < 0 ||
    triangleIndex >= snapshot.triangleCount
  ) {
    throw new Error(
      `Triangle index ${String(triangleIndex)} is outside the captured mesh.`,
    );
  }
  return `${snapshot.feature.id}#${snapshot.polygonIndex}#${triangleIndex}`;
}
