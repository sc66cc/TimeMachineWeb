// @vitest-environment jsdom
import { Cartesian3, Color, ColorGeometryInstanceAttribute, DataSourceCollection, DataSourceDisplay, Event, GroundPrimitive, JulianDate, Material, Matrix4, PerInstanceColorAppearance, PointPrimitiveCollection, PointVisualizer, PolylineCollection, Primitive, PrimitiveCollection, Resource, type Scene, type Viewer } from "cesium";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativePointLayerRuntime } from "../layers/native-point-layer-runtime";
import type { NativePointStyle } from "../layers/native-point-style";
import type { NativeLineStyle } from "../layers/native-line-style";
import type { NativePolygonStyle } from "../layers/native-polygon-style";
import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";

const time = JulianDate.fromIso8601("2026-11-14T00:00:00Z");
const source = { sourceRef: "fixture:goal-points-v1", geojson: {
  type: "FeatureCollection", features: [{ type: "Feature", id: "shared", properties: { label: "海洋", value: 0, enabled: false },
    geometry: { type: "Point", coordinates: [0, 0] } }],
} };
const polygonSource = { kind: "polygon" as const, sourceRef: "fixture:goal-polygons-v1", geojson: {
  type: "FeatureCollection", features: [{ type: "Feature", id: "area", properties: { name: "有洞面" }, geometry: { type: "Polygon", coordinates: [
    [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]],
    [[-5, -5], [-5, 5], [5, 5], [5, -5], [-5, -5]],
  ] } }],
} };
const lineSource = { kind: "line" as const, sourceRef: "fixture:goal-lines-v1", geojson: {
  type: "FeatureCollection", features: [{ type: "Feature", id: "shared-line", properties: { label: "界线", value: 0 },
    geometry: { type: "LineString", coordinates: [[0, 45], [90, 45]] } }],
} };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeAll(async () => {
  // jsdom lacks this browser type; Material only checks its constructor here.
  vi.stubGlobal("ImageBitmap", class ImageBitmap {});
  vi.stubGlobal("OffscreenCanvas", class OffscreenCanvas {});
  vi.stubGlobal("CESIUM_BASE_URL", "http://localhost/cesium/");
  // Public initialization with a controlled, unused terrain asset boundary.
  // These points use HeightReference.NONE and never query terrain heights.
  const fetch = vi.spyOn(Resource, "fetchJson").mockResolvedValue({});
  await GroundPrimitive.initializeTerrainHeights();
  fetch.mockRestore();
});

const cleanups: Array<() => Promise<void>> = [];
function harness(timeoutMs = 30_000, controlFillReadiness = false) {
  const dataSources = new DataSourceCollection();
  const preRender = new Event(), postRender = new Event(), renderError = new Event();
  const primitives = new PrimitiveCollection(), groundPrimitives = new PrimitiveCollection();
  const scene = { preRender, postRender, renderError, primitives, groundPrimitives, ellipsoid: SPHERICAL_EARTH, context: { depthTexture: false },
    camera: { changed: new Event() }, frameState: { context: { depthTexture: false } }, requestRender: vi.fn(), isDestroyed: () => false } as unknown as Scene;
  let ready = true;
  let fillReady = false;
  const lineCollections: PolylineCollection[] = [];
  const fillPrimitives: Primitive[] = [];
  const polygonBoundaries: PolylineCollection[] = [];
  const pointCollections: PointPrimitiveCollection[] = [];
  primitives.primitiveAdded.addEventListener(primitive => {
    if (primitive instanceof PointPrimitiveCollection) { pointCollections.push(primitive); return; }
    if (primitive instanceof PolylineCollection) {
      (primitive.length > 0 && "polygonPart" in primitive.get(0).id ? polygonBoundaries : lineCollections).push(primitive); return;
    }
    if (!controlFillReadiness) return;
    if (!(primitive instanceof Primitive)) return;
    if (!(primitive.appearance instanceof PerInstanceColorAppearance)) return;
    fillPrimitives.push(primitive);
    // Real fill geometry/Primitive/collections; only unavailable GPU completion
    // and uploaded attribute storage are controlled at this public Primitive boundary.
    Object.defineProperty(primitive, "ready", { configurable: true, get: () => fillReady });
    const instances = Array.isArray(primitive.geometryInstances) ? primitive.geometryInstances : [primitive.geometryInstances];
    const attributes = new Map(instances.map(instance => [instance!.id, Object.fromEntries(Object.entries(instance!.attributes).map(([name, attribute]) => [name, (attribute as { value: unknown }).value]))]));
    vi.spyOn(primitive, "getGeometryInstanceAttributes").mockImplementation(id => {
      if (!fillReady) throw new Error("Synthetic fill is not ready for attribute access");
      return attributes.get(id);
    });
  });
  const display = new DataSourceDisplay({ scene, dataSourceCollection: dataSources,
    visualizersCallback: (_scene, cluster, dataSource) => [new PointVisualizer(cluster, dataSource.entities),
      {
      update: () => ready, isDestroyed: () => false, destroy: () => undefined,
    }] });
  const states = new Map<number, { visible: boolean; opacity: number; style?: NativePointStyle | NativeLineStyle | NativePolygonStyle }>();
  const viewer = { scene, dataSources, dataSourceDisplay: display, clock: { currentTime: time }, useDefaultRenderLoop: true } as unknown as Viewer;
  const publish = vi.fn(), diagnostic = vi.fn();
  const runtime = new NativePointLayerRuntime(viewer, {
    readEffectiveState: id => states.get(id), onStateChange: publish, onDiagnostic: diagnostic, timeoutMs,
  });
  const frame = (fault?: "before-post" | "after-post") => {
    if (!viewer.useDefaultRenderLoop) return;
    preRender.raiseEvent(scene, time);
    if (fault === "before-post") { viewer.useDefaultRenderLoop = false; renderError.raiseEvent(scene, new Error("Synthetic draw failure")); }
    postRender.raiseEvent(scene, time);
    if (fault === "after-post") { viewer.useDefaultRenderLoop = false; renderError.raiseEvent(scene, new Error("Synthetic late draw failure")); }
  };
  cleanups.push(async () => {
    await runtime.dispose().catch(() => undefined);
    display.destroy(); dataSources.destroy(); primitives.destroy(); groundPrimitives.destroy();
  });
  return { runtime, viewer, dataSources, display, scene, states, publish, diagnostic, preRender, postRender, renderError, frame,
    setReady: (value: boolean) => { ready = value; }, lineCollections,
    setFillReady: (value: boolean) => { fillReady = value; }, fillPrimitives, polygonBoundaries, pointCollections, activePointCount: () => pointCollections.filter(owner => primitives.contains(owner)).length, primitives };
}
async function addReady(h: ReturnType<typeof harness>, id: number) {
  h.states.set(id, { visible: true, opacity: 1 });
  const result = h.runtime.add(id, source); await flush(); h.frame(); return result;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe("ordinary line runtime shares native frame ownership", () => {
  it.each(["cancel", "remove", "throw"] as const)("handles synchronous primitiveAdded %s without late native ownership", async failure => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 }); const abort = new AbortController(); let owner!: PolylineCollection;
    h.primitives.primitiveAdded.addEventListener(value => {
      if (!(value instanceof PolylineCollection)) return; owner = value; expect(owner.show).toBe(false);
      if (failure === "cancel") abort.abort(); else if (failure === "remove") h.primitives.remove(owner); else throw new Error("Synthetic Line add failure");
    });
    const result = await h.runtime.add(301, lineSource, abort.signal).catch(error => error);
    expect(result).toBeInstanceOf(Error); expect(owner.isDestroyed()).toBe(true); expect(h.runtime.get(301)?.runtimeStatus).toBe("error");
  });

  it("requires a prepared successful frame rather than membership or an orphan postRender", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 0.4 });
    let settled = false; const result = h.runtime.add(301, lineSource).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush(); expect(h.dataSources.length).toBe(0); expect(h.lineCollections).toHaveLength(1); expect(settled).toBe(false);
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false); h.frame(); expect(await result).toMatchObject({ runtimeStatus: "ready" });
    const collection = h.lineCollections[0]!, line = collection.get(0); expect(line.width).toBe(2);
    expect(line.material.uniforms.color).toEqual(Color.fromCssColorString("#38bdf8")!.withAlpha(0.4));
    expect(h.runtime.resolvePick({ primitive: line, collection, id: line.id })).toEqual({ layerId: 301, featureId: "shared-line", sourceRef: lineSource.sourceRef });
  });

  it("keeps hidden/alpha-zero lines and same-source styles independent from native points", async () => {
    const h = harness(); await addReady(h, 201);
    h.states.set(301, { visible: false, opacity: 0, style: { lineColor: "#ff5500", lineWidth: 3.5 } }); h.states.set(302, { visible: true, opacity: 0.7, style: { lineColor: "#00ff00", lineWidth: 7 } });
    const a = h.runtime.add(301, lineSource), b = h.runtime.add(302, lineSource); await flush(); h.frame(); await Promise.all([a, b]);
    const first = h.lineCollections[0]!, second = h.lineCollections[1]!;
    expect(first.show).toBe(false); expect(first.get(0).width).toBe(3.5); expect(first.get(0).material.uniforms.color).toEqual(Color.fromCssColorString("#ff5500")!.withAlpha(0)); expect(second.get(0).width).toBe(7);
    h.states.set(301, { ...h.states.get(301)!, visible: true, opacity: 0.2 }); h.runtime.apply(301);
    expect(first.get(0).material.uniforms.color).toEqual(Color.fromCssColorString("#ff5500")!.withAlpha(0.2)); expect(h.pointCollections[0]!.get(0).pixelSize).toBe(6);
    const removal = h.runtime.remove(301); await flush(); h.frame(); await removal; expect(first.isDestroyed()).toBe(true);
    expect(h.runtime.get(302)?.runtimeStatus).toBe("ready"); expect(h.runtime.get(201)?.runtimeStatus).toBe("ready");
  });

  it("does not confirm a style change after preRender until a new matching frame", async () => {
    const h = harness(), style = { lineColor: "#ff0000", lineWidth: 3 }; h.states.set(301, { visible: true, opacity: 0.3, style });
    let settled = false; const result = h.runtime.add(301, lineSource).then(value => { settled = true; return value; }); await flush(); h.preRender.raiseEvent(h.scene, time);
    style.lineColor = "#0000ff"; style.lineWidth = 8; h.runtime.apply(301); h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false);
    h.frame(); await result; const line = h.lineCollections[0]!.get(0); expect(line.width).toBe(8); expect(line.material.uniforms.color).toEqual(Color.BLUE.withAlpha(0.3));
  });

  it("does not confirm tampered native width, material or ID state", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 }); let settled = false;
    const result = h.runtime.add(301, lineSource).then(value => { settled = true; return value; }); await flush(); h.preRender.raiseEvent(h.scene, time);
    const line = h.lineCollections[0]!.get(0), material = line.material, id = line.id, other = Material.fromType("PolylineDash");
    line.id = { ...id }; line.width = 12; line.material = other; h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false);
    line.id = id; line.width = 2; line.material = material; other.destroy(); h.frame(); await result;
  });

  it.each(["hidden", "empty", "mutated"] as const)("refuses a pending line with %s native geometry", async changed => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 }); let settled = false;
    const result = h.runtime.add(301, lineSource).then(value => { settled = true; return value; }); await flush(); h.preRender.raiseEvent(h.scene, time);
    const line = h.lineCollections[0]!.get(0), original = line.positions.map(point => Cartesian3.clone(point));
    if (changed === "hidden") line.show = false; else if (changed === "empty") line.positions = []; else line.positions[0]!.x += 1;
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false); line.show = true; line.positions = original; h.frame(); await result;
  });

  it.each(["cancel", "before-post", "after-post"] as const)("retains an older layer and waits for cleanup after %s", async failure => {
    const h = harness(); await addReady(h, 201); h.states.set(301, { visible: true, opacity: 1 }); const abort = new AbortController(); let settled = false;
    const result = h.runtime.add(301, lineSource, abort.signal).catch(error => error).then(value => { settled = true; return value; }); await flush();
    if (failure === "cancel") { h.preRender.raiseEvent(h.scene, time); abort.abort(); h.postRender.raiseEvent(h.scene, time); } else h.frame(failure);
    await flush(); expect(settled).toBe(false); expect(h.activePointCount()).toBe(1); expect(h.runtime.get(201)?.runtimeStatus).toBe("ready");
    expect(h.lineCollections[0]!.isDestroyed()).toBe(true); h.frame(); expect(await result).toBeInstanceOf(Error);
  });

  it("retains failed direct Line cleanup after attachment failure and retries the exact owner", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 });
    h.primitives.primitiveAdded.addEventListener(owner => { if (owner instanceof PolylineCollection) { vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic Line destroy failure"); }); throw new Error("Synthetic Line attach fault"); } });
    await expect(h.runtime.add(301, lineSource)).rejects.toThrow(); expect(h.runtime.get(301)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    await expect(h.runtime.add(301, lineSource)).rejects.toThrow(); const removal = h.runtime.remove(301); await flush(); h.frame(); await removal;
    expect(h.lineCollections[0]!.isDestroyed()).toBe(true); expect(h.runtime.get(301)).toBeUndefined();
  });

  it("rewrites the old Line style after a final setter fails and business state rolls back", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 0.4 }); const add = h.runtime.add(301, lineSource); await flush(); h.frame(); await add;
    const owner = h.lineCollections[0]!, line = owner.get(0); let fail = true, show = owner.show;
    Object.defineProperty(owner, "show", { configurable: true, get: () => show, set: value => { if (fail) { fail = false; throw new Error("Synthetic final Line setter failure"); } show = value; } });
    h.states.set(301, { visible: false, opacity: 0.7, style: { lineColor: "#ff0000", lineWidth: 8 } }); expect(() => h.runtime.apply(301)).toThrow();
    h.states.set(301, { visible: true, opacity: 0.4 }); h.runtime.apply(301);
    expect(owner.show).toBe(true); expect(line.width).toBe(2); expect(line.material.uniforms.color).toEqual(Color.fromCssColorString("#38bdf8")!.withAlpha(0.4));
  });

  it("keeps persistent Line destruction errors explicit and retries only the owned collection", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 }); const add = h.runtime.add(301, lineSource); await flush(); h.frame(); await add;
    const owner = h.lineCollections[0]!, destroy = vi.spyOn(owner, "destroy").mockImplementation(() => { throw new Error("Synthetic persistent Line cleanup failure"); });
    await expect(h.runtime.remove(301)).rejects.toThrow(); await expect(h.runtime.remove(301)).rejects.toThrow();
    expect(owner.isDestroyed()).toBe(false); expect(h.runtime.get(301)).toMatchObject({ runtimeStatus: "error", cleanupPending: true }); await expect(h.runtime.add(301, lineSource)).rejects.toThrow();
    destroy.mockRestore(); const retry = h.runtime.remove(301); await flush(); h.frame(); await retry; expect(owner.isDestroyed()).toBe(true); expect(h.runtime.get(301)).toBeUndefined();
  });

  it("accepts an empty Line layer only after a successful empty frame and isolates teardown reentry", async () => {
    const h = harness(); h.states.set(301, { visible: true, opacity: 1 }); let settled = false;
    const add = h.runtime.add(301, { ...lineSource, geojson: { type: "FeatureCollection", features: [] } }).then(value => { settled = true; return value; });
    await flush(); expect(h.lineCollections[0]!.length).toBe(0); h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false); h.frame(); await add;
    let reentrant!: Promise<void>; h.primitives.primitiveRemoved.addEventListener(() => { reentrant = h.runtime.dispose(); });
    await h.runtime.dispose(); await reentrant; expect(h.runtime.getSnapshot()).toEqual([]); expect(h.lineCollections[0]!.isDestroyed()).toBe(true);
  });
  it("retries the exact Line owner after remove splices before destroy throws", async () => {
    const h = harness(30_000, true); h.states.set(301, { visible: true, opacity: 1 });
    const add = h.runtime.add(301, lineSource); void add.catch(() => undefined); await flush(); h.frame(); await flush(); h.frame(); await add;
    const owner = h.lineCollections[0]!;
    const destroy = vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic Line destruction failure"); });
    await expect(h.runtime.remove(301)).rejects.toThrow(); expect(owner.isDestroyed()).toBe(false);
    expect(h.runtime.get(301)).toMatchObject({ runtimeStatus: "error", cleanupPending: true }); await expect(h.runtime.add(301, lineSource)).rejects.toThrow();
    let settled = false;
    const retry = h.runtime.remove(301).then(() => { settled = true; }, error => { settled = true; return error; });
    await flush();
    try {
      expect(settled).toBe(false); h.frame(); expect(await retry).toBeUndefined();
      expect(destroy).toHaveBeenCalledTimes(2); expect(owner.isDestroyed()).toBe(true); expect(h.runtime.get(301)).toBeUndefined();
    } finally { destroy.mockRestore(); if (!owner.isDestroyed()) owner.destroy(); }
  });
});

describe("ordinary Polygon runtime owns both native containers", () => {
  it("rewrites both fill and boundary state after the final setter fails and business state is restored", async () => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 0.3 }); h.setFillReady(true);
    const add = h.runtime.add(401, polygonSource); void add.catch(() => undefined); await flush(); h.frame(); await flush(); h.frame(); await add;
    const fill = h.fillPrimitives[0]!, boundary = h.polygonBoundaries[0]!;
    let fail = true, show = boundary.show;
    Object.defineProperty(boundary, "show", { configurable: true, get: () => show, set: value => {
      if (fail) { fail = false; throw new Error("Synthetic Polygon final setter failure"); } show = value;
    } });
    h.states.set(401, { visible: false, opacity: 0.7, style: { fillColor: "#ff0000", outlineColor: "#0000ff", outlineWidth: 7 } });
    expect(() => h.runtime.apply(401)).toThrow("Synthetic Polygon final setter failure");
    h.states.set(401, { visible: true, opacity: 0.3 }); h.runtime.apply(401);
    for (const instance of fill.geometryInstances as { id: unknown }[]) {
      expect(fill.getGeometryInstanceAttributes(instance.id).color).toEqual(ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString("#38bdf8")!.withAlpha(0.3)));
    }
    for (let i = 0; i < boundary.length; i++) {
      expect(boundary.get(i).material.uniforms.color).toEqual(Color.WHITE.withAlpha(0.3));
      expect(boundary.get(i).width).toBe(2);
    }
    expect(fill.show).toBe(true); expect(boundary.show).toBe(true);
  });

  it("requires a new preRender after fill first becomes ready and applies the latest hidden style", async () => {
    const h = harness(30_000, true); h.states.set(401, { visible: false, opacity: 0.3 });
    let settled = false; const result = h.runtime.add(401, polygonSource).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush();
    expect(h.fillPrimitives).toHaveLength(1); expect(h.fillPrimitives[0]!.show).toBe(false);
    const fill = h.fillPrimitives[0]!;
    h.frame(); await flush(); expect(settled).toBe(false); expect(fill.getGeometryInstanceAttributes).not.toHaveBeenCalled();
    h.states.set(401, { visible: false, opacity: 0.3, style: { fillColor: "#ff5500", outlineColor: "#00ff00", outlineWidth: 4 } }); h.runtime.apply(401);
    h.preRender.raiseEvent(h.scene, time); h.setFillReady(true); h.postRender.raiseEvent(h.scene, time); await flush();
    expect(settled).toBe(false); h.frame(); expect(await result).toMatchObject({ runtimeStatus: "ready" });
    const instance = (fill.geometryInstances as { id: unknown }[])[0]!;
    expect(fill.getGeometryInstanceAttributes(instance.id).color).toEqual(ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString("#ff5500")!.withAlpha(0.3)));
    expect(h.dataSources.length).toBe(0); expect(h.polygonBoundaries[0]!.length).toBe(2);
    expect(h.polygonBoundaries[0]!.get(0).width).toBe(4);
  });

  it("confirms an alpha-zero native collection only on a successful matching frame", async () => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 0 }); h.setFillReady(true);
    let settled = false; const result = h.runtime.add(401, polygonSource).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush(); expect(settled).toBe(false);
    const boundary = h.polygonBoundaries[0]!; expect(boundary.get(0).material.uniforms.color.alpha).toBe(0);
    h.frame(); await result; expect(boundary.show).toBe(true); expect(h.fillPrimitives[0]!.show).toBe(true);
  });

  it("cancels before fill readiness, releases both containers and confirms cleanup without reviving on late readiness", async () => {
    const h = harness(30_000, true); await addReady(h, 201); h.states.set(401, { visible: true, opacity: 1 });
    const abort = new AbortController(); let settled = false;
    const result = h.runtime.add(401, polygonSource, abort.signal).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.frame(); await flush(); abort.abort(); h.postRender.raiseEvent(h.scene, time); await flush();
    expect(h.activePointCount()).toBe(1); expect(h.dataSources.length).toBe(0); expect(h.fillPrimitives[0]!.isDestroyed()).toBe(true); expect(settled).toBe(false);
    h.setFillReady(true); h.frame(); expect(await result).toMatchObject({ reason: "cancelled" });
    expect(h.runtime.get(201)?.runtimeStatus).toBe("ready"); expect(h.runtime.get(401)?.runtimeStatus).toBe("error");
  });

  it.each(["fill", "boundary"] as const)("rejects lost %s ownership and confirms cleanup of the other container", async missing => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 1 });
    let settled = false; const result = h.runtime.add(401, polygonSource).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.frame(); await flush();
    if (missing === "fill") h.primitives.remove(h.fillPrimitives[0]); else h.primitives.remove(h.polygonBoundaries[0]);
    h.frame(); await flush(); expect(settled).toBe(false); expect(h.dataSources.length).toBe(0); expect(h.fillPrimitives[0]!.isDestroyed()).toBe(true);
    h.frame(); expect(await result).toMatchObject({ reason: "superseded" });
  });

  it.each(["before-post", "after-post"] as const)("does not turn a %s render error into a completed Polygon frame", async fault => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 1 }); h.setFillReady(true);
    let settled = false; const result = h.runtime.add(401, polygonSource).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.frame(fault); await flush();
    expect(settled).toBe(false); expect(h.fillPrimitives[0]!.isDestroyed()).toBe(true); expect(h.dataSources.length).toBe(0);
    h.frame(); expect(await result).toBeInstanceOf(Error);
  });

  it.each(["fill", "boundary"] as const)("retains a failed %s destruction after detach and retries the exact owner", async failed => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 1 }); h.setFillReady(true);
    const add = h.runtime.add(401, polygonSource); void add.catch(() => undefined); await flush(); h.frame(); await flush(); h.frame(); await add;
    const fill = failed === "fill" ? h.fillPrimitives[0]! : h.polygonBoundaries[0]!, destroy = vi.spyOn(fill, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic fill destroy failure"); });
    await expect(h.runtime.remove(401)).rejects.toThrow();
    expect(h.runtime.get(401)).toMatchObject({ runtimeStatus: "error", cleanupPending: true }); expect(h.dataSources.length).toBe(0);
    await expect(h.runtime.add(401, polygonSource)).rejects.toThrow();
    const retry = h.runtime.remove(401); await flush(); h.frame(); await retry;
    expect(destroy).toHaveBeenCalledTimes(2); expect(fill.isDestroyed()).toBe(true); expect(h.runtime.get(401)).toBeUndefined();
  });

  it("keeps a repeatedly failing direct boundary owner explicit instead of deleting its runtime record", async () => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 1 }); h.setFillReady(true);
    const add = h.runtime.add(401, polygonSource); await flush(); h.frame(); await add;
    const boundary = h.polygonBoundaries[0]!;
    const destroy = vi.spyOn(boundary, "destroy").mockImplementation(() => { throw new Error("Synthetic persistent native cleanup fault"); });
    await expect(h.runtime.remove(401)).rejects.toThrow(); await expect(h.runtime.remove(401)).rejects.toThrow();
    expect(boundary.isDestroyed()).toBe(false); expect(h.runtime.get(401)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    await expect(h.runtime.add(401, polygonSource)).rejects.toThrow();
    destroy.mockRestore(); const retry = h.runtime.remove(401); await flush(); h.frame(); await retry;
    expect(boundary.isDestroyed()).toBe(true); expect(h.runtime.get(401)).toBeUndefined();
  });


});

describe("ordinary point runtime ownership and native frame completion", () => {
  it("retries the exact Point native owner after remove splices before destroy throws", async () => {
    const h = harness(); await addReady(h, 201);
    const owner = h.pointCollections[0]!;
    const destroy = vi.spyOn(owner, "destroy").mockImplementationOnce(() => { throw new Error("Synthetic Point destruction failure"); });
    await expect(h.runtime.remove(201)).rejects.toThrow();
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    await expect(h.runtime.add(201, source)).rejects.toThrow();
    let settled = false;
    const retry = h.runtime.remove(201).then(() => { settled = true; }, error => { settled = true; return error; });
    await flush();
    try {
      expect(settled).toBe(false);
      h.frame(); expect(await retry).toBeUndefined(); expect(destroy).toHaveBeenCalledTimes(2);
      expect(h.runtime.get(201)).toBeUndefined(); expect(owner.isDestroyed()).toBe(true);
    } finally { destroy.mockRestore(); if (!owner.isDestroyed()) owner.destroy(); }
  });

  it("retains persistent Point destruction failures without losing the exact direct owner", async () => {
    const h = harness(); await addReady(h, 201); const owner = h.pointCollections[0]!;
    const destroy = vi.spyOn(owner, "destroy").mockImplementation(() => { throw new Error("Synthetic persistent Point cleanup failure"); });
    await expect(h.runtime.remove(201)).rejects.toThrow(); await expect(h.runtime.remove(201)).rejects.toThrow();
    expect(owner.isDestroyed()).toBe(false); expect(h.primitives.contains(owner)).toBe(false);
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: true }); await expect(h.runtime.add(201, source)).rejects.toThrow();
    destroy.mockRestore(); const retry = h.runtime.remove(201); await flush(); h.frame(); await retry;
    expect(owner.isDestroyed()).toBe(true); expect(h.runtime.get(201)).toBeUndefined();
  });

  it("confirms a legal empty Point layer only after a successful scene frame", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); let settled = false;
    const result = h.runtime.add(201, { ...source, geojson: { type: "FeatureCollection", features: [] } }).then(value => { settled = true; return value; });
    await flush(); expect(h.pointCollections[0]!.length).toBe(0); expect(settled).toBe(false);
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false); h.frame();
    expect(await result).toMatchObject({ runtimeStatus: "ready" });
  });

  it("reapplies the previous business style after a later native setter fails partway through apply", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 0.4, style: { singleColor: "#ffffff", pointSize: 6 } });
    const add = h.runtime.add(201, source); await flush(); h.frame(); await add;
    const collection = h.pointCollections[0]!, entity = collection.get(0);
    let fail = true, show = collection.show;
    Object.defineProperty(collection, "show", { configurable: true, get: () => show, set: value => {
      if (fail) { fail = false; throw new Error("Synthetic third setter failure"); } show = value;
    } });
    h.states.set(201, { visible: false, opacity: 0.7, style: { singleColor: "#0000ff", pointSize: 8 } });
    expect(() => h.runtime.apply(201)).toThrow("Synthetic third setter failure");
    expect(entity.color).toEqual(Color.BLUE.withAlpha(0.7));
    h.states.set(201, { visible: true, opacity: 0.4, style: { singleColor: "#ffffff", pointSize: 6 } });
    h.runtime.apply(201);
    expect(entity.color).toEqual(Color.WHITE.withAlpha(0.4));
    expect(entity.pixelSize).toBe(6); expect(h.pointCollections[0]!.show).toBe(true);
  });
  it("attaches hidden and waits for an updated successful frame, not membership or an orphan postRender", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 0.25 });
    const hiddenAtAdd: boolean[] = [];
    h.primitives.primitiveAdded.addEventListener(owner => { if (owner instanceof PointPrimitiveCollection) hiddenAtAdd.push(owner.show); });
    let settled = false;
    const result = h.runtime.add(201, source).then(value => { settled = true; return value; });
    void result.catch(() => undefined);
    await flush();
    expect(hiddenAtAdd).toEqual([false]); expect(h.activePointCount()).toBe(1);
    expect(h.runtime.get(201)?.runtimeStatus).toBe("loading"); expect(settled).toBe(false);
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false);
    const update = vi.spyOn(h.display, "update");
    h.frame(); expect(update).toHaveBeenCalledWith(time); await flush();
    expect(await result).toMatchObject({ layerId: 201, runtimeStatus: "ready", cleanupPending: false });
    expect(h.pointCollections[0]!.get(0).color.alpha).toBe(0.25);
    expect(h.preRender.numberOfListeners).toBe(0); expect(h.renderError.numberOfListeners).toBe(0);
  });

  it("keeps two same-source instances independent, with cloned snapshots and attributes", async () => {
    const h = harness(); await addReady(h, 201); await addReady(h, 202);
    expect(h.pointCollections[0]!).not.toBe(h.pointCollections[1]!);
    const entity = h.pointCollections[1]!.get(0);
    expect(h.runtime.resolvePick({ primitive: entity, collection: h.pointCollections[1], id: entity.id })).toEqual({ layerId: 202, featureId: "shared", sourceRef: source.sourceRef });
    const attributes = h.runtime.getAttributes(202, "shared")!; attributes.label = "changed";
    expect(h.runtime.getAttributes(202, "shared")).toEqual({ label: "海洋", value: 0, enabled: false });
    const snapshot = h.runtime.get(202)!; snapshot.runtimeStatus = "error";
    expect(h.runtime.get(202)?.runtimeStatus).toBe("ready");
    h.states.set(201, { visible: false, opacity: 0.2 }); h.runtime.apply(201);
    expect(h.pointCollections[0]!.show).toBe(false); expect(h.pointCollections[1]!.show).toBe(true);
    const removed = h.runtime.remove(201); await flush(); expect(h.activePointCount()).toBe(1);
    expect(h.runtime.get(201)?.runtimeStatus).toBe("removing"); h.frame(); await removed;
    expect(h.runtime.get(201)).toBeUndefined(); expect(h.runtime.get(202)?.runtimeStatus).toBe("ready");
    expect(h.runtime.resolvePick({ primitive: entity, collection: h.pointCollections[1], id: entity.id })?.layerId).toBe(202);
  });

  it("applies latest effective state during loading and accepts hidden or alpha-zero frames", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 });
    const first = h.runtime.add(201, source); void first.catch(() => undefined); await flush();
    h.states.set(201, { visible: false, opacity: 0 }); h.runtime.apply(201);
    h.frame(); await first;
    expect(h.pointCollections[0]!.show).toBe(false);
    h.states.set(202, { visible: true, opacity: 0 }); const second = h.runtime.add(202, source);
    await flush(); h.frame(); await second;
    expect(h.pointCollections[1]!.get(0).color).toEqual(new Color(1, 1, 1, 0));
  });

  it("uses fresh display readiness even when its public ready property is already latched true", async () => {
    const h = harness(); await addReady(h, 201); expect(h.display.ready).toBe(true);
    h.setReady(false); h.states.set(202, { visible: true, opacity: 1 });
    let settled = false; const result = h.runtime.add(202, source).then(value => { settled = true; return value; });
    await flush(); h.frame(); await flush(); expect(settled).toBe(false); expect(h.display.ready).toBe(true);
    h.setReady(true); h.frame(); await result; expect(settled).toBe(true);
  });

  it.each(["before-post", "after-post"] as const)("does not confirm a %s failing frame or its same-stack cleanup", async fault => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 });
    let settled = false; const result = h.runtime.add(201, source).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.frame(fault); await flush();
    expect(h.activePointCount()).toBe(0); expect(settled).toBe(false);
    expect(h.viewer.useDefaultRenderLoop).toBe(true);
    h.frame(); expect(await result).toBeInstanceOf(Error);
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: false });
  });

  it("acknowledges cancellation only after a later successful cleanup frame", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); const abort = new AbortController();
    let settled = false; const result = h.runtime.add(201, source, abort.signal).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.preRender.raiseEvent(h.scene, time); abort.abort(); h.postRender.raiseEvent(h.scene, time);
    await flush(); expect(h.activePointCount()).toBe(0); expect(settled).toBe(false);
    h.frame(); expect(await result).toMatchObject({ reason: "cancelled" });
  });

  it("retains failed release ownership and blocks duplicate IDs until an explicit retry succeeds", async () => {
    const h = harness(); await addReady(h, 201);
    const remove = vi.spyOn(h.primitives, "remove").mockImplementationOnce(() => { throw new Error("Synthetic release failure"); });
    await expect(h.runtime.remove(201)).rejects.toThrow();
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    await expect(h.runtime.add(201, source)).rejects.toThrow();
    expect(h.activePointCount()).toBe(1);
    const retry = h.runtime.remove(201); await flush(); h.frame(); await retry;
    expect(remove).toHaveBeenCalledTimes(2); expect(h.activePointCount()).toBe(0); expect(h.runtime.get(201)).toBeUndefined();
  });

  it("reports a bounded readiness timeout after cleanup and isolates observer failures", async () => {
    vi.useFakeTimers(); const h = harness(100); h.states.set(201, { visible: true, opacity: 1 }); h.setReady(false);
    h.publish.mockImplementation(() => { throw new Error("synthetic-secret-observer"); });
    h.diagnostic.mockRejectedValue(new Error("synthetic diagnostic failure"));
    const result = h.runtime.add(201, source).catch(error => error); await flush(); h.frame();
    await vi.advanceTimersByTimeAsync(100); expect(h.activePointCount()).toBe(0);
    h.setReady(true); h.frame(); expect(await result).toBeInstanceOf(Error);
    expect(JSON.stringify(h.runtime.getSnapshot())).not.toMatch(/synthetic-secret|geojson|coordinates/);
    expect(h.runtime.get(201)?.runtimeStatus).toBe("error");
  });

  it("disposes waiting work without a new frame and rejects later additions", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 });
    const result = h.runtime.add(201, source).catch(error => error); await flush();
    await h.runtime.dispose(); expect(await result).toMatchObject({ reason: "cancelled" });
    expect(h.activePointCount()).toBe(0); expect(h.preRender.numberOfListeners).toBe(0); expect(h.renderError.numberOfListeners).toBe(0);
    await expect(h.runtime.add(201, source)).rejects.toThrow();
  });

  it("retains a dispose failure as error and retries that exact cleanup owner", async () => {
    const h = harness(); await addReady(h, 201);
    const remove = vi.spyOn(h.primitives, "remove").mockImplementationOnce(() => { throw new Error("Synthetic disposal failure"); });
    await expect(h.runtime.dispose()).rejects.toThrow();
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    await h.runtime.dispose();
    expect(remove).toHaveBeenCalledTimes(2); expect(h.runtime.getSnapshot()).toEqual([]); expect(h.activePointCount()).toBe(0);
  });

  it("shares teardown ownership when a native removal observer reenters dispose", async () => {
    const h = harness(); await addReady(h, 201); let reentrant!: Promise<void>;
    const remove = vi.spyOn(h.primitives, "remove");
    h.primitives.primitiveRemoved.addEventListener(() => { reentrant = h.runtime.dispose(); });
    await h.runtime.dispose(); await reentrant;
    expect(remove).toHaveBeenCalledTimes(1); expect(h.runtime.getSnapshot()).toEqual([]);
  });

  it("retains an attachment cleanupHandle without serializing it, then releases it on remove", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 });
    h.primitives.primitiveAdded.addEventListener(() => { throw new Error("Synthetic attachment failure"); });
    vi.spyOn(h.primitives, "remove").mockImplementationOnce(() => { throw new Error("Synthetic attachment cleanup failure"); });
    await expect(h.runtime.add(201, source)).rejects.toThrow();
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: true });
    expect(JSON.stringify(h.runtime.getSnapshot())).not.toMatch(/cleanupHandle|entities|synthetic/i);
    const removal = h.runtime.remove(201); await flush(); expect(h.activePointCount()).toBe(0); h.frame(); await removal;
    expect(h.runtime.get(201)).toBeUndefined();
  });

  it("removes a loading owner immediately and shares its confirmed cleanup frame", async () => {
    const h = harness(); await addReady(h, 202); h.states.set(201, { visible: true, opacity: 1 });
    const add = h.runtime.add(201, source).catch(error => error); await flush();
    const remove = h.runtime.remove(201); const again = h.runtime.remove(201);
    expect(h.activePointCount()).toBe(1); await flush();
    expect(h.runtime.get(201)?.runtimeStatus).toBe("removing");
    h.frame(); await remove; await again;
    expect(await add).toMatchObject({ reason: "superseded" });
    expect(h.runtime.get(201)).toBeUndefined(); expect(h.runtime.get(202)?.runtimeStatus).toBe("ready");
  });

  it("keeps a second recovery render failure on the original add and allows an explicit removal retry", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 });
    const result = h.runtime.add(201, source).catch(error => error); await flush();
    h.frame("before-post"); await flush(); h.frame("before-post");
    const error = await result; expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toHaveLength(2);
    expect(h.runtime.get(201)).toMatchObject({ runtimeStatus: "error", cleanupPending: false });
    const removal = h.runtime.remove(201); await flush(); expect(h.viewer.useDefaultRenderLoop).toBe(true); h.frame(); await removal;
  });

  it("does not confirm state changed between the visualizer update and postRender", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); let settled = false;
    const result = h.runtime.add(201, source).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush(); h.preRender.raiseEvent(h.scene, time);
    h.states.set(201, { visible: false, opacity: 0.4 }); h.runtime.apply(201); h.postRender.raiseEvent(h.scene, time);
    await flush(); expect(settled).toBe(false); h.frame(); await result;
    expect(h.pointCollections[0]!.show).toBe(false);
  });

  it("rejects a lost native owner promptly and confirms the remaining scene before settling", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); let settled = false;
    const result = h.runtime.add(201, source).catch(error => error).then(value => { settled = true; return value; });
    await flush(); h.primitives.remove(h.pointCollections[0]!); h.frame(); await flush();
    expect(settled).toBe(false); h.frame();
    expect(await result).toMatchObject({ reason: "superseded" });
  });

  it("rejects invalid and unknown layers without affecting an existing instance", async () => {
    const h = harness(); await addReady(h, 202); h.states.set(201, { visible: true, opacity: 1 });
    await expect(h.runtime.add(201, { sourceRef: "fixture:invalid", geojson: { type: "Feature", geometry: null } })).rejects.toThrow();
    expect(h.runtime.get(201)?.runtimeStatus).toBe("error"); expect(h.activePointCount()).toBe(1);
    await expect(h.runtime.remove(999)).rejects.toThrow(/Unknown/);
    expect(() => h.runtime.apply(999)).toThrow(/Unknown/);
    expect(h.runtime.get(202)?.runtimeStatus).toBe("ready");
  });

  it("handles a reentrant remove from the first loading observer without a late candidate", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); let removal!: Promise<void>;
    h.publish.mockImplementationOnce(() => { removal = h.runtime.remove(201); });
    const result = h.runtime.add(201, source).catch(error => error); await flush();
    expect(h.activePointCount()).toBe(0); h.frame(); await removal;
    expect(await result).toMatchObject({ reason: "superseded" }); expect(h.runtime.get(201)).toBeUndefined();
  });

  it("does not let an old signal remove a frame that has already completed", async () => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 1 }); const abort = new AbortController();
    const result = h.runtime.add(201, source, abort.signal); await flush(); h.frame(); await result;
    abort.abort(); await flush(); expect(h.runtime.get(201)?.runtimeStatus).toBe("ready"); expect(h.activePointCount()).toBe(1);
  });

  it("applies independent native styles and preserves them through effective opacity and visibility changes", async () => {
    const h = harness();
    h.states.set(201, { visible: true, opacity: 0.2, style: { singleColor: "#123456", pointSize: 4 } });
    h.states.set(202, { visible: true, opacity: 0.7, style: { singleColor: "#ff8800", pointSize: 8 } });
    const first = h.runtime.add(201, source), second = h.runtime.add(202, source);
    void first.catch(() => undefined); void second.catch(() => undefined);
    await flush(); h.frame(); await Promise.all([first, second]);
    const firstPoint = h.pointCollections[0]!.get(0), secondPoint = h.pointCollections[1]!.get(0);
    expect(firstPoint.color).toEqual(Color.fromCssColorString("#123456")!.withAlpha(0.2));
    expect(firstPoint.pixelSize).toBe(4);
    expect(secondPoint.color).toEqual(Color.fromCssColorString("#ff8800")!.withAlpha(0.7));
    expect(secondPoint.pixelSize).toBe(8);
    h.states.set(201, { ...h.states.get(201)!, visible: false, opacity: 0.6 }); h.runtime.apply(201);
    h.states.set(201, { ...h.states.get(201)!, visible: true }); h.runtime.apply(201);
    expect(firstPoint.color).toEqual(Color.fromCssColorString("#123456")!.withAlpha(0.6));
    expect(firstPoint.pixelSize).toBe(4); expect(secondPoint.pixelSize).toBe(8);
  });

  it.each(["apply", "in-place"] as const)("waits for a new frame when loading style changes via %s after preRender", async change => {
    const h = harness(); const style = { singleColor: "#ff0000", pointSize: 4 };
    h.states.set(201, { visible: true, opacity: 0.3, style });
    let settled = false; const result = h.runtime.add(201, source).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush(); h.preRender.raiseEvent(h.scene, time);
    style.singleColor = "#0000ff"; style.pointSize = 7.5;
    if (change === "apply") h.runtime.apply(201);
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false);
    h.frame(); await result;
    const point = h.pointCollections[0]!.get(0);
    expect(point.color).toEqual(Color.BLUE.withAlpha(0.3)); expect(point.pixelSize).toBe(7.5);
  });

  it.each(["color", "size"] as const)("refuses a pending frame whose actual native %s differs from the target", async changed => {
    const h = harness(); h.states.set(201, { visible: true, opacity: 0.4 });
    let settled = false; const result = h.runtime.add(201, source).then(value => { settled = true; return value; });
    void result.catch(() => undefined); await flush(); h.preRender.raiseEvent(h.scene, time);
    const point = h.pointCollections[0]!.get(0);
    if (changed === "color") point.color = Color.RED.withAlpha(0.4);
    else point.pixelSize = 7;
    h.postRender.raiseEvent(h.scene, time); await flush(); expect(settled).toBe(false);
    point.color = Color.WHITE.withAlpha(0.4); point.pixelSize = 6;
    h.frame(); await result;
  });
});


describe("native display matrix frame confirmation", () => {
  it.each(["point", "line", "fill", "boundary"] as const)("does not commit a %s transform changed after preRender", async kind => {
    const h = harness(30_000, true); h.states.set(401, { visible: true, opacity: 1 }); h.setFillReady(true);
    const input = kind === "point" ? source : kind === "line" ? lineSource : polygonSource;
    let settled = false;
    const result = h.runtime.add(401, input).then(value => { settled = true; return value; }); void result.catch(() => undefined);
    await flush(); h.preRender.raiseEvent(h.scene, time);
    const owner = kind === "point" ? h.pointCollections[0]! : kind === "line" ? h.lineCollections[0]! : kind === "fill" ? h.fillPrimitives[0]! : h.polygonBoundaries[0]!;
    const original = Matrix4.clone(owner.modelMatrix);
    owner.modelMatrix = Matrix4.fromTranslation(new Cartesian3(1, 2, 3));
    h.postRender.raiseEvent(h.scene, time); await flush();
    expect(settled).toBe(false); expect(h.runtime.get(401)?.runtimeStatus).toBe("loading");
    owner.modelMatrix = original; h.frame(); expect(await result).toMatchObject({ runtimeStatus: "ready" });
  });
});
