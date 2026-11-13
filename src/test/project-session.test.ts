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
