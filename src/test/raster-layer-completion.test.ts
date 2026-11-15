// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Event, ImageryLayerCollection, Request, RequestState, type ImageryLayer, type UrlTemplateImageryProvider, type Viewer } from "cesium";
import { SingleRasterLayerController, type SingleRasterManifest, type SingleRasterRuntimeState } from "@timemachine/raster-runtime";

const native = vi.hoisted(() => ({ requestImage: vi.fn<UrlTemplateImageryProvider["requestImage"]>() }));
vi.mock("cesium", async importOriginal => {
  const actual = await importOriginal<typeof import("cesium")>();
  return { ...actual, UrlTemplateImageryProvider: class extends actual.UrlTemplateImageryProvider {
    override requestImage(...args: Parameters<UrlTemplateImageryProvider["requestImage"]>) { return native.requestImage(...args); }
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(onState?: (state: SingleRasterRuntimeState) => void, onCleanupError?: (error: unknown, context: { phase: string; generation: number }) => void | Promise<void>) {
  const collection = new ImageryLayerCollection();
  const layers = () => Array.from({ length: collection.length }, (_, index) => collection.get(index));
  const states: SingleRasterRuntimeState[] = [];
  const scene = {
    postRender: new Event(), renderError: new Event(), globe: { tilesLoaded: true },
    requestRender: vi.fn(), isDestroyed: () => false,
  };
  const viewer = { scene, imageryLayers: collection, useDefaultRenderLoop: true };
  const manifest: SingleRasterManifest = {
    schemaVersion: 1, id: "raster-fixture", label: "Raster fixture", attribution: "Synthetic test data", defaultRasterId: "raster-0",
    tileMatrixSet: { crs: "EPSG:3857", name: "WebMercatorQuad", tileSize: 256, bounds: [-180, -85, 180, 85] },
    rasters: [0, 1, 2].map(index => ({
      id: `raster-${index}`, sourceId: `source-${index}`, label: `Raster ${index}`, kind: "synthetic", sourceFile: `${index}.png`, sourceSha256: String(index).padStart(64, "0"),
      tileUrl: `/synthetic/raster-${index}/{z}/{x}/{y}.png`, byteLength: 256,
      tiles: { format: "image/png", minimumLevel: 0, maximumLevel: 4, hasAlphaChannel: true },
      colorbar: { label: "Synthetic values", sourceFile: "values.json", sourceSha256: "0".repeat(64), mode: "continuous", minimum: 0, maximum: 1, units: "unit", stops: [{ offset: 0, value: 0, color: "#000000" }, { offset: 1, value: 1, color: "#ffffff" }] },
    })),
  };
  const controller = new SingleRasterLayerController(viewer as unknown as Viewer, manifest, state => { states.push(state); onState?.(state); }, onCleanupError);
  const render = () => scene.postRender.raiseEvent(scene);
  return {
    controller, viewer, scene, get layers() { return layers(); }, states, render,
    candidate: () => layers().at(-1)!,
    async load(layer = layers().at(-1)!) { await layer.imageryProvider.requestImage(1, 1, 2, new Request({ throttle: false })); },
    async commit(id: string) {
      const promise = controller.selectAsync(id);
      await this.load(); render(); render(); await promise;
      return layers().at(-1)!;
    },
    listeners: () => scene.postRender.numberOfListeners + scene.renderError.numberOfListeners,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  native.requestImage.mockReset().mockImplementation(async () => document.createElement("img"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Raster request completion", () => {
  it("does not report legacy root HTTP success as a rendered raster", async () => {
    const h = createHarness();
    h.controller.select("raster-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.some(state => state.status === "ready")).toBe(false);
    expect(h.layers).toHaveLength(1);
    expect(h.candidate().alpha).toBe(0);
    h.controller.destroy();
  });

  it("requires actual target images and two loaded postRender boundaries", async () => {
    const h = createHarness();
    let completed = false;
    const result = h.controller.selectAsync("raster-1").then(value => { completed = true; return value; });
    const next = h.candidate();
    h.render();
    expect(next.alpha).toBe(0);
    const image = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(image.promise);
    const request = new Request({ throttle: false });
    const nativeResult = next.imageryProvider.requestImage(2, 1, 3, request);
    expect(native.requestImage).toHaveBeenLastCalledWith(2, 1, 3, request);
    image.resolve(document.createElement("img")); await nativeResult;
    expect(completed).toBe(false);
    h.scene.globe.tilesLoaded = false; h.render();
    expect(next.alpha).toBe(0);
    h.scene.globe.tilesLoaded = true; h.render();
    expect(next.alpha).toBe(0.9);
    expect(completed).toBe(false);
    expect(h.controller.getCommittedRaster()).toBeUndefined();
    h.scene.globe.tilesLoaded = false; h.render();
    expect(completed).toBe(false);
    h.scene.globe.tilesLoaded = true; h.render();
    expect(await result).toMatchObject({ status: "ready", requestedRasterId: "raster-1", rasterId: "raster-1", sourceId: "source-1", generation: 1 });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-1");
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves native throttling and leaves warming candidates transparent on opacity changes", async () => {
    const h = createHarness();
    const result = h.controller.selectAsync("raster-1");
    const next = h.candidate();
    native.requestImage.mockReturnValueOnce(undefined);
    expect(next.imageryProvider.requestImage(0, 0, 0)).toBeUndefined();
    h.controller.setOpacity(0.4); h.controller.setVisible(true); h.controller.raiseToTop(); h.render();
    expect(next.alpha).toBe(0);
    expect(h.layers).toHaveLength(1);
    await h.load(); h.render(); h.render();
    expect(await result).toMatchObject({ status: "ready", generation: 1 });
    expect(next.alpha).toBe(0.4);
  });

  it("keeps the old raster and restores visibility after a candidate render failure", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    h.controller.setOpacity(0.6);
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    await h.load(); h.render();
    expect(old.show).toBe(false);
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic raster render failure"));
    await Promise.resolve(); h.render();
    expect(await result).toMatchObject({ kind: "render" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(old.alpha).toBe(0.6);
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(h.states.at(-1)).toMatchObject({ status: "error", raster: { id: "raster-1" } });
    expect(h.listeners()).toBe(0);
  });

  it("shares the same selection while one caller cancels independently", async () => {
    const h = createHarness();
    const abort = new AbortController();
    const a = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    const b = h.controller.whenReady();
    expect(h.layers).toHaveLength(1);
    abort.abort();
    expect(await a).toMatchObject({ kind: "cancelled" });
    await h.load(); h.render(); h.render();
    expect(await b).toMatchObject({ status: "ready", requestedRasterId: "raster-1" });
    expect(h.listeners()).toBe(0);
  });

  it("captures whenReady selection and supersedes it explicitly on a different resource", async () => {
    const h = createHarness();
    expect(await h.controller.whenReady().catch(error => error)).toMatchObject({ kind: "invalid" });
    const a = h.controller.selectAsync("raster-0").catch(error => error);
    const current = h.controller.whenReady().catch(error => error);
    const old = h.candidate();
    const pending = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(pending.promise);
    const nativeResult = old.imageryProvider.requestImage(0, 0, 0);
    const b = h.controller.selectAsync("raster-1");
    expect(await a).toMatchObject({ kind: "superseded" });
    expect(await current).toMatchObject({ kind: "superseded" });
    pending.resolve(document.createElement("img")); await nativeResult;
    h.render(); expect(h.candidate().alpha).toBe(0);
    await h.load(); h.render(); h.render();
    expect(await b).toMatchObject({ requestedRasterId: "raster-1" });
  });

  it("reuses a committed resource and reports its newly failed native image request", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-0").catch(error => error);
    expect(h.layers).toEqual([old]);
    native.requestImage.mockRejectedValueOnce(new Error("Synthetic reused raster failure"));
    await old.imageryProvider.requestImage(1, 1, 2)?.catch(() => undefined);
    h.render();
    expect(await result).toMatchObject({ kind: "load" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.listeners()).toBe(0);
  });

  it("restores the old raster when the final caller cancels after candidate display", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const abort = new AbortController();
    const result = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    await h.load(); h.render();
    abort.abort(); await Promise.resolve(); h.render();
    expect(await result).toMatchObject({ kind: "cancelled" });
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(true);
    expect(h.listeners()).toBe(0);
  });

  it("bounds preparation and permits an explicit retry after timeout", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ kind: "timeout" });
    expect(h.layers).toEqual([old]);
    expect(await h.controller.whenReady().catch(error => error)).toMatchObject({ kind: "timeout" });
    const retry = h.controller.selectAsync("raster-1");
    await h.load(); h.render(); h.render();
    expect(await retry).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(h.listeners()).toBe(0);
  });

  it("settles hidden selections without falsely committing and resumes their requested resource", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-1");
    h.controller.setVisible(false); h.render();
    expect(await result).toMatchObject({ status: "hidden", reason: "disabled", requestedRasterId: "raster-1" });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(old.show).toBe(false);
    expect(await h.controller.whenReady()).toMatchObject({ status: "hidden", requestedRasterId: "raster-1" });
    h.controller.setVisible(true);
    const resumed = h.controller.whenReady();
    await h.load(); h.render(); h.render();
    expect(await resumed).toMatchObject({ status: "ready", rasterId: "raster-1" });
  });

  it("rejects invalid and pre-aborted requests without stealing the active owner", async () => {
    const h = createHarness();
    const active = h.controller.selectAsync("raster-1");
    const next = h.candidate();
    const abort = new AbortController(); abort.abort();
    expect(await h.controller.selectAsync("missing").catch(error => error)).toMatchObject({ kind: "invalid" });
    expect(await h.controller.selectAsync("raster-2", { signal: abort.signal }).catch(error => error)).toMatchObject({ kind: "cancelled" });
    expect(h.layers).toEqual([next]);
    await h.load(); h.render(); h.render();
    expect(await active).toMatchObject({ rasterId: "raster-1" });
  });

  it("consumes legacy failures and returns deep copies of committed metadata", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const copy = h.controller.getCommittedRaster()!;
    copy.tiles.maximumLevel = 99; copy.colorbar!.stops[0]!.value = 99;
    expect(h.controller.getCommittedRaster()?.tiles.maximumLevel).toBe(4);
    expect(h.controller.getCommittedRaster()?.colorbar?.stops[0]?.value).toBe(0);
    h.controller.select("raster-1");
    h.candidate().imageryProvider.errorEvent.raiseEvent(new Error("Synthetic provider failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toMatchObject({ status: "error" });
    expect(h.layers).toEqual([old]);
  });

  it("cleans listeners and public waiters after synchronous insertion or notification errors", async () => {
    const h = createHarness(state => { if (state.status === "error") throw new Error("Synthetic observer failure"); });
    vi.spyOn(h.viewer.imageryLayers, "add").mockImplementationOnce(() => { throw new Error("Synthetic add failure"); });
    expect(await h.controller.selectAsync("raster-1").catch(error => error)).toMatchObject({ kind: "recovery" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one failed cleanup owner and refuses direct replacement while removal fails", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const a = h.controller.selectAsync("raster-1").catch(error => error);
    const failed = h.candidate();
    await h.load(); h.render();
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation(() => { throw new Error("Synthetic remove failure"); });
    expect(await h.controller.selectAsync("raster-2").catch(error => error)).toMatchObject({ kind: "recovery" });
    expect(await a).toMatchObject({ kind: "recovery" });
    expect(old.show).toBe(true); expect(failed.show).toBe(false);
    for (let i = 0; i < 3; i++) expect(await h.controller.selectAsync("raster-2").catch(error => error)).toMatchObject({ kind: "recovery" });
    expect(h.layers).toHaveLength(2);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore(); h.controller.destroy();
    expect(h.layers).toHaveLength(0);
  });

  it("finishes detached layer destruction after a removal event throws", async () => {
    const h = createHarness();
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    const failed = h.candidate();
    const remove = h.viewer.imageryLayers.remove.bind(h.viewer.imageryLayers);
    vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(layer => { remove(layer, false); throw new Error("Synthetic removed observer failure"); });
    h.controller.setVisible(false);
    expect(await result).toMatchObject({ kind: "recovery" });
    h.controller.destroy();
    expect(failed.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
  });

  it("preserves a newer selection started synchronously by a state callback", async () => {
    let reenter = false;
    let inner: Promise<unknown> | undefined;
    const h = createHarness(state => {
      if (reenter && state.status === "error") { reenter = false; inner = h.controller.selectAsync("raster-0").catch(error => error); }
    });
    const old = await h.commit("raster-0");
    const a = h.controller.selectAsync("raster-1").catch(error => error);
    reenter = true;
    expect(await h.controller.selectAsync("raster-2").catch(error => error)).toMatchObject({ kind: "superseded" });
    expect(await a).toMatchObject({ kind: "superseded" });
    expect(h.layers).toEqual([old]);
    h.render();
    expect(await inner).toMatchObject({ status: "ready", rasterId: "raster-0" });
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows native scheduling cancellation to retry the same raster", async () => {
    const h = createHarness();
    const result = h.controller.selectAsync("raster-1");
    const request = new Request({ throttle: false });
    const pending = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(pending.promise);
    const nativeResult = h.candidate().imageryProvider.requestImage(1, 1, 2, request)?.catch(error => error);
    Object.defineProperty(request, "state", { value: RequestState.CANCELLED });
    const error = new Error("Synthetic scheduled cancellation");
    pending.reject(error);
    expect(await nativeResult).toBe(error);
    expect(h.states.at(-1)).toMatchObject({ status: "loading" });
    await h.load(); h.render(); h.render();
    expect(await result).toMatchObject({ status: "ready" });
  });

  it("bounds same-resource waiters without dropping accepted callers", async () => {
    const h = createHarness();
    const callers = Array.from({ length: 64 }, () => h.controller.selectAsync("raster-1"));
    expect(await h.controller.whenReady().catch(error => error)).toMatchObject({ kind: "busy" });
    await h.load(); h.render(); h.render();
    expect((await Promise.all(callers)).every(result => result.status === "ready")).toBe(true);
    expect(h.listeners()).toBe(0);
  });

  it("permanently closes requests on destroy and ignores late image settlement", async () => {
    const h = createHarness();
    await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    const pending = deferred<HTMLImageElement>();
    native.requestImage.mockReturnValueOnce(pending.promise);
    const nativeResult = h.candidate().imageryProvider.requestImage(1, 1, 2);
    h.controller.destroy();
    expect(await result).toMatchObject({ kind: "disposed" });
    const states = h.states.length;
    const renders = h.scene.requestRender.mock.calls.length;
    pending.resolve(document.createElement("img")); await nativeResult;
    expect(await h.controller.selectAsync("raster-2").catch(error => error)).toMatchObject({ kind: "disposed" });
    expect(await h.controller.whenReady().catch(error => error)).toMatchObject({ kind: "disposed" });
    h.controller.select("raster-2"); h.controller.setVisible(true); h.controller.setOpacity(1);
    await Promise.resolve();
    expect(h.states).toHaveLength(states);
    expect(h.scene.requestRender).toHaveBeenCalledTimes(renders);
    expect(h.layers).toHaveLength(0);
    expect(h.controller.getCommittedRaster()).toBeUndefined();
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the same confirmed generation without starting a new selection", async () => {
    const h = createHarness();
    const selected = h.controller.selectAsync("raster-1");
    await h.load(); h.render(); h.render();
    const confirmed = await selected;
    const states = h.states.length;
    const readiness = h.controller.whenReady();
    expect(h.states).toHaveLength(states);
    const copy = await readiness;
    expect(copy).toEqual(confirmed);
    copy.requestedRasterId = "mutated-by-caller";
    expect(await h.controller.whenReady()).toEqual(confirmed);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["retirement", "notification"] as const)("preserves the actual committed raster after post-commit %s failure", async failure => {
    const h = createHarness(state => {
      if (failure === "notification" && state.status === "ready" && state.raster.id === "raster-1") throw new Error("Synthetic committed notification failure");
    });
    const old = await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    const next = h.candidate();
    await h.load(); h.render();
    if (failure === "retirement") vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic committed retirement failure"); });
    h.render();
    expect(await result).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(await h.controller.whenReady()).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-1");
    expect(next.show).toBe(true);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.destroy();
    expect(old.isDestroyed()).toBe(true);
    expect(next.isDestroyed()).toBe(true);
    expect(h.layers).toHaveLength(0);
  });

  it("cleans earlier subscriptions if a later event subscription throws", async () => {
    const h = createHarness();
    vi.spyOn(h.scene.renderError, "addEventListener").mockImplementationOnce(() => { throw new Error("Synthetic event registration failure"); });
    expect(await h.controller.selectAsync("raster-1").catch(error => error)).toMatchObject({ kind: "load" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.layers).toHaveLength(0);
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps disposal permanent while retrying failed native cleanup", async () => {
    const h = createHarness();
    await h.commit("raster-0");
    const result = h.controller.selectAsync("raster-1").catch(error => error);
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation(() => { throw new Error("Synthetic disposal failure"); });
    expect(() => h.controller.destroy()).toThrow("Synthetic disposal failure");
    expect(await result).toMatchObject({ kind: "recovery" });
    expect(await h.controller.whenReady().catch(error => error)).toMatchObject({ kind: "disposed" });
    expect(await h.controller.selectAsync("raster-2").catch(error => error)).toMatchObject({ kind: "disposed" });
    expect(h.controller.getCommittedRaster()).toBeUndefined();
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore(); h.controller.destroy();
    expect(h.layers).toHaveLength(0);
  });

  it("reports a hidden new selection separately from the old committed raster", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    h.controller.setVisible(false);
    const selection = h.controller.selectAsync("raster-1"); h.render();
    const hidden = await selection;
    expect(hidden).toMatchObject({ status: "hidden", requestedRasterId: "raster-1" });
    expect(h.states.at(-1)).toMatchObject({ status: "hidden", raster: { id: "raster-1" } });
    expect(await h.controller.whenReady()).toEqual(hidden);
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(false);
    h.controller.setVisible(true);
    const ready = h.controller.whenReady();
    expect(h.states.at(-1)).toMatchObject({ status: "loading", raster: { id: "raster-1" } });
    await h.load(); h.render(); h.render();
    expect(await ready).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-1");
  });

  it("preserves synchronous invalid-id errors at the legacy select entry", async () => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const states = h.states.length;
    expect(() => h.controller.select("missing")).toThrow('SingleRaster dataset "missing" was not found.');
    expect(h.layers).toEqual([old]);
    expect(h.states).toHaveLength(states);
    expect(await h.controller.whenReady()).toMatchObject({ status: "ready", rasterId: "raster-0" });
  });

  it("does not create a visible replacement after a supersede callback hides the layer", async () => {
    let hideOnError = false;
    const h = createHarness(state => {
      if (hideOnError && state.status === "error") { hideOnError = false; h.controller.setVisible(false); }
    });
    const old = await h.commit("raster-0");
    const active = h.controller.selectAsync("raster-1").catch(error => error);
    hideOnError = true;
    const replacement = h.controller.selectAsync("raster-2").catch(error => error);
    expect(h.layers).toHaveLength(1);
    expect(h.layers[0]).toBe(old);
    expect(old.show).toBe(false);
    expect(await replacement).toMatchObject({ kind: "superseded" });
    expect(await active).toMatchObject({ kind: "superseded" });
    expect(h.states.at(-1)).toMatchObject({ status: "hidden", raster: { id: "raster-1" } });
    expect(await h.controller.whenReady()).toMatchObject({ status: "hidden", requestedRasterId: "raster-1" });
    h.render();
    expect(h.states.at(-1)?.status).toBe("hidden");
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("Raster frame-job boundaries", () => {
  it.each(["detached", "destroyed", "hidden", "alpha"] as const)("rejects a %s candidate at the final render", async mutation => {
    const h = createHarness();
    const old = await h.commit("raster-0");
    const selected = h.controller.selectAsync("raster-1").catch(error => error);
    const candidate = h.candidate();
    await h.load(); h.render();
    if (mutation === "detached") h.viewer.imageryLayers.remove(candidate, false);
    if (mutation === "destroyed") h.viewer.imageryLayers.remove(candidate, true);
    if (mutation === "hidden") candidate.show = false;
    if (mutation === "alpha") candidate.alpha = 0.1;
    h.render(); await Promise.resolve(); h.render();
    expect(await selected).toMatchObject({ kind: "render" });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(old.show).toBe(true);
    h.controller.destroy();
  });

  it("confirms a hidden selection on a real frame without loading its source", async () => {
    const h = createHarness(); const old = await h.commit("raster-0");
    h.controller.setVisible(false);
    let settled = false;
    const selected = h.controller.selectAsync("raster-1").then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(h.layers).toEqual([old]);
    expect(old.show).toBe(false);
    h.render();
    expect(await selected).toMatchObject({ status: "hidden", requestedRasterId: "raster-1" });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(h.listeners()).toBe(0);
    h.controller.destroy();
  });

  it("waits for the restored frame before acknowledging the final caller cancellation", async () => {
    const h = createHarness(); const old = await h.commit("raster-0");
    const abort = new AbortController(); let settled = false;
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => { settled = true; return error; });
    await h.load(); h.render(); abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); expect(old.show).toBe(true);
    h.render();
    expect(await selected).toMatchObject({ kind: "cancelled" });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    h.controller.destroy();
  });

  it("reports restoration render failure instead of successful cancellation", async () => {
    const h = createHarness(); await h.commit("raster-0");
    const abort = new AbortController();
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    await h.load(); h.render(); abort.abort();
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic recovery render failure"));
    expect(await selected).toMatchObject({ kind: "recovery" });
    expect(h.listeners()).toBe(0); h.controller.destroy();
  });

  it.each(["retire", "observer"] as const)("reports post-commit %s failure without changing the committed result", async phase => {
    const reports: Array<{ error: unknown; context: { phase: string; generation: number } }> = [];
    const h = createHarness(state => {
      if (phase === "observer" && state.status === "ready" && state.raster.id === "raster-1") throw new Error("Synthetic ready observer failure");
    }, (error, context) => { reports.push({ error, context }); });
    const old = await h.commit("raster-0");
    const selected = h.controller.selectAsync("raster-1").catch(error => error);
    await h.load(); h.render();
    if (phase === "retire") vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic retirement failure"); });
    h.render();
    expect(await selected).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(await h.controller.whenReady()).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(reports).toHaveLength(1); expect(reports[0]?.context).toMatchObject({ phase, generation: 2 });
    h.controller.destroy(); expect(old.isDestroyed()).toBe(true);
  });
});


describe("Raster recovery ownership", () => {
  it("ignores a late candidate provider failure after transitioning to a hidden frame", async () => {
    const h = createHarness(); const old = await h.commit("raster-0");
    const selected = h.controller.selectAsync("raster-1").catch(error => error);
    const provider = h.candidate().imageryProvider;
    h.controller.setVisible(false);
    provider.errorEvent.raiseEvent(new Error("Late removed candidate failure"));
    h.render();
    expect(await selected).toMatchObject({ status: "hidden", requestedRasterId: "raster-1" });
    expect(old.show).toBe(false); h.controller.destroy();
  });

  it("confirms cancellation against a visibility change during recovery", async () => {
    const h = createHarness(); const old = await h.commit("raster-0"); const abort = new AbortController();
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    await h.load(); h.render(); abort.abort(); h.controller.setVisible(false);
    expect(old.show).toBe(false); await Promise.resolve(); h.render();
    expect(await selected).toMatchObject({ kind: "cancelled" }); h.controller.destroy();
  });

  it("lets a new owner supersede recovery without an old callback restoring its predecessor", async () => {
    const h = createHarness(); const old = await h.commit("raster-0"); const abort = new AbortController();
    const cancelled = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    await h.load(); h.render(); abort.abort();
    const replacement = h.controller.selectAsync("raster-2");
    expect(await cancelled).toMatchObject({ kind: "superseded" });
    await h.load(); h.render(); h.render();
    expect(await replacement).toMatchObject({ status: "ready", rasterId: "raster-2" });
    h.render(); expect(h.controller.getCommittedRaster()?.id).toBe("raster-2");
    expect(old.isDestroyed()).toBe(true); expect(h.layers).toHaveLength(1); h.controller.destroy();
  });

  it("bounds recovery that never renders and closes all listeners", async () => {
    const h = createHarness(); await h.commit("raster-0"); const abort = new AbortController();
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    await h.load(); h.render(); abort.abort(); await vi.advanceTimersByTimeAsync(30_000);
    expect(await selected).toMatchObject({ kind: "recovery" });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0); h.controller.destroy();
  });

  it("accepts a configured zero opacity without treating it as a missing candidate", async () => {
    const h = createHarness(); h.controller.setOpacity(0);
    const selected = h.controller.selectAsync("raster-1"); await h.load(); h.render(); h.render();
    expect(await selected).toMatchObject({ status: "ready" }); expect(h.candidate().alpha).toBe(0); h.controller.destroy();
  });

  it.each(["throw", "reject"] as const)("isolates a cleanup reporter that can %s and retains the failed handle for retry", async mode => {
    let reports = 0;
    const h = createHarness(undefined, () => {
      reports += 1;
      if (mode === "throw") throw new Error("Synthetic diagnostic failure");
      return Promise.reject(new Error("Synthetic diagnostic rejection"));
    });
    const old = await h.commit("raster-0");
    const selected = h.controller.selectAsync("raster-1"); await h.load(); h.render();
    const remove = vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementationOnce(() => { throw new Error("Synthetic retirement failure"); });
    h.render(); expect(await selected).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(old.isDestroyed()).toBe(false); expect(old.show).toBe(false); expect(reports).toBe(1);
    remove.mockRestore();
    const retry = h.controller.selectAsync("raster-1"); h.render();
    expect(await retry).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(old.isDestroyed()).toBe(true); expect(h.layers).toHaveLength(1); h.controller.destroy();
  });
});

describe("Raster failure restoration", () => {
  it.each(["render", "load"] as const)("confirms the restored frame before reporting an activated %s failure", async kind => {
    const h = createHarness(); const old = await h.commit("raster-0");
    let settled = false;
    const selected = h.controller.selectAsync("raster-1").catch(error => { settled = true; return error; });
    const provider = h.candidate().imageryProvider;
    await h.load(); h.render();
    if (kind === "render") {
      h.viewer.useDefaultRenderLoop = false;
      h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic target render failure"));
    } else provider.errorEvent.raiseEvent(new Error("Synthetic target load failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); expect(old.show).toBe(true);
    if (kind === "render") expect(h.viewer.useDefaultRenderLoop).toBe(true);
    h.render(); expect(await selected).toMatchObject({ kind });
    expect(h.controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(h.listeners()).toBe(0); h.controller.destroy();
  });

  it("does not restart a rendering loop repeatedly when recovery itself fails", async () => {
    const h = createHarness(); await h.commit("raster-0");
    const selected = h.controller.selectAsync("raster-1").catch(error => error);
    await h.load(); h.render();
    h.viewer.useDefaultRenderLoop = false;
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic target failure"));
    await vi.advanceTimersByTimeAsync(0); expect(h.viewer.useDefaultRenderLoop).toBe(true);
    h.viewer.useDefaultRenderLoop = false;
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic recovery failure"));
    expect(await selected).toMatchObject({ kind: "recovery" });
    await vi.advanceTimersByTimeAsync(0); expect(h.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.listeners()).toBe(0); h.controller.destroy();
  });
});

describe("Raster native collection reentry", () => {
  it("does not publish an older ready state over a new selection started during retirement", async () => {
    const h = createHarness(); const old = await h.commit("raster-0");
    let next: ReturnType<typeof h.controller.selectAsync> | undefined;
    h.viewer.imageryLayers.layerRemoved.addEventListener(layer => {
      if (layer === old) next = h.controller.selectAsync("raster-2");
    });
    const selected = h.controller.selectAsync("raster-1"); await h.load(); h.render(); h.render();
    expect(await selected).toMatchObject({ status: "ready", rasterId: "raster-1" });
    expect(h.states.at(-1)).toMatchObject({ status: "loading", raster: { id: "raster-2" } });
    await h.load(); h.render(); h.render(); expect(await next).toMatchObject({ rasterId: "raster-2" });
    h.controller.destroy();
  });

  it("does not create an obsolete recovery timer when candidate removal starts a new owner", async () => {
    const h = createHarness(); await h.commit("raster-0"); const abort = new AbortController();
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    const candidate = h.candidate(); await h.load(); h.render();
    let next: ReturnType<typeof h.controller.selectAsync> | undefined;
    h.viewer.imageryLayers.layerRemoved.addEventListener(layer => {
      if (layer === candidate) next = h.controller.selectAsync("raster-2");
    });
    abort.abort(); expect(await selected).toMatchObject({ kind: "superseded" });
    await h.load(); h.render(); h.render(); expect(await next).toMatchObject({ rasterId: "raster-2" });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0); h.controller.destroy();
  });
});

describe("Raster cleanup reentry ownership", () => {
  it.each(["replace", "dispose"] as const)("does not destroy the same candidate twice when native removal can %s the owner", async action => {
    const h = createHarness(); await h.commit("raster-0"); const abort = new AbortController();
    const selected = h.controller.selectAsync("raster-1", { signal: abort.signal }).catch(error => error);
    const candidate = h.candidate(); await h.load(); h.render();
    const removalFailures: unknown[] = [];
    const remove = h.viewer.imageryLayers.remove.bind(h.viewer.imageryLayers);
    vi.spyOn(h.viewer.imageryLayers, "remove").mockImplementation((...args) => {
      try { return remove(...args); } catch (error) { removalFailures.push(error); throw error; }
    });
    let replacement: ReturnType<typeof h.controller.selectAsync> | undefined;
    h.viewer.imageryLayers.layerRemoved.addEventListener(layer => {
      if (layer !== candidate) return;
      if (action === "dispose") h.controller.destroy();
      else replacement = h.controller.selectAsync("raster-2");
    });
    abort.abort();
    expect(await selected).toMatchObject({ kind: action === "dispose" ? "disposed" : "superseded" });
    expect(removalFailures).toEqual([]);
    if (replacement) { await h.load(); h.render(); h.render(); await replacement; }
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0); h.controller.destroy();
  });
});

it("allows an explicit new selection to resume the loop after a failed recovery", async () => {
  const h = createHarness(); await h.commit("raster-0");
  const failed = h.controller.selectAsync("raster-1").catch(error => error);
  await h.load(); h.render();
  h.viewer.useDefaultRenderLoop = false;
  h.scene.renderError.raiseEvent(h.scene, new Error("Target failure"));
  await vi.advanceTimersByTimeAsync(0);
  h.viewer.useDefaultRenderLoop = false;
  h.scene.renderError.raiseEvent(h.scene, new Error("Recovery failure"));
  expect(await failed).toMatchObject({ kind: "recovery" });
  const retry = h.controller.selectAsync("raster-2");
  expect(h.viewer.useDefaultRenderLoop).toBe(true);
  await h.load(); h.render(); h.render();
  expect(await retry).toMatchObject({ status: "ready", rasterId: "raster-2" }); h.controller.destroy();
});

describe("Raster failed-render postRender boundary", () => {
  it("does not accept the failed render's own postRender as a restored frame", async () => {
    const h = createHarness(); const old = await h.commit("raster-0");
    let settled = false;
    const result = h.controller.selectAsync("raster-1").catch(error => { settled = true; return error; });
    await h.load(); h.render();
    h.viewer.useDefaultRenderLoop = false;
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic target draw failure"));
    h.render(); // Scene may still emit postRender in the failed render call stack.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); expect(old.show).toBe(true);
    expect(h.viewer.useDefaultRenderLoop).toBe(true);
    h.render();
    expect(await result).toMatchObject({ kind: "render", message: "Synthetic target draw failure" });
    expect(h.listeners()).toBe(0); h.controller.destroy();
  });

  it("keeps the old-frame draw failure on the original operation before allowing a clean explicit retry", async () => {
    const h = createHarness(); await h.commit("raster-0");
    const original = h.controller.selectAsync("raster-1").catch(error => error);
    await h.load(); h.render();
    h.viewer.useDefaultRenderLoop = false;
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic target draw failure"));
    h.render();
    await vi.advanceTimersByTimeAsync(0);
    h.viewer.useDefaultRenderLoop = false;
    h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic old-frame draw failure"));
    h.render();
    expect(await original).toMatchObject({ kind: "recovery", message: "Synthetic old-frame draw failure" });
    const retry = h.controller.selectAsync("raster-2"); await h.load(); h.render(); h.render();
    expect(await retry).toMatchObject({ status: "ready", rasterId: "raster-2" });
    expect(h.listeners()).toBe(0); h.controller.destroy();
  });
});
