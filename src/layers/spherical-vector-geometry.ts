import {
  ArcType, Cartesian2, Cartesian3, Cartographic, EllipsoidGeodesic,
  EllipsoidTangentPlane, GeometryInstance, PerInstanceColorAppearance,
  PolygonGeometry, PolygonHierarchy,
} from "cesium";
import { EARTH_RADIUS_METRES, SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";

// Engineering candidate limits, not the final scientific/large-dataset contract.
// No height datum is established for ordinary vectors yet: this slice is 2D, h=0.
const STEP = Math.PI / 180;
const LINE_POSITIONS = 8192;
const POLYGON_SOURCE_POSITIONS = 512;
const POLYGON_OUTPUT_POSITIONS = 262144;
const CHART_MARGIN = 1e-6;
const PREDICATE_EPSILON = 1e-12;

type Position = [number, number];
type Ring = Cartesian3[];

function invalid(message: string): never {
  throw new AgentActionValidationError(message);
}

function unsupported(message: string): never {
  throw new AgentActionUnsupportedError(message);
}

function readPosition(value: unknown): Position {
  if (!Array.isArray(value) || value.length < 2) invalid("A vector position must contain longitude and latitude.");
  if (value.length !== 2) unsupported("Ordinary vector heights and extra coordinate dimensions are not supported by this slice.");
  const [longitude, latitude] = value;
  if (typeof longitude !== "number" || typeof latitude !== "number" ||
      !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    invalid("Vector coordinates must be finite degrees within longitude/latitude bounds.");
  }
  return [longitude, latitude];
}

function cartesian([longitude, latitude]: Position): Cartesian3 {
  return Cartesian3.fromDegrees(longitude, latitude, 0, SPHERICAL_EARTH);
}

/**
 * Sample short great-circle arcs on the project sphere. The consumer MUST use
 * ArcType.NONE: Cesium's PolylinePipeline caches a default-ellipsoid geodesic.
 * Even interval counts retain each segment midpoint, with steps no larger than
 * one degree. This prepares positions only; it does not prove a rendered frame.
 */
export function sampleSphericalLine(coordinates: unknown): Cartesian3[] {
  if (!Array.isArray(coordinates) || coordinates.length < 2) invalid("A line needs at least two positions.");
  if (coordinates.length > LINE_POSITIONS) unsupported("The line exceeds the source position budget.");
  const source = Array.from(coordinates, readPosition);
  const vertices = source.map(cartesian);
  const intervals: number[] = [];
  let outputCount = 1;
  for (let i = 1; i < vertices.length; i++) {
    const angle = Cartesian3.angleBetween(vertices[i - 1]!, vertices[i]!);
    if (angle <= PREDICATE_EPSILON) invalid("A line contains a zero-length or numerically coincident segment.");
    // Match the native inverse-geodesic domain in both development and production.
    if (Math.PI - angle < 0.0125) unsupported("Near-antipodal line segments require an explicit source subdivision.");
    const count = Math.max(2, 2 * Math.ceil(angle / (2 * STEP)));
    intervals.push(count);
    outputCount += count;
    if (outputCount > LINE_POSITIONS) unsupported("The sampled line exceeds the position budget.");
  }
  const result: Cartesian3[] = [vertices[0]!];
  for (let i = 1; i < source.length; i++) {
    const first = source[i - 1]!, last = source[i]!;
    const geodesic = new EllipsoidGeodesic(
      Cartographic.fromDegrees(first[0], first[1]),
      Cartographic.fromDegrees(last[0], last[1]),
      SPHERICAL_EARTH,
    );
    const count = intervals[i - 1]!;
    for (let step = 1; step < count; step++) {
      const point = geodesic.interpolateUsingFraction(step / count);
      point.height = 0;
      result.push(SPHERICAL_EARTH.cartographicToCartesian(point));
    }
    result.push(vertices[i]!);
  }
  return result;
}

function orient(a: Cartesian2, b: Cartesian2, c: Cartesian2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Cartesian2, b: Cartesian2, p: Cartesian2): boolean {
  return Math.abs(orient(a, b, p)) <= PREDICATE_EPSILON &&
    p.x >= Math.min(a.x, b.x) - PREDICATE_EPSILON && p.x <= Math.max(a.x, b.x) + PREDICATE_EPSILON &&
    p.y >= Math.min(a.y, b.y) - PREDICATE_EPSILON && p.y <= Math.max(a.y, b.y) + PREDICATE_EPSILON;
}

function intersects(a: Cartesian2, b: Cartesian2, c: Cartesian2, d: Cartesian2): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - PREDICATE_EPSILON ||
      Math.max(c.x, d.x) < Math.min(a.x, b.x) - PREDICATE_EPSILON ||
      Math.max(a.y, b.y) < Math.min(c.y, d.y) - PREDICATE_EPSILON ||
      Math.max(c.y, d.y) < Math.min(a.y, b.y) - PREDICATE_EPSILON) return false;
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  // Overlapping bounds with uncertain orientation are not evidence of separation.
  // Refuse the topology rather than accepting small crossings or boundary contact.
  if ([abC, abD, cdA, cdB].some(turn => Math.abs(turn) <= PREDICATE_EPSILON)) return true;
  return ((abC > PREDICATE_EPSILON && abD < -PREDICATE_EPSILON) || (abC < -PREDICATE_EPSILON && abD > PREDICATE_EPSILON)) &&
    ((cdA > PREDICATE_EPSILON && cdB < -PREDICATE_EPSILON) || (cdA < -PREDICATE_EPSILON && cdB > PREDICATE_EPSILON));
}

function ringsIntersect(first: Cartesian2[], second: Cartesian2[]): boolean {
  return first.some((a, i) => second.some((c, j) => intersects(a, first[(i + 1) % first.length]!, c, second[(j + 1) % second.length]!)));
}

function inside(point: Cartesian2, ring: Cartesian2[]): boolean {
  let contained = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    if (onSegment(a, b, point)) return false;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) contained = !contained;
  }
  return contained;
}

function validateSimpleRing(ring: Cartesian2[]): void {
  let twiceArea = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, c = ring[(i + 2) % ring.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
    if (Math.abs(orient(a, b, c)) <= PREDICATE_EPSILON &&
        (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0) {
      invalid("A polygon ring folds back along an adjacent edge.");
    }
    for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
      if (intersects(a, b, ring[j]!, ring[(j + 1) % ring.length]!)) invalid("A polygon ring crosses, touches or overlaps itself.");
    }
  }
  if (Math.abs(twiceArea) <= PREDICATE_EPSILON) invalid("A polygon ring is degenerate or numerically indeterminate.");
}

function validateTopology(rings: Ring[]): void {
  const sum = rings[0]!.reduce((total, point) => Cartesian3.add(total, point, total), new Cartesian3());
  if (Cartesian3.magnitude(sum) / EARTH_RADIUS_METRES <= PREDICATE_EPSILON) unsupported("A supported forward-hemisphere polygon chart could not be established.");
  const normal = Cartesian3.normalize(sum, new Cartesian3());
  const plane = new EllipsoidTangentPlane(Cartesian3.multiplyByScalar(normal, EARTH_RADIUS_METRES, new Cartesian3()), SPHERICAL_EARTH);
  const projected = rings.map(ring => ring.map(point => {
    if (Cartesian3.dot(normal, point) / EARTH_RADIUS_METRES <= CHART_MARGIN) unsupported("Polygon positions must share the selected forward-hemisphere chart.");
    // The batch API drops unprojectable points; the single API can reverse rays.
    // Prove the forward domain first, then require every point to survive.
    const result = plane.projectPointOntoPlane(point);
    if (!result || !Number.isFinite(result.x) || !Number.isFinite(result.y)) unsupported("The polygon chart is numerically unsupported.");
    return Cartesian2.divideByScalar(result, EARTH_RADIUS_METRES, result);
  }));
  projected.forEach(validateSimpleRing);
  const outer = projected[0]!;
  for (let i = 1; i < projected.length; i++) {
    const hole = projected[i]!;
    if (ringsIntersect(outer, hole) || !inside(hole[0]!, outer)) invalid("A polygon hole must lie strictly inside its exterior without touching it.");
    for (let j = 1; j < i; j++) {
      const other = projected[j]!;
      if (ringsIntersect(hole, other) || inside(hole[0]!, other) || inside(other[0]!, hole)) invalid("Polygon holes must not intersect, touch or contain each other.");
    }
  }
}

/**
 * Prepare actual native CPU meshes, not Viewer attachments. Every part keeps
 * pickId; its array index is the part index. A failure rejects the whole input.
 * The supported interior is bounded in one forward radial chart per Polygon;
 * multipart union/overlap analysis and arbitrary global topology are not provided.
 */
export function prepareSphericalPolygons(geometry: unknown, pickId: unknown): GeometryInstance[] {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) invalid("A GeoJSON Polygon or MultiPolygon geometry is required.");
  const value = geometry as { type?: unknown; coordinates?: unknown };
  if (value.type !== "Polygon" && value.type !== "MultiPolygon") unsupported("Only Polygon and MultiPolygon geometry is supported here.");
  if (!Array.isArray(value.coordinates) || value.coordinates.length === 0) invalid("A polygon geometry must contain at least one exterior ring.");
  const parts = value.type === "Polygon" ? [value.coordinates] : value.coordinates;
  if (parts.length > POLYGON_SOURCE_POSITIONS / 4) unsupported("The polygon exceeds the part budget.");
  let sourceCount = 0;
  const parsed: Ring[][] = Array.from(parts, part => {
    if (!Array.isArray(part) || part.length === 0) invalid("Every polygon part needs an exterior ring.");
    if (part.length > POLYGON_SOURCE_POSITIONS / 4) unsupported("The polygon exceeds the ring budget.");
    return Array.from(part, (ring: unknown) => {
      if (!Array.isArray(ring) || ring.length < 4) invalid("A polygon ring must contain three vertices and an explicit closure.");
      sourceCount += ring.length;
      if (sourceCount > POLYGON_SOURCE_POSITIONS) unsupported("The polygon exceeds the source position budget.");
      const positions = Array.from(ring, readPosition).map(cartesian);
      if (Cartesian3.angleBetween(positions[0]!, positions[positions.length - 1]!) > PREDICATE_EPSILON) invalid("A polygon ring must be explicitly closed.");
      positions.pop();
      for (let i = 0; i < positions.length; i++) {
        if (Cartesian3.angleBetween(positions[i]!, positions[(i + 1) % positions.length]!) <= PREDICATE_EPSILON) invalid("A polygon ring contains a zero-length edge.");
      }
      return positions;
    });
  });
  // Validate all parts before asking Cesium to triangulate any of them. Native
  // earcut completion alone is not validation: Cesium can skip invalid holes.
  parsed.forEach(validateTopology);
  let outputCount = 0;
  return parsed.map(rings => {
    const hierarchy = new PolygonHierarchy(rings[0]!, rings.slice(1).map(hole => new PolygonHierarchy(hole)));
    const mesh = PolygonGeometry.createGeometry(new PolygonGeometry({
      polygonHierarchy: hierarchy, ellipsoid: SPHERICAL_EARTH, height: 0,
      arcType: ArcType.GEODESIC, granularity: STEP,
      vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
    }));
    if (!mesh || !mesh.indices?.length || !mesh.attributes.position?.values.length) invalid("Cesium could not produce a nonempty polygon mesh.");
    outputCount += mesh.attributes.position.values.length / 3;
    // This is a post-computation attachment guard, not cancellation of native CPU work.
    if (outputCount > POLYGON_OUTPUT_POSITIONS) unsupported("The native polygon mesh exceeds the output position budget.");
    return new GeometryInstance({ id: pickId, geometry: mesh });
  });
}
