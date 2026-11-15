import { beforeEach, describe, expect, it, vi } from "vitest";

let registry: typeof import("../agent-actions/registry");
let target: Window;
beforeEach(async () => {
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  target = {} as Window;
  registry.installAgentActions(target);
});
const api = () => target.timeMachineAgent!.v2;
function register(id: string, handler: () => Promise<{ data?: Record<string, unknown> }>) {
  registry.agentActions.register({ id, title: "test", description: "", status: "ready", params: [{ name: "password", type: "string", description: "", required: false }] }, handler);
  registry.agentActions.setContract(id, { kind: "command", scope: "p0-p3", effect: "ui-local", completion: "state-committed", requirements: [] });
}

describe("facade diagnostics use each operation's explicit trace", () => {
  it("records concurrent starts and real completions without copying request or result bodies", async () => {
    expect(api().logs).toBeDefined();
    const release: Array<() => void> = [];
    register("test.wait", () => new Promise(resolve => release.push(() => resolve({ data: { privateBody: "synthetic-secret-body" } }))));
    const first = api().execute("test.wait", { password: "synthetic-private-password" });
    const second = api().execute("test.wait", { password: "synthetic-private-password" });
    for (let i = 0; i < 8 && release.length < 2; i++) await Promise.resolve();
    expect(release).toHaveLength(2);
    expect(api().logs.query().entries.filter(row => row.event === "action.completed")).toHaveLength(0);
    release[1]!();
    const b = await second;
    release[0]!();
    const a = await first;
    expect(a.traceId).not.toBe(b.traceId);
    for (const traceId of [a.traceId, b.traceId]) {
      const page = api().logs.query({ traceId });
      expect(page.entries.map(row => row.event)).toEqual(["action.started", "action.completed"]);
      expect(page.entries.every(row => row.actionId === "test.wait")).toBe(true);
    }
    expect(JSON.stringify(api().logs.query())).not.toMatch(/synthetic-secret-body|synthetic-private-password/);
  });

  it("records failures safely and exposes a bounded diagnostic Blob that can be cleared", async () => {
    register("test.failure", async () => { throw new Error("Rejected synthetic-private-password"); });
    const result = await api().execute("test.failure", { password: "synthetic-private-password" });
    expect(result.ok).toBe(false);
    const entries = api().logs.query({ traceId: result.traceId }).entries;
    expect(entries.map(row => row.event)).toEqual(["action.started", "action.failed"]);
    const content = await api().logs.export().text();
    expect(content).toContain("diagnostic-summary");
    expect(content).toContain("action.failed");
    expect(content).not.toContain("synthetic-private-password");
    api().logs.clear();
    expect(api().logs.query().retainedCount).toBe(0);
    expect(Object.isFrozen(api().logs)).toBe(true);
  });

  it("logs the legacy handler once while preserving its v1 result shape", async () => {
    register("test.legacy-log", async () => ({ data: { count: 1 } }));
    const result = await target.timeMachineAgent!.execute("test.legacy-log");
    expect(result).toEqual({ actionId: "test.legacy-log", ok: true, reloadRequired: false, data: { count: 1 } });
    const entries = api().logs.query().entries;
    expect(entries.map(row => row.event)).toEqual(["action.started", "action.completed"]);
    expect(entries[0]?.traceId).toBe(entries[1]?.traceId);
  });

  it("does not upgrade an unverified legacy return or an unknown v2 outcome to definite completion", async () => {
    register("test.unverified", async () => ({ data: { launched: true } }));
    registry.agentActions.setContract("test.unverified", { kind: "command", scope: "p0-p3", effect: "project-local", completion: "unverified", requirements: [] });
    expect((await target.timeMachineAgent!.execute("test.unverified")).ok).toBe(true);
    expect(api().logs.query().entries.at(-1)).toMatchObject({ event: "action.returned", outcome: "unknown" });
    registry.agentActions.register({ id: "test.reload", title: "reload", description: "", status: "ready", params: [] }, () => ({ reloadRequired: true }));
    registry.agentActions.setContract("test.reload", { kind: "command", scope: "p0-p3", effect: "project-local", completion: "state-committed", requirements: [] });
    const unknown = await api().execute("test.reload");
    expect(unknown).toMatchObject({ ok: false, status: "unknown" });
    expect(api().logs.query({ traceId: unknown.traceId }).entries.at(-1)).toMatchObject({ event: "action.unknown", outcome: "unknown" });
  });
});
