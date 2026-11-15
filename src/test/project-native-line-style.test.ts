import { describe, expect, it } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { ProjectSession, LOCAL_PROJECT_DRAFT_KEY, type ProjectLayerSnapshot } from "../project/project-session";
import { LayerController } from "../layers/layer-controller";
import { installAgentActions } from "../agent-actions/registry";
import { registerLayerStyleAction } from "../layers/style-action";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function add(session: ProjectSession, lineStyle?: unknown): number {
  return session.addLayer({ name: "Ordinary line", type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1", groupId: 101, active: true, alpha: 1, lineStyle } as Omit<ProjectLayerSnapshot, "id">);
}
const defaultStyle = { lineColor: "#38bdf8", lineWidth: 2 };

describe("ordinary line style storage", () => {
  it("defaults only new line layers without changing the existing point expression", () => {
    const session = new ProjectSession(); const gpu = session.getLayer(2); const id = add(session);
    expect(session.getLayer(id)?.lineStyle).toEqual(defaultStyle);
    expect(session.getLayer(2)).toEqual(gpu);
  });

  it("round-trips independent same-source styles and detaches caller references", () => {
    const session = new ProjectSession(); const style = { lineColor: "#ff5500", lineWidth: 3.5 };
    const first = add(session, style), second = add(session);
    style.lineColor = "#000000";
    const snapshot = session.getLayer(first)!; snapshot.lineStyle!.lineWidth = 9;
    const storage = memory(); session.save(storage);
    for (const restored of [session, ProjectSession.restore(storage)!, ProjectSession.fromDocument(session.toDocument())]) {
      expect(restored.getLayer(first)?.lineStyle).toEqual({ lineColor: "#ff5500", lineWidth: 3.5 });
      expect(restored.getLayer(second)?.lineStyle).toEqual(defaultStyle);
    }
  });

  it("defaults missing local and cloud extensions, while preserving the line source", () => {
    const session = new ProjectSession(); const id = add(session); const storage = memory(); session.save(storage);
    const draft = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    for (const layer of draft.layers) delete layer.lineStyle;
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
    const document = session.toDocument(); document.LegacyExtensions.delete(`lineStyle:${id}`);
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(document)]) {
      expect(restored.getLayer(id)).toMatchObject({ sourceRef: "fixture:goal-lines-v1", lineStyle: defaultStyle });
    }
  });

  it.each([null, false, 0, "", { lineColor: "invalid", lineWidth: 99 }, { ...defaultStyle, futureMode: "dashed" }])(
    "preserves explicit invalid/future JSON %j instead of silently replacing it", raw => {
      const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
      document.LegacyExtensions.set(`lineStyle:${id}`, JSON.stringify(raw));
      const restored = ProjectSession.fromDocument(document);
      expect(restored.getLayer(id)?.lineStyle).toEqual(raw);
      expect(restored.toDocument().LegacyExtensions.get(`lineStyle:${id}`)).toBe(JSON.stringify(raw));
      const storage = memory(); restored.save(storage);
      expect(ProjectSession.restore(storage)!.getLayer(id)?.lineStyle).toEqual(raw);
    },
  );

  it("rejects malformed cloud JSON without modifying the supplied document", () => {
    const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
    document.LegacyExtensions.set(`lineStyle:${id}`, "{broken-json");
    expect(() => ProjectSession.fromDocument(document)).toThrow(/line style.*JSON/i);
    expect(document.LegacyExtensions.get(`lineStyle:${id}`)).toBe("{broken-json");
  });

  it("applies line style through the existing controller and refuses a point target", () => {
    const session = new ProjectSession(); const id = add(session); const applied: unknown[] = []; const saved: unknown[] = [];
    const controller = new LayerController(session, {
      applyRuntime(target) { applied.push(session.getLayer(target)?.lineStyle); },
      persist() { saved.push(session.toDocument().LegacyExtensions.get(`lineStyle:${id}`)); },
      applyImageryOrder() {}, publishState() {}, syncNativeControls() {},
    });
    const style = { lineColor: "#2255aa", lineWidth: 4.5 };
    controller.setLineStyle(id, style);
    style.lineWidth = 1;
    expect(applied).toEqual([{ lineColor: "#2255aa", lineWidth: 4.5 }]);
    expect(saved).toEqual([JSON.stringify({ lineColor: "#2255aa", lineWidth: 4.5 })]);
    expect(() => controller.setLineStyle(2, defaultStyle)).toThrow(/line layer/i);
    expect(applied).toHaveLength(1); expect(saved).toHaveLength(1);
  });

  it.each([ProjectLayerType.Point, ProjectLayerType.Line])("restores complete style after native apply fails for type %i and reports API failure", async type => {
    const session = new ProjectSession();
    const id = type === ProjectLayerType.Line ? add(session) : session.addLayer({ name: "Ordinary point", type, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
    const original = session.getLayer(id)!;
    const readStyle = () => type === ProjectLayerType.Line ? session.getLayer(id)!.lineStyle : session.getLayer(id)!.pointStyle;
    const oldStyle = readStyle();
    const attempted: unknown[] = [], published: unknown[] = [], persisted: unknown[] = [];
    const fault = new Error("Synthetic native style apply failed");
    const controller = new LayerController(session, {
      applyRuntime() { attempted.push(readStyle()); if (attempted.length === 1) throw fault; },
      publishState() { published.push(session.getLayer(id)); },
      persist() { persisted.push(session.getLayer(id)); },
      applyImageryOrder() {}, syncNativeControls() {},
    });
    const target = {} as Window; installAgentActions(target); registerLayerStyleAction(session, controller);
    const patch = type === ProjectLayerType.Line ? { lineColor: "#1255aa", lineWidth: 7 } : { singleColor: "#1255aa", pointSize: 7 };
    expect(await target.timeMachineAgent!.v2.execute("layer.setStyle", { layerId: id, style: patch })).toMatchObject({ ok: false, error: { message: "Synthetic native style apply failed" } });
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).toMatchObject(patch); expect(attempted[1]).toEqual(oldStyle);
    expect(session.getLayer(id)).toEqual(original);
    expect(published).toEqual([original]); expect(persisted).toEqual([]);
  });

  it.each([ProjectLayerType.Point, ProjectLayerType.Line])("preserves the original failure and a failed native rollback for type %i", type => {
    const session = new ProjectSession();
    // Include the default GPU expression: rollback must retain every field, not
    // replace its thematic configuration with ordinary point defaults.
    const id = type === ProjectLayerType.Line ? add(session) : 2;
    const original = session.getLayer(id)!;
    const applied = new Error("Synthetic apply failed"), recovered = new Error("Synthetic rollback failed");
    const published: unknown[] = [], persisted: unknown[] = []; let calls = 0;
    const controller = new LayerController(session, {
      applyRuntime() { throw ++calls === 1 ? applied : recovered; },
      publishState() { published.push(session.getLayer(id)); },
      persist() { persisted.push(session.getLayer(id)); },
      applyImageryOrder() {}, syncNativeControls() {},
    });
    let failure: unknown;
    try {
      if (type === ProjectLayerType.Line) controller.setLineStyle(id, { lineColor: "#1255aa", lineWidth: 7 });
      else controller.setPointStyle(id, { ...original.pointStyle!, singleColor: "#1255aa", pointSize: 7 });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([applied, recovered]);
    expect(session.getLayer(id)).toEqual(original);
    expect(published).toEqual([original]); expect(persisted).toEqual([]);
  });
});
