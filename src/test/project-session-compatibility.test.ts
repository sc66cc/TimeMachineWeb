import { describe, expect, it } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { LOCAL_PROJECT_DRAFT_KEY, ProjectSession } from "../project/project-session";

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map ? Object.fromEntries(item) : item));
}

function cloudDocument() {
  return {
    SchemaVersion: 2, Name: "Original", Version: "unity-preserved", CurrentTimeMa: 100, LastID: 102,
    Author: "Fixture author", Description: "Keep the full original contract",
    FutureProjectField: { nested: [0, false, null, "kept"] },
    ViewSetting: { FutureSetting: 17 },
    LayerPathTree: {
      LastID: 102, FutureTreeField: "root metadata",
      ChildList: [{
        ID: 101, Name: "Root", FutureNodeField: { retained: true },
        Value: { Active: true, Alpha: 1, FutureValue: 12 },
        ChildList: [{ ID: 102, Name: "Child", Value: { Active: true, Alpha: 0.5 }, ChildList: [] }],
      }],
    },
    LayerList: [{
      ID: 7, Name: "Line", Active: true, Alpha: 0.8, PathTreeNodeID: 102,
      Type: { Value: ProjectLayerType.Line, FutureEnumField: "kept" },
      FeatureLine: { Coordinates: [[1, 2], [3, 4]] },
      FutureLayerField: { value: "original" },
    }],
    LegacyExtensions: { "sourceRef:7": "fixture:goal-lines-v1", workbenchState: '{"outsideScope":true}', futureExtension: " keep exact whitespace " },
  };
}

function storageWith(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (_key: string) => value,
    setItem: (key: string, next: string) => {
      expect(key).toBe(LOCAL_PROJECT_DRAFT_KEY);
      value = next;
    },
  };
}

describe("project compatibility preservation", () => {
  it("keeps untouched cloud DTO fields, tree values and extension strings through a local save and refresh", () => {
    const input = cloudDocument();
    const session = ProjectSession.fromDocument(input as never);
    expect(plain(session.toDocument())).toEqual(input);
    const storage = storageWith();
    session.setName("Edited"); session.setTime(110);
    session.save(storage, new Date("2026-11-15T01:00:00Z"));
    const restored = ProjectSession.restore(storage)!;
    expect(plain(restored.toDocument())).toEqual({ ...input, Name: "Edited", CurrentTimeMa: 110 });
    expect(restored.compatibilityReport.writable).toBe(true);
    expect(restored.compatibilityReport.issues.some(issue => issue.path.includes("FutureProjectField") && issue.preserved)).toBe(true);
    expect(restored.toDocument()).not.toHaveProperty("cloudDocument");
    expect(input.Name).toBe("Original");
  });

  it("retains unknown local root, group, layer and camera fields while applying an edit", () => {
    const draft = plain(new ProjectSession().toSnapshot(new Date(0))) as unknown as Record<string, any>;
    draft.futureRoot = { data: [1, false] };
    draft.groups[0].futureGroup = { data: "group" };
    draft.layers[0].futureLayer = ["layer", null];
    draft.camera = { position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1], futureCamera: "camera" };
    const storage = storageWith(JSON.stringify(draft));
    const session = ProjectSession.restore(storage)!;
    session.setTime(200); session.save(storage, new Date(0));
    const output = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    expect(output).toEqual({ ...draft, currentTimeMa: 200 });
  });

  it("merges group moves and known edits without dropping untouched original node and layer payloads", () => {
    const session = ProjectSession.fromDocument(cloudDocument() as never);
    session.moveGroup(102); session.setGroupVisibility(101, false); session.setLayerOpacity(7, 0.4);
    const output = plain(session.toDocument()) as unknown as ReturnType<typeof cloudDocument>;
    expect(output.LayerPathTree.ChildList[0]).toMatchObject({ FutureNodeField: { retained: true }, Value: { Active: false, FutureValue: 12 }, ChildList: [] });
    expect(output.LayerPathTree.ChildList[1]).toMatchObject({ ID: 102 });
    expect(output.LayerList[0]).toMatchObject({ Alpha: 0.4, FeatureLine: { Coordinates: [[1, 2], [3, 4]] }, FutureLayerField: { value: "original" } });
  });

  it("does not expose mutable aliases to imported payloads, cameras or compatibility reports", () => {
    const input = cloudDocument();
    const session = ProjectSession.fromDocument(input as never);
    input.FutureProjectField.nested.push("external mutation");
    session.setCamera({ position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1] });
    (session.cameraSnapshot!.position as unknown as number[])[0] = 999;
    (session.toSnapshot().camera!.position as unknown as number[])[1] = 999;
    session.compatibilityReport.issues.length = 0;
    expect(session.cameraSnapshot!.position).toEqual([1, 2, 3]);
    expect((plain(session.toDocument()) as any).FutureProjectField.nested).toEqual([0, false, null, "kept"]);
    expect(session.compatibilityReport.issues.length).toBeGreaterThan(0);
  });
});

describe("project compatibility write protection", () => {
  it("reports a future local schema without executing layers or overwriting its original bytes", () => {
    const original = '{ "schemaVersion": 9, "name": "Future", "opaque": {"data": 7} }';
    const storage = storageWith(original);
    const result = ProjectSession.restoreWithReport(storage);
    expect(result.status).toBe("readonly");
    expect(result.session!.layerList).toEqual([]);
    expect(result.session!.isReadOnly).toBe(true);
    expect(result.session!.localSaveState.status).toBe("readonly");
    expect(result.session!.exportOriginal()).toBe(original);
    expect(() => result.session!.save(storage)).toThrow(/read.only/i);
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(original);
    expect(() => ProjectSession.restore(storage)).toThrow(/schema version 2/);
  });

  it("retains unknown cloud layers as non-executable readonly records with exportable originals", () => {
    const input = cloudDocument(); input.LayerList[0]!.Type.Value = 99 as ProjectLayerType;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.getLayer(7)!.type).toBe(99);
    expect(session.getEffectiveLayerVisibility(7)).toBe(false);
    expect(session.compatibilityReport.writable).toBe(false);
    expect(JSON.parse(session.exportOriginal()!)).toEqual(input);
    expect(() => session.setTime(120)).toThrow(/read.only/i);
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it("does not guess that a cloud layer with a missing enum value is a point", () => {
    const input = cloudDocument(); input.LayerList[0]!.Type = {} as never;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(session.layerList.every(layer => !session.getEffectiveLayerVisibility(layer.id))).toBe(true);
    expect(JSON.parse(session.exportOriginal()!)).toEqual(input);
  });

  it("reports normalization that would overwrite a cloud value and protects the source", () => {
    const input = cloudDocument(); input.LayerList[0]!.Alpha = 2;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(session.compatibilityReport.issues.some(issue => issue.code === "normalization-required")).toBe(true);
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it.each(["{bad", '{"schemaVersion":2,"name":"Broken","currentTimeMa":0,"layers":null}', '{"schemaVersion":2,"name":"Broken","currentTimeMa":1e400,"layers":[]}'])
    ("does not replace corrupt input %s", original => {
      const storage = storageWith(original);
      const result = ProjectSession.restoreWithReport(storage);
      expect(result.status).toBe("invalid"); expect(result.session).toBeUndefined();
      expect(result.original).toBe(original); expect(result.compatibility.writable).toBe(false);
      expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(original);
    });

  it("distinguishes syntax, duplicate identity and missing-parent failures without quoting raw input", () => {
    const syntax = ProjectSession.restoreWithReport(storageWith('{"privateValue":"fixture-sensitive-value" broken}'));
    expect(syntax.compatibility.issues[0]!.code).toBe("invalid-json");
    expect(JSON.stringify(syntax.compatibility)).not.toContain("fixture-sensitive-value");
    const draft = plain(new ProjectSession().toSnapshot());
    draft.layers.push(draft.layers[0]!);
    const duplicate = ProjectSession.restoreWithReport(storageWith(JSON.stringify(draft)));
    expect(duplicate.compatibility.issues[0]!.message).toMatch(/unique/);
    draft.layers.pop(); draft.groups[0]!.parentId = 999;
    const parent = ProjectSession.restoreWithReport(storageWith(JSON.stringify(draft)));
    expect(parent.compatibility.issues[0]!.message).toMatch(/parent must exist/);
  });

  it("keeps raw sensitive input exportable but refuses to persist it and omits values from diagnostics", () => {
    const input = cloudDocument(); (input.LegacyExtensions as any).accessToken = "fixture-sensitive-value";
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(JSON.stringify(session.compatibilityReport)).not.toContain("fixture-sensitive-value");
    expect(session.exportOriginal()).toContain("fixture-sensitive-value");
    expect(() => session.save(storageWith())).toThrow(/read.only/i);
  });

  it("protects cloud export when unknown local fields have no DTO mapping", () => {
    const draft = { ...new ProjectSession().toSnapshot(), futureLocalWorkspace: { selectedTool: "unknown" } };
    const session = ProjectSession.restore(storageWith(JSON.stringify(draft)))!;
    expect(session.isReadOnly).toBe(false);
    expect(session.compatibilityReport.cloudWritable).toBe(false);
    expect(() => session.toDocument()).toThrow(/cloud.*compatib/i);
    const storage = storageWith(); session.setTime(120); session.save(storage);
    expect(JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!).futureLocalWorkspace).toEqual({ selectedTool: "unknown" });
  });

  it("rejects temporary URLs introduced by an edit for both persistence targets", () => {
    const session = new ProjectSession();
    session.setLayerSourceRef(1, "https://fixture.example.test/image?X-Amz-Signature=fixture-signature");
    expect(() => session.toDocument()).toThrow(/persist/);
    expect(() => session.save(storageWith())).toThrow(/persist/);
    expect(session.localSaveState.status).toBe("error");
    expect(JSON.stringify(session.localSaveState)).not.toContain("fixture-signature");
  });

  it("does not turn a nonfinite style value into a JSON null in a cloud extension", () => {
    const session = ProjectSession.fromDocument(cloudDocument() as never);
    session.setLineStyle(7, { schemaVersion: 1, width: Infinity });
    expect(() => session.toDocument()).toThrow(/finite/);
  });

  it("opens future cloud schemas without constructing an executable default project", () => {
    const input = { ...cloudDocument(), SchemaVersion: 7 };
    const session = ProjectSession.fromDocument(input as never);
    expect(session.layerList).toEqual([]); expect(session.groupList).toEqual([]);
    expect(session.compatibilityReport).toMatchObject({ writable: false, cloudWritable: false, schemaVersion: 7 });
    expect(JSON.parse(session.exportOriginal()!)).toEqual(input);
  });

  it("preserves an explicit null group value by refusing to normalize and overwrite it", () => {
    const input = cloudDocument(); input.LayerPathTree.ChildList[0]!.Value = null as never;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it.each(["Alpha", "Active"] as const)("protects an explicit null group %s instead of silently defaulting it", field => {
    const input = cloudDocument(); input.LayerPathTree.ChildList[0]!.Value[field] = null as never;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(session.compatibilityReport.issues.some(issue => issue.code === "normalization-required" && issue.path.endsWith(field))).toBe(true);
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it.each(["LayerPathTree", "LegacyExtensions"] as const)("protects a null cloud %s value instead of replacing it", field => {
    const input = cloudDocument(); input[field] = null as never;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(JSON.parse(session.exportOriginal()!)[field]).toBeNull();
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it("protects a null tree ChildList instead of replacing it with default groups", () => {
    const input = cloudDocument(); input.LayerPathTree.ChildList = null as never;
    const session = ProjectSession.fromDocument(input as never);
    expect(session.isReadOnly).toBe(true);
    expect(() => session.toDocument()).toThrow(/read.only/i);
  });

  it("reports legacy defaults while keeping old flat local v2 drafts editable", () => {
    const draft = plain(new ProjectSession().toSnapshot()) as any;
    delete draft.groups; delete draft.lastId;
    for (const layer of draft.layers) delete layer.groupId;
    const session = ProjectSession.restore(storageWith(JSON.stringify(draft)))!;
    expect(session.isReadOnly).toBe(false);
    expect(session.compatibilityReport.issues.some(issue => issue.code === "legacy-default")).toBe(true);
    expect(session.getLayer(4)!.groupId).toBe(102);
  });

  it.each([
    (session: ProjectSession) => session.addLayer({ name: "new", type: ProjectLayerType.Point, active: true, alpha: 1, sourceRef: "fixture:goal-points-v1", groupId: 101 }),
    (session: ProjectSession) => session.removeLayer(7),
    (session: ProjectSession) => session.addGroup({ name: "new", active: true, alpha: 1, collapsed: false }),
    (session: ProjectSession) => session.moveGroup(102),
    (session: ProjectSession) => session.removeGroup(101),
    (session: ProjectSession) => session.setCamera({ position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1] }),
    (session: ProjectSession) => session.setLayerVisibility(7, false),
    (session: ProjectSession) => session.setLayerSourceRef(7, "changed"),
    (session: ProjectSession) => session.setLayerOpacity(7, 0.3),
    (session: ProjectSession) => session.setLayerGroup(7, 101),
    (session: ProjectSession) => session.setGroupVisibility(101, false),
    (session: ProjectSession) => session.setGroupOpacity(101, 0.3),
    (session: ProjectSession) => session.setGroupCollapsed(101, true),
    (session: ProjectSession) => session.setPointStyle(7, {}),
    (session: ProjectSession) => session.setLineStyle(7, {}),
    (session: ProjectSession) => session.setPolygonStyle(7, {}),
    (session: ProjectSession) => session.setRasterId(7, "new"),
    (session: ProjectSession) => session.reorderLayers([7]),
    (session: ProjectSession) => session.setName("changed"),
  ])("rejects write entry point %# on a readonly document before changing its view", edit => {
    const input = cloudDocument(); input.LayerList[0]!.Type.Value = 99 as ProjectLayerType;
    const session = ProjectSession.fromDocument(input as never);
    const before = session.toSnapshot(new Date(0));
    expect(() => edit(session)).toThrow(/read.only/i);
    expect(session.toSnapshot(new Date(0))).toEqual(before);
  });
});

describe("local save state", () => {
  it("tracks actual edits and acknowledges a save only after storage succeeds", () => {
    const session = new ProjectSession();
    const storage = storageWith();
    session.save(storage, new Date(0));
    const saved = session.localSaveState;
    session.setTime(0); session.setName(session.projectName); session.setLayerVisibility(1, true);
    expect(session.localSaveState).toEqual(saved);
    session.setTime(110);
    expect(session.localSaveState.status).toBe("dirty");
    expect(session.localSaveState.revision).toBeGreaterThan(saved.revision);
    let observed = "";
    session.save({ ...storage, setItem: (key, value) => { observed = session.localSaveState.status; storage.setItem(key, value); } }, new Date(1000));
    expect(observed).toBe("saving");
    expect(session.localSaveState).toMatchObject({ status: "saved", savedAt: new Date(1000).toISOString(), savedRevision: session.localSaveState.revision });
    expect(ProjectSession.restore(storage)!.localSaveState.status).toBe("saved");
  });

  it("keeps the existing draft and current edits on quota failure then allows an explicit retry", () => {
    const storage = storageWith(); const session = new ProjectSession();
    session.save(storage, new Date(0)); const oldDraft = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    session.setTime(110);
    expect(() => session.save({ ...storage, setItem: () => { throw new DOMException("Quota denied", "QuotaExceededError"); } })).toThrow("Quota denied");
    expect(session.localSaveState).toMatchObject({ status: "error", savedAt: new Date(0).toISOString() });
    expect(session.timeMa).toBe(110); expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(oldDraft);
    session.save(storage); expect(session.localSaveState.status).toBe("saved");
    expect(ProjectSession.restore(storage)!.timeMa).toBe(110);
  });

  it("distinguishes missing drafts from inaccessible storage", () => {
    expect(ProjectSession.restoreWithReport(storageWith()).status).toBe("empty");
    expect(ProjectSession.restoreWithReport({ getItem: () => { throw new Error("denied"); }, setItem: () => {} }).status).toBe("unavailable");
  });
});
