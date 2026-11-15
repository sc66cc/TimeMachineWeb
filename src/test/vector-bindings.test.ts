// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Cartesian3, Color, ColorGeometryInstanceAttribute, DataSourceCollection, Event, JulianDate, Material, Matrix4, PerInstanceColorAppearance, PointPrimitiveCollection, PolylineCollection, Primitive, PrimitiveCollection, type PointPrimitive, type Polyline, type GeometryInstance, type Viewer } from "cesium";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";
import { attachVectorLayer } from "../layers/vector-bindings";

// jsdom lacks this browser type; only Material type detection needs it.
beforeAll(() => {
  vi.stubGlobal("ImageBitmap", class ImageBitmap {});
  vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});
});
const time = JulianDate.fromIso8601("2026-11-14T00:00:00Z");
const point = (id: string | number | undefined = undefined, properties: Record<string, unknown> | null = {}) => ({
  type: "Feature", ...(id === undefined ? {} : { id }), properties,
  geometry: { type: "Point", coordinates: [0, 0] },
});
const source = (features: unknown[], sourceRef = "fixture:points-v1") => ({
  sourceRef, geojson: { type: "FeatureCollection", features },
});
const fixture = JSON.parse(readFileSync("data/goal-fixtures/vectors.geojson", "utf8"));
const fixturePoints = fixture.features.filter((feature: { geometry: { type: string } }) => ["Point", "MultiPoint"].includes(feature.geometry.type));
const fixtureLines = fixture.features.filter((feature: { geometry: { type: string } }) => ["LineString", "MultiLineString"].includes(feature.geometry.type));
const lineSource = (features: unknown[] = fixtureLines) => ({ ...source(features, "fixture:goal-lines-v1"), kind: "line" as const });
const fixturePolygons = fixture.features.filter((feature: { geometry: { type: string } }) => ["Polygon", "MultiPolygon"].includes(feature.geometry.type));
const polygonSource = () => ({ ...source(fixturePolygons, "fixture:goal-polygons-v1"), kind: "polygon" as const });

function harness() {
  const dataSources = new DataSourceCollection();
  const primitives = new PrimitiveCollection();
  const scene = { primitives, requestRender: vi.fn(), isDestroyed: () => false, postRender: new Event() };
  return { dataSources, primitives, scene, viewer: { dataSources, scene } as unknown as Viewer };
}
function controlFill(primitive: Primitive) {
  let ready = false;
  Object.defineProperty(primitive, "ready", { configurable: true, get: () => ready });
  const instances = primitive.geometryInstances as GeometryInstance[];
  const attributes = new Map(instances.map(instance => [instance.id, { color: Uint8Array.from(instance.attributes.color.value) }]));
  const get = vi.spyOn(primitive, "getGeometryInstanceAttributes").mockImplementation(id => {
    if (!ready) throw new Error("Synthetic GPU boundary is not ready");
    return attributes.get(id);
  });
  return { instances, attributes, get, setReady: () => { ready = true; } };
}
afterEach(() => vi.restoreAllMocks());

const pointCollection = (h: ReturnType<typeof harness>, index = 0) => h.primitives.get(index) as PointPrimitiveCollection;
const pointValues = (collection: PointPrimitiveCollection) => Array.from({ length: collection.length }, (_, i) => collection.get(i));
const pointPick = (collection: PointPrimitiveCollection, point: PointPrimitive = collection.get(0)) => ({ primitive: point, collection, id: point.id });

describe("ordinary point native bindings", () => {
  it("binds Point/MultiPoint on the project sphere in a hidden directly owned collection", async () => {
    const h = harness(), before = JSON.stringify(fixturePoints);
    const handle = await attachVectorLayer(h.viewer, 103, source(fixturePoints));
    const collection = pointCollection(h), values = pointValues(collection);
    expect(collection).toBeInstanceOf(PointPrimitiveCollection); expect("dataSource" in handle).toBe(false); expect(h.dataSources.length).toBe(0);
    expect(collection.show).toBe(false); expect(values).toHaveLength(10);
    const origin = values.find(point => handle.resolvePick(pointPick(collection, point))?.featureId === "origin")!;
    expect(origin.position).toEqual(new Cartesian3(6_395_000, 0, 0)); expect(origin.pixelSize).toBe(6);
    expect(origin.id).toEqual({ layerId: 103, featureId: "origin", part: 0 });
    expect(handle.getAttributes("origin")).toMatchObject({ plateId: 101, validTimeMa: { youngest: 0, oldest: 100, endpoints: "inclusive" } });
    const multi = values.filter(point => handle.resolvePick(pointPick(collection, point))?.featureId === "world-points");
    expect(multi).toHaveLength(8); expect(new Set(multi.map(point => point.id)).size).toBe(8);
    expect(multi.map(point => point.id.part)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.stringify(fixturePoints)).toBe(before); expect(h.scene.postRender.numberOfListeners).toBe(0);
    handle.dispose(); expect(collection.isDestroyed()).toBe(true);
  });

  it.each([120, -500])("preserves source height %s and adds only a display offset on SPHERICAL_EARTH", async height => {
    const h = harness(), feature = point(); feature.geometry.coordinates = [90, 30, height];
    const original = JSON.stringify(feature);
    const handle = await attachVectorLayer(h.viewer, 1, source([feature])); const position = pointCollection(h).get(0).position;
    expect(Cartesian3.distance(position, Cartesian3.fromDegrees(90, 30, height + 24_000, SPHERICAL_EARTH))).toBeLessThan(1e-8);
    expect(Math.abs(Cartesian3.magnitude(position) - (6_371_000 + height + 24_000))).toBeLessThan(1e-8);
    expect(JSON.stringify(feature)).toBe(original); handle.dispose();
  });

  it("keeps typed source attributes outside native points and returns independent redacted copies", async () => {
    const h = harness(), properties = { number: 12.5, zero: 0, enabled: false, missing: null, label: "海洋 Δ", nested: { values: [1, true, null] }, token: "synthetic-secret" };
    const handle = await attachVectorLayer(h.viewer, 1, source([point("attributes", properties)]));
    properties.number = 99; properties.nested.values[0] = 77;
    expect(handle.getAttributes("attributes")).toEqual({ number: 12.5, zero: 0, enabled: false, missing: null, label: "海洋 Δ", nested: { values: [1, true, null] }, token: "[redacted]" });
    const copy = handle.getAttributes("attributes")!; copy.number = 88; expect(handle.getAttributes("attributes")?.number).toBe(12.5);
    expect(pointCollection(h).get(0).id).toEqual({ layerId: 1, featureId: "attributes", part: 0 });
    expect(handle.getAttributes("missing-feature")).toBeUndefined(); handle.dispose();
  });

  it("distinguishes null attributes from a missing feature", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 1, { sourceRef: "fixture:single", geojson: point("null-properties", null) });
    expect(handle.getAttributes("null-properties")).toBeNull(); expect(handle.getAttributes("unknown")).toBeUndefined(); handle.dispose();
  });

  it("keeps generated IDs stable across same-source layers and each multipart point", async () => {
    const h = harness(), features = [point(undefined), { ...point(undefined), geometry: { type: "MultiPoint", coordinates: [[10, 0], [20, 0]] } }];
    const first = await attachVectorLayer(h.viewer, 1, source(features)), second = await attachVectorLayer(h.viewer, 2, source(features));
    const keys = pointValues(pointCollection(h)).map(point => first.resolvePick(pointPick(pointCollection(h), point))!);
    expect(keys.map(key => key.featureId)).toEqual(["fixture:points-v1#feature:0", "fixture:points-v1#feature:1", "fixture:points-v1#feature:1"]);
    expect(pointValues(pointCollection(h, 1)).map(point => second.resolvePick(pointPick(pointCollection(h, 1), point))!.featureId)).toEqual(keys.map(key => key.featureId));
    const other = await attachVectorLayer(h.viewer, 3, source(features, "fixture:points-v2"));
    expect(other.resolvePick(pointPick(pointCollection(h, 2)))!.featureId).not.toBe(keys[0]!.featureId); first.dispose(); second.dispose(); other.dispose();
  });

  it("isolates same-source layers and requires collection, point and exact ID ownership for picks", async () => {
    const h = harness(), first = await attachVectorLayer(h.viewer, 1, source([point("shared")])), second = await attachVectorLayer(h.viewer, 2, source([point("shared")]));
    const a = pointCollection(h), b = pointCollection(h, 1), value = a.get(0), picked = pointPick(a);
    expect(first.resolvePick(picked)).toEqual({ layerId: 1, featureId: "shared", sourceRef: "fixture:points-v1" });
    expect(second.resolvePick(picked)).toBeUndefined(); expect(first.resolvePick({ ...picked, collection: b })).toBeUndefined();
    expect(first.resolvePick({ ...picked, id: { ...value.id } })).toBeUndefined(); expect(first.resolvePick({ ...picked, primitive: b.get(0) })).toBeUndefined();
    expect(first.resolvePick({ id: value.id })).toBeUndefined();
    first.setVisible(true); first.setOpacity(0.25); expect(a.show).toBe(true); expect(b.show).toBe(false);
    expect(value.color.alpha).toBe(0.25); expect(b.get(0).color.alpha).toBe(1);
    first.setOpacity(0); expect(value.color.alpha).toBe(0); expect(() => first.setOpacity(NaN)).toThrow(/opacity/i);
    first.dispose(); first.dispose(); expect(a.isDestroyed()).toBe(true); expect(h.primitives.length).toBe(1);
    expect(first.resolvePick(picked)).toBeUndefined(); expect(first.getAttributes("shared")).toBeUndefined();
    expect(() => first.setVisible(true)).toThrow(/disposed/i); expect(h.primitives.contains(b)).toBe(true); second.dispose();
  });

  it("preserves RGB and size through opacity and visibility and keeps same-source styles independent", async () => {
    const h = harness(), first = await attachVectorLayer(h.viewer, 201, source(fixturePoints)), second = await attachVectorLayer(h.viewer, 202, source([point("shared")]));
    const style = { singleColor: "#123ABC", pointSize: 4.5 }; first.setOpacity(0.25); first.setStyle(style); style.singleColor = "#ffffff"; style.pointSize = 1;
    for (const opacity of [0.25, 0.7, 0]) {
      first.setVisible(true); first.setVisible(false); first.setOpacity(opacity);
      for (const value of pointValues(pointCollection(h))) { expect(value.color).toEqual(Color.fromCssColorString("#123abc")!.withAlpha(opacity)); expect(value.pixelSize).toBe(4.5); }
    }
    expect(pointCollection(h, 1).get(0).color).toEqual(Color.WHITE); expect(pointCollection(h, 1).get(0).pixelSize).toBe(6);
    h.scene.requestRender.mockClear(); expect(() => first.setStyle({ singleColor: "#11223344", pointSize: 4 })).toThrow();
    expect(() => first.setStyle({ singleColor: "#ff0000", pointSize: 9 })).toThrow(); expect(h.scene.requestRender).not.toHaveBeenCalled();
    expect(pointCollection(h).get(0).pixelSize).toBe(4.5); first.dispose(); second.dispose();
    expect(() => first.setStyle({ singleColor: "#ffffff", pointSize: 8 })).toThrow(/disposed/i);
  });

  it("accepts an empty collection and checks actual point show, position, ID, color and size without mutation", async () => {
    const h = harness(), empty = await attachVectorLayer(h.viewer, 1, source([]));
    const state = { visible: false, opacity: 1, style: { singleColor: "#ffffff", pointSize: 6 } };
    expect(empty.matches(state, time)).toBe(true); empty.dispose();
    const handle = await attachVectorLayer(h.viewer, 2, source([point("one")])), collection = pointCollection(h), value = collection.get(0), id = value.id;
    value.show = false; expect(handle.matches(state, time)).toBe(false); value.show = true;
    value.position.x += 1; expect(handle.matches(state, time)).toBe(false); value.position = new Cartesian3(6_395_000, 0, 0);
    value.id = { ...id }; expect(handle.matches(state, time)).toBe(false); value.id = id;
    value.color = Color.RED; expect(handle.matches(state, time)).toBe(false); value.color = Color.WHITE;
    value.pixelSize = 7; expect(handle.matches(state, time)).toBe(false); value.pixelSize = 6; expect(handle.matches(state, time)).toBe(true);
    collection.remove(value); expect(handle.resolvePick({ primitive: value, collection, id })).toBeUndefined(); expect(handle.isAttached()).toBe(false); handle.dispose();
  });

  it.each([
    ["nonfinite longitude", { ...point(), geometry: { type: "Point", coordinates: [NaN, 0] } }],
    ["out-of-range latitude", { ...point(), geometry: { type: "Point", coordinates: [0, 91] } }],
    ["out-of-range longitude", { ...point(), geometry: { type: "Point", coordinates: [181, 0] } }],
    ["extra coordinate dimensions", { ...point(), geometry: { type: "Point", coordinates: [0, 0, 0, 0] } }],
    ["empty multipoint", { ...point(), geometry: { type: "MultiPoint", coordinates: [] } }],
    ["null geometry", { ...point(), geometry: null }],
    ["nonfinite age", point("age", { validTimeMa: { youngest: 0, oldest: Infinity, endpoints: "inclusive" } })],
    ["reversed age range", point("age", { validTimeMa: { youngest: 100, oldest: 0, endpoints: "inclusive" } })],
    ["non-inclusive range", point("age", { validTimeMa: { youngest: 0, oldest: 100, endpoints: "exclusive" } })],
    ["conflicting identity", point("one", { featureId: "another" })],
  ])("rejects %s before attaching anything", async (_name, feature) => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 1, source([feature]))).rejects.toMatchObject({ name: "AgentActionValidationError" });
    expect(h.dataSources.length).toBe(0);
  });

  it("rejects unsupported geometries instead of silently omitting them", async () => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 1, source(fixture.features))).rejects.toMatchObject({ name: "AgentActionUnsupportedError" });
    expect(h.dataSources.length).toBe(0);
  });

  it.each([
    [point("same"), point("same")],
    [point(0), point("0")],
    [point(undefined), point("fixture:points-v1#feature:0")],
  ])("rejects colliding business IDs including generated versus explicit IDs", async (...features) => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 1, source(features))).rejects.toThrow(/duplicate/i);
    expect(h.dataSources.length).toBe(0);
  });

  it("does not attach a pre-cancelled request", async () => {
    const h = harness(), abort = new AbortController(); abort.abort();
    await expect(attachVectorLayer(h.viewer, 1, source([point()]), abort.signal)).rejects.toBeInstanceOf(OperationInterruptedError); expect(h.primitives.length).toBe(0);
  });

  it.each(["cancel", "remove", "throw"] as const)("handles native add observer %s without leaving the candidate", async failure => {
    const h = harness(), old = h.primitives.add(new PointPrimitiveCollection()), abort = new AbortController(), error = new Error("Synthetic add observer failure");
    h.primitives.primitiveAdded.addEventListener(owner => {
      expect(owner.show).toBe(false);
      if (failure === "cancel") abort.abort(new OperationInterruptedError("superseded"));
      else if (failure === "remove") h.primitives.remove(owner); else throw error;
    });
    const result = await attachVectorLayer(h.viewer, 1, source([point()]), abort.signal).catch(error => error);
    if (failure === "throw") expect(result).toBe(error); else expect(result).toMatchObject({ reason: "superseded" });
    expect(h.primitives.length).toBe(1); expect(h.primitives.contains(old)).toBe(true); h.primitives.remove(old);
  });

  it("reports a native remove observer error and leaves a retryable cleanup owner", async () => {
    const h = harness(), abort = new AbortController(), failure = new Error("Synthetic remove observer failure");
    h.primitives.primitiveAdded.addEventListener(() => abort.abort()); const stop = h.primitives.primitiveRemoved.addEventListener(() => { throw failure; });
    const result = await attachVectorLayer(h.viewer, 1, source([point()]), abort.signal).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError); expect(result.errors.flatMap((e: unknown) => e instanceof AggregateError ? e.errors : [e])).toContain(failure);
    expect(h.primitives.length).toBe(0); stop(); result.cleanupHandle.dispose(); expect(result.cleanupHandle.isDetached()).toBe(true);
  });

  it("releases attached ownership from the original signal and removes even when hiding throws", async () => {
    const h = harness(), abort = new AbortController(), handle = await attachVectorLayer(h.viewer, 1, source([point()]), abort.signal), collection = pointCollection(h);
    abort.abort(); await Promise.resolve(); expect(handle.isAttached()).toBe(true);
    Object.defineProperty(collection, "show", { configurable: true, get: () => true, set: () => { throw new Error("Synthetic hide failure"); } });
    expect(() => handle.dispose()).toThrow(); expect(collection.isDestroyed()).toBe(true); expect(h.primitives.length).toBe(0);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("transfers exact cleanup ownership when cancelled attachment cannot destroy its candidate", async () => {
    const h = harness(), abort = new AbortController(); let owner!: PointPrimitiveCollection;
    h.primitives.primitiveAdded.addEventListener(value => { owner = value; vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic destroy failure"); }); abort.abort(); });
    const result = await attachVectorLayer(h.viewer, 1, source([point()]), abort.signal).catch(error => error);
    expect(result).toMatchObject({ name: "VectorAttachmentError" }); expect(owner.isDestroyed()).toBe(false); expect(result.cleanupHandle.isDetached()).toBe(false);
    expect(Object.keys(result)).not.toContain("cleanupHandle"); expect(Object.getOwnPropertyDescriptor(result, "cleanupHandle")?.writable).toBe(false);
    result.cleanupHandle.dispose(); expect(owner.isDestroyed()).toBe(true); result.cleanupHandle.dispose(); expect(result.cleanupHandle.isDetached()).toBe(true);
  });
});

const lineValues = (collection: PolylineCollection) => Array.from({ length: collection.length }, (_, i) => collection.get(i));
const linePick = (collection: PolylineCollection, line: Polyline = collection.get(0)) => ({ primitive: line, collection, id: line.id });

describe("ordinary line native bindings", () => {
  it.each(["cancel", "remove", "throw"] as const)("settles native add observer %s only after candidate cleanup", async failure => {
    const h = harness(), old = h.primitives.add(new PolylineCollection()), abort = new AbortController(), error = new Error("Synthetic Line add observer failure");
    h.primitives.primitiveAdded.addEventListener(owner => {
      expect(owner.show).toBe(false);
      if (failure === "cancel") abort.abort(); else if (failure === "remove") h.primitives.remove(owner); else throw error;
    });
    const result = await attachVectorLayer(h.viewer, 301, lineSource(), abort.signal).catch(error => error);
    if (failure === "throw") expect(result).toBe(error); else expect(result).toMatchObject({ reason: failure === "cancel" ? "cancelled" : "superseded" });
    expect(h.primitives.length).toBe(1); expect(h.primitives.contains(old)).toBe(true); h.primitives.remove(old);
  });

  it("binds sampled spherical lines directly with stable multipart identities and independent materials", async () => {
    const h = harness(), input = lineSource(), before = JSON.stringify(input), handle = await attachVectorLayer(h.viewer, 301, input);
    const collection = h.primitives.get(0) as PolylineCollection, values = lineValues(collection);
    expect(collection).toBeInstanceOf(PolylineCollection); expect(handle.kind).toBe("line"); expect(handle.isAttached()).toBe(true);
    expect("dataSource" in handle).toBe(false); expect(h.dataSources.length).toBe(0); expect(collection.show).toBe(false); expect(values).toHaveLength(5);
    const multi = values.filter(line => handle.resolvePick(linePick(collection, line))?.featureId === "multiple-lines");
    expect(multi).toHaveLength(3); expect(new Set(multi.map(line => line.id)).size).toBe(3); expect(multi.map(line => line.id.part)).toEqual([0, 1, 2]);
    for (const line of values) {
      expect(line.positions.length).toBeGreaterThan(2); expect(line.positions.every(point => Math.abs(Cartesian3.magnitude(point) - 6_395_000) < 1e-6)).toBe(true);
      expect(line.id).toMatchObject({ layerId: 301, part: expect.any(Number) }); expect(handle.resolvePick(linePick(collection, line))?.sourceRef).toBe(input.sourceRef);
    }
    const seam = values.find(line => line.id.featureId === "seam-line")!; expect(seam.positions.every(point => point.x < 0)).toBe(true);
    expect(new Set(values.map(line => line.material)).size).toBe(5); expect(JSON.stringify(input)).toBe(before);
    handle.dispose(); expect(collection.isDestroyed()).toBe(true); expect(handle.isDetached()).toBe(true);
  });

  it("preserves the independently known great-circle midpoint without adding another native arc", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 301, lineSource([{ type: "Feature", id: "midpoint", properties: null, geometry: { type: "LineString", coordinates: [[0, 45], [90, 45]] } }]));
    const positions = (h.primitives.get(0) as PolylineCollection).get(0).positions, midpoint = positions[(positions.length - 1) / 2]!;
    expect(Math.atan2(midpoint.y, midpoint.x) * 180 / Math.PI).toBeCloseTo(45, 10);
    expect(Math.atan2(midpoint.z, Math.hypot(midpoint.x, midpoint.y)) * 180 / Math.PI).toBeCloseTo(54.735610317245346, 10);
    expect(Cartesian3.magnitude(midpoint)).toBeCloseTo(6_395_000, 6); handle.dispose();
  });

  it("preserves style through alpha/show changes and validates collection, actual line and exact pick ID", async () => {
    const h = harness(), first = await attachVectorLayer(h.viewer, 301, lineSource()), second = await attachVectorLayer(h.viewer, 302, lineSource());
    const a = h.primitives.get(0) as PolylineCollection, b = h.primitives.get(1) as PolylineCollection, value = a.get(0), picked = linePick(a);
    expect(first.resolvePick(picked)).toMatchObject({ layerId: 301 }); expect(second.resolvePick(picked)).toBeUndefined();
    expect(first.resolvePick({ ...picked, id: { ...value.id } })).toBeUndefined(); expect(first.resolvePick({ ...picked, collection: b })).toBeUndefined(); expect(first.resolvePick({ ...picked, primitive: b.get(0) })).toBeUndefined();
    const material = value.material, style = { lineColor: "#ff5500", lineWidth: 3.5 };
    first.setStyle({ ...style, lineColor: "#FF5500" }); first.setOpacity(0.2); first.setVisible(true);
    expect(first.matches({ visible: true, opacity: 0.2, style }, time)).toBe(true);
    expect(second.matches({ visible: false, opacity: 1, style: { lineColor: "#38bdf8", lineWidth: 2 } }, time)).toBe(true);
    first.setOpacity(0); first.setVisible(false);
    for (const line of lineValues(a)) { expect(line.material.uniforms.color).toEqual(Color.fromCssColorString("#ff5500")!.withAlpha(0)); expect(line.width).toBe(3.5); }
    expect(value.material).toBe(material); expect(() => first.setStyle({ singleColor: "#ffffff", pointSize: 6 })).toThrow(); expect(() => first.setStyle({ lineColor: "#ffffff", lineWidth: 17 })).toThrow();
    expect(first.matches({ visible: false, opacity: 0, style }, time)).toBe(true); first.dispose(); second.dispose();
  });

  it("checks actual material, width, native identity and membership without mutating them", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 301, lineSource()), collection = h.primitives.get(0) as PolylineCollection, line = collection.get(0), id = line.id;
    const state = { visible: false, opacity: 1, style: { lineColor: "#38bdf8", lineWidth: 2 } };
    line.width = 4; expect(handle.matches(state, time)).toBe(false); expect(line.width).toBe(4); line.width = 2;
    line.material.uniforms.color = Color.RED; expect(handle.matches(state, time)).toBe(false); handle.setStyle(state.style);
    const originalMaterial = line.material, other = Material.fromType("PolylineDash"); line.material = other;
    expect(handle.matches(state, time)).toBe(false); line.material = originalMaterial; other.destroy();
    line.id = { ...id }; expect(handle.matches(state, time)).toBe(false); line.id = id; expect(handle.matches(state, time)).toBe(true);
    collection.remove(line); expect(handle.resolvePick({ primitive: line, collection, id })).toBeUndefined(); expect(handle.matches(state, time)).toBe(false); handle.dispose();
  });

  it("refuses hidden graphics, emptied/replaced coordinates and in-place coordinate mutation", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 301, lineSource()), line = (h.primitives.get(0) as PolylineCollection).get(0);
    const state = { visible: false, opacity: 1, style: { lineColor: "#38bdf8", lineWidth: 2 } }, original = line.positions.map(point => Cartesian3.clone(point));
    line.show = false; expect(handle.matches(state, time)).toBe(false); line.show = true;
    line.positions = []; expect(handle.matches(state, time)).toBe(false); line.positions = original.map(point => Cartesian3.clone(point)); line.positions[0]!.x += 1;
    expect(handle.matches(state, time)).toBe(false); line.positions = original; expect(handle.matches(state, time)).toBe(true); handle.dispose();
  });

  it("rejects sparse point coordinates and retains a valid explicit feature ID on early failures", async () => {
    const h = harness();
    for (const feature of [
      { ...point("early-failure"), geometry: { type: "Point", coordinates: [, 0] } },
      { ...point("early-failure"), geometry: null },
      { ...point("early-failure"), properties: "invalid-properties" },
    ]) {
      await expect(attachVectorLayer(h.viewer, 201, source([feature]))).rejects.toMatchObject({ name: "AgentActionValidationError", featureId: "early-failure" });
      expect(h.dataSources.length).toBe(0);
    }
  });

  it("rejects invalid kinds, geometry-kind mismatches and one bad line without attaching a partial layer", async () => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 301, { ...lineSource(), kind: "polygon" } as never)).rejects.toMatchObject({ name: "AgentActionUnsupportedError" });
    await expect(attachVectorLayer(h.viewer, 301, lineSource([point("not-a-line")]))).rejects.toMatchObject({ name: "AgentActionUnsupportedError" });
    const bad = { type: "Feature", id: "bad-line", properties: { token: "synthetic-secret" }, geometry: { type: "LineString", coordinates: [[0, 0], [180, 0]] } };
    const error = await attachVectorLayer(h.viewer, 301, lineSource([...fixtureLines, bad])).catch(error => error);
    expect(error).toMatchObject({ name: "AgentActionUnsupportedError", featureId: "bad-line" });
    expect(error.message).not.toContain("synthetic-secret"); expect(h.dataSources.length).toBe(0);
  });

  it("does not treat an explicitly null source kind as the omitted point default", async () => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 201, { ...source([point("point")]), kind: null } as never)).rejects.toMatchObject({ name: "AgentActionUnsupportedError" });
    expect(h.dataSources.length).toBe(0);
  });

  it("keeps a failed Line cleanup owner and its detach probe retryable", async () => {
    const h = harness(), abort = new AbortController(); let owner!: PolylineCollection;
    h.primitives.primitiveAdded.addEventListener(value => { owner = value; vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic Line destruction failure"); }); abort.abort(); });
    const error = await attachVectorLayer(h.viewer, 301, lineSource(), abort.signal).catch(error => error);
    expect(error.name).toBe("VectorAttachmentError"); expect(error.cleanupHandle.isDetached()).toBe(false); expect(owner.isDestroyed()).toBe(false);
    error.cleanupHandle.dispose(); expect(error.cleanupHandle.isDetached()).toBe(true); expect(owner.isDestroyed()).toBe(true); expect(Object.keys(error)).not.toContain("cleanupHandle");
  });

  it("does not mark disposal released when a removal boundary silently leaves its owner attached", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 301, lineSource()); vi.spyOn(h.primitives, "remove").mockReturnValueOnce(true);
    expect(() => handle.dispose()).toThrow(); expect(handle.isDetached()).toBe(false); expect(() => handle.dispose()).not.toThrow(); expect(handle.isDetached()).toBe(true);
  });
});

describe("ordinary Polygon native bindings", () => {
  it("rejects an empty Polygon feature collection before creating either native owner", async () => {
    const h = harness();
    await expect(attachVectorLayer(h.viewer, 401, { ...polygonSource(), geojson: { type: "FeatureCollection", features: [] } })).rejects.toMatchObject({ name: "AgentActionValidationError" });
    expect(h.primitives.length).toBe(0); expect(h.dataSources.length).toBe(0);
  });

  it("rejects a fill removed by its native add observer and cleans the remaining boundary owner", async () => {
    const h = harness();
    h.primitives.primitiveAdded.addEventListener(primitive => h.primitives.remove(primitive));
    await expect(attachVectorLayer(h.viewer, 401, polygonSource())).rejects.toMatchObject({ reason: "superseded" });
    expect(h.primitives.length).toBe(0); expect(h.dataSources.length).toBe(0);
  });

  it("owns one hidden fill plus all exterior/hole boundary rings with independent native part IDs", async () => {
    const h = harness(), input = polygonSource(), before = JSON.stringify(input);
    const handle = await attachVectorLayer(h.viewer, 401, input);
    expect(handle.kind).toBe("polygon"); expect(handle.isAttached()).toBe(true);
    expect(h.primitives.length).toBe(2); expect(h.dataSources.length).toBe(0);
    const fill = h.primitives.get(0) as Primitive;
    expect(fill).toBeInstanceOf(Primitive); expect(fill.show).toBe(false); expect("dataSource" in handle).toBe(false);
    expect(fill.appearance).toBeInstanceOf(PerInstanceColorAppearance);
    const instances = fill.geometryInstances as GeometryInstance[];
    expect(instances).toHaveLength(7); expect(new Set(instances.map(instance => instance.id)).size).toBe(7);
    const multi = instances.filter(instance => instance.id.featureId === "split-seam-multipolygon");
    expect(multi).toHaveLength(2);
    for (const instance of multi) expect(handle.resolvePick({ primitive: fill, id: instance.id })).toEqual({ layerId: 401, featureId: "split-seam-multipolygon", sourceRef: input.sourceRef });
    expect(handle.resolvePick({ primitive: fill, id: { ...multi[0]!.id } })).toBeUndefined();
    expect(handle.resolvePick({ primitive: {}, id: multi[0]!.id })).toBeUndefined();
    const collection = h.primitives.get(1) as PolylineCollection;
    expect(collection).toBeInstanceOf(PolylineCollection); expect(collection.show).toBe(false); expect(collection.length).toBe(8);
    const boundaries = Array.from({ length: collection.length }, (_, i) => collection.get(i));
    const pick = (line: typeof boundaries[number]) => ({ primitive: line, collection, id: line.id });
    const holeRings = boundaries.filter(line => handle.resolvePick(pick(line))?.featureId === "polygon-hole");
    expect(holeRings.map(line => line.id.ring)).toEqual([0, 1]);
    for (const line of boundaries) {
      expect(line.id).toMatchObject({ layerId: 401, polygonPart: expect.any(Number), ring: expect.any(Number) });
      expect(line.positions.every(point => Math.abs(Cartesian3.magnitude(point) - 6_395_000) < 1e-6)).toBe(true);
      expect(handle.resolvePick(pick(line))).toMatchObject({ featureId: line.id.featureId });
      expect(handle.resolvePick({ ...pick(line), id: { ...line.id } })).toBeUndefined();
      expect(handle.resolvePick({ ...pick(line), collection: {} })).toBeUndefined();
    }
    expect(new Set(boundaries.map(line => line.material)).size).toBe(8);
    expect(JSON.stringify(input)).toBe(before);
    handle.dispose(); expect(fill.isDestroyed()).toBe(true); expect(handle.isDetached()).toBe(true);
  });

  it("defers every fill part color until ready and compares quantized alpha without mutating matches", async () => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 401, polygonSource());
    const fill = h.primitives.get(0) as Primitive, gpu = controlFill(fill);
    const style = { fillColor: "#ff5500", outlineColor: "#00ff00", outlineWidth: 4.5 };
    handle.setStyle(style); handle.setOpacity(0.3); handle.setVisible(false); handle.prepareFrame();
    expect(gpu.get).not.toHaveBeenCalled(); expect(handle.matches({ visible: false, opacity: 0.3, style }, time)).toBe(false);
    gpu.setReady();
    expect(handle.matches({ visible: false, opacity: 0.3, style }, time)).toBe(false);
    handle.prepareFrame();
    const expected = ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString("#ff5500")!.withAlpha(0.3));
    for (const value of gpu.attributes.values()) expect(value.color).toEqual(expected);
    expect(handle.matches({ visible: false, opacity: 0.3, style }, time)).toBe(true);
    const first = gpu.attributes.values().next().value!; first.color = Uint8Array.from([255, 255, 255, 255]);
    expect(handle.matches({ visible: false, opacity: 0.3, style }, time)).toBe(false);
    expect(first.color).toEqual(Uint8Array.from([255, 255, 255, 255]));
    handle.setOpacity(0);
    for (const value of gpu.attributes.values()) expect(value.color[3]).toBe(0);
    const boundaries = h.primitives.get(1) as PolylineCollection;
    for (let i = 0; i < boundaries.length; i++) {
      expect(boundaries.get(i).material.uniforms.color).toEqual(Color.fromCssColorString("#00ff00")!.withAlpha(0));
      expect(boundaries.get(i).width).toBe(4.5);
    }
    const line = boundaries.get(0), positions = line.positions;
    line.show = false; expect(handle.matches({ visible: false, opacity: 0, style }, time)).toBe(false); line.show = true;
    line.positions = []; expect(handle.matches({ visible: false, opacity: 0, style }, time)).toBe(false); line.positions = positions;
    expect(handle.matches({ visible: false, opacity: 0, style }, time)).toBe(true);
    handle.dispose();
  });

  it.each(["fill", "boundary"] as const)("does not call a half-detached %s layer attached", async detached => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 401, polygonSource());
    const fill = h.primitives.get(0) as Primitive;
    h.primitives.remove(detached === "fill" ? fill : h.primitives.get(1));
    expect(handle.isAttached()).toBe(false); expect(handle.isDetached()).toBe(false);
    expect(handle.resolvePick({ primitive: fill, id: {} })).toBeUndefined();
    handle.dispose(); expect(handle.isDetached()).toBe(true);
  });

  it.each(["fill", "boundary"] as const)("cleans the other container when %s removal fails and retains a retry owner", async failed => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 401, polygonSource());
    const fill = h.primitives.get(0) as Primitive, destroy = vi.spyOn(fill, "destroy");
    const target = failed === "fill" ? fill : h.primitives.get(1), remove = h.primitives.remove.bind(h.primitives);
    vi.spyOn(h.primitives, "remove").mockImplementation(owner => { if (owner === target) throw new Error("Synthetic owner remove failure"); return remove(owner); });
    expect(() => handle.dispose()).toThrow(); expect(handle.isDetached()).toBe(false);
    expect(h.primitives.length).toBe(1); vi.mocked(h.primitives.remove).mockRestore();
    handle.dispose(); expect(handle.isDetached()).toBe(true); expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["fill", "boundary"] as const)("retries %s destruction after native collection membership was removed", async failed => {
    const h = harness(), handle = await attachVectorLayer(h.viewer, 401, polygonSource());
    const fill = h.primitives.get(failed === "fill" ? 0 : 1) as Primitive | PolylineCollection;
    const destroy = vi.spyOn(fill, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic fill destruction failure"); });
    expect(() => handle.dispose()).toThrow(); expect(h.primitives.length).toBe(0); expect(h.dataSources.length).toBe(0);
    expect(fill.isDestroyed()).toBe(false); handle.dispose(); expect(fill.isDestroyed()).toBe(true); expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("hands back a direct cleanup owner when cancellation and boundary destruction fail during attachment", async () => {
    const h = harness(), abort = new AbortController();
    let boundary: PolylineCollection | undefined;
    h.primitives.primitiveAdded.addEventListener(owner => {
      if (owner instanceof PolylineCollection) {
        boundary = owner; vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic attach cleanup failure"); }); abort.abort();
      }
    });
    const error = await attachVectorLayer(h.viewer, 401, polygonSource(), abort.signal).catch(error => error);
    expect(error.name).toBe("VectorAttachmentError"); expect(error.cleanupHandle.isDetached()).toBe(false);
    expect(boundary!.isDestroyed()).toBe(false); expect(Object.keys(error)).not.toContain("cleanupHandle");
    error.cleanupHandle.dispose(); expect(error.cleanupHandle.isDetached()).toBe(true); expect(boundary!.isDestroyed()).toBe(true);
  });

  it("keeps same-source fill and boundary styles independent and rejects a bad polygon before either attachment", async () => {
    const h = harness(), first = await attachVectorLayer(h.viewer, 401, polygonSource()), second = await attachVectorLayer(h.viewer, 402, polygonSource());
    const a = controlFill(h.primitives.get(0)), b = controlFill(h.primitives.get(2)); a.setReady(); b.setReady();
    first.setStyle({ fillColor: "#ff0000", outlineColor: "#0000ff", outlineWidth: 7 }); first.setOpacity(0.2); first.setVisible(true); first.prepareFrame(); second.prepareFrame();
    expect(a.attributes.values().next().value!.color).toEqual(ColorGeometryInstanceAttribute.toValue(Color.RED.withAlpha(0.2)));
    expect(b.attributes.values().next().value!.color).toEqual(ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString("#38bdf8")!));
    expect((h.primitives.get(3) as PolylineCollection).show).toBe(false);
    const bad = { ...fixturePolygons[0], geometry: { type: "Polygon", coordinates: [] } };
    await expect(attachVectorLayer(h.viewer, 403, { ...polygonSource(), geojson: { type: "FeatureCollection", features: [bad] } })).rejects.toMatchObject({ name: "AgentActionValidationError" });
    expect(h.primitives.length).toBe(4); expect(h.dataSources.length).toBe(0); first.dispose(); second.dispose();
  });
});


describe("display-only native vector offset", () => {
  it("keeps Polygon source geometry on R while its public transform and every boundary display above Plate", async () => {
    const h = harness(), input = polygonSource(), original = JSON.stringify(input);
    const handle = await attachVectorLayer(h.viewer, 401, input);
    const fill = h.primitives.get(0) as Primitive, boundary = h.primitives.get(1) as PolylineCollection;
    const expectedMatrix = Matrix4.fromUniformScale((6_371_000 + 24_000) / 6_371_000);
    expect(Matrix4.equals(fill.modelMatrix, expectedMatrix)).toBe(true);
    for (const instance of fill.geometryInstances as GeometryInstance[]) {
      const values = instance.geometry.attributes.position!.values;
      for (let i = 0; i < values.length; i += 3) {
        const originalPosition = new Cartesian3(values[i], values[i + 1], values[i + 2]);
        const displayed = Matrix4.multiplyByPoint(fill.modelMatrix, originalPosition, new Cartesian3());
        expect(Cartesian3.magnitude(originalPosition)).toBeCloseTo(6_371_000, 6);
        expect(Cartesian3.magnitude(displayed)).toBeCloseTo(6_395_000, 6);
        expect(Cartesian3.angleBetween(originalPosition, displayed)).toBeLessThan(1e-14);
      }
    }
    const hole = Array.from({ length: boundary.length }, (_, i) => boundary.get(i)).find(line => line.id.featureId === "polygon-hole" && line.id.ring === 1);
    expect(hole).toBeDefined();
    for (let i = 0; i < boundary.length; i++) for (const value of boundary.get(i).positions) expect(Cartesian3.magnitude(value)).toBeCloseTo(6_395_000, 6);
    expect(JSON.stringify(input)).toBe(original); handle.dispose();
  });

  it.each(["point", "line", "fill", "boundary"] as const)("rejects %s owner matrix changes without repairing them inside matches", async kind => {
    const h = harness(), input = kind === "point" ? source([point("one")]) : kind === "line" ? lineSource() : polygonSource();
    const handle = await attachVectorLayer(h.viewer, 401, input);
    const style = kind === "point" ? { singleColor: "#ffffff", pointSize: 6 } : kind === "line" ? { lineColor: "#38bdf8", lineWidth: 2 } : { fillColor: "#38bdf8", outlineColor: "#ffffff", outlineWidth: 2 };
    if (kind === "fill" || kind === "boundary") { controlFill(h.primitives.get(0)).setReady(); handle.prepareFrame(); }
    const owner = h.primitives.get(kind === "boundary" ? 1 : 0) as Primitive | PointPrimitiveCollection | PolylineCollection;
    const original = Matrix4.clone(owner.modelMatrix), state = { visible: false, opacity: 1, style };
    expect(handle.matches(state, time)).toBe(true);
    owner.modelMatrix = Matrix4.fromTranslation(new Cartesian3(1, 2, 3));
    expect(handle.matches(state, time)).toBe(false); expect(owner.modelMatrix[12]).toBe(1);
    owner.modelMatrix = original; expect(handle.matches(state, time)).toBe(true); handle.dispose();
  });
});
