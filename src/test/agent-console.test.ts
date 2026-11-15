import { afterEach, describe, expect, it } from "vitest";
import { AGENT_ACTIONS, AGENT_DECLARATIONS, agentActions, installAgentActions } from "../agent-actions";
import { parseConsoleCommand, runConsoleCommand, summarizeConsoleValue } from "../agent-actions/console-command";
import { OperationInterruptedError } from "../agent-actions/operation";
import { ProjectSession } from "../project/project-session";

const target = {} as Window;
installAgentActions(target);
const api = target.timeMachineAgent!.v2;
afterEach(() => { agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet]); });

describe("development console commands", () => {
  it("parses only the documented command grammar and never echoes invalid input", () => {
    expect(parseConsoleCommand('time.set {"ageMa":110}')).toMatchObject({ kind: "execute", id: "time.set", input: { ageMa: 110 } });
    for (const line of ['', 'window.alert(1)', 'query', 'jobs stop abc', 'catalog a b', 'time.set []', 'time.set {"password":"synthetic-value"']) {
      expect(() => parseConsoleCommand(line)).toThrow();
      try { parseConsoleCommand(line); } catch (error) { expect(String(error)).not.toContain("synthetic-value"); }
    }
    const longInput = "x".repeat(16_385);
    expect(parseConsoleCommand(`project.setName ${JSON.stringify({ name: longInput })}`).input.name).toBe(longInput);
  });

  it("executes through the real facade and exposes actual job acceptance, waiting and logs", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let committedAge = 0;
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], async params => {
      await gate; committedAge = params.ageMa as number; return { data: { committedAge } };
    });
    const accepted = await runConsoleCommand(parseConsoleCommand('time.set {"ageMa":110}'), api);
    const result = JSON.parse(accepted.output);
    expect(result).toMatchObject({ ok: true, status: "accepted" }); expect(committedAge).toBe(0);
    expect(JSON.parse((await runConsoleCommand(parseConsoleCommand(`jobs get ${result.jobId}`), api)).output).status).toBe("running");
    const waiting = runConsoleCommand(parseConsoleCommand(`jobs wait ${result.jobId}`), api);
    release();
    expect(JSON.parse((await waiting).output)).toMatchObject({ ok: true, status: "completed", data: { committedAge: 110 } });
    expect(committedAge).toBe(110);
    const logs = JSON.parse((await runConsoleCommand(parseConsoleCommand(`logs {"traceId":"${result.traceId}"}`), api)).output);
    expect(logs.entries.some((entry: { traceId: string }) => entry.traceId === result.traceId)).toBe(true);
  });

  it("keeps actual cancellation and unknown job errors visible", async () => {
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], (_params, context) => new Promise((_resolve, reject) => {
      context!.signal!.addEventListener("abort", () => reject(new OperationInterruptedError("cancelled")), { once: true });
    }));
    const accepted = JSON.parse((await runConsoleCommand(parseConsoleCommand('time.set {"ageMa":110}'), api)).output);
    const cancel = await runConsoleCommand(parseConsoleCommand(`jobs cancel ${accepted.jobId}`), api);
    expect(JSON.parse(cancel.output)).toMatchObject({ ok: true });
    const terminal = await runConsoleCommand(parseConsoleCommand(`jobs wait ${accepted.jobId}`), api);
    expect(JSON.parse(terminal.output)).toMatchObject({ ok: false, status: "cancelled" });
    expect(terminal.failed).toBe(true);
    expect(await runConsoleCommand(parseConsoleCommand("jobs get missing-job"), api)).toMatchObject({ failed: true });
  });

  it("shows real directory availability and query failures", async () => {
    const catalog = JSON.parse((await runConsoleCommand(parseConsoleCommand("catalog"), api)).output);
    expect(catalog.some((entry: { availability: string }) => entry.availability === "not-implemented")).toBe(true);
    expect(catalog.some((entry: { id: string }) => entry.id === "time.set")).toBe(true);
    const reserved = catalog.find((entry: { kind: string; availability: string }) => entry.kind === "command" && entry.availability === "not-implemented");
    expect(JSON.parse((await runConsoleCommand(parseConsoleCommand(reserved.id), api)).output)).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    expect(await runConsoleCommand(parseConsoleCommand("catalog unknown.operation"), api)).toMatchObject({ failed: true });
    const failed = await runConsoleCommand(parseConsoleCommand("query missing.snapshot"), api);
    expect(JSON.parse(failed.output)).toMatchObject({ ok: false, status: "failed", error: { kind: "validation" } });
    const session = new ProjectSession("Console query");
    const detach = agentActions.registerStateSection("project", () => ({ ...session.toSnapshot() }));
    try {
      const snapshot = JSON.parse((await runConsoleCommand(parseConsoleCommand("query project.snapshot"), api)).output);
      expect(snapshot).toMatchObject({ ok: true, data: { name: "Console query" } });
    } finally { detach(); }
  });

  it("uses existing redaction for credentials and URLs without extra result clipping", () => {
    const command = parseConsoleCommand('auth.login {"password":"synthetic-password","nested":{"api_key":"synthetic-key"},"name":"demo"}');
    expect(command.summary).not.toContain("synthetic-password"); expect(command.summary).not.toContain("synthetic-key");
    const output = summarizeConsoleValue({ message: "synthetic-password https://example.test/private?token=abc Bearer abc", token: "synthetic-token", items: Array.from({ length: 1000 }, () => "x".repeat(1000)) }, command.input);
    expect(output).not.toContain("synthetic-password"); expect(output).not.toContain("synthetic-token");
    expect(output).not.toContain("example.test"); expect(output).not.toContain("Bearer abc");
    expect(JSON.parse(output).items).toHaveLength(1000);
    expect(JSON.parse(output).items[999]).toBe("x".repeat(1000));
    expect(summarizeConsoleValue({ error: '{"password":"synthetic-json-secret"}', url: '/private?token=synthetic-query-secret' })).not.toContain("synthetic-");
    expect(parseConsoleCommand("jobs get eyJsynthetic.value.signature").summary).not.toContain("eyJsynthetic");
    expect(Object.keys(JSON.parse(summarizeConsoleValue(Object.fromEntries(Array.from({ length: 70 }, (_, index) => [String(index), index])))))).toHaveLength(70);
  });

  it("preserves the API pointStyle and complete nested catalog schema without a second depth cut", async () => {
    const session = new ProjectSession("Console depth regression");
    const detach = agentActions.registerStateSection("project", () => ({ ...session.toSnapshot() }));
    try {
      const direct = JSON.parse(JSON.stringify(await api.query("project.snapshot")));
      const expectedStyle = direct.data.layers.find((layer: { id: number }) => layer.id === 2).pointStyle;
      expect(expectedStyle).toMatchObject({ pointSize: expect.any(Number), filter: "[truncated]" });
      const displayed = JSON.parse((await runConsoleCommand(parseConsoleCommand("query project.snapshot"), api)).output);
      expect(displayed.data.layers.find((layer: { id: number }) => layer.id === 2).pointStyle).toEqual(expectedStyle);
      const descriptor = await api.catalog.describe("logs.query");
      const displayedDescriptor = JSON.parse((await runConsoleCommand(parseConsoleCommand("catalog logs.query"), api)).output);
      expect(displayedDescriptor.inputSchema).toEqual(descriptor!.inputSchema);
      expect(displayedDescriptor.inputSchema.properties.filter.properties.level.enum).toContain("error");
    } finally { detach(); }
  });

  it("keeps deep input history fields while redacting their sensitive siblings", () => {
    const command = parseConsoleCommand('layer.setStyle {"layerId":2,"style":{"filter":{"rules":[{"minimumOccurrence":5,"password":"synthetic-deep-secret"}]}}}');
    const stored = JSON.parse(command.summary.slice(command.summary.indexOf(" ") + 1));
    expect(stored.style.filter.rules[0]).toEqual({ minimumOccurrence: 5, password: "[redacted]" });
    expect(command.summary).not.toContain("synthetic-deep-secret");
  });

  it("validates log filters and reports an unavailable facade", async () => {
    expect(await runConsoleCommand(parseConsoleCommand('logs {"unknown":true}'), api)).toMatchObject({ failed: true, output: expect.stringContaining("filter") });
    expect(await runConsoleCommand(parseConsoleCommand('logs {"limit":"invalid"}'), api)).toMatchObject({ failed: true });
    expect(await runConsoleCommand(parseConsoleCommand('logs {"limit":0}'), api)).toMatchObject({ failed: false });
    expect(await runConsoleCommand(parseConsoleCommand("catalog"), undefined)).toMatchObject({ failed: true, output: expect.stringContaining("unavailable") });
    expect(await runConsoleCommand(parseConsoleCommand("help"), undefined)).toMatchObject({ failed: false, output: expect.stringContaining("jobs cancel") });
  });
});
