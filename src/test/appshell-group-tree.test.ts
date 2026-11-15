// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { LayerController } from "../layers/layer-controller";
import { registerLayerGroupActions } from "../layers/group-actions";
import { LAYER_GROUP_COLLAPSE_CHANGE_EVENT, LAYER_STATE_EVENT } from "../layers/layer-events";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(),
  phase1BCloudClient: {
    get snapshot() { return fixture.state!; },
    initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; },
    getCloudReference: () => undefined,
  },
}));

let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
let controller: LayerController;
let detachCollapse: () => void;

function publish(): void {
  window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail: { groups: session.groupList, layers: session.layerList } }));
}

beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession();
  controller = new LayerController(session, {
    publishState: publish, applyImageryOrder() {}, applyRuntime() {}, persist() {}, syncNativeControls() {},
  });
  // Exactly the same handlers as main.ts, with a real registry/controller/tree.
  registerLayerGroupActions(session, controller);
  const collapse = (event: Event) => {
    const detail = (event as CustomEvent<{ id: number; collapsed: boolean }>).detail;
    controller.setGroupCollapsed(detail.id, detail.collapsed);
  };
  window.addEventListener(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, collapse);
  detachCollapse = () => window.removeEventListener(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, collapse);
});

afterEach(() => {
  mounted?.unmount(); mounted = undefined;
  detachCollapse();
  vi.restoreAllMocks();
});

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing group UI control: ${selector}`);
  return node;
}

function field(selector: string, value: string, event = "input"): void {
  const node = element<HTMLInputElement | HTMLSelectElement>(selector);
  node.value = value;
  node.dispatchEvent(new Event(event, { bubbles: true }));
}

async function settle(): Promise<void> {
  await Promise.resolve(); await nextTick();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await nextTick(); }
function add(name: string, parentId?: number): number {
  return controller.addGroup({ name, active: true, alpha: 1, collapsed: false, ...(parentId === undefined ? {} : { parentId }) });
}
function groupRow(id: number): HTMLElement { return element(`.layer-group-row[data-group-id="${id}"]`); }
function visibleGroups(): number[] {
  return [...document.querySelectorAll<HTMLElement>(".layer-group-row")].filter(node => node.style.display !== "none").map(node => Number(node.dataset.groupId));
}
function moveSelect(id: number): string { return `[data-group-controls="${id}"] select[data-action="layer.group.move"]`; }

describe("AppShell editable group tree", () => {
  it("adds root and child groups through the shared action without changing the four runtime layers", async () => {
    await mount();
    const execute = vi.spyOn(agentActions, "execute");
    field('[aria-label="New group name"]', "  Research  ");
    await nextTick();
    element<HTMLButtonElement>('button[data-action="layer.group.add"]').click();
    await settle();
    const parent = session.groupList.find(group => group.name === "Research")!;
    expect(parent).toMatchObject({ active: true, alpha: 1, collapsed: false });
    expect(parent.parentId).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerGroupAdd, { group: { name: "Research", active: true, alpha: 1, collapsed: false } });
    expect(element<HTMLInputElement>('[aria-label="New group name"]').value).toBe("");
    field('[aria-label="New group name"]', "Occurrences");
    field('[aria-label="New group parent"]', String(parent.id), "change");
    await nextTick();
    element<HTMLButtonElement>('button[data-action="layer.group.add"]').click();
    await settle();
    expect(session.groupList.find(group => group.name === "Occurrences")?.parentId).toBe(parent.id);
    expect(session.layerList).toHaveLength(4);
    expect(document.querySelectorAll(".layer-row")).toHaveLength(4);
    field('[aria-label="New group name"]', "   "); await nextTick();
    expect(element<HTMLButtonElement>('button[data-action="layer.group.add"]').disabled).toBe(true);
  });

  it("uses stable tree order and hides all descendants when an ancestor is collapsed", async () => {
    const dataId = session.layerList.find(layer => layer.id === RUNTIME_LAYER_IDS.points)!.groupId;
    const parent = add("Research"); const child = add("Samples", parent);
    controller.moveGroup(dataId, child);
    await mount();
    const roots = session.groupList.filter(group => group.parentId === undefined).map(group => group.id);
    expect(visibleGroups()).toEqual([...roots, child, dataId]);
    expect(groupRow(dataId).dataset.depth).toBe("2");
    controller.setGroupCollapsed(parent, true); await nextTick();
    expect(visibleGroups()).toEqual(roots);
    expect(element(`#load-points`).closest<HTMLElement>(".layer-row")?.style.display).toBe("none");
    expect(element<HTMLElement>(`[data-group-controls="${dataId}"]`).style.display).toBe("none");
    groupRow(parent).querySelector<HTMLButtonElement>('button[data-action="layer.group.setCollapsed"]')!.click();
    await nextTick();
    expect(visibleGroups()).toEqual([...roots, child, dataId]);
  });

  it("searches a nested layer or group with its ancestor path, without mutating collapse state", async () => {
    const dataId = session.layerList.find(layer => layer.id === RUNTIME_LAYER_IDS.points)!.groupId;
    const parent = add("Research"); const child = add("Samples", parent);
    controller.moveGroup(dataId, child); controller.setGroupCollapsed(parent, true);
    await mount();
    field('input[data-action="ui.layerSearch.set"]', " PBDB "); await nextTick();
    expect(visibleGroups()).toEqual([parent, child, dataId]);
    expect(element(`#load-points`).closest<HTMLElement>(".layer-row")?.style.display).not.toBe("none");
    expect(groupRow(dataId).querySelector("small")?.textContent).toBe("1");
    expect(groupRow(parent).querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    field('input[data-action="ui.layerSearch.set"]', "Research"); await nextTick();
    expect(visibleGroups()).toEqual([parent, child, dataId]);
    expect(document.querySelector(".layer-empty")).toBeNull();
    expect(session.getGroup(parent)?.collapsed).toBe(true);
    field('input[data-action="ui.layerSearch.set"]', "missing-group"); await nextTick();
    expect(visibleGroups()).toEqual([]);
    expect(document.querySelector(".layer-empty")?.textContent).toContain("No matching");
    field('input[data-action="ui.layerSearch.set"]', ""); await nextTick();
    expect(visibleGroups()).not.toContain(child);
  });

  it("reveals style through every collapsed ancestor and preserves native runtime DOM and listeners", async () => {
    const dataId = session.layerList.find(layer => layer.id === RUNTIME_LAYER_IDS.points)!.groupId;
    const parent = add("Research"); const child = add("Samples", parent);
    controller.moveGroup(dataId, child);
    await mount();
    const ids = ["load-points", "point-state-chip", "atlas-frame-value", "single-raster-state"];
    const nodes = ids.map(id => element(`#${id}`));
    const load = nodes[0] as HTMLButtonElement; const clicked = vi.fn();
    load.disabled = false; load.addEventListener("click", clicked); nodes[1]!.textContent = "Native ready";
    for (const id of [parent, child, dataId]) controller.setGroupCollapsed(id, true);
    await nextTick();
    await agentActions.execute(AGENT_ACTIONS.layerSearchSet, { query: "no-match" });
    const outcome = await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: RUNTIME_LAYER_IDS.points });
    await nextTick();
    expect(outcome.ok).toBe(true);
    for (const id of [parent, child, dataId]) expect(session.getGroup(id)?.collapsed).toBe(false);
    expect(agentActions.getState().ui).toMatchObject({ layerSearch: "", layerStyleOpen: true, selectedLayerId: RUNTIME_LAYER_IDS.points });
    expect(load.closest<HTMLElement>(".layer-row")?.style.display).not.toBe("none");
    ids.forEach((id, index) => expect(element(`#${id}`)).toBe(nodes[index]));
    expect(nodes[1]!.textContent).toBe("Native ready"); expect(load.disabled).toBe(false);
    load.click(); expect(clicked).toHaveBeenCalledOnce();
    controller.setGroupCollapsed(parent, true); await nextTick();
    expect(agentActions.getState().ui).toMatchObject({ layerStyleOpen: false });
  });

  it("moves groups with cycle targets excluded and keeps the native layer nodes", async () => {
    const parent = add("Research"); const child = add("Samples", parent);
    const dataId = session.layerList.find(layer => layer.id === RUNTIME_LAYER_IDS.points)!.groupId;
    await mount();
    const pointButton = element("#load-points");
    const execute = vi.spyOn(agentActions, "execute");
    const options = [...element<HTMLSelectElement>(moveSelect(parent)).options].map(option => option.value);
    expect(options).not.toContain(String(parent)); expect(options).not.toContain(String(child));
    field(moveSelect(dataId), String(child), "change"); await settle();
    expect(session.getGroup(dataId)?.parentId).toBe(child);
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerGroupMove, { groupId: dataId, parentId: child });
    expect(groupRow(dataId).dataset.depth).toBe("2"); expect(element("#load-points")).toBe(pointButton);
    field(moveSelect(dataId), "", "change"); await settle();
    expect(session.getGroup(dataId)?.parentId).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerGroupMove, { groupId: dataId });
    expect(element("#load-points")).toBe(pointButton);
  });

  it("preserves every native point control when an existing layer moves across group owners", async () => {
    const parent = add("Research"); const target = add("Samples", parent);
    controller.setGroupCollapsed(parent, true);
    await mount();
    const pointId = RUNTIME_LAYER_IDS.points;
    const originalGroup = session.layerList.find(layer => layer.id === pointId)!.groupId;
    const ids = ["load-points", "unload-points", "point-state-chip", "point-status", "point-count", "point-visibility", "point-dataset-select"];
    const nodes = ids.map(id => element(`#${id}`));
    const load = nodes[0] as HTMLButtonElement;
    const visibility = nodes[5] as HTMLInputElement;
    const dataset = nodes[6] as HTMLSelectElement;
    const clicked = vi.fn(); const changed = vi.fn();
    load.disabled = false; load.addEventListener("click", clicked);
    visibility.addEventListener("change", changed);
    nodes[2]!.textContent = "Native ready";
    dataset.disabled = false; dataset.replaceChildren(new Option("Native dataset", "fixture")); dataset.value = "fixture";
    controller.setLayerGroup(pointId, target); await nextTick();
    ids.forEach((id, index) => expect(element(`#${id}`), id).toBe(nodes[index]));
    expect(load.closest<HTMLElement>(".layer-row")?.style.display).toBe("none");
    expect(load.closest<HTMLElement>(".layer-row")?.style.marginLeft).toBe("12px");
    await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: pointId }); await nextTick();
    expect(load.closest<HTMLElement>(".layer-row")?.style.display).not.toBe("none");
    controller.setLayerGroup(pointId, originalGroup); await nextTick();
    ids.forEach((id, index) => expect(element(`#${id}`), id).toBe(nodes[index]));
    expect(nodes[2]!.textContent).toBe("Native ready"); expect(load.disabled).toBe(false);
    expect(dataset.disabled).toBe(false); expect(dataset.value).toBe("fixture"); expect(dataset.options[0]?.text).toBe("Native dataset");
    load.click(); visibility.dispatchEvent(new Event("change", { bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
  });

  it("restores the move select and shows the shared action's real stale-parent failure", async () => {
    const moving = add("Research"); const target = add("Samples");
    await mount();
    session.removeGroup(target); // A concurrent edit has not reached the sidebar yet.
    field(moveSelect(moving), String(target), "change"); await settle();
    expect(session.getGroup(moving)?.parentId).toBeUndefined();
    expect(element<HTMLSelectElement>(moveSelect(moving)).value).toBe("");
    expect(element('[role="alert"].layer-group-error').textContent).toMatch(/unknown layer group/i);
  });

  it("deletes only empty groups, explains nonempty groups and reports an actual stale-state rejection", async () => {
    const parent = add("Research"); const child = add("Samples", parent);
    await mount();
    const remove = (id: number) => element<HTMLButtonElement>(`[data-group-controls="${id}"] button[data-action="layer.group.remove"]`);
    expect(remove(parent).disabled).toBe(true);
    expect(element(`[data-group-controls="${parent}"]`).textContent).toContain("Contains layers or child groups");
    const dataId = session.layerList[0]!.groupId;
    expect(remove(dataId).disabled).toBe(true);
    const execute = vi.spyOn(agentActions, "execute");
    remove(child).click(); await settle();
    expect(session.getGroup(child)).toBeUndefined(); expect(document.querySelector(`.layer-group-row[data-group-id="${child}"]`)).toBeNull();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerGroupRemove, { groupId: child });
    // A concurrent edit reaches the controller before this UI receives its state event.
    session.addGroup({ name: "Concurrent child", active: true, alpha: 1, collapsed: false, parentId: parent });
    remove(parent).click(); await settle();
    expect(session.getGroup(parent)).toBeDefined();
    expect(element('[role="alert"].layer-group-error').textContent).toMatch(/nonempty/i);
  });
});
