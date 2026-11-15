import { describe, expect, it } from "vitest";

import { ProjectLayerType } from "@timemachine/generated-api";
import {
  LOCAL_PROJECT_DRAFT_KEY,
  ProjectSession,
  RUNTIME_LAYER_GROUP_IDS,
  RUNTIME_LAYER_IDS,
} from "../project/project-session";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("ProjectSession", () => {
  it("maps runtime state into the generated ProjectDocumentV2 contract", () => {
    const session = new ProjectSession("Canonical UI project");
    session.setTime(251.9);
    session.setLayerVisibility(RUNTIME_LAYER_IDS.points, false);
    session.setLayerOpacity(RUNTIME_LAYER_IDS.points, 0.42);
    session.setPointStyle(RUNTIME_LAYER_IDS.points, {
      colorMode: "single",
      filter: {
        maximumOccurrence: 40,
        minimumOccurrence: 3,
        plateId: 101,
      },
      occurrenceSizeScale: 1,
      pointSize: 3.5,
      schemaVersion: 1,
      shape: "square",
      singleColor: "#336699",
      sizeMode: "fixed",
    });
    session.reorderLayers([
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_IDS.raster,
      RUNTIME_LAYER_IDS.atlas,
    ]);
    session.setCamera({
      direction: [0, 1, 0],
      position: [1, 2, 3],
      up: [0, 0, 1],
    });

    const document = session.toDocument();

    expect(document.SchemaVersion).toBe(2);
    expect(document.Name).toBe("Canonical UI project");
    expect(document.CurrentTimeMa).toBe(251.9);
    expect(document.LayerList).toHaveLength(4);
    expect(document.LayerList.map((layer) => layer.ID)).toEqual([
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_IDS.raster,
      RUNTIME_LAYER_IDS.atlas,
    ]);
    expect(document.LayerPathTree.ChildList).toEqual([
      expect.objectContaining({
        ID: RUNTIME_LAYER_GROUP_IDS.data,
        Name: "Data layers",
      }),
      expect.objectContaining({
        ID: RUNTIME_LAYER_GROUP_IDS.reconstruction,
        Name: "Reconstruction",
      }),
    ]);
    expect(
      document.LayerList.find(
        (layer) => layer.ID === RUNTIME_LAYER_IDS.points,
      ),
    ).toMatchObject({
      Active: false,
      Alpha: 0.42,
      Name: "PBDB point dataset",
    });
    expect(
      document.LayerList.find(
        (layer) => layer.ID === RUNTIME_LAYER_IDS.plateModel,
      )?.Type.Value,
    ).toBe(ProjectLayerType.PlateModel);
    expect(document.LegacyExtensions.get("camera")).toContain(
      '"position":[1,2,3]',
    );
    expect(
      JSON.parse(
        document.LegacyExtensions.get(
          `pointStyle:${RUNTIME_LAYER_IDS.points}`,
        ) ?? "{}",
      ),
    ).toMatchObject({
      colorMode: "single",
      pointSize: 3.5,
      shape: "square",
    });
  });

  it("persists and restores the local Phase 1A draft", () => {
    const storage = new MemoryStorage();
    const session = new ProjectSession("Restorable project");
    session.setTime(32);
    session.setLayerVisibility(RUNTIME_LAYER_IDS.atlas, false);
    session.setLayerOpacity(RUNTIME_LAYER_IDS.raster, 0.35);
    session.reorderLayers([
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_IDS.atlas,
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.raster,
    ]);
    session.save(storage, new Date("2026-07-27T08:00:00.000Z"));

    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).not.toBeNull();

    const restored = ProjectSession.restore(storage);
    expect(restored?.projectName).toBe("Restorable project");
    expect(restored?.timeMa).toBe(32);
    expect(restored?.getLayer(RUNTIME_LAYER_IDS.atlas)?.active).toBe(false);
    expect(restored?.getLayer(RUNTIME_LAYER_IDS.raster)?.alpha).toBe(0.35);
    expect(restored?.layerList.map((layer) => layer.id)).toEqual([
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_IDS.atlas,
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.raster,
    ]);
  });

  it("applies, reorders, and locally persists complete layer groups", () => {
    const storage = new MemoryStorage();
    const session = new ProjectSession("Grouped project");

    expect(
      session.getLayer(RUNTIME_LAYER_IDS.points)?.groupId,
    ).toBe(RUNTIME_LAYER_GROUP_IDS.data);
    expect(
      session.getLayer(RUNTIME_LAYER_IDS.plateModel)?.groupId,
    ).toBe(RUNTIME_LAYER_GROUP_IDS.reconstruction);

    session.setLayerGroup(
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
    );
    session.reorderLayers([
      RUNTIME_LAYER_IDS.atlas,
      RUNTIME_LAYER_IDS.raster,
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.points,
    ]);
    session.setGroupOpacity(RUNTIME_LAYER_GROUP_IDS.reconstruction, 0.5);
    session.setGroupVisibility(
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
      false,
    );
    session.setGroupCollapsed(
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
      true,
    );

    expect(
      session.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points),
    ).toBe(false);
    expect(
      session.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.points),
    ).toBe(0.5);
    expect(session.getLayer(RUNTIME_LAYER_IDS.points)?.active).toBe(true);

    session.save(storage);
    const restored = ProjectSession.restore(storage);

    expect(
      restored?.getLayer(RUNTIME_LAYER_IDS.points)?.groupId,
    ).toBe(RUNTIME_LAYER_GROUP_IDS.reconstruction);
    expect(
      restored?.getGroup(RUNTIME_LAYER_GROUP_IDS.reconstruction),
    ).toMatchObject({
      active: false,
      alpha: 0.5,
      collapsed: true,
    });
    expect(restored?.layerList.map((layer) => layer.id)).toEqual([
      RUNTIME_LAYER_IDS.atlas,
      RUNTIME_LAYER_IDS.raster,
      RUNTIME_LAYER_IDS.plateModel,
      RUNTIME_LAYER_IDS.points,
    ]);
  });

  it("hydrates a plain JSON cloud revision and preserves resource identities", () => {
    const source = new ProjectSession("Cross-browser project");
    source.setTime(145);
    source.setLayerSourceRef(
      RUNTIME_LAYER_IDS.plateModel,
      "resource:plate-model-version:91",
    );
    source.setLayerVisibility(RUNTIME_LAYER_IDS.points, false);
    source.setLayerGroup(
      RUNTIME_LAYER_IDS.points,
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
    );
    source.setGroupOpacity(RUNTIME_LAYER_GROUP_IDS.reconstruction, 0.64);
    source.setGroupCollapsed(
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
      true,
    );
    source.setPointStyle(RUNTIME_LAYER_IDS.points, {
      colorMode: "occurrence",
      filter: {
        maximumOccurrence: 100,
        minimumOccurrence: 4,
        plateId: null,
      },
      occurrenceSizeScale: 1.4,
      pointSize: 2.8,
      schemaVersion: 1,
      shape: "circle",
      singleColor: "#aabbcc",
      sizeMode: "occurrence",
    });
    const plainDocument = JSON.parse(
      JSON.stringify(
        RPCDocument(source.toDocument()),
      ),
    );

    const restored = ProjectSession.fromDocument(plainDocument);

    expect(restored.projectName).toBe("Cross-browser project");
    expect(restored.timeMa).toBe(145);
    expect(
      restored.getLayer(RUNTIME_LAYER_IDS.plateModel)?.sourceRef,
    ).toBe("resource:plate-model-version:91");
    expect(restored.getLayer(RUNTIME_LAYER_IDS.points)?.active).toBe(false);
    expect(restored.getLayer(RUNTIME_LAYER_IDS.points)?.groupId).toBe(
      RUNTIME_LAYER_GROUP_IDS.reconstruction,
    );
    expect(
      restored.getGroup(RUNTIME_LAYER_GROUP_IDS.reconstruction),
    ).toMatchObject({
      alpha: 0.64,
      collapsed: true,
    });
    expect(restored.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle).toMatchObject({
      colorMode: "occurrence",
      occurrenceSizeScale: 1.4,
      filter: { minimumOccurrence: 4 },
    });
  });

  it("rejects corrupted local drafts instead of silently accepting them", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LOCAL_PROJECT_DRAFT_KEY,
      JSON.stringify({ schemaVersion: 1, name: "old" }),
    );

    expect(() => ProjectSession.restore(storage)).toThrow(
      "does not match schema version 2",
    );
  });

  it("rejects incomplete or duplicate layer orders", () => {
    const session = new ProjectSession();

    expect(() =>
      session.reorderLayers([
        RUNTIME_LAYER_IDS.atlas,
        RUNTIME_LAYER_IDS.points,
      ]),
    ).toThrow("every layer exactly once");
    expect(() =>
      session.reorderLayers([
        RUNTIME_LAYER_IDS.atlas,
        RUNTIME_LAYER_IDS.points,
        RUNTIME_LAYER_IDS.raster,
        RUNTIME_LAYER_IDS.raster,
      ]),
    ).toThrow("every layer exactly once");
  });
});

function RPCDocument(
  document: ReturnType<ProjectSession["toDocument"]>,
): Record<string, unknown> {
  return {
    ...document,
    LegacyExtensions: Object.fromEntries(document.LegacyExtensions),
  };
}

function layerInput(session: ProjectSession, layerId: number) {
  const { id: _id, ...input } = session.getLayer(layerId)!;
  return input;
}
function groupInput(name = "New group", parentId?: number) {
  return { name, parentId, active: true, alpha: 1, collapsed: false };
}
function stableSnapshot(session: ProjectSession) { return session.toSnapshot(new Date(0)); }

describe("ProjectSession multi-instance business records", () => {
  it("allocates one monotonic identity space across layers and groups without changing defaults", () => {
    const session = new ProjectSession();
    const ids: number[] = [];
    for (const source of [2, 3, 4]) {
      ids.push(session.addLayer(layerInput(session, source)), session.addLayer(layerInput(session, source)));
    }
    const group = session.addGroup(groupInput()); ids.push(group);
    expect(ids).toEqual([103, 104, 105, 106, 107, 108, 109]);
    expect(session.layerList.slice(0, 4).map(layer => layer.id)).toEqual([1, 2, 3, 4]);
    expect(session.groupList.slice(0, 2).map(item => item.id)).toEqual([101, 102]);
    session.removeLayer(108); session.removeGroup(group);
    expect(session.addLayer(layerInput(session, 4))).toBe(110);
  });

  it("copies point styles and keeps same-source records independently mutable", () => {
    const session = new ProjectSession(); const input = layerInput(session, 2);
    input.pointStyle!.pointSize = 3;
    const a = session.addLayer(input); const b = session.addLayer(input);
    input.pointStyle!.filter.plateId = 777;
    session.setLayerOpacity(a, 0.4); session.setLayerVisibility(a, false);
    session.setPointStyle(a, { ...session.getLayer(a)!.pointStyle, pointSize: 9 });
    expect(session.getLayer(b)).toMatchObject({ active: true, alpha: 1, pointStyle: { pointSize: 3, filter: { plateId: null } } });
    expect(session.getLayer(2)?.active).toBe(true);
    expect(session.getLayer(a)?.sourceRef).toBe(session.getLayer(b)?.sourceRef);
    const copy = session.getLayer(b)!; copy.pointStyle!.filter.plateId = 888;
    expect(session.getLayer(b)?.pointStyle?.filter.plateId).toBeNull();
  });

  it("computes inherited visibility and opacity through three group levels", () => {
    const session = new ProjectSession();
    const a = session.addGroup({ ...groupInput("A"), alpha: 0.5 });
    const b = session.addGroup({ ...groupInput("B", a), alpha: 0.5 });
    const c = session.addGroup({ ...groupInput("C", b), alpha: 0.8 });
    session.setLayerGroup(2, c);
    expect(session.getEffectiveLayerOpacity(2)).toBeCloseTo(0.2, 12);
    session.setGroupVisibility(a, false); expect(session.getEffectiveLayerVisibility(2)).toBe(false);
    session.moveGroup(c); expect(session.getEffectiveLayerVisibility(2)).toBe(true);
    expect(session.getEffectiveLayerOpacity(2)).toBe(0.8);
    expect(session.getGroup(c)?.parentId).toBeUndefined();
  });

  it("reports group effective values including the group itself and every ancestor", () => {
    const session = new ProjectSession();
    const parent = session.addGroup({ ...groupInput("Parent"), alpha: 0.5 });
    const child = session.addGroup({ ...groupInput("Child", parent), alpha: 0.5 });
    expect(session.getEffectiveGroupOpacity(child)).toBe(0.25);
    expect(session.getEffectiveGroupVisibility(child)).toBe(true);
    session.setGroupVisibility(parent, false);
    expect(session.getEffectiveGroupVisibility(child)).toBe(false);
    session.moveGroup(child);
    expect(session.getEffectiveGroupVisibility(child)).toBe(true);
    expect(session.getEffectiveGroupOpacity(child)).toBe(0.5);
    expect(() => session.getEffectiveGroupOpacity(9999)).toThrow();
    expect(() => session.getEffectiveGroupVisibility(9999)).toThrow();
  });

  it("rejects missing parents, cycles and nonempty removal before changing any state or consuming IDs", () => {
    const session = new ProjectSession(); const a = session.addGroup(groupInput("A"));
    const b = session.addGroup(groupInput("B", a)); session.setLayerGroup(2, b);
    const before = stableSnapshot(session);
    for (const operation of [
      () => session.moveGroup(a, a), () => session.moveGroup(a, b),
      () => session.moveGroup(a, 999), () => session.moveGroup(999, a),
      () => session.removeGroup(a), () => session.removeGroup(b),
      () => session.removeGroup(999), () => session.removeLayer(999),
      () => session.addGroup(groupInput("Bad", 999)),
      () => session.addLayer({ ...layerInput(session, 2), groupId: 999 }),
      () => session.addLayer({ ...layerInput(session, 2), alpha: NaN }),
    ]) {
      expect(operation).toThrow(); expect(stableSnapshot(session)).toEqual(before);
    }
    expect(session.addGroup(groupInput("Valid"))).toBe(b + 1);
  });

  it("really removes default records and empty groups without implicitly recreating them on restore", () => {
    const session = new ProjectSession();
    for (const id of [1, 2, 3, 4]) session.removeLayer(id);
    session.removeGroup(101); session.removeGroup(102);
    const storage = new MemoryStorage(); session.save(storage);
    const restored = ProjectSession.restore(storage)!;
    expect(restored.layerList).toEqual([]); expect(restored.groupList).toEqual([]);
    const cloud = ProjectSession.fromDocument(session.toDocument());
    expect(cloud.layerList).toEqual([]); expect(cloud.groupList).toEqual([]);
    expect(restored.addGroup(groupInput())).toBe(103);
  });

  it.each(["local", "cloud"] as const)("roundtrips nested groups and deleted ID high-water through %s v2", kind => {
    const session = new ProjectSession("Nested");
    const parent = session.addGroup({ ...groupInput("Parent"), alpha: 0.5, collapsed: true });
    const child = session.addGroup({ ...groupInput("Child", parent), alpha: 0.4 });
    session.setLayerGroup(2, child); session.setLayerSourceRef(2, "fixture:points-v2");
    session.setPointStyle(2, { ...session.getLayer(2)!.pointStyle, pointSize: 7 });
    session.setTime(123); session.setCamera({ position: [1, 2, 3], direction: [0, 1, 0], up: [0, 0, 1] });
    const deleted = session.addLayer(layerInput(session, 4)); session.removeLayer(deleted);
    const storage = new MemoryStorage(); session.save(storage, new Date(0));
    const restored = kind === "local" ? ProjectSession.restore(storage)! : ProjectSession.fromDocument(JSON.parse(JSON.stringify(RPCDocument(session.toDocument()))));
    expect(stableSnapshot(restored)).toEqual(stableSnapshot(session));
    expect(restored.getEffectiveLayerOpacity(2)).toBeCloseTo(0.2, 12);
    expect(restored.addGroup(groupInput())).toBe(deleted + 1);
  });

  it.each(["duplicate-layer", "duplicate-group", "shared-id", "missing-parent", "cycle"] as const)("rejects a %s local tree without changing storage or the original instance", kind => {
    const session = new ProjectSession(); const before = stableSnapshot(session);
    const snapshot = structuredClone(before);
    if (kind === "duplicate-layer") snapshot.layers.push(snapshot.layers[0]!);
    if (kind === "duplicate-group") snapshot.groups.push(snapshot.groups[0]!);
    if (kind === "shared-id") snapshot.groups[0]!.id = snapshot.layers[0]!.id;
    if (kind === "missing-parent") snapshot.groups[0]!.parentId = 999;
    if (kind === "cycle") { snapshot.groups[0]!.parentId = 102; snapshot.groups[1]!.parentId = 101; }
    const storage = new MemoryStorage(); const serialized = JSON.stringify(snapshot);
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, serialized);
    expect(() => ProjectSession.restore(storage)).toThrow();
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(serialized);
    expect(stableSnapshot(session)).toEqual(before);
  });

  it("keeps a legacy flat v2 draft without groups or allocator metadata compatible", () => {
    const snapshot = stableSnapshot(new ProjectSession());
    const old = { ...snapshot } as Record<string, unknown>; delete old.groups; delete old.lastId;
    for (const layer of old.layers as Record<string, unknown>[]) delete layer.groupId;
    const storage = new MemoryStorage(); storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(old));
    const restored = ProjectSession.restore(storage)!;
    expect(restored.groupList.map(group => group.id)).toEqual([101, 102]);
    expect(restored.getLayer(4)?.groupId).toBe(102);
    expect(restored.addLayer(layerInput(restored, 2))).toBe(103);
  });
});

describe("ProjectSession tree import boundaries", () => {
  it.each(["duplicate-layer", "duplicate-group", "shared-id", "missing-group", "cycle"] as const)("rejects cloud %s without mutating its document", kind => {
    const source = new ProjectSession(); const document = source.toDocument();
    if (kind === "duplicate-layer") document.LayerList.push(document.LayerList[0]!);
    if (kind === "duplicate-group") document.LayerPathTree.ChildList.push({ ...document.LayerPathTree.ChildList[0]! });
    if (kind === "shared-id") document.LayerPathTree.ChildList[0]!.ID = document.LayerList[0]!.ID;
    if (kind === "missing-group") document.LayerList[0]!.PathTreeNodeID = 999;
    if (kind === "cycle") {
      const group = document.LayerPathTree.ChildList[0]!; group.ChildList.push(group);
      expect(() => ProjectSession.fromDocument(document)).toThrow();
      expect(group.ChildList[0]).toBe(group); return;
    }
    const before = JSON.stringify(RPCDocument(document));
    expect(() => ProjectSession.fromDocument(document)).toThrow();
    expect(JSON.stringify(RPCDocument(document))).toBe(before);
    expect(source.layerList.map(layer => layer.id)).toEqual([1, 2, 3, 4]);
  });

  it("preserves a larger allocator high-water even after that ID was deleted and refuses exhaustion atomically", () => {
    const document = new ProjectSession().toDocument(); document.LastID = 900;
    const restored = ProjectSession.fromDocument(document);
    expect(restored.addGroup(groupInput())).toBe(901);
    document.LastID = Number.MAX_SAFE_INTEGER;
    const exhausted = ProjectSession.fromDocument(document); const before = stableSnapshot(exhausted);
    expect(() => exhausted.addLayer(layerInput(exhausted, 2))).toThrow(/exhausted/);
    expect(stableSnapshot(exhausted)).toEqual(before);
  });

  it("rejects caller-supplied identities and invalid new record fields without allocating IDs", () => {
    const session = new ProjectSession(); const before = stableSnapshot(session);
    const operations = [
      () => session.addLayer({ ...layerInput(session, 2), id: 1 } as never),
      () => session.addGroup({ ...groupInput(), id: 101 } as never),
      () => session.addGroup({ ...groupInput(), alpha: Infinity }),
      () => session.addLayer({ ...layerInput(session, 2), type: 99 as ProjectLayerType }),
      () => session.addLayer({ ...layerInput(session, 2), active: "yes" } as never),
    ];
    for (const operation of operations) { expect(operation).toThrow(); expect(stableSnapshot(session)).toEqual(before); }
    expect(session.addGroup(groupInput())).toBe(103);
  });
});

it("respects the existing cloud tree allocator high-water when its last group was removed", () => {
  const document = new ProjectSession().toDocument();
  document.LastID = 102; document.LayerPathTree.LastID = 900;
  const restored = ProjectSession.fromDocument(document);
  expect(restored.addLayer(layerInput(restored, 2))).toBe(901);
  expect(restored.toDocument().LastID).toBe(901);
});
