import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { installAgentActions, AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { ProjectSession } from "../project/project-session";
import { registerLayerInstanceActions, type LayerInstanceAdapter } from "../layers/instance-actions";

let session: ProjectSession;
let target: Window;
let adapter: LayerInstanceAdapter;
const input = () => ({ name: "Sample", type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
const rasterInput = () => ({ ...input(), type: ProjectLayerType.Raster, sourceRef: "local:single-raster-manifest" });
const atlasInput = () => ({ ...input(), type: ProjectLayerType.Atlas, sourceRef: "local:paleoatlas-manifest" });
const api = () => target.timeMachineAgent!.v2;
beforeEach(() => {
  session = new ProjectSession("Instances");
  target = {} as Window;
  installAgentActions(target);
  adapter = { assertCanAdd: vi.fn(), load: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), publish: vi.fn(), persist: vi.fn() };
  registerLayerInstanceActions(session, adapter);
});

describe("layer instance application commands", () => {
  it("adds same-source Atlas records independently and waits for native attachment before completion", async () => {
    let finish!: () => void;
    vi.mocked(adapter.load).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const accepted = await api().execute("layer.add", { layer: atlasInput() }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalled());
    expect(api().jobs.get(accepted.jobId!)?.status).toBe("running");
    expect(session.getLayer(103)).toMatchObject({ type: ProjectLayerType.Atlas, sourceRef: "local:paleoatlas-manifest" });
    for (const field of ["pointStyle", "lineStyle", "polygonStyle", "rasterId"] as const) expect(session.getLayer(103)?.[field]).toBeUndefined();
    expect(adapter.assertCanAdd).toHaveBeenCalledWith(atlasInput());
    finish(); expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: true, data: { layerId: 103, frameConfirmed: true } });
    expect(await api().execute("layer.add", { layer: atlasInput() })).toMatchObject({ ok: true, data: { layerId: 104 } });
    let release!: () => void;
    vi.mocked(adapter.remove).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const removal = await api().execute("layer.remove", { layerId: 103 }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.remove).toHaveBeenCalledWith(103));
    expect(api().jobs.get(removal.jobId!)?.status).toBe("running"); expect(session.getLayer(103)).toBeDefined();
    release(); expect(await api().jobs.wait(removal.jobId!)).toMatchObject({ ok: true, data: { removed: true, frameConfirmed: true } });
    expect(session.getLayer(103)).toBeUndefined(); expect(session.getLayer(104)).toBeDefined();
    expect(await api().execute("layer.remove", { layerId: 1 })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(adapter.remove).toHaveBeenCalledTimes(1); expect(session.getLayer(1)).toBeDefined();
  });

  it("rejects Atlas rasterId, per-layer age, atlasId and mismatched sources without side effects", async () => {
    const before = session.toSnapshot(new Date(0));
    for (const extra of [{ rasterId: "raster-a" }, { rasterId: undefined }, { atlasId: "atlas-a" }, { timeMa: 10 }, { ageMa: 10 }]) {
      expect(await api().execute("layer.add", { layer: { ...atlasInput(), ...extra } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    for (const layer of [{ ...atlasInput(), sourceRef: "local:single-raster-manifest" }, { ...rasterInput(), sourceRef: "local:paleoatlas-manifest" }, { ...input(), sourceRef: "local:paleoatlas-manifest" }]) {
      expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    }
    expect(session.toSnapshot(new Date(0))).toEqual(before);
    for (const callback of [adapter.assertCanAdd, adapter.load, adapter.remove, adapter.publish, adapter.persist]) expect(callback).not.toHaveBeenCalled();
  });

  it("checks the Atlas adapter guard before allocating and preserves failed load/cleanup records", async () => {
    const before = session.toSnapshot(new Date(0));
    vi.mocked(adapter.assertCanAdd).mockImplementationOnce(() => { throw new AgentActionUnsupportedError("Atlas manifest unavailable"); });
    expect(await api().execute("layer.add", { layer: atlasInput() })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(adapter.assertCanAdd).toHaveBeenCalledTimes(1); expect(session.toSnapshot(new Date(0))).toEqual(before); expect(adapter.load).not.toHaveBeenCalled(); expect(adapter.persist).not.toHaveBeenCalled();
    vi.mocked(adapter.load).mockRejectedValueOnce(new Error("Synthetic Atlas load failure"));
    expect(await api().execute("layer.add", { layer: atlasInput() })).toMatchObject({ ok: false, status: "failed" });
    expect(session.getLayer(103)?.sourceRef).toBe("local:paleoatlas-manifest");
    vi.mocked(adapter.remove).mockRejectedValueOnce(new Error("Synthetic Atlas cleanup failure"));
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: false, status: "failed" }); expect(session.getLayer(103)).toBeDefined();
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { removed: true } });
    expect(session.getLayer(103)).toBeUndefined(); expect(session.getLayer(1)).toBeDefined();
  });

  it("adds same-source Raster instances with independent raster IDs and no vector style", async () => {
    for (const [rasterId, layerId] of [["raster-a", 103], ["raster-b", 104]] as const) {
      expect(await api().execute("layer.add", { layer: { ...rasterInput(), rasterId } })).toMatchObject({ ok: true, data: { layerId, frameConfirmed: true } });
      expect(session.getLayer(layerId)).toMatchObject({ type: ProjectLayerType.Raster, sourceRef: "local:single-raster-manifest", rasterId });
      for (const style of ["pointStyle", "lineStyle", "polygonStyle"] as const) expect(session.getLayer(layerId)?.[style]).toBeUndefined();
      expect(adapter.assertCanAdd).toHaveBeenCalledWith({ ...rasterInput(), rasterId });
      expect(adapter.load).toHaveBeenCalledWith(layerId, "local:single-raster-manifest", expect.any(AbortSignal));
    }
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { removed: true, frameConfirmed: true } });
    expect(session.getLayer(103)).toBeUndefined(); expect(session.getLayer(104)?.rasterId).toBe("raster-b"); expect(session.getLayer(3)).toBeDefined();
  });

  it("accepts missing rasterId for the adapter's compatible default without inventing one", async () => {
    expect(await api().execute("layer.add", { layer: rasterInput() })).toMatchObject({ ok: true, data: { layerId: 103 } });
    expect(adapter.assertCanAdd).toHaveBeenCalledWith(rasterInput());
    expect(session.getLayer(103)?.rasterId).toBeUndefined();
    expect(session.getLayer(103)?.pointStyle).toBeUndefined();
  });

  it("keeps Raster add and remove pending until their adapter completions", async () => {
    let finishLoad!: () => void, finishRemove!: () => void;
    vi.mocked(adapter.load).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const add = await api().execute("layer.add", { layer: { ...rasterInput(), rasterId: "raster-a" } }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalled());
    expect(api().jobs.get(add.jobId!)?.status).toBe("running"); expect(session.getLayer(103)?.rasterId).toBe("raster-a");
    finishLoad(); expect(await api().jobs.wait(add.jobId!)).toMatchObject({ ok: true, data: { frameConfirmed: true } });
    vi.mocked(adapter.remove).mockImplementationOnce(() => new Promise(resolve => { finishRemove = resolve; }));
    const remove = await api().execute("layer.remove", { layerId: 103 }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.remove).toHaveBeenCalled());
    expect(api().jobs.get(remove.jobId!)?.status).toBe("running"); expect(session.getLayer(103)).toBeDefined();
    finishRemove(); expect(await api().jobs.wait(remove.jobId!)).toMatchObject({ ok: true, data: { removed: true } }); expect(session.getLayer(103)).toBeUndefined();
  });

  it("rejects invalid Raster fields and vector rasterId before business mutation or adapter I/O", async () => {
    const before = session.toSnapshot(new Date(0));
    for (const rasterId of ["", " \t\n", null, 0, false, {}, undefined]) {
      expect(await api().execute("layer.add", { layer: { ...rasterInput(), rasterId } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    for (const layer of [input(), { ...input(), type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1" }, { ...input(), type: ProjectLayerType.Polygon, sourceRef: "fixture:goal-polygons-v1" }]) {
      expect(await api().execute("layer.add", { layer: { ...layer, rasterId: "raster-a" } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    expect(await api().execute("layer.add", { layer: { ...rasterInput(), extra: true } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    for (const layer of [{ ...rasterInput(), sourceRef: "fixture:goal-points-v1" }, { ...input(), sourceRef: "local:single-raster-manifest" }]) {
      expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    }
    expect(session.toSnapshot(new Date(0))).toEqual(before);
    for (const callback of [adapter.assertCanAdd, adapter.load, adapter.remove, adapter.publish, adapter.persist]) expect(callback).not.toHaveBeenCalled();
  });

  it("runs Raster manifest membership validation before allocating an ID or persisting", async () => {
    const before = session.toSnapshot(new Date(0));
    vi.mocked(adapter.assertCanAdd).mockImplementation(value => {
      expect(value).toEqual({ ...rasterInput(), rasterId: "missing" });
      expect(session.toSnapshot(new Date(0))).toEqual(before);
      throw new AgentActionValidationError("Unknown raster in manifest.");
    });
    expect(await api().execute("layer.add", { layer: { ...rasterInput(), rasterId: "missing" } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(session.toSnapshot(new Date(0))).toEqual(before); expect(adapter.load).not.toHaveBeenCalled(); expect(adapter.publish).not.toHaveBeenCalled(); expect(adapter.persist).not.toHaveBeenCalled();
    vi.mocked(adapter.assertCanAdd).mockImplementation(() => undefined);
    expect(await api().execute("layer.add", { layer: rasterInput() })).toMatchObject({ ok: true, data: { layerId: 103 } });
  });

  it("retains failed Raster records and retries cleanup without touching the default Raster", async () => {
    vi.mocked(adapter.load).mockRejectedValueOnce(new Error("Synthetic Raster load failure"));
    expect(await api().execute("layer.add", { layer: { ...rasterInput(), rasterId: "raster-a" } })).toMatchObject({ ok: false, status: "failed" });
    expect(session.getLayer(103)?.rasterId).toBe("raster-a");
    vi.mocked(adapter.remove).mockRejectedValueOnce(new Error("Synthetic Raster cleanup failure"));
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: false, status: "failed" });
    expect(session.getLayer(103)).toBeDefined(); expect(adapter.persist).toHaveBeenCalledTimes(1);
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { removed: true, frameConfirmed: true } });
    expect(session.getLayer(103)).toBeUndefined(); expect(adapter.persist).toHaveBeenCalledTimes(2);
    expect(await api().execute("layer.remove", { layerId: 3 })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(adapter.remove).toHaveBeenCalledTimes(2); expect(session.getLayer(3)).toBeDefined();
  });

  it("adds an independent polygon instance and removes only its record after release", async () => {
    const layer = { ...input(), type: ProjectLayerType.Polygon, sourceRef: "fixture:goal-polygons-v1" };
    expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: true, data: { layerId: 103, frameConfirmed: true } });
    expect(session.getLayer(103)).toMatchObject({ type: ProjectLayerType.Polygon, polygonStyle: { fillColor: "#38bdf8", outlineColor: "#ffffff", outlineWidth: 2 } });
    expect(session.getLayer(103)?.pointStyle).toBeUndefined();
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { removed: true } });
    expect(session.layerList).toHaveLength(4);
  });
  it("adds and removes independent line instances with line-specific default style", async () => {
    const layer = { ...input(), type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1" };
    expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: true, data: { layerId: 103, frameConfirmed: true } });
    expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: true, data: { layerId: 104, frameConfirmed: true } });
    expect(session.getLayer(103)).toMatchObject({ type: ProjectLayerType.Line, lineStyle: { lineColor: "#38bdf8", lineWidth: 2 } });
    expect(session.getLayer(103)?.pointStyle).toBeUndefined();
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { removed: true } });
    expect(session.getLayer(104)).toBeDefined();
  });

  it("keeps same-source instances separate and does not report complete before runtime frame", async () => {
    let finish!: () => void;
    vi.mocked(adapter.load).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const accepted = await api().execute("layer.add", { layer: input() }, { completion: "accepted" });
    expect(accepted.status).toBe("accepted");
    await vi.waitFor(() => expect(session.getLayer(103)).toBeDefined());
    expect(api().jobs.get(accepted.jobId!)?.status).toBe("running");
    finish();
    expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: true, data: { layerId: 103, frameConfirmed: true } });
    const second = await api().execute("layer.add", { layer: input() });
    expect(second).toMatchObject({ ok: true, data: { layerId: 104, frameConfirmed: true } });
    expect(session.getLayer(103)?.sourceRef).toBe(session.getLayer(104)?.sourceRef);
  });

  it("validates nested input and supported source/type before changing the project", async () => {
    for (const layer of [{ ...input(), alpha: 2 }, { ...input(), unexpected: true }, { ...input(), groupId: 9999 }, { ...input(), name: " " }]) {
      expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    for (const layer of [{ ...input(), type: ProjectLayerType.Line }, { ...input(), sourceRef: "service:unimplemented" }]) {
      expect(await api().execute("layer.add", { layer })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    }
    expect(session.layerList).toHaveLength(4);
    expect(adapter.persist).not.toHaveBeenCalled();
    expect(adapter.load).not.toHaveBeenCalled();
  });

  it("preserves a failed layer for diagnosis and removes its record only after runtime cleanup", async () => {
    vi.mocked(adapter.load).mockRejectedValueOnce(new Error("Synthetic native failure"));
    expect(await api().execute("layer.add", { layer: input() })).toMatchObject({ ok: false, status: "failed" });
    expect(session.getLayer(103)).toBeDefined();
    vi.mocked(adapter.remove).mockRejectedValueOnce(new Error("Synthetic cleanup failure"));
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: false });
    expect(session.getLayer(103)).toBeDefined();
    expect(await api().execute("layer.remove", { layerId: 103 })).toMatchObject({ ok: true, data: { layerId: 103, removed: true, frameConfirmed: true } });
    expect(session.getLayer(103)).toBeUndefined();
    expect(session.getLayer(2)).toBeDefined();
  });

  it("refuses default/unknown removal and scene guard before project mutation", async () => {
    expect(await api().execute("layer.remove", { layerId: 2 })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(await api().execute("layer.remove", { layerId: 9999 })).toMatchObject({ ok: false, error: { kind: "validation" } });
    vi.mocked(adapter.assertCanAdd).mockImplementation(() => { throw new AgentActionUnsupportedError("Unsupported current projection"); });
    expect(await api().execute("layer.add", { layer: input() })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(session.layerList).toHaveLength(4);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it.each(["Point", "Raster", "Atlas"] as const)("cleans a late %s runtime result before confirming cancellation", async kind => {
    let finish!: () => void;
    vi.mocked(adapter.load).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const accepted = await api().execute("layer.add", { layer: kind === "Atlas" ? atlasInput() : kind === "Raster" ? rasterInput() : input() }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.load).toHaveBeenCalled());
    api().jobs.cancel(accepted.jobId!);
    finish();
    expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: false, status: "cancelled" });
    expect(adapter.remove).toHaveBeenCalledWith(103, true);
    expect(session.getLayer(103)).toBeDefined();
    expect(await api().catalog.describe("layer.remove")).toMatchObject({ execution: "job", cancellationSupported: false, completion: "frame-committed" });
  });
});
