import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../agent-actions/contracts";
import type { OperationContext } from "../agent-actions/operation";

let registry: typeof import("../agent-actions/registry");
let OperationInterruptedError: typeof import("../agent-actions/operation").OperationInterruptedError;
let target: Window;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  ({ OperationInterruptedError } = await import("../agent-actions/operation"));
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(() => { registry.agentActions.disposeStateObservers(); vi.useRealTimers(); });
const api = () => target.timeMachineAgent!.v2;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function register(handler: (context: OperationContext) => Promise<Record<string, unknown>>, cancellable = true) {
  registry.agentActions.register({ id: "test.job", title: "Fixture job", description: "", status: "ready", params: [] },
    async (_params, context) => ({ data: await handler(context!) }));
  registry.agentActions.setContract("test.job", {
    kind: "command", scope: "p0-p3", effect: "project-local", completion: "frame-committed",
    execution: "job", cancellationSupported: cancellable, requirements: [],
  });
}
async function accepted() {
  const result = await api().execute("test.job", {}, { completion: "accepted" });
  expect(result).toMatchObject({ ok: true, status: "accepted", jobId: expect.any(String) });
  if (!result.ok || result.status !== "accepted") throw new Error("Fixture job was not accepted.");
  return result;
}

describe("real asynchronous operation completion", () => {
  it("waits for point loading but does not claim a frame for selection-only requests", async () => {
    const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
    const frame = deferred();
    registry.agentActions.register(AGENT_DECLARATIONS["points.load"], async () => {
      await frame.promise;
      return { data: { datasetId: "points-a", loaded: true, frameConfirmed: true } };
    });
    registry.agentActions.register(AGENT_DECLARATIONS["points.selectDataset"], async params => ({
      data: { datasetId: params.datasetId, loaded: false, frameConfirmed: false },
    }));
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => { events.push(event); });
    const selected = await api().execute("points.selectDataset", { datasetId: "points-b", load: false });
    expect(selected).toMatchObject({ ok: true, status: "completed", data: { frameConfirmed: false } });
    expect(await api().catalog.describe("points.selectDataset")).toMatchObject({ execution: "job", completion: "state-committed", cancellationSupported: true });
    const started = await api().execute("points.load", {}, { completion: "accepted" });
    expect(started).toMatchObject({ ok: true, status: "accepted" });
    if (!started.ok || started.status !== "accepted") throw new Error("Point job was not accepted.");
    expect(api().jobs.get(started.jobId)).toMatchObject({ status: "running" });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(event => event.type === "frame.committed")).toHaveLength(0);
    frame.resolve();
    expect(await api().jobs.wait(started.jobId)).toMatchObject({ status: "completed", data: { frameConfirmed: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(event => event.type === "frame.committed")).toEqual([expect.objectContaining({ actionId: "points.load" })]);
  });
  it("runs the time action as a frame job and keeps cancellation tied to that request", async () => {
    const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
    const rendered = deferred();
    registry.agentActions.register(AGENT_DECLARATIONS["time.set"], async (params, context) => {
      await Promise.race([
        rendered.promise,
        new Promise<never>((_resolve, reject) => context!.signal!.addEventListener("abort", () => reject(new OperationInterruptedError("cancelled")), { once: true })),
      ]);
      return { data: { committedAgeMa: params.ageMa } };
    });
    const first = await api().execute("time.set", { ageMa: 100 }, { completion: "accepted" });
    expect(first).toMatchObject({ ok: true, status: "accepted", jobId: expect.any(String) });
    expect(api().jobs.get(first.jobId!)).toMatchObject({ status: "running" });
    await api().jobs.cancel(first.jobId!);
    expect(await api().jobs.wait(first.jobId!)).toMatchObject({ status: "cancelled" });
    const second = await api().execute("time.set", { ageMa: 200 }, { completion: "accepted" });
    rendered.resolve();
    expect(await api().jobs.wait(second.jobId!)).toMatchObject({ status: "completed", data: { committedAgeMa: 200 } });
    expect(api().jobs.get(first.jobId!)).toMatchObject({ status: "cancelled" });
  });

  it("exposes camera reset as a cancellable frame job", async () => {
    const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
    registry.agentActions.register(AGENT_DECLARATIONS["camera.reset"], async (_params, context) => {
      await new Promise<void>(resolve => context!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new OperationInterruptedError("cancelled");
    });
    const result = await api().execute("camera.reset", {}, { completion: "accepted" });
    expect(result).toMatchObject({ ok: true, status: "accepted", jobId: expect.any(String) });
    expect(await api().catalog.describe("camera.reset")).toMatchObject({ execution: "job", completion: "frame-committed", cancellationSupported: true });
    await api().jobs.cancel(result.jobId!);
    expect(await api().jobs.wait(result.jobId!)).toMatchObject({ status: "cancelled" });
  });

  it("accepts raster selection as a cancellable job and publishes completion only after its owner resolves", async () => {
    const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
    const frame = deferred();
    registry.agentActions.register(AGENT_DECLARATIONS["raster.select"], async params => {
      await frame.promise;
      return { data: { rasterId: params.rasterId, selection: {
        generation: 1, requestedRasterId: params.rasterId, status: "hidden", reason: "disabled",
      } } };
    });
    const started = await api().execute("raster.select", { rasterId: "synthetic-raster" }, { completion: "accepted" });
    expect(started).toMatchObject({ ok: true, status: "accepted", jobId: expect.any(String) });
    if (!started.ok || started.status !== "accepted") throw new Error("Raster job was not accepted.");
    expect(api().jobs.get(started.jobId)).toMatchObject({ status: "running", cancellationSupported: true });
    frame.resolve();
    expect(await api().jobs.wait(started.jobId)).toMatchObject({ status: "completed", data: {
      rasterId: "synthetic-raster", selection: { status: "hidden", reason: "disabled" },
    } });
    const descriptor = await api().catalog.describe("raster.select");
    expect(descriptor?.outputSchema.properties?.selection?.properties?.status?.enum).toEqual(["ready", "hidden"]);
    expect(descriptor?.outputSchema.properties?.selection?.required).toEqual(["generation", "requestedRasterId", "status"]);
  });

  it("accepts once and lets late waiters read the same committed result", async () => {
    const frame = deferred(); let calls = 0; let context!: OperationContext;
    register(async ctx => { calls++; context = ctx; await frame.promise; return { committedAgeMa: 100 }; });
    const started = await accepted();
    expect(Object.isFrozen(api().jobs)).toBe(true);
    expect(api().jobs.get(started.jobId)).toMatchObject({ status: "running", traceId: started.traceId, cancellationSupported: true });
    expect(context).toMatchObject({ traceId: started.traceId, jobId: started.jobId });
    expect(api().logs.query({ traceId: started.traceId }).entries.map(e => e.event)).toEqual(["action.started", "job.accepted"]);
    const waiting = api().jobs.wait(started.jobId);
    frame.resolve();
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, status: "completed", jobId: started.jobId, data: { committedAgeMa: 100 } });
    expect(await api().jobs.wait(started.jobId)).toEqual(result);
    expect(calls).toBe(1);
    expect(api().jobs.get(started.jobId)).toMatchObject({ status: "completed", result });
    expect(api().logs.query({ traceId: started.traceId }).entries.map(e => e.event)).toEqual(["action.started", "job.accepted", "action.completed"]);
  });

  it("a committed wait timeout preserves the running job and never aborts or resubmits it", async () => {
    const frame = deferred(); let calls = 0; let signal!: AbortSignal;
    register(async ctx => { calls++; signal = ctx.signal!; await frame.promise; return { committed: true }; });
    const waiting = api().execute("test.job", {}, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const timeout = await waiting;
    expect(timeout).toMatchObject({ ok: false, status: "unknown", error: { kind: "timeout" }, jobId: expect.any(String) });
    expect(signal.aborted).toBe(false);
    expect(api().jobs.get(timeout.jobId!)).toMatchObject({ status: "running" });
    expect(api().logs.query({ traceId: timeout.traceId }).entries.map(e => e.event)).toEqual(["action.started", "job.accepted"]);
    frame.resolve();
    expect(await api().jobs.wait(timeout.jobId!)).toMatchObject({ ok: true, status: "completed" });
    expect(calls).toBe(1);
  });

  it.each(["execute", "wait"] as const)("bounds a default %s wait at 30 seconds without stopping the owner", async mode => {
    const frame = deferred(); let signal!: AbortSignal; let calls = 0;
    register(async ctx => { calls++; signal = ctx.signal!; await frame.promise; return { committed: true }; });
    const start = mode === "wait" ? await accepted() : undefined;
    let settled = false;
    const waiting = (start ? api().jobs.wait(start.jobId) : api().execute("test.job"))
      .then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const timeout = await waiting;
    expect(timeout).toMatchObject({ status: "unknown", error: { kind: "timeout" }, jobId: expect.any(String) });
    expect(api().jobs.get(timeout.jobId!)?.status).toBe("running");
    expect(signal.aborted).toBe(false);
    expect(api().logs.query({ traceId: timeout.traceId }).entries.map(e => e.event)).toEqual(["action.started", "job.accepted"]);
    frame.resolve();
    expect(await api().jobs.wait(timeout.jobId!)).toMatchObject({ status: "completed" });
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an explicit finite wait override the default without leaking its timer", async () => {
    const frame = deferred(); register(async () => { await frame.promise; return {}; });
    const start = await accepted(); let settled = false;
    const waiting = api().jobs.wait(start.jobId, { timeoutMs: 60_000 }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    frame.resolve();
    expect(await waiting).toMatchObject({ status: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel requests stop the actual owner and only settle after cleanup acknowledges it", async () => {
    const cleanup = deferred(); let signal!: AbortSignal;
    register(async ctx => {
      signal = ctx.signal!;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup.promise;
      throw new OperationInterruptedError("cancelled");
    });
    const start = await accepted();
    expect(await api().jobs.cancel(start.jobId)).toMatchObject({ ok: true, status: "accepted", jobId: start.jobId });
    expect(signal.aborted).toBe(true);
    expect(api().jobs.get(start.jobId)).toMatchObject({ status: "running", cancellationRequested: true });
    cleanup.resolve();
    const result = await api().jobs.wait(start.jobId);
    expect(result).toMatchObject({ ok: false, status: "cancelled", error: { kind: "cancelled" } });
    expect(await api().jobs.cancel(start.jobId)).toEqual(result);
    expect(api().logs.query({ traceId: start.traceId }).entries.map(e => e.event)).toEqual(["action.started", "job.accepted", "action.cancelled"]);
  });

  it("keeps superseded separate from cancellation and leaves v1's busy shape compatible", async () => {
    register(async () => { throw new OperationInterruptedError("superseded"); });
    expect(await api().execute("test.job")).toMatchObject({ ok: false, status: "superseded", error: { kind: "superseded" } });
    expect(await target.timeMachineAgent!.execute("test.job")).toMatchObject({ actionId: "test.job", ok: false, error: { kind: "busy", code: 409 } });
  });

  it("refuses unsupported cancellation without pretending a remote operation stopped", async () => {
    const frame = deferred(); let signal: AbortSignal | undefined;
    register(async ctx => { signal = ctx.signal; await frame.promise; return {}; }, false);
    const start = await accepted();
    expect(await api().jobs.cancel(start.jobId)).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(signal?.aborted ?? false).toBe(false);
    expect(api().jobs.get(start.jobId)?.status).toBe("running");
    frame.resolve();
    expect((await api().jobs.wait(start.jobId)).ok).toBe(true);
  });

  it("bounds running jobs before side effects, then reuses freed capacity", async () => {
    const frame = deferred(); let calls = 0;
    register(async () => { calls++; await frame.promise; return {}; });
    const events: AppEvent[] = [];
    api().events.subscribe({ types: ["job.changed"] }, event => events.push(event));
    const starts = await Promise.all(Array.from({ length: 8 }, accepted));
    expect(await api().execute("test.job", {}, { completion: "accepted" })).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(calls).toBe(8);
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(8);
    expect(events.every(event => event.type === "job.changed" && event.phase === "accepted")).toBe(true);
    frame.resolve();
    await Promise.all(starts.map(s => api().jobs.wait(s.jobId)));
    expect((await api().execute("test.job")).ok).toBe(true);
    expect(calls).toBe(9);
  });

  it("returns copies, expires completed records and rejects a prior document's identity", async () => {
    register(async () => ({ count: 1, token: "synthetic-secret" }));
    const done = await api().execute("test.job");
    expect(done).toMatchObject({ ok: true, data: { token: "[redacted]" }, jobId: expect.any(String) });
    const snapshot = api().jobs.get(done.jobId!)!;
    snapshot.status = "failed";
    expect(api().jobs.get(done.jobId!)?.status).toBe("completed");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret");
    expect(api().jobs.get("old-boot:job-1")).toBeUndefined();
    expect(await api().jobs.wait("old-boot:job-1")).toMatchObject({ ok: false, error: { kind: "expired-job" } });
    await vi.advanceTimersByTimeAsync(300001);
    expect(api().jobs.get(done.jobId!)).toBeUndefined();
    expect(await api().jobs.cancel(done.jobId!)).toMatchObject({ ok: false, error: { kind: "expired-job" } });
  });

  it("bounds waiters and invalid wait options without altering the running operation", async () => {
    const frame = deferred(); register(async () => { await frame.promise; return {}; });
    const start = await accepted();
    expect(await api().jobs.wait(start.jobId, { timeoutMs: -1 })).toMatchObject({ ok: false, error: { kind: "validation" } });
    const waiters = Array.from({ length: 128 }, () => api().jobs.wait(start.jobId));
    expect(await api().jobs.wait(start.jobId)).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(api().jobs.get(start.jobId)?.status).toBe("running");
    frame.resolve();
    expect((await Promise.all(waiters)).every(result => result.ok)).toBe(true);
  });

  it("keeps at most 128 terminal records and bounds retained result bodies", async () => {
    register(async () => ({ text: "x".repeat(100_000) }));
    const oversized = await api().execute("test.job");
    expect(oversized).toMatchObject({ ok: true, status: "completed", dataTruncated: true });
    expect(oversized).not.toHaveProperty("data");
    register(async () => ({ count: 1 }));
    for (let i = 0; i < 128; i++) expect((await api().execute("test.job")).ok).toBe(true);
    expect(api().jobs.get(oversized.jobId!)).toBeUndefined();
  });

  it("disposal releases waiters, removes old ids and prevents a late success from being logged", async () => {
    const frame = deferred(); register(async () => { await frame.promise; return {}; });
    const start = await accepted();
    const waiter = api().jobs.wait(start.jobId);
    registry.agentActions.disposeStateObservers();
    expect(await waiter).toMatchObject({ ok: false, status: "unknown", error: { kind: "runtime-disposed" } });
    expect(api().jobs.get(start.jobId)).toBeUndefined();
    frame.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(api().logs.query({ traceId: start.traceId }).entries.some(e => e.event === "action.completed")).toBe(false);
  });

  it("does not start a queued business side effect after its document has closed", async () => {
    const { OperationJobs } = await import("../agent-actions/jobs");
    const jobs = new OperationJobs("fixture-boot"); let calls = 0;
    jobs.start("fixture", "trace", true, async () => {
      calls++; return { ok: true, status: "completed", traceId: "trace" };
    }, () => {});
    jobs.close();
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(0);
  });

  it("captures caller input before accepted execution yields to later caller mutations", async () => {
    const frame = deferred();
    register(async () => ({}));
    registry.agentActions.register({ id: "test.job", title: "Fixture", description: "", status: "ready", params: [{ name: "value", type: "object", description: "" }] }, async (params) => {
      await frame.promise;
      return { data: { value: params.value } };
    });
    const input = { value: { ageMa: 100 } };
    const start = await api().execute("test.job", input, { completion: "accepted" });
    input.value.ageMa = 200;
    frame.resolve();
    expect(await api().jobs.wait(start.jobId!)).toMatchObject({ data: { value: { ageMa: 100 } } });
  });

  it("captures input before the first lazy-schema await", async () => {
    const schema = deferred();
    register(async () => ({}));
    registry.agentActions.register({ id: "test.job", title: "Fixture", description: "", status: "ready", params: [{ name: "ageMa", type: "number", description: "" }] }, async params => ({ data: { ageMa: params.ageMa } }));
    registry.agentActions.setContract("test.job", { kind: "command", scope: "p0-p3", effect: "project-local", completion: "frame-committed", execution: "job", requirements: [] }, async () => {
      await schema.promise;
      return { inputSchema: { type: "object", properties: { ageMa: { type: "number" } } }, outputSchema: { type: "object" }, examples: [] };
    });
    const input = { ageMa: 100 };
    const result = api().execute("test.job", input);
    input.ageMa = 200;
    schema.resolve();
    expect(await result).toMatchObject({ data: { ageMa: 100 } });
  });

  it("diagnostic payload limits never turn acknowledged cancellation or completion into business failure", async () => {
    const { OperationJobs } = await import("../agent-actions/jobs");
    const jobs = new OperationJobs("fixture-boot");
    const cancelled = jobs.start("fixture", "trace-cancel", true, async () => ({
      ok: false, status: "cancelled", traceId: "trace-cancel", error: { kind: "cancelled", code: "CANCELLED", message: "x".repeat(100_000), retryable: false },
    }), () => {});
    expect(await jobs.wait(cancelled.jobId!)).toMatchObject({ ok: false, status: "cancelled", error: { kind: "cancelled" } });
    expect(JSON.stringify(jobs.get(cancelled.jobId!)).length).toBeLessThan(65_536);
    const completed = jobs.start("fixture", "trace-done", true, async () => ({
      ok: true, status: "completed", traceId: "trace-done", data: { nonJsonValue: 1n },
    }), () => {});
    expect(await jobs.wait(completed.jobId!)).toMatchObject({ ok: true, status: "completed", dataTruncated: true });
  });

  it("observes and isolates rejected terminal callbacks while settling the real result", async () => {
    const { OperationJobs } = await import("../agent-actions/jobs");
    const jobs = new OperationJobs("fixture-boot"); let observed = false;
    const started = jobs.start("fixture", "trace", true, async () => ({ ok: true, status: "completed", traceId: "trace" }), () => ({
      then(_resolve: unknown, reject: (error: Error) => void) { observed = true; reject(new Error("synthetic observer failure")); },
    }));
    expect(await jobs.wait(started.jobId!)).toMatchObject({ ok: true, status: "completed" });
    await Promise.resolve(); await Promise.resolve();
    expect(observed).toBe(true);
  });
});


describe("operation event completion boundaries", () => {
  it.each(["inline", "job"] as const)("retains the %s operation's committed revision when state changes before event delivery", async execution => {
    let value = 0;
    registry.agentActions.registerStateSection("ui", () => ({ value }));
    register(async () => { value++; return {}; });
    registry.agentActions.setContract("test.job", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "frame-committed", execution, requirements: [] });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    const result = await api().execute("test.job");
    if (!result.ok || result.status !== "completed") throw new Error("Expected a committed fixture operation.");
    value++;
    registry.agentActions.notifyStateChanged("ui");
    const later = await api().query("ui.snapshot");
    expect(later.ok && later.revision).toBeGreaterThan(result.revision!);
    await vi.runOnlyPendingTimersAsync();
    const frames = events.filter(event => event.type === "frame.committed");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ revision: result.revision, traceId: result.traceId });
    if (execution === "inline") {
      expect(frames[0]).not.toHaveProperty("jobId");
      expect(events.filter(event => event.type === "job.changed")).toEqual([]);
    } else expect(frames[0]).toHaveProperty("jobId", result.jobId);
  });

  it("emits accepted, actual terminal, and a frame only after the owner commits", async () => {
    const frame = deferred();
    register(async () => { await frame.promise; return { body: "synthetic-private-body", url: "https://invalid.example/?token=synthetic-secret" }; });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    const start = await accepted();
    await vi.runOnlyPendingTimersAsync();
    expect(events).toEqual([expect.objectContaining({ type: "job.changed", phase: "accepted", status: "running", jobId: start.jobId, traceId: start.traceId, actionId: "test.job" })]);
    frame.resolve();
    const result = await api().jobs.wait(start.jobId);
    await vi.runOnlyPendingTimersAsync();
    expect(events.map(event => event.type)).toEqual(["job.changed", "job.changed", "frame.committed"]);
    expect(events[1]).toMatchObject({ phase: "terminal", status: "completed", jobId: start.jobId });
    expect(events[2]).toMatchObject({ traceId: start.traceId, jobId: start.jobId, actionId: "test.job", revision: result.ok ? result.revision : -1 });
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(events)).not.toMatch(/synthetic|https|body|token/);
    await api().jobs.wait(start.jobId);
    await api().jobs.cancel(start.jobId);
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(3);
  });

  it("does not turn a wait timeout or cancellation request into a terminal event", async () => {
    const cleanup = deferred();
    register(async () => { await cleanup.promise; throw new OperationInterruptedError("cancelled"); });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    const start = await accepted();
    const wait = api().jobs.wait(start.jobId, { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await wait).toMatchObject({ status: "unknown" });
    await api().jobs.cancel(start.jobId);
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "job.changed", phase: "accepted", status: "running" });
    expect(api().jobs.get(start.jobId)?.status).toBe("running");
    cleanup.resolve();
    await api().jobs.wait(start.jobId);
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "job.changed", phase: "terminal", status: "cancelled" });
  });

  it.each(["failed", "superseded", "unknown"] as const)("never emits a frame for a %s owner", async status => {
    register(async () => { if (status === "superseded") throw new OperationInterruptedError(status); throw new Error("synthetic-private-error"); });
    if (status === "unknown") registry.agentActions.register({ id: "test.job", title: "Fixture", description: "", status: "ready", params: [] }, () => ({ reloadRequired: true }));
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    expect(await api().execute("test.job")).toMatchObject({ status });
    await vi.runOnlyPendingTimersAsync();
    expect(events.map(event => event.type)).toEqual(["job.changed", "job.changed"]);
    expect(events[1]).toMatchObject({ phase: "terminal", status });
    expect(JSON.stringify(events)).not.toContain("synthetic-private-error");
  });

  it("suppresses pending and late events after disposal without manufacturing cancellation", async () => {
    const frame = deferred(); register(async () => { await frame.promise; return {}; });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    const start = await accepted();
    registry.agentActions.disposeStateObservers();
    frame.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(events).toEqual([]);
    expect(api().jobs.get(start.jobId)).toBeUndefined();
  });

  it.each(["v1", "v2"] as const)("captures the %s completion contract before an asynchronous handler can change it", async version => {
    const frame = deferred(); register(async () => { await frame.promise; return {}; });
    registry.agentActions.setContract("test.job", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "state-committed", execution: "job", requirements: [] });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    const waiting = version === "v1" ? target.timeMachineAgent!.execute("test.job") : api().execute("test.job");
    await Promise.resolve();
    registry.agentActions.setContract("test.job", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "frame-committed", execution: "job", requirements: [] });
    frame.resolve();
    expect((await waiting).ok).toBe(true);
    await vi.runOnlyPendingTimersAsync();
    expect(events.some(event => event.type === "frame.committed")).toBe(false);
    expect(events.filter(event => event.type === "job.changed")).toHaveLength(version === "v2" ? 2 : 0);
  });

  it("emits a verified v1/UI frame with no fake job and omits failed, unverified and reload outcomes", async () => {
    register(async () => ({ body: "synthetic-private-body" }));
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    expect(await target.timeMachineAgent!.execute("test.job")).toMatchObject({ ok: true });
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "frame.committed", actionId: "test.job", traceId: expect.any(String), revision: expect.any(Number) });
    expect(events[0]).not.toHaveProperty("jobId");
    register(async () => { throw new Error("synthetic-private-error"); });
    await target.timeMachineAgent!.execute("test.job");
    registry.agentActions.register({ id: "test.job", title: "Fixture", description: "", status: "ready", params: [] }, () => ({ reloadRequired: true }));
    await target.timeMachineAgent!.execute("test.job");
    registry.agentActions.setContract("test.job", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "unverified", requirements: [] });
    await target.timeMachineAgent!.execute("test.job");
    await api().execute("test.job");
    const { AGENT_DECLARATIONS } = await import("../agent-actions/actions");
    registry.agentActions.register(AGENT_DECLARATIONS["time.set"], () => ({}));
    await target.timeMachineAgent!.execute("time.set", { timeMa: 100 });
    await api().execute("time.set", { timeMa: 100 });
    await api().execute("token=synthetic-private-id");
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
  });

  it("bounds delayed operation events and advertises dropped notifications without affecting jobs", async () => {
    register(async () => ({}));
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    let latestJobId = "";
    for (let i = 0; i < 100; i++) latestJobId = (await api().execute("test.job")).jobId!;
    expect(events).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(256);
    expect(events[0]).toHaveProperty("droppedCount", 44);
    expect(events.at(-1)).toMatchObject({ type: "frame.committed", jobId: latestJobId });
    expect(await api().jobs.wait(latestJobId)).toMatchObject({ status: "completed" });
  });
});
