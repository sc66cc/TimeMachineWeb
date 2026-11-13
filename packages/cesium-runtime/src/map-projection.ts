import type { LonLat } from "@timemachine/reconstruction-core";

import { EARTH_RADIUS_METRES } from "./geometry";

/**
 * Viewer projection modes for this stage.
 *
 * Only the planar ids have flat-map maths. "globe" stays on the Cesium 3D
 * scene, so {@link createProjection} refuses it instead of returning a stub.
 */
export type MapProjectionId = "globe" | "rectangle" | "mollweide";

/** Projection ids that map longitude/latitude onto a 2D plane. */
export type PlanarProjectionId = Exclude<MapProjectionId, "globe">;

/** Point on the projected plane, in metres. x grows east, y grows north. */
export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapProjection {
  readonly id: PlanarProjectionId;
  /** Central meridian in degrees; longitudes are measured relative to it. */
  readonly centralMeridianDeg: number;
  /**
   * Forward projection. Input is longitude/latitude in degrees, output is
   * metres on the plane. The longitude is wrapped into the half-open
   * interval [-180, 180) relative to the central meridian. Non-finite
   * inputs and latitudes outside [-90, 90] throw RangeError instead of
   * being clamped.
   */
  project(longitudeDeg: number, latitudeDeg: number): ProjectedPoint;
  /**
   * Forward projection from a longitude already measured relative to the
   * central meridian. Unlike {@link project} this never wraps: +180 and
   * -180 stay on their own side of the seam, which is what geometry code
   * needs when a ring deliberately crosses the antimeridian.
   *
   * `relativeLongitudeDeg` must be finite and inside the closed interval
   * [-180, 180]; `latitudeDeg` must be finite and inside [-90, 90].
   * Anything else throws RangeError.
   */
  projectRelative(
    relativeLongitudeDeg: number,
    latitudeDeg: number,
  ): ProjectedPoint;
  /**
   * Inverse projection. Returns null when the point lies outside the
   * projection's valid domain (for example outside the Mollweide ellipse)
   * or when either coordinate is not finite.
   */
  unproject(x: number, y: number): LonLat | null;
}

/** Tolerance used when deciding whether a planar point is still in domain. */
const DOMAIN_EPSILON_METRES = 1e-6;

/**
 * Tolerance, in metres, for treating a Mollweide point as a pole. The pole
 * collapses the ellipse half width, so longitude is undefined there and the
 * central meridian is reported instead. cos(pi/2) is a tiny positive number,
 * so the test has to look at |y| rather than at cos(theta).
 */
const POLE_EPSILON_METRES = 1e-6;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Mollweide x scale: 2*sqrt(2)*R/pi, so the equator ends at +/-2*sqrt(2)*R.
 */
const MOLLWEIDE_X_SCALE = (2 * Math.SQRT2 * EARTH_RADIUS_METRES) / Math.PI;
/** Mollweide y scale: sqrt(2)*R, the polar extent. */
const MOLLWEIDE_Y_SCALE = Math.SQRT2 * EARTH_RADIUS_METRES;

/**
 * Wraps a longitude into [-180, 180). The half-open range keeps the
 * antimeridian at a single value (-180) so seam handling stays unambiguous.
 */
export function normalizeLongitudeDeg(longitudeDeg: number): number {
  return (((longitudeDeg + 180) % 360 + 360) % 360) - 180;
}

/** Longitude of `longitudeDeg` relative to `centralMeridianDeg`, wrapped into [-180, 180). */
export function relativeLongitudeDeg(
  longitudeDeg: number,
  centralMeridianDeg: number,
): number {
  return normalizeLongitudeDeg(longitudeDeg - centralMeridianDeg);
}

function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

function toDegrees(radians: number): number {
  return radians * RAD_TO_DEG;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Throws RangeError when `value` is not a finite number. Forward projections
 * fail loudly instead of quietly producing NaN.
 */
function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, received ${value}`);
  }
}

/** Throws RangeError when `latitudeDeg` is outside [-90, 90]. */
function assertLatitudeDeg(latitudeDeg: number): void {
  assertFinite(latitudeDeg, "latitudeDeg");
  if (latitudeDeg < -90 || latitudeDeg > 90) {
    throw new RangeError(
      `latitudeDeg must be within [-90, 90], received ${latitudeDeg}`,
    );
  }
}

/**
 * Throws RangeError when a relative longitude leaves the closed interval
 * [-180, 180]. Wrapping is {@link MapProjection.project}'s job, not this
 * function's.
 */
function assertRelativeLongitudeDeg(relativeLongitudeDeg: number): void {
  assertFinite(relativeLongitudeDeg, "relativeLongitudeDeg");
  if (relativeLongitudeDeg < -180 || relativeLongitudeDeg > 180) {
    throw new RangeError(
      `relativeLongitudeDeg must be within [-180, 180], received ${relativeLongitudeDeg}`,
    );
  }
}

/**
 * Solves 2*theta + sin(2*theta) = pi*sin(latitude) for theta in [-pi/2, pi/2].
 *
 * The left-hand side is strictly increasing on that interval, so bisection is
 * used: it cannot diverge the way Newton does where the slope vanishes at the
 * poles. 64 halvings of a pi-wide bracket is far below double precision.
 */
function solveMollweideTheta(sinLatitude: number): number {
  if (sinLatitude <= -1) {
    return -Math.PI / 2;
  }
  if (sinLatitude >= 1) {
    return Math.PI / 2;
  }

  const target = Math.PI * sinLatitude;
  let low = -Math.PI / 2;
  let high = Math.PI / 2;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    if (2 * middle + Math.sin(2 * middle) < target) {
      low = middle;
    } else {
      high = middle;
    }
    if (high - low < 1e-15) {
      break;
    }
  }
  return (low + high) / 2;
}

function createMollweideProjection(centralMeridianDeg: number): MapProjection {
  /**
   * Mollweide forward maths on an already-relative longitude. At the exact
   * poles the ellipse collapses to a point, so x is forced to 0 instead of
   * being scaled by the tiny cos(pi/2).
   */
  function projectRelative(
    relativeLongitudeDeg: number,
    latitudeDeg: number,
  ): ProjectedPoint {
    assertRelativeLongitudeDeg(relativeLongitudeDeg);
    assertLatitudeDeg(latitudeDeg);
    if (latitudeDeg === 90) {
      return { x: 0, y: MOLLWEIDE_Y_SCALE };
    }
    if (latitudeDeg === -90) {
      return { x: 0, y: -MOLLWEIDE_Y_SCALE };
    }
    const theta = solveMollweideTheta(Math.sin(toRadians(latitudeDeg)));
    return {
      x: MOLLWEIDE_X_SCALE * toRadians(relativeLongitudeDeg) * Math.cos(theta),
      y: MOLLWEIDE_Y_SCALE * Math.sin(theta),
    };
  }

  return {
    id: "mollweide",
    centralMeridianDeg,
    project(longitudeDeg, latitudeDeg) {
      assertFinite(longitudeDeg, "longitudeDeg");
      assertLatitudeDeg(latitudeDeg);
      return projectRelative(
        relativeLongitudeDeg(longitudeDeg, centralMeridianDeg),
        latitudeDeg,
      );
    },
    projectRelative,
    unproject(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      if (Math.abs(y) > MOLLWEIDE_Y_SCALE + DOMAIN_EPSILON_METRES) {
        return null;
      }
      const theta = Math.asin(clamp(y / MOLLWEIDE_Y_SCALE, -1, 1));
      const cosTheta = Math.cos(theta);
      // Half width of the ellipse at this latitude: A*pi*cos(theta).
      const halfWidth = Math.PI * MOLLWEIDE_X_SCALE * cosTheta;
      if (Math.abs(x) > halfWidth + DOMAIN_EPSILON_METRES) {
        return null;
      }
      // Pole branch: within tolerance of the polar extent the half width has
      // collapsed, so longitude is undefined and the central meridian is
      // reported. Testing cos(theta) > 0 would miss this because
      // cos(pi/2) is a tiny positive number.
      if (Math.abs(y) >= MOLLWEIDE_Y_SCALE - POLE_EPSILON_METRES) {
        return [normalizeLongitudeDeg(centralMeridianDeg), Math.sign(y) * 90];
      }
      const latitude = Math.asin(
        clamp((2 * theta + Math.sin(2 * theta)) / Math.PI, -1, 1),
      );
      const deltaLongitudeDeg = toDegrees(x / (MOLLWEIDE_X_SCALE * cosTheta));
      return [
        normalizeLongitudeDeg(centralMeridianDeg + deltaLongitudeDeg),
        toDegrees(latitude),
      ];
    },
  };
}

/**
 * Plate Carree: an equirectangular cylindrical projection with the standard
 * parallel at the equator. Deliberately not Mercator.
 */
function createRectangleProjection(centralMeridianDeg: number): MapProjection {
  const equatorHalfWidth = Math.PI * EARTH_RADIUS_METRES;
  const poleHeight = (Math.PI / 2) * EARTH_RADIUS_METRES;

  /** Plate Carree forward maths on an already-relative longitude. */
  function projectRelative(
    relativeLongitudeDeg: number,
    latitudeDeg: number,
  ): ProjectedPoint {
    assertRelativeLongitudeDeg(relativeLongitudeDeg);
    assertLatitudeDeg(latitudeDeg);
    return {
      x: EARTH_RADIUS_METRES * toRadians(relativeLongitudeDeg),
      y: EARTH_RADIUS_METRES * toRadians(latitudeDeg),
    };
  }

  return {
    id: "rectangle",
    centralMeridianDeg,
    project(longitudeDeg, latitudeDeg) {
      assertFinite(longitudeDeg, "longitudeDeg");
      assertLatitudeDeg(latitudeDeg);
      return projectRelative(
        relativeLongitudeDeg(longitudeDeg, centralMeridianDeg),
        latitudeDeg,
      );
    },
    projectRelative,
    unproject(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      if (Math.abs(y) > poleHeight + DOMAIN_EPSILON_METRES) {
        return null;
      }
      if (Math.abs(x) > equatorHalfWidth + DOMAIN_EPSILON_METRES) {
        return null;
      }
      return [
        normalizeLongitudeDeg(centralMeridianDeg + toDegrees(x / EARTH_RADIUS_METRES)),
        // Only the domain-tolerance overshoot is clamped, never real input.
        clamp(toDegrees(y / EARTH_RADIUS_METRES), -90, 90),
      ];
    },
  };
}

/**
 * Creates a planar projection. Throws for "globe", which is rendered by the
 * Cesium 3D scene rather than by any flat-map maths.
 */
export function createProjection(
  id: MapProjectionId,
  centralMeridianDeg = 0,
): MapProjection {
  assertFinite(centralMeridianDeg, "centralMeridianDeg");
  switch (id) {
    case "rectangle":
      return createRectangleProjection(centralMeridianDeg);
    case "mollweide":
      return createMollweideProjection(centralMeridianDeg);
    default:
      throw new Error(
        `Projection "${id}" has no planar form; use the 3D globe scene instead.`,
      );
  }
}
