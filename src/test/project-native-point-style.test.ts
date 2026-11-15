import { describe, expect, it } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { DEFAULT_POINT_STYLE, type PointStyleExpression } from "@timemachine/point-runtime";
import { ProjectSession, LOCAL_PROJECT_DRAFT_KEY, RUNTIME_LAYER_IDS } from "../project/project-session";
import { defaultNativePointStyle, patchNativePointStyle, readNativePointStyle } from "../layers/native-point-style";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function add(session: ProjectSession, pointStyle?: PointStyleExpression): number {
  return session.addLayer({ name: "Ordinary point", type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1, pointStyle });
}

describe("ordinary point style storage", () => {
  it("defaults new ordinary points to white/6 while preserving the GPU expression", () => {
    const session = new ProjectSession(); const id = add(session);
    expect(session.getLayer(id)?.pointStyle).toEqual(defaultNativePointStyle());
    expect(session.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle).toEqual(DEFAULT_POINT_STYLE);
  });

  it("round-trips independent same-source styles through local and generated cloud documents", () => {
    const session = new ProjectSession(); const style = patchNativePointStyle(undefined, { singleColor: "#123abc", pointSize: 4.5 });
    const first = add(session, style); const second = add(session);
    style.singleColor = "#000000"; style.filter.plateId = 10;
    const stored = session.getLayer(first)!.pointStyle!; stored.filter.plateId = 20;
    const storage = memory(); session.save(storage);
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(session.toDocument())]) {
      expect(readNativePointStyle(restored.getLayer(first)!.pointStyle)).toEqual({ singleColor: "#123abc", pointSize: 4.5 });
      expect(restored.getLayer(second)!.pointStyle).toEqual(defaultNativePointStyle());
      expect(restored.getLayer(2)!.pointStyle).toEqual(DEFAULT_POINT_STYLE);
    }
  });

  it("supplies native defaults only when old local/cloud ordinary styles are absent", () => {
    const session = new ProjectSession(); const id = add(session); const storage = memory(); session.save(storage);
    const draft = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    for (const layer of draft.layers) delete layer.pointStyle;
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
    const document = session.toDocument();
    document.LegacyExtensions.delete(`pointStyle:${id}`); document.LegacyExtensions.delete("pointStyle:2");
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(document)]) {
      expect(restored.getLayer(id)!.pointStyle).toEqual(defaultNativePointStyle());
      expect(restored.getLayer(2)!.pointStyle).toEqual(DEFAULT_POINT_STYLE);
    }
  });

  it.each([{ shape: "square" }, { colorMode: "plate" }, { pointSize: 99 }, { singleColor: "invalid-color" }])("preserves explicit unsupported/invalid values for runtime rejection: %j", change => {
    const session = new ProjectSession(); const style = { ...defaultNativePointStyle(), ...change } as PointStyleExpression;
    const id = add(session, style); const storage = memory(); session.save(storage);
    for (const restored of [session, ProjectSession.restore(storage)!, ProjectSession.fromDocument(session.toDocument())]) {
      expect(restored.getLayer(id)!.pointStyle).toEqual(style);
      expect(() => readNativePointStyle(restored.getLayer(id)!.pointStyle)).toThrow();
    }
    session.setPointStyle(id, { ...style, pointSize: 100 });
    expect(session.getLayer(id)!.pointStyle!.pointSize).toBe(100);
    session.setPointStyle(2, { ...DEFAULT_POINT_STYLE, pointSize: 100 });
    expect(session.getLayer(2)!.pointStyle!.pointSize).toBe(8);
  });

  it("rejects malformed ordinary cloud style JSON without rewriting the supplied document", () => {
    const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
    document.LegacyExtensions.set(`pointStyle:${id}`, "{invalid-style-json");
    expect(() => ProjectSession.fromDocument(document)).toThrow(/style.*JSON/i);
    expect(document.LegacyExtensions.get(`pointStyle:${id}`)).toBe("{invalid-style-json");
  });

  it.each([null, false, 0, ""])("preserves explicit falsy JSON %j across cloud and local writes for runtime rejection", raw => {
    const session = new ProjectSession(); const id = add(session); const document = session.toDocument();
    document.LegacyExtensions.set(`pointStyle:${id}`, JSON.stringify(raw));
    const restored = ProjectSession.fromDocument(document);
    expect(restored.getLayer(id)!.pointStyle).toBe(raw);
    expect(() => readNativePointStyle(restored.getLayer(id)!.pointStyle)).toThrow();
    const exported = restored.toDocument();
    expect(exported.LegacyExtensions.get(`pointStyle:${id}`)).toBe(JSON.stringify(raw));
    expect(ProjectSession.fromDocument(exported).getLayer(id)!.pointStyle).toBe(raw);
    const storage = memory(); restored.save(storage);
    expect(ProjectSession.restore(storage)!.getLayer(id)!.pointStyle).toBe(raw);
  });
});
