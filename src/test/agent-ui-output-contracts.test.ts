// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Phase1BState } from "../phase1b/cloud-client";
import { agentActions } from "../agent-actions";
import { installAgentActions } from "../agent-actions/registry";
import { validateApiInput, type ApiDescriptor } from "../agent-actions/contracts";
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

interface Case {
  id: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  secondOutput?: Record<string, unknown>;
  state: Record<string, unknown>;
  signedIn?: boolean;
  before?: Array<[string, Record<string, unknown>]>;
}
const cases: Case[] = [
  { id: "ui.sidebar.select", input: { tab: "plate-models" }, output: { tab: "plate-models" }, state: { activeSidebarTab: "plate-models" } },
  { id: "ui.authDialog.open", input: {}, output: {}, state: { authDialogOpen: true } },
  { id: "ui.authDialog.close", input: {}, output: {}, state: { authDialogOpen: false }, before: [["ui.authDialog.open", {}]] },
  { id: "ui.authMode.set", input: { mode: "email-code" }, output: { mode: "email-code" }, state: { authMode: "email-code" } },
  { id: "ui.toolbar.toggle", input: {}, output: { collapsed: true }, secondOutput: { collapsed: false }, state: { toolbarCollapsed: true } },
  { id: "ui.accountMenu.toggle", input: {}, output: { accountMenuOpen: false, authDialogOpen: true }, state: { accountMenuOpen: false, authDialogOpen: true } },
  { id: "ui.accountMenu.setVisible", input: { visible: true }, output: { open: false }, state: { accountMenuOpen: false } },
  { id: "ui.layerSearch.set", input: { query: "raster" }, output: { query: "raster" }, state: { layerSearch: "raster" } },
  { id: "ui.layerStyle.open", input: { layerId: 3 }, output: { layerId: 3 }, state: { selectedLayerId: 3 } },
  { id: "ui.layerStyle.close", input: {}, output: { layerId: null }, state: { selectedLayerId: null }, before: [["ui.layerStyle.open", { layerId: 3 }]] },
  { id: "ui.module.select", input: { module: "Atlas" }, output: { module: "Atlas" }, state: { activeModule: "Atlas" } },
  { id: "ui.upload.back", input: { step: "select" }, output: { step: "select" }, state: { uploadStep: "select" }, signedIn: true,
    before: [["upload.open", {}], ["ui.upload.back", { step: "map" }]] },
];
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let target: Window;
beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  target = {} as Window;
  installAgentActions(target);
});
afterEach(() => { mounted?.unmount(); mounted = undefined; });

function assertExactOutput(descriptor: ApiDescriptor, data: Record<string, unknown>): void {
  const schema = descriptor.outputSchema;
  expect(validateApiInput(schema, data)).toBeUndefined();
  expect(validateApiInput(schema, { ...data, undeclaredOutput: true })).toBeDefined();
  expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(data).sort());
  for (const key of Object.keys(data)) {
    const missing = { ...data }; delete missing[key];
    expect(validateApiInput(schema, missing), `${descriptor.id} missing ${key}`).toBeDefined();
    expect(validateApiInput(schema, { ...data, [key]: {} }), `${descriptor.id} invalid ${key}`).toBeDefined();
  }
}

describe("real AppShell UI output contracts", () => {
  it.each(cases)("describes actual v1/v2 results for $id with no extra output fields", async entry => {
    if (entry.signedIn) {
      fixture.state!.account = { name: "Synthetic account", email: "synthetic@example.test", tokenExpiresAt: "" };
      fixture.state!.status = "signed-in";
    }
    mounted = await mountAppShell();
    for (const [id, input] of entry.before ?? []) expect((await agentActions.execute(id, input)).ok).toBe(true);
    const v1 = await target.timeMachineAgent!.execute(entry.id, entry.input);
    expect(v1).toEqual({ actionId: entry.id, ok: true, reloadRequired: false, data: entry.output });
    expect(agentActions.getState().ui).toMatchObject(entry.state);
    const descriptor = await target.timeMachineAgent!.v2.catalog.describe(entry.id);
    expect(descriptor).toBeDefined();
    assertExactOutput(descriptor!, entry.output);
    const v2 = await target.timeMachineAgent!.v2.execute(entry.id, entry.input);
    expect(v2).toMatchObject({ ok: true, status: "completed", data: entry.secondOutput ?? entry.output });
    if (!v2.ok || v2.status !== "completed") throw new Error("UI action failed.");
    assertExactOutput(descriptor!, v2.data as Record<string, unknown>);
    expect(descriptor!.examples).toContainEqual(expect.objectContaining({ input: entry.input, output: entry.output }));
    for (const example of descriptor!.examples as Array<{ input: unknown; output: unknown }>) {
      expect(validateApiInput(descriptor!.inputSchema, example.input)).toBeUndefined();
      expect(validateApiInput(descriptor!.outputSchema, example.output)).toBeUndefined();
    }
  });

  it("describes module switching as a toolbar label, without claiming module work completed", async () => {
    mounted = await mountAppShell();
    const descriptor = await target.timeMachineAgent!.v2.catalog.describe("ui.module.select");
    for (const module of ["Layer", "Atlas", "Database", "Multi Globe", "Project Market", "Area Tool"]) {
      const result = await target.timeMachineAgent!.v2.execute("ui.module.select", { module });
      expect(result).toMatchObject({ ok: true, data: { module } });
      expect(agentActions.getState().ui).toMatchObject({ activeModule: module });
      expect(validateApiInput(descriptor!.outputSchema, { module })).toBeUndefined();
    }
    expect(validateApiInput(descriptor!.outputSchema, { module: "Invented module" })).toBeDefined();
    expect(descriptor!.outputSchema.description).toMatch(/label/i);
    expect(await target.timeMachineAgent!.v2.execute("ui.module.select", { module: "Invented module" })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(agentActions.getState().ui).toMatchObject({ activeModule: "Area Tool" });
  });

  it("keeps nullable style selection explicit and prevents returned schema mutations from changing later descriptions", async () => {
    mounted = await mountAppShell();
    const api = target.timeMachineAgent!.v2;
    const first = await api.catalog.describe("ui.layerStyle.open");
    expect(validateApiInput(first!.outputSchema, { layerId: null })).toBeUndefined();
    expect(validateApiInput(first!.outputSchema, { layerId: 0 })).toBeDefined();
    first!.outputSchema.properties!.layerId!.type = "string";
    const second = await api.catalog.describe("ui.layerStyle.open");
    expect(validateApiInput(second!.outputSchema, { layerId: 3 })).toBeUndefined();
    expect(validateApiInput(second!.outputSchema, { layerId: "3" })).toBeDefined();
  });
});
