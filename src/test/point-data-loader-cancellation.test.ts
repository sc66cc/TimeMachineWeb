import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPointDataset, PointDatasetCache } from "../../packages/point-runtime/src/point-data-loader";
import type { LoadedPointDataset } from "../../packages/point-runtime/src/types";

class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly capturedMessages: EventListenerOrEventListenerObject[] = [];
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  constructor() { super(); ControlledWorker.instances.push(this); }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    if (listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
      if (type === "message") this.capturedMessages.push(listener);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  loaded(payload: LoadedPointDataset): void {
    this.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", payload } }));
  }
  lateLoaded(payload: LoadedPointDataset): void {
    const event = new MessageEvent("message", { data: { type: "loaded", payload } });
    for (const listener of this.capturedMessages) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
  get listenerCount(): number { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

function dataset(): LoadedPointDataset {
  return {
    datasetId: "synthetic-points", buffer: new ArrayBuffer(84),
    header: { magic: "WGP1", version: 1, headerBytes: 64, recordStrideBytes: 20, pointCount: 1, sourcePointCount: 1, maxPlateId: 1, maxTimeDeciMa: 11000 },
    timings: { cacheHit: false, fetchMs: 1, decodeMs: 1, totalMs: 2 },
  };
}
const id = "synthetic-points";
const url = "/synthetic/points.wgp";

beforeEach(() => { ControlledWorker.instances = []; vi.stubGlobal("Worker", ControlledWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("point data request cancellation", () => {
  it.each([false, true])("rejects pre-cancellation before cache access or Worker creation (cached=%s)", async populated => {
    const cache = new PointDatasetCache();
    if (populated) cache.set(id, url, dataset());
    const get = vi.spyOn(cache, "get");
    const abort = new AbortController(); abort.abort();
    await expect(loadPointDataset(id, url, { cache, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(get).not.toHaveBeenCalled();
    expect(ControlledWorker.instances).toHaveLength(0);
    expect(cache.sizeBytes).toBe(populated ? 84 : 0);
  });

  it("terminates and removes both Worker listeners when pending work is cancelled", async () => {
    const cache = new PointDatasetCache();
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const result = loadPointDataset(id, url, { cache, signal: abort.signal });
    const failure = expect(result).rejects.toMatchObject({ name: "AbortError" });
    const worker = ControlledWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "load", datasetId: id, url });
    abort.abort(); await failure;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(cache.sizeBytes).toBe(0);
  });

  it("ignores an already-queued loaded callback after cancellation without polluting the cache", async () => {
    const cache = new PointDatasetCache();
    const abort = new AbortController();
    const outcome = loadPointDataset(id, url, { cache, signal: abort.signal }).catch(error => error);
    const worker = ControlledWorker.instances[0]!;
    abort.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    worker.lateLoaded(dataset());
    expect(cache.get(id, url)).toBeUndefined();
    expect(cache.sizeBytes).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("retains successful same-ID/URL cache reuse and ignores cancellation after completion", async () => {
    const cache = new PointDatasetCache();
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const result = loadPointDataset(id, url, { cache, signal: abort.signal });
    const worker = ControlledWorker.instances[0]!;
    const value = dataset(); worker.loaded(value);
    expect(await result).toBe(value);
    expect(worker.listenerCount).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort(); worker.lateLoaded(dataset());
    const hit = await loadPointDataset(id, url, { cache });
    expect(hit.buffer).toBe(value.buffer);
    expect(hit.timings).toEqual({ cacheHit: true, fetchMs: 0, decodeMs: 0, totalMs: 0 });
    expect(ControlledWorker.instances).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("does not let a cancelled same-key request poison a later independent successful request", async () => {
    const cache = new PointDatasetCache();
    const abort = new AbortController();
    const cancelled = loadPointDataset(id, url, { cache, signal: abort.signal }).catch(error => error);
    const oldWorker = ControlledWorker.instances[0]!;
    const current = loadPointDataset(id, url, { cache });
    const newWorker = ControlledWorker.instances[1]!;
    abort.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    expect(newWorker.terminate).not.toHaveBeenCalled();
    const value = dataset(); newWorker.loaded(value);
    expect(await current).toBe(value);
    oldWorker.lateLoaded(dataset());
    expect(cache.get(id, url)?.buffer).toBe(value.buffer);
    expect(cache.sizeBytes).toBe(84);
  });

  it.each(["response", "event"])("cleans up a Worker %s failure and ignores its late success", async kind => {
    const cache = new PointDatasetCache();
    const abort = new AbortController();
    const outcome = loadPointDataset(id, url, { cache, signal: abort.signal }).catch(error => error);
    const worker = ControlledWorker.instances[0]!;
    if (kind === "response") worker.dispatchEvent(new MessageEvent("message", { data: { type: "error", datasetId: id, message: "synthetic failure" } }));
    else worker.dispatchEvent(Object.assign(new Event("error"), { message: "synthetic failure" }));
    expect(await outcome).toMatchObject({ message: "synthetic failure" });
    worker.lateLoaded(dataset()); abort.abort();
    expect(cache.get(id, url)).toBeUndefined();
    expect(worker.listenerCount).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("keeps dataset ID and URL as separate parts of the existing cache identity", async () => {
    const cache = new PointDatasetCache();
    const value = dataset(); cache.set(id, url, value);
    const otherURL = loadPointDataset(id, "/synthetic/other.wgp", { cache });
    const otherID = loadPointDataset("other-id", url, { cache });
    expect(ControlledWorker.instances).toHaveLength(2);
    ControlledWorker.instances[0]!.loaded(dataset());
    ControlledWorker.instances[1]!.loaded({ ...dataset(), datasetId: "other-id" });
    await Promise.all([otherURL, otherID]);
    expect(cache.get(id, url)?.buffer).toBe(value.buffer);
    expect(cache.sizeBytes).toBe(252);
  });
});
