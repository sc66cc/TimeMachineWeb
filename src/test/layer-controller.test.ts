// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { LayerController, type LayerRuntimeAdapter } from "../layers/layer-controller";
import { LAYER_STATE_EVENT } from "../layers/layer-events";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";

/**
 * The LayerController is the code both the sidebar UI events and the action
 * facade call, so these tests drive the production class with a real
 * ProjectSession and a recording adapter.
 */

interface Recorded {
  imageryOrder: number;
  persisted: number;
  published: number;
  runtime: number[];
  synced: number;
}

function harness(): {
  controller: LayerController;
  recorded: Recorded;
  session: ProjectSession;
} {
  const session = new ProjectSession();
  const recorded: Recorded = {
    imageryOrder: 0,
    persisted: 0,
    published: 0,
    runtime: [],
    synced: 0,
  };
  const adapter: LayerRuntimeAdapter = {
    applyImageryOrder: () => {
      recorded.imageryOrder += 1;
    },
    applyRuntime: (id) => {
      recorded.runtime.push(id);
    },
    persist: () => {
      recorded.persisted += 1;
    },
    // Mirrors what main.ts does: republish the session state to the sidebar.
    publishState: () => {
      recorded.published += 1;
      window.dispatchEvent(
        new CustomEvent(LAYER_STATE_EVENT, {
          detail: {
            groups: session.groupList,
            layers: session.layerList,
          },
        }),
      );
    },
    syncNativeControls: () => {
      recorded.synced += 1;
    },
  };
  return { controller: new LayerController(session, adapter), recorded, session };
}

describe("LayerController", () => {
  it("applies a layer visibility change to renderers, state and persistence", () => {
    const { controller, recorded, session } = harness();
    controller.setLayerVisibility(RUNTIME_LAYER_IDS.raster, false);
    expect(session.getLayer(RUNTIME_LAYER_IDS.raster)?.active).toBe(false);
    expect(session.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.raster)).toBe(
      false,
    );
    expect(recorded.runtime).toEqual([RUNTIME_LAYER_IDS.raster]);
    expect(recorded.synced).toBe(1);
    expect(recorded.published).toBe(1);
    expect(recorded.persisted).toBe(1);
  });

  it("rejects an alpha outside [0, 1] instead of clamping silently", () => {
    const { controller, session } = harness();
    expect(() =>
      controller.setLayerOpacity(RUNTIME_LAYER_IDS.raster, 2),
    ).toThrow(/alpha must be within \[0, 1\]/);
    expect(session.getLayer(RUNTIME_LAYER_IDS.raster)?.alpha).toBe(0.9);
    expect(() =>
      controller.setLayerOpacity(RUNTIME_LAYER_IDS.raster, -1),
    ).toThrow(/alpha must be within \[0, 1\]/);
  });

  it("rejects an unknown layer or group", () => {
    const { controller } = harness();
    expect(() => controller.setLayerVisibility(99, true)).toThrow(
      /Unknown layer 99/,
    );
    expect(() => controller.setGroupVisibility(99, true)).toThrow(
      /Unknown layer group 99/,
    );
    expect(() => controller.setLayerGroup(RUNTIME_LAYER_IDS.raster, 99)).toThrow(
      /Unknown layer group 99/,
    );
  });

  it("applies a group visibility change to every member layer", () => {
    const { controller, recorded, session } = harness();
    const members = session.layerList
      .filter((layer) => layer.groupId === 101)
      .map((layer) => layer.id);
    controller.setGroupVisibility(101, false);
    for (const id of members) {
      expect(session.getEffectiveLayerVisibility(id)).toBe(false);
    }
    expect(recorded.runtime).toEqual(members);
    expect(recorded.persisted).toBe(1);
  });

  it("persists a group collapse", () => {
    const { controller, recorded, session } = harness();
    controller.setGroupCollapsed(102, true);
    expect(session.getGroup(102)?.collapsed).toBe(true);
    expect(recorded.persisted).toBe(1);
  });

  it("reorders with a full ordered id list and moves layers between groups", () => {
    const { controller, recorded, session } = harness();
    controller.setOrder([4, 3, 2, 1], { 1: 102 });
    expect(session.layerList.map((layer) => layer.id)).toEqual([4, 3, 2, 1]);
    expect(session.getLayer(RUNTIME_LAYER_IDS.atlas)?.groupId).toBe(102);
    expect(recorded.runtime).toEqual([4, 3, 2, 1]);
    expect(recorded.imageryOrder).toBe(1);
    expect(recorded.persisted).toBe(1);
  });

  it("rejects an incomplete order and an unknown group in the map", () => {
    const { controller, session } = harness();
    expect(() => controller.setOrder([1, 2])).toThrow(
      /Layer order must contain every layer exactly once/,
    );
    expect(() => controller.setOrder([1, 2, 3, 4], { 1: 999 })).toThrow(
      /Unknown layer group 999/,
    );
    expect(session.layerList.map((layer) => layer.id)).toEqual([1, 2, 3, 4]);
  });

  it("moves a single layer into another group", () => {
    const { controller, recorded, session } = harness();
    controller.setLayerGroup(RUNTIME_LAYER_IDS.points, 102);
    expect(session.getLayer(RUNTIME_LAYER_IDS.points)?.groupId).toBe(102);
    expect(recorded.runtime).toEqual([RUNTIME_LAYER_IDS.points]);
    expect(recorded.imageryOrder).toBe(1);
  });

  it("publishes the layer state event so the sidebar follows an agent edit", () => {
    const { controller, session } = harness();
    let seen: unknown;
    const listener = (event: Event): void => {
      seen = (event as CustomEvent<unknown>).detail;
    };
    window.addEventListener(LAYER_STATE_EVENT, listener);
    controller.setLayerVisibility(RUNTIME_LAYER_IDS.plateModel, false);
    window.removeEventListener(LAYER_STATE_EVENT, listener);
    expect(seen).toEqual({
      groups: session.groupList,
      layers: session.layerList,
    });
  });
});
