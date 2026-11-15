import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { installAgentActions } from "../agent-actions/registry";
import { ProjectSession } from "../project/project-session";
import { registerLayerInstanceActions, type LayerInstanceAdapter } from "../layers/instance-actions";

const source = "fixture:goal-points-v1";
let session: ProjectSession, target: Window, adapter: LayerInstanceAdapter;
let binding: ReturnType<typeof registerLayerInstanceActions>;
const api = () => target.timeMachineAgent!.v2;
const add = () => session.addLayer({ name: "Keep settings", type: ProjectLayerType.Point, sourceRef: source, groupId: 101, active: false, alpha: 0.35 });
beforeEach(() => {
  session = new ProjectSession("Retry"); target = {} as Window; installAgentActions(target);
  adapter = { assertCanAdd: vi.fn(), load: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined), publish: vi.fn(), persist: vi.fn() };
  binding = registerLayerInstanceActions(session, adapter);
});

describe("layer.retry application lifecycle", () => {
  it("preserves identity/settings and waits for replacement frame, allowing another instance to progress", async () => {
    const layerId = add(), otherId = add(), before = session.toSnapshot(new Date(0));
    let finish!: () => void;
    vi.mocked(adapter.retry!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const accepted = await api().execute("layer.retry", { layerId }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.retry).toHaveBeenCalledWith(layerId, expect.any(AbortSignal)));
    expect(api().jobs.get(accepted.jobId!)?.status).toBe("running");
    expect(binding.isRetrying(layerId)).toBe(true);
    expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(await api().execute("layer.remove", { layerId })).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(await api().execute("layer.retry", { layerId: otherId })).toMatchObject({ ok: true });
    finish();
    expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: true, data: { layerId, sourceRef: source, frameConfirmed: true } });
    expect(binding.isRetrying(layerId)).toBe(false);
    expect(session.toSnapshot(new Date(0))).toEqual(before);
    expect(adapter.persist).not.toHaveBeenCalled(); expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("holds the retry lock until late cancellation cleanup finishes, preserving the error record", async () => {
    const layerId = add(); let finish!: () => void, release!: () => void;
    vi.mocked(adapter.retry!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(adapter.remove).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const accepted = await api().execute("layer.retry", { layerId }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.retry).toHaveBeenCalled());
    api().jobs.cancel(accepted.jobId!); finish();
    await vi.waitFor(() => expect(adapter.remove).toHaveBeenCalledWith(layerId, true));
    expect(binding.isRetrying(layerId)).toBe(true);
    expect(api().jobs.get(accepted.jobId!)?.status).toBe("running");
    expect(await api().execute("layer.remove", { layerId })).toMatchObject({ ok: false, error: { kind: "busy" } });
    release();
    expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: false, status: "cancelled" });
    expect(session.getLayer(layerId)).toBeDefined(); expect(binding.isRetrying(layerId)).toBe(false);
    expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: true });
  });

  it("reports cleanup failure instead of successful cancellation and releases the action lock for explicit retry", async () => {
    const layerId = add(); let finish!: () => void;
    vi.mocked(adapter.retry!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(adapter.remove).mockRejectedValueOnce(new Error("Cleanup failed"));
    const accepted = await api().execute("layer.retry", { layerId }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.retry).toHaveBeenCalled());
    api().jobs.cancel(accepted.jobId!); finish();
    expect(await api().jobs.wait(accepted.jobId!)).toMatchObject({ ok: false, status: "failed", error: { kind: "internal" } });
    expect(session.getLayer(layerId)).toBeDefined(); expect(binding.isRetrying(layerId)).toBe(false);
    expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: true });
  });

  it("rejects retry while concurrent removals own the record, including the final publish callback", async () => {
    const layerId = add(); let finish!: () => void;
    const removal = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(adapter.remove).mockReturnValue(removal);
    const first = await api().execute("layer.remove", { layerId }, { completion: "accepted" });
    const second = await api().execute("layer.remove", { layerId }, { completion: "accepted" });
    await vi.waitFor(() => expect(adapter.remove).toHaveBeenCalledTimes(2));
    expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: false, error: { kind: "busy" } });
    finish();
    expect(await api().jobs.wait(first.jobId!)).toMatchObject({ ok: true });
    expect(await api().jobs.wait(second.jobId!)).toMatchObject({ ok: true });
    expect(session.getLayer(layerId)).toBeUndefined(); expect(adapter.retry).not.toHaveBeenCalled();
  });

  it("supports default Atlas/Raster and all three native vector sources without entering GPU or plate paths", async () => {
    for (const layerId of [1, 3, add(), session.addLayer({ name: "Line", type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1", groupId: 101, active: true, alpha: 1 }),
      session.addLayer({ name: "Polygon", type: ProjectLayerType.Polygon, sourceRef: "fixture:goal-polygons-v1", groupId: 101, active: true, alpha: 1 })]) {
      expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: true, data: { layerId, frameConfirmed: true } });
    }
    for (const layerId of [2, 4]) expect(await api().execute("layer.retry", { layerId })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    const id = add(); session.setLayerSourceRef(id, "service:unimplemented");
    expect(await api().execute("layer.retry", { layerId: id })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(adapter.retry).toHaveBeenCalledTimes(5);
    expect(await api().catalog.describe("layer.retry")).toMatchObject({ execution: "job", cancellationSupported: true, completion: "frame-committed" });
  });

  it("rejects malformed or unavailable retry without changing the project", async () => {
    const before = session.toSnapshot(new Date(0));
    for (const params of [{}, { layerId: 0 }, { layerId: 1, extra: true }, { layerId: 9999 }]) {
      expect(await api().execute("layer.retry", params)).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    adapter.retry = undefined;
    expect(await api().execute("layer.retry", { layerId: 1 })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(session.toSnapshot(new Date(0))).toEqual(before); expect(adapter.remove).not.toHaveBeenCalled();
  });
});
