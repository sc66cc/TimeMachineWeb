// @vitest-environment jsdom

import {
  Cartesian2,
  GeometryInstance,
  PolylineCollection,
  Primitive,
  PrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from "cesium";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_QUATERNION, type PlateFeature, type RotationModel } from "@timemachine/reconstruction-core";
import { PlateRenderer, PlateRendererCreateError, type PlatePick } from "@timemachine/cesium-runtime";

for (const name of ["ImageBitmap", "OffscreenCanvas"]) {
  if (typeof (globalThis as Record<string, unknown>)[name] === "undefined") {
    (globalThis as Record<string, unknown>)[name] = class {};
  }
}

function feature(plateId = 101): PlateFeature {
  return {
    id: `plate-${plateId}`, plateId, name: "Plate", description: "",
    validFromMa: 100, validToMa: 0, sourceIndex: 0,
    polygons: [{ exterior: [[0, 0], [12, 0], [12, 12], [0, 12]], holes: [] }],
  };
}

function harness(destroyPrimitives = true) {
  const primitives = new PrimitiveCollection({ destroyPrimitives });
  const added: (Primitive | PolylineCollection)[] = [];
  const postRender = new Set<() => void>();
  const renderError = new Set<(...args: unknown[]) => void>();
  const pick = vi.fn();
  const add = vi.spyOn(primitives, "add").mockImplementation((primitive) => {
    added.push(primitive);
    return PrimitiveCollection.prototype.add.call(primitives, primitive);
  });
  const viewer = {
    isDestroyed: () => false,
    scene: {
      canvas: document.createElement("canvas"), primitives, pick,
      isDestroyed: () => false, requestRender: vi.fn(),
      postRender: { addEventListener: (fn: () => void) => { postRender.add(fn); return () => { postRender.delete(fn); }; } },
      renderError: { addEventListener: (fn: (...args: unknown[]) => void) => { renderError.add(fn); return () => { renderError.delete(fn); }; } },
    },
  } as unknown as Viewer;
  return { viewer, primitives, added, add, pick, postRender, renderError };
}

function nativePick(fill: Primitive): PlatePick {
  return (fill.geometryInstances as GeometryInstance[])[0]!.id as PlatePick;
}

function click(renderer: PlateRenderer): void {
  const handler = (renderer as unknown as { clickHandler: ScreenSpaceEventHandler }).clickHandler;
  const callback = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as (event: { position: Cartesian2 }) => void;
  callback({ position: new Cartesian2(1, 1) });
}

const model = { getRotationMap: () => new Map([[101, IDENTITY_QUATERNION]]) } as unknown as RotationModel;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PlateRenderer instance identity", () => {
  it("keeps the three-argument default and gives extra instances no graticule", async () => {
    const h = harness();
    const progress = vi.fn();
    const first = await PlateRenderer.create(h.viewer, [feature()], progress);
    const second = await PlateRenderer.create(h.viewer, [feature()], undefined, { layerId: 24, graticule: false });
    expect(progress).toHaveBeenCalledWith(1, 1);
    expect(h.added).toHaveLength(5);
    expect(nativePick(h.added[1] as Primitive)).not.toHaveProperty("layerId");
    expect(nativePick(h.added[3] as Primitive).layerId).toBe(24);
    first.destroy();
    expect(h.primitives.length).toBe(2);
    expect(h.added[3]!.isDestroyed()).toBe(false);
    second.destroy();
    expect(h.primitives.length).toBe(0);
  });

  it("only delivers the renderer's actual native id, including legacy calls without layerId", async () => {
    const h = harness();
    const first = await PlateRenderer.create(h.viewer, [feature()]);
    const second = await PlateRenderer.create(h.viewer, [feature()]);
    const firstCallback = vi.fn(); const secondCallback = vi.fn();
    first.setPickCallback(firstCallback); second.setPickCallback(secondCallback);
    const id = nativePick(h.added[4] as Primitive);
    h.pick.mockReturnValue({ id });
    click(first); click(second);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledExactlyOnceWith(id);
    h.pick.mockReturnValue({ id: { ...id } });
    click(first); click(second);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
    first.destroy(); second.destroy();
  });

  it("keeps flat native picks instance-owned and tagged, without mutating CPU picks", async () => {
    const h = harness();
    const first = await PlateRenderer.create(h.viewer, [feature()], undefined, { layerId: 30, graticule: false });
    const second = await PlateRenderer.create(h.viewer, [feature()], undefined, { layerId: 31, graticule: false });
    const firstCallback = vi.fn(); const secondCallback = vi.fn();
    first.setPickCallback(firstCallback); second.setPickCallback(secondCallback);
    const handle = await second.prepareRectangleFrame(50, model);
    const cpuPick = (second as unknown as { rectanglePreparation: { data: { plates: { polygons: { pick: PlatePick }[] }[] } } }).rectanglePreparation.data.plates[0]!.polygons[0]!.pick;
    const pending = second.stageRectangleFrame(handle, 1);
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    const id = nativePick(h.added[h.added.length - 2] as Primitive);
    expect(id.layerId).toBe(31);
    expect(id).not.toBe(cpuPick);
    expect(cpuPick).not.toHaveProperty("layerId");
    h.pick.mockReturnValue({ id }); click(first); click(second);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledExactlyOnceWith(id);
    second.cancelRectangleStaging(); await rejected;
    first.destroy(); second.destroy();
  });
});

describe("PlateRenderer creation cancellation and cleanup", () => {
  it("rejects an already-aborted create before allocating native resources", async () => {
    const h = harness(); const controller = new AbortController(); controller.abort();
    const handlers = vi.spyOn(ScreenSpaceEventHandler.prototype, "setInputAction");
    await expect(PlateRenderer.create(h.viewer, [feature()], undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.added).toHaveLength(0); expect(handlers).not.toHaveBeenCalled();
  });

  it("observes abort from real progress without resolving a partial renderer", async () => {
    const h = harness(); const controller = new AbortController();
    await expect(PlateRenderer.create(h.viewer, [feature()], () => controller.abort(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.primitives.length).toBe(0);
    expect(h.added.every((value) => value.isDestroyed())).toBe(true);
  });

  it("aborts while the real eight-plate build yield is pending and cancels that frame", async () => {
    const h = harness(); const controller = new AbortController();
    const raf = vi.fn(() => 42); const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf); vi.stubGlobal("cancelAnimationFrame", cancel);
    const pending = PlateRenderer.create(h.viewer, Array.from({ length: 9 }, (_, i) => feature(i + 1)), undefined, { signal: controller.signal });
    expect(raf).toHaveBeenCalledTimes(1);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(42);
    expect(h.primitives.length).toBe(0);
    expect(h.added.every((value) => value.isDestroyed())).toBe(true);
  });

  it("preserves a thrown progress error after releasing all created resources", async () => {
    const h = harness(); const error = new Error("progress failed");
    const handlers = vi.spyOn(ScreenSpaceEventHandler.prototype, "destroy");
    await expect(PlateRenderer.create(h.viewer, [feature()], () => { throw error; })).rejects.toBe(error);
    expect(h.primitives.length).toBe(0); expect(handlers).toHaveBeenCalledTimes(1);
    expect(h.added.every((value) => value.isDestroyed())).toBe(true);
  });

  it("cleans resources allocated before scene insertion fails", async () => {
    const h = harness(); const error = new Error("scene add failed");
    const outlinesDestroyed = vi.spyOn(PolylineCollection.prototype, "destroy");
    const fillsDestroyed = vi.spyOn(Primitive.prototype, "destroy");
    h.add.mockImplementationOnce(() => { throw error; });
    await expect(PlateRenderer.create(h.viewer, [feature()], undefined, { graticule: false })).rejects.toBe(error);
    expect(fillsDestroyed).toHaveBeenCalledTimes(1);
    expect(outlinesDestroyed).toHaveBeenCalledTimes(1);
    expect(h.primitives.length).toBe(0);
  });

  it("exposes native outline failure instead of disguising it as a skipped polygon", async () => {
    const h = harness(); const error = new Error("outline material failed");
    vi.spyOn(PolylineCollection.prototype, "add").mockImplementationOnce(() => { throw error; });
    const destroyed = vi.spyOn(PolylineCollection.prototype, "destroy");
    await expect(PlateRenderer.create(h.viewer, [feature()], undefined, { graticule: false })).rejects.toBe(error);
    expect(destroyed).toHaveBeenCalledTimes(1); expect(h.primitives.length).toBe(0);
  });

  it("returns the failed owner only when create cleanup fails, and permits an explicit retry", async () => {
    const h = harness(); const buildError = new Error("progress failed"); const cleanupError = new Error("primitive release failed");
    vi.spyOn(Primitive.prototype, "destroy").mockImplementationOnce(() => { throw cleanupError; });
    let failure: unknown;
    try { await PlateRenderer.create(h.viewer, [feature()], () => { throw buildError; }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PlateRendererCreateError);
    const result = failure as PlateRendererCreateError;
    expect(result.cause).toBe(buildError);
    expect(result.cleanupError).toBeInstanceOf(AggregateError);
    expect((result.cleanupError as AggregateError).errors).toContain(cleanupError);
    expect(h.added[0]!.isDestroyed()).toBe(true);
    expect(h.added[2]!.isDestroyed()).toBe(true);
    expect(h.added[1]!.isDestroyed()).toBe(false);
    result.renderer.destroy();
    expect(h.added[1]!.isDestroyed()).toBe(true);
    expect(() => result.renderer.destroy()).not.toThrow();
  });
});

describe("PlateRenderer release retry", () => {
  it.each([true, false])("cleans other owners after a failure, then retries only the failed primitive (collection owns=%s)", async (owns) => {
    const h = harness(owns);
    const first = await PlateRenderer.create(h.viewer, [feature()]);
    const second = await PlateRenderer.create(h.viewer, [feature()], undefined, { layerId: 41, graticule: false });
    const failed = h.added[1] as Primitive; const error = new Error("first release failed");
    const originalDestroy = failed.destroy.bind(failed);
    const destroy = vi.spyOn(failed, "destroy").mockImplementationOnce(() => { throw error; }).mockImplementation(originalDestroy);
    const handlers = vi.spyOn(ScreenSpaceEventHandler.prototype, "destroy");
    expect(() => first.destroy()).toThrow(AggregateError);
    expect(failed.isDestroyed()).toBe(false);
    expect(h.added[0]!.isDestroyed()).toBe(true);
    expect(h.added[2]!.isDestroyed()).toBe(true);
    expect(h.added[3]!.isDestroyed()).toBe(false);
    expect(h.primitives.length).toBe(2);
    first.destroy(); first.destroy();
    expect(destroy).toHaveBeenCalledTimes(2); expect(handlers).toHaveBeenCalledTimes(1);
    expect(failed.isDestroyed()).toBe(true);
    await expect(first.prepareRectangleFrame(50, model)).rejects.toThrow(/destroyed/);
    second.destroy(); expect(h.primitives.length).toBe(0);
  });

  it("retains a failed flat staging owner after the staging slot is cleared", async () => {
    const h = harness(); const renderer = await PlateRenderer.create(h.viewer, [feature()]);
    const prepared = await renderer.prepareRectangleFrame(50, model);
    const pending = renderer.stageRectangleFrame(prepared, 1);
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    const fill = h.added[h.added.length - 2] as Primitive;
    const outlines = h.added[h.added.length - 1] as PolylineCollection;
    const originalDestroy = fill.destroy.bind(fill);
    vi.spyOn(fill, "destroy").mockImplementationOnce(() => { throw new Error("flat release failed"); }).mockImplementation(originalDestroy);
    expect(() => renderer.cancelRectangleStaging()).toThrow(); await rejected;
    expect(fill.isDestroyed()).toBe(false);
    expect(outlines.isDestroyed()).toBe(true);
    expect(h.postRender.size).toBe(0); expect(h.renderError.size).toBe(0);
    renderer.destroy();
    expect(fill.isDestroyed()).toBe(true); expect(h.primitives.length).toBe(0);
  });
});
