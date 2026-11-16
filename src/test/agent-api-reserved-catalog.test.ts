import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SHELL_UI_ACTIONS = [
  "ui.addPanel.setVisible",
  "ui.console.clear",
  "ui.console.selectOutput",
  "ui.console.setVisible",
  "ui.sidebar.setVisible",
  "ui.welcome.setVisible",
] as const;

const services = [
  "service.TimeMachinePlatform.GetCapabilities",
  "service.UserPlateModel.Display",
  "service.UserPlateModel.DisplayMine",
  "service.UserPlateModel.GetDetail",
];
const commands = ["feature.pick", "feature.select", "feature.clear"];
const declaredSelectionCommands = ["feature.select", "feature.clear"];
const queries = ["selection.snapshot", "feature.attributes", "feature.queryBox"];
const reserved = [...services, ...commands, ...queries];
let module: typeof import("../agent-actions/registry");
let target: Window;
const api = () => target.timeMachineAgent!.v2;

beforeEach(async () => {
  vi.resetModules();
  module = await import("../agent-actions/registry");
  await import("../agent-actions/actions");
  target = {} as Window;
  module.installAgentActions(target);
});
afterEach(() => {
  module.agentActions.disposeStateObservers();
  vi.unstubAllGlobals();
  vi.doUnmock("../agent-actions/reserved-catalog");
});

describe("reserved service and selection contracts", () => {
  it("discovers ten uninstalled entries while distinguishing two declared selection commands", () => {
    const rows = api().catalog.list();
    for (const id of reserved) {
      expect(rows.filter(row => row.id === id), id).toHaveLength(1);
      expect(rows.find(row => row.id === id), id).toMatchObject({
        availability: "not-implemented",
        completion: declaredSelectionCommands.includes(id) ? "state-committed" : "unverified",
        kind: services.includes(id) ? "service" : queries.includes(id) ? "query" : "command",
        scope: services.includes(id) ? "existing" : "p0-p3",
      });
      expect(rows.find(row => row.id === id)?.reason, id).toEqual(expect.any(String));
    }
    expect(api().catalog.list({ kind: "service", idPrefix: "service." }).map(row => row.id)).toEqual(services);
    const actions = target.timeMachineAgent!.listActions();
    expect(actions).toHaveLength(70);
    // The six shell controls were added; the original 64 stay complete.
    expect(actions.filter(row => !(SHELL_UI_ACTIONS as readonly string[]).includes(row.id))).toHaveLength(64);
    for (const id of SHELL_UI_ACTIONS) expect(actions.some(row => row.id === id), id).toBe(true);
    expect(actions.filter(row => reserved.includes(row.id)).map(row => row.id)).toEqual(["feature.clear", "feature.select"]);
    for (const id of declaredSelectionCommands) {
      expect(actions.find(row => row.id === id), id).toMatchObject({ id, status: "unsupported" });
    }
    expect(rows.some(row => /raster\.(paint|edit|write|formula)/i.test(row.id))).toBe(false);
  });

  it.each(reserved)("rejects uninstalled %s through its honest route without I/O, jobs or state changes", async id => {
    const fetch = vi.fn(() => { throw new Error("Reserved metadata must not contact a service"); });
    vi.stubGlobal("fetch", fetch);
    const before = module.agentActions.getState();
    const events: unknown[] = [];
    const unsubscribe = api().events.subscribe({}, event => events.push(event));
    const execution = await api().execute(id, {});
    const query = await api().query(id, {});
    expect(execution).toMatchObject({ ok: false, status: "failed", error: { kind: "not-implemented", code: "NOT_IMPLEMENTED", retryable: false } });
    expect(query).toMatchObject({ ok: false, status: "failed", error: declaredSelectionCommands.includes(id)
      ? { kind: "validation", code: "VALIDATION", retryable: false }
      : { kind: "not-implemented", code: "NOT_IMPLEMENTED", retryable: false } });
    for (const result of [execution, query]) {
      expect(result).not.toHaveProperty("data");
      expect(result).not.toHaveProperty("jobId");
    }
    if (declaredSelectionCommands.includes(id)) {
      expect(await target.timeMachineAgent!.execute(id, {})).toMatchObject({ actionId: id, ok: false, error: { kind: "unsupported" } });
    }
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(module.agentActions.getState()).toEqual(before);
    expect(events).toEqual([]);
    unsubscribe();
  });

  it("describes adapter provenance without a fabricated service invocation or wire DTO", async () => {
    const expected = [
      [services[0]!, "TimeMachinePlatformRuntime.loadCapabilities", "TimeMachineCapabilitiesRO"],
      [services[1]!, "SharedPlateModelClient.display", "PageRO<PlateModelSimpleRO>"],
      [services[2]!, "SharedPlateModelClient.displayMine", "PlateModelSimpleRO[]"],
      [services[3]!, "SharedPlateModelClient.getDetail", "PlateModelRO"],
    ];
    for (const [id, adapter, response] of expected) {
      const descriptor = await api().catalog.describe(id!);
      expect(descriptor, id).toBeDefined();
      expect(descriptor!.description).toContain(adapter);
      expect(descriptor!.outputSchema.description).toContain(response);
      expect(descriptor!.description).toContain("metadata only");
      expect(descriptor).not.toHaveProperty("invocation");
      expect(descriptor!.examples).toEqual([]);
      expect(descriptor!.outputSchema.type).toBeUndefined();
    }
    expect((await api().catalog.describe(services[1]!))!.description).toContain("binary");
    expect((await api().catalog.describe(services[2]!))!.requirements).toContain("authenticated-account");
  });

  it("keeps planned selection units and bounded results discoverable and independently copied", async () => {
    const pick = await api().catalog.describe("feature.pick");
    expect(pick?.description).toContain("CSS pixels");
    const first = await api().catalog.describe("feature.queryBox");
    expect(first?.inputSchema.properties?.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 500 });
    expect(first?.outputSchema.properties?.items?.items?.properties?.featureId).toMatchObject({ type: "string" });
    first!.inputSchema.properties!.limit!.maximum = 1;
    first!.outputSchema.properties!.items!.items!.properties!.featureId!.type = "number";
    const second = await api().catalog.describe("feature.queryBox");
    expect(second!.inputSchema.properties!.limit!.maximum).toBe(500);
    expect(second!.outputSchema.properties!.items!.items!.properties!.featureId!.type).toBe("string");
  });

  it("does not load reserved details for discovery or rejected execution", async () => {
    let detailModuleLoads = 0;
    // Observe the module-loader boundary while retaining the real descriptor code.
    vi.doMock("../agent-actions/reserved-catalog", async importOriginal => {
      detailModuleLoads++;
      return importOriginal<typeof import("../agent-actions/reserved-catalog")>();
    });
    api().catalog.list();
    await api().execute("feature.pick");
    await api().query("feature.queryBox");
    expect(detailModuleLoads).toBe(0);
    expect(await api().catalog.describe("feature.queryBox")).toMatchObject({ id: "feature.queryBox", availability: "not-implemented" });
    expect(detailModuleLoads).toBe(1);
    await api().catalog.describe(services[0]!);
    expect(detailModuleLoads).toBe(1);
  });

  it("lets an actual definition and contract replace a reserved entry without duplication", async () => {
    expect(await api().execute("feature.pick")).toMatchObject({ error: { kind: "not-implemented" } });
    let calls = 0;
    module.agentActions.register({ id: "feature.pick", title: "Pick current feature", description: "Actual selection adapter", params: [], status: "ready" }, () => ({ data: { calls: ++calls } }));
    module.agentActions.setContract("feature.pick", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "state-committed", requirements: [] }, async () => ({
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { calls: { type: "number" } } }, examples: [],
    }));
    expect(api().catalog.list().filter(row => row.id === "feature.pick")).toHaveLength(1);
    expect(await api().catalog.describe("feature.pick")).toMatchObject({ availability: "ready", description: "Actual selection adapter", completion: "state-committed" });
    expect(await api().execute("feature.pick")).toMatchObject({ status: "completed", data: { calls: 1 } });
    expect(await target.timeMachineAgent!.execute("feature.pick")).toMatchObject({ ok: true, data: { calls: 2 } });
  });

  it("does not let a lazy reserved description overwrite a registration made during its await", async () => {
    const describing = api().catalog.describe("feature.pick");
    module.agentActions.registerUnsupported("feature.pick", "Real adapter pending", "Actual adapter capability pending");
    module.agentActions.setContract("feature.pick", { kind: "command", scope: "excluded", effect: "ui-local", completion: "unverified", requirements: [] });
    expect(await describing).toMatchObject({ title: "Real adapter pending", availability: "out-of-scope", description: "Actual adapter capability pending" });
    expect(await api().execute("feature.pick")).toMatchObject({ error: { kind: "unsupported" } });
  });

  it("preserves live snapshot queries, direct helper routing and genuinely unknown IDs", async () => {
    module.agentActions.registerStateSection("ui", () => ({ panel: "layers" }));
    module.agentActions.registerStateSection("project", () => ({ name: "Synthetic project" }));
    for (const id of ["scene.snapshot", "ui.snapshot", "project.snapshot"]) {
      expect(await api().query(id, {})).toMatchObject({ ok: true, status: "completed" });
      expect(await api().execute(id, {})).toMatchObject({ error: { kind: "validation" } });
    }
    for (const id of ["catalog.list", "catalog.describe", "jobs.get", "jobs.wait", "jobs.cancel", "logs.query", "logs.export", "logs.clear", "events.subscribe"]) {
      expect(await api().execute(id, {})).toMatchObject({ error: { kind: "validation", message: expect.stringContaining("direct facade") } });
      expect(await api().query(id, {})).toMatchObject({ error: { kind: "validation", message: expect.stringContaining("direct facade") } });
    }
    expect(await api().execute("not.a.contract")).toMatchObject({ error: { kind: "validation" } });
    expect(await api().query("not.a.contract")).toMatchObject({ error: { kind: "validation" } });
    expect(await api().catalog.describe("not.a.contract")).toBeUndefined();
  });
});
