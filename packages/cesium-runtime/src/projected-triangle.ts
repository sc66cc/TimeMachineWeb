import type { Vec3 } from "@timemachine/reconstruction-core";

import { EARTH_RADIUS_METRES } from "./geometry";
import type { MapProjection, ProjectedPoint } from "./map-projection";
import { clipTriangleToHemispheres } from "./projected-geometry";
import type {
  ClippedTrianglePiece,
  ClippedTriangleVertex,
  TriangleClipStatus,
} from "./projected-geometry";

/**
 * Planar distance, in metres, at or below which two projected points are the
 * same point. A pole expanded twice against the same neighbour longitude, or a
 * seam vertex visited twice by one piece, lands bit-identical; the tolerance
 * only has to absorb rounding of the last micrometre.
 */
const PLANAR_EPSILON_METRES = 1e-6;
const PLANAR_EPSILON_SQUARED = PLANAR_EPSILON_METRES * PLANAR_EPSILON_METRES;

/**
 * Half an ulp: the rounding unit of the fast orientation determinant, and the
 * Shewchuk error factor of a 2x2 determinant. The fast result is trusted only
 * when it clearly exceeds its bound; everything else falls back to exact
 * arithmetic. No cross-product tolerance decides collinearity: a cross product
 * of 1e-12 scaled by the Earth radius squared is about forty square metres of
 * real area, which is a genuine turn of the boundary and not rounding noise.
 */
const ORIENT_ROUNDING_UNIT = Number.EPSILON / 2;
const ORIENT_ERROR_FACTOR = 3 + 16 * ORIENT_ROUNDING_UNIT;

/** Dimensionless signed area at or below which a planar face has no area. */
const AREA_TOLERANCE = 1e-14;

const R = EARTH_RADIUS_METRES;
const R_SQUARED = R * R;

/** One planar triangle that keeps the source id and the hemisphere it came from. */
export interface ProjectedTriangle {
  readonly sourceId: string | number;
  readonly hemisphere: 1 | -1;
  readonly vertices: readonly [ProjectedPoint, ProjectedPoint, ProjectedPoint];
}

export interface TriangleProjectionResult {
  readonly status: TriangleClipStatus;
  readonly sourceId: string | number;
  /** Empty for every non-ok status. */
  readonly triangles: readonly ProjectedTriangle[];
  /** Present and non-empty for every non-ok status. */
  readonly reason?: string;
  /** Orientation of the source triangle, once it could be established. */
  readonly winding?: 1 | -1;
}

/** A planar triangle in boundary order, before the source id is attached. */
type PlanarTriangle = readonly [ProjectedPoint, ProjectedPoint, ProjectedPoint];

/** Outcome of turning one clipped piece into planar triangles. */
type PieceProjection =
  | { readonly ok: true; readonly triangles: readonly ProjectedTriangle[] }
  | { readonly ok: false; readonly reason: string };

function projectionDiagnostic(
  status: Exclude<TriangleClipStatus, "ok">,
  sourceId: string | number,
  reason: string,
  winding?: 1 | -1,
): TriangleProjectionResult {
  return winding === undefined
    ? { status, sourceId, triangles: [], reason }
    : { status, sourceId, triangles: [], reason, winding };
}

/** Diagnostic for a piece boundary that no longer describes a face. */
function simplifiedToVertices(
  hemisphere: 1 | -1,
  vertices: number,
): PieceProjection {
  return {
    ok: false,
    reason: `planar boundary of the hemisphere ${hemisphere} piece simplified to ${vertices} vertices`,
  };
}

/** Diagnostic for a piece boundary that cannot be certified simple. */
function untrustworthyBoundary(hemisphere: 1 | -1): PieceProjection {
  return {
    ok: false,
    reason: `planar boundary of the hemisphere ${hemisphere} piece folds or crosses itself`,
  };
}

/** Vertex at a cyclic index of a boundary, or null when there is none. */
function vertexAt<T>(vertices: readonly T[], index: number): T | null {
  const wrapped = ((index % vertices.length) + vertices.length) % vertices.length;
  return vertices[wrapped] ?? null;
}

/**
 * Relative longitude of a vertex that is not a pole, or null when the vertex
 * is a pole (no unique longitude) or carries none.
 */
function nonPoleLongitude(vertex: ClippedTriangleVertex): number | null {
  return vertex.pole ? null : vertex.relativeLongitudeDeg;
}

/**
 * Forward projection of one relative longitude/latitude pair. A rejection by
 * the projection maths, or a non-finite result, is reported to the caller
 * instead of reaching the triangulation.
 */
function projectRelativePoint(
  relativeLongitudeDeg: number,
  latitudeDeg: number,
  projection: MapProjection,
): ProjectedPoint | null {
  try {
    const point = projection.projectRelative(relativeLongitudeDeg, latitudeDeg);
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  } catch {
    return null;
  }
}

function projectNonPoleVertex(
  vertex: ClippedTriangleVertex,
  projection: MapProjection,
): ProjectedPoint | null {
  const relativeLongitudeDeg = nonPoleLongitude(vertex);
  if (relativeLongitudeDeg === null) {
    return null;
  }
  return projectRelativePoint(relativeLongitudeDeg, vertex.latitudeDeg, projection);
}

/**
 * Plate Carree keeps the map edge at a fixed x, so a pole is expanded into the
 * two edge points its neighbouring vertices dictate: the piece runs up the
 * neighbour longitude, along the top edge to the other neighbour longitude, and
 * back down. The longitude the source happened to write for the pole is never
 * used, and the two copies are only merged later if they coincide.
 */
function rectanglePiecePolygon(
  piece: ClippedTrianglePiece,
  projection: MapProjection,
): ProjectedPoint[] | null {
  const vertices = piece.vertices;
  const points: ProjectedPoint[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertexAt(vertices, index);
    if (vertex === null) {
      return null;
    }
    if (!vertex.pole) {
      const point = projectNonPoleVertex(vertex, projection);
      if (point === null) {
        return null;
      }
      points.push(point);
      continue;
    }
    const previous = vertexAt(vertices, index - 1);
    const next = vertexAt(vertices, index + 1);
    const previousLongitude =
      previous === null ? null : nonPoleLongitude(previous);
    const nextLongitude = next === null ? null : nonPoleLongitude(next);
    if (previousLongitude === null || nextLongitude === null) {
      // A pole beside another pole, or beside a vertex without a longitude,
      // has no determined boundary.
      return null;
    }
    const previousEdge = projectRelativePoint(
      previousLongitude,
      vertex.latitudeDeg,
      projection,
    );
    const nextEdge = projectRelativePoint(
      nextLongitude,
      vertex.latitudeDeg,
      projection,
    );
    if (previousEdge === null || nextEdge === null) {
      return null;
    }
    points.push(previousEdge, nextEdge);
  }
  return points;
}

/**
 * Mollweide closes the ellipse into one boundary, so a pole converges to the
 * single point the projection maths gives it on the central meridian. It is
 * never expanded into two edge points: that would invent a width the ellipse
 * does not have.
 */
function mollweidePiecePolygon(
  piece: ClippedTrianglePiece,
  projection: MapProjection,
): ProjectedPoint[] | null {
  const points: ProjectedPoint[] = [];
  for (const vertex of piece.vertices) {
    const point = vertex.pole
      ? projectRelativePoint(0, vertex.latitudeDeg, projection)
      : projectNonPoleVertex(vertex, projection);
    if (point === null) {
      return null;
    }
    points.push(point);
  }
  return points;
}

function piecePolygon(
  piece: ClippedTrianglePiece,
  projection: MapProjection,
): ProjectedPoint[] | null {
  switch (projection.id) {
    case "rectangle":
      return rectanglePiecePolygon(piece, projection);
    case "mollweide":
      return mollweidePiecePolygon(piece, projection);
    default:
      // Stage 3B carries exactly the two planar ids; any other id has no
      // vertex rule here and is reported rather than guessed at.
      return null;
  }
}

function distanceSquared(first: ProjectedPoint, second: ProjectedPoint): number {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}

/**
 * Drops points that repeat their predecessor bit for bit, including across the
 * wrap-around. A pole expanded into two edge points, or a seam vertex visited
 * twice by one piece, lands identical; removing those is exact bookkeeping and
 * happens before the near-duplicate merge, which is a tolerance decision.
 */
function dropExactDuplicates(
  points: readonly ProjectedPoint[],
): ProjectedPoint[] {
  const unique: ProjectedPoint[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (
      previous !== undefined &&
      previous.x === point.x &&
      previous.y === point.y
    ) {
      continue;
    }
    unique.push(point);
  }
  while (unique.length > 1) {
    const first = unique[0];
    const last = unique[unique.length - 1];
    if (
      first === undefined ||
      last === undefined ||
      first.x !== last.x ||
      first.y !== last.y
    ) {
      break;
    }
    unique.pop();
  }
  return unique;
}

/**
 * Merges points that repeat their predecessor to within
 * {@link PLANAR_EPSILON_METRES}, including across the wrap-around. This is the
 * one distance tolerance left in the boundary cleanup, and it only ever
 * removes what the projection itself rendered indistinguishable.
 */
function dropRepeatedPoints(
  points: readonly ProjectedPoint[],
): ProjectedPoint[] {
  const unique: ProjectedPoint[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (
      previous !== undefined &&
      distanceSquared(previous, point) <= PLANAR_EPSILON_SQUARED
    ) {
      continue;
    }
    unique.push(point);
  }
  while (unique.length > 1) {
    const first = unique[0];
    const last = unique[unique.length - 1];
    if (
      first === undefined ||
      last === undefined ||
      distanceSquared(first, last) > PLANAR_EPSILON_SQUARED
    ) {
      break;
    }
    unique.pop();
  }
  return unique;
}

/**
 * Cross product of the edge differences from `first`, scaled by 1/R^2.
 * Translating to a local origin and dividing by the Earth radius keeps the
 * result dimensionless and stops the large map coordinates from cancelling
 * each other away.
 */
function crossScaled(
  first: ProjectedPoint,
  second: ProjectedPoint,
  third: ProjectedPoint,
): number {
  return (
    ((second.x - first.x) * (third.y - first.y) -
      (second.y - first.y) * (third.x - first.x)) /
    R_SQUARED
  );
}

/** Signed planar area of one triangle, dimensionless after the R^2 scaling. */
function signedTriangleArea(triangle: PlanarTriangle): number {
  return crossScaled(triangle[0], triangle[1], triangle[2]) / 2;
}

/**
 * True when a triangle carries real area in the source orientation. The
 * threshold is independent of the orientation predicate, and a non-finite
 * area never counts as area.
 */
function hasSourceOrientation(
  triangle: PlanarTriangle,
  winding: 1 | -1,
): boolean {
  const area = signedTriangleArea(triangle);
  return (
    Number.isFinite(area) &&
    Math.abs(area) > AREA_TOLERANCE &&
    Math.sign(area) === winding
  );
}

/**
 * True when `middle` lies on the straight segment `before`-`after`, so dropping
 * it leaves the boundary unchanged. Collinearity is certified exactly and
 * betweenness by the span of the edge: a spike that doubles back past `after`
 * is not redundant and is kept, because removing it would hide a fold rather
 * than simplify one.
 */
function isRedundantMiddle(
  before: ProjectedPoint,
  middle: ProjectedPoint,
  after: ProjectedPoint,
): boolean {
  return (
    orientSign(before, middle, after) === 0 &&
    pointBetween(before, middle, after)
  );
}

/** Removes the first redundant middle vertex, or returns null when there is none. */
function dropOneCollinearMiddle(
  points: readonly ProjectedPoint[],
): ProjectedPoint[] | null {
  for (let index = 0; index < points.length; index += 1) {
    const before = points[(index - 1 + points.length) % points.length];
    const middle = points[index];
    const after = points[(index + 1) % points.length];
    if (
      before !== undefined &&
      middle !== undefined &&
      after !== undefined &&
      isRedundantMiddle(before, middle, after)
    ) {
      return [...points.slice(0, index), ...points.slice(index + 1)];
    }
  }
  return null;
}

/**
 * Drops middle vertices that are certified collinear with their neighbours
 * until the boundary stops simplifying. A triangle is never reduced this way:
 * three collinear vertices have no area, which the orientation check reports
 * instead.
 */
function dropCollinearMiddles(
  points: readonly ProjectedPoint[],
): ProjectedPoint[] {
  let remaining = [...points];
  while (remaining.length > 3) {
    const reduced = dropOneCollinearMiddle(remaining);
    if (reduced === null) {
      break;
    }
    remaining = reduced;
  }
  return remaining;
}

/** Certified orientation of an ordered triple: left, right, or exactly collinear. */
type Orientation = 1 | -1 | 0;

/**
 * Scratch view for reading the IEEE754 fields of one double without
 * allocating. The endianness is stated explicitly at both ends - the write and
 * every read use big-endian, so the high word (sign, exponent, high fraction)
 * is at offset 0 and the low word at offset 4 on every platform, whatever the
 * host byte order happens to be.
 */
const exactScratch = new DataView(new ArrayBuffer(8));

/**
 * One finite double as a signed BigInt counted in units of 2^-1074, the step
 * of the smallest subnormal. Every finite double - zero, negative zero,
 * subnormal and normal alike - is a whole number of those units, so
 * differences and products of these integers are exact and the orientation
 * determinant can be decided with no rounding at all. The sign is a separate
 * field and the exponent is masked to its eleven bits, so a negative value
 * decodes to exactly the negation of its positive counterpart. Returns null
 * for a non-finite value, which has no such representation.
 */
function toExactInteger(value: number): bigint | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  exactScratch.setFloat64(0, value, false);
  const highWord = exactScratch.getUint32(0, false);
  const lowWord = exactScratch.getUint32(4, false);
  const exponentBits = (highWord >>> 20) & 0x7ff;
  const fraction = (BigInt(highWord & 0xfffff) << 32n) | BigInt(lowWord);
  const negative = (highWord >>> 31) === 1;
  if (exponentBits === 0) {
    return negative ? -fraction : fraction;
  }
  const units = ((1n << 52n) | fraction) << BigInt(exponentBits - 1);
  return negative ? -units : units;
}

/**
 * Orientation of `a`, `b`, `c` recomputed from the raw IEEE754 fields, which
 * settles every case the fast determinant cannot separate from zero - a
 * determinant that computes to exactly zero included, since that on its own
 * proves nothing about collinearity.
 */
function exactOrientSign(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint,
): Orientation {
  const ax = toExactInteger(a.x);
  const ay = toExactInteger(a.y);
  const bx = toExactInteger(b.x);
  const by = toExactInteger(b.y);
  const cx = toExactInteger(c.x);
  const cy = toExactInteger(c.y);
  if (
    ax === null ||
    ay === null ||
    bx === null ||
    by === null ||
    cx === null ||
    cy === null
  ) {
    // A non-finite coordinate has no IEEE754 value to decode. Every point that
    // reaches a boundary predicate has already passed projectRelativePoint,
    // which rejects those, so this branch only keeps the function total.
    return 0;
  }
  const determinant = (ax - cx) * (by - cy) - (ay - cy) * (bx - cx);
  return determinant === 0n ? 0 : determinant > 0n ? 1 : -1;
}

/**
 * Certified orientation of the ordered triple `a`, `b`, `c`: +1 when `c` lies
 * left of the directed line `a` -> `b`, -1 when it lies right, and 0 only when
 * the three points are exactly collinear.
 *
 * The fast path is the float determinant of the edge differences from `c`,
 * trusted only while it clearly exceeds its rounding bound; anything else, and
 * any non-finite product, falls back to the exact integer determinant. This is
 * the single predicate behind collinearity, betweenness and segment crossing,
 * so none of them inherits a tolerance.
 */
function orientSign(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint,
): Orientation {
  const left = (a.x - c.x) * (b.y - c.y);
  const right = (a.y - c.y) * (b.x - c.x);
  const determinant = left - right;
  if (Number.isFinite(determinant)) {
    const errorBound =
      ORIENT_ERROR_FACTOR *
      ORIENT_ROUNDING_UNIT *
      (Math.abs(left) + Math.abs(right));
    if (Math.abs(determinant) > errorBound) {
      return determinant > 0 ? 1 : -1;
    }
  }
  return exactOrientSign(a, b, c);
}

/**
 * True when `point` lies inside the closed span of `start` and `end`, measured
 * along whichever axis the two of them actually differ in. Only meaningful for
 * three points {@link orientSign} has certified collinear: without that, a
 * projection onto one axis says nothing about betweenness. When `start` and
 * `end` coincide, only the identical point counts.
 */
function pointBetween(
  start: ProjectedPoint,
  point: ProjectedPoint,
  end: ProjectedPoint,
): boolean {
  const spanX = Math.abs(end.x - start.x);
  const spanY = Math.abs(end.y - start.y);
  if (spanX === 0 && spanY === 0) {
    return point.x === start.x && point.y === start.y;
  }
  if (spanX >= spanY) {
    return (
      point.x >= Math.min(start.x, end.x) &&
      point.x <= Math.max(start.x, end.x)
    );
  }
  return (
    point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y)
  );
}

/**
 * True when `point` lies on the closed segment `start`-`end`. Collinearity
 * comes from the exact orientation predicate and betweenness from the span of
 * the edge; no distance tolerance takes part, so a point a micrometre off the
 * line is off the line.
 */
function pointLiesOnSegment(
  start: ProjectedPoint,
  end: ProjectedPoint,
  point: ProjectedPoint,
): boolean {
  return orientSign(start, end, point) === 0 && pointBetween(start, point, end);
}

/**
 * True when the closed segments `first`-`second` and `third`-`fourth` share any
 * point: a proper crossing when the endpoints straddle, and otherwise any
 * collinear endpoint that lies on the other segment, which covers a shared
 * corner and a collinear overlap alike. The caller only ever passes
 * non-adjacent edges of one boundary, so any sharing makes the boundary
 * unreliable.
 */
function segmentsSharePoint(
  first: ProjectedPoint,
  second: ProjectedPoint,
  third: ProjectedPoint,
  fourth: ProjectedPoint,
): boolean {
  const fromFirst = orientSign(first, second, third);
  const fromSecond = orientSign(first, second, fourth);
  const fromThird = orientSign(third, fourth, first);
  const fromFourth = orientSign(third, fourth, second);
  if (fromFirst * fromSecond < 0 && fromThird * fromFourth < 0) {
    return true;
  }
  return (
    (fromFirst === 0 && pointBetween(first, third, second)) ||
    (fromSecond === 0 && pointBetween(first, fourth, second)) ||
    (fromThird === 0 && pointBetween(third, first, fourth)) ||
    (fromFourth === 0 && pointBetween(third, second, fourth))
  );
}

/**
 * True when the boundary doubles back at `middle`: it is exactly collinear
 * with its neighbours yet lies outside the segment they span. That is both an
 * A-B-A spike and a collinear fold-back, and dropping such a vertex would hide
 * a fold rather than simplify one.
 */
function isFold(
  before: ProjectedPoint,
  middle: ProjectedPoint,
  after: ProjectedPoint,
): boolean {
  return (
    orientSign(before, middle, after) === 0 &&
    !pointBetween(before, middle, after)
  );
}

/**
 * True when the closed boundary through `points` never touches itself: no
 * vertex doubles back on the edge before it, and no two non-adjacent edges
 * share a point, whether by a proper crossing, a shared endpoint or a
 * collinear overlap. The check runs on the actual vertex count rather than
 * only on a final quad, because a piece can arrive with five vertices and lose
 * one only later. A boundary that cannot be certified simple is reported
 * rather than assumed disjoint.
 */
function boundaryIsSimple(points: readonly ProjectedPoint[]): boolean {
  const count = points.length;
  if (count < 3) {
    return false;
  }
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return false;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const before = vertexAt(points, index - 1);
    const middle = vertexAt(points, index);
    const after = vertexAt(points, index + 1);
    if (before === null || middle === null || after === null) {
      return false;
    }
    if (isFold(before, middle, after)) {
      return false;
    }
  }
  for (let first = 0; first < count; first += 1) {
    for (let second = first + 2; second < count; second += 1) {
      if (first === 0 && second === count - 1) {
        // The closing edge is adjacent to the first edge.
        continue;
      }
      const start = vertexAt(points, first);
      const end = vertexAt(points, first + 1);
      const other = vertexAt(points, second);
      const otherEnd = vertexAt(points, second + 1);
      if (
        start === null ||
        end === null ||
        other === null ||
        otherEnd === null
      ) {
        return false;
      }
      if (segmentsSharePoint(start, end, other, otherEnd)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Triangulates a cleaned 3- or 4-gon in boundary order, so every emitted
 * triangle keeps the source orientation. A 4-gon is split along the diagonal
 * that yields two non-degenerate triangles in the source orientation; when
 * neither diagonal does, the boundary cannot be trusted and is reported.
 */
function triangulatePolygon(
  points: readonly ProjectedPoint[],
  winding: 1 | -1,
): readonly PlanarTriangle[] | null {
  const first = points[0];
  const second = points[1];
  const third = points[2];
  if (first === undefined || second === undefined || third === undefined) {
    return null;
  }
  if (points.length === 3) {
    const triangle: PlanarTriangle = [first, second, third];
    return hasSourceOrientation(triangle, winding) ? [triangle] : null;
  }
  const fourth = points[3];
  if (fourth === undefined) {
    return null;
  }
  if (!boundaryIsSimple(points)) {
    return null;
  }
  const diagonals: readonly (readonly PlanarTriangle[])[] = [
    [
      [first, second, third],
      [first, third, fourth],
    ],
    [
      [first, second, fourth],
      [second, third, fourth],
    ],
  ];
  for (const diagonal of diagonals) {
    if (diagonal.every((triangle) => hasSourceOrientation(triangle, winding))) {
      return diagonal;
    }
  }
  return null;
}

function projectPiece(
  piece: ClippedTrianglePiece,
  projection: MapProjection,
  winding: 1 | -1,
  sourceId: string | number,
): PieceProjection {
  const polygon = piecePolygon(piece, projection);
  if (polygon === null) {
    return {
      ok: false,
      reason: `projection "${projection.id}" cannot place every vertex of the hemisphere ${piece.hemisphere} piece on the plane`,
    };
  }
  // Bit-identical repeats go first, then the near-duplicate merge, with the
  // topology of the actual vertex count checked after each: a merge can create
  // or destroy a fold. Only certified collinear middles are removed last, and
  // never below three vertices, because three collinear vertices have no area
  // and the orientation check reports that instead.
  const distinct = dropExactDuplicates(polygon);
  if (distinct.length < 3) {
    return simplifiedToVertices(piece.hemisphere, distinct.length);
  }
  if (!boundaryIsSimple(distinct)) {
    return untrustworthyBoundary(piece.hemisphere);
  }
  const merged = dropRepeatedPoints(distinct);
  if (merged.length < 3) {
    return simplifiedToVertices(piece.hemisphere, merged.length);
  }
  if (!boundaryIsSimple(merged)) {
    return untrustworthyBoundary(piece.hemisphere);
  }
  const cleaned = dropCollinearMiddles(merged);
  if (cleaned.length < 3 || cleaned.length > 4) {
    return simplifiedToVertices(piece.hemisphere, cleaned.length);
  }
  const triangles = triangulatePolygon(cleaned, winding);
  if (triangles === null) {
    return {
      ok: false,
      reason: `planar boundary of the hemisphere ${piece.hemisphere} piece folds or loses the source orientation`,
    };
  }
  return {
    ok: true,
    triangles: triangles.map((vertices) => ({
      sourceId,
      hemisphere: piece.hemisphere,
      vertices,
    })),
  };
}

/**
 * Projects one source spherical triangle onto a flat map and triangulates it.
 *
 * `a`, `b` and `c` are world-space positions already rotated for the target age
 * and may carry any radius; they are copied and unitised by the spherical
 * clipper, never modified. The spherical clipping is delegated to the verified
 * stage 3A, whose status, reason and winding are passed through unchanged for
 * every non-ok verdict: a degenerate, invalid or unsupported source face stays
 * exactly that, and never becomes a partial set of planar triangles.
 *
 * Each clipped piece is then mapped vertex by vertex with
 * {@link MapProjection.projectRelative}, never with the wrapping
 * {@link MapProjection.project}: a piece already lives inside one half of the
 * map, so re-wrapping it would move it. A pole is expanded into the two map
 * edge points its neighbours dictate on Plate Carree, and kept as the single
 * convergent point the projection gives it on Mollweide. Any piece that cannot
 * be represented fails the whole source face rather than dropping area.
 *
 * Scope: this is a vertex approximation of an upstream mesh that is already
 * subdivided to roughly one degree. No adaptive subdivision of curved edges, no
 * ring or hole reconstruction, and no claim that the straightened boundary area
 * equals the spherical area of the source face.
 */
export function projectTriangle(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
  sourceId: string | number,
  projection: MapProjection,
): TriangleProjectionResult {
  const clipped = clipTriangleToHemispheres(
    a,
    b,
    c,
    sourceId,
    projection.centralMeridianDeg,
  );
  if (clipped.status !== "ok") {
    return projectionDiagnostic(
      clipped.status,
      sourceId,
      clipped.reason ?? "triangle clipping rejected the source triangle",
      clipped.winding,
    );
  }
  const winding = clipped.winding;
  if (winding === undefined) {
    return projectionDiagnostic(
      "unsupported",
      sourceId,
      "clipped triangle carries no source winding",
    );
  }

  const triangles: ProjectedTriangle[] = [];
  for (const piece of clipped.pieces) {
    const projected = projectPiece(piece, projection, winding, sourceId);
    if (!projected.ok) {
      return projectionDiagnostic(
        "unsupported",
        sourceId,
        projected.reason,
        winding,
      );
    }
    triangles.push(...projected.triangles);
  }
  return { status: "ok", sourceId, triangles, winding };
}
