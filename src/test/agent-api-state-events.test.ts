import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../agent-actions/contracts";

let registry: typeof import("../agent-actions/registry");
let target: Window;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  target = {} as Window;
  registry.installAgentActions(target);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const api = () => target.timeMachineAgent!.v2;

describe("authoritative v2 state and event observations", () => {
  it("separates requested and committed frames and returns independent snapshots", async () => {
    expect(api().query).toBeTypeOf("function");
    const state = { requestedTimeMa: 0, committedTimeMa: 0, status: "ready", camera: { width: 40 } };
    registry.agentActions.registerStateSection("projection", () => state);
    const first = await api().query("scene.snapshot");
    expect(first).toMatchObject({ ok: true, data: { projection: { committedTimeMa: 0 } } });
    state.requestedTimeMa = 100;
    state.status = "preparing";
    registry.agentActions.notifyStateChanged("projection");
    const pending = await api().query("scene.snapshot");
    expect(pending).toMatchObject({ ok: true, data: { projection: { requestedTimeMa: 100, committedTimeMa: 0, status: "preparing" } } });
    if (!first.ok || !pending.ok) throw new Error("snapshot unavailable");
    expect(pending.revision).toBeGreaterThan(first.revision!);
    const copy = pending.data as { projection: typeof state };
    copy.projection.camera.width = 999;
    expect((await api().query("scene.snapshot"))).toMatchObject({ data: { projection: { camera: { width: 40 } } } });
    state.committedTimeMa = 100;
    state.status = "ready";
    registry.agentActions.notifyStateChanged("projection");
    expect(await api().query("scene.snapshot")).toMatchObject({ data: { projection: { committedTimeMa: 100, status: "ready" } } });
  });

  it("keeps queries read-only and rejects unknown IDs and undeclared inputs", async () => {
    registry.agentActions.registerStateSection("ui", () => ({ busy: false }));
    let writes = 0;
    registry.agentActions.register({ id: "test.write", title: "Write", description: "", params: [], status: "ready" }, () => ({ data: { writes: ++writes } }));
    expect(await api().query("test.write")).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await api().query("unknown.snapshot")).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await api().query("ui.snapshot", { password: "synthetic-value" })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(writes).toBe(0);
    expect(api().catalog.list({ kind: "query" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scene.snapshot", effect: "read", availability: "ready" }),
      expect.objectContaining({ id: "ui.snapshot", effect: "read", availability: "ready" }),
      expect.objectContaining({ id: "project.snapshot", availability: "unavailable" }),
    ]));
    expect(await api().catalog.describe("ui.snapshot")).toMatchObject({ kind: "query", inputSchema: { additionalProperties: false } });
    expect(await api().execute("ui.snapshot")).toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it("coalesces changed sections and supports subscribe-before-query with monotonic revisions", async () => {
    const state = { activeSidebarTab: "layers", busy: false };
    registry.agentActions.registerStateSection("ui", () => state);
    await vi.runOnlyPendingTimersAsync();
    const events: AppEvent[] = [];
    const stop = api().events.subscribe({ types: ["state.changed"], sections: ["ui"] }, event => events.push(event));
    const before = await api().query("ui.snapshot");
    state.busy = true;
    registry.agentActions.notifyStateChanged("ui");
    state.activeSidebarTab = "plate-models";
    registry.agentActions.notifyStateChanged("ui");
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    const after = await api().query("ui.snapshot");
    if (!before.ok || !after.ok) throw new Error("snapshot unavailable");
    expect(events[0]).toMatchObject({ type: "state.changed", bootId: target.timeMachineAgent!.getState().bootId, sections: ["ui"], revision: after.revision });
    expect(events[0]!.revision).toBeGreaterThan(before.revision!);
    registry.agentActions.notifyStateChanged("ui");
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    stop();
    state.busy = false;
    registry.agentActions.notifyStateChanged("ui");
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
  });

  it("isolates listener failures, copies event payloads, and respects section filters", async () => {
    let value = 0;
    registry.agentActions.registerStateSection("ui", () => ({ value }));
    await vi.runOnlyPendingTimersAsync();
    const received: AppEvent[] = [];
    let wrongSectionDeliveries = 0;
    api().events.subscribe({}, event => { if (event.type === "state.changed") event.sections.push("injected"); throw new Error("listener failure"); });
    api().events.subscribe({ sections: ["project"] }, () => { wrongSectionDeliveries++; });
    api().events.subscribe({}, event => received.push(event));
    value++;
    registry.agentActions.notifyStateChanged("ui");
    await vi.runOnlyPendingTimersAsync();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sections: ["ui"] });
    expect(wrongSectionDeliveries).toBe(0);
    value++;
    registry.agentActions.notifyStateChanged("ui");
    await vi.runOnlyPendingTimersAsync();
    expect(received[1]!.sequence).toBeGreaterThan(received[0]!.sequence);
  });

  it("unregisters only the provider it owns and does not expose removed UI state", async () => {
    const removeOld = registry.agentActions.registerStateSection("ui", () => ({ label: "old" }));
    const removeNew = registry.agentActions.registerStateSection("ui", () => ({ label: "new" }));
    removeOld();
    expect(await api().query("ui.snapshot")).toMatchObject({ ok: true, data: { label: "new" } });
    removeNew();
    removeNew();
    expect(await api().query("ui.snapshot")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(target.timeMachineAgent!.getState()).not.toHaveProperty("ui");
  });

  it("redacts state and provider failures without treating a broken provider as a successful query", async () => {
    registry.agentActions.registerStateSection("ui", () => ({ error: "token=synthetic-secret", password: "synthetic-secret" }));
    const safe = await api().query("ui.snapshot");
    expect(JSON.stringify(safe)).not.toContain("synthetic-secret");
    registry.agentActions.registerStateSection("ui", () => { throw new Error("provider failed token=synthetic-secret"); });
    const broken = await api().query("ui.snapshot");
    expect(broken).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify(broken)).not.toContain("synthetic-secret");
  });

  it("reports changes from the shared command handler without inventing commits for rejected input", async () => {
    let value = 0;
    registry.agentActions.registerStateSection("ui", () => ({ value }));
    registry.agentActions.register({ id: "test.set", title: "set", description: "", status: "ready", params: [{ name: "value", type: "number", required: true, description: "" }] }, params => { value = params.value as number; return { data: { value } }; });
    registry.agentActions.setContract("test.set", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "state-committed", requirements: [] });
    const before = await api().query("ui.snapshot");
    const invalid = await api().execute("test.set", { value: "bad" });
    expect(invalid.ok).toBe(false);
    const unchanged = await api().query("ui.snapshot");
    expect(unchanged.ok && unchanged.revision).toBe(before.ok && before.revision);
    const changed = await api().execute("test.set", { value: 3 });
    const after = await api().query("ui.snapshot");
    expect(after).toMatchObject({ ok: true, data: { value: 3 } });
    expect(changed.ok && changed.revision).toBe(after.ok && after.revision);
    expect(changed.ok && changed.revision).toBeGreaterThan(before.ok ? before.revision! : -1);
  });

  it("bounds live subscribers and releases them on a real page lifecycle end", async () => {
    expect(() => api().events.subscribe({ types: ["not-a-real-event"] }, () => {})).toThrow();
    const stops: Array<() => void> = [];
    for (let i = 0; i < 128; i++) stops.push(api().events.subscribe({}, () => {}));
    expect(() => api().events.subscribe({}, () => {})).toThrow(/limit/i);
    stops[0]!();
    expect(() => api().events.subscribe({}, () => {})).not.toThrow();
    registry.agentActions.disposeStateObservers();
    expect(() => api().events.subscribe({}, () => {})).toThrow(/closed/i);
  });

  it("observes legacy commands and failure cleanup without waiting for a query to discover changes", async () => {
    let busy = false;
    registry.agentActions.registerStateSection("ui", () => ({ busy }));
    registry.agentActions.register({ id: "test.legacy", title: "legacy", description: "", status: "ready", params: [] }, () => { busy = true; return {}; });
    const received: AppEvent[] = [];
    api().events.subscribe({ sections: ["ui"] }, event => received.push(event));
    await target.timeMachineAgent!.execute("test.legacy");
    await vi.runOnlyPendingTimersAsync();
    expect(received).toHaveLength(1);
    registry.agentActions.register({ id: "test.cleanup", title: "cleanup", description: "", status: "ready", params: [] }, () => { busy = false; throw new Error("failed after cleanup"); });
    expect((await target.timeMachineAgent!.execute("test.cleanup")).ok).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(received).toHaveLength(2);
  });

  it("contains non-serializable provider failures and never exports executable references", async () => {
    registry.agentActions.registerStateSection("ui", () => ({ label: "safe", mutate: () => "private" }));
    expect(target.timeMachineAgent!.getState().ui).not.toHaveProperty("mutate");
    expect(() => registry.agentActions.registerStateSection("ui", () => ({ unsupported: 1n }))).not.toThrow();
    expect(await api().query("ui.snapshot")).toMatchObject({ ok: false, error: { kind: "internal" } });
    registry.agentActions.register({ id: "test.safe", title: "safe", description: "", status: "ready", params: [] }, () => ({ data: { ran: true } }));
    expect(await target.timeMachineAgent!.execute("test.safe")).toMatchObject({ ok: true, data: { ran: true } });
  });
});


describe("bounded operation event observers", () => {
  function registerFrame() {
    registry.agentActions.register({ id: "test.frame", title: "frame", description: "", status: "ready", params: [] }, () => ({}));
    registry.agentActions.setContract("test.frame", { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "frame-committed", requirements: [] });
  }

  it("isolates asynchronous failures and mutation, snapshots filters and honors unsubscribe during dispatch", async () => {
    registerFrame();
    const seen: AppEvent[] = [];
    const filter = { types: ["frame.committed"] };
    api().events.subscribe(filter, async event => { if (event.type === "frame.committed") event.traceId = "mutated"; throw new Error("observer rejection"); });
    filter.types[0] = "state.changed";
    let removeLater = () => {};
    api().events.subscribe({}, () => removeLater());
    const removed = vi.fn();
    removeLater = api().events.subscribe({}, removed);
    api().events.subscribe({ types: ["frame.committed"] }, event => seen.push(event));
    const sectionOnly = vi.fn();
    api().events.subscribe({ sections: ["ui"] }, sectionOnly);
    await target.timeMachineAgent!.execute("test.frame");
    await vi.runOnlyPendingTimersAsync();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatchObject({ traceId: "mutated" });
    expect(removed).not.toHaveBeenCalled();
    expect(sectionOnly).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps coalesced state trace-free when two operations share its turn", async () => {
    let value = 0;
    registry.agentActions.registerStateSection("ui", () => ({ value }));
    registerFrame();
    registry.agentActions.register({ id: "test.frame", title: "frame", description: "", status: "ready", params: [] }, () => { value++; return {}; });
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    await target.timeMachineAgent!.execute("test.frame");
    await target.timeMachineAgent!.execute("test.frame");
    await vi.runOnlyPendingTimersAsync();
    const changed = events.filter(event => event.type === "state.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).not.toHaveProperty("traceId");
    expect(changed[0]).not.toHaveProperty("jobId");
    const frames = events.filter(event => event.type === "frame.committed");
    expect(frames).toHaveLength(2);
    expect(frames[0]!.traceId).not.toBe(frames[1]!.traceId);
    expect(changed[0]!.revision).toBe(frames[1]!.revision);
  });

  it("bounds merged invalidation churn and exposes overflow for authoritative requery", async () => {
    const events: AppEvent[] = [];
    api().events.subscribe({}, event => events.push(event));
    for (let i = 0; i < 70; i++) registry.agentActions.registerStateSection(`section${i}`, () => ({ present: true }))();
    await vi.runOnlyPendingTimersAsync();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "state.changed", droppedCount: 12 });
    if (events[0]!.type !== "state.changed") throw new Error("Expected state invalidation.");
    expect(events[0]!.sections).toHaveLength(64);
    expect((await api().query("scene.snapshot"))).toMatchObject({ ok: true });
  });

  it("yields reentrant events to another turn and close suppresses the remainder of a queued batch", async () => {
    registerFrame();
    const seen: AppEvent[] = [];
    api().events.subscribe({}, event => {
      seen.push(event);
      if (seen.length === 1) void target.timeMachineAgent!.execute("test.frame");
    });
    await target.timeMachineAgent!.execute("test.frame");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    api().events.subscribe({}, () => registry.agentActions.disposeStateObservers());
    const afterClose = vi.fn();
    api().events.subscribe({}, afterClose);
    await target.timeMachineAgent!.execute("test.frame");
    await vi.runOnlyPendingTimersAsync();
    expect(seen).toHaveLength(2);
    expect(afterClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(api().catalog.list({ kind: "event" }).every(event => event.availability === "unavailable")).toBe(true);
  });
});
