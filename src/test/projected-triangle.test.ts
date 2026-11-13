import { describe, expect, it } from "vitest";

import type { Vec3 } from "@timemachine/reconstruction-core";

import { EARTH_RADIUS_METRES } from "../../packages/cesium-runtime/src/geometry";
import { createProjection } from "../../packages/cesium-runtime/src/map-projection";
import type { MapProjection, ProjectedPoint } from "../../packages/cesium-runtime/src/map-projection";
import { clipTriangleToHemispheres } from "../../packages/cesium-runtime/src/projected-geometry";
import type { ClippedTrianglePiece } from "../../packages/cesium-runtime/src/projected-geometry";
import { projectTriangle } from "../../packages/cesium-runtime/src/projected-triangle";
import type {
  ProjectedTriangle,
  TriangleProjectionResult,
} from "../../packages/cesium-runtime/src/projected-triangle";

const R = EARTH_RADIUS_METRES;
const DEG_TO_RAD = Math.PI / 180;

/** Plate Carree half width: pi*R. */
const RECT_HALF_WIDTH = Math.PI * R;
/** Plate Carree half height: (pi/2)*R. */
const RECT_HALF_HEIGHT = (Math.PI / 2) * R;
/** Mollweide half width at the equator: 2*sqrt(2)*R. */
const MOLLWEIDE_HALF_WIDTH = 2 * Math.SQRT2 * R;
/** Mollweide half height (polar extent): sqrt(2)*R. */
const MOLLWEIDE_HALF_HEIGHT = Math.SQRT2 * R;

/** Planar slack, in metres, allowed for projection rounding. */
const PLANAR_TOLERANCE_METRES = 1e-6;
/** Angular slack, in degrees, for matching a logical longitude or latitude. */
const ANGLE_TOLERANCE = 1e-9;

function sameAngle(value: number, expected: number): boolean {
  return Math.abs(value - expected) <= ANGLE_TOLERANCE;
}

/** Unique longitudes, in degrees, of the vertices that sit at the given latitude. */
function longitudesAtLatitude(
  result: TriangleProjectionResult,
  latitudeDeg: number,
): number[] {
  return [
    ...new Set(
      result.triangles
        .flatMap((triangle) => [...triangle.vertices])
        .filter((vertex) =>
          sameAngle(vertex.y / R / DEG_TO_RAD, latitudeDeg),
        )
        .map((vertex) => Number((vertex.x / R / DEG_TO_RAD).toFixed(9))),
    ),
  ].sort((left, right) => left - right);
}

function spherePoint(longitudeDeg: number, latitudeDeg: number): Vec3 {
  const lon = longitudeDeg * DEG_TO_RAD;
  const lat = latitudeDeg * DEG_TO_RAD;
  return {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };
}

/** Rotates a direction about Z, used only to build pre-rotated test input. */
function rotateAboutZ(point: Readonly<Vec3>, degrees: number): Vec3 {
  const angle = degrees * DEG_TO_RAD;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
    z: point.z,
  };
}

function scale(point: Readonly<Vec3>, factor: number): Vec3 {
  return { x: point.x * factor, y: point.y * factor, z: point.z * factor };
}

/**
 * Independent Plate Carree forward maths, written without the production
 * module: the map is a simple degree-to-radian scaling of the Earth radius.
 */
function rectanglePoint(
  relativeLongitudeDeg: number,
  latitudeDeg: number,
): ProjectedPoint {
  return {
    x: R * (relativeLongitudeDeg * DEG_TO_RAD),
    y: R * (latitudeDeg * DEG_TO_RAD),
  };
}

/**
 * Forward projection used to build expectations. Plate Carree is re-derived
 * here; the Mollweide forward maths is not, because map-projection.test.ts
 * already controls it, so the Mollweide expectations below check the stage 3B
 * wiring (pole rule, boundary order, triangulation, area bookkeeping) rather
 * than the projection formula itself.
 */
function planarProjector(
  projection: MapProjection,
): (relativeLongitudeDeg: number, latitudeDeg: number) => ProjectedPoint {
  return projection.id === "rectangle"
    ? rectanglePoint
    : (relativeLongitudeDeg, latitudeDeg) =>
        projection.projectRelative(relativeLongitudeDeg, latitudeDeg);
}

/**
 * Independent expectation for the planar boundary of one stage 3A piece, built
 * from the stage 3B contract: a non-pole vertex projects directly, a pole
 * becomes the two neighbour-longitude edge points on Plate Carree and the
 * single convergent point on Mollweide, and the boundary order is preserved.
 */
function expectedPiecePolygon(
  piece: ClippedTrianglePiece,
  projection: MapProjection,
): ProjectedPoint[] {
  const project = planarProjector(projection);
  const vertices = piece.vertices;
  const points: ProjectedPoint[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index]!;
    if (!vertex.pole) {
      points.push(project(vertex.relativeLongitudeDeg!, vertex.latitudeDeg));
      continue;
    }
    if (projection.id === "mollweide") {
      points.push(project(0, vertex.latitudeDeg));
      continue;
    }
    const previous = vertices[(index - 1 + vertices.length) % vertices.length]!;
    const next = vertices[(index + 1) % vertices.length]!;
    points.push(project(previous.relativeLongitudeDeg!, vertex.latitudeDeg));
    points.push(project(next.relativeLongitudeDeg!, vertex.latitudeDeg));
  }
  return points;
}

/**
 * Independent signed area of a planar polygon: a centroid-shifted shoelace sum
 * scaled by R^2, so the result is dimensionless and the large map coordinates
 * cannot cancel each other away.
 */
function signedPolygonArea(points: readonly ProjectedPoint[]): number {
  let centreX = 0;
  let centreY = 0;
  for (const point of points) {
    centreX += point.x;
    centreY += point.y;
  }
  centreX /= points.length;
  centreY /= points.length;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    total +=
      (current.x - centreX) * (next.y - centreY) -
      (next.x - centreX) * (current.y - centreY);
  }
  return total / (2 * R * R);
}

function pointsMatch(first: ProjectedPoint, second: ProjectedPoint): boolean {
  return (
    Math.abs(first.x - second.x) <= PLANAR_TOLERANCE_METRES &&
    Math.abs(first.y - second.y) <= PLANAR_TOLERANCE_METRES
  );
}

/** Compares two point collections as multisets. */
function expectSamePoints(
  actual: readonly ProjectedPoint[],
  expected: readonly ProjectedPoint[],
): void {
  expect(actual).toHaveLength(expected.length);
  const unmatched = [...expected];
  for (const point of actual) {
    const index = unmatched.findIndex((candidate) =>
      pointsMatch(candidate, point),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    unmatched.splice(index, 1);
  }
  expect(unmatched).toHaveLength(0);
}

/**
 * Checks every emitted triangle of an ok result against the independent
 * expectation of the stage 3A pieces. Each piece contributes one triangle for a
 * 3-gon and two for a 4-gon, in piece order; the triangles of one piece carry
 * exactly that piece's boundary vertices, in the source orientation, and their
 * signed areas add up to the independent straight-line area of that boundary.
 * This walks every output triangle, not just the first two.
 */
function expectMatchesPieces(
  result: TriangleProjectionResult,
  pieces: readonly ClippedTrianglePiece[],
  projection: MapProjection,
): void {
  const expected = pieces.map((piece) =>
    expectedPiecePolygon(piece, projection),
  );
  const expectedCount = expected.reduce(
    (sum, polygon) => sum + (polygon.length === 3 ? 1 : 2),
    0,
  );
  expect(result.triangles).toHaveLength(expectedCount);

  let cursor = 0;
  for (const polygon of expected) {
    const count = polygon.length === 3 ? 1 : 2;
    const emitted = result.triangles.slice(cursor, cursor + count);
    cursor += count;
    expect(emitted).toHaveLength(count);
    let sum = 0;
    const covered: ProjectedPoint[] = [];
    for (const triangle of emitted) {
      for (const vertex of triangle.vertices) {
        expect(polygon.some((point) => pointsMatch(point, vertex))).toBe(true);
        covered.push(vertex);
      }
      const area = signedPolygonArea(triangle.vertices);
      expect(Math.sign(area)).toBe(result.winding);
      sum += area;
    }
    for (const point of polygon) {
      expect(covered.some((vertex) => pointsMatch(vertex, point))).toBe(true);
    }
    expect(sum).toBeCloseTo(signedPolygonArea(polygon), 9);
  }
  expect(cursor).toBe(result.triangles.length);
}

/** Checks the invariants that must hold for every triangle of an ok result. */
function expectPlanarInvariants(
  result: TriangleProjectionResult,
  projection: MapProjection,
): void {
  expect(result.status).toBe("ok");
  expect(result.triangles.length).toBeGreaterThan(0);
  for (const triangle of result.triangles) {
    for (const vertex of triangle.vertices) {
      expect(Number.isFinite(vertex.x)).toBe(true);
      expect(Number.isFinite(vertex.y)).toBe(true);
      if (projection.id === "rectangle") {
        expect(Math.abs(vertex.x)).toBeLessThanOrEqual(
          RECT_HALF_WIDTH + PLANAR_TOLERANCE_METRES,
        );
        expect(Math.abs(vertex.y)).toBeLessThanOrEqual(
          RECT_HALF_HEIGHT + PLANAR_TOLERANCE_METRES,
        );
      } else {
        // Inside the Mollweide ellipse: within the polar extent in y, and
        // within the half width the ellipse has at that y.
        expect(Math.abs(vertex.y)).toBeLessThanOrEqual(
          MOLLWEIDE_HALF_HEIGHT + PLANAR_TOLERANCE_METRES,
        );
        const ratio = vertex.y / MOLLWEIDE_HALF_HEIGHT;
        const halfWidth =
          MOLLWEIDE_HALF_WIDTH * Math.sqrt(Math.max(0, 1 - ratio * ratio));
        expect(Math.abs(vertex.x)).toBeLessThanOrEqual(
          halfWidth + PLANAR_TOLERANCE_METRES,
        );
      }
    }
    const area = signedPolygonArea(triangle.vertices);
    expect(Math.abs(area)).toBeGreaterThan(1e-14);
    expect(Math.sign(area)).toBe(result.winding);
  }
}

function totalSignedArea(result: TriangleProjectionResult): number {
  let total = 0;
  for (const triangle of result.triangles) {
    total += signedPolygonArea(triangle.vertices);
  }
  return total;
}

function sortedVertices(result: TriangleProjectionResult): ProjectedPoint[] {
  return result.triangles
    .flatMap((triangle) => [...triangle.vertices])
    .sort((left, right) => left.x - right.x || left.y - right.y);
}

/** Compares two results that describe the same geometry in equivalent frames. */
function expectEquivalentProjections(
  actual: TriangleProjectionResult,
  expected: TriangleProjectionResult,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.winding).toBe(expected.winding);
  expect(actual.triangles).toHaveLength(expected.triangles.length);
  for (const [index, triangle] of actual.triangles.entries()) {
    const mate = expected.triangles[index]!;
    expect(triangle.sourceId).toBe(mate.sourceId);
    expect(triangle.hemisphere).toBe(mate.hemisphere);
    expect(triangle.vertices).toHaveLength(mate.vertices.length);
    for (const [position, vertex] of triangle.vertices.entries()) {
      const twin = mate.vertices[position]!;
      expect(Math.abs(vertex.x - twin.x)).toBeLessThanOrEqual(
        PLANAR_TOLERANCE_METRES,
      );
      expect(Math.abs(vertex.y - twin.y)).toBeLessThanOrEqual(
        PLANAR_TOLERANCE_METRES,
      );
    }
  }
}

/**
 * Wraps the Plate Carree forward maths with a transform, so the projection
 * itself can be made to reject, collapse, reflect or fold a boundary. Only the
 * relative forward projection is wrapped.
 */
function transformedRectangle(
  transform: (
    relativeLongitudeDeg: number,
    latitudeDeg: number,
    point: ProjectedPoint,
  ) => ProjectedPoint,
): MapProjection {
  const rectangle = createProjection("rectangle");
  return {
    id: "rectangle",
    centralMeridianDeg: rectangle.centralMeridianDeg,
    project: rectangle.project,
    projectRelative(relativeLongitudeDeg, latitudeDeg) {
      return transform(
        relativeLongitudeDeg,
        latitudeDeg,
        rectangle.projectRelative(relativeLongitudeDeg, latitudeDeg),
      );
    },
    unproject: rectangle.unproject,
  };
}

function project(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
  sourceId: string | number,
  projection: MapProjection,
): TriangleProjectionResult {
  return projectTriangle(a, b, c, sourceId, projection);
}

describe("projectTriangle single-hemisphere triangles", () => {
  it("projects a triangle that never crosses the seam onto Plate Carree", () => {
    const a = spherePoint(10, 0);
    const b = spherePoint(20, 0);
    const c = spherePoint(10, 10);
    const projection = createProjection("rectangle");
    const result = project(a, b, c, "triangle", projection);

    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined();
    expect(result.winding).toBe(1);
    expect(result.triangles).toHaveLength(1);
    const [triangle] = result.triangles as [ProjectedTriangle];
    expect(triangle.sourceId).toBe("triangle");
    expect(triangle.hemisphere).toBe(1);
    // The three vertices are the Plate Carree points of the three logical
    // vertices, whatever rotation of the boundary order the clipper chose.
    expectSamePoints(triangle.vertices, [
      rectanglePoint(20, 0),
      rectanglePoint(10, 10),
      rectanglePoint(10, 0),
    ]);
    expect(signedPolygonArea(triangle.vertices)).toBeGreaterThan(0);
    expectMatchesPieces(
      result,
      clipTriangleToHemispheres(a, b, c, "triangle").pieces,
      projection,
    );
  });

  it("flips the planar orientation when the source triangle is reversed", () => {
    const a = spherePoint(10, 0);
    const b = spherePoint(20, 0);
    const c = spherePoint(10, 10);
    const projection = createProjection("rectangle");
    const forward = project(a, b, c, "triangle", projection);
    const reversed = project(a, c, b, "triangle", projection);

    expect(reversed.status).toBe("ok");
    expect(reversed.winding).toBe(-1);
    expect(totalSignedArea(reversed)).toBeCloseTo(
      -totalSignedArea(forward),
      12,
    );
    expect(sortedVertices(reversed)).toHaveLength(
      sortedVertices(forward).length,
    );
    for (const [index, vertex] of sortedVertices(reversed).entries()) {
      expect(pointsMatch(vertex, sortedVertices(forward)[index]!)).toBe(true);
    }
  });

  it("triangulates a cross-seam triangle into one quad and one triangle", () => {
    const a = spherePoint(170, 0);
    const b = spherePoint(-170, 0);
    const c = spherePoint(175, 10);
    const projection = createProjection("rectangle");
    const result = project(a, b, c, "cross-seam", projection);

    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(3);
    expect(result.winding).toBe(1);
    const eastern = result.triangles.filter(
      (triangle) => triangle.hemisphere === 1,
    );
    const western = result.triangles.filter(
      (triangle) => triangle.hemisphere === -1,
    );
    expect(eastern).toHaveLength(2);
    expect(western).toHaveLength(1);
    for (const triangle of result.triangles) {
      expect(triangle.sourceId).toBe("cross-seam");
      // Neither half reaches across the map: the eastern piece stays right of
      // the central meridian, the western piece left of the antimeridian.
      for (const vertex of triangle.vertices) {
        expect(triangle.hemisphere * vertex.x).toBeGreaterThan(0);
      }
    }
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(
      result,
      clipTriangleToHemispheres(a, b, c, "cross-seam").pieces,
      projection,
    );
  });

  it("keeps a whole seam edge on one map edge", () => {
    const a = spherePoint(180, -1);
    const b = spherePoint(180, 1);
    const c = spherePoint(179, 0);
    const projection = createProjection("rectangle");
    const result = project(a, b, c, "seam-edge", projection);

    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(1);
    expect(result.triangles[0]!.hemisphere).toBe(1);
    // Two of the three vertices sit on the eastern map edge.
    const onEdge = result.triangles[0]!.vertices.filter(
      (vertex) => Math.abs(vertex.x - RECT_HALF_WIDTH) <= PLANAR_TOLERANCE_METRES,
    );
    expect(onEdge).toHaveLength(2);
    expectMatchesPieces(
      result,
      clipTriangleToHemispheres(a, b, c, "seam-edge").pieces,
      projection,
    );
  });
});

describe("projectTriangle pole vertices", () => {
  const poleNorth = spherePoint(10, 80);
  const poleSouth = spherePoint(40, 80);

  it("expands a Plate Carree pole vertex into the two neighbour longitudes", () => {
    const projection = createProjection("rectangle");
    const result = project(
      poleNorth,
      poleSouth,
      spherePoint(123, 90),
      "pole",
      projection,
    );

    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(2);
    expect(result.winding).toBe(1);
    // The top edge runs from longitude 10 to longitude 40. The 123 degrees the
    // source happened to write for the pole must not appear anywhere.
    expect(longitudesAtLatitude(result, 90)).toEqual([10, 40]);
    for (const vertex of result.triangles.flatMap((triangle) => [
      ...triangle.vertices,
    ])) {
      expect(
        Math.abs(vertex.x - rectanglePoint(123, 80).x),
      ).toBeGreaterThan(1);
    }
    // The piece is the rectangle [10, 40] x [80, 90] degrees, so its planar
    // area is exactly the product of the two degree spans in radians.
    expect(totalSignedArea(result)).toBeCloseTo(
      (40 - 10) * DEG_TO_RAD * (90 - 80) * DEG_TO_RAD,
      12,
    );
    expectPlanarInvariants(result, projection);
  });

  it("converges a Mollweide pole vertex to the single polar point", () => {
    const projection = createProjection("mollweide");
    const result = project(
      poleNorth,
      poleSouth,
      spherePoint(123, 90),
      "pole",
      projection,
    );

    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(1);
    expect(result.winding).toBe(1);
    // The pole is one point on the central meridian, not a pair of edge points,
    // and the other two vertices are the two non-pole vertices.
    expectSamePoints(result.triangles[0]!.vertices, [
      projection.projectRelative(40, 80),
      { x: 0, y: MOLLWEIDE_HALF_HEIGHT },
      projection.projectRelative(10, 80),
    ]);
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(
      result,
      clipTriangleToHemispheres(
        poleNorth,
        poleSouth,
        spherePoint(123, 90),
        "pole",
      ).pieces,
      projection,
    );
  });

  it("mirrors a pole vertex to the south and keeps the winding reversed", () => {
    const south = project(
      spherePoint(10, -80),
      spherePoint(40, -80),
      spherePoint(123, -90),
      "pole",
      createProjection("rectangle"),
    );
    expect(south.status).toBe("ok");
    expect(south.triangles).toHaveLength(2);
    expect(south.winding).toBe(-1);
    expect(totalSignedArea(south)).toBeCloseTo(
      -(40 - 10) * DEG_TO_RAD * (90 - 80) * DEG_TO_RAD,
      12,
    );
    for (const vertex of south.triangles.flatMap((triangle) => [
      ...triangle.vertices,
    ])) {
      expect(vertex.y).toBeLessThan(0);
    }

    const mollweideProjection = createProjection("mollweide");
    const mollweide = project(
      spherePoint(10, -80),
      spherePoint(40, -80),
      spherePoint(123, -90),
      "pole",
      mollweideProjection,
    );
    expect(mollweide.status).toBe("ok");
    expect(mollweide.triangles).toHaveLength(1);
    // The ellipse converges on the south polar point, exactly.
    expectSamePoints(mollweide.triangles[0]!.vertices, [
      mollweideProjection.projectRelative(40, -80),
      { x: 0, y: -MOLLWEIDE_HALF_HEIGHT },
      mollweideProjection.projectRelative(10, -80),
    ]);
  });

  it("keeps the same planar coverage for a clockwise pole triangle", () => {
    const projection = createProjection("rectangle");
    const clockwise = project(
      poleSouth,
      poleNorth,
      spherePoint(123, 90),
      "pole",
      projection,
    );

    expect(clockwise.status).toBe("ok");
    expect(clockwise.triangles).toHaveLength(2);
    expect(clockwise.winding).toBe(-1);
    expect(totalSignedArea(clockwise)).toBeCloseTo(
      -(40 - 10) * DEG_TO_RAD * (90 - 80) * DEG_TO_RAD,
      12,
    );
    expect(longitudesAtLatitude(clockwise, 90)).toEqual([10, 40]);
    expectPlanarInvariants(clockwise, projection);
  });

  it("fans an interior north pole into four pieces on both maps", () => {
    const a = spherePoint(0, 89);
    const b = spherePoint(120, 89);
    const c = spherePoint(-120, 89);
    const pieces = clipTriangleToHemispheres(a, b, c, "interior").pieces;
    expect(pieces).toHaveLength(4);

    const rectangle = createProjection("rectangle");
    const flat = project(a, b, c, "interior", rectangle);
    expect(flat.status).toBe("ok");
    expect(flat.winding).toBe(1);
    // Four quads, two triangles each, and every piece keeps to its own half.
    expect(flat.triangles).toHaveLength(8);
    for (const triangle of flat.triangles) {
      expect(triangle.sourceId).toBe("interior");
      for (const vertex of triangle.vertices) {
        // A vertex may sit on the central meridian itself, which belongs to
        // both halves, but never on the far side of it.
        expect(triangle.hemisphere * vertex.x).toBeGreaterThanOrEqual(0);
        expect(vertex.y).toBeLessThanOrEqual(RECT_HALF_HEIGHT);
      }
    }
    expectPlanarInvariants(flat, rectangle);
    expectMatchesPieces(flat, pieces, rectangle);

    const mollweide = createProjection("mollweide");
    const round = project(a, b, c, "interior", mollweide);
    expect(round.status).toBe("ok");
    expect(round.triangles).toHaveLength(4);
    // Every piece converges on the one polar point of the ellipse.
    for (const triangle of round.triangles) {
      const polar = triangle.vertices.filter(
        (vertex) =>
          vertex.x === 0 &&
          Math.abs(vertex.y - MOLLWEIDE_HALF_HEIGHT) <=
            PLANAR_TOLERANCE_METRES,
      );
      expect(polar).toHaveLength(1);
    }
    expectPlanarInvariants(round, mollweide);
    expectMatchesPieces(round, pieces, mollweide);
  });

  it("mirrors an interior south pole and keeps the winding reversed", () => {
    const a = spherePoint(0, -89);
    const b = spherePoint(120, -89);
    const c = spherePoint(-120, -89);
    const pieces = clipTriangleToHemispheres(a, b, c, "interior-south").pieces;
    expect(pieces).toHaveLength(4);

    const rectangle = createProjection("rectangle");
    const flat = project(a, b, c, "interior-south", rectangle);
    expect(flat.status).toBe("ok");
    expect(flat.winding).toBe(-1);
    expect(flat.triangles).toHaveLength(8);
    for (const vertex of flat.triangles.flatMap((triangle) => [
      ...triangle.vertices,
    ])) {
      expect(vertex.y).toBeGreaterThanOrEqual(-RECT_HALF_HEIGHT);
    }
    expectPlanarInvariants(flat, rectangle);
    expectMatchesPieces(flat, pieces, rectangle);

    const mollweide = createProjection("mollweide");
    const round = project(a, b, c, "interior-south", mollweide);
    expect(round.status).toBe("ok");
    expect(round.triangles).toHaveLength(4);
    for (const triangle of round.triangles) {
      const polar = triangle.vertices.filter(
        (vertex) =>
          vertex.x === 0 &&
          Math.abs(vertex.y + MOLLWEIDE_HALF_HEIGHT) <=
            PLANAR_TOLERANCE_METRES,
      );
      expect(polar).toHaveLength(1);
    }
    expectPlanarInvariants(round, mollweide);
    expectMatchesPieces(round, pieces, mollweide);
  });

  it("splits a pole triangle at the seam into one quad per map half", () => {
    const a = spherePoint(0, 90);
    const b = spherePoint(170, 80);
    const c = spherePoint(-170, 80);
    const pieces = clipTriangleToHemispheres(a, b, c, "pole-seam").pieces;
    expect(pieces).toHaveLength(2);

    const projection = createProjection("rectangle");
    const result = project(a, b, c, "pole-seam", projection);
    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(4);
    const eastern = result.triangles.filter(
      (triangle) => triangle.hemisphere === 1,
    );
    const western = result.triangles.filter(
      (triangle) => triangle.hemisphere === -1,
    );
    expect(eastern).toHaveLength(2);
    expect(western).toHaveLength(2);
    // The eastern quad spans longitudes 170 to 180 and the western one -180 to
    // -170, both closed along the top edge at the pole.
    for (const triangle of eastern) {
      for (const vertex of triangle.vertices) {
        expect(vertex.x).toBeGreaterThanOrEqual(rectanglePoint(170, 80).x);
        expect(vertex.x).toBeLessThanOrEqual(RECT_HALF_WIDTH);
      }
    }
    for (const triangle of western) {
      for (const vertex of triangle.vertices) {
        expect(vertex.x).toBeLessThanOrEqual(rectanglePoint(-170, 80).x);
        expect(vertex.x).toBeGreaterThanOrEqual(-RECT_HALF_WIDTH);
      }
    }
    expect(longitudesAtLatitude(result, 90)).toEqual([-180, -170, 170, 180]);
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(result, pieces, projection);

    const mollweide = createProjection("mollweide");
    const round = project(a, b, c, "pole-seam", mollweide);
    expect(round.status).toBe("ok");
    expect(round.triangles).toHaveLength(2);
    for (const triangle of round.triangles) {
      const polar = triangle.vertices.filter(
        (vertex) =>
          vertex.x === 0 &&
          Math.abs(vertex.y - MOLLWEIDE_HALF_HEIGHT) <=
            PLANAR_TOLERANCE_METRES,
      );
      expect(polar).toHaveLength(1);
    }
    expectMatchesPieces(round, pieces, mollweide);
  });

  it("expands a pole whose neighbours straddle the central meridian", () => {
    const a = spherePoint(30, 80);
    const b = spherePoint(-30, 80);
    const c = spherePoint(0, 90);
    const pieces = clipTriangleToHemispheres(a, b, c, "pole-straddle").pieces;
    expect(pieces).toHaveLength(2);

    const projection = createProjection("rectangle");
    const result = project(a, b, c, "pole-straddle", projection);
    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(4);
    // Both top edges start on the central meridian and run out to 30 degrees
    // on their own side, so no quad crosses the middle of the map.
    expect(longitudesAtLatitude(result, 90)).toEqual([-30, 0, 30]);
    for (const triangle of result.triangles) {
      for (const vertex of triangle.vertices) {
        expect(triangle.hemisphere * vertex.x).toBeGreaterThanOrEqual(0);
      }
    }
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(result, pieces, projection);
  });

  it("splits a triangle whose edge runs through the pole", () => {
    const a = spherePoint(-90, 80);
    const b = spherePoint(90, 80);
    const c = spherePoint(0, 75);
    const pieces = clipTriangleToHemispheres(a, b, c, "edge-pole").pieces;
    expect(pieces).toHaveLength(2);

    const projection = createProjection("rectangle");
    const result = project(a, b, c, "edge-pole", projection);
    expect(result.status).toBe("ok");
    expect(result.winding).toBe(-1);
    expect(result.triangles).toHaveLength(4);
    for (const triangle of result.triangles) {
      for (const vertex of triangle.vertices) {
        // The vertex on the central meridian belongs to both halves; nothing
        // may cross to the far side of it.
        expect(triangle.hemisphere * vertex.x).toBeGreaterThanOrEqual(0);
      }
    }
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(result, pieces, projection);

    const mollweide = createProjection("mollweide");
    const round = project(a, b, c, "edge-pole", mollweide);
    expect(round.status).toBe("ok");
    expect(round.triangles).toHaveLength(2);
    expectMatchesPieces(round, pieces, mollweide);
  });

  it("keeps every triangle of a five-piece pole triangle", () => {
    const a = spherePoint(10, 85);
    const b = spherePoint(100, 85);
    const c = spherePoint(-100, 85);
    const pieces = clipTriangleToHemispheres(a, b, c, "pole-many").pieces;
    expect(pieces).toHaveLength(5);

    const projection = createProjection("rectangle");
    const result = project(a, b, c, "pole-many", projection);
    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(10);
    expectPlanarInvariants(result, projection);
    expectMatchesPieces(result, pieces, projection);

    const mollweide = createProjection("mollweide");
    const round = project(a, b, c, "pole-many", mollweide);
    expect(round.status).toBe("ok");
    expect(round.triangles).toHaveLength(5);
    expectPlanarInvariants(round, mollweide);
    expectMatchesPieces(round, pieces, mollweide);
  });
});

describe("projectTriangle frames, ids and inputs", () => {
  const a = spherePoint(200, 0);
  const b = spherePoint(-140, 0);
  const c = spherePoint(205, 10);

  it("treats a 30 degree central meridian like a 30 degree world turn", () => {
    for (const [turned, straight] of [
      [createProjection("rectangle", 30), createProjection("rectangle")],
      [createProjection("mollweide", 30), createProjection("mollweide")],
    ] as const) {
      const centred = project(
        rotateAboutZ(a, 30),
        rotateAboutZ(b, 30),
        rotateAboutZ(c, 30),
        7,
        turned,
      );
      const plain = project(a, b, c, 7, straight);
      expect(centred.status).toBe("ok");
      expectEquivalentProjections(centred, plain);
    }
  });

  it("keeps the source id, ignores the input radius and never mutates the input", () => {
    const projection = createProjection("rectangle");
    const snapshot = JSON.stringify([a, b, c]);
    const frozen = Object.freeze(spherePoint(10, 0));
    const plain = project(a, b, c, "huge", projection);
    const huge = project(
      scale(a, 1e200),
      scale(b, 1e200),
      scale(c, 1e200),
      "huge",
      projection,
    );
    const tiny = project(
      scale(a, 1e-200),
      scale(b, 1e-200),
      scale(c, 1e-200),
      "huge",
      projection,
    );

    expect(JSON.stringify([a, b, c])).toBe(snapshot);
    expect(Object.isFrozen(frozen)).toBe(true);
    for (const triangle of plain.triangles) {
      expect(triangle.sourceId).toBe("huge");
    }
    expectEquivalentProjections(huge, plain);
    expectEquivalentProjections(tiny, plain);
  });

  it("passes a non-ok spherical verdict through untouched", () => {
    const projection = createProjection("rectangle");
    const good = [
      spherePoint(10, 10),
      spherePoint(40, 10),
      spherePoint(20, 30),
    ] as const;

    const bad: readonly [string, Readonly<Vec3>][] = [
      ["nan", { x: Number.NaN, y: 0, z: 1 }],
      ["infinite", { x: Number.POSITIVE_INFINITY, y: 0, z: 1 }],
      ["zero", { x: 0, y: 0, z: 0 }],
    ];
    for (const [name, vertex] of bad) {
      for (const position of [0, 1, 2]) {
        const vertices: [Vec3, Vec3, Vec3] = [good[0], good[1], good[2]];
        vertices[position] = vertex;
        const result = project(
          vertices[0],
          vertices[1],
          vertices[2],
          `bad-${name}`,
          projection,
        );
        expect(result.status).toBe("invalid");
        expect(result.triangles).toHaveLength(0);
        expect(result.reason).toBeTruthy();
        expect(result.winding).toBeUndefined();
      }
    }

    const coincident = project(
      spherePoint(5, 5),
      spherePoint(5, 5),
      spherePoint(20, 20),
      "coincident",
      projection,
    );
    expect(coincident.status).toBe("degenerate");
    expect(coincident.triangles).toHaveLength(0);
    expect(coincident.reason).toBeTruthy();
    expect(coincident.winding).toBeUndefined();

    const collinear = project(
      spherePoint(0, 0),
      spherePoint(30, 0),
      spherePoint(60, 0),
      "collinear",
      projection,
    );
    expect(collinear.status).toBe("degenerate");
    expect(collinear.triangles).toHaveLength(0);

    for (const [name, vertices] of [
      ["quarter", [spherePoint(0, 0), spherePoint(90, 0), spherePoint(45, 45)]],
      ["half", [spherePoint(0, 0), spherePoint(180, 0), spherePoint(90, 0)]],
      ["wide", [spherePoint(0, 0), spherePoint(120, 0), spherePoint(-120, 0)]],
    ] as const) {
      const result = project(
        vertices[0],
        vertices[1],
        vertices[2],
        name,
        projection,
      );
      expect(result.status).toBe("unsupported");
      expect(result.triangles).toHaveLength(0);
      expect(result.reason).toBeTruthy();
      expect(result.winding).toBeUndefined();
    }
  });

  it("keeps a sliver that the y = 0 snapping flattens unsupported, not degenerate", () => {
    const thin: [Vec3, Vec3, Vec3] = [
      { x: 1, y: 0, z: 0 },
      { x: Math.cos(0.5), y: 0, z: Math.sin(0.5) },
      { x: Math.cos(0.25), y: 5e-13, z: Math.sin(0.25) },
    ];
    for (const projection of [
      createProjection("rectangle"),
      createProjection("mollweide"),
    ]) {
      const result = project(thin[0], thin[1], thin[2], "thin", projection);
      expect(result.status).toBe("unsupported");
      expect(result.status).not.toBe("degenerate");
      expect(result.triangles).toHaveLength(0);
      expect(result.winding).toBe(-1);
      expect(result.reason).toMatch(/snapping/);
    }
  });
});

describe("projectTriangle hostile projections", () => {
  const a = spherePoint(10, 80);
  const b = spherePoint(40, 80);
  const pole = spherePoint(123, 90);

  it("reports a projection that rejects a non-pole vertex", () => {
    const rejecting = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) => {
        if (sameAngle(latitudeDeg, 80)) {
          throw new RangeError("hostile projection rejected the vertex");
        }
        return point;
      },
    );
    const result = project(a, b, pole, "reject", rejecting);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.winding).toBe(1);
    expect(result.reason).toBeTruthy();
  });

  it("reports a projection that rejects the pole expansion", () => {
    const rejecting = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) => {
        if (sameAngle(latitudeDeg, 90)) {
          throw new RangeError("hostile projection rejected the pole edge");
        }
        return point;
      },
    );
    const result = project(a, b, pole, "reject-pole", rejecting);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("reports a projection that returns a non-finite point", () => {
    const nonFinite = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) =>
        sameAngle(latitudeDeg, 90)
          ? { x: Number.NaN, y: 0 }
          : point,
    );
    const result = project(a, b, pole, "non-finite", nonFinite);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("reports a projection that collapses the piece to a point", () => {
    const collapsing = transformedRectangle(() => ({ x: 0, y: 0 }));
    const result = project(a, b, pole, "collapse", collapsing);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.winding).toBe(1);
    expect(result.reason).toMatch(/simplified to/);
  });

  it("reports a projection that reflects the piece away from the source winding", () => {
    const reflecting = transformedRectangle((relativeLongitudeDeg, latitudeDeg, point) => ({
      x: -point.x,
      y: point.y,
    }));
    const result = project(a, b, pole, "reflect", reflecting);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("reports a projection that folds the boundary over itself", () => {
    // Swaps the two lower corners of the quad so its boundary crosses itself.
    const folding = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) => {
        if (!sameAngle(latitudeDeg, 80)) {
          return point;
        }
        return rectanglePoint(
          sameAngle(relativeLongitudeDeg, 40) ? 10 : 40,
          85,
        );
      },
    );
    const result = project(a, b, pole, "fold", folding);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("keeps a nearly collinear vertex the exact predicate does not certify", () => {
    const lowerLeft = rectanglePoint(10, 80);
    const topLeft = rectanglePoint(40, 90);
    const topRight = rectanglePoint(10, 90);
    // Moves the lower right corner to the midpoint of the line between its two
    // neighbours. In floating point that midpoint is a few nanometres off the
    // exact line, so it is a real vertex and the quad is really a quad: the
    // boundary is triangulated, not simplified, and the area is unchanged
    // either way.
    const moved = {
      x: (lowerLeft.x + topLeft.x) / 2,
      y: (lowerLeft.y + topLeft.y) / 2,
    };
    const collinear = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) =>
        sameAngle(latitudeDeg, 80) && sameAngle(relativeLongitudeDeg, 40)
          ? moved
          : point,
    );
    const result = project(a, b, pole, "collinear", collinear);

    expect(result.status).toBe("ok");
    expect(result.triangles).toHaveLength(2);
    expect(result.winding).toBe(1);
    const vertices = result.triangles.flatMap((triangle) => [
      ...triangle.vertices,
    ]);
    expect(vertices).toHaveLength(6);
    // The moved corner survives as a real vertex, and every corner of the quad
    // is still covered by the two triangles.
    for (const corner of [moved, topLeft, topRight, lowerLeft]) {
      expect(
        vertices.filter((vertex) => pointsMatch(vertex, corner)).length,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(totalSignedArea(result)).toBeCloseTo(
      signedPolygonArea([topLeft, topRight, lowerLeft]),
      12,
    );
  });

  it("refuses a projection id that has no vertex rule in this stage", () => {
    const mercator = {
      ...createProjection("rectangle"),
      id: "mercator",
    } as unknown as MapProjection;
    const result = project(a, b, pole, "mercator", mercator);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.reason).toMatch(/mercator/);
  });
});

describe("projectTriangle straightened area", () => {
  it("does not claim the straightened boundary area equals the spherical area", () => {
    // A continuous equal-area projection conserves area in the limit, but a
    // handful of vertices joined by straight lines does not: the chords cut
    // inside the curved edges, so the planar area stays measurably below the
    // spherical area. The code must not bend coordinates to hide that.
    const a = spherePoint(0, 0);
    const b = spherePoint(60, 0);
    const c = spherePoint(30, 60);

    const spherical = ((): number => {
      const dot = (left: Readonly<Vec3>, right: Readonly<Vec3>): number =>
        left.x * right.x + left.y * right.y + left.z * right.z;
      const cross = (left: Readonly<Vec3>, right: Readonly<Vec3>): Vec3 => ({
        x: left.y * right.z - left.z * right.y,
        y: left.z * right.x - left.x * right.z,
        z: left.x * right.y - left.y * right.x,
      });
      const determinant = dot(
        a,
        cross(
          { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
          { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z },
        ),
      );
      return (
        2 *
        Math.atan2(
          determinant,
          1 + dot(a, b) + dot(b, c) + dot(c, a),
        )
      );
    })();

    for (const projection of [
      createProjection("rectangle"),
      createProjection("mollweide"),
    ]) {
      const result = project(a, b, c, "coarse", projection);
      expect(result.status).toBe("ok");
      expect(result.triangles).toHaveLength(1);
      const planar = totalSignedArea(result);
      expect(planar).toBeGreaterThan(0);
      expect(planar).toBeLessThan(spherical);
      expect(planar).toBeGreaterThan(spherical * 0.5);
      // What the planar total does equal is the straight-line area of the
      // independently projected boundary.
      const pieces = clipTriangleToHemispheres(a, b, c, "coarse").pieces;
      const boundary = pieces.flatMap((piece) =>
        expectedPiecePolygon(piece, projection),
      );
      expect(planar).toBeCloseTo(signedPolygonArea(boundary), 9);
    }
  });
});

describe("projectTriangle output invariants", () => {
  const sources: readonly (readonly [string, Vec3, Vec3, Vec3])[] = [
    ["plain", spherePoint(10, 0), spherePoint(20, 0), spherePoint(10, 10)],
    [
      "cross-seam",
      spherePoint(170, 0),
      spherePoint(-170, 0),
      spherePoint(175, 10),
    ],
    [
      "pole",
      spherePoint(10, 80),
      spherePoint(40, 80),
      spherePoint(123, 90),
    ],
    [
      "interior-pole",
      spherePoint(0, 89),
      spherePoint(120, 89),
      spherePoint(-120, 89),
    ],
    [
      "interior-south-pole",
      spherePoint(0, -89),
      spherePoint(120, -89),
      spherePoint(-120, -89),
    ],
    [
      "pole-seam",
      spherePoint(0, 90),
      spherePoint(170, 80),
      spherePoint(-170, 80),
    ],
    [
      "pole-straddle",
      spherePoint(30, 80),
      spherePoint(-30, 80),
      spherePoint(0, 90),
    ],
    [
      "edge-through-pole",
      spherePoint(-90, 80),
      spherePoint(90, 80),
      spherePoint(0, 75),
    ],
    [
      "pole-many-pieces",
      spherePoint(10, 85),
      spherePoint(100, 85),
      spherePoint(-100, 85),
    ],
    [
      "seam-edge",
      spherePoint(180, -1),
      spherePoint(180, 1),
      spherePoint(179, 0),
    ],
    [
      "seam-triangle",
      spherePoint(179, 5),
      spherePoint(-179, 5),
      spherePoint(180, 20),
    ],
    ["coarse", spherePoint(0, 0), spherePoint(60, 0), spherePoint(30, 60)],
  ];

  it("keeps every triangle of every supported projection in domain and orientation", () => {
    for (const [name, a, b, c] of sources) {
      for (const projection of [
        createProjection("rectangle"),
        createProjection("mollweide"),
      ]) {
        const result = project(a, b, c, name, projection);
        expect(result.status).toBe("ok");
        expectPlanarInvariants(result, projection);
        expectMatchesPieces(
          result,
          clipTriangleToHemispheres(a, b, c, name).pieces,
          projection,
        );
      }
    }
  });
});

/**
 * Plate Carree wrapper that answers every vertex of the pole piece with a
 * fixed point, so a test can place the planar boundary exactly where it wants
 * it: a two metre square, a bowtie, an exact midpoint. The vertex set is the
 * one the rectangle pole rule asks for, in boundary order.
 */
function mappedPoleProjection(
  lowerRight: ProjectedPoint,
  upperRight: ProjectedPoint,
  upperLeft: ProjectedPoint,
  lowerLeft: ProjectedPoint,
): MapProjection {
  const rectangle = createProjection("rectangle");
  const vertices: readonly (readonly [number, number, ProjectedPoint])[] = [
    [40, 80, lowerRight],
    [40, 90, upperRight],
    [10, 90, upperLeft],
    [10, 80, lowerLeft],
  ];
  return {
    id: "rectangle",
    centralMeridianDeg: rectangle.centralMeridianDeg,
    project: rectangle.project,
    projectRelative(relativeLongitudeDeg, latitudeDeg) {
      for (const [longitude, latitude, point] of vertices) {
        if (
          Math.abs(relativeLongitudeDeg - longitude) <= ANGLE_TOLERANCE &&
          Math.abs(latitudeDeg - latitude) <= ANGLE_TOLERANCE
        ) {
          return point;
        }
      }
      throw new Error(
        `unexpected pole piece vertex ${relativeLongitudeDeg}, ${latitudeDeg}`,
      );
    },
    unproject: rectangle.unproject,
  };
}

/** Asserts two dimensionless areas agree to a strict relative error. */
function expectSameArea(actual: number, expected: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-12);
}

describe("projectTriangle exact planar predicates", () => {
  const poleInputs: readonly [Vec3, Vec3, Vec3] = [
    spherePoint(10, 80),
    spherePoint(40, 80),
    spherePoint(123, 90),
  ];

  it("keeps the area of a seam triangle only a few metres wide", () => {
    for (const delta of [2e-5, 1e-5]) {
      const logical: readonly Vec3[] = [
        spherePoint(180 - delta, 0),
        spherePoint(-180 + delta, 0),
        spherePoint(180 - delta / 2, delta),
      ];
      for (const center of [0, 30]) {
        const inputs = logical.map((vertex) => rotateAboutZ(vertex, center));
        for (const projection of [
          createProjection("rectangle", center),
          createProjection("mollweide", center),
        ]) {
          const name = `micro-${delta}-${projection.id}-${center}`;
          const [first, second, third] = inputs;
          const result = project(first!, second!, third!, name, projection);
          // The seam half is a quad and the far half a triangle, so three
          // triangles: the quad keeps both of its seam vertices.
          expect(result.status).toBe("ok");
          expect(result.triangles).toHaveLength(3);
          const pieces = clipTriangleToHemispheres(
            first!,
            second!,
            third!,
            name,
            projection.centralMeridianDeg,
          ).pieces;
          const actualByHemisphere = new Map<number, number>();
          for (const triangle of result.triangles) {
            actualByHemisphere.set(
              triangle.hemisphere,
              (actualByHemisphere.get(triangle.hemisphere) ?? 0) +
                signedPolygonArea(triangle.vertices),
            );
          }
          for (const piece of pieces) {
            const expected = signedPolygonArea(
              expectedPiecePolygon(piece, projection),
            );
            const actual = actualByHemisphere.get(piece.hemisphere);
            expect(actual).toBeDefined();
            // A relative error, never toBeCloseTo: a piece this small has an
            // area near 1e-13, which a nine-digit absolute tolerance passes
            // whatever the answer.
            expectSameArea(actual!, expected);
          }
          expectMatchesPieces(result, pieces, projection);
          expectPlanarInvariants(result, projection);
        }
      }
    }
  });

  it("keeps a two metre square and a hundred kilometre square whole", () => {
    for (const side of [2, 1e5]) {
      const square = mappedPoleProjection(
        { x: side, y: 0 },
        { x: side, y: side },
        { x: 0, y: side },
        { x: 0, y: 0 },
      );
      const result = project(
        poleInputs[0],
        poleInputs[1],
        poleInputs[2],
        `square-${side}`,
        square,
      );

      expect(result.status).toBe("ok");
      expect(result.triangles).toHaveLength(2);
      // The corner cross product of a two metre square is four square metres,
      // far below the forty square metres a scaled cross-product tolerance
      // used to call collinear, so the square used to lose half its area.
      expectSameArea(totalSignedArea(result), (side * side) / (R * R));
      expectPlanarInvariants(result, square);
    }
  });

  it("keeps the same shape under a two times ten to the seven metre translation", () => {
    const offset = 2e7;
    const plain = mappedPoleProjection(
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 },
    );
    const shifted = mappedPoleProjection(
      { x: offset + 2, y: offset },
      { x: offset + 2, y: offset + 2 },
      { x: offset, y: offset + 2 },
      { x: offset, y: offset },
    );
    const straight = project(poleInputs[0], poleInputs[1], poleInputs[2], "square", plain);
    const turned = project(
      poleInputs[0],
      poleInputs[1],
      poleInputs[2],
      "square",
      shifted,
    );

    expect(turned.status).toBe("ok");
    expect(turned.triangles).toHaveLength(straight.triangles.length);
    for (const [index, triangle] of turned.triangles.entries()) {
      const mate = straight.triangles[index]!;
      expect(triangle.hemisphere).toBe(mate.hemisphere);
      for (const [position, vertex] of triangle.vertices.entries()) {
        const twin = mate.vertices[position]!;
        // The whole boundary moved by one offset, vertex for vertex, and the
        // area is unchanged: the predicates decide on exact coordinates, so a
        // large translation cannot turn a corner into a collinear point.
        expect(vertex.x - twin.x).toBeCloseTo(offset, 6);
        expect(vertex.y - twin.y).toBeCloseTo(offset, 6);
      }
    }
    expectSameArea(totalSignedArea(turned), totalSignedArea(straight));
  });

  it("drops a middle vertex that is exactly collinear with its neighbours", () => {
    // Each entry is the pole piece's four corners in boundary order, followed
    // by the triangle that survives once the redundant middle is dropped. The
    // surviving triangle keeps the whole boundary, so its area is the area of
    // the original quad: nothing may be lost by the simplification.
    type Placement = readonly [
      string,
      ProjectedPoint,
      ProjectedPoint,
      ProjectedPoint,
      ProjectedPoint,
      readonly [ProjectedPoint, ProjectedPoint, ProjectedPoint],
    ];
    const placements: readonly Placement[] = [
      [
        "axial",
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 0, y: 10 },
        ],
      ],
      [
        "diagonal",
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      ],
      [
        // Mixed signs: the first three corners are collinear on a line of
        // slope one, and the quad reaches into both half planes.
        "mixed-signs",
        { x: -5, y: 0 },
        { x: 0, y: 5 },
        { x: 5, y: 10 },
        { x: -5, y: 10 },
        [
          { x: -5, y: 0 },
          { x: 5, y: 10 },
          { x: -5, y: 10 },
        ],
      ],
      [
        // A negative zero first corner: -0 and 0 are the same coordinate but
        // not the same bits, and the decoder must not scale one of them.
        "negative-zero",
        { x: -0, y: 0 },
        { x: 0, y: 5 },
        { x: 0, y: 10 },
        { x: -5, y: 0 },
        [
          { x: -0, y: 0 },
          { x: 0, y: 10 },
          { x: -5, y: 0 },
        ],
      ],
      [
        // A negative subnormal corner: the smallest possible magnitude, which
        // a decoder that treats every non-zero exponent word as a normal would
        // inflate into a huge value.
        "negative-subnormal",
        { x: -Number.MIN_VALUE, y: -5 },
        { x: 0, y: 0 },
        { x: Number.MIN_VALUE, y: 5 },
        { x: -5, y: 5 },
        [
          { x: -Number.MIN_VALUE, y: -5 },
          { x: Number.MIN_VALUE, y: 5 },
          { x: -5, y: 5 },
        ],
      ],
      [
        // A mixed negative slope, and the redundant middle is not the first
        // corner of the boundary.
        "mixed-negative-slope",
        { x: -2, y: 2 },
        { x: 0, y: 0 },
        { x: 2, y: -2 },
        { x: 4, y: 4 },
        [
          { x: -2, y: 2 },
          { x: 2, y: -2 },
          { x: 4, y: 4 },
        ],
      ],
      [
        // The same shape mirrored and walked the other way round, so the
        // boundary still runs counter-clockwise like the source winding.
        "mirrored",
        { x: 4, y: -4 },
        { x: 2, y: 2 },
        { x: 0, y: 0 },
        { x: -2, y: -2 },
        [
          { x: 4, y: -4 },
          { x: 2, y: 2 },
          { x: -2, y: -2 },
        ],
      ],
    ];
    for (const [name, lowerRight, upperRight, upperLeft, lowerLeft, expected] of
      placements) {
      const projection = mappedPoleProjection(
        lowerRight,
        upperRight,
        upperLeft,
        lowerLeft,
      );
      const result = project(
        poleInputs[0],
        poleInputs[1],
        poleInputs[2],
        name,
        projection,
      );

      expect(result.status).toBe("ok");
      expect(result.triangles).toHaveLength(1);
      expectSamePoints(result.triangles[0]!.vertices, expected);
      expectSameArea(
        signedPolygonArea(result.triangles[0]!.vertices),
        signedPolygonArea(expected),
      );
      // Every one of these quads has real area in the source orientation, so
      // the surviving triangle must carry it, not a fraction of it.
      expect(Math.abs(signedPolygonArea(expected))).toBeGreaterThan(0);
    }
  });

  it("rejects a boundary that doubles back on itself", () => {
    const folds: readonly (readonly [
      string,
      ProjectedPoint,
      ProjectedPoint,
      ProjectedPoint,
      ProjectedPoint,
    ])[] = [
      // A-B-A: the first and the third corner are the same point.
      ["spike", { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 2 }],
      // The third corner doubles back inside the first edge.
      [
        "fold-back",
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 0 },
        { x: 0, y: 10 },
      ],
    ];
    for (const [name, lowerRight, upperRight, upperLeft, lowerLeft] of folds) {
      const projection = mappedPoleProjection(
        lowerRight,
        upperRight,
        upperLeft,
        lowerLeft,
      );
      const result = project(
        poleInputs[0],
        poleInputs[1],
        poleInputs[2],
        name,
        projection,
      );

      expect(result.status).toBe("unsupported");
      expect(result.triangles).toHaveLength(0);
      expect(result.winding).toBe(1);
      expect(result.reason).toBeTruthy();
    }
  });

  it("rejects a bowtie instead of deleting one of its corners", () => {
    // The hostile mapping the independent runner uses: the boundary crosses
    // itself, which used to be hidden by dropping a corner whose cross product
    // sat below the old tolerance.
    const bowtie = mappedPoleProjection(
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 2, y: 0 },
    );
    const result = project(
      poleInputs[0],
      poleInputs[1],
      poleInputs[2],
      "bowtie",
      bowtie,
    );

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.winding).toBe(1);
    expect(result.reason).toBeTruthy();
  });

  it("reports a failing piece without emitting the pieces that succeeded", () => {
    const a = spherePoint(170, 0);
    const b = spherePoint(-170, 0);
    const c = spherePoint(175, 10);
    // The eastern piece is projected first and succeeds; the western one, whose
    // vertices all sit west of -100 degrees, is then rejected.
    const rejecting = transformedRectangle(
      (relativeLongitudeDeg, latitudeDeg, point) => {
        if (relativeLongitudeDeg < -100) {
          throw new RangeError("hostile projection rejected the western piece");
        }
        return point;
      },
    );
    const result = project(a, b, c, "partial", rejecting);

    expect(result.status).toBe("unsupported");
    expect(result.triangles).toHaveLength(0);
    expect(result.winding).toBe(1);
    expect(result.reason).toBeTruthy();
  });
});
