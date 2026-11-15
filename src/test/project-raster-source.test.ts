import { describe, expect, it } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import {
  LOCAL_PROJECT_DRAFT_KEY,
  ProjectSession,
  RUNTIME_LAYER_IDS,
  type ProjectLayerSnapshot,
} from "../project/project-session";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function addRaster(session: ProjectSession, rasterId?: unknown): number {
  return session.addLayer({
    name: "Independent raster", type: ProjectLayerType.Raster, sourceRef: "fixture:single-raster-manifest",
    groupId: 101, active: true, alpha: 0.8, rasterId,
  });
}
function plainCloud(session: ProjectSession): ReturnType<ProjectSession["toDocument"]> {
  const document = session.toDocument();
  return JSON.parse(JSON.stringify({ ...document, LegacyExtensions: Object.fromEntries(document.LegacyExtensions) }));
}
const stable = (session: ProjectSession) => session.toSnapshot(new Date(0));

describe("per-layer raster source selection storage", () => {
  it("keeps missing IDs backward compatible without inventing an Atlas or Raster default", () => {
    const session = new ProjectSession();
    const id = addRaster(session);
    expect(session.getRasterId(RUNTIME_LAYER_IDS.raster)).toBeUndefined();
    expect(session.getRasterId(id)).toBeUndefined();
    expect(session.layerList.slice(0, 4).map(layer => layer.id)).toEqual([1, 2, 3, 4]);
    const storage = memory(); session.save(storage);
    const document = session.toDocument();
    expect([...document.LegacyExtensions.keys()].filter(key => key.startsWith("rasterId:"))).toEqual([]);
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(document), ProjectSession.fromDocument(plainCloud(session))]) {
      expect(restored.getRasterId(3)).toBeUndefined();
      expect(restored.getRasterId(id)).toBeUndefined();
      expect(restored.getLayer(1)?.rasterId).toBeUndefined();
    }
  });

  it("round-trips independent selections from one source through local and cloud serialization", () => {
    const session = new ProjectSession();
    const first = addRaster(session); const second = addRaster(session);
    session.setRasterId(3, "temperature_000");
    session.setRasterId(first, "temperature_015");
    session.setRasterId(second, "seafloor_age_merdith_100");
    const storage = memory(); session.save(storage);
    const document = session.toDocument();
    expect(document.LegacyExtensions.get("rasterId:3")).toBe('"temperature_000"');
    expect(document.LegacyExtensions.get(`rasterId:${first}`)).toBe('"temperature_015"');
    for (const restored of [ProjectSession.restore(storage)!, ProjectSession.fromDocument(document), ProjectSession.fromDocument(plainCloud(session))]) {
      expect(restored.getRasterId(3)).toBe("temperature_000");
      expect(restored.getRasterId(first)).toBe("temperature_015");
      expect(restored.getRasterId(second)).toBe("seafloor_age_merdith_100");
      expect(restored.getLayer(first)?.sourceRef).toBe(restored.getLayer(second)?.sourceRef);
    }
  });

  it("keeps a cloned raster's selected ID independent of subsequent edits", () => {
    const session = new ProjectSession();
    const first = addRaster(session, "temperature_000");
    const { id: _id, ...copy } = session.getLayer(first)!;
    const second = session.addLayer(copy);
    session.setRasterId(second, "temperature_015");
    copy.rasterId = "caller-only";
    const returned = session.getLayer(first)!; returned.rasterId = "caller-only";
    const listed = session.layerList.find(layer => layer.id === first)!; listed.rasterId = "caller-only";
    const snapshot = stable(session); snapshot.layers.find(layer => layer.id === first)!.rasterId = "caller-only";
    expect(session.getRasterId(first)).toBe("temperature_000");
    expect(session.getRasterId(second)).toBe("temperature_015");
  });

  it("preserves future nonempty IDs exactly and leaves manifest membership to the runtime", () => {
    const session = new ProjectSession();
    session.setRasterId(3, " future:海底/age:999 ");
    expect(session.getRasterId(3)).toBe(" future:海底/age:999 ");
    expect(ProjectSession.fromDocument(session.toDocument()).getRasterId(3)).toBe(" future:海底/age:999 ");
  });

  it.each([undefined, null, false, 0, NaN, Infinity, "", " \t ", [], { id: "temperature_000" }])("rejects a new malformed selection without mutation: %j", input => {
    const session = new ProjectSession(); session.setRasterId(3, "temperature_000");
    const before = stable(session);
    expect(() => session.setRasterId(3, input as string)).toThrow(/raster.*ID/i);
    expect(stable(session)).toEqual(before);
    expect(session.getRasterId(3)).toBe("temperature_000");
  });

  it.each([1, 2, 4, 999])("rejects non-Raster/unknown getter and setter targets without mutation: %s", id => {
    const session = new ProjectSession(); const before = stable(session);
    expect(() => session.getRasterId(id)).toThrow(/raster layer/i);
    expect(() => session.setRasterId(id, "temperature_000")).toThrow(/raster layer/i);
    expect(stable(session)).toEqual(before);
  });

  it.each([null, false, 0, "", "  ", ["future"], { version: 2, source: { id: "future" } }])("preserves explicit malformed/future stored values for runtime rejection: %j", raw => {
    const session = new ProjectSession(); const id = addRaster(session);
    const document = session.toDocument();
    document.LegacyExtensions.set(`rasterId:${id}`, JSON.stringify(raw));
    const restored = ProjectSession.fromDocument(document);
    expect(restored.getLayer(id)?.rasterId).toEqual(raw);
    expect(() => restored.getRasterId(id)).toThrow(/raster.*ID/i);
    expect(restored.toDocument().LegacyExtensions.get(`rasterId:${id}`)).toBe(JSON.stringify(raw));
    const storage = memory(); restored.save(storage);
    const local = ProjectSession.restore(storage)!;
    expect(local.getLayer(id)?.rasterId).toEqual(raw);
    expect(() => local.getRasterId(id)).toThrow(/raster.*ID/i);
    expect(ProjectSession.fromDocument(plainCloud(local)).getLayer(id)?.rasterId).toEqual(raw);
  });

  it("preserves malformed local raw values and protects them from caller mutation", () => {
    const session = new ProjectSession(); const id = addRaster(session);
    const storage = memory(); session.save(storage);
    const draft = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    const raw = { version: 2, nested: { id: "future" } };
    draft.layers.find((layer: ProjectLayerSnapshot) => layer.id === id).rasterId = raw;
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
    const restored = ProjectSession.restore(storage)!;
    const value = restored.getLayer(id)!.rasterId as typeof raw;
    value.nested.id = "caller-only";
    const { id: _id, ...copy } = restored.getLayer(id)!;
    const second = restored.addLayer(copy);
    (copy.rasterId as typeof raw).nested.id = "caller-only";
    expect(restored.getLayer(id)?.rasterId).toEqual(raw);
    expect(restored.getLayer(second)?.rasterId).toEqual(raw);
    expect(() => restored.getRasterId(id)).toThrow();
    restored.setRasterId(second, "temperature_015");
    expect(restored.getLayer(id)?.rasterId).toEqual(raw);
    expect(restored.getRasterId(second)).toBe("temperature_015");
  });

  it("rejects corrupt cloud extension JSON without changing the input document", () => {
    const document = new ProjectSession().toDocument();
    document.LegacyExtensions.set("rasterId:3", "{invalid-raster-selection-json");
    expect(() => ProjectSession.fromDocument(document)).toThrow(/raster.*JSON/i);
    expect(document.LegacyExtensions.get("rasterId:3")).toBe("{invalid-raster-selection-json");
  });

  it.each([NaN, Infinity, -Infinity, { future: Infinity }, [NaN]])("rejects nonfinite raw additions before allocating or mutating: %j", raw => {
    const session = new ProjectSession(); const before = stable(session);
    expect(() => addRaster(session, raw)).toThrow(/raster.*finite/i);
    expect(stable(session)).toEqual(before);
  });

  it.each(["1e400", '{"future":1e400}'])("rejects overflowing cloud JSON numbers rather than rewriting them to null: %s", serialized => {
    const document = new ProjectSession().toDocument();
    document.LegacyExtensions.set("rasterId:3", serialized);
    expect(() => ProjectSession.fromDocument(document)).toThrow(/raster.*(?:finite|JSON)/i);
    expect(document.LegacyExtensions.get("rasterId:3")).toBe(serialized);
  });

  it("rejects overflowing local JSON numbers without overwriting the draft", () => {
    const session = new ProjectSession(); session.setRasterId(3, "overflow-placeholder");
    const storage = memory(); session.save(storage);
    const serialized = storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!.replace('"rasterId":"overflow-placeholder"', '"rasterId":1e400');
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, serialized);
    expect(() => ProjectSession.restore(storage)).toThrow(/raster.*finite/i);
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(serialized);
  });
});
