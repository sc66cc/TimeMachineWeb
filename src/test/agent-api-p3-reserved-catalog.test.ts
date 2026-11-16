import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SHELL_UI_ACTIONS = [
  "ui.addPanel.setVisible",
  "ui.console.clear",
  "ui.console.selectOutput",
  "ui.console.setVisible",
  "ui.sidebar.setVisible",
  "ui.welcome.setVisible",
] as const;

const commands = ["model.bind", "model.setAnchor", "viewport.create", "viewport.close", "viewport.activate", "viewport.layout", "camera.sync"];
const queries = ["raster.sample", "viewports.snapshot"];
const ids = [...commands, ...queries];
let registry: typeof import("../agent-actions/registry");
let target: Window;
const api = () => target.timeMachineAgent!.v2;

beforeEach(async () => {
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  await import("../agent-actions/actions");
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(() => {
  registry.agentActions.disposeStateObservers();
  vi.unstubAllGlobals();
  vi.doUnmock("../agent-actions/reserved-catalog");
});

describe("P3 reserved model, viewport and sampling catalog", () => {
  it("discovers all nine P3 entries without changing the v1 inventory", () => {
    for (const id of ids) {
      const matches = api().catalog.list({ idPrefix: id }).filter(row => row.id === id);
      expect(matches, id).toHaveLength(1);
      expect(matches[0], id).toMatchObject({ kind: queries.includes(id) ? "query" : "command", scope: "p0-p3", availability: "not-implemented", completion: "unverified" });
      expect(matches[0]!.requirements, id).toContain(id.startsWith("model.") ? "P3-01-model-binding" : id === "raster.sample" ? "P3-06-original-value-source" : "P3-07-viewports");
      expect(matches[0]!.reason, id).not.toContain("P2-05");
    }
    const actions = target.timeMachineAgent!.listActions();
    expect(actions).toHaveLength(70);
    expect(actions.filter(row => !(SHELL_UI_ACTIONS as readonly string[]).includes(row.id))).toHaveLength(64);
    for (const id of SHELL_UI_ACTIONS) expect(actions.some(row => row.id === id), id).toBe(true);
    expect(actions.some(row => ids.includes(row.id))).toBe(false);
    expect(api().catalog.list({ idPrefix: "raster.", kind: "query" }).map(row => row.id)).toEqual(["raster.sample"]);
  });

  it.each(ids)("rejects reserved %s with no transport, state mutation or fabricated job", async id => {
    const fetch = vi.fn(() => { throw new Error("No reserved transport exists"); });
    vi.stubGlobal("fetch", fetch);
    const before = registry.agentActions.getState();
    for (const result of [await api().execute(id, {}), await api().query(id, {})]) {
      expect(result).toMatchObject({ ok: false, status: "failed", error: { kind: "not-implemented", code: "NOT_IMPLEMENTED", retryable: false } });
      expect(result).not.toHaveProperty("data");
      expect(result).not.toHaveProperty("jobId");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(registry.agentActions.getState()).toEqual(before);
  });

  it("keeps unfrozen request and result shapes descriptive instead of claiming executable contracts", async () => {
    for (const id of ids) {
      const descriptor = await api().catalog.describe(id);
      expect(descriptor, id).toBeDefined();
      expect(descriptor!.description, id).toContain("03-p2-p3-implementation.md");
      expect(descriptor!.description, id).toContain("metadata only");
      expect(descriptor).not.toHaveProperty("invocation");
      expect(descriptor!.inputSchema.type, id).toBeUndefined();
      expect(descriptor!.outputSchema.type, id).toBeUndefined();
      expect(descriptor!.inputSchema.description, id).toEqual(expect.any(String));
      expect(descriptor!.outputSchema.description, id).toEqual(expect.any(String));
      expect(descriptor!.examples, id).toEqual([]);
    }
    const sample = (await api().catalog.describe("raster.sample"))!;
    expect(sample.effect).toBe("read");
    expect(sample.requirements).toContain("P3-06-original-value-source");
    expect(sample.description).toContain("RGBA");
    expect(sample.outputSchema.description).toContain("NoData is not zero");
  });

  it("keeps new details lazy and returns independent descriptions", async () => {
    let loaded = 0;
    vi.doMock("../agent-actions/reserved-catalog", async importOriginal => {
      loaded++;
      return importOriginal<typeof import("../agent-actions/reserved-catalog")>();
    });
    api().catalog.list();
    await api().execute("viewport.create");
    await api().query("raster.sample");
    expect(loaded).toBe(0);
    const first = await api().catalog.describe("model.bind");
    expect(first).toBeDefined();
    expect(loaded).toBe(1);
    Reflect.set(first!.requirements, 0, "caller-mutated");
    first!.inputSchema.description = "caller-mutated";
    const second = await api().catalog.describe("model.bind");
    expect(second!.requirements).not.toContain("caller-mutated");
    expect(second!.inputSchema.description).not.toBe("caller-mutated");
    expect(loaded).toBe(1);
  });

  it("lets a real registered command supersede the reserved metadata without duplicate or v1 divergence", async () => {
    expect(await api().execute("viewport.activate")).toMatchObject({ error: { kind: "not-implemented" } });
    let active = "main";
    registry.agentActions.register({ id: "viewport.activate", title: "Actual viewport activation", description: "Actual adapter", status: "ready", params: [{ name: "viewportId", type: "string", required: true, description: "Existing viewport" }] }, input => {
      active = input.viewportId as string;
      return { data: { viewportId: active } };
    });
    registry.agentActions.setContract("viewport.activate", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "state-committed", requirements: [] });
    expect(api().catalog.list().filter(row => row.id === "viewport.activate")).toHaveLength(1);
    expect(await api().catalog.describe("viewport.activate")).toMatchObject({ availability: "ready", description: "Actual adapter" });
    expect(await api().execute("viewport.activate", { viewportId: "A" })).toMatchObject({ status: "completed", data: { viewportId: "A" } });
    expect(active).toBe("A");
    expect(await target.timeMachineAgent!.execute("viewport.activate", { viewportId: "B" })).toMatchObject({ ok: true, data: { viewportId: "B" } });
    expect(active).toBe("B");
  });

  it("preserves existing queries and helpers rather than reserving an overlapping ID", async () => {
    registry.agentActions.registerStateSection("ui", () => ({ selectedLayerId: 3 }));
    registry.agentActions.registerStateSection("project", () => ({ name: "Synthetic project" }));
    for (const id of ["scene.snapshot", "ui.snapshot", "project.snapshot"]) {
      expect(await api().query(id)).toMatchObject({ ok: true, status: "completed" });
      expect(await api().execute(id)).toMatchObject({ error: { kind: "validation" } });
    }
    expect(api().catalog.list({ kind: "service", idPrefix: "service." })).toHaveLength(4);
    for (const id of ["catalog.list", "catalog.describe", "jobs.get", "jobs.wait", "jobs.cancel", "logs.query", "logs.export", "logs.clear", "events.subscribe"]) {
      expect(await api().execute(id)).toMatchObject({ error: { kind: "validation", message: expect.stringContaining("direct facade") } });
    }
    expect(await api().execute("raster.edit")).toMatchObject({ error: { kind: "validation" } });
    expect(await api().catalog.describe("raster.edit")).toBeUndefined();
  });
});
