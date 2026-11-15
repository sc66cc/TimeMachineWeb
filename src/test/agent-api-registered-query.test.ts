import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActionHandler } from "../agent-actions/types";
import type { ApiContractDetails, ApiContractMetadata, AppEvent } from "../agent-actions/contracts";

let registry: typeof import("../agent-actions/registry");
let operation: typeof import("../agent-actions/operation");
let target: Window;
const api = () => target.timeMachineAgent!.v2;
const metadata: ApiContractMetadata = { kind: "query", scope: "p0-p3", effect: "read", completion: "state-committed", requirements: [] };
const details: ApiContractDetails = {
  inputSchema: { type: "object", additionalProperties: false, required: ["key"], properties: { key: { type: "string", minLength: 1 } } },
  outputSchema: { type: "object", additionalProperties: true }, examples: [],
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function register(id: string, handler?: AgentActionHandler, load: () => Promise<ApiContractDetails> = async () => details) {
  registry.agentActions.register({ id, title: "Synthetic read", description: "Read a synthetic fixture", status: "ready", params: [] }, handler);
  registry.agentActions.setContract(id, metadata, load);
}

beforeEach(async () => {
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  operation = await import("../agent-actions/operation");
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(() => { registry.agentActions.disposeStateObservers(); vi.unstubAllGlobals(); });

describe("registered query dispatch through existing handlers", () => {
  it("invokes a real registered read while execute refuses its query kind", async () => {
    const records = new Map([["sample", { count: 3 }]]);
    let calls = 0;
    register("feature.attributes", (input, context) => {
      calls++;
      return { data: { record: records.get(input.key as string), trace: context?.traceId, jobId: context?.jobId } };
    });
    expect(await api().execute("feature.attributes", { key: "sample" })).toMatchObject({ error: { kind: "validation" } });
    expect(calls).toBe(0);
    const result = await api().query("feature.attributes", { key: "sample" });
    expect(result).toMatchObject({ ok: true, status: "completed", data: { record: { count: 3 } } });
    expect(result).not.toHaveProperty("jobId");
    if (!result.ok || result.status !== "completed") throw new Error("Expected read completion");
    expect(result.data).toMatchObject({ trace: result.traceId });
    expect(calls).toBe(1);
    expect(api().catalog.list().filter(row => row.id === "feature.attributes")).toHaveLength(1);
  });

  it("validates input before invoking the handler or starting side effects", async () => {
    let calls = 0;
    register("fixture.read", () => { calls++; return { data: { count: 1 } }; });
    for (const input of [null, [], {}, { key: "" }, { key: 3 }, { key: "sample", extra: true }, { key: () => "sample" }]) {
      expect(await api().query("fixture.read", input)).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    expect(calls).toBe(0);
    expect(await api().query("fixture.read", { key: "sample" })).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });

  it("captures nested caller input before lazy schema loading and redacts independent results", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const row = { count: 4, password: "synthetic-result-password" };
    let seen: unknown;
    register("fixture.clone", input => { seen = input; return { data: { row, echoed: input } }; }, async () => {
      await gate;
      return { ...details, inputSchema: { type: "object", properties: { nested: { type: "object", properties: { value: { type: "number" }, password: { type: "string" } }, required: ["value", "password"], additionalProperties: false } }, required: ["nested"], additionalProperties: false } };
    });
    const input = { nested: { value: 2, password: "synthetic-input-password" } };
    const pending = api().query("fixture.clone", input);
    input.nested.value = 99;
    release();
    const result = await pending;
    expect(seen).toEqual({ nested: { value: 2, password: "synthetic-input-password" } });
    expect(result).toMatchObject({ ok: true, data: { row: { count: 4, password: "[redacted]" }, echoed: { nested: { value: 2, password: "[redacted]" } } } });
    if (!result.ok || result.status !== "completed") throw new Error("Expected read completion");
    Reflect.set((result.data as { row: object }).row, "count", 99);
    expect(row.count).toBe(4);
    expect(JSON.stringify(result)).not.toContain("synthetic-");
  });

  it("waits for the actual read and logs only its trace and terminal status", async () => {
    let complete!: () => void;
    register("fixture.delayed", () => new Promise(resolve => { complete = () => resolve({ data: { value: "synthetic-private-body" } }); }));
    let done = false;
    const pending = api().query("fixture.delayed", { key: "synthetic-input" }).then(result => { done = true; return result; });
    await flush();
    expect(done).toBe(false);
    expect(api().logs.query().entries.filter(entry => entry.event === "query.started")).toHaveLength(1);
    expect(api().logs.query().entries.some(entry => entry.event === "query.completed")).toBe(false);
    complete();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, status: "completed" });
    const log = api().logs.query({ traceId: result.traceId });
    expect(log.entries.map(entry => entry.event)).toEqual(["query.started", "query.completed"]);
    expect(log.entries.every(entry => entry.actionId === "fixture.delayed")).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/synthetic-private-body|synthetic-input/);
  });

  it.each(["validation", "busy", "unsupported", "auth", "internal"] as const)("preserves the %s read failure classification", async kind => {
    register("fixture.failure", () => { throw new registry.AgentActionFailureError(kind, "Synthetic read failed"); });
    const result = await api().query("fixture.failure", { key: "sample" });
    expect(result).toMatchObject({ ok: false, status: "failed", error: { kind, code: kind.toUpperCase() } });
    expect(api().logs.query({ traceId: result.traceId }).entries.at(-1)).toMatchObject({ event: "query.failed", outcome: "failed", errorCode: kind.toUpperCase() });
  });

  it.each(["cancelled", "superseded"] as const)("keeps %s as a structured read terminal outcome without a job", async reason => {
    register("fixture.interrupted", () => { throw new operation.OperationInterruptedError(reason); });
    const result = await api().query("fixture.interrupted", { key: "sample" });
    expect(result).toMatchObject({ ok: false, status: reason, error: { kind: reason, code: reason.toUpperCase() } });
    expect(result).not.toHaveProperty("jobId");
    expect(api().logs.query({ traceId: result.traceId }).entries.at(-1)).toMatchObject({ event: `query.${reason}`, outcome: reason });
  });

  it("redacts unlabelled input secrets from handler and lazy loader failures", async () => {
    const secret = "synthetic-private-query-password";
    const input = { password: secret };
    const schema: ApiContractDetails = { ...details, inputSchema: { type: "object", properties: { password: { type: "string" } } } };
    register("fixture.error", () => { throw new Error(`Rejected ${secret}`); }, async () => schema);
    register("fixture.loader-error", () => ({ data: {} }), async () => { throw new Error(`Cannot read ${secret}`); });
    for (const id of ["fixture.error", "fixture.loader-error"]) {
      const result = await api().query(id, input);
      expect(result).toMatchObject({ ok: false, error: { kind: "internal" } });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(api().logs.query({ traceId: result.traceId }))).not.toContain(secret);
    }
  });

  it.each(["remove", "replace", "kind", "availability", "schema"] as const)("rechecks a %s change during lazy description before any handler can run", async change => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let oldCalls = 0, newCalls = 0, allowed = true;
    const id = "fixture.changing";
    register(id, () => { oldCalls++; return { data: {} }; }, async () => { await gate; return details; });
    registry.agentActions.setAvailability(id, () => allowed ? undefined : "Unavailable now");
    const pending = api().query(id, { key: "sample" });
    await flush();
    if (change === "remove" || change === "replace") registry.agentActions.register({ id, title: "Replacement", description: "Replacement", status: "ready", params: [] }, change === "replace" ? () => { newCalls++; return { data: {} }; } : undefined);
    if (change === "kind") registry.agentActions.setContract(id, { ...metadata, kind: "command" });
    if (change === "availability") allowed = false;
    if (change === "schema") registry.agentActions.setContract(id, metadata, async () => ({ ...details, inputSchema: { type: "object", required: ["differentKey"] } }));
    release();
    expect(await pending).toMatchObject({ ok: false, error: { kind: change === "remove" ? "not-implemented" : change === "kind" ? "validation" : change === "availability" ? "unsupported" : "superseded" } });
    expect(oldCalls).toBe(0);
    expect(newCalls).toBe(0);
  });

  it("does not perform action completion observation, create jobs or emit frame events for a read", async () => {
    let stateReads = 0;
    registry.agentActions.registerStateSection("project", () => { stateReads++; return { name: "Synthetic project" }; });
    await flush();
    const before = await api().query("project.snapshot");
    await flush();
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    register("fixture.observe", () => ({ data: { count: 1 } }));
    // Even accidental command-style job/frame metadata cannot turn a query into a mutation completion.
    registry.agentActions.setContract("fixture.observe", { ...metadata, execution: "job", completion: "frame-committed" });
    const readsBefore = stateReads;
    const fetch = vi.fn(() => { throw new Error("Unexpected cloud operation"); });
    vi.stubGlobal("fetch", fetch);
    const result = await api().query("fixture.observe");
    await flush();
    expect(result).toMatchObject({ ok: true, status: "completed", revision: before.ok && before.status === "completed" ? before.revision : undefined });
    expect(result).not.toHaveProperty("jobId");
    expect(stateReads).toBe(readsBefore);
    expect(events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a non-read query effect and a query handler asking to reload", async () => {
    let calls = 0;
    register("fixture.write", () => { calls++; return { data: {} }; });
    registry.agentActions.setContract("fixture.write", { ...metadata, effect: "remote-write" });
    expect(await api().query("fixture.write")).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(calls).toBe(0);
    register("fixture.reload", () => ({ reloadRequired: true }));
    expect(await api().query("fixture.reload", { key: "sample" })).toMatchObject({ ok: false, error: { kind: "internal" } });
  });

  it("distinguishes a declared unavailable query from unknown IDs and existing reserved entries", async () => {
    register("fixture.no-handler");
    expect(await api().query("fixture.no-handler")).toMatchObject({ error: { kind: "not-implemented" } });
    expect(await api().query("missing.query")).toMatchObject({ error: { kind: "validation" } });
    expect(await api().query("raster.sample")).toMatchObject({ error: { kind: "not-implemented", code: "NOT_IMPLEMENTED" } });
    expect(await api().query("logs.query")).toMatchObject({ error: { kind: "validation", message: expect.stringContaining("direct facade") } });
    registry.agentActions.registerStateSection("ui", () => ({ tab: "layers" }));
    expect(await api().query("scene.snapshot")).toMatchObject({ ok: true });
    expect(await api().query("ui.snapshot")).toMatchObject({ ok: true, data: { tab: "layers" } });
  });

  it("does not execute a query that replaced a command while execute awaited its schema", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    register("fixture.route-change", () => { calls++; return { data: { count: 1 } }; });
    registry.agentActions.setContract("fixture.route-change", { ...metadata, kind: "command" }, async () => { await gate; return details; });
    const pending = api().execute("fixture.route-change", { key: "sample" });
    await flush();
    registry.agentActions.setContract("fixture.route-change", metadata, async () => details);
    release();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(calls).toBe(0);
    expect(await api().query("fixture.route-change", { key: "sample" })).toMatchObject({ ok: true, data: { count: 1 } });
    expect(calls).toBe(1);
  });
});
