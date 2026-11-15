// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Event as CesiumEvent, Request, RequestErrorEvent, RequestScheduler, RequestState, Resource, type ImageryLayer, type Viewer } from "cesium";
import { ObservedAtlasProvider } from "../../packages/raster-runtime/src/observed-atlas-provider";
import { parseSingleRasterManifest, SingleRasterLayerController } from "@timemachine/raster-runtime";

// Resource, its HTTP status handling and RequestScheduler are real. Only the
// network and image decoder are browser stand-ins; no server or GPU is involved.
const requests: TileXHR[] = [];
class TileXHR {
  status = 0;
  responseType = "";
  response: Blob | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getAllResponseHeaders() { return "Content-Type: image/png\r\n"; }
  send() { requests.push(this); }
  abort() { this.aborted = true; }
  respond(status: number, blob = new Blob()) { this.status = status; this.response = blob; this.onload?.(); }
  fail() { this.onerror?.(); }
}

const blobs = new Map<string, Blob>();
const decodable = new Set<Blob>();
const maximumRequests = RequestScheduler.maximumRequests;
beforeEach(() => {
  requests.length = 0;
  blobs.clear(); decodable.clear();
  vi.stubGlobal("XMLHttpRequest", TileXHR);
  vi.stubGlobal("createImageBitmap", undefined);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(blob: Blob) { const url = `blob:synthetic-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url: string) { blobs.delete(url); }
  });
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    Object.defineProperty(image, "src", { set(url: string) {
      const valid = decodable.has(blobs.get(url)!);
      queueMicrotask(() => image.dispatchEvent(new Event(valid ? "load" : "error")));
    } });
    return image;
  });
});
afterEach(() => {
  RequestScheduler.maximumRequests = maximumRequests;
  vi.unstubAllGlobals();
});

function provider(policy?: "transparent-204", headers = true) {
  const source = new Resource({ url: "/synthetic/sparse/{z}/{x}/{y}.png", headers: headers ? { "X-Fixture": "synthetic" } : {} });
  const result = new ObservedAtlasProvider({ url: source, hasAlphaChannel: true }, policy);
  const failure = vi.fn();
  result.observe(() => {}, failure);
  return { result, failure };
}

describe("explicit sparse raster HTTP 204 protocol", () => {
  it("turns an actual HTTP 204 into a transparent tile instead of failing the frame", async () => {
    const { result, failure } = provider("transparent-204");
    const request = new Request({ throttle: false });
    const image = result.requestImage(3, 3, 2, request);
    expect(image).toBeInstanceOf(Promise);
    requests[0]!.respond(204);
    const tile = await image;
    expect(tile).toBeInstanceOf(HTMLCanvasElement);
    expect(tile).toMatchObject({ width: 256, height: 256 });
    expect(result.succeeded).toBe(1);
    expect(result.pending).toBe(0);
    expect(failure).not.toHaveBeenCalled();
    expect(request.state).toBe(RequestState.RECEIVED);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", url: "/synthetic/sparse/2/3/3.png", headers: { "X-Fixture": "synthetic" } });
  });

  it("uses a single HTTP request for headerless tiles and reuses the transparent canvas", async () => {
    const { result } = provider("transparent-204", false);
    const first = result.requestImage(3, 3, 2, new Request({ throttle: false }));
    void first?.catch(() => {}); // Own rejection even when an earlier RED assertion fails.
    expect(requests).toHaveLength(1);
    requests[0]!.respond(204);
    const tile = await first;
    const second = result.requestImage(2, 3, 2, new Request({ throttle: false }));
    requests[1]!.respond(204);
    expect(await second).toBe(tile);
    expect(requests).toHaveLength(2);
    expect(result.succeeded).toBe(2);
  });

  it("does not infer the empty tile protocol from alpha support", async () => {
    const { result, failure } = provider();
    const image = result.requestImage(3, 3, 2, new Request({ throttle: false }));
    requests[0]!.respond(204);
    expect(await image).toBeUndefined();
    expect(result.succeeded).toBe(0);
    expect(failure).toHaveBeenCalledOnce();
  });

  it.each(["/synthetic/{z}/{x}/{reverseY}.png", "/synthetic/{quadkey}.png"])("rejects unsupported sparse template %s instead of requesting wrong coordinates", url => {
    expect(() => new ObservedAtlasProvider({ url }, "transparent-204")).toThrow(/XYZ/);
    expect(() => new ObservedAtlasProvider({ url })).not.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("preserves immediate undefined throttling without requesting or counting a tile", () => {
    const { result, failure } = provider("transparent-204");
    RequestScheduler.maximumRequests = 0;
    expect(result.requestImage(0, 0, 0, new Request({ throttle: true }))).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(result.requested).toBe(0);
    expect(result.pending).toBe(0);
    expect(failure).not.toHaveBeenCalled();
  });

  it.each([403, 500])("preserves HTTP %i as an actual failure", async status => {
    const { result, failure } = provider("transparent-204");
    const image = result.requestImage(0, 0, 0, new Request({ throttle: false }))!;
    const error = image.catch(value => value);
    requests[0]!.respond(status);
    expect(await error).toBeInstanceOf(RequestErrorEvent);
    expect(await error).toMatchObject({ statusCode: status });
    expect(failure).toHaveBeenCalledWith(await error);
    expect(result.succeeded).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("preserves a network error without creating a transparent substitute", async () => {
    const { result, failure } = provider("transparent-204");
    const error = result.requestImage(0, 0, 0, new Request({ throttle: false }))!.catch(value => value);
    requests[0]!.fail();
    expect(await error).toBeInstanceOf(RequestErrorEvent);
    expect(failure).toHaveBeenCalledWith(await error);
    expect(result.succeeded).toBe(0);
  });

  it.each(["", "broken PNG bytes"])("preserves a 200 decode failure for %j", async bytes => {
    const { result, failure } = provider("transparent-204");
    const error = result.requestImage(0, 0, 0, new Request({ throttle: false }))!.catch(value => value);
    const invalid = new Blob([bytes], { type: "image/png" });
    requests[0]!.respond(200, invalid);
    expect(await error).toMatchObject({ type: "error", blob: invalid });
    expect(failure).toHaveBeenCalledWith(await error);
    expect(result.succeeded).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("returns the decoded 200 image and releases its temporary object URL", async () => {
    const { result, failure } = provider("transparent-204");
    const image = result.requestImage(0, 0, 0, new Request({ throttle: false }));
    const valid = new Blob(["synthetic decoded image"], { type: "image/png" });
    decodable.add(valid);
    requests[0]!.respond(200, valid);
    expect(await image).toBeInstanceOf(HTMLImageElement);
    expect(result.succeeded).toBe(1);
    expect(failure).not.toHaveBeenCalled();
    expect(blobs.size).toBe(0);
  });

  it("passes the actual Request through native cancellation and allows a later retry", async () => {
    const { result, failure } = provider("transparent-204");
    const request = new Request({ throttle: false });
    const error = result.requestImage(0, 0, 0, request)!.catch(value => value);
    expect(request.state).toBe(RequestState.ACTIVE);
    // These existing Cesium runtime methods normally run from Scene. They are
    // invoked only in this test to pump real cancellation, never replaced.
    (request as Request & { cancel(): void }).cancel();
    (RequestScheduler as typeof RequestScheduler & { update(): void }).update();
    await error;
    expect(request.state).toBe(RequestState.CANCELLED);
    expect(requests[0]!.aborted).toBe(true);
    expect(result.pending).toBe(0);
    expect(failure).not.toHaveBeenCalled();
    const retry = result.requestImage(0, 0, 0, new Request({ throttle: false }));
    requests[1]!.respond(204);
    expect(await retry).toBeInstanceOf(HTMLCanvasElement);
    expect(result.succeeded).toBe(1);
  });
});

function manifest(policy?: string) {
  return {
    schemaVersion: 1, id: "synthetic", label: "Synthetic", attribution: "Synthetic", defaultRasterId: "sparse",
    tileMatrixSet: { crs: "EPSG:3857", name: "WebMercatorQuad", tileSize: 256, bounds: [-180, -85, 180, 85] },
    rasters: [{ id: "sparse", label: "Sparse", kind: "synthetic", sourceId: "synthetic-sparse", sourceFile: "sparse.nc", sourceSha256: "0".repeat(64), byteLength: 1,
      tileUrl: "/synthetic/sparse/{z}/{x}/{y}.png", colorbar: null,
      tiles: { format: "image/png", minimumLevel: 0, maximumLevel: 4, hasAlphaChannel: false, ...(policy === undefined ? {} : { emptyTilePolicy: policy }) },
    }],
  };
}

function controllerHarness() {
  const layers: ImageryLayer[] = [];
  const scene = { postRender: new CesiumEvent(), renderError: new CesiumEvent(), globe: { tilesLoaded: true }, requestRender() {}, isDestroyed: () => false };
  const viewer = { scene, imageryLayers: {
    add(layer: ImageryLayer) { layers.push(layer); return layer; },
    contains: (layer: ImageryLayer) => layers.includes(layer),
    remove(layer: ImageryLayer) { layers.splice(layers.indexOf(layer), 1); layer.destroy(); return true; },
  } };
  const value = manifest("transparent-204");
  value.rasters.push({ ...value.rasters[0]!, id: "previous", sourceId: "synthetic-previous", tileUrl: "/synthetic/previous/{z}/{x}/{y}.png" });
  const states: string[] = [];
  const controller = new SingleRasterLayerController(viewer as unknown as Viewer, parseSingleRasterManifest(value), state => states.push(state.status));
  return { controller, layers, scene, states, render: () => scene.postRender.raiseEvent(scene) };
}

describe("sparse protocol manifest and controller", () => {
  it("retains explicit source policy and leaves unmarked sources unmarked", () => {
    expect(parseSingleRasterManifest(manifest("transparent-204")).rasters[0]!.tiles).toHaveProperty("emptyTilePolicy", "transparent-204");
    expect(parseSingleRasterManifest(manifest()).rasters[0]!.tiles.emptyTilePolicy).toBeUndefined();
  });

  it("rejects unknown source policy instead of silently accepting an unimplemented protocol", () => {
    expect(() => parseSingleRasterManifest(manifest("transparent-all-errors"))).toThrow(/empty.*policy/i);
  });

  it("commits a sparse controller candidate only after both real-frame stand-in boundaries", async () => {
    const { controller, layers, scene } = controllerHarness();
    const complete = controller.selectAsync("sparse").catch(error => error);
    try {
      const layer = layers[0]!;
      const image = layer.imageryProvider.requestImage(3, 3, 2, new Request({ throttle: false }));
      void image?.catch(() => {});
      expect(requests).toHaveLength(1);
      requests[0]!.respond(204);
      await image;
      expect(layer.imageryProvider.hasAlphaChannel).toBe(true);
      expect(controller.getCommittedRaster()).toBeUndefined();
      scene.globe.tilesLoaded = false; scene.postRender.raiseEvent(scene);
      expect(layer.alpha).toBe(0);
      scene.globe.tilesLoaded = true; scene.postRender.raiseEvent(scene);
      expect(controller.getCommittedRaster()).toBeUndefined();
      scene.postRender.raiseEvent(scene);
      expect(await complete).toMatchObject({ status: "ready", sourceId: "synthetic-sparse" });
      expect(controller.getCommittedRaster()?.id).toBe("sparse");
    } finally { controller.destroy(); await complete; }
  });

  it.each(["403", "500", "network", "bad-image", "empty-200"])("keeps the previously committed layer when an opted-in target fails with %s", async fault => {
    const h = controllerHarness();
    try {
      const previous = h.controller.selectAsync("previous");
      const old = h.layers[0]!;
      const image = old.imageryProvider.requestImage(0, 0, 0, new Request({ throttle: false }));
      const valid = new Blob(["synthetic decoded image"], { type: "image/png" });
      decodable.add(valid); requests[0]!.respond(200, valid);
      await image; h.render(); h.render(); await previous;
      const next = h.controller.selectAsync("sparse").catch(error => error);
      const failedImage = h.layers[1]!.imageryProvider.requestImage(0, 0, 0, new Request({ throttle: false }))!.catch(error => error);
      if (fault === "network") requests[1]!.fail();
      else if (fault === "bad-image" || fault === "empty-200") requests[1]!.respond(200, new Blob([fault === "bad-image" ? "broken" : ""], { type: "image/png" }));
      else requests[1]!.respond(Number(fault));
      await failedImage;
      expect(await next).toMatchObject({ kind: "load" });
      expect(h.controller.getCommittedRaster()?.id).toBe("previous");
      expect(h.layers).toEqual([old]);
      expect(old.show).toBe(true);
      expect(old.alpha).toBe(0.9);
      expect(h.states.at(-1)).toBe("error");
      expect(h.scene.postRender.numberOfListeners).toBe(0);
    } finally { h.controller.destroy(); }
  });
});
