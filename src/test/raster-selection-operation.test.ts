// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Event, ImageryLayerCollection, Request, type UrlTemplateImageryProvider, type Viewer } from "cesium";
import type { SingleRasterLayerController, SingleRasterManifest } from "@timemachine/raster-runtime";

const native = vi.hoisted(() => ({ requestImage: vi.fn<UrlTemplateImageryProvider["requestImage"]>() }));
vi.mock("cesium", async importOriginal => {
  const actual = await importOriginal<typeof import("cesium")>();
  return { ...actual, UrlTemplateImageryProvider: class extends actual.UrlTemplateImageryProvider {
    override requestImage(...args: Parameters<UrlTemplateImageryProvider["requestImage"]>) { return native.requestImage(...args); }
  } };
});

let registry: typeof import("../agent-actions/registry");
let runtime: typeof import("@timemachine/raster-runtime");
let target: Window;
let controller: SingleRasterLayerController;
let executeRasterSelection: typeof import("../layers/raster-selection-operation").executeRasterSelection;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  native.requestImage.mockReset().mockImplementation(async () => document.createElement("img"));
  runtime = await import("@timemachine/raster-runtime");
  registry = await import("../agent-actions/registry");
  ({ executeRasterSelection } = await import("../layers/raster-selection-operation"));
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(async () => {
  controller?.destroy();
  await Promise.resolve();
  registry.agentActions.disposeStateObservers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const api = () => target.timeMachineAgent!.v2;

async function harness() {
  const collection = new ImageryLayerCollection();
  const scene = {
    postRender: new Event(), renderError: new Event(), globe: { tilesLoaded: true },
    requestRender: () => {}, isDestroyed: () => false,
  };
  const manifest: SingleRasterManifest = {
    schemaVersion: 1, id: "raster-fixture", label: "Raster fixture", attribution: "Synthetic", defaultRasterId: "raster-0",
    tileMatrixSet: { crs: "EPSG:3857", name: "WebMercatorQuad", tileSize: 256, bounds: [-180, -85, 180, 85] },
    rasters: [0, 1, 2].map(index => ({
      id: `raster-${index}`, sourceId: `source-${index}`, label: `Raster ${index}`, kind: "synthetic",
      sourceFile: `${index}.png`, sourceSha256: String(index).repeat(64), tileUrl: `/synthetic/${index}/{z}/{x}/{y}.png`, byteLength: 256,
      tiles: { format: "image/png", minimumLevel: 0, maximumLevel: 4, hasAlphaChannel: true }, colorbar: null,
    })),
  };
  controller = new runtime.SingleRasterLayerController({ scene, imageryLayers: collection } as unknown as Viewer, manifest, () => {});
  const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
  registry.agentActions.register(AGENT_DECLARATIONS["raster.select"], async (params, context) => ({ data: {
    rasterId: params.rasterId,
    selection: await executeRasterSelection(controller, params.rasterId as string, context?.signal),
  } }));
  const render = () => scene.postRender.raiseEvent(scene);
  const candidate = () => collection.get(collection.length - 1);
  const load = async () => { await candidate().imageryProvider.requestImage(1, 1, 2, new Request({ throttle: false })); };
  return {
    scene, collection, render, candidate, load,
    async commit(id = "raster-0") {
      const result = executeRasterSelection(controller, id);
      await load(); render(); render(); await result;
      return candidate();
    },
  };
}
async function accepted(id = "raster-1") {
  const result = await api().execute("raster.select", { rasterId: id }, { completion: "accepted" });
  expect(result).toMatchObject({ ok: true, status: "accepted", jobId: expect.any(String) });
  if (!result.ok || result.status !== "accepted") throw new Error("Raster job was not accepted.");
  return result;
}

describe("Raster selection application boundary", () => {
  it("keeps accepted work running until the actual controller confirms the target frame", async () => {
    const h = await harness();
    const job = await accepted();
    h.render();
    expect(api().jobs.get(job.jobId)?.status).toBe("running");
    await h.load(); h.render();
    expect(controller.getCommittedRaster()).toBeUndefined();
    expect(api().jobs.get(job.jobId)?.status).toBe("running");
    h.render();
    const result = await api().jobs.wait(job.jobId);
    expect(result).toMatchObject({ ok: true, status: "completed", data: {
      rasterId: "raster-1", selection: { status: "ready", requestedRasterId: "raster-1", rasterId: "raster-1", sourceId: "source-1", generation: 1 },
    } });
    expect(await api().jobs.wait(job.jobId)).toEqual(result);
  });

  it("keeps hidden selection distinct from ready and waits for its hidden frame", async () => {
    const h = await harness();
    const old = await h.commit();
    controller.setVisible(false);
    const job = await accepted();
    expect(old.show).toBe(false);
    expect(api().jobs.get(job.jobId)?.status).toBe("running");
    h.render();
    expect(await api().jobs.wait(job.jobId)).toMatchObject({ status: "completed", data: {
      selection: { status: "hidden", requestedRasterId: "raster-1", reason: "disabled" },
    } });
    expect(controller.getCommittedRaster()?.id).toBe("raster-0");
  });

  it("maps explicit cancellation only after the runtime restores and renders the old raster", async () => {
    const h = await harness();
    const old = await h.commit();
    const job = await accepted();
    await h.load(); h.render();
    expect(old.show).toBe(false);
    expect(await api().jobs.cancel(job.jobId)).toMatchObject({ status: "accepted", jobId: job.jobId });
    expect(old.show).toBe(true);
    expect(api().jobs.get(job.jobId)).toMatchObject({ status: "running", cancellationRequested: true });
    h.render();
    expect(await api().jobs.wait(job.jobId)).toMatchObject({ ok: false, status: "cancelled", error: { kind: "cancelled", code: "CANCELLED" } });
    expect(controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(h.scene.postRender.numberOfListeners + h.scene.renderError.numberOfListeners).toBe(0);
  });

  it("reports controller disposal as cancellation instead of an internal failure", async () => {
    await harness();
    const job = await accepted();
    controller.destroy();
    expect(await api().jobs.wait(job.jobId)).toMatchObject({ status: "cancelled", error: { kind: "cancelled" } });
  });

  it("keeps replaced requests superseded while the replacement alone commits", async () => {
    const h = await harness();
    const first = await accepted("raster-1");
    const second = await accepted("raster-2");
    expect(await api().jobs.wait(first.jobId)).toMatchObject({ status: "superseded", error: { kind: "superseded", code: "SUPERSEDED" } });
    expect(api().jobs.get(second.jobId)?.status).toBe("running");
    await h.load(); h.render(); h.render();
    expect(await api().jobs.wait(second.jobId)).toMatchObject({ status: "completed", data: { selection: { rasterId: "raster-2" } } });
    expect(api().jobs.get(first.jobId)?.status).toBe("superseded");
  });

  it("preserves v1 busy compatibility for a request superseded by the same UI business call", async () => {
    const h = await harness();
    const first = target.timeMachineAgent!.execute("raster.select", { rasterId: "raster-1" });
    const second = executeRasterSelection(controller, "raster-2");
    void second.catch(() => undefined);
    expect(await first).toMatchObject({ actionId: "raster.select", ok: false, error: { kind: "busy", code: 409 } });
    await h.load(); h.render(); h.render();
    expect(await second).toMatchObject({ status: "ready", rasterId: "raster-2" });
  });

  it("leaves a timed-out wait running and later returns the same actual completed job", async () => {
    const h = await harness();
    const job = await accepted();
    const wait = api().jobs.wait(job.jobId, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await wait).toMatchObject({ status: "unknown", jobId: job.jobId, error: { kind: "timeout" } });
    expect(api().jobs.get(job.jobId)).toMatchObject({ status: "running", cancellationRequested: false });
    expect(h.collection.length).toBe(1);
    await h.load(); h.render(); h.render();
    expect(await api().jobs.wait(job.jobId)).toMatchObject({ status: "completed", jobId: job.jobId });
  });

  it.each(["load", "render", "recovery"] as const)("does not misclassify an actual %s failure as cancellation", async kind => {
    const h = await harness();
    const old = await h.commit();
    const job = await accepted();
    if (kind === "load") {
      native.requestImage.mockRejectedValueOnce(new Error("Synthetic image cancelled-looking failure"));
      await h.load().catch(() => undefined);
    } else {
      await h.load(); h.render();
      if (kind === "render") {
        h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic render cancelled-looking failure"));
        await vi.advanceTimersByTimeAsync(0);
        expect(api().jobs.get(job.jobId)?.status).toBe("running");
        expect(old.show).toBe(true);
        h.render();
      } else {
        await api().jobs.cancel(job.jobId);
        h.scene.renderError.raiseEvent(h.scene, new Error("Synthetic recovery cancelled-looking failure"));
      }
    }
    const result = await api().jobs.wait(job.jobId);
    expect(result).toMatchObject({ ok: false, status: "failed", error: { kind: "internal" } });
    expect(result.ok ? undefined : result.error.message).toBe(`Synthetic ${kind === "load" ? "image" : kind} cancelled-looking failure`);
    expect(controller.getCommittedRaster()?.id).toBe("raster-0");
    expect(old.show).toBe(true);
  });

  it("rejects a pre-aborted request without allocating a native layer", async () => {
    const h = await harness();
    const aborted = new AbortController(); aborted.abort();
    await expect(executeRasterSelection(controller, "raster-1", aborted.signal)).rejects.toMatchObject({ name: "OperationInterruptedError", reason: "cancelled" });
    expect(h.collection.length).toBe(0);
  });
});
