import { describe, expect, it } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { ProjectSession, LOCAL_PROJECT_DRAFT_KEY, type ProjectLayerSnapshot } from "../project/project-session";
import { LayerController } from "../layers/layer-controller";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function add(session: ProjectSession, polygonStyle?: unknown): number {
  return session.addLayer({ name: "Ordinary polygon", type: ProjectLayerType.Polygon, sourceRef: "fixture:goal-polygons-v1", groupId: 101, active: true, alpha: 1, polygonStyle } as Omit<ProjectLayerSnapshot, "id">);
}
const defaultStyle = { fillColor: "#38bdf8", outlineColor: "#ffffff", outlineWidth: 2 };

describe("ordinary polygon style storage", () => {
  it("defaults only new polygon layers without changing the existing point expression", () => {
    const session = new ProjectSession(); const gpu = session.getLayer(2); const id = add(session);
    expect(session.getLayer(id)?.polygonStyle).toEqual(defaultStyle);
    expect(session.getLayer(2)).toEqual(gpu);
  });

  it("round-trips independent same-source styles and detaches caller references", () => {
    const session = new ProjectSession(); const style = { fillColor: "#ff5500", outlineColor: "#123abc", outlineWidth: 3.5 };
    const first = add(session, style), second = add(session);
    style.fillColor = "#000000";
    const snapshot = session.getLayer(first)!; snapshot.polygonStyle!.outlineWidth = 9;
    const storage = memory(); session.save(storage);
    for (const restored of [session, ProjectSession.restore(storage)!, ProjectSession.fromDocument(session.toDocument())]) {
      expect(restored.getLayer(first)?.polygonStyle).toEqual({ fillColor: "#ff5500", outlineColor: "#123abc", outlineWidth: 3.5 });
      expect(restored.getLayer(second)?.polygonStyle).toEqual(defaultStyle);
    }
  });

  it("defaults missing local and cloud extensions, while preserving the polygon source", () => {
    const session = new ProjectSession(); const id = add(session); const storage = memory(); session.save(storage);
    const draft = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    for (const layer of draft.layers) delete layer.polygonStyle;
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
    const document = session.toDocument(); document.LegacyExtensions.delete(`polygonStyle:${id}`);
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(document)]) {
      expect(restored.getLayer(id)).toMatchObject({ sourceRef: "fixture:goal-polygons-v1", polygonStyle: defaultStyle });
    }
  });

  it.each([null, false, 0, "", { fillColor: "invalid", outlineWidth: 99 }, { ...defaultStyle, futureMode: "dashed" }])(
    "preserves explicit invalid/future JSON %j instead of silently replacing it", raw => {
      const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
      document.LegacyExtensions.set(`polygonStyle:${id}`, JSON.stringify(raw));
      const restored = ProjectSession.fromDocument(document);
      expect(restored.getLayer(id)?.polygonStyle).toEqual(raw);
      expect(restored.toDocument().LegacyExtensions.get(`polygonStyle:${id}`)).toBe(JSON.stringify(raw));
      const storage = memory(); restored.save(storage);
      expect(ProjectSession.restore(storage)!.getLayer(id)?.polygonStyle).toEqual(raw);
    },
  );

  it("rejects malformed cloud JSON without modifying the supplied document", () => {
    const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
    document.LegacyExtensions.set(`polygonStyle:${id}`, "{broken-json");
    expect(() => ProjectSession.fromDocument(document)).toThrow(/polygon style.*JSON/i);
    expect(document.LegacyExtensions.get(`polygonStyle:${id}`)).toBe("{broken-json");
  });

  it("applies polygon style through the existing controller and refuses a point target", () => {
    const session = new ProjectSession(); const id = add(session); const applied: unknown[] = []; const saved: unknown[] = [];
    const controller = new LayerController(session, {
      applyRuntime(target) { applied.push(session.getLayer(target)?.polygonStyle); },
      persist() { saved.push(session.toDocument().LegacyExtensions.get(`polygonStyle:${id}`)); },
      applyImageryOrder() {}, publishState() {}, syncNativeControls() {},
    });
    const style = { fillColor: "#2255aa", outlineColor: "#abcdef", outlineWidth: 4.5 };
    controller.setPolygonStyle(id, style);
    style.outlineWidth = 1;
    expect(applied).toEqual([{ fillColor: "#2255aa", outlineColor: "#abcdef", outlineWidth: 4.5 }]);
    expect(saved).toEqual([JSON.stringify({ fillColor: "#2255aa", outlineColor: "#abcdef", outlineWidth: 4.5 })]);
    expect(() => controller.setPolygonStyle(2, defaultStyle)).toThrow(/polygon layer/i);
    expect(applied).toHaveLength(1); expect(saved).toHaveLength(1);
  });

  it("restores the entire polygon style after a native application failure", () => {
    const session = new ProjectSession(); const id = add(session); const previous = session.getLayer(id);
    const attempted: unknown[] = [], published: unknown[] = [], saved: unknown[] = [];
    const failure = new Error("Synthetic polygon apply failed");
    const controller = new LayerController(session, {
      applyRuntime() { attempted.push(session.getLayer(id)?.polygonStyle); if (attempted.length === 1) throw failure; },
      publishState() { published.push(session.getLayer(id)); }, persist() { saved.push(session.getLayer(id)); },
      applyImageryOrder() {}, syncNativeControls() {},
    });
    expect(() => controller.setPolygonStyle(id, { fillColor: "#123456", outlineColor: "#abcdef", outlineWidth: 5 })).toThrow(failure);
    expect(attempted).toEqual([{ fillColor: "#123456", outlineColor: "#abcdef", outlineWidth: 5 }, defaultStyle]);
    expect(session.getLayer(id)).toEqual(previous); expect(published).toEqual([previous]); expect(saved).toEqual([]);
  });

  it("returns both original and rollback errors without persisting an unconfirmed polygon style", () => {
    const session = new ProjectSession(); const id = add(session); const previous = session.getLayer(id);
    const failure = new Error("Synthetic polygon apply failed"), recovery = new Error("Synthetic polygon recovery failed");
    const published: unknown[] = [], saved: unknown[] = []; let calls = 0;
    const controller = new LayerController(session, {
      applyRuntime() { throw ++calls === 1 ? failure : recovery; },
      publishState() { published.push(session.getLayer(id)); }, persist() { saved.push(session.getLayer(id)); },
      applyImageryOrder() {}, syncNativeControls() {},
    });
    let caught: unknown;
    try { controller.setPolygonStyle(id, { fillColor: "#123456", outlineColor: "#abcdef", outlineWidth: 5 }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure, recovery]);
    expect(session.getLayer(id)).toEqual(previous); expect(published).toEqual([previous]); expect(saved).toEqual([]);
  });
});
