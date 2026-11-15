import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateApiInput } from "../agent-actions/contracts";

let registry: typeof import("../agent-actions/registry");
let target: Window;
beforeEach(async () => {
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(() => {
  registry.agentActions.disposeStateObservers();
  vi.useRealTimers();
});
const api = () => target.timeMachineAgent!.v2;
const helperIds = ["catalog.describe", "catalog.list", "events.subscribe", "jobs.cancel", "jobs.get", "jobs.wait", "logs.clear", "logs.export", "logs.query"];

describe("direct facade helpers are discoverable without a second execution route", () => {
  it("lists all nine existing helpers once, retaining event and v1 command catalogs", () => {
    const rows = api().catalog.list();
    for (const id of helperIds) {
      expect(rows.filter(row => row.id === id), id).toHaveLength(1);
      expect(rows.find(row => row.id === id), id).toMatchObject({ availability: "ready", invocation: { channel: "direct", method: id } });
    }
    expect(api().catalog.list({ kind: "event" }).map(row => row.id)).toEqual(["frame.committed", "job.changed", "state.changed"]);
    expect(api().catalog.list({ idPrefix: "logs.", kind: "query" }).map(row => row.id)).toEqual(["logs.export", "logs.query"]);
    expect(target.timeMachineAgent!.listActions().some(row => helperIds.includes(row.id))).toBe(false);
  });

  it("describes positional arguments, direct return kinds and local effects", async () => {
    const expected = [
      ["catalog.list", ["filter"], false, "json", "read"],
      ["catalog.describe", ["id"], true, "json-or-undefined", "read"],
      ["jobs.get", ["jobId"], false, "json-or-undefined", "read"],
      ["jobs.wait", ["jobId", "options"], true, "json", "read"],
      ["jobs.cancel", ["jobId"], true, "json", "ui-local"],
      ["logs.query", ["filter"], false, "json", "read"],
      ["logs.export", ["filter"], false, "blob", "read"],
      ["logs.clear", [], false, "void", "ui-local"],
      ["events.subscribe", ["filter", "listener"], false, "unsubscribe", "ui-local"],
    ] as const;
    for (const [id, args, asynchronous, returns, effect] of expected) {
      const entry = await api().catalog.describe(id);
      expect(entry, id).toMatchObject({ effect, requirements: ["same-document-facade"], invocation: { channel: "direct", method: id, asynchronous, returns } });
      expect(entry!.invocation!.arguments.map(arg => arg.name)).toEqual(args);
      expect(entry!.description).toContain("No additional login");
    }
    const subscribe = (await api().catalog.describe("events.subscribe"))!;
    expect(subscribe.invocation!.arguments[1]).toMatchObject({ name: "listener", kind: "callback" });
    expect(subscribe.inputSchema.properties).not.toHaveProperty("listener");
    expect(subscribe.outputSchema.type).toBeUndefined();
    expect((await api().catalog.describe("logs.clear"))!.outputSchema.type).toBeUndefined();
  });

  it("documents actual job snapshots, bounded waiting and owner-confirmed cancellation", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const accepted = registry.agentActions.jobs.start("test.catalog.job", "trace-catalog", true,
      () => new Promise(resolve => { finish = () => resolve({ ok: true, status: "completed", traceId: "trace-catalog", revision: 2 }); }), () => {});
    if (!accepted.ok || accepted.status !== "accepted") throw new Error("Job setup failed");
    await Promise.resolve();
    const get = (await api().catalog.describe("jobs.get"))!;
    expect(get).toBeDefined();
    expect(validateApiInput(get.outputSchema, api().jobs.get(accepted.jobId))).toBeUndefined();
    expect(api().jobs.get("missing")).toBeUndefined();
    const wait = (await api().catalog.describe("jobs.wait"))!;
    expect(wait.inputSchema.properties?.options?.properties?.timeoutMs).toMatchObject({ type: "number", exclusiveMinimum: 0, maximum: 2_147_483_647 });
    expect(wait.description).toContain("30000");
    const waiting = api().jobs.wait(accepted.jobId);
    await vi.advanceTimersByTimeAsync(30000);
    const timedOut = await waiting;
    expect(timedOut).toMatchObject({ status: "unknown", jobId: accepted.jobId, error: { code: "TIMEOUT" } });
    expect(validateApiInput(wait.outputSchema, timedOut)).toBeUndefined();
    expect(api().jobs.get(accepted.jobId)?.status).toBe("running");
    expect(await api().jobs.cancel(accepted.jobId)).toMatchObject({ status: "accepted", jobId: accepted.jobId });
    expect(api().jobs.get(accepted.jobId)).toMatchObject({ status: "running", cancellationRequested: true });
    finish();
    expect(await api().jobs.wait(accepted.jobId)).toMatchObject({ status: "completed", revision: 2 });
    expect(await api().jobs.cancel(accepted.jobId)).toMatchObject({ status: "completed" });
  });

  it("describes log pagination, all-retained export and non-download Blob truthfully", async () => {
    for (let i = 0; i < 205; i++) registry.agentActions.diagnostics.record({ level: "info", category: "app", event: "catalog.fixture" });
    const query = (await api().catalog.describe("logs.query"))!;
    expect(query).toBeDefined();
    expect(query.inputSchema.properties?.filter?.properties?.limit).toMatchObject({ type: "number" });
    expect(query.description).toContain("floor");
    const page = api().logs.query();
    expect(page.entries).toHaveLength(100);
    expect(validateApiInput(query.outputSchema, page)).toBeUndefined();
    expect(api().logs.query({ limit: 999 }).entries).toHaveLength(200);
    expect(api().logs.query({ limit: 0 }).entries).toHaveLength(1);
    const exportEntry = (await api().catalog.describe("logs.export"))!;
    expect(exportEntry.description).toContain("all retained matches");
    const blob = api().logs.export();
    expect(blob.type).toBe("application/x-ndjson");
    expect((await blob.text()).trim().split("\n")).toHaveLength(206);
    const lastSequence = api().logs.query({ afterSequence: 204 }).entries[0]!.sequence;
    expect(api().logs.clear()).toBeUndefined();
    registry.agentActions.diagnostics.record({ level: "info", category: "app", event: "catalog.after-clear" });
    expect(api().logs.query().entries[0]!.sequence).toBeGreaterThan(lastSequence);
  });

  it("rejects dispatching helper IDs through execute/query without performing their effects", async () => {
    registry.agentActions.diagnostics.record({ level: "info", category: "app", event: "catalog.keep-me" });
    for (const id of helperIds) {
      expect(await api().execute(id, {}), id).toMatchObject({ ok: false, error: { kind: "validation", message: expect.stringContaining("direct facade") } });
      expect(await api().query(id, {}), id).toMatchObject({ ok: false, error: { kind: "validation", message: expect.stringContaining("direct facade") } });
    }
    expect(api().logs.query().entries.some(row => row.event === "catalog.keep-me")).toBe(true);
    expect(api().catalog.list({ idPrefix: "logs.clear" })[0]).toMatchObject({ kind: "command", invocation: { channel: "direct" } });
  });

  it("returns independent contract copies and reflects event stream closure", async () => {
    const first = (await api().catalog.describe("jobs.wait"))!;
    expect(first).toBeDefined();
    first.inputSchema.properties!.options!.properties!.timeoutMs!.maximum = 1;
    first.invocation!.arguments[0]!.name = "changed";
    const again = (await api().catalog.describe("jobs.wait"))!;
    expect(again.inputSchema.properties!.options!.properties!.timeoutMs!.maximum).toBe(2_147_483_647);
    expect(again.invocation!.arguments[0]!.name).toBe("jobId");
    const stop = api().events.subscribe({}, () => {});
    stop(); stop();
    registry.agentActions.disposeStateObservers();
    expect((await api().catalog.describe("events.subscribe"))!.availability).toBe("unavailable");
    expect(() => api().events.subscribe({}, () => {})).toThrow("closed");
    expect(api().catalog.list({ idPrefix: "jobs." }).every(row => row.availability === "ready")).toBe(true);
    expect(api().jobs.get("old-page-job")).toBeUndefined();
  });
});
