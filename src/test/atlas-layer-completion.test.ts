// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Event, Request, RequestState, type ImageryLayer, type UrlTemplateImageryProvider, type Viewer } from "cesium";
import { AtlasFrameResolver, PaleoAtlasLayerController, type PaleoAtlasManifest, type PaleoAtlasRuntimeState } from "@timemachine/raster-runtime";

const native = vi.hoisted(() => ({ requestImage: vi.fn<UrlTemplateImageryProvider["requestImage"]>() }));
vi.mock("cesium", async importOriginal => {
  const actual = await importOriginal<typeof import("cesium")>();
  return {
    ...actual,
    // Preserve Cesium's real provider/layer construction. Only image transport
    // is controlled; the fake Scene below supplies explicit render boundaries.
    UrlTemplateImageryProvider: class extends actual.UrlTemplateImageryProvider {
      override requestImage(...args: Parameters<UrlTemplateImageryProvider["requestImage"]>) {
        return native.requestImage(...args);
      }
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(onState?: (state: PaleoAtlasRuntimeState) => void) {
  const layers: ImageryLayer[] = [];
  const states: PaleoAtlasRuntimeState[] = [];
  const scene = {
    postRender: new Event(), renderError: new Event(),
    globe: { tilesLoaded: true, tileLoadProgressEvent: new Event() },
    requestRender: vi.fn(), isDestroyed: () => false,
  };
  const viewer = {
    scene, useDefaultRenderLoop: true,
    imageryLayers: {
      add(layer: ImageryLayer, index = layers.length) { layers.splice(index, 0, layer); return layer; },
      contains: (layer: ImageryLayer) => layers.includes(layer),
      remove(layer: ImageryLayer, destroy = true) {
        const index = layers.indexOf(layer);
        if (index < 0) return false;
        layers.splice(index, 1);
        if (destroy) layer.destroy();
        return true;
      },
      raiseToTop(layer: ImageryLayer) {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.push(...layers.splice(index, 1));
      },
    },
  };
  const manifest: PaleoAtlasManifest = {
    schemaVersion: 1, id: "atlas-fixture", label: "Atlas fixture", attribution: "Synthetic test data",
    frameSelection: "nearest", outOfRangePolicy: "hide",
    tiles: { crs: "EPSG:3857", tileMatrixSet: "WebMercatorQuad", tileSize: 256, format: "image/jpeg", minimumLevel: 0, maximumLevel: 4, bounds: [-180, -85, 180, 85] },
    frames: [0, 100, 200].map(age => ({ timeMa: age, sourceId: `frame-${age}`, label: `${age} Ma`, sourceFile: `${age}.jpg`, sourceSha256: String(age).padStart(64, "0"), tileUrl: `/synthetic/${age}/{z}/{x}/{y}.jpg`, byteLength: 256 })),
  };
  const controller = new PaleoAtlasLayerController(viewer as unknown as Viewer, new AtlasFrameResolver(manifest), state => { states.push(state); onState?.(state); });
  const render = () => scene.postRender.raiseEvent(scene);
  const candidate = () => layers.find(layer => layer !== committedLayer)!;
  let committedLayer: ImageryLayer | undefined;
  return {
    controller, viewer, scene, layers, states, render, candidate,
    async load(layer = candidate()) {
      const request = layer.imageryProvider.requestImage(2, 1, 2, new Request({ throttle: false }));
      await request;
      await Promise.resolve();
    },
    async commit(age: number) {
      const promise = controller.setTimeAsync(age);
      await this.load();
      render();
      render();
      await promise;
      committedLayer = layers[0];
      return committedLayer!;
    },
    listeners() { return scene.postRender.numberOfListeners + scene.renderError.numberOfListeners + scene.globe.tileLoadProgressEvent.numberOfListeners; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  native.requestImage.mockReset().mockImplementation(async () => document.createElement("img"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Atlas request completion", () => {
  it("does not announce ready from the legacy HTTP probe and animation timer", async () => {
    const h = createHarness();
    h.controller.setTime(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.states.some(state => state.status === "ready")).toBe(false);
    expect(h.layers).toHaveLength(1);
    expect(h.layers[0]!.alpha).toBe(0);
    h.controller.destroy();
  });

  it("requires candidate image participation, view readiness and a separate final-alpha render", async () => {
    const h = createHarness();
    let completed = false;
    const result = h.controller.setTimeAsync(90).then(value => { completed = true; return value; });
    const layer = h.candidate();
    h.render(); // The old global true cannot prove that this candidate loaded.
    await Promise.resolve();
    expect(layer.alpha).toBe(0);
    expect(completed).toBe(false);
    const image = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(image.promise);
    const nativeRequest = new Request({ throttle: false });
    const load = layer.imageryProvider.requestImage(5, 7, 3, nativeRequest);
    expect(native.requestImage).toHaveBeenLastCalledWith(5, 7, 3, nativeRequest);
    image.resolve(document.createElement("img"));
    await load;
    expect(completed).toBe(false);
    h.scene.globe.tilesLoaded = false;
    h.render();
    expect(layer.alpha).toBe(0);
    h.scene.globe.tilesLoaded = true;
    h.render();
    expect(layer.alpha).toBe(1);
    expect(completed).toBe(false);
    h.scene.globe.tilesLoaded = false;
    h.render();
    expect(completed).toBe(false);
    h.scene.globe.tilesLoaded = true;
    h.render();
    expect(await result).toMatchObject({ status: "ready", requestedAgeMa: 90, actualFrameAgeMa: 100, sourceId: "frame-100", generation: 1 });
    expect(h.listeners()).toBe(0);
  });

  it("preserves throttled requestImage undefined and does not reveal a warming layer when opacity changes", async () => {
    const h = createHarness();
    const result = h.controller.setTimeAsync(100);
    const layer = h.candidate();
    native.requestImage.mockReturnValueOnce(undefined);
    expect(layer.imageryProvider.requestImage(0, 0, 0)).toBeUndefined();
    h.controller.setOpacity(0.4);
    h.render();
    expect(layer.alpha).toBe(0);
    await h.load(layer);
    h.render();
    expect(layer.alpha).toBe(0.4);
    h.render();
    expect(await result).toMatchObject({ status: "ready" });
  });

  it("retains the old layer until the new target's final render and restores it on render failure", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    h.controller.setOpacity(0.6);
    const result = h.controller.setTimeAsync(100).catch(error => error);
    const next = h.candidate();
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(0.6);
    await h.load(next);
    h.render();
    expect(h.layers).toContain(old);
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic target render failure"));
    expect(await result).toMatchObject({ kind: "render" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(0.6);
    expect(h.states.at(-1)).toMatchObject({ status: "error", frame: { sourceId: "frame-100" } });
    expect(h.listeners()).toBe(0);
  });

  it("shares preparation for the same frame while preserving each caller age and cancellation", async () => {
    const h = createHarness();
    const abort = new AbortController();
    const a = h.controller.setTimeAsync(80, { signal: abort.signal }).catch(error => error);
    const b = h.controller.setTimeAsync(90);
    expect(h.layers).toHaveLength(1);
    abort.abort();
    expect(await a).toMatchObject({ kind: "cancelled" });
    await h.load(); h.render(); h.render();
    expect(await b).toMatchObject({ requestedAgeMa: 90, actualFrameAgeMa: 100, sourceId: "frame-100" });
    expect(h.states.at(-1)).toMatchObject({ status: "ready", requestedAgeMa: 90 });
    expect(h.listeners()).toBe(0);
  });

  it("supersedes the old target and ignores its late native request without changing the replacement", async () => {
    const h = createHarness();
    const a = h.controller.setTimeAsync(0).catch(error => error);
    const old = h.candidate();
    const load = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(load.promise);
    const nativeLoad = old.imageryProvider.requestImage(0, 0, 0);
    const b = h.controller.setTimeAsync(100);
    expect(await a).toMatchObject({ kind: "superseded" });
    load.resolve(document.createElement("img")); await nativeLoad;
    h.render();
    expect(h.candidate().alpha).toBe(0);
    await h.load(); h.render(); h.render();
    expect(await b).toMatchObject({ sourceId: "frame-100" });
    expect(h.layers).toHaveLength(1);
    expect(h.states.at(-1)).toMatchObject({ status: "ready", frame: { sourceId: "frame-100" } });
  });

  it("bounds stalled candidate preparation and keeps the old frame available for retry", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const stalled = h.controller.setTimeAsync(100).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await stalled).toMatchObject({ kind: "timeout" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.listeners()).toBe(0);
    const retry = h.controller.setTimeAsync(100);
    await h.load(); h.render(); h.render();
    expect(await retry).toMatchObject({ status: "ready" });
  });

  it("settles hidden and out-of-range requests and never reloads after destroy", async () => {
    const h = createHarness();
    const active = h.controller.setTimeAsync(100);
    h.controller.setVisible(false);
    expect(await active).toMatchObject({ status: "hidden", reason: "disabled", requestedAgeMa: 100 });
    expect(await h.controller.setTimeAsync(500)).toMatchObject({ status: "hidden", reason: "out-of-range" });
    expect(h.layers).toHaveLength(0);
    h.controller.destroy();
    expect(await h.controller.setTimeAsync(100).catch(error => error)).toMatchObject({ kind: "disposed" });
    h.controller.setTime(100);
    h.controller.setVisible(true);
    await Promise.resolve();
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
  });

  it("observes new native requests when reusing an already committed frame", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const result = h.controller.setTimeAsync(10).catch(error => error);
    native.requestImage.mockRejectedValueOnce(new Error("Synthetic reused-frame image failure"));
    await old.imageryProvider.requestImage(4, 3, 3)?.catch(() => undefined);
    h.render();
    expect(await result).toMatchObject({ kind: "load" });
    expect(h.layers).toEqual([old]);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    expect(h.listeners()).toBe(0);
  });

  it("settles a failed native layer insertion without leaving a rejected internal waiter", async () => {
    const h = createHarness();
    vi.spyOn(h.viewer.imageryLayers, "add").mockImplementationOnce(() => { throw new Error("Synthetic add failure"); });
    expect(await h.controller.setTimeAsync(100).catch(error => error)).toMatchObject({ kind: "load" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toMatchObject({ status: "error", message: "Synthetic add failure" });
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes legacy load failure while retaining a read-only copy of the committed frame", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const copy = h.controller.getCommittedFrame()!;
    copy.sourceId = "changed-by-caller";
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    h.controller.setTime(100);
    h.candidate().imageryProvider.errorEvent.raiseEvent(new Error("Synthetic provider failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toMatchObject({ status: "error", frame: { sourceId: "frame-100" } });
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    expect(h.layers).toEqual([old]);
    expect(h.listeners()).toBe(0);
  });

  it("does not supersede initialization when setVisible(true) and layer ordering run synchronously", async () => {
    const h = createHarness();
    h.controller.setOpacity(0.7);
    const result = h.controller.setTimeAsync(100);
    const layer = h.candidate();
    h.controller.setVisible(true);
    h.controller.raiseToTop();
    expect(h.layers).toEqual([layer]);
    expect(layer.alpha).toBe(0);
    await h.load(layer); h.render(); h.render();
    expect(await result).toMatchObject({ status: "ready", generation: 1 });
    expect(layer.alpha).toBe(0.7);
  });

  it("cancels the final caller after candidate visibility without destroying the old frame", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const abort = new AbortController();
    const result = h.controller.setTimeAsync(100, { signal: abort.signal }).catch(error => error);
    await h.load(); h.render();
    expect(old.show).toBe(false);
    abort.abort();
    expect(await result).toMatchObject({ kind: "cancelled" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(1);
    h.render();
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    expect(h.listeners()).toBe(0);
  });

  it("rejects a pre-aborted request without replacing the current candidate", async () => {
    const h = createHarness();
    const active = h.controller.setTimeAsync(100);
    const layer = h.candidate();
    const abort = new AbortController(); abort.abort();
    expect(await h.controller.setTimeAsync(0, { signal: abort.signal }).catch(error => error)).toMatchObject({ kind: "cancelled" });
    expect(h.layers).toEqual([layer]);
    await h.load(layer); h.render(); h.render();
    expect(await active).toMatchObject({ requestedAgeMa: 100, actualFrameAgeMa: 100 });
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite age %s before changing the current owner", async ageMa => {
    const h = createHarness();
    const active = h.controller.setTimeAsync(100).catch(error => error);
    const layer = h.candidate();
    const states = h.states.length;
    expect(await h.controller.setTimeAsync(ageMa).catch(error => error)).toMatchObject({ kind: "invalid" });
    expect(h.layers).toEqual([layer]);
    expect(h.states).toHaveLength(states);
    await h.load(layer); h.render(); h.render();
    expect(await active).toMatchObject({ requestedAgeMa: 100, actualFrameAgeMa: 100 });
    expect(h.states.at(-1)).toMatchObject({ status: "ready", requestedAgeMa: 100 });
  });

  it("settles the public request even when its state listener throws during loading and failure", async () => {
    const h = createHarness(() => { throw new Error("Synthetic state observer failure"); });
    expect(await h.controller.setTimeAsync(100).catch(error => error)).toMatchObject({ kind: "recovery" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans an earlier subscription if a later native event subscription throws", async () => {
    const h = createHarness();
    vi.spyOn(h.scene.renderError, "addEventListener").mockImplementationOnce(() => { throw new Error("Synthetic listener registration failure"); });
    expect(await h.controller.setTimeAsync(100).catch(error => error)).toMatchObject({ kind: "load" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds same-frame waiters without dropping accepted callers", async () => {
    const h = createHarness();
    const accepted = Array.from({ length: 64 }, () => h.controller.setTimeAsync(100));
    expect(await h.controller.setTimeAsync(100).catch(error => error)).toMatchObject({ kind: "busy" });
    await h.load(); h.render(); h.render();
    expect((await Promise.all(accepted)).every(result => result.status === "ready")).toBe(true);
    expect(h.layers).toHaveLength(1);
    expect(h.listeners()).toBe(0);
  });

  it("destroys active preparation and ignores late native image settlement", async () => {
    const h = createHarness();
    await h.commit(0);
    const result = h.controller.setTimeAsync(100).catch(error => error);
    const pending = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(pending.promise);
    const request = h.candidate().imageryProvider.requestImage(1, 0, 1);
    h.controller.destroy();
    expect(await result).toMatchObject({ kind: "disposed" });
    const requestCount = h.scene.requestRender.mock.calls.length;
    const states = h.states.length;
    pending.resolve(document.createElement("img")); await request;
    h.render();
    expect(h.scene.requestRender).toHaveBeenCalledTimes(requestCount);
    expect(h.states).toHaveLength(states);
    expect(h.controller.getCommittedFrame()).toBeUndefined();
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "render-error", "hide"] as const)("restores the old frame when candidate removal throws during %s", async trigger => {
    const h = createHarness();
    const old = await h.commit(0);
    h.controller.setOpacity(0.6);
    const abort = new AbortController();
    const result = h.controller.setTimeAsync(100, { signal: abort.signal }).catch(error => error);
    const next = h.candidate();
    await h.load(next); h.render();
    expect(old.show).toBe(false);
    const requestCount = h.scene.requestRender.mock.calls.length;
    vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic candidate removal failure"); });
    if (trigger === "cancel") abort.abort();
    else if (trigger === "hide") h.controller.setVisible(false);
    else h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic render failure"));
    expect(await result).toMatchObject({ kind: "recovery", message: "Synthetic candidate removal failure" });
    expect(old.show).toBe(trigger !== "hide");
    expect(old.alpha).toBe(0.6);
    expect(next.show).toBe(false);
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    expect(h.scene.requestRender.mock.calls.length).toBeGreaterThan(requestCount);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.states.at(-1)).toMatchObject({ status: "error" });
    const states = h.states.length;
    h.render();
    expect(h.states).toHaveLength(states);
  });

  it("settles all waiters and restores the old frame when cleanup and failure notification throw", async () => {
    const h = createHarness(state => {
      if (state.status === "error") throw new Error("Synthetic failure notification error");
    });
    const old = await h.commit(0);
    const nativeSubscribe = h.scene.postRender.addEventListener.bind(h.scene.postRender);
    vi.spyOn(h.scene.postRender, "addEventListener").mockImplementationOnce((...args: Parameters<Event["addEventListener"]>) => {
      const remove = nativeSubscribe(...args);
      return () => { remove(); throw new Error("Synthetic listener cleanup failure"); };
    });
    const a = h.controller.setTimeAsync(80).catch(error => error);
    const b = h.controller.setTimeAsync(90).catch(error => error);
    await h.load(); h.render();
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic render failure"));
    expect(await Promise.all([a, b])).toMatchObject([{ kind: "recovery" }, { kind: "recovery" }]);
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(1);
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["retry", "destroy"] as const)("retains failed candidate cleanup ownership for %s", async action => {
    const h = createHarness();
    await h.commit(0);
    const abort = new AbortController();
    const result = h.controller.setTimeAsync(100, { signal: abort.signal }).catch(error => error);
    const failed = h.candidate();
    await h.load(failed); h.render();
    vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic candidate removal failure"); });
    abort.abort();
    expect(await result).toMatchObject({ kind: "recovery" });
    expect(h.layers).toContain(failed);
    if (action === "destroy") {
      h.controller.destroy();
      expect(h.layers).toHaveLength(0);
    } else {
      const retry = h.controller.setTimeAsync(200);
      expect(h.layers).not.toContain(failed);
      expect(h.layers).toHaveLength(2);
      await h.load(); h.render(); h.render();
      expect(await retry).toMatchObject({ sourceId: "frame-200" });
      expect(h.layers).toHaveLength(1);
    }
    expect(failed.isDestroyed()).toBe(true);
    expect(h.listeners()).toBe(0);
  });

  it("refuses new candidates while native removal keeps failing", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const abort = new AbortController();
    const result = h.controller.setTimeAsync(100, { signal: abort.signal }).catch(error => error);
    const failed = h.candidate();
    await h.load(failed); h.render();
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation(() => { throw new Error("Synthetic persistent removal failure"); });
    abort.abort();
    expect(await result).toMatchObject({ kind: "recovery" });
    for (const age of [200, 100, 0]) {
      expect(await h.controller.setTimeAsync(age).catch(error => error)).toMatchObject({ kind: "recovery" });
      expect(h.layers).toHaveLength(2);
      expect(h.layers).toContain(old);
      expect(h.layers).toContain(failed);
    }
    expect(old.show).toBe(true);
    expect(failed.show).toBe(false);
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-0");
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
    h.controller.destroy();
    expect(h.layers).toHaveLength(0);
  });

  it("destroys a detached layer when the collection removal event throws after removing it", async () => {
    const h = createHarness();
    await h.commit(0);
    const abort = new AbortController();
    const result = h.controller.setTimeAsync(100, { signal: abort.signal }).catch(error => error);
    const failed = h.candidate();
    const remove = h.viewer.imageryLayers.remove.bind(h.viewer.imageryLayers);
    vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(layer => {
      remove(layer, false);
      throw new Error("Synthetic layerRemoved observer failure");
    });
    abort.abort();
    expect(await result).toMatchObject({ kind: "recovery" });
    expect(h.layers).not.toContain(failed);
    h.controller.destroy();
    expect(failed.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
  });

  it.each(["retirement", "notification"] as const)("reports %s failure after a confirmed commit without claiming an old-frame rollback", async failure => {
    const h = createHarness(state => {
      if (failure === "notification" && state.status === "ready" && state.frame.timeMa === 100) throw new Error("Synthetic committed notification failure");
    });
    const old = await h.commit(0);
    const result = h.controller.setTimeAsync(100).catch(error => error);
    const next = h.candidate();
    await h.load(next); h.render();
    if (failure === "retirement") vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic committed retirement failure"); });
    h.render();
    expect(await result).toMatchObject({ kind: "recovery" });
    expect(h.controller.getCommittedFrame()?.sourceId).toBe("frame-100");
    expect(next.show).toBe(true);
    expect(next.alpha).toBe(1);
    expect(h.layers).toContain(next);
    if (failure === "retirement") expect(old.show).toBe(false);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.destroy();
    expect(old.isDestroyed()).toBe(true);
    expect(next.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
  });

  it("keeps disposal permanent while allowing failed native cleanup to be retried", async () => {
    const h = createHarness();
    await h.commit(0);
    const result = h.controller.setTimeAsync(100).catch(error => error);
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation(() => { throw new Error("Synthetic disposal cleanup failure"); });
    expect(() => h.controller.destroy()).toThrow("Synthetic disposal cleanup failure");
    expect(await result).toMatchObject({ kind: "recovery" });
    expect(h.controller.getCommittedFrame()).toBeUndefined();
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await h.controller.setTimeAsync(200).catch(error => error)).toMatchObject({ kind: "disposed" });
    expect(h.layers).toHaveLength(2);
    remove.mockRestore();
    h.controller.destroy();
    expect(h.layers).toHaveLength(0);
  });

  it("refuses a direct replacement when superseding its predecessor creates failed cleanup", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const first = h.controller.setTimeAsync(100).catch(error => error);
    const failed = h.candidate();
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation(() => { throw new Error("Synthetic supersede removal failure"); });
    let replacement: unknown;
    const second = h.controller.setTimeAsync(200).catch(error => error).then(value => { replacement = value; return value; });
    expect(h.layers).toHaveLength(2);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(replacement).toMatchObject({ kind: "recovery" });
    expect(await second).toMatchObject({ kind: "recovery" });
    expect(await first).toMatchObject({ kind: "recovery" });
    expect(h.layers).toHaveLength(2);
    expect(h.layers).toContain(old);
    expect(h.layers).toContain(failed);
    expect(failed.show).toBe(false);
    expect(old.show).toBe(true);
    expect(h.states.some(state => state.status === "loading" && state.frame.timeMa === 200)).toBe(false);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const age of [100, 200, 0]) {
      expect(await h.controller.setTimeAsync(age).catch(error => error)).toMatchObject({ kind: "recovery" });
      expect(h.layers).toHaveLength(2);
    }
    remove.mockRestore();
    h.controller.destroy();
    expect(failed.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
  });

  it("allows Cesium scheduling cancellation to retry without failing the whole frame", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const result = h.controller.setTimeAsync(100).catch(error => error);
    const next = h.candidate();
    const cancelled = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(cancelled.promise);
    const request = new Request({ throttle: false });
    const rejection = new Error("Synthetic low-priority request cancellation");
    const nativeResult = next.imageryProvider.requestImage(1, 1, 2, request)?.catch(error => error);
    // Cesium's scheduler writes this public readonly-to-callers state before
    // rejecting the request. Simulate that scheduler boundary without network.
    Object.defineProperty(request, "state", { value: RequestState.CANCELLED });
    cancelled.reject(rejection);
    expect(await nativeResult).toBe(rejection);
    expect(h.states.at(-1)).toMatchObject({ status: "loading" });
    expect(h.layers).toContain(next);
    expect(old.show).toBe(true);
    h.render();
    expect(next.alpha).toBe(0);
    await h.load(next); h.render(); h.render();
    expect(await result).toMatchObject({ status: "ready", sourceId: "frame-100" });
    expect(h.layers).toEqual([next]);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overwrite a newer request started by a superseded-state callback", async () => {
    let reenter = false;
    let inner: Promise<unknown> | undefined;
    const h = createHarness(state => {
      if (reenter && state.status === "error") {
        reenter = false;
        inner = h.controller.setTimeAsync(0).catch(error => error);
      }
    });
    const old = await h.commit(0);
    const first = h.controller.setTimeAsync(100).catch(error => error);
    reenter = true;
    let outerResult: unknown;
    const outer = h.controller.setTimeAsync(200).catch(error => error).then(value => { outerResult = value; return value; });
    expect(inner).toBeDefined();
    expect(h.layers).toEqual([old]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(outerResult).toMatchObject({ kind: "superseded" });
    expect(await first).toMatchObject({ kind: "superseded" });
    expect(await outer).toMatchObject({ kind: "superseded" });
    h.render();
    expect(await inner).toMatchObject({ status: "ready", requestedAgeMa: 0, sourceId: "frame-0" });
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    expect(h.states.at(-1)).toMatchObject({ status: "ready", requestedAgeMa: 0 });
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect a candidate when a superseded-state callback hides Atlas", async () => {
    let hideOnError = false;
    const h = createHarness(state => {
      if (hideOnError && state.status === "error") { hideOnError = false; h.controller.setVisible(false); }
    });
    const old = await h.commit(0);
    const active = h.controller.setTimeAsync(100).catch(error => error);
    hideOnError = true;
    const replacement = h.controller.setTimeAsync(200).catch(error => error);
    expect(h.layers).toHaveLength(1);
    expect(h.layers[0]).toBe(old);
    expect(old.show).toBe(false);
    expect(await replacement).toMatchObject({ kind: "superseded" });
    expect(await active).toMatchObject({ kind: "superseded" });
    expect(h.states.at(-1)).toMatchObject({ status: "hidden", requestedAgeMa: 100 });
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    h.render();
    expect(h.states.at(-1)?.status).toBe("hidden");
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Atlas coordinated time tickets", () => {
  it("warms without activation, then accepts a rendered target without retiring or notifying early", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const owner = {};
    const ticket = h.controller.prepareTime(100, { owner });
    const next = h.candidate();
    expect(ticket.owner).toBe(owner);
    expect(ticket.canConfirm()).toBe(false);
    expect(() => ticket.activate()).toThrow();
    await h.load(next); h.render(); await ticket.ready;
    h.render();
    expect(next.alpha).toBe(0);
    expect(old.show).toBe(true);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    ticket.activate();
    expect(next.alpha).toBe(1);
    expect(old.show).toBe(false);
    expect(ticket.canConfirm()).toBe(false);
    expect(() => ticket.accept()).toThrow();
    h.render();
    expect(ticket.canConfirm()).toBe(true);
    const states = h.states.length;
    expect(ticket.accept()).toMatchObject({ status: "ready", requestedAgeMa: 100, sourceId: "frame-100" });
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(100);
    expect(h.layers).toContain(old);
    expect(old.isDestroyed()).toBe(false);
    expect(h.states).toHaveLength(states);
    ticket.retire();
    expect(h.layers).toEqual([next]);
    expect(old.isDestroyed()).toBe(true);
    expect(h.states.at(-1)).toMatchObject({ status: "ready", requestedAgeMa: 100 });
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers out-of-range hiding and removal until activation and confirmed acceptance", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const ticket = h.controller.prepareTime(500, { owner: {} });
    await ticket.ready;
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    ticket.activate();
    expect(old.show).toBe(false);
    expect(ticket.canConfirm()).toBe(false);
    h.render();
    expect(ticket.canConfirm()).toBe(true);
    expect(ticket.accept()).toMatchObject({ status: "hidden", reason: "out-of-range" });
    expect(h.controller.getCommittedFrame()).toBeUndefined();
    expect(old.isDestroyed()).toBe(false);
    ticket.retire();
    expect(old.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
  });

  it("confirms a disabled target without allocating or deleting the reusable committed layer", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    h.controller.setVisible(false);
    const ticket = h.controller.prepareTime(100, { owner: {} });
    await ticket.ready;
    expect(h.layers).toEqual([old]);
    ticket.activate(); h.render();
    expect(ticket.accept()).toMatchObject({ status: "hidden", reason: "disabled" });
    ticket.retire();
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(false);
    expect(old.isDestroyed()).toBe(false);
    h.controller.destroy();
  });

  it("restores the prior frame after activation failure and keeps the real error visible to the owner", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    h.controller.setOpacity(0.6);
    const failures: unknown[] = [];
    const ticket = h.controller.prepareTime(100, { owner: {}, onFailure: error => { failures.push(error); } });
    await h.load(); h.render(); await ticket.ready;
    ticket.activate();
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic joint render failure"));
    expect(() => ticket.canConfirm()).toThrow("Synthetic joint render failure");
    expect(() => ticket.accept()).toThrow("Synthetic joint render failure");
    ticket.rollback(); ticket.rollback();
    expect(failures).toHaveLength(1);
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(0.6);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    expect(h.listeners()).toBe(0);
  });

  it("reuses the same source but still waits for a post-activation frame", async () => {
    const h = createHarness();
    const old = await h.commit(100);
    const requests = native.requestImage.mock.calls.length;
    const ticket = h.controller.prepareTime(90, { owner: {} });
    await ticket.ready;
    expect(h.layers).toEqual([old]);
    ticket.activate();
    expect(ticket.canConfirm()).toBe(false);
    h.render();
    expect(ticket.accept()).toMatchObject({ requestedAgeMa: 90, actualFrameAgeMa: 100 });
    ticket.retire();
    expect(native.requestImage.mock.calls).toHaveLength(requests);
    expect(old.isDestroyed()).toBe(false);
  });

  it("cancels only its owner and makes late rollback unable to change its successor", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const abort = new AbortController();
    const ticket = h.controller.prepareTime(100, { owner: {}, signal: abort.signal });
    await h.load(); h.render(); await ticket.ready;
    ticket.activate(); abort.abort();
    expect(() => ticket.canConfirm()).toThrow(/cancel/i);
    expect(old.show).toBe(true);
    const next = h.controller.prepareTime(200, { owner: {} });
    const candidate = h.candidate();
    ticket.rollback();
    expect(h.layers).toContain(candidate);
    expect(candidate.isDestroyed()).toBe(false);
    expect(() => ticket.activate()).toThrow(/cancel/i);
    await h.load(candidate); h.render(); await next.ready;
    next.activate(); h.render(); next.accept(); next.retire();
    ticket.rollback();
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(200);
  });

  it("keeps standalone calls and another owner from stealing an active coordinated ticket", async () => {
    const h = createHarness();
    const ticket = h.controller.prepareTime(100, { owner: {} });
    const candidate = h.candidate();
    expect(() => h.controller.prepareTime(200, { owner: {} })).toThrow(/active|busy|owner/i);
    expect(await h.controller.setTimeAsync(0).catch(error => error)).toMatchObject({ kind: "busy" });
    expect(h.candidate()).toBe(candidate);
    await h.load(); h.render(); await ticket.ready;
    ticket.activate(); h.render(); ticket.accept(); ticket.retire();
  });

  it("reports failure after ready and bounds abandoned prepared tickets", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const failures: unknown[] = [];
    const ticket = h.controller.prepareTime(100, { owner: {}, onFailure: error => { failures.push(error); throw new Error("Observer failed."); } });
    await h.load(); h.render(); await ticket.ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failures).toHaveLength(1);
    expect(() => ticket.canConfirm()).toThrow(/30000/);
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["retirement", "notification"] as const)("keeps accepted facts when %s fails, without rolling back a new owner", async failure => {
    const h = createHarness(state => {
      if (failure === "notification" && state.status === "ready" && state.frame.timeMa === 100) throw new Error("Synthetic ticket notification failure");
    });
    const old = await h.commit(0);
    const ticket = h.controller.prepareTime(100, { owner: {} });
    await h.load(); h.render(); await ticket.ready;
    const next = h.candidate();
    ticket.activate(); h.render(); ticket.accept();
    if (failure === "retirement") vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic ticket retirement failure"); });
    expect(() => ticket.retire()).toThrow(/Synthetic ticket/);
    ticket.rollback();
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(100);
    expect(next.show).toBe(true);
    expect(old.show).toBe(false);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.destroy();
    expect(h.layers).toHaveLength(0);
  });

  it("destroys both retained layers and observers if disposal occurs after accept but before retire", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const ticket = h.controller.prepareTime(100, { owner: {} });
    await h.load(); h.render(); await ticket.ready;
    const next = h.candidate();
    ticket.activate(); h.render(); ticket.accept();
    h.controller.destroy();
    expect(old.isDestroyed()).toBe(true);
    expect(next.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    ticket.rollback(); ticket.retire();
    expect(h.controller.getCommittedFrame()).toBeUndefined();
  });

  it("rolls back a partial activation when native requestRender fails", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const ticket = h.controller.prepareTime(100, { owner: {} });
    await h.load(); h.render(); await ticket.ready;
    h.scene.requestRender.mockImplementationOnce(() => { throw new Error("Synthetic activation requestRender failure"); });
    expect(() => ticket.activate()).toThrow("Synthetic activation requestRender failure");
    expect(() => ticket.canConfirm()).toThrow("Synthetic activation requestRender failure");
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.controller.getCommittedFrame()?.timeMa).toBe(0);
    expect(h.listeners()).toBe(0);
  });

  it("keeps an owner for unchanged visibility and opacity, but invalidates it on a real style change", async () => {
    const h = createHarness();
    const old = await h.commit(0);
    const ticket = h.controller.prepareTime(100, { owner: {} });
    const candidate = h.candidate();
    h.controller.setVisible(true);
    h.controller.setOpacity(1);
    expect(() => ticket.canConfirm()).not.toThrow();
    expect(h.layers).toContain(candidate);
    await h.load(candidate); h.render(); await ticket.ready;
    h.controller.setOpacity(0.4);
    expect(() => ticket.canConfirm()).toThrow(/opacity changed/);
    expect(h.layers).toEqual([old]);
    expect(old.alpha).toBe(0.4);
    expect(old.show).toBe(true);
  });
});
