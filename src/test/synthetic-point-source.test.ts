import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSyntheticPointSource, loadSyntheticVectorSource } from "../layers/synthetic-point-source";
afterEach(() => vi.useRealTimers());

describe("explicit synthetic point source", () => {
  it("selects the explicit polygon sample including holes and separate MultiPolygon parts", async () => {
    const source = await loadSyntheticVectorSource("fixture:goal-polygons-v1");
    expect(source).toMatchObject({ kind: "polygon", sourceRef: "fixture:goal-polygons-v1" });
    const features = (source.geojson as { features: { id: string; geometry: { type: string; coordinates: unknown[] } }[] }).features;
    expect(features.map(f => f.id)).toEqual(["ordinary-polygon", "polygon-hole", "seam-polygon", "split-seam-multipolygon", "polar-polygon", "reversed-winding-polygon"]);
    expect(features.find(f => f.id === "polygon-hole")!.geometry.coordinates).toHaveLength(2);
    expect(features.find(f => f.id === "split-seam-multipolygon")!.geometry).toMatchObject({ type: "MultiPolygon" });
    expect(features.find(f => f.id === "split-seam-multipolygon")!.geometry.coordinates).toHaveLength(2);
    await expect(loadSyntheticPointSource("fixture:goal-polygons-v1")).rejects.toMatchObject({ kind: "unsupported" });
  });
  it("loads line and multipart fixture features only through the explicitly selected line source", async () => {
    const source = await loadSyntheticVectorSource("fixture:goal-lines-v1");
    expect(source).toMatchObject({ kind: "line", sourceRef: "fixture:goal-lines-v1" });
    const collection = source.geojson as { features: { id: string; geometry: { type: string } }[] };
    expect(collection.features.map(f => f.id)).toEqual(["ordinary-line", "seam-line", "multiple-lines"]);
    expect(collection.features.map(f => f.geometry.type)).toEqual(["LineString", "LineString", "MultiLineString"]);
    await expect(loadSyntheticPointSource("fixture:goal-lines-v1")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(loadSyntheticVectorSource("service:unavailable")).rejects.toMatchObject({ kind: "unsupported" });
  });
  it("selects the documented fixture records without changing stable IDs or sharing mutable data", async () => {
    const first = await loadSyntheticPointSource("fixture:goal-points-v1");
    const geojson = first.geojson as { features: { id: string; properties: { plateId: number }; geometry: { type: string; coordinates: unknown[] } }[] };
    expect(geojson.features.map(f => f.id)).toEqual(["origin", "origin-other-id", "world-points"]);
    expect(geojson.features.map(f => f.geometry.type)).toEqual(["Point", "Point", "MultiPoint"]);
    expect(geojson.features[2]!.geometry.coordinates).toHaveLength(8);
    geojson.features[0]!.properties.plateId = 9999;
    expect((await loadSyntheticPointSource("fixture:goal-points-v1")).geojson).not.toEqual(geojson);
  });
  it("never falls back from an unknown or service source", async () => {
    await expect(loadSyntheticPointSource("service:missing")).rejects.toMatchObject({ kind: "unsupported" });
  });
  it("settles cancelled imports promptly and discards late invalid chunks", async () => {
    const abort = new AbortController();
    let finish!: (text: string) => void;
    const promise = loadSyntheticPointSource("fixture:goal-points-v1", abort.signal, () => new Promise(resolve => { finish = resolve; }));
    const rejected = expect(promise).rejects.toMatchObject({ reason: "cancelled" });
    abort.abort();
    await rejected;
    finish("not valid JSON; must never reach decoder after cancellation");
    await Promise.resolve();
  });
  it("bounds a stalled import and consumes a late transport rejection", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const promise = loadSyntheticPointSource("fixture:goal-points-v1", undefined, () => new Promise((_resolve, reject) => { fail = reject; }));
    const rejected = expect(promise).rejects.toThrow("30 seconds");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    fail(new Error("Late transport failure"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
