import { describe, expect, it } from "vitest";

import type { Vec3 } from "@timemachine/reconstruction-core";

import { EARTH_RADIUS_METRES } from "../../packages/cesium-runtime/src/geometry";
import { createProjection } from "../../packages/cesium-runtime/src/map-projection";
import type { MapProjection, ProjectedPoint } from "../../packages/cesium-runtime/src/map-projection";
import { projectSegment } from "../../packages/cesium-runtime/src/projected-geometry";
import type {
  ProjectedSegment,
  SegmentProjectionResult,
} from "../../packages/cesium-runtime/src/projected-geometry";

const R = EARTH_RADIUS_METRES;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Plate Carree half width: pi*R. */
const RECT_HALF_WIDTH = Math.PI * R;
/** Plate Carree half height: (pi/2)*R. */
const RECT_HALF_HEIGHT = (Math.PI / 2) * R;
/** Mollweide half width at the equator: 2*sqrt(2)*R. */
const MOLLWEIDE_HALF_WIDTH = 2 * Math.SQRT2 * R;
/** Mollweide half height (polar extent): sqrt(2)*R. */
const MOLLWEIDE_HALF_HEIGHT = Math.SQRT2 * R;

/**
 * Independent analytic control value for a great circle through two points at
 * latitude 10 degrees and longitudes +/-170 degrees: at the antimeridian it
 * satisfies tan(lat) = tan(10 deg) / cos(10 deg), so lat ~ 10.1510817 degrees.
 * The same figure holds for the central-meridian cut of a symmetric edge.
 */
const CROSSING_LATITUDE_RAD = Math.atan(
  Math.tan(10 * DEG_TO_RAD) / Math.cos(10 * DEG_TO_RAD),
);
const CROSSING_LATITUDE_DEG = CROSSING_LATITUDE_RAD * RAD_TO_DEG;

function spherePoint(
  longitudeDeg: number,
  latitudeDeg: number,
  radius = R,
): Vec3 {
  const lon = longitudeDeg * DEG_TO_RAD;
  const lat = latitudeDeg * DEG_TO_RAD;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.cos(lat) * Math.sin(lon),
    z: radius * Math.sin(lat),
  };
}

/** Rotates a position about Z, used only to build pre-rotated test input. */
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

/** Builds a unit direction for boundary cases that need an exact angle. */
function normalize(vector: Vec3): Vec3 {
  const length = Math.sqrt(
    vector.x * vector.x + vector.y * vector.y + vector.z * vector.z,
  );
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function planarProjections(): ReadonlyArray<readonly [string, MapProjection]> {
  return [
    ["rectangle", createProjection("rectangle")],
    ["mollweide", createProjection("mollweide")],
  ];
}

function halfWidth(projection: MapProjection): number {
  return projection.id === "rectangle"
    ? RECT_HALF_WIDTH
    : MOLLWEIDE_HALF_WIDTH;
}

function expectCloseToPoint(
  actual: ProjectedPoint,
  expected: ProjectedPoint,
): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

function asPair(
  segments: readonly ProjectedSegment[],
): readonly [ProjectedSegment, ProjectedSegment] {
  expect(segments).toHaveLength(2);
  return segments as readonly [ProjectedSegment, ProjectedSegment];
}

function asSingle(
  segments: readonly ProjectedSegment[],
): readonly [ProjectedSegment] {
  expect(segments).toHaveLength(1);
  return segments as readonly [ProjectedSegment];
}

function asTriple(
  segments: readonly ProjectedSegment[],
): readonly [ProjectedSegment, ProjectedSegment, ProjectedSegment] {
  expect(segments).toHaveLength(3);
  return segments as readonly [
    ProjectedSegment,
    ProjectedSegment,
    ProjectedSegment,
  ];
}

function expectDiagnostic(
  result: SegmentProjectionResult,
  status: "degenerate" | "invalid" | "unsupported",
): void {
  expect(result.status).toBe(status);
  expect(result.segments).toEqual([]);
  expect(typeof result.reason).toBe("string");
  expect((result.reason ?? "").length).toBeGreaterThan(0);
}

describe("projectSegment antimeridian crossing", () => {
  it.each(planarProjections())(
    "cuts a seam-crossing edge into two pieces on %s",
    (_id, projection) => {
      const result = projectSegment(
        spherePoint(170, 10),
        spherePoint(-170, 10),
        "edge-1",
        projection,
      );

      expect(result.status).toBe("ok");
      expect(result.reason).toBeUndefined();
      const [right, left] = asPair(result.segments);

      // Source direction a -> b is preserved piece by piece.
      expectCloseToPoint(right.start, projection.projectRelative(170, 10));
      expectCloseToPoint(right.end, projection.projectRelative(180, CROSSING_LATITUDE_DEG));
      expectCloseToPoint(left.start, projection.projectRelative(-180, CROSSING_LATITUDE_DEG));
      expectCloseToPoint(left.end, projection.projectRelative(-170, 10));

      // Both copies of the shared crossing sit at the same latitude, and each
      // piece stays on its own side of the map.
      expect(right.end.y).toBeCloseTo(left.start.y, 6);
      expect(right.start.x).toBeGreaterThan(0);
      expect(right.end.x).toBeGreaterThan(0);
      expect(left.start.x).toBeLessThan(0);
      expect(left.end.x).toBeLessThan(0);
    },
  );

  it("puts the Plate Carree crossing at the analytic latitude", () => {
    const rectangle = createProjection("rectangle");
    const result = projectSegment(
      spherePoint(170, 10),
      spherePoint(-170, 10),
      1,
      rectangle,
    );
    const [right, left] = asPair(result.segments);

    const expectedY = R * CROSSING_LATITUDE_RAD;
    expect(right.end.y).toBeCloseTo(expectedY, 6);
    expect(left.start.y).toBeCloseTo(expectedY, 6);
    expect(right.end.x).toBeCloseTo(RECT_HALF_WIDTH, 6);
    expect(left.start.x).toBeCloseTo(-RECT_HALF_WIDTH, 6);
    expect(right.start.y).toBeCloseTo(R * 10 * DEG_TO_RAD, 6);
    expect(left.end.y).toBeCloseTo(R * 10 * DEG_TO_RAD, 6);
  });

  it("does not run the Mollweide pieces across the map", () => {
    const mollweide = createProjection("mollweide");
    const result = projectSegment(
      spherePoint(170, 10),
      spherePoint(-170, 10),
      1,
      mollweide,
    );
    const [right, left] = asPair(result.segments);

    // The crossing is not on the equator, so both copies sit strictly inside
    // the ellipse instead of on its widest points.
    expect(right.end.x).toBeGreaterThan(0);
    expect(right.end.x).toBeLessThan(MOLLWEIDE_HALF_WIDTH);
    expect(left.start.x).toBeLessThan(0);
    expect(left.start.x).toBeGreaterThan(-MOLLWEIDE_HALF_WIDTH);
    expectCloseToPoint(right.end, mollweide.projectRelative(180, CROSSING_LATITUDE_DEG));
    expectCloseToPoint(left.start, mollweide.projectRelative(-180, CROSSING_LATITUDE_DEG));
    for (const segment of result.segments) {
      expect(Math.abs(segment.start.x)).toBeLessThanOrEqual(MOLLWEIDE_HALF_WIDTH);
      expect(Math.abs(segment.end.x)).toBeLessThanOrEqual(MOLLWEIDE_HALF_WIDTH);
      expect(Math.abs(segment.start.y)).toBeLessThan(MOLLWEIDE_HALF_HEIGHT);
      expect(Math.abs(segment.end.y)).toBeLessThan(MOLLWEIDE_HALF_HEIGHT);
    }
  });
});

describe("projectSegment central meridian crossing", () => {
  it.each(planarProjections())(
    "cuts a central-meridian edge without any seam copy on %s",
    (_id, projection) => {
      const result = projectSegment(
        spherePoint(-10, 10),
        spherePoint(10, 10),
        2,
        projection,
      );

      expect(result.status).toBe("ok");
      const [first, second] = asPair(result.segments);
      expectCloseToPoint(first.start, projection.projectRelative(-10, 10));
      expectCloseToPoint(
        first.end,
        projection.projectRelative(0, CROSSING_LATITUDE_DEG),
      );
      expectCloseToPoint(
        second.start,
        projection.projectRelative(0, CROSSING_LATITUDE_DEG),
      );
      expectCloseToPoint(second.end, projection.projectRelative(10, 10));

      // No +/-180 copy is produced for a central cut.
      for (const segment of result.segments) {
        expect(Math.abs(segment.start.x)).toBeLessThan(halfWidth(projection));
        expect(Math.abs(segment.end.x)).toBeLessThan(halfWidth(projection));
      }
    },
  );

  it.each(planarProjections())(
    "leaves a long equatorial edge that merely touches the meridian uncut on %s",
    (_id, projection) => {
      const result = projectSegment(spherePoint(0, 0), spherePoint(80, 0), 21, projection);

      expect(result.status).toBe("ok");
      expect(result.segments).toHaveLength(1);
      const [only] = asSingle(result.segments);
      expectCloseToPoint(only.start, projection.projectRelative(0, 0));
      expectCloseToPoint(only.end, projection.projectRelative(80, 0));
    },
  );
});

describe("projectSegment seam endpoints and whole-meridian edges", () => {
  it.each(planarProjections())(
    "keeps an edge that starts on the seam on one side on %s",
    (_id, projection) => {
      const result = projectSegment(
        spherePoint(180, 0),
        spherePoint(-170, 10),
        3,
        projection,
      );

      expect(result.status).toBe("ok");
      expect(result.segments).toHaveLength(1);
      const [only] = asSingle(result.segments);
      // The other end is in the western half, so the seam copy is -180 only.
      expectCloseToPoint(only.start, projection.projectRelative(-180, 0));
      expectCloseToPoint(only.end, projection.projectRelative(-170, 10));
      expect(only.start.x).toBeLessThan(0);
      expect(only.end.x).toBeLessThan(0);
    },
  );

  it.each(planarProjections())(
    "draws a whole seam edge on both map edges on %s",
    (_id, projection) => {
      const result = projectSegment(
        spherePoint(180, -1),
        spherePoint(180, 1),
        4,
        projection,
      );

      expect(result.status).toBe("ok");
      const [right, left] = asPair(result.segments);
      expectCloseToPoint(right.start, projection.projectRelative(180, -1));
      expectCloseToPoint(right.end, projection.projectRelative(180, 1));
      expectCloseToPoint(left.start, projection.projectRelative(-180, -1));
      expectCloseToPoint(left.end, projection.projectRelative(-180, 1));
    },
  );

  it.each(planarProjections())(
    "draws a whole central-meridian edge exactly once on %s",
    (_id, projection) => {
      const result = projectSegment(spherePoint(0, -1), spherePoint(0, 1), 5, projection);

      expect(result.status).toBe("ok");
      expect(result.segments).toHaveLength(1);
      const [only] = asSingle(result.segments);
      expectCloseToPoint(only.start, projection.projectRelative(0, -1));
      expectCloseToPoint(only.end, projection.projectRelative(0, 1));
      expect(only.start.x).toBeCloseTo(0, 6);
      expect(only.end.x).toBeCloseTo(0, 6);
    },
  );
});

describe("projectSegment poles", () => {
  it("splits a Plate Carree edge through the pole into two vertical pieces", () => {
    const rectangle = createProjection("rectangle");
    const result = projectSegment(
      spherePoint(-90, 80),
      spherePoint(90, 80),
      6,
      rectangle,
    );

    expect(result.status).toBe("ok");
    const [first, second] = asPair(result.segments);
    // Each piece runs along one meridian; the pole takes the longitude of the
    // end it is joined to, never the longitude written at the pole.
    expectCloseToPoint(first.start, rectangle.projectRelative(-90, 80));
    expectCloseToPoint(first.end, rectangle.projectRelative(-90, 90));
    expectCloseToPoint(second.start, rectangle.projectRelative(90, 90));
    expectCloseToPoint(second.end, rectangle.projectRelative(90, 80));

    // Each piece has exactly one end on the polar extent: there is no
    // horizontal join between the two pole copies along the top edge.
    for (const segment of result.segments) {
      expect(segment.start.x).toBeCloseTo(segment.end.x, 6);
      const poleEnds = [segment.start.y, segment.end.y].filter(
        (y) => Math.abs(y - RECT_HALF_HEIGHT) < 1e-3,
      );
      expect(poleEnds).toHaveLength(1);
    }
  });

  it("converges both Mollweide pole copies onto the same point", () => {
    const mollweide = createProjection("mollweide");
    const result = projectSegment(
      spherePoint(-90, 80),
      spherePoint(90, 80),
      6,
      mollweide,
    );

    expect(result.status).toBe("ok");
    const [first, second] = asPair(result.segments);
    expectCloseToPoint(first.end, { x: 0, y: MOLLWEIDE_HALF_HEIGHT });
    expectCloseToPoint(second.start, { x: 0, y: MOLLWEIDE_HALF_HEIGHT });
    expectCloseToPoint(first.start, mollweide.projectRelative(-90, 80));
    expectCloseToPoint(second.end, mollweide.projectRelative(90, 80));

    // Still no horizontal join along the polar extent.
    for (const segment of result.segments) {
      expect(Math.abs(segment.start.y - segment.end.y)).toBeGreaterThan(1);
    }
  });

  it.each(planarProjections())(
    "ignores the longitude written at an existing pole endpoint on %s",
    (_id, projection) => {
      const reference = projectSegment(
        spherePoint(0, 90),
        spherePoint(40, 80),
        7,
        projection,
      );
      expect(reference.status).toBe("ok");
      expect(reference.segments).toHaveLength(1);

      for (const longitudeDeg of [123, -200, 180, 40, -47]) {
        const result = projectSegment(
          spherePoint(longitudeDeg, 90),
          spherePoint(40, 80),
          7,
          projection,
        );
        expect(result.status).toBe("ok");
        expect(result.segments).toEqual(reference.segments);
      }

      const south = projectSegment(
        spherePoint(123, -90),
        spherePoint(40, -80),
        7,
        projection,
      );
      const southReference = projectSegment(
        spherePoint(0, -90),
        spherePoint(40, -80),
        7,
        projection,
      );
      expect(south.segments).toEqual(southReference.segments);
    },
  );

  it.each(planarProjections())(
    "draws a pole-to-seam edge on both edges and a pole-to-meridian edge once on %s",
    (_id, projection) => {
      const onSeam = projectSegment(
        spherePoint(0, 90),
        spherePoint(180, 10),
        8,
        projection,
      );
      expect(onSeam.status).toBe("ok");
      const [seamRight, seamLeft] = asPair(onSeam.segments);
      expectCloseToPoint(seamRight.start, projection.projectRelative(180, 90));
      expectCloseToPoint(seamRight.end, projection.projectRelative(180, 10));
      expectCloseToPoint(seamLeft.start, projection.projectRelative(-180, 90));
      expectCloseToPoint(seamLeft.end, projection.projectRelative(-180, 10));

      const onMeridian = projectSegment(
        spherePoint(0, 90),
        spherePoint(0, 10),
        8,
        projection,
      );
      expect(onMeridian.status).toBe("ok");
      expect(onMeridian.segments).toHaveLength(1);
      const [only] = asSingle(onMeridian.segments);
      expectCloseToPoint(only.start, projection.projectRelative(0, 90));
      expectCloseToPoint(only.end, projection.projectRelative(0, 10));
    },
  );
});

describe("projectSegment near-pole arcs", () => {
  /** Far end of the near-pole arcs: 0.1 rad of colatitude on one meridian. */
  const northArcEnd: Vec3 = { x: Math.sin(0.1), y: 0, z: Math.cos(0.1) };
  const southArcEnd: Vec3 = { x: Math.sin(0.1), y: 0, z: -Math.cos(0.1) };

  it.each(planarProjections())(
    "keeps a hair-off-pole arc that never reaches the pole whole on %s",
    (_id, projection) => {
      // The pole sits a fraction of a nanoradian behind the start, outside
      // the arc: an angle-sum test mistakes that for an interior pole.
      for (const delta of [1e-11, 2e-12]) {
        const start: Vec3 = { x: delta, y: 0, z: 1 };
        const forward = projectSegment(start, northArcEnd, "near-pole", projection);
        const backward = projectSegment(northArcEnd, start, "near-pole", projection);

        for (const result of [forward, backward]) {
          expect(result.status).toBe("ok");
          expect(result.reason).toBeUndefined();
          expect(result.segments).toHaveLength(1);
        }
        const [only] = asSingle(forward.segments);
        expect(only.sourceId).toBe("near-pole");
        expectCloseToPoint(
          only.start,
          projection.projectRelative(0, Math.atan2(1, delta) * RAD_TO_DEG),
        );
        expectCloseToPoint(
          only.end,
          projection.projectRelative(0, (Math.PI / 2 - 0.1) * RAD_TO_DEG),
        );
        const [reversed] = asSingle(backward.segments);
        expectCloseToPoint(reversed.start, only.end);
        expectCloseToPoint(reversed.end, only.start);
      }
    },
  );

  it.each(planarProjections())(
    "keeps the mirrored southern arc whole on %s",
    (_id, projection) => {
      const start: Vec3 = { x: 1e-11, y: 0, z: -1 };
      const forward = projectSegment(start, southArcEnd, 32, projection);
      const backward = projectSegment(southArcEnd, start, 32, projection);

      expect(forward.status).toBe("ok");
      expect(backward.status).toBe("ok");
      const [only] = asSingle(forward.segments);
      expectCloseToPoint(
        only.start,
        projection.projectRelative(0, Math.atan2(-1, 1e-11) * RAD_TO_DEG),
      );
      expectCloseToPoint(
        only.end,
        projection.projectRelative(0, -(Math.PI / 2 - 0.1) * RAD_TO_DEG),
      );
      const [reversed] = asSingle(backward.segments);
      expectCloseToPoint(reversed.start, only.end);
      expectCloseToPoint(reversed.end, only.start);
    },
  );

  it.each(planarProjections())(
    "still splits an arc that really runs through the pole on %s",
    (_id, projection) => {
      // Colatitude 0.2 on the central meridian to colatitude 0.1 on the
      // seam: the pole is genuinely interior, so the edge is cut there.
      const result = projectSegment(
        { x: Math.sin(0.2), y: 0, z: Math.cos(0.2) },
        { x: -Math.sin(0.1), y: 0, z: Math.cos(0.1) },
        33,
        projection,
      );

      expect(result.status).toBe("ok");
      const [meridian, seamRight, seamLeft] = asTriple(result.segments);
      expectCloseToPoint(
        meridian.start,
        projection.projectRelative(0, (Math.PI / 2 - 0.2) * RAD_TO_DEG),
      );
      expectCloseToPoint(meridian.end, projection.projectRelative(0, 90));
      expectCloseToPoint(seamRight.start, projection.projectRelative(180, 90));
      expectCloseToPoint(
        seamRight.end,
        projection.projectRelative(180, (Math.PI / 2 - 0.1) * RAD_TO_DEG),
      );
      expectCloseToPoint(seamLeft.start, projection.projectRelative(-180, 90));
      expectCloseToPoint(
        seamLeft.end,
        projection.projectRelative(-180, (Math.PI / 2 - 0.1) * RAD_TO_DEG),
      );
    },
  );

  it.each(planarProjections())(
    "keeps a point a hair off the pole below ninety degrees on %s",
    (_id, projection) => {
      const result = projectSegment(
        { x: 1e-8, y: 0, z: 1 },
        northArcEnd,
        41,
        projection,
      );

      expect(result.status).toBe("ok");
      const [only] = asSingle(result.segments);
      // asin(z) would round the unitised z to 1 and report the pole itself;
      // atan2(z, hypot(x, y)) keeps the true 1e-8 rad shortfall.
      const latitudeDeg = Math.atan2(1, 1e-8) * RAD_TO_DEG;
      expect(latitudeDeg).toBeLessThan(90);
      expectCloseToPoint(
        only.start,
        projection.projectRelative(0, latitudeDeg),
      );
      if (projection.id === "rectangle") {
        // Analytic Plate Carree control value for the same latitude.
        expect(only.start.y).toBeCloseTo(R * Math.atan2(1, 1e-8), 6);
        expect(only.start.y).toBeLessThan(RECT_HALF_HEIGHT);
      }
    },
  );
});

describe("projectSegment frame and source bookkeeping", () => {
  it.each(planarProjections())(
    "reverses the pieces when the source direction reverses on %s",
    (_id, projection) => {
      const forward = projectSegment(
        spherePoint(170, 10),
        spherePoint(-170, 10),
        10,
        projection,
      );
      const backward = projectSegment(
        spherePoint(-170, 10),
        spherePoint(170, 10),
        10,
        projection,
      );

      expect(forward.status).toBe("ok");
      expect(backward.status).toBe("ok");
      const reversed = [...forward.segments]
        .reverse()
        .map((segment) => ({
          sourceId: segment.sourceId,
          start: segment.end,
          end: segment.start,
        }));
      expect(backward.segments).toEqual(reversed);
    },
  );

  it.each(planarProjections())(
    "propagates the source id to the result and every piece on %s",
    (_id, projection) => {
      for (const sourceId of [7, "plate-42"]) {
        const result = projectSegment(
          spherePoint(170, 10),
          spherePoint(-170, 10),
          sourceId,
          projection,
        );
        expect(result.sourceId).toBe(sourceId);
        expect(result.segments.length).toBeGreaterThan(0);
        for (const segment of result.segments) {
          expect(segment.sourceId).toBe(sourceId);
        }
      }
    },
  );

  it.each(planarProjections())(
    "leaves frozen input vectors untouched on %s",
    (_id, projection) => {
      const a = Object.freeze(spherePoint(170, 10));
      const b = Object.freeze(spherePoint(-170, 10));
      const snapshotA = { ...a };
      const snapshotB = { ...b };

      const result = projectSegment(a, b, 12, projection);

      expect(result.status).toBe("ok");
      expect(a).toEqual(snapshotA);
      expect(b).toEqual(snapshotB);
    },
  );

  it.each(planarProjections())(
    "treats a scaled radius like the unit direction on %s",
    (_id, projection) => {
      const unit = projectSegment(
        spherePoint(170, 10, 1),
        spherePoint(-170, 10, 1),
        13,
        projection,
      );
      const wgs84 = projectSegment(
        spherePoint(170, 10, 6_378_137),
        spherePoint(-170, 10, 6_378_137),
        13,
        projection,
      );

      expect(unit.status).toBe("ok");
      expect(unit.segments).toEqual(wgs84.segments);
    },
  );

  it.each(planarProjections())(
    "matches pre-rotated input when the central meridian moves on %s",
    (_id, projection) => {
      const shifted = createProjection(projection.id, 30);
      const result = projectSegment(
        spherePoint(170, 10),
        spherePoint(-170, 10),
        9,
        shifted,
      );
      const reference = projectSegment(
        rotateAboutZ(spherePoint(170, 10), -30),
        rotateAboutZ(spherePoint(-170, 10), -30),
        9,
        projection,
      );

      expect(result.status).toBe("ok");
      expect(result.segments).toEqual(reference.segments);
    },
  );

  it("keeps a seam-crossing edge whole once the seam moves away", () => {
    const shifted = createProjection("rectangle", 30);
    const result = projectSegment(
      spherePoint(170, 10),
      spherePoint(-170, 10),
      9,
      shifted,
    );

    // With the seam at 30 + 180 the arc stays in the eastern half.
    expect(result.status).toBe("ok");
    expect(result.segments).toHaveLength(1);
    const [only] = asSingle(result.segments);
    expectCloseToPoint(only.start, shifted.projectRelative(140, 10));
    expectCloseToPoint(only.end, shifted.projectRelative(160, 10));
  });
});

describe("projectSegment numeric scale safety", () => {
  it.each(planarProjections())(
    "matches the unit direction at extreme finite scales on %s",
    (_id, projection) => {
      const unit = projectSegment(
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        40,
        projection,
      );
      const huge = projectSegment(
        { x: 1e200, y: 0, z: 0 },
        { x: 1e200, y: 1e200, z: 0 },
        40,
        projection,
      );
      const tiny = projectSegment(
        { x: 1e-200, y: 0, z: 0 },
        { x: 1e-200, y: 1e-200, z: 0 },
        40,
        projection,
      );

      for (const result of [unit, huge, tiny]) {
        expect(result.status).toBe("ok");
      }
      expect(huge.segments).toEqual(unit.segments);
      expect(tiny.segments).toEqual(unit.segments);

      const [only] = asSingle(unit.segments);
      expectCloseToPoint(only.start, projection.projectRelative(0, 0));
      expectCloseToPoint(only.end, projection.projectRelative(45, 0));
    },
  );
});

describe("projectSegment diagnostics", () => {
  const east: Vec3 = { x: 1, y: 0, z: 0 };
  const north: Vec3 = { x: 0, y: 1, z: 0 };
  const antipode: Vec3 = { x: -1, y: 0, z: 0 };
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  const nonFinite: ReadonlyArray<Vec3> = [
    { x: Number.NaN, y: 0, z: 1 },
    { x: 0, y: Number.NEGATIVE_INFINITY, z: 1 },
    { x: Number.POSITIVE_INFINITY, y: 0, z: 1 },
  ];

  it.each(planarProjections())("reports invalid vectors on %s", (_id, projection) => {
    expectDiagnostic(projectSegment(zero, east, 14, projection), "invalid");
    expectDiagnostic(projectSegment(east, zero, 14, projection), "invalid");
    for (const bad of nonFinite) {
      expectDiagnostic(projectSegment(bad, east, 14, projection), "invalid");
      expectDiagnostic(projectSegment(east, bad, 14, projection), "invalid");
    }
  });

  it.each(planarProjections())(
    "reports coincident endpoints as degenerate on %s",
    (_id, projection) => {
      expectDiagnostic(
        projectSegment(spherePoint(12, 34), spherePoint(12, 34), 14, projection),
        "degenerate",
      );
      // Same direction at a different radius is still the same point.
      expectDiagnostic(
        projectSegment(
          spherePoint(12, 34, R),
          spherePoint(12, 34, 1),
          14,
          projection,
        ),
        "degenerate",
      );
      // 1e-11 degrees is about two millimetres: below the angular threshold.
      expectDiagnostic(
        projectSegment(
          spherePoint(12, 34),
          spherePoint(12 + 1e-11, 34),
          14,
          projection,
        ),
        "degenerate",
      );
    },
  );

  it.each(planarProjections())(
    "reports edges that are not short arcs as unsupported on %s",
    (_id, projection) => {
      // Exactly a quarter turn and a half turn are both outside the domain.
      expectDiagnostic(projectSegment(east, north, 14, projection), "unsupported");
      expectDiagnostic(
        projectSegment(east, antipode, 14, projection),
        "unsupported",
      );
      expectDiagnostic(
        projectSegment(spherePoint(0, 0), spherePoint(179.999, 0), 14, projection),
        "unsupported",
      );
      // A hair under a quarter turn is still outside the conservative domain.
      const almostQuarter = normalize({ x: 1e-11, y: 1, z: 0 });
      expectDiagnostic(projectSegment(east, almostQuarter, 14, projection), "unsupported");
    },
  );

  it.each(planarProjections())(
    "still accepts an edge just inside the supported angular limit on %s",
    (_id, projection) => {
      const justInside = normalize({ x: 1e-9, y: 1, z: 0 });
      const result = projectSegment(east, justInside, 14, projection);
      expect(result.status).toBe("ok");
      expect(result.segments).toHaveLength(1);
    },
  );
});
