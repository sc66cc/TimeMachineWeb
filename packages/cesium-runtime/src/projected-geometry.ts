import type { Vec3 } from "@timemachine/reconstruction-core";

import type { MapProjection, ProjectedPoint } from "./map-projection";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Snapping tolerance for a unit-vector component, in radians of arc (on the
 * Earth's surface R * eps is about six micrometres). Anything this close to
 * an axis is treated as being exactly on it, which keeps the y = 0 great
 * circle a hard boundary.
 */
const EPS_UNIT = 1e-12;

/** Angular distance at or below which a source edge is a single point. */
const DEGENERATE_ANGLE_RAD = 1e-12;

/**
 * Largest angular distance still treated as one unique short great-circle
 * arc. The upstream grid stays near one degree, so this leaves ample slack.
 */
const MAX_SUPPORTED_ANGLE_RAD = Math.PI / 2 - 1e-10;

const NORTH_POLE: Vec3 = { x: 0, y: 0, z: 1 };
const SOUTH_POLE: Vec3 = { x: 0, y: 0, z: -1 };

export type SegmentProjectionStatus =
  | "ok"
  | "degenerate"
  | "invalid"
  | "unsupported";

/** One projected polyline piece of a source spherical edge. */
export interface ProjectedSegment {
  readonly sourceId: string | number;
  readonly start: ProjectedPoint;
  readonly end: ProjectedPoint;
}

export interface SegmentProjectionResult {
  readonly status: SegmentProjectionStatus;
  readonly sourceId: string | number;
  /** Empty for every non-ok status. */
  readonly segments: readonly ProjectedSegment[];
  /** Present and non-empty for every non-ok status. */
  readonly reason?: string;
}

/**
 * Which side of the relative frame an endpoint sits on. "pole" and "seam"
 * have no longitude of their own and inherit one from the other end of the
 * sub-segment they belong to.
 */
type EndpointSide = "pole" | "seam" | "central" | "ordinary";

interface RelativeEndpoint {
  /** Unit direction in the frame of the central meridian, y already snapped. */
  readonly direction: Vec3;
  readonly side: EndpointSide;
  readonly latitudeDeg: number;
  /**
   * Relative longitude in degrees. Only meaningful for "central" (always 0)
   * and "ordinary"; pole and seam longitudes are assigned per sub-segment.
   */
  readonly longitudeDeg: number;
}

/** A sub-segment of the source edge, still in spherical form. */
type SubSegment = readonly [RelativeEndpoint, RelativeEndpoint];

interface ResolvedEndpoint {
  readonly relativeLongitudeDeg: number;
  readonly latitudeDeg: number;
}

interface ResolvedPair {
  readonly start: ResolvedEndpoint;
  readonly end: ResolvedEndpoint;
}

function diagnostic(
  status: Exclude<SegmentProjectionStatus, "ok">,
  sourceId: string | number,
  reason: string,
): SegmentProjectionResult {
  return { status, sourceId, segments: [], reason };
}

function isFiniteVec3(vector: Readonly<Vec3>): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}

/**
 * True when at least one component is non-zero. Comparing components instead
 * of the squared length keeps the test exact at subnormal magnitudes, where
 * the sum of squares would underflow to zero.
 */
function isNonzeroVec3(vector: Readonly<Vec3>): boolean {
  return vector.x !== 0 || vector.y !== 0 || vector.z !== 0;
}

function dotVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vec3Length(vector: Readonly<Vec3>): number {
  return Math.sqrt(
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z,
  );
}

/**
 * Normalises a non-zero finite vector. Dividing by the largest component
 * first keeps every scaled component inside [-1, 1], so neither huge nor
 * tiny magnitudes overflow or underflow the sum of squares, and no 1/tiny
 * intermediate is ever formed.
 */
function normalizeVec3(vector: Readonly<Vec3>): Vec3 {
  const largest = Math.max(
    Math.abs(vector.x),
    Math.abs(vector.y),
    Math.abs(vector.z),
  );
  const scaled = {
    x: vector.x / largest,
    y: vector.y / largest,
    z: vector.z / largest,
  };
  const length = Math.hypot(scaled.x, scaled.y, scaled.z);
  return {
    x: scaled.x / length,
    y: scaled.y / length,
    z: scaled.z / length,
  };
}

/** Central angle between two unit directions, via atan2 so it never saturates. */
function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.atan2(vec3Length(crossVec3(a, b)), dotVec3(a, b));
}

/**
 * Rotates a unit direction by minus the central meridian about Z, which moves
 * the central meridian onto the +X axis and the antimeridian onto -X.
 */
function rotateToCentralMeridian(
  direction: Readonly<Vec3>,
  centralMeridianDeg: number,
): Vec3 {
  const lambda = centralMeridianDeg * DEG_TO_RAD;
  const cos = Math.cos(lambda);
  const sin = Math.sin(lambda);
  return {
    x: direction.x * cos + direction.y * sin,
    y: -direction.x * sin + direction.y * cos,
    z: direction.z,
  };
}

/**
 * Latitude of a unit direction. atan2(z, hypot(x, y)) stays just under 90
 * degrees for a point a hair off the pole, where asin(z) would round the
 * unitised z to 1 and report the pole itself.
 */
function latitudeDegOf(direction: Readonly<Vec3>): number {
  return (
    Math.atan2(direction.z, Math.hypot(direction.x, direction.y)) *
    RAD_TO_DEG
  );
}

/**
 * Classifies an already-relative unit direction. A y component within
 * {@link EPS_UNIT} is snapped to exactly zero and the direction is renormalised,
 * so a direction that close to the y = 0 great circle is treated as lying on it.
 */
function relativeEndpoint(direction: Readonly<Vec3>): RelativeEndpoint {
  let { x, y, z } = direction;
  if (Math.abs(y) <= EPS_UNIT) {
    y = 0;
    const renormalised = normalizeVec3({ x, y, z });
    x = renormalised.x;
    z = renormalised.z;
  }

  if (Math.hypot(x, y) <= EPS_UNIT) {
    // Collapse to the exact pole: its longitude is not unique and must be
    // inherited from the other end of the sub-segment.
    const sign = z >= 0 ? 1 : -1;
    return {
      direction: { x: 0, y: 0, z: sign },
      side: "pole",
      latitudeDeg: sign * 90,
      longitudeDeg: 0,
    };
  }

  if (y === 0) {
    return {
      direction: { x, y, z },
      // x < 0 is the antimeridian half of the y = 0 great circle, x > 0 the
      // central meridian half.
      side: x < 0 ? "seam" : "central",
      latitudeDeg: latitudeDegOf({ x, y, z }),
      longitudeDeg: 0,
    };
  }

  return {
    direction: { x, y, z },
    side: "ordinary",
    latitudeDeg: latitudeDegOf({ x, y, z }),
    longitudeDeg: Math.atan2(y, x) * RAD_TO_DEG,
  };
}

type PolePlacement = "inside" | "outside";

/**
 * Decides whether `pole` lies strictly inside the short arc from `a` to `b`.
 *
 * The test is the directed progress along the great circle, not an angle sum:
 * with `n` the plane normal, `cross(a, pole) . n` is how far `pole` has
 * advanced past `a` on the way to `b`, and `cross(pole, b) . n` is how far it
 * still falls short of `b`. Both strictly positive means strictly inside; a
 * clearly negative value means outside. A value within {@link EPS_UNIT} of
 * arc puts the pole at an end of the arc, where the endpoint snap in
 * {@link relativeEndpoint} has already turned that end into a pole vertex, so
 * no extra split is needed. An angle sum cannot tell a pole just past an end
 * from one just inside, which is why it is not used here.
 */
function polePlacement(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  pole: Readonly<Vec3>,
): PolePlacement {
  const planeNormal = normalizeVec3(crossVec3(a, b));
  if (Math.abs(dotVec3(planeNormal, pole)) > EPS_UNIT) {
    // Not on the great circle through a and b, so not on the arc at all.
    return "outside";
  }
  const progressFromA = dotVec3(crossVec3(a, pole), planeNormal);
  const progressToB = dotVec3(crossVec3(pole, b), planeNormal);
  return progressFromA > EPS_UNIT && progressToB > EPS_UNIT
    ? "inside"
    : "outside";
}

/**
 * Makes an interior pole an explicit vertex so the edge is cut there. A short
 * arc cannot contain both poles, so at most one split happens.
 */
function splitAtInteriorPoles(
  a: RelativeEndpoint,
  b: RelativeEndpoint,
): SubSegment[] {
  for (const pole of [NORTH_POLE, SOUTH_POLE]) {
    if (polePlacement(a.direction, b.direction, pole) === "inside") {
      const vertex = relativeEndpoint(pole);
      return [
        [a, vertex],
        [vertex, b],
      ];
    }
  }
  return [[a, b]];
}

/**
 * Intersection of the short arc with the complete y = 0 great circle, found by
 * normalising the true spherical interpolation. Linear interpolation of
 * longitude/latitude is deliberately not used.
 */
function planeCrossing(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
): RelativeEndpoint | null {
  const t = a.y / (a.y - b.y);
  const interpolated = {
    x: (1 - t) * a.x + t * b.x,
    y: (1 - t) * a.y + t * b.y,
    z: (1 - t) * a.z + t * b.z,
  };
  const onArc = normalizeVec3(interpolated);
  const flattened = { x: onArc.x, y: 0, z: onArc.z };
  const crossing = relativeEndpoint(flattened);
  // The arc reaching a pole here was not split by the pole pass, so the piece
  // cannot be trusted.
  return crossing.side === "pole" ? null : crossing;
}

function seamSideLongitude(other: RelativeEndpoint): number {
  // The caller guarantees the other end is off the y = 0 great circle.
  return other.direction.y > 0 ? 180 : -180;
}

function resolveEndpoint(
  endpoint: RelativeEndpoint,
  other: RelativeEndpoint,
): ResolvedEndpoint {
  switch (endpoint.side) {
    case "pole":
      // A pole has no unique longitude: take the meridian of the other end so
      // both ends of the piece stay on one meridian.
      return {
        relativeLongitudeDeg: other.longitudeDeg,
        latitudeDeg: endpoint.latitudeDeg,
      };
    case "seam":
      // Which side of the seam this copy belongs to follows the other end's
      // hemisphere, never how the input longitude happened to be written.
      return {
        relativeLongitudeDeg: seamSideLongitude(other),
        latitudeDeg: endpoint.latitudeDeg,
      };
    default:
      return {
        relativeLongitudeDeg: endpoint.longitudeDeg,
        latitudeDeg: endpoint.latitudeDeg,
      };
  }
}

/**
 * A sub-segment that lies on one meridian: both ends share the longitude and
 * keep their own latitude.
 */
function meridianPair(
  longitudeDeg: number,
  a: RelativeEndpoint,
  b: RelativeEndpoint,
): ResolvedPair {
  return {
    start: {
      relativeLongitudeDeg: longitudeDeg,
      latitudeDeg: a.latitudeDeg,
    },
    end: { relativeLongitudeDeg: longitudeDeg, latitudeDeg: b.latitudeDeg },
  };
}

/**
 * Resolves the longitudes of a sub-segment that lies entirely on the y = 0
 * great circle. Such a piece is a whole meridian: the seam half is drawn on
 * both map edges, the central-meridian half only once.
 */
function resolveCoplanarPair(
  a: RelativeEndpoint,
  b: RelativeEndpoint,
): ResolvedPair[] | null {
  const aIsPole = a.side === "pole";
  const bIsPole = b.side === "pole";
  if (aIsPole && bIsPole) {
    return null;
  }
  if (a.side === "central" && b.side === "central") {
    return [meridianPair(0, a, b)];
  }
  if (
    (a.side === "seam" && b.side === "seam") ||
    (aIsPole && b.side === "seam") ||
    (a.side === "seam" && bIsPole)
  ) {
    return [meridianPair(180, a, b), meridianPair(-180, a, b)];
  }
  if (
    (aIsPole && b.side === "central") ||
    (a.side === "central" && bIsPole)
  ) {
    return [meridianPair(0, a, b)];
  }
  // Seam to central meridian passes through a pole that the pole pass did not
  // split out.
  return null;
}

/**
 * Assigns a relative longitude to every end of a sub-segment. Returns two
 * pairs when the piece lies on the seam and has to be drawn on both edges.
 */
function resolvePair(
  a: RelativeEndpoint,
  b: RelativeEndpoint,
): ResolvedPair[] | null {
  if (a.direction.y === 0 && b.direction.y === 0) {
    return resolveCoplanarPair(a, b);
  }
  return [{ start: resolveEndpoint(a, b), end: resolveEndpoint(b, a) }];
}

function projectEndpoint(
  endpoint: ResolvedEndpoint,
  projection: MapProjection,
): ProjectedPoint | null {
  try {
    return projection.projectRelative(
      endpoint.relativeLongitudeDeg,
      endpoint.latitudeDeg,
    );
  } catch {
    return null;
  }
}

/**
 * Projects one spherical line segment onto a flat map.
 *
 * `a` and `b` are world-space positions already rotated for the target age and
 * may carry any radius; they are copied and unitised, never modified. The edge
 * is cut at interior poles and at the y = 0 great circle so that no piece
 * crosses the antimeridian or the central meridian, and every piece keeps the
 * source direction and id. The result is a vertex approximation of the already
 * subdivided upstream mesh: no extra adaptive subdivision is added.
 *
 * Unsupported input is reported instead of being silently dropped: non-finite
 * or zero vectors are "invalid", coincident endpoints are "degenerate", and
 * edges outside the supported short-arc domain or with an unreliable crossing
 * are "unsupported".
 */
export function projectSegment(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  sourceId: string | number,
  projection: MapProjection,
): SegmentProjectionResult {
  if (!isFiniteVec3(a) || !isFiniteVec3(b)) {
    return diagnostic(
      "invalid",
      sourceId,
      "segment endpoint has a non-finite component",
    );
  }
  if (!isNonzeroVec3(a) || !isNonzeroVec3(b)) {
    return diagnostic(
      "invalid",
      sourceId,
      "segment endpoint is not a usable direction",
    );
  }

  const unitA = normalizeVec3(a);
  const unitB = normalizeVec3(b);

  const angularDistance = angleBetween(unitA, unitB);
  if (angularDistance <= DEGENERATE_ANGLE_RAD) {
    return diagnostic("degenerate", sourceId, "segment endpoints coincide");
  }
  if (angularDistance >= MAX_SUPPORTED_ANGLE_RAD) {
    return diagnostic(
      "unsupported",
      sourceId,
      `edge spans ${angularDistance} rad, beyond the supported short-arc domain of ${MAX_SUPPORTED_ANGLE_RAD} rad`,
    );
  }

  const relativeA = relativeEndpoint(
    rotateToCentralMeridian(unitA, projection.centralMeridianDeg),
  );
  const relativeB = relativeEndpoint(
    rotateToCentralMeridian(unitB, projection.centralMeridianDeg),
  );

  const cut: SubSegment[] = [];
  for (const [start, end] of splitAtInteriorPoles(relativeA, relativeB)) {
    if (start.direction.y * end.direction.y < 0) {
      const crossing = planeCrossing(start.direction, end.direction);
      if (!crossing) {
        return diagnostic(
          "unsupported",
          sourceId,
          "great-circle crossing of the y = 0 plane is numerically unreliable",
        );
      }
      cut.push([start, crossing], [crossing, end]);
    } else {
      cut.push([start, end]);
    }
  }

  const segments: ProjectedSegment[] = [];
  for (const [start, end] of cut) {
    const resolved = resolvePair(start, end);
    if (!resolved) {
      return diagnostic(
        "unsupported",
        sourceId,
        "sub-segment runs along an unsupported great circle",
      );
    }
    for (const pair of resolved) {
      const projectedStart = projectEndpoint(pair.start, projection);
      const projectedEnd = projectEndpoint(pair.end, projection);
      if (!projectedStart || !projectedEnd) {
        return diagnostic(
          "unsupported",
          sourceId,
          "projection maths rejected a sub-segment endpoint",
        );
      }
      segments.push({ sourceId, start: projectedStart, end: projectedEnd });
    }
  }

  return { status: "ok", sourceId, segments };
}

/** Which half of the y = 0 great circle a clipped piece belongs to. */
type Hemisphere = 1 | -1;

/** A spherical triangle of unit directions in the central-meridian frame. */
type SphericalTriangle = readonly [Vec3, Vec3, Vec3];

/** Signed spherical area at or below which a source face has no area. */
const SPHERICAL_DEGENERATE_AREA = 1e-14;

/**
 * One vertex of a clipped piece, still in spherical form. No planar
 * projection and no triangulation happen here: both the Rectangle and the
 * Mollweide paths consume these pieces.
 */
export interface ClippedTriangleVertex {
  /** Unit direction in the frame of the central meridian. */
  readonly direction: Vec3;
  readonly latitudeDeg: number;
  /**
   * Logical relative longitude in degrees, or `null` for a pole: a pole has
   * no unique longitude until stage 3B expands it against the neighbouring
   * vertices. Never `NaN`.
   */
  readonly relativeLongitudeDeg: number | null;
  readonly pole: boolean;
  /** Which map edge a seam copy belongs to; 0 when not on the seam. */
  readonly seamSide: -1 | 0 | 1;
}

/** One piece of a source triangle that lies inside a single hemisphere. */
export interface ClippedTrianglePiece {
  readonly sourceId: string | number;
  readonly hemisphere: Hemisphere;
  readonly vertices: readonly ClippedTriangleVertex[];
}

export type TriangleClipStatus =
  | "ok"
  | "degenerate"
  | "invalid"
  | "unsupported";

export interface TriangleClipResult {
  readonly status: TriangleClipStatus;
  readonly sourceId: string | number;
  /** Empty for every non-ok status. */
  readonly pieces: readonly ClippedTrianglePiece[];
  /** Present and non-empty for every non-ok status. */
  readonly reason?: string;
  /** Orientation of the source triangle, once it could be established. */
  readonly winding?: 1 | -1;
}

function triangleDiagnostic(
  status: Exclude<TriangleClipStatus, "ok">,
  sourceId: string | number,
  reason: string,
  winding?: 1 | -1,
): TriangleClipResult {
  return winding === undefined
    ? { status, sourceId, pieces: [], reason }
    : { status, sourceId, pieces: [], reason, winding };
}

function subtractVec3(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Signed spherical area of a unit triangle, via atan2 so it never saturates.
 * The determinant uses edge differences rather than the raw cross product so
 * that a small face does not lose its sign to cancellation.
 */
function signedSphericalArea(triangle: SphericalTriangle): number {
  const [a, b, c] = triangle;
  const determinant = dotVec3(
    a,
    crossVec3(subtractVec3(b, a), subtractVec3(c, a)),
  );
  return (
    2 *
    Math.atan2(
      determinant,
      1 + dotVec3(a, b) + dotVec3(b, c) + dotVec3(c, a),
    )
  );
}

function sameDirection(a: Readonly<Vec3>, b: Readonly<Vec3>): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Turns a pole into an explicit vertex, preserving the source winding and id.
 *
 * Returns `null` when the pole cannot be attributed reliably: it is neither
 * clearly inside nor clearly outside the face, so guessing could silently
 * swallow a non-degenerate face.
 */
function splitTriangleAtPoles(
  triangle: SphericalTriangle,
  winding: 1 | -1,
): SphericalTriangle[] | null {
  const [a, b, c] = triangle;
  // Each entry is a directed edge followed by the vertex opposite to it.
  const edges: readonly [Vec3, Vec3, Vec3][] = [
    [a, b, c],
    [b, c, a],
    [c, a, b],
  ];

  for (const pole of [NORTH_POLE, SOUTH_POLE]) {
    if (
      sameDirection(a, pole) ||
      sameDirection(b, pole) ||
      sameDirection(c, pole)
    ) {
      // Already an explicit vertex: its written longitude is irrelevant.
      continue;
    }
    for (const [start, end, opposite] of edges) {
      if (polePlacement(start, end, pole) === "inside") {
        return [
          [start, pole, opposite],
          [pole, end, opposite],
        ];
      }
    }
    const orientations = edges.map(
      ([start, end]) =>
        winding * dotVec3(normalizeVec3(crossVec3(start, end)), pole),
    );
    if (orientations.every((value) => value > EPS_UNIT)) {
      return [
        [a, b, pole],
        [b, c, pole],
        [c, a, pole],
      ];
    }
    if (orientations.some((value) => value < -EPS_UNIT)) {
      // Clearly on the outside of one edge, so outside the face.
      continue;
    }
    return null;
  }
  return [triangle];
}

/**
 * Crossing of a directed edge with the y = 0 great circle. An end already on
 * the plane is the crossing itself, so no division by zero ever happens; only
 * strictly opposite ends fall back to the verified short-arc interpolation.
 */
function hemisphereCrossing(
  start: Readonly<Vec3>,
  end: Readonly<Vec3>,
): RelativeEndpoint | null {
  if (start.y === 0) {
    return relativeEndpoint(start);
  }
  if (end.y === 0) {
    return relativeEndpoint(end);
  }
  return planeCrossing(start, end);
}

/** Drops consecutive duplicate unit vertices, including the wrap-around. */
function dedupeConsecutiveEndpoints(
  vertices: readonly RelativeEndpoint[],
): RelativeEndpoint[] {
  const unique: RelativeEndpoint[] = [];
  for (const vertex of vertices) {
    const previous = unique[unique.length - 1];
    if (previous && sameDirection(previous.direction, vertex.direction)) {
      continue;
    }
    unique.push(vertex);
  }
  while (unique.length > 1) {
    const firstDirection = unique[0]?.direction;
    const lastDirection = unique[unique.length - 1]?.direction;
    if (
      firstDirection === undefined ||
      lastDirection === undefined ||
      !sameDirection(firstDirection, lastDirection)
    ) {
      break;
    }
    unique.pop();
  }
  return unique;
}

/**
 * Spherical Sutherland-Hodgman clip of one already pole-split triangle against
 * a single hemisphere. The input order is preserved, so the piece keeps the
 * source winding. Returns `null` when a crossing is numerically unreliable.
 */
function clipEndpointsToHemisphere(
  vertices: readonly [RelativeEndpoint, RelativeEndpoint, RelativeEndpoint],
  hemisphere: Hemisphere,
): RelativeEndpoint[] | null {
  const [first, second, third] = vertices;
  const edges: readonly [RelativeEndpoint, RelativeEndpoint][] = [
    [first, second],
    [second, third],
    [third, first],
  ];

  const clipped: RelativeEndpoint[] = [];
  for (const [start, end] of edges) {
    const startInside = hemisphere * start.direction.y >= 0;
    const endInside = hemisphere * end.direction.y >= 0;
    if (startInside && endInside) {
      clipped.push(end);
      continue;
    }
    if (startInside === endInside) {
      continue;
    }
    const crossing = hemisphereCrossing(start.direction, end.direction);
    if (!crossing) {
      return null;
    }
    if (endInside) {
      clipped.push(crossing, end);
    } else {
      clipped.push(crossing);
    }
  }
  return dedupeConsecutiveEndpoints(clipped);
}

/**
 * Assigns the logical longitude of a clipped vertex. A pole keeps `null` here;
 * stage 3B expands it against the neighbouring vertices. A seam copy takes
 * the longitude of the hemisphere it belongs to, never the written input
 * longitude.
 */
function clippedTriangleVertex(
  endpoint: RelativeEndpoint,
  hemisphere: Hemisphere,
): ClippedTriangleVertex {
  const { direction, latitudeDeg } = endpoint;
  if (endpoint.side === "pole") {
    return {
      direction,
      latitudeDeg,
      relativeLongitudeDeg: null,
      pole: true,
      seamSide: 0,
    };
  }
  if (endpoint.side === "seam") {
    return {
      direction,
      latitudeDeg,
      relativeLongitudeDeg: hemisphere * 180,
      pole: false,
      seamSide: hemisphere,
    };
  }
  if (endpoint.side === "central") {
    return {
      direction,
      latitudeDeg,
      relativeLongitudeDeg: 0,
      pole: false,
      seamSide: 0,
    };
  }
  return {
    direction,
    latitudeDeg,
    relativeLongitudeDeg: endpoint.longitudeDeg,
    pole: false,
    seamSide: 0,
  };
}

/**
 * Prepares one spherical triangle for planar projection: interior and
 * edge-interior poles become explicit vertices, then every piece is clipped to
 * the positive and the negative half of the y = 0 great circle.
 *
 * This is the spherical stage shared by the Rectangle and Mollweide paths. It
 * deliberately stops short of planar triangulation and of expanding poles into
 * map-edge copies, both of which depend on the target projection.
 *
 * `a`, `b` and `c` are world-space positions already rotated for the target
 * age and may carry any radius; they are copied and unitised, never modified.
 * The output directions live in the frame of the central meridian, not in the
 * input world frame. Every piece keeps the source id and the source winding.
 *
 * Unsupported input is reported instead of being silently dropped: non-finite
 * or zero vectors are "invalid", coincident or coplanar faces are
 * "degenerate", and edges outside the supported short-arc domain, ambiguous
 * pole attribution, an unreliable crossing, or a sliver that the y = 0
 * snapping cannot represent are "unsupported".
 */
export function clipTriangleToHemispheres(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
  sourceId: string | number,
  centralMeridianDeg = 0,
): TriangleClipResult {
  if (!isFiniteVec3(a) || !isFiniteVec3(b) || !isFiniteVec3(c)) {
    return triangleDiagnostic(
      "invalid",
      sourceId,
      "triangle vertex has a non-finite component",
    );
  }
  if (!isNonzeroVec3(a) || !isNonzeroVec3(b) || !isNonzeroVec3(c)) {
    return triangleDiagnostic(
      "invalid",
      sourceId,
      "triangle vertex is not a usable direction",
    );
  }
  if (!Number.isFinite(centralMeridianDeg)) {
    return triangleDiagnostic(
      "invalid",
      sourceId,
      "central meridian is not finite",
    );
  }

  // The source face is measured before any snapping. Rotating the world by
  // minus the central meridian is an isometry, so the area and the winding are
  // identical in either frame; only the raw unit directions decide whether the
  // source is degenerate and which way it winds.
  const sourceTriangle: SphericalTriangle = [
    normalizeVec3(a),
    normalizeVec3(b),
    normalizeVec3(c),
  ];

  for (const [start, end] of [
    [sourceTriangle[0], sourceTriangle[1]],
    [sourceTriangle[1], sourceTriangle[2]],
    [sourceTriangle[2], sourceTriangle[0]],
  ] as const) {
    const angularDistance = angleBetween(start, end);
    if (angularDistance >= MAX_SUPPORTED_ANGLE_RAD) {
      return triangleDiagnostic(
        "unsupported",
        sourceId,
        `triangle edge spans ${angularDistance} rad, beyond the supported short-arc domain of ${MAX_SUPPORTED_ANGLE_RAD} rad`,
      );
    }
  }

  const signedArea = signedSphericalArea(sourceTriangle);
  if (
    !Number.isFinite(signedArea) ||
    Math.abs(signedArea) <= SPHERICAL_DEGENERATE_AREA
  ) {
    return triangleDiagnostic(
      "degenerate",
      sourceId,
      "triangle has no spherical area",
    );
  }
  const winding: 1 | -1 = signedArea > 0 ? 1 : -1;

  const relativeUnit = (position: Readonly<Vec3>): Vec3 =>
    relativeEndpoint(
      rotateToCentralMeridian(normalizeVec3(position), centralMeridianDeg),
    ).direction;
  const triangle: SphericalTriangle = [
    relativeUnit(a),
    relativeUnit(b),
    relativeUnit(c),
  ];

  // Snapping a vertex onto the y = 0 great circle moves it by at most EPS_UNIT,
  // which is harmless for a face with real area but can flatten a sliver that
  // the source measurement above already found non-degenerate. The working
  // triangle must never redefine that verdict: if the snapping flattened or
  // reversed the source face, the face cannot be represented reliably and is
  // reported instead of being mislabelled as degenerate.
  const workingArea = signedSphericalArea(triangle);
  if (
    !Number.isFinite(workingArea) ||
    Math.abs(workingArea) <= SPHERICAL_DEGENERATE_AREA
  ) {
    return triangleDiagnostic(
      "unsupported",
      sourceId,
      "relative-frame snapping collapsed a non-degenerate source face below the area precision threshold",
      winding,
    );
  }
  const workingWinding: 1 | -1 = workingArea > 0 ? 1 : -1;
  if (workingWinding !== winding) {
    return triangleDiagnostic(
      "unsupported",
      sourceId,
      "relative-frame snapping reversed the orientation of a non-degenerate source face",
      winding,
    );
  }

  const split = splitTriangleAtPoles(triangle, winding);
  if (!split) {
    return triangleDiagnostic(
      "unsupported",
      sourceId,
      "pole membership of the triangle is numerically ambiguous",
      winding,
    );
  }

  const pieces: ClippedTrianglePiece[] = [];
  for (const subTriangle of split) {
    const [subA, subB, subC] = subTriangle;
    const endpoints: readonly [
      RelativeEndpoint,
      RelativeEndpoint,
      RelativeEndpoint,
    ] = [
      relativeEndpoint(subA),
      relativeEndpoint(subB),
      relativeEndpoint(subC),
    ];
    for (const hemisphere of [1, -1] as const) {
      const clipped = clipEndpointsToHemisphere(endpoints, hemisphere);
      if (!clipped) {
        return triangleDiagnostic(
          "unsupported",
          sourceId,
          "great-circle crossing of the y = 0 plane is numerically unreliable",
          winding,
        );
      }
      if (clipped.length < 3) {
        // No area in this hemisphere.
        continue;
      }
      if (clipped.every((vertex) => vertex.direction.y === 0)) {
        // Every vertex on the y = 0 great circle: a seam or central-meridian
        // sliver with no area, not a piece of the wrong side.
        continue;
      }
      pieces.push({
        sourceId,
        hemisphere,
        vertices: clipped.map((vertex) =>
          clippedTriangleVertex(vertex, hemisphere),
        ),
      });
    }
  }
  if (pieces.length === 0) {
    return triangleDiagnostic(
      "unsupported",
      sourceId,
      "clipping a non-degenerate triangle produced no area",
      winding,
    );
  }

  return { status: "ok", sourceId, pieces, winding };
}
