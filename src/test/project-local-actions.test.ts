import { beforeEach, describe, expect, it, vi } from "vitest";
import { installAgentActions } from "../agent-actions/registry";
import { registerProjectLocalActions } from "../project/project-actions";
import { LOCAL_PROJECT_DRAFT_KEY, ProjectSession } from "../project/project-session";

let target: Window;
let storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
const api = () => target.timeMachineAgent!.v2;
beforeEach(() => {
  const data = new Map<string, string>();
  storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  target = {} as Window; installAgentActions(target);
});

describe("local project action storage boundary", () => {
  it("captures current time and camera and saves without a cloud account", async () => {
    const session = new ProjectSession("Local"); const publish = vi.fn();
    registerProjectLocalActions(session, { storage, capture: () => { session.setTime(110); session.setCamera({ position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1] }); }, publish, downloadOriginal: vi.fn() });
    const result = await api().execute("project.saveLocal", {});
    expect(result).toMatchObject({ ok: true, data: { revision: 2, savedAt: expect.any(String) } });
    const restored = ProjectSession.restore(storage)!;
    expect(restored.timeMa).toBe(110); expect(restored.cameraSnapshot?.position).toEqual([1, 2, 3]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await api().catalog.describe("project.saveLocal")).toMatchObject({ effect: "project-local", completion: "state-committed" });
  });

  it("propagates storage rejection and publishes error while preserving the old draft", async () => {
    const session = new ProjectSession(); session.save(storage);
    const previous = storage.getItem(LOCAL_PROJECT_DRAFT_KEY); const statuses: string[] = [];
    registerProjectLocalActions(session, { storage, capture: () => session.setTime(111), publish: () => statuses.push(session.localSaveState.status), downloadOriginal: vi.fn() });
    const setter = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Storage full", "QuotaExceededError"); });
    try {
      expect(await api().execute("project.saveLocal", {})).toMatchObject({ ok: false, error: { kind: "internal" } });
      expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(previous);
      expect(session.timeMa).toBe(111); expect(statuses).toEqual(["error"]);
    } finally { setter.mockRestore(); }
    expect(await api().execute("project.saveLocal", {})).toMatchObject({ ok: true });
    expect(ProjectSession.restore(storage)?.timeMa).toBe(111);
  });

  it("keeps invalid input protected and exports its exact bytes only through the explicit download action", async () => {
    const original = '{"broken":'; storage.setItem(LOCAL_PROJECT_DRAFT_KEY, original);
    const restored = ProjectSession.restoreWithReport(storage); const downloadOriginal = vi.fn(); const capture = vi.fn();
    registerProjectLocalActions(restored.session, { storage, capture, publish: vi.fn(), original: restored.original, downloadOriginal });
    expect(await api().execute("project.saveLocal", {})).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(capture).not.toHaveBeenCalled(); expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(original);
    expect(await api().execute("project.exportOriginal", {})).toMatchObject({ ok: true, data: { downloadStarted: true, bytes: new TextEncoder().encode(original).byteLength } });
    expect(downloadOriginal).toHaveBeenCalledWith(original);
  });

  it("rejects extra parameters and export when no original input exists", async () => {
    const downloadOriginal = vi.fn(); registerProjectLocalActions(new ProjectSession(), { storage, capture: vi.fn(), publish: vi.fn(), downloadOriginal });
    expect(await api().execute("project.saveLocal", { cloud: true })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await api().execute("project.exportOriginal", {})).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull(); expect(downloadOriginal).not.toHaveBeenCalled();
  });
});
