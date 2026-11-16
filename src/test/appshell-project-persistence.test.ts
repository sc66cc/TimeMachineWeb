// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectDocumentV2TO } from "@timemachine/generated-api";
import { AGENT_ACTIONS, AGENT_DECLARATIONS, agentActions } from "../agent-actions";
import { registerProjectLocalActions } from "../project/project-actions";
import { ProjectSession, LOCAL_PROJECT_DRAFT_KEY, type ProjectRestoreResult } from "../project/project-session";
import { PROJECT_STATE_EVENT, type ProjectCloudSaveState, type ProjectStateDetail } from "../project/project-events";
import { LAYER_STATE_EVENT, type LayerStateDetail } from "../layers/layer-events";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";
import { openAddLayerPanel } from "./support/add-layer-panel";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined, referenceFails: false }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(), phase1BCloudClient: {
    get snapshot() { return fixture.state!; }, initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; },
    getCloudReference: () => { if (fixture.referenceFails) throw new Error("Invalid stored cloud project context"); return undefined; },
  },
}));
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession | undefined;
let restored: ProjectRestoreResult;
let cloudSave: ProjectCloudSaveState;
let downloaded: string[];
let review: ProjectStateDetail["review"];
let reviewOriginal: string | undefined;
let timeRange: ProjectStateDetail["timeRange"];
function publish(): void {
  const detail: ProjectStateDetail = {
    restoreStatus: restored.status, compatibility: session?.compatibilityReport ?? restored.compatibility,
    localSave: session?.localSaveState ?? { status: "readonly", revision: 0 }, cloudSave,
    originalAvailable: restored.original !== undefined,
    ...(review ? { review } : {}),
    ...(timeRange ? { timeRange } : {}),
  };
  window.dispatchEvent(new CustomEvent(PROJECT_STATE_EVENT, { detail }));
}
beforeEach(() => {
  fixture.referenceFails = false;
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession("Persistence test");
  restored = { status: "empty", compatibility: session.compatibilityReport };
  cloudSave = { status: "idle" }; downloaded = []; review = undefined; reviewOriginal = undefined; timeRange = undefined;
});
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); });
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount(): Promise<void> {
  mounted = await mountAppShell();
  window.localStorage.clear();
  registerProjectLocalActions(session, { storage: window.localStorage, capture() {}, publish, original: restored.original,
    reviewOriginal: () => reviewOriginal, downloadOriginal(original) { downloaded.push(original); } });
  publish(); await settle();
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing project UI: ${selector}`); return node;
}
const localButton = () => element<HTMLButtonElement>('button[data-action="project.saveLocal"]');

describe("AppShell project persistence", () => {
  it("saves the real local draft and keeps local and cloud outcomes separate", async () => {
    await mount();
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Unsaved");
    localButton().click(); await settle();
    const saved = JSON.parse(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)!);
    expect(saved.name).toBe("Persistence test"); expect(saved.schemaVersion).toBe(2);
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Saved locally");
    expect(element('[data-testid="cloud-save-status"]').textContent).toContain("Not saved to cloud");
    session!.setName("Changed locally"); cloudSave = { status: "error", message: "Cloud revision conflict" }; publish(); await settle();
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Unsaved");
    expect(element('[data-testid="cloud-save-error"]').textContent).toContain("Cloud revision conflict");
    localButton().click(); await settle();
    expect(JSON.parse(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)!).name).toBe("Changed locally");
    expect(element('[data-testid="cloud-save-error"]').textContent).toContain("Cloud revision conflict");
  });

  it("keeps the closed status entry one line and closes the expanded card with Escape", async () => {
    await mount();
    const details = element<HTMLDetailsElement>('[aria-label="Project persistence"]');
    const summary = element<HTMLElement>('[aria-label="Project persistence"] > summary');
    // Closed: the summary itself is the compact entry, with both real state nodes.
    expect(details.open).toBe(false);
    expect(details.firstElementChild).toBe(summary);
    expect(summary.querySelectorAll("span")).toHaveLength(2);
    expect(summary.querySelector('[data-testid="local-save-status"]')?.textContent).toContain("Unsaved");
    expect(summary.querySelector('[data-testid="cloud-save-status"]')?.textContent).toContain("Not saved to cloud");
    // Expanded: Escape closes it and returns focus to the summary; the details node
    // stays the same node, so the state feedback is never unmounted.
    details.open = true; details.dispatchEvent(new Event("toggle")); await settle();
    summary.focus();
    summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(element('[aria-label="Project persistence"]')).toBe(details);
    expect(summary.querySelector('[data-testid="local-save-status"]')?.textContent).toContain("Unsaved");
  });

  it("keeps a failed local save visible and allows a real subsequent save", async () => {
    await mount();
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => { throw new Error("Storage quota exhausted"); });
    localButton().click(); await settle();
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Local save failed");
    expect(element('[data-testid="local-save-error"]').textContent).toContain("not saved");
    expect(element('[data-testid="project-action-error"]').textContent).toContain("Storage quota exhausted");
    expect(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull(); expect(localButton().disabled).toBe(false);
    write.mockRestore(); localButton().click(); await settle();
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Saved locally");
    expect(document.querySelector('[data-testid="local-save-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="project-action-error"]')).toBeNull();
  });

  it.each(["future", "invalid"] as const)("preserves %s input with a read-only report and explicit original download", async kind => {
    const original = kind === "future" ? '{"schemaVersion":99,"name":"Future input","unknown":{"keep":true}}' : '{broken input';
    restored = ProjectSession.restoreWithReport({ getItem: () => original, setItem() { throw new Error("Restore must not rewrite input"); } });
    session = restored.session; cloudSave = { status: "readonly" }; await mount();
    await openAddLayerPanel("group"); await settle();
    const nativeIds = ["project-name", "atlas-status", "single-raster-select", "projection-select", "timeline-slider"];
    const nodes = nativeIds.map(id => element(`#${id}`));
    expect(element('[aria-label="Project persistence"]').textContent).toContain("Read-only");
    expect(element('[data-testid="project-compatibility-issues"]').textContent).toContain(kind === "future" ? "future-schema" : "invalid-json");
    expect(localButton().disabled).toBe(true);
    for (const selector of ['#project-name', 'button[data-action="project.save"]', 'button[data-action="model.select"]',
      'button[data-action="upload.open"]', '#timeline-slider', 'form[aria-label="Add layer group"] button[type="submit"]']) {
      expect(element<HTMLInputElement | HTMLButtonElement>(selector).disabled, selector).toBe(true);
    }
    expect(element<HTMLButtonElement>('[data-action="ui.accountMenu.toggle"]').disabled).toBe(false);
    expect(element<HTMLButtonElement>('[data-action="catalog.refresh"]').disabled).toBe(false);
    expect(await agentActions.execute(AGENT_ACTIONS.modelSelect, { source: "local-demo" })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(await agentActions.execute(AGENT_ACTIONS.uploadOpen)).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    element<HTMLButtonElement>('button[data-action="project.exportOriginal"]').click(); await settle();
    expect(downloaded).toEqual([original]); expect(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull();
    publish(); await settle(); nativeIds.forEach((id, index) => expect(element(`#${id}`)).toBe(nodes[index]));
  });

  it("renders an unsupported preserved layer without labeling it as plates", async () => {
    const snapshot = session!.toSnapshot(new Date(0)); (snapshot.layers[0]! as { type: number }).type = 99;
    const original = JSON.stringify(snapshot);
    restored = ProjectSession.restoreWithReport({ getItem: () => original, setItem() {} }); session = restored.session;
    cloudSave = { status: "readonly" }; await mount();
    const detail: LayerStateDetail = { layers: session!.layerList, groups: session!.groupList };
    window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail })); await settle();
    const row = element('[data-layer-id="1"]');
    expect(row.textContent).toContain("Unsupported layer type 99");
    expect(row.querySelector('.layer-swatch.plates')).toBeNull(); expect(row.querySelector('.layer-swatch.unsupported')).not.toBeNull();
  });

  it("keeps local saving available when preserved fields block cloud mapping", async () => {
    const original = JSON.stringify({ ...session!.toSnapshot(new Date(0)), extension: { label: "Keep this field" } });
    restored = ProjectSession.restoreWithReport({ getItem: () => original, setItem() {} }); session = restored.session;
    cloudSave = { status: "readonly" }; await mount();
    expect(localButton().disabled).toBe(false);
    expect(element<HTMLButtonElement>('button[data-action="project.save"]').disabled).toBe(true);
    expect(element('[aria-label="Project persistence"]').textContent).toContain("Local editing is available");
    localButton().click(); await settle();
    expect(JSON.parse(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)!).extension).toEqual({ label: "Keep this field" });
  });

  it("opens cloud projects through the shared action and exposes unavailable execution", async () => {
    fixture.state!.projects = [{ Name: "Cloud A", Revision: { Value: 41 }, Project: { Value: 5 }, PlateModelVersion: { Value: 7 },
      Description: "", ContentHash: "", RevisionNumber: 3, CreateTime: new Date("2026-11-15T00:00:00Z") }];
    await mount();
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.projectOpen]);
    const execute = vi.spyOn(agentActions, "execute");
    element<HTMLButtonElement>('button[data-action="project.open"]').click(); await settle();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.projectOpen, { revisionId: 41 });
    expect(element('[data-testid="project-action-error"]').textContent).not.toBe("");
    expect(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull();
  });

  it("shows a pending cloud review separately and downloads its original without locking the current project", async () => {
    const currentOriginal = JSON.stringify(session!.toSnapshot(new Date(0)));
    restored = ProjectSession.restoreWithReport({ getItem: () => currentOriginal, setItem() {} }); session = restored.session;
    await mount();
    expect(document.querySelector('[aria-label="Cloud project awaiting review"]')).toBeNull();
    const futureDocument = new ProjectDocumentV2TO(); futureDocument.SchemaVersion = 99; futureDocument.Name = "Future cloud project";
    const reviewed = ProjectSession.fromDocument(futureDocument);
    reviewOriginal = reviewed.exportOriginal();
    review = { name: reviewed.projectName, compatibility: reviewed.compatibilityReport, originalAvailable: true };
    publish(); await settle();
    expect(document.querySelector('[aria-label="Cloud project awaiting review"]')).not.toBeNull();
    expect(element('[aria-label="Cloud project awaiting review"]').textContent).toContain("Future cloud project");
    expect(element('[aria-label="Cloud project awaiting review"]').textContent).toContain("future-schema");
    expect(element<HTMLDetailsElement>('[aria-label="Project persistence"]').open).toBe(true);
    expect(localButton().disabled).toBe(false);
    expect(element<HTMLInputElement>('#project-name').disabled).toBe(false);
    expect(document.querySelector('.project-readonly-reason')).toBeNull();
    const execute = vi.spyOn(agentActions, "execute");
    element<HTMLButtonElement>('button[data-action="project.exportOriginal"][data-source="review"]').click(); await settle();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.projectExportOriginal, { source: "review" });
    expect(downloaded).toEqual([reviewOriginal]); expect(downloaded[0]).not.toBe(currentOriginal);
    element<HTMLButtonElement>('button[data-action="project.exportOriginal"][data-source="current"]').click(); await settle();
    expect(downloaded).toEqual([reviewOriginal, currentOriginal]);
    session!.setName("Current project edited"); publish(); localButton().click(); await settle();
    expect(JSON.parse(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)!).name).toBe("Current project edited");
    expect(element('[aria-label="Cloud project awaiting review"]').textContent).toContain("Future cloud project");
  });

  it("renders the shell without reading a throwing cloud-reference accessor", async () => {
    fixture.referenceFails = true;
    fixture.state!.projectContextError = "Invalid stored cloud project context";
    await mount();
    expect(element('[aria-label="Project persistence"]')).toBeDefined();
    expect(document.querySelector('button[data-action="project.saveLocal"]')).not.toBeNull();
    expect(element('[data-testid="project-context-error"]').textContent).toContain("Invalid stored cloud project context");
    expect(element('.draft-pill').textContent).toBe("Cloud context error");
    expect(element<HTMLButtonElement>('button[data-action="project.save"]').disabled).toBe(true);
    expect(localButton().disabled).toBe(false);
  });

  it("blocks project writes until compatibility is checked while keeping account access", async () => {
    mounted = await mountAppShell({ publishProjectState: false });
    expect(element('[data-testid="local-save-status"]').textContent).toContain("Checking project compatibility");
    expect(localButton().disabled).toBe(true);
    expect(element<HTMLButtonElement>('button[data-action="model.select"]').disabled).toBe(true);
    expect(await agentActions.execute(AGENT_ACTIONS.modelSelect, { source: "local-demo" })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(await agentActions.execute(AGENT_ACTIONS.uploadOpen)).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(element<HTMLButtonElement>('[data-action="ui.accountMenu.toggle"]').disabled).toBe(false);
    publish(); await settle();
    expect(localButton().disabled).toBe(false);
  });

  it("extends every timeline row for a 750 Ma project without replacing native controls or existing segments", async () => {
    await mount();
    const slider = element<HTMLInputElement>('#timeline-slider');
    const endpoint = element<HTMLButtonElement>('.quick-ages button:last-child');
    const rows = [...document.querySelectorAll<HTMLElement>('.timeline-row')];
    const originalSegments = rows.map(row => [...row.querySelectorAll<HTMLElement>('.segment')]);
    const originalWeights = originalSegments.map(segments => segments.map(segment => Number(segment.style.flexGrow)));
    const changed = vi.fn(); slider.addEventListener("input", changed);
    const endpointClicked = vi.fn(); endpoint.addEventListener("click", endpointClicked);
    expect(slider.max).toBe("538.8"); expect(element('.timeline__max').textContent).toBe("538.8");
    expect(endpoint.dataset.age).toBe("538.8"); expect(endpoint.textContent).toBe("538.8");
    expect(document.querySelector('.timeline-range-extension')).toBeNull();
    session!.setTime(750); timeRange = { minAgeMa: 0, maxAgeMa: 750 }; publish(); await settle();
    expect(element<HTMLInputElement>('#timeline-slider')).toBe(slider); expect(slider.max).toBe("750");
    expect(element('.timeline__max').textContent).toBe("750");
    expect(element('.quick-ages button:last-child')).toBe(endpoint);
    expect(endpoint.dataset.age).toBe("750"); expect(endpoint.textContent).toBe("750");
    rows.forEach((row, index) => {
      const extension = row.firstElementChild as HTMLElement;
      expect(extension.classList.contains('timeline-range-extension')).toBe(true);
      expect(extension.textContent?.trim()).toBe("750–538.8 Ma");
      const segments = [...row.querySelectorAll<HTMLElement>('.segment')].slice(1);
      expect(segments).toHaveLength(originalSegments[index]!.length);
      segments.forEach((segment, segmentIndex) => expect(segment).toBe(originalSegments[index]![segmentIndex]));
      expect(segments.map(segment => Number(segment.style.flexGrow))).toEqual(originalWeights[index]);
      const originalTotal = originalWeights[index]!.reduce((sum, value) => sum + value, 0);
      expect(Number(extension.style.flexGrow) / (originalTotal + Number(extension.style.flexGrow))).toBeCloseTo(0.2816, 6);
    });
    slider.value = "750"; slider.dispatchEvent(new Event("input", { bubbles: true })); endpoint.click();
    expect(changed).toHaveBeenCalledOnce(); expect(endpointClicked).toHaveBeenCalledOnce();
    expect(slider.value).toBe("750"); expect(session!.timeMa).toBe(750);
  });
});
