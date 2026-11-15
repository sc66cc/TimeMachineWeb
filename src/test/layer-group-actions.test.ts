import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentActions, installAgentActions, AgentActionValidationError } from "../agent-actions/registry";
import { ProjectSession } from "../project/project-session";
import { LayerController } from "../layers/layer-controller";
import { registerLayerGroupActions } from "../layers/group-actions";

let session: ProjectSession;
let controller: LayerController;
let target: Window;
function createRuntime() {
  return { applyImageryOrder: vi.fn(() => undefined), applyRuntime: vi.fn((_id: number) => undefined), persist: vi.fn(() => undefined), publishState: vi.fn(() => undefined), syncNativeControls: vi.fn(() => undefined) };
}
let runtime: ReturnType<typeof createRuntime>;
beforeEach(() => {
  session = new ProjectSession("Group actions");
  runtime = createRuntime();
  controller = new LayerController(session, runtime);
  target = {} as Window;
  installAgentActions(target);
  registerLayerGroupActions(session, controller);
});
const api = () => target.timeMachineAgent!.v2;
const group = (name = "New group") => ({ name, active: true, alpha: 0.5, collapsed: false });

describe("group application commands", () => {
  it("creates, moves and removes the actual session group through v2", async () => {
    const created = await api().execute("layer.group.add", { group: group() });
    expect(created).toMatchObject({ ok: true, status: "completed", data: { groupId: 103, group: { ...group(), id: 103 } } });
    expect(session.getGroup(103)).toEqual({ ...group(), id: 103 });
    expect(await api().execute("layer.group.move", { groupId: 103, parentId: 101 })).toMatchObject({ ok: true, data: { groupId: 103, group: { parentId: 101 } } });
    expect(await api().execute("layer.group.move", { groupId: 103 })).toMatchObject({ ok: true });
    expect(session.getGroup(103)).not.toHaveProperty("parentId");
    expect(await api().execute("layer.group.remove", { groupId: 103 })).toMatchObject({ ok: true, data: { groupId: 103, removed: true } });
    expect(session.getGroup(103)).toBeUndefined();
    expect(runtime.persist).toHaveBeenCalledTimes(4);
  });

  it("rejects cycles, invalid IDs and nonempty deletion without mutation or persistence", async () => {
    const parent = controller.addGroup(group("Parent"));
    const child = controller.addGroup({ ...group("Child"), parentId: parent });
    const before = session.groupList;
    runtime.persist.mockClear(); runtime.publishState.mockClear(); runtime.applyRuntime.mockClear();
    for (const [id, params] of [
      ["layer.group.move", { groupId: parent, parentId: child }],
      ["layer.group.move", { groupId: child, parentId: 9999 }],
      ["layer.group.remove", { groupId: parent }],
      ["layer.group.remove", { groupId: 101 }],
      ["layer.group.remove", { groupId: 9999 }],
    ] as const) expect(await api().execute(id, params)).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(session.groupList).toEqual(before);
    expect(runtime.persist).not.toHaveBeenCalled();
    expect(runtime.applyRuntime).not.toHaveBeenCalled();
    expect(runtime.publishState).not.toHaveBeenCalled();
  });

  it("validates nested v2 input and preserves v1 validation", async () => {
    expect(await api().execute("layer.group.add", { group: { ...group(), alpha: 2 } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await api().execute("layer.group.add", { group: { ...group(), secret: "unexpected" } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await target.timeMachineAgent!.execute("layer.group.add", { group: { ...group(), parentId: 9999 } })).toMatchObject({ ok: false, error: { code: 400 } });
    expect(session.groupList).toHaveLength(2);
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  it("runs the scene guard before moving or persisting", async () => {
    const id = controller.addGroup(group());
    runtime.persist.mockClear();
    const guard = vi.fn(() => { throw new AgentActionValidationError("Synthetic scene boundary"); });
    registerLayerGroupActions(session, controller, guard);
    expect(await api().execute("layer.group.move", { groupId: id, parentId: 101 })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(guard).toHaveBeenCalledWith(id, 101);
    expect(session.getGroup(id)).not.toHaveProperty("parentId");
    expect(runtime.persist).not.toHaveBeenCalled();
  });

  it("does not label a runtime adapter failure as invalid user input", async () => {
    runtime.publishState.mockImplementationOnce(() => { throw new Error("Synthetic runtime publication failure"); });
    expect(await api().execute("layer.group.add", { group: group() })).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(session.getGroup(103)).toBeDefined();
  });
});
