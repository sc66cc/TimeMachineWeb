import { describe, expect, it } from "vitest";

import { EARTH_RADIUS_METRES } from "../../packages/cesium-runtime/src/geometry";
import { createProjection } from "../../packages/cesium-runtime/src/map-projection";
import type { MapProjection } from "../../packages/cesium-runtime/src/map-projection";

const R = EARTH_RADIUS_METRES;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Mollweide half width at the equator: 2*sqrt(2)*R. */
const MOLLWEIDE_HALF_WIDTH = 2 * Math.SQRT2 * R;
/** Mollweide half height (polar extent): sqrt(2)*R. */
const MOLLWEIDE_HALF_HEIGHT = Math.SQRT2 * R;
/** Plate Carree half width: pi*R. */
const RECT_HALF_WIDTH = Math.PI * R;
/** Plate Carree half height: (pi/2)*R. */
const RECT_HALF_HEIGHT = (Math.PI / 2) * R;

/** Radians of error tolerated on round trips (poles/seam excluded). */
const ROUND_TRIP_TOLERANCE_RAD = 1e-8;

describe("MapProjection.projectRelative", () => {
  it("keeps +180 and -180 on their own side for Plate Carree", () => {
    const rect = createProjection("rectangle");
    expect(rect.projectRelative(180, 0).x).toBeCloseTo(RECT_HALF_WIDTH, 6);
    expect(rect.projectRelative(-180, 0).x).toBeCloseTo(-RECT_HALF_WIDTH, 6);
    expect(rect.projectRelative(180, 0).y).toBe(0);
    expect(rect.projectRelative(-180, 0).y).toBe(0);
  });

  it("keeps +180 and -180 on their own side for Mollweide", () => {
    const moll = createProjection("mollweide");
    // At the equator theta = 0, so cos(theta) = 1 and x = A*pi = 2*sqrt(2)*R.
    expect(moll.projectRelative(180, 0).x).toBeCloseTo(MOLLWEIDE_HALF_WIDTH, 6);
    expect(moll.projectRelative(-180, 0).x).toBeCloseTo(-MOLLWEIDE_HALF_WIDTH, 6);
    // theta solves to within ~1e-15 rad, so y is zero to a few nanometres.
    expect(moll.projectRelative(180, 0).y).toBeCloseTo(0, 6);
  });

  it("does not wrap on the right of the seam where project() does", () => {
    const rect = createProjection("rectangle");
    // project() normalizes into the half-open [-180, 180) interval.
    expect(rect.project(180, 0).x).toBeCloseTo(-RECT_HALF_WIDTH, 6);
    expect(rect.project(-180, 0).x).toBeCloseTo(-RECT_HALF_WIDTH, 6);
    expect(rect.project(190, 0).x).toBeCloseTo(-170 * DEG_TO_RAD * R, 6);
    expect(rect.project(-190, 0).x).toBeCloseTo(170 * DEG_TO_RAD * R, 6);
    // projectRelative() leaves +180 exactly where it was given.
    expect(rect.projectRelative(180, 0).x).toBeCloseTo(RECT_HALF_WIDTH, 6);
  });

  it("projects the origin and the exact poles", () => {
    for (const projection of [
      createProjection("rectangle"),
      createProjection("mollweide"),
    ]) {
      const origin = projection.projectRelative(0, 0);
      // The theta solve leaves a nanometre-scale residual for Mollweide.
      expect(origin.x).toBe(0);
      expect(origin.y).toBeCloseTo(0, 6);
    }

    const moll = createProjection("mollweide");
    // Pole branch: x is forced to 0 even for a non-zero relative longitude,
    // because cos(pi/2) would otherwise scale it by ~1e-16.
    expect(moll.projectRelative(0, 90)).toEqual({ x: 0, y: MOLLWEIDE_HALF_HEIGHT });
    expect(moll.projectRelative(180, 90)).toEqual({ x: 0, y: MOLLWEIDE_HALF_HEIGHT });
    expect(moll.projectRelative(123.5, -90)).toEqual({
      x: 0,
      y: -MOLLWEIDE_HALF_HEIGHT,
    });

    const rect = createProjection("rectangle");
    expect(rect.projectRelative(37, 90)).toEqual({
      x: 37 * DEG_TO_RAD * R,
      y: RECT_HALF_HEIGHT,
    });
    expect(rect.projectRelative(-37, -90)).toEqual({
      x: -37 * DEG_TO_RAD * R,
      y: -RECT_HALF_HEIGHT,
    });
  });

  it("places the central meridian at the origin and inverse adds it back", () => {
    for (const projection of [
      createProjection("rectangle", 30),
      createProjection("mollweide", 30),
    ]) {
      const origin = projection.project(30, 0);
      expect(origin.x).toBeCloseTo(0, 6);
      expect(origin.y).toBeCloseTo(0, 6);
      const inverse = projection.unproject(origin.x, origin.y);
      expect(inverse).not.toBeNull();
      expect((inverse as readonly [number, number])[0]).toBeCloseTo(30, 9);
      expect((inverse as readonly [number, number])[1]).toBeCloseTo(0, 9);
    }
  });
});

describe("Mollweide analytic control point", () => {
  it("maps theta = pi/4 at longitude 90 to exactly (R, R)", () => {
    // Independent analytic control point: with theta = pi/4 the defining
    // equation 2*theta + sin(2*theta) = pi*sin(lat) gives
    // lat = asin(0.5 + 1/pi), and x = A*pi/2*cos(pi/4) = R,
    // y = sqrt(2)*R*sin(pi/4) = R. Not a forward/inverse round trip.
    const latitudeDeg = Math.asin(0.5 + 1 / Math.PI) * RAD_TO_DEG;
    const moll = createProjection("mollweide");
    const point = moll.projectRelative(90, latitudeDeg);
    expect(point.x).toBeCloseTo(R, 6);
    expect(point.y).toBeCloseTo(R, 6);
  });
});

describe("MapProjection round trips", () => {
  // Poles and seam longitudes are excluded: their longitude is not unique.
  const points: ReadonlyArray<readonly [number, number]> = [
    [10, 0],
    [-45, 33.3],
    [120, -60.5],
    [75, 80],
    [-160, -80],
    [0, 45],
    [95, -12.25],
  ];

  it.each([
    ["rectangle", createProjection("rectangle")],
    ["mollweide", createProjection("mollweide")],
  ])("round trips ordinary points through %s", (_id, projection) => {
    for (const [longitudeDeg, latitudeDeg] of points) {
      const point = projection.project(longitudeDeg, latitudeDeg);
      const inverse = projection.unproject(point.x, point.y);
      expect(inverse).not.toBeNull();
      const [lonDeg, latDeg] = inverse as readonly [number, number];
      const lonErrorRad = Math.abs(lonDeg - longitudeDeg) * DEG_TO_RAD;
      const latErrorRad = Math.abs(latDeg - latitudeDeg) * DEG_TO_RAD;
      expect(lonErrorRad).toBeLessThan(ROUND_TRIP_TOLERANCE_RAD);
      expect(latErrorRad).toBeLessThan(ROUND_TRIP_TOLERANCE_RAD);
    }
  });
});

describe("Mollweide inverse domain and poles", () => {
  it("returns null outside the ellipse and for non-finite input", () => {
    const moll = createProjection("mollweide");
    expect(moll.unproject(Infinity, 0)).toBeNull();
    expect(moll.unproject(0, NaN)).toBeNull();
    expect(moll.unproject(NaN, NaN)).toBeNull();
    expect(moll.unproject(0, 2 * MOLLWEIDE_HALF_HEIGHT)).toBeNull();
    // At the equator the ellipse half width is 2*sqrt(2)*R.
    expect(moll.unproject(MOLLWEIDE_HALF_WIDTH + 1e-3, 0)).toBeNull();
    expect(moll.unproject(-MOLLWEIDE_HALF_WIDTH - 1e-3, 0)).toBeNull();
    // Just inside the equator half width stays in domain.
    const inside = moll.unproject(MOLLWEIDE_HALF_WIDTH - 1e-3, 0);
    expect(inside).not.toBeNull();
    expect((inside as readonly [number, number])[1]).toBeCloseTo(0, 9);
  });

  it("reports the central meridian at the poles instead of dividing by cos(pi/2)", () => {
    const moll = createProjection("mollweide", 30);
    expect(moll.unproject(0, MOLLWEIDE_HALF_HEIGHT)).toEqual([30, 90]);
    expect(moll.unproject(0, -MOLLWEIDE_HALF_HEIGHT)).toEqual([30, -90]);
    // Within the pole tolerance the same branch is taken.
    expect(moll.unproject(0, MOLLWEIDE_HALF_HEIGHT - 5e-7)).toEqual([30, 90]);
    expect(moll.unproject(0, -MOLLWEIDE_HALF_HEIGHT + 5e-7)).toEqual([30, -90]);
    // Just past the domain tolerance it is out of domain.
    expect(moll.unproject(0, MOLLWEIDE_HALF_HEIGHT + 1e-3)).toBeNull();
  });

  it("checks the ellipse half width before the pole tolerance branch", () => {
    const moll = createProjection("mollweide", 30);
    // The half width collapses at the pole, so a far-east point is out of
    // domain even though y sits on the polar extent.
    expect(moll.unproject(1e9, MOLLWEIDE_HALF_HEIGHT)).toBeNull();
    expect(moll.unproject(1e9, -MOLLWEIDE_HALF_HEIGHT)).toBeNull();
    expect(moll.unproject(1e9, MOLLWEIDE_HALF_HEIGHT - 5e-7)).toBeNull();
    expect(moll.unproject(-1e9, -MOLLWEIDE_HALF_HEIGHT + 5e-7)).toBeNull();
    // Inside the tolerance band the half width is still a few metres, so
    // points within it must not be rejected.
    const bandHalfWidth = 5.998; // ~6 m at 5e-7 m below the polar extent
    expect(
      moll.unproject(bandHalfWidth / 2, MOLLWEIDE_HALF_HEIGHT - 5e-7),
    ).toEqual([30, 90]);
    expect(
      moll.unproject(-bandHalfWidth / 2, -MOLLWEIDE_HALF_HEIGHT + 5e-7),
    ).toEqual([30, -90]);
  });
});

describe("Plate Carree inverse domain", () => {
  it("returns null outside the rectangle and for non-finite input", () => {
    const rect = createProjection("rectangle");
    expect(rect.unproject(Infinity, 0)).toBeNull();
    expect(rect.unproject(0, -Infinity)).toBeNull();
    expect(rect.unproject(NaN, 0)).toBeNull();
    expect(rect.unproject(0, RECT_HALF_HEIGHT + 1e-3)).toBeNull();
    expect(rect.unproject(RECT_HALF_WIDTH + 1e-3, 0)).toBeNull();
    expect(rect.unproject(-RECT_HALF_WIDTH - 1e-3, 0)).toBeNull();
    const corner = rect.unproject(RECT_HALF_WIDTH - 1e-3, RECT_HALF_HEIGHT - 1e-3);
    expect(corner).not.toBeNull();
    expect((corner as readonly [number, number])[0]).toBeCloseTo(180, 6);
    expect((corner as readonly [number, number])[1]).toBeCloseTo(90, 6);
  });

  it("never returns a latitude beyond +/-90 inside the domain tolerance", () => {
    const rect = createProjection("rectangle");
    const north = rect.unproject(0, RECT_HALF_HEIGHT + 5e-7);
    expect(north).not.toBeNull();
    expect((north as readonly [number, number])[1]).toBe(90);
    const south = rect.unproject(0, -RECT_HALF_HEIGHT - 5e-7);
    expect(south).not.toBeNull();
    expect((south as readonly [number, number])[1]).toBe(-90);
  });
});

describe("Projection input validation", () => {
  it.each([
    ["rectangle", createProjection("rectangle")],
    ["mollweide", createProjection("mollweide")],
  ])("throws RangeError for illegal forward input on %s", (_id, projection) => {
    expect(() => projection.project(0, 90.5)).toThrow(RangeError);
    expect(() => projection.project(0, -91)).toThrow(RangeError);
    expect(() => projection.project(NaN, 0)).toThrow(RangeError);
    expect(() => projection.project(0, Infinity)).toThrow(RangeError);
    expect(() => projection.projectRelative(180.5, 0)).toThrow(RangeError);
    expect(() => projection.projectRelative(-180.5, 0)).toThrow(RangeError);
    expect(() => projection.projectRelative(Infinity, 0)).toThrow(RangeError);
    expect(() => projection.projectRelative(0, NaN)).toThrow(RangeError);
    // The closed endpoints themselves are legal.
    expect(() => projection.projectRelative(180, 90)).not.toThrow();
    expect(() => projection.projectRelative(-180, -90)).not.toThrow();
  });

  it("throws RangeError for a non-finite central meridian", () => {
    expect(() => createProjection("rectangle", NaN)).toThrow(RangeError);
    expect(() => createProjection("mollweide", Infinity)).toThrow(RangeError);
    expect(() => createProjection("rectangle", -Infinity)).toThrow(RangeError);
  });

  it("still refuses the globe id", () => {
    expect(() => createProjection("globe")).toThrow();
  });
});

/**
 * Numerical Jacobian determinant of the forward projection with respect to
 * (longitude, latitude) in radians, by central differences.
 */
function jacobianDeterminant(
  projection: MapProjection,
  longitudeDeg: number,
  latitudeDeg: number,
): number {
  const stepRad = 1e-7;
  const stepDeg = stepRad * RAD_TO_DEG;
  const east = projection.project(longitudeDeg + stepDeg, latitudeDeg);
  const west = projection.project(longitudeDeg - stepDeg, latitudeDeg);
  const north = projection.project(longitudeDeg, latitudeDeg + stepDeg);
  const south = projection.project(longitudeDeg, latitudeDeg - stepDeg);
  const dxDLon = (east.x - west.x) / (2 * stepRad);
  const dyDLon = (east.y - west.y) / (2 * stepRad);
  const dxDLat = (north.x - south.x) / (2 * stepRad);
  const dyDLat = (north.y - south.y) / (2 * stepRad);
  return dxDLon * dyDLat - dxDLat * dyDLon;
}

describe("Jacobian determinants", () => {
  it.each([0, 30, 70])("Mollweide is equal-area at latitude %i", (latitudeDeg) => {
    const moll = createProjection("mollweide");
    const determinant = jacobianDeterminant(moll, 10, latitudeDeg);
    const expected = R * R * Math.cos(latitudeDeg * DEG_TO_RAD);
    expect(Math.abs(determinant - expected) / expected).toBeLessThan(1e-6);
  });

  it.each([0, 30, 70])("Plate Carree is not equal-area at latitude %i", (latitudeDeg) => {
    const rect = createProjection("rectangle");
    const determinant = jacobianDeterminant(rect, 10, latitudeDeg);
    // x = R*lambda, y = R*phi: the determinant is the constant R^2, which is
    // why this projection deliberately is not the equal-area one.
    expect(Math.abs(determinant - R * R) / (R * R)).toBeLessThan(1e-6);
  });
});
