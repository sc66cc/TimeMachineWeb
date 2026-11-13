import { describe, expect, it } from "vitest";

import type { Vec3 } from "@timemachine/reconstruction-core";

import { clipTriangleToHemispheres } from "../../packages/cesium-runtime/src/projected-geometry";
import type {
  ClippedTrianglePiece,
  TriangleClipResult,
} from "../../packages/cesium-runtime/src/projected-geometry";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Angular tolerance used for the unit-vector and hemisphere invariants. */
const UNIT_TOLERANCE = 1e-12;
/** Tolerance for comparing longitudes/latitudes across equivalent calls. */
const ANGLE_TOLERANCE = 1e-9;

/**
 * Independent analytic area of a spherical equilateral triangle whose edges
 * span 60 degrees: three angles of acos(1/3) minus pi.
 */
const EQUILATERAL_AREA = 3 * Math.acos(1 / 3) - Math.PI;

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
function rotateAboutZ(point: Vec3, degrees: number): Vec3 {
  const angle = degrees * DEG_TO_RAD;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
    z: point.z,
  };
}

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function subtract(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(point: Readonly<Vec3>, factor: number): Vec3 {
  return { x: point.x * factor, y: point.y * factor, z: point.z * factor };
}

/**
 * Signed spherical area of one triangle, computed here independently of the
 * production module so that area conservation is not self-certified.
 */
function triangleArea(a: Readonly<Vec3>, b: Readonly<Vec3>, c: Readonly<Vec3>): number {
  const determinant = dot(a, cross(subtract(b, a), subtract(c, a)));
  return (
    2 *
    Math.atan2(
      determinant,
      1 + dot(a, b) + dot(b, c) + dot(c, a),
    )
  );
}

/** Signed spherical area of a convex spherical polygon, fanned from vertex 0. */
function polygonArea(vertices: readonly Vec3[]): number {
  let total = 0;
  for (let index = 1; index + 1 < vertices.length; index += 1) {
    total += triangleArea(
      vertices[0]!,
      vertices[index]!,
      vertices[index + 1]!,
    );
  }
  return total;
}

function directionsOf(piece: ClippedTrianglePiece): Vec3[] {
  return piece.vertices.map((vertex) => vertex.direction);
}

/**
 * Latitude at which the great circle through (lon1, lat1) and (lon2, lat2)
 * crosses the given meridian, from the standard great-circle relation. Used as
 * an independent control for the seam crossings.
 */
function crossingLatitudeDeg(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
  atLonDeg: number,
): number {
  const tangent =
    (Math.tan(lat2 * DEG_TO_RAD) * Math.sin((atLonDeg - lon1) * DEG_TO_RAD) -
      Math.tan(lat1 * DEG_TO_RAD) * Math.sin((atLonDeg - lon2) * DEG_TO_RAD)) /
    Math.sin((lon2 - lon1) * DEG_TO_RAD);
  return Math.atan(tangent) * RAD_TO_DEG;
}

function containsFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function expectNoNonFinite(result: TriangleClipResult): void {
  const scan = (value: unknown): void => {
    if (typeof value === "number") {
      expect(Number.isFinite(value)).toBe(true);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      scan(nested);
    }
  };
  scan(result);
}

/**
 * Checks the invariants that must hold for every piece of every ok result:
 * unit finite directions, the piece inside its own hemisphere, a longitude in
 * that half of the map, and the source winding preserved.
 */
function expectPieceInvariants(
  result: TriangleClipResult,
  sourceArea: number,
): void {
  expect(result.status).toBe("ok");
  expect(result.pieces.length).toBeGreaterThan(0);
  let total = 0;
  for (const piece of result.pieces) {
    expect(piece.vertices.length).toBeGreaterThanOrEqual(3);
    expect(piece.vertices.length).toBeLessThanOrEqual(4);
    for (const vertex of piece.vertices) {
      const { direction } = vertex;
      expect(containsFiniteNumber(direction.x)).toBe(true);
      expect(containsFiniteNumber(direction.y)).toBe(true);
      expect(containsFiniteNumber(direction.z)).toBe(true);
      const length = Math.hypot(direction.x, direction.y, direction.z);
      expect(Math.abs(length - 1)).toBeLessThanOrEqual(UNIT_TOLERANCE);
      // The piece never strays into the other half of the y = 0 great circle.
      expect(piece.hemisphere * direction.y).toBeGreaterThanOrEqual(-UNIT_TOLERANCE);
      expect(containsFiniteNumber(vertex.latitudeDeg)).toBe(true);
      if (vertex.pole) {
        expect(vertex.relativeLongitudeDeg).toBeNull();
        expect(vertex.seamSide).toBe(0);
        expect(Math.abs(Math.abs(vertex.latitudeDeg) - 90)).toBeLessThanOrEqual(
          UNIT_TOLERANCE,
        );
      } else {
        expect(containsFiniteNumber(vertex.relativeLongitudeDeg)).toBe(true);
        const longitude = vertex.relativeLongitudeDeg as number;
        if (piece.hemisphere === 1) {
          expect(longitude).toBeGreaterThanOrEqual(-ANGLE_TOLERANCE);
          expect(longitude).toBeLessThanOrEqual(180 + ANGLE_TOLERANCE);
        } else {
          expect(longitude).toBeLessThanOrEqual(ANGLE_TOLERANCE);
          expect(longitude).toBeGreaterThanOrEqual(-180 - ANGLE_TOLERANCE);
        }
        if (vertex.seamSide !== 0) {
          expect(vertex.seamSide).toBe(piece.hemisphere);
          expect(longitude).toBeCloseTo(piece.hemisphere * 180, 9);
        }
      }
    }
    const area = polygonArea(directionsOf(piece));
    expect(Math.sign(area)).toBe(result.winding);
    total += area;
  }
  expect(Math.abs(total - sourceArea)).toBeLessThanOrEqual(
    1e-12 + 1e-9 * Math.abs(sourceArea),
  );
}

function clip(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
  sourceId: string | number = "triangle",
  centralMeridianDeg = 0,
): TriangleClipResult {
  return clipTriangleToHemispheres(a, b, c, sourceId, centralMeridianDeg);
}

function unitTriangle(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
): [Vec3, Vec3, Vec3] {
  const normalise = (point: Readonly<Vec3>): Vec3 => {
    const largest = Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
    const scaled = scale(point, 1 / largest);
    const length = Math.hypot(scaled.x, scaled.y, scaled.z);
    return scale(scaled, 1 / length);
  };
  return [normalise(a), normalise(b), normalise(c)];
}

function sourceAreaOf(
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
  centralMeridianDeg = 0,
): number {
  const [ua, ub, uc] = unitTriangle(
    rotateAboutZ(a, centralMeridianDeg),
    rotateAboutZ(b, centralMeridianDeg),
    rotateAboutZ(c, centralMeridianDeg),
  );
  return triangleArea(ua, ub, uc);
}

describe("clipTriangleToHemispheres single-hemisphere triangles", () => {
  it("keeps a triangle that never crosses the y = 0 great circle whole", () => {
    const result = clip(spherePoint(10, 10), spherePoint(40, 10), spherePoint(20, 30));

    expect(result.status).toBe("ok");
    expect(result.reason).toBeUndefined();
    expect(result.winding).toBe(1);
    expect(result.pieces).toHaveLength(1);
    const only = result.pieces[0]!;
    expect(only.sourceId).toBe("triangle");
    expect(only.hemisphere).toBe(1);
    expect(only.vertices).toHaveLength(3);
    for (const vertex of only.vertices) {
      expect(vertex.pole).toBe(false);
      expect(vertex.seamSide).toBe(0);
    }
    const longitudes = only.vertices.map((vertex) => vertex.relativeLongitudeDeg);
    expect(longitudes).toHaveLength(3);
    expect(longitudes[0]).toBeCloseTo(40, 9);
    expect(longitudes[1]).toBeCloseTo(20, 9);
    expect(longitudes[2]).toBeCloseTo(10, 9);
    expectPieceInvariants(
      result,
      sourceAreaOf(spherePoint(10, 10), spherePoint(40, 10), spherePoint(20, 30)),
    );
  });

  it("splits a cross-seam triangle into one piece per hemisphere", () => {
    const a = spherePoint(170, 0);
    const b = spherePoint(-170, 0);
    const c = spherePoint(175, 10);
    const result = clip(a, b, c);

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(2);
    const north = result.pieces[0]!;
    const south = result.pieces[1]!;
    expect(north.hemisphere).toBe(1);
    expect(south.hemisphere).toBe(-1);
    expect(north.vertices).toHaveLength(4);
    expect(south.vertices).toHaveLength(3);

    // Both copies of every cut share the spherical position of the short arc;
    // only the seam longitude differs.
    const seamOf = (piece: ClippedTrianglePiece): Vec3[] =>
      piece.vertices
        .filter((vertex) => vertex.seamSide !== 0)
        .map((vertex) => vertex.direction);
    const northSeam = seamOf(north);
    const southSeam = seamOf(south);
    expect(northSeam).toHaveLength(2);
    expect(southSeam).toHaveLength(2);
    for (const direction of northSeam) {
      expect(
        southSeam.some(
          (other) =>
            Math.abs(other.x - direction.x) < UNIT_TOLERANCE &&
            Math.abs(other.y - direction.y) < UNIT_TOLERANCE &&
            Math.abs(other.z - direction.z) < UNIT_TOLERANCE,
        ),
      ).toBe(true);
    }
    for (const vertex of north.vertices) {
      if (vertex.seamSide !== 0) {
        expect(vertex.relativeLongitudeDeg).toBe(180);
        expect(vertex.seamSide).toBe(1);
      }
    }
    for (const vertex of south.vertices) {
      if (vertex.seamSide !== 0) {
        expect(vertex.relativeLongitudeDeg).toBe(-180);
        expect(vertex.seamSide).toBe(-1);
      }
    }

    // Independent analytic control for the two seam crossings.
    const latitudes = north.vertices
      .filter((vertex) => vertex.seamSide !== 0)
      .map((vertex) => vertex.latitudeDeg)
      .sort((left, right) => left - right);
    expect(latitudes[0]).toBeCloseTo(0, 9);
    expect(latitudes[1]).toBeCloseTo(
      crossingLatitudeDeg(-170, 0, 175, 10, 180),
      9,
    );
    expectPieceInvariants(result, sourceAreaOf(a, b, c));
  });

  it("gives no wrong-side sliver for a triangle with a whole seam edge", () => {
    const result = clip(spherePoint(180, -1), spherePoint(180, 1), spherePoint(179, 0));

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(1);
    const only = result.pieces[0]!;
    expect(only.hemisphere).toBe(1);
    expect(only.vertices).toHaveLength(3);
    expectPieceInvariants(
      result,
      sourceAreaOf(spherePoint(180, -1), spherePoint(180, 1), spherePoint(179, 0)),
    );
  });

  it("assigns a seam vertex only to the hemisphere that owns it", () => {
    // The seam vertex sits on the y = 0 great circle, so it is inside for both
    // hemispheres; only the southern one has any area here.
    const a = spherePoint(180, 0);
    const b = spherePoint(-170, 0);
    const c = spherePoint(-175, 10);
    const result = clip(a, b, c);

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(1);
    const only = result.pieces[0]!;
    expect(only.hemisphere).toBe(-1);
    const seam = only.vertices.filter((vertex) => vertex.seamSide !== 0);
    expect(seam).toHaveLength(1);
    expect(seam[0]!.relativeLongitudeDeg).toBe(-180);
    expect(seam[0]!.seamSide).toBe(-1);
    expectPieceInvariants(result, sourceAreaOf(a, b, c));
  });
});

describe("clipTriangleToHemispheres pole pre-split", () => {
  it("keeps an input pole vertex and ignores its written longitude", () => {
    const a = spherePoint(10, 80);
    const b = spherePoint(40, 80);
    const withLongitude = clip(a, b, spherePoint(123, 90));
    const withOtherLongitude = clip(a, b, spherePoint(-77, 90));

    for (const result of [withLongitude, withOtherLongitude]) {
      expect(result.status).toBe("ok");
      expect(result.pieces).toHaveLength(1);
      const only = result.pieces[0]!;
      expect(only.vertices).toHaveLength(3);
      const pole = only.vertices.filter((vertex) => vertex.pole);
      expect(pole).toHaveLength(1);
      expect(pole[0]!.relativeLongitudeDeg).toBeNull();
      expect(pole[0]!.latitudeDeg).toBe(90);
      expect(pole[0]!.seamSide).toBe(0);
      expect(pole[0]!.direction).toEqual({ x: 0, y: 0, z: 1 });
      expectPieceInvariants(result, sourceAreaOf(a, b, spherePoint(123, 90)));
    }
    // The arbitrary input longitude cannot leak into the result.
    expect(withLongitude.pieces).toEqual(withOtherLongitude.pieces);
  });

  it("fans out an interior north pole into four pieces", () => {
    const a = spherePoint(0, 89);
    const b = spherePoint(120, 89);
    const c = spherePoint(-120, 89);
    const result = clip(a, b, c);

    expect(result.status).toBe("ok");
    expect(result.winding).toBe(1);
    expect(result.pieces).toHaveLength(4);
    for (const piece of result.pieces) {
      expect(piece.vertices.filter((vertex) => vertex.pole)).toHaveLength(1);
    }
    expectPieceInvariants(result, sourceAreaOf(a, b, c));
  });

  it("mirrors an interior south pole and keeps the source winding reversed", () => {
    const south = clip(
      spherePoint(0, -89),
      spherePoint(120, -89),
      spherePoint(-120, -89),
    );
    expect(south.status).toBe("ok");
    expect(south.winding).toBe(-1);
    expect(south.pieces).toHaveLength(4);
    for (const piece of south.pieces) {
      const pole = piece.vertices.filter((vertex) => vertex.pole);
      expect(pole).toHaveLength(1);
      expect(pole[0]!.latitudeDeg).toBe(-90);
      expect(pole[0]!.relativeLongitudeDeg).toBeNull();
    }
    expectPieceInvariants(
      south,
      sourceAreaOf(spherePoint(0, -89), spherePoint(120, -89), spherePoint(-120, -89)),
    );

    const reversed = clip(
      spherePoint(0, 89),
      spherePoint(-120, 89),
      spherePoint(120, 89),
    );
    expect(reversed.status).toBe("ok");
    expect(reversed.winding).toBe(-1);
    expect(reversed.pieces).toHaveLength(4);
    expectPieceInvariants(
      reversed,
      sourceAreaOf(spherePoint(0, 89), spherePoint(-120, 89), spherePoint(120, 89)),
    );
  });

  it("splits a triangle whose edge runs through the pole into two pieces", () => {
    const a = spherePoint(-90, 80);
    const b = spherePoint(90, 80);
    const c = spherePoint(0, 75);
    const result = clip(a, b, c);

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(2);
    for (const piece of result.pieces) {
      expect(piece.vertices.filter((vertex) => vertex.pole)).toHaveLength(1);
    }
    expectPieceInvariants(result, sourceAreaOf(a, b, c));
  });

  it("cuts a pole-vertex triangle at the seam without a wrong-side piece", () => {
    const a = spherePoint(0, 90);
    const b = spherePoint(170, 80);
    const c = spherePoint(-170, 80);
    const result = clip(a, b, c);

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(2);
    const [north, south] = [result.pieces[0]!, result.pieces[1]!];
    expect(north.hemisphere).toBe(1);
    expect(south.hemisphere).toBe(-1);
    for (const piece of result.pieces) {
      const poles = piece.vertices.filter((vertex) => vertex.pole);
      const seam = piece.vertices.filter((vertex) => vertex.seamSide !== 0);
      expect(poles).toHaveLength(1);
      expect(poles[0]!.relativeLongitudeDeg).toBeNull();
      expect(seam).toHaveLength(1);
      expect(seam[0]!.relativeLongitudeDeg).toBe(piece.hemisphere * 180);
      expect(seam[0]!.seamSide).toBe(piece.hemisphere);
    }
    // Both copies of the cut share one spherical position at latitude 80.
    expect(north.vertices.filter((vertex) => vertex.seamSide !== 0)[0]!.direction)
      .toEqual(south.vertices.filter((vertex) => vertex.seamSide !== 0)[0]!.direction);
    expectPieceInvariants(result, sourceAreaOf(a, b, c));
  });

  it("never inserts a pole that sits outside a near-pole arc", () => {
    // Same construction the segment tests use: the pole trails the start by a
    // fraction of a nanoradian, so it is behind the arc, not inside it.
    for (const delta of [1e-11, 2e-12]) {
      const start: Vec3 = { x: delta, y: 0, z: 1 };
      const arcEnd: Vec3 = { x: Math.sin(0.1), y: 0, z: Math.cos(0.1) };
      const third: Vec3 = {
        x: Math.sin(0.05) * Math.cos(0.3),
        y: Math.sin(0.05) * Math.sin(0.3),
        z: Math.cos(0.05),
      };
      const result = clip(start, arcEnd, third, "near-pole");
      for (const piece of result.pieces) {
        expect(piece.vertices.some((vertex) => vertex.pole)).toBe(false);
      }
      expectNoNonFinite(result);
      if (result.status === "ok") {
        expect(result.pieces).toHaveLength(1);
        expect(result.pieces[0]!.vertices).toHaveLength(3);
      } else {
        // A pole this close to a vertex cannot be attributed reliably, so the
        // face is reported instead of being split on a guess.
        expect(result.status).toBe("unsupported");
        expect(result.reason).toBeTruthy();
        expect(result.pieces).toHaveLength(0);
      }
    }
  });
});

/** Compares two results of the same geometry in two equivalent frames. */
function expectEquivalentResults(
  actual: TriangleClipResult,
  expected: TriangleClipResult,
): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.winding).toBe(expected.winding);
  expect(actual.pieces).toHaveLength(expected.pieces.length);
  for (const [index, piece] of actual.pieces.entries()) {
    const mate = expected.pieces[index]!;
    expect(piece.sourceId).toBe(mate.sourceId);
    expect(piece.hemisphere).toBe(mate.hemisphere);
    expect(piece.vertices).toHaveLength(mate.vertices.length);
    for (const [position, vertex] of piece.vertices.entries()) {
      const twin = mate.vertices[position]!;
      expect(vertex.pole).toBe(twin.pole);
      expect(vertex.seamSide).toBe(twin.seamSide);
      expect(vertex.direction.x).toBeCloseTo(twin.direction.x, 9);
      expect(vertex.direction.y).toBeCloseTo(twin.direction.y, 9);
      expect(vertex.direction.z).toBeCloseTo(twin.direction.z, 9);
      expect(vertex.latitudeDeg).toBeCloseTo(twin.latitudeDeg, 9);
      if (
        vertex.relativeLongitudeDeg === null ||
        twin.relativeLongitudeDeg === null
      ) {
        expect(vertex.relativeLongitudeDeg).toBeNull();
        expect(twin.relativeLongitudeDeg).toBeNull();
      } else {
        expect(vertex.relativeLongitudeDeg).toBeCloseTo(
          twin.relativeLongitudeDeg,
          9,
        );
      }
    }
  }
}

describe("clipTriangleToHemispheres frames, ids and inputs", () => {
  const a = spherePoint(200, 0);
  const b = spherePoint(-140, 0);
  const c = spherePoint(205, 10);

  it("treats a central meridian of 30 degrees like pre-rotated input", () => {
    // Rotating the world by minus the central meridian and keeping the
    // central meridian at zero lands on the same relative frame; rotating the
    // world by plus the central meridian and centring on it does too.
    const centred = clip(a, b, c, 7, 30);
    const preRotated = clip(
      rotateAboutZ(a, -30),
      rotateAboutZ(b, -30),
      rotateAboutZ(c, -30),
      7,
    );
    const plain = clip(a, b, c, 7);
    const centredWorld = clip(
      rotateAboutZ(a, 30),
      rotateAboutZ(b, 30),
      rotateAboutZ(c, 30),
      7,
      30,
    );

    for (const result of [centred, preRotated, plain, centredWorld]) {
      expect(result.status).toBe("ok");
    }
    expectEquivalentResults(centred, preRotated);
    expectEquivalentResults(plain, centredWorld);
  });

  it("keeps the source id and never mutates or scales the input", () => {
    const frozen = Object.freeze(spherePoint(170, 0));
    const snapshot = JSON.stringify([a, b, c]);
    const scaled = clip(scale(a, 1e200), scale(b, 1e200), scale(c, 1e200), "huge");
    const shrunk = clip(scale(a, 1e-200), scale(b, 1e-200), scale(c, 1e-200), "huge");
    const plain = clip(a, b, c, "huge");

    expect(JSON.stringify([a, b, c])).toBe(snapshot);
    expect(Object.isFrozen(frozen)).toBe(true);
    for (const piece of plain.pieces) {
      expect(piece.sourceId).toBe("huge");
    }
    for (const [index, piece] of plain.pieces.entries()) {
      const huge = scaled.pieces[index]!;
      const tiny = shrunk.pieces[index]!;
      expect(huge.sourceId).toBe("huge");
      expect(tiny.sourceId).toBe("huge");
      expect(huge.vertices).toHaveLength(piece.vertices.length);
      expect(tiny.vertices).toHaveLength(piece.vertices.length);
      for (const [position, vertex] of piece.vertices.entries()) {
        for (const twin of [huge.vertices[position]!, tiny.vertices[position]!]) {
          expect(twin.pole).toBe(vertex.pole);
          expect(twin.seamSide).toBe(vertex.seamSide);
          expect(twin.direction.x).toBeCloseTo(vertex.direction.x, 9);
          expect(twin.direction.y).toBeCloseTo(vertex.direction.y, 9);
          expect(twin.direction.z).toBeCloseTo(vertex.direction.z, 9);
          expect(twin.latitudeDeg).toBeCloseTo(vertex.latitudeDeg, 9);
        }
      }
    }
  });
});

describe("clipTriangleToHemispheres area conservation", () => {
  const equilateral: [Vec3, Vec3, Vec3] = [
    { x: 1, y: 0, z: 0 },
    { x: 0.5, y: Math.sqrt(3) / 2, z: 0 },
    { x: 0.5, y: 1 / (2 * Math.sqrt(3)), z: Math.sqrt(2 / 3) },
  ];

  it("conserves the analytic area of an equilateral spherical triangle", () => {
    const [a, b, c] = equilateral;
    const result = clip(a, b, c, "equilateral");

    expect(result.status).toBe("ok");
    expect(result.pieces).toHaveLength(1);
    expectPieceInvariants(result, EQUILATERAL_AREA);
    let total = 0;
    for (const piece of result.pieces) {
      total += polygonArea(directionsOf(piece));
    }
    expect(total).toBeCloseTo(EQUILATERAL_AREA, 12);
  });

  it("conserves the same analytic area across the seam after a 150 degree turn", () => {
    const [a, b, c] = equilateral;
    const rotated: [Vec3, Vec3, Vec3] = [
      rotateAboutZ(a, 150),
      rotateAboutZ(b, 150),
      rotateAboutZ(c, 150),
    ];
    const result = clip(rotated[0], rotated[1], rotated[2], "equilateral-seam");

    expect(result.status).toBe("ok");
    expect(result.pieces.length).toBeGreaterThan(1);
    let total = 0;
    for (const piece of result.pieces) {
      total += polygonArea(directionsOf(piece));
      expect(piece.sourceId).toBe("equilateral-seam");
    }
    expect(total).toBeCloseTo(EQUILATERAL_AREA, 12);
    expectPieceInvariants(
      result,
      triangleArea(rotated[0], rotated[1], rotated[2]),
    );
  });
});

describe("clipTriangleToHemispheres diagnostics", () => {
  const good = [spherePoint(10, 10), spherePoint(40, 10), spherePoint(20, 30)] as const;

  it("rejects non-finite vertices and centres as invalid", () => {
    const nan = { x: Number.NaN, y: 0, z: 1 };
    const infinite = { x: Number.POSITIVE_INFINITY, y: 0, z: 1 };
    const zero = { x: 0, y: 0, z: 0 };

    for (const [index, bad] of [nan, infinite, zero].entries()) {
      const vertices: [Vec3, Vec3, Vec3] = [good[0], good[1], good[2]];
      vertices[index] = bad;
      const result = clip(vertices[0], vertices[1], vertices[2], "bad");
      expect(result.status).toBe("invalid");
      expect(result.reason).toBeTruthy();
      expect(result.pieces).toHaveLength(0);
      expectNoNonFinite(result);
    }

    const infiniteCentre = clip(
      good[0],
      good[1],
      good[2],
      "bad",
      Number.POSITIVE_INFINITY,
    );
    expect(infiniteCentre.status).toBe("invalid");
    expect(infiniteCentre.pieces).toHaveLength(0);
    expectNoNonFinite(infiniteCentre);
  });

  it("reports coincident and locally collinear faces as degenerate", () => {
    const coincident = clip(spherePoint(5, 5), spherePoint(5, 5), spherePoint(20, 20));
    expect(coincident.status).toBe("degenerate");
    expect(coincident.reason).toBeTruthy();
    expect(coincident.pieces).toHaveLength(0);

    const collinear = clip(spherePoint(0, 0), spherePoint(30, 0), spherePoint(60, 0));
    expect(collinear.status).toBe("degenerate");
    expect(collinear.pieces).toHaveLength(0);
    expectNoNonFinite(collinear);
  });

  it("rejects edges at or beyond a quarter turn without producing pieces", () => {
    const quarter = clip(spherePoint(0, 0), spherePoint(90, 0), spherePoint(45, 45));
    expect(quarter.status).toBe("unsupported");
    expect(quarter.reason).toBeTruthy();
    expect(quarter.pieces).toHaveLength(0);

    const half = clip(spherePoint(0, 0), spherePoint(180, 0), spherePoint(90, 0));
    expect(half.status).toBe("unsupported");
    expect(half.pieces).toHaveLength(0);

    const wide = clip(spherePoint(0, 0), spherePoint(120, 0), spherePoint(-120, 0));
    expect(wide.status).toBe("unsupported");
    expect(wide.pieces).toHaveLength(0);
    expectNoNonFinite(wide);
  });

  it("keeps a sliver that the y = 0 snapping flattens out of the degenerate bucket", () => {
    // The third vertex sits 5e-13 above the y = 0 great circle, inside the
    // EPS_UNIT snap, so the relative endpoint is pulled onto the great circle
    // and the working triangle collapses. The source face is a genuine
    // non-degenerate sliver (area about 1.3e-13 sr, well over the 1e-14
    // threshold), so it must be reported as unrepresentable rather than
    // mislabelled as a degenerate face.
    const thin: [Vec3, Vec3, Vec3] = [
      { x: 1, y: 0, z: 0 },
      { x: Math.cos(0.5), y: 0, z: Math.sin(0.5) },
      { x: Math.cos(0.25), y: 5e-13, z: Math.sin(0.25) },
    ];

    const sourceArea = sourceAreaOf(thin[0], thin[1], thin[2]);
    expect(Math.abs(sourceArea)).toBeGreaterThan(1e-14);

    const result = clip(thin[0], thin[1], thin[2], "thin");
    expect(result.status).toBe("unsupported");
    expect(result.status).not.toBe("degenerate");
    expect(result.pieces).toHaveLength(0);
    expect(result.winding).toBe(-1);
    expect(result.reason).toMatch(/snapping/);
    expectNoNonFinite(result);

    // Reversing the input flips the source winding, so the same sliver must be
    // reported as unsupported with the opposite winding, never as degenerate.
    const reversed = clip(thin[0], thin[2], thin[1], "thin");
    expect(reversed.status).toBe("unsupported");
    expect(reversed.status).not.toBe("degenerate");
    expect(reversed.pieces).toHaveLength(0);
    expect(reversed.winding).toBe(1);
    expect(reversed.reason).toMatch(/snapping/);

    // The same face seen through a 30 degree world turn and a 30 degree central
    // meridian lands on the identical relative frame, so it stays unsupported.
    const moved = clip(
      rotateAboutZ(thin[0], 30),
      rotateAboutZ(thin[1], 30),
      rotateAboutZ(thin[2], 30),
      "thin",
      30,
    );
    expect(moved.status).toBe("unsupported");
    expect(moved.status).not.toBe("degenerate");
    expect(moved.pieces).toHaveLength(0);
    expect(moved.winding).toBe(-1);
    expect(moved.reason).toMatch(/snapping/);
  });

  it("still reports a genuinely collinear source face as degenerate", () => {
    // Control for the sliver above: a face whose three unit directions really
    // are coplanar has no area before any snapping, so it stays degenerate.
    const collinear = clip(
      spherePoint(0, 0),
      spherePoint(0.25, 0),
      spherePoint(0.5, 0),
    );
    expect(collinear.status).toBe("degenerate");
    expect(collinear.reason).toBeTruthy();
    expect(collinear.pieces).toHaveLength(0);
    expectNoNonFinite(collinear);
  });
});
