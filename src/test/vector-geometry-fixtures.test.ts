// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Cartesian3, Geometry, GeometryInstance } from "cesium";
import { describe, expect, it } from "vitest";
import { AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { prepareSphericalPolygons, sampleSphericalLine } from "../layers/spherical-vector-geometry";

const radius = 6_371_000;
type Position = [number, number];
const fixture = JSON.parse(readFileSync("data/goal-fixtures/vectors.geojson", "utf8"));
const badFixture = JSON.parse(readFileSync("data/goal-fixtures/invalid-geometries.json", "utf8"));
const geometryOf = (id: string) => fixture.features.find((feature: { id: string }) => feature.id === id).geometry;
const polygon = (rings: Position[][]) => ({ type: "Polygon", coordinates: rings });
const square: Position[] = [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]];

function vertices(instance: GeometryInstance): Cartesian3[] {
  const geometry = instance.geometry as Geometry;
  const values = Array.from(geometry.attributes.position!.values);
  expect(geometry.indices!.length).toBeGreaterThan(0);
  return Array.from({ length: values.length / 3 }, (_, index) => Cartesian3.fromArray(values, index * 3));
}

function expectSphere(points: Cartesian3[]) {
  expect(points.length).toBeGreaterThan(0);
  for (const point of points) {
    expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
    // Native double-precision CPU geometry check, not a GPU/scientific tolerance.
    expect(Cartesian3.magnitude(point)).toBeCloseTo(radius, 6);
  }
}

describe("bounded spherical line preparation", () => {
  it("uses the independent great-circle midpoint instead of WGS84 interpolation", () => {
    const positions = sampleSphericalLine([[0, 45], [90, 45]]);
    expectSphere(positions);
    const middle = positions[(positions.length - 1) / 2]!;
    const longitude = Math.atan2(middle.y, middle.x) * 180 / Math.PI;
    const latitude = Math.asin(middle.z / radius) * 180 / Math.PI;
    // Normalize ((sqrt(.5),0,sqrt(.5)) + (0,sqrt(.5),sqrt(.5))).
    expect(longitude).toBeCloseTo(45, 9);
    expect(latitude).toBeCloseTo(54.735610317245346, 9);
    for (const point of positions) {
      expect((point.x + point.y - point.z) / radius).toBeCloseTo(0, 12);
    }
  });

  it("takes the short antimeridian arc and retains source coordinates", () => {
    const source: Position[] = [[170, 0], [-170, 0]];
    const before = JSON.stringify(source);
    const positions = sampleSphericalLine(source);
    expect(positions.length).toBeLessThan(30);
    expect(positions.every(point => point.x < 0)).toBe(true);
    expect(positions[(positions.length - 1) / 2]!.x).toBeCloseTo(-radius, 6);
    expect(JSON.stringify(source)).toBe(before);
    expectSphere(positions);
  });

  it("handles high-latitude arcs without a longitude-plane shortcut", () => {
    const positions = sampleSphericalLine([[-45, 80], [45, 80]]);
    const middle = positions[(positions.length - 1) / 2]!;
    expect(middle.y).toBeCloseTo(0, 6);
    expect(Math.asin(middle.z / radius) * 180 / Math.PI).toBeCloseTo(82.89292388955346, 9);
    expectSphere(positions);
  });

  it("keeps multipart source vertices while bounding each returned line", () => {
    const lines = geometryOf("multiple-lines").coordinates as Position[][];
    for (const line of lines) {
      const positions = sampleSphericalLine(line);
      expectSphere(positions);
      expect(positions.length).toBeLessThanOrEqual(8192);
    }
  });

  it.each([[], [[0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 91]], [[0, 0], [NaN, 0]], [[180, 0], [-180, 0]]].map(coordinates => ({ coordinates })))(
    "rejects an empty, degenerate or invalid line $coordinates", ({ coordinates }) => {
      expect(() => sampleSphericalLine(coordinates)).toThrow(AgentActionValidationError);
    },
  );

  it("rejects unconfirmed heights and native near-antipodal ambiguity", () => {
    expect(() => sampleSphericalLine([[0, 0, 0], [1, 1, 0]])).toThrow(AgentActionUnsupportedError);
    expect(() => sampleSphericalLine([[0, 0], [180, 0]])).toThrow(AgentActionUnsupportedError);
  });

  it("rejects a small source whose sampled output would exceed the budget", () => {
    const zigzag = Array.from({ length: 60 }, (_, index) => [index % 2 ? 170 : 0, 0]);
    expect(() => sampleSphericalLine(zigzag)).toThrow(AgentActionUnsupportedError);
  });

  it("rejects sparse line positions explicitly", () => {
    expect(() => sampleSphericalLine([[0, 0], , [10, 10]])).toThrow(AgentActionValidationError);
  });
});

describe("native spherical polygon preparation", () => {
  it.each(["ordinary-polygon", "polygon-hole", "seam-polygon", "polar-polygon", "reversed-winding-polygon"])(
    "prepares %s on the project sphere without altering source geometry", id => {
      const source = geometryOf(id);
      const before = JSON.stringify(source);
      const pickId = { layerId: 17, featureId: id };
      const instances = prepareSphericalPolygons(source, pickId);
      expect(instances).toHaveLength(1);
      expect(instances[0]!.id).toBe(pickId);
      expectSphere(vertices(instances[0]!));
      expect(JSON.stringify(source)).toBe(before);
    },
  );

  it("retains every MultiPolygon part with one business pick identity", () => {
    const key = { layerId: 19, featureId: "multipart" };
    const instances = prepareSphericalPolygons(geometryOf("split-seam-multipolygon"), key);
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance.id).toBe(key);
      expectSphere(vertices(instance));
    }
  });

  it("keeps the hole empty in the actual native triangles and preserves its area", () => {
    const source = geometryOf("polygon-hole");
    const instance = prepareSphericalPolygons(source, "hole")[0]!;
    const points = vertices(instance);
    const indices = (instance.geometry as Geometry).indices!;
    // Independent radial chart: n=(-30deg,-10deg), x=east, y=north.
    const lon = -Math.PI / 6, lat = -Math.PI / 18;
    const n = new Cartesian3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const east = new Cartesian3(-Math.sin(lon), Math.cos(lon), 0);
    const north = Cartesian3.cross(n, east, new Cartesian3());
    const project = (point: Cartesian3): Position => [Cartesian3.dot(point, east) / Cartesian3.dot(point, n), Cartesian3.dot(point, north) / Cartesian3.dot(point, n)];
    const fromDegrees = ([x, y]: Position) => new Cartesian3(Math.cos(y * Math.PI / 180) * Math.cos(x * Math.PI / 180), Math.cos(y * Math.PI / 180) * Math.sin(x * Math.PI / 180), Math.sin(y * Math.PI / 180));
    const area = (ring: Position[]) => Math.abs(ring.reduce((sum, p, index) => { const q = ring[(index + 1) % ring.length]!; return sum + p[0] * q[1] - p[1] * q[0]; }, 0)) / 2;
    const cross = (a: Position, b: Position, p: Position) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const triangles: Position[][] = [];
    for (let i = 0; i < indices.length; i += 3) triangles.push([project(points[indices[i]!]!), project(points[indices[i + 1]!]!), project(points[indices[i + 2]!]!)]);
    const sourceRings = (source.coordinates as Position[][]).map(ring => ring.map(point => project(fromDegrees(point))));
    expect(triangles.reduce((sum, triangle) => sum + area(triangle), 0)).toBeCloseTo(area(sourceRings[0]!) - area(sourceRings[1]!), 10);
    for (const x of [-34, -32, -30, -28, -26]) for (const y of [-14, -12, -10, -8, -6]) {
      const point = project(fromDegrees([x, y]));
      expect(triangles.some(([a, b, c]) => {
        const signs = [cross(a!, b!, point), cross(b!, c!, point), cross(c!, a!, point)];
        return signs.every(sign => sign >= -1e-14) || signs.every(sign => sign <= 1e-14);
      })).toBe(false);
    }
  });

  it("accepts a concave ring, reversed rings and a small true polar cap", () => {
    const concave: Position[] = [[0, 0], [20, 0], [20, 20], [10, 10], [0, 20], [0, 0]];
    for (const ring of [concave, [...concave].reverse(), [[-135, 80], [-45, 80], [45, 80], [135, 80], [-135, 80]] as Position[]]) {
      expectSphere(vertices(prepareSphericalPolygons(polygon([ring]), "shape")[0]!));
    }
  });

  it.each(["unclosed-ring", "empty-polygon", "degenerate-ring"])("rejects the controlled bad fixture %s", id => {
    const source = badFixture.cases.find((item: { id: string }) => item.id === id).feature.geometry;
    expect(() => prepareSphericalPolygons(source, id)).toThrow(AgentActionValidationError);
  });

  it.each([
    [[-10, -10], [10, 10], [-10, 10], [10, -10], [-10, -10]],
    [[0, 0], [20, 0], [10, 0], [10, 10], [0, 0]],
    [[0, 0], [10, 0], [10, 10], [0, 0], [-10, 10], [0, 0]],
  ].map(ring => ({ ring })))("rejects self-crossing, adjacent backtracking and self-touching rings $ring", ({ ring }) => {
    expect(() => prepareSphericalPolygons(polygon([ring as Position[]]), "bad")).toThrow(AgentActionValidationError);
  });

  it.each([
    [[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]],
    [[0, -5], [15, -5], [15, 5], [0, 5], [0, -5]],
    [[-10, -10], [-5, -5], [-5, 0], [-10, -10]],
    [[0, 0], [1, 0], [2, 0], [0, 0]],
  ].map(ring => ({ ring })))("rejects outside, crossing, touching or degenerate holes $ring", ({ ring }) => {
    expect(() => prepareSphericalPolygons(polygon([square, ring as Position[]]), "bad-hole")).toThrow(AgentActionValidationError);
  });

  it("rejects intersecting or nested holes instead of silently filling them", () => {
    const first: Position[] = [[-5, -5], [3, -5], [3, 3], [-5, 3], [-5, -5]];
    const crossing: Position[] = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
    const nested: Position[] = [[-2, -2], [0, -2], [0, 0], [-2, 0], [-2, -2]];
    for (const second of [crossing, nested]) expect(() => prepareSphericalPolygons(polygon([square, first, second]), "bad-holes")).toThrow(AgentActionValidationError);
  });

  it("rejects a back-hemisphere hole even though the native chart can reverse its ray", () => {
    const back: Position[] = [[170, -1], [175, -1], [175, 1], [170, 1], [170, -1]];
    expect(() => prepareSphericalPolygons(polygon([square, back]), "outside-domain")).toThrow(AgentActionUnsupportedError);
  });

  it("rejects small crossing edges inside a much larger ring instead of treating uncertain signs as disjoint", () => {
    const crossing: Position[] = [[-0.00001, 0], [0.00001, 0], [0, -0.00001], [0, 0.00001], [10, 10], [-10, 10], [-0.00001, 0]];
    expect(() => prepareSphericalPolygons(polygon([crossing]), "tiny-crossing")).toThrow(AgentActionValidationError);
  });

  it("rejects unsupported height/domain, source budgets and any bad multipart member", () => {
    expect(() => prepareSphericalPolygons({ type: "Polygon", coordinates: [square.map(point => [...point, 0])] }, "height")).toThrow(AgentActionUnsupportedError);
    const huge = Array.from({ length: 103 }, () => [square]);
    expect(() => prepareSphericalPolygons({ type: "MultiPolygon", coordinates: huge }, "large")).toThrow(AgentActionUnsupportedError);
    expect(() => prepareSphericalPolygons({ type: "MultiPolygon", coordinates: [[square], []] }, "partial")).toThrow(AgentActionValidationError);
    expect(() => prepareSphericalPolygons({ type: "Polygon", coordinates: [[[0, 0], [120, 0], [-120, 0], [0, 0]]] }, "hemisphere")).toThrow(AgentActionUnsupportedError);
  });

  it("rejects sparse parts and holes instead of returning a partial sparse mesh array", () => {
    expect(() => prepareSphericalPolygons({ type: "MultiPolygon", coordinates: Array(1) }, "sparse")).toThrow(AgentActionValidationError);
    expect(() => prepareSphericalPolygons({ type: "Polygon", coordinates: [square, , square] }, "sparse-hole")).toThrow(AgentActionValidationError);
    expect(() => prepareSphericalPolygons({ type: "Polygon", coordinates: [[[0, 0], [10, 0], , [0, 0]]] }, "sparse-position")).toThrow(AgentActionValidationError);
    expect(() => prepareSphericalPolygons({ type: "MultiPolygon", coordinates: Array(10000) }, "oversized-sparse")).toThrow(AgentActionUnsupportedError);
  });
});
