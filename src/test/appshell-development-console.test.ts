// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { AGENT_ACTIONS, AGENT_DECLARATIONS, agentActions, installAgentActions } from "../agent-actions";
import { OperationInterruptedError } from "../agent-actions/operation";
import { ProjectSession, LOCAL_PROJECT_DRAFT_KEY } from "../project/project-session";
import { registerProjectLocalActions } from "../project/project-actions";
import { mountAppShell } from "./support/mount-app-shell";

let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
afterEach(() => {
  mounted?.unmount(); mounted = undefined;
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet]);
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.projectSaveLocal]);
});
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing console control: ${selector}`); return node;
}
async function settle(): Promise<void> { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount(): Promise<void> {
  mounted = await mountAppShell(); installAgentActions(window);
  element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await nextTick();
}
async function enter(line: string): Promise<void> {
  const input = element<HTMLInputElement>('[aria-label="Console command"]');
  input.value = line; input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
}
const output = () => element<HTMLTextAreaElement>('[aria-label="Console output"]').value;

describe("AppShell development console", () => {
  it("saves a real ProjectSession through v2, preserves output across close and allows copying", async () => {
    await mount();
    const nativeTimeline = document.getElementById("timeline-slider");
    const session = new ProjectSession("Saved from console");
    registerProjectLocalActions(session, { storage: window.localStorage, capture() {}, publish() {}, downloadOriginal() {} });
    await enter("project.saveLocal");
    await vi.waitFor(() => expect(output()).toContain('"status": "completed"'));
    expect(JSON.parse(window.localStorage.getItem(LOCAL_PROJECT_DRAFT_KEY)!)).toMatchObject({ name: "Saved from console" });
    expect(output()).toContain('"ok": true'); expect(output()).toContain('"status": "completed"'); expect(output()).toContain('"traceId"');
    const savedOutput = output();
    element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await nextTick();
    expect(element<HTMLElement>('[aria-label="Development console"]').style.display).toBe("none");
    element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await nextTick();
    expect(output()).toBe(savedOutput); expect(document.getElementById("timeline-slider")).toBe(nativeTimeline);
    element<HTMLButtonElement>('[data-ui-local="console.selectOutput"]').click();
    const textarea = element<HTMLTextAreaElement>('[aria-label="Console output"]');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(0); expect(textarea.selectionEnd).toBe(textarea.value.length);
    expect([...element<HTMLElement>('[data-testid="development-console"]').querySelectorAll("button")].every(button => button.hasAttribute("data-ui-local") && !button.hasAttribute("data-action"))).toBe(true);
  });

  it("keeps a real pending wait observable while a cancellation command can run", async () => {
    await mount();
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], (_params, context) => new Promise((_resolve, reject) => {
      context!.signal!.addEventListener("abort", () => reject(new OperationInterruptedError("cancelled")), { once: true });
    }));
    await enter('time.set {"ageMa":110}');
    await vi.waitFor(() => expect(output()).toContain('"status": "accepted"'));
    const jobId = output().match(/"jobId": "([^"]+)"/)![1]!;
    await enter(`jobs wait ${jobId}`); expect(output()).toContain("[pending]");
    expect(element<HTMLInputElement>('[aria-label="Console command"]').disabled).toBe(false);
    await enter(`jobs cancel ${jobId}`); await settle();
    await vi.waitFor(() => expect(output()).not.toContain("[pending]"));
    expect(output()).toContain('"status": "cancelled"'); expect(output()).not.toContain("[pending]");
  });

  it("clears raw input, keeps redacted history until explicitly cleared and surfaces failures", async () => {
    await mount();
    const previousStored = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.getItem(window.localStorage.key(index)!));
    await enter('auth.login {"password":"synthetic-console-secret","token":"synthetic-console-token"}');
    expect(element<HTMLInputElement>('[aria-label="Console command"]').value).toBe("");
    expect(output()).not.toContain("synthetic-console-secret"); expect(output()).not.toContain("synthetic-console-token");
    expect(output()).toContain("[redacted]"); expect(output()).toContain("[failed]");
    await enter('auth.login {"password":"invalid-json-secret"');
    expect(output()).toContain("Invalid JSON"); expect(output()).not.toContain("invalid-json-secret");
    expect(Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.getItem(window.localStorage.key(index)!))).toEqual(previousStored);
    for (let i = 0; i < 45; i++) await enter("help");
    expect(output().match(/> help/g)).toHaveLength(45);
    expect(output()).toContain("Invalid JSON");
    expect(element<HTMLElement>('[data-testid="console-history-status"]').textContent).toContain("47 entries");
    element<HTMLButtonElement>('[data-ui-local="console.clear"]').click(); await nextTick(); expect(output()).toBe("");
  });

  it("executes a command entered in the same tick and in a later tick", async () => {
    await mount();
    const inputElement = element<HTMLInputElement>('[aria-label="Console command"]');
    // Same tick: input -> keydown Enter before Vue can flush anything.
    inputElement.value = "help";
    inputElement.dispatchEvent(new Event("input", { bubbles: true }));
    inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(output().match(/> help/g)).toHaveLength(1);
    expect(inputElement.value).toBe("");
    // Later tick: the same command after an explicit flush.
    inputElement.value = "help";
    inputElement.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(inputElement.value).toBe("help");
    inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(output().match(/> help/g)).toHaveLength(2);
    expect(inputElement.value).toBe("");
  });

  it("fails selectOutput honestly when closed or empty and focuses the real textarea otherwise", async () => {
    await mount();
    const api = window.timeMachineAgent!.v2;
    // Open, but nothing retained yet.
    expect(await api.execute("ui.console.selectOutput", {})).toMatchObject({
      ok: false, error: { kind: "validation" },
    });
    await enter("help");
    element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await nextTick();
    // Closed with retained output: still a failure, never a fake success.
    expect(await api.execute("ui.console.selectOutput", {})).toMatchObject({
      ok: false, error: { kind: "validation" },
    });
    element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await settle();
    const selected = await api.execute("ui.console.selectOutput", {});
    expect(selected).toMatchObject({ ok: true, data: { selected: true } });
    const textarea = element<HTMLTextAreaElement>('[aria-label="Console output"]');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
    expect(textarea.value.length).toBeGreaterThan(0);
  });

  it("clears retained output without cancelling the running job", async () => {
    await mount();
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], (_params, context) => new Promise((_resolve, reject) => {
      context!.signal!.addEventListener("abort", () => reject(new OperationInterruptedError("cancelled")), { once: true });
    }));
    await enter('time.set {"ageMa":110}');
    await vi.waitFor(() => expect(output()).toContain('"status": "accepted"'));
    const jobId = output().match(/"jobId": "([^"]+)"/)![1]!;
    element<HTMLButtonElement>('[data-ui-local="console.clear"]').click(); await nextTick();
    expect(output()).toBe("");
    expect(agentActions.getState().ui).toMatchObject({ consoleEntryCount: 0, consolePendingCount: 0 });
    const api = window.timeMachineAgent!.v2;
    expect(await api.jobs.get(jobId)).toMatchObject({ jobId, status: "running" });
    await api.jobs.cancel(jobId);
    expect(await api.jobs.wait(jobId)).toMatchObject({ ok: false, status: "cancelled" });
  });

  it("moves focus to the command input after Clear and closes with Escape from there", async () => {
    await mount();
    const input = element<HTMLInputElement>('[aria-label="Console command"]');
    await enter("help");
    // Clear disables its own button; focus must land on the real command input,
    // not on <body>, or the panel-scoped Escape listener never fires.
    element<HTMLButtonElement>('[data-ui-local="console.clear"]').click(); await settle();
    expect(output()).toBe("");
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
    expect(element<HTMLElement>('[aria-label="Development console"]').style.display).toBe("none");
    expect(element<HTMLElement>('[data-ui-local="console.toggle"].console-toggle')).toBe(document.activeElement);
  });

  it("clears through the API without opening the panel or stealing focus when closed", async () => {
    await mount();
    await enter("help");
    element<HTMLButtonElement>('[data-ui-local="console.toggle"]').click(); await settle();
    expect(element<HTMLElement>('[aria-label="Development console"]').style.display).toBe("none");
    // Closing returns focus to the visible toggle; a closed-panel clear must leave it there.
    const toggle = element<HTMLElement>('[data-ui-local="console.toggle"].console-toggle');
    expect(document.activeElement).toBe(toggle);
    const api = window.timeMachineAgent!.v2;
    expect(await api.execute("ui.console.clear", {})).toMatchObject({ ok: true, data: { entries: 0 } });
    await settle();
    expect(element<HTMLElement>('[aria-label="Development console"]').style.display).toBe("none");
    expect(document.activeElement).toBe(toggle);
    expect(document.activeElement).not.toBe(element('[aria-label="Console command"]'));
  });

  it("keeps a pending job running across Clear and the Escape close", async () => {
    await mount();
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], (_params, context) => new Promise((_resolve, reject) => {
      context!.signal!.addEventListener("abort", () => reject(new OperationInterruptedError("cancelled")), { once: true });
    }));
    await enter('time.set {"ageMa":110}');
    await vi.waitFor(() => expect(output()).toContain('"status": "accepted"'));
    const jobId = output().match(/"jobId": "([^"]+)"/)![1]!;
    element<HTMLButtonElement>('[data-ui-local="console.clear"]').click(); await settle();
    expect(output()).toBe("");
    const api = window.timeMachineAgent!.v2;
    expect(await api.jobs.get(jobId)).toMatchObject({ jobId, status: "running" });
    element<HTMLInputElement>('[aria-label="Console command"]')
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
    expect(await api.jobs.get(jobId)).toMatchObject({ jobId, status: "running" });
    await api.jobs.cancel(jobId);
    expect(await api.jobs.wait(jobId)).toMatchObject({ ok: false, status: "cancelled" });
  });

  it("shows API startup absence without pretending execution succeeded", async () => {
    await mount(); delete window.timeMachineAgent;
    await enter("query project.snapshot"); expect(output()).toContain("[failed]"); expect(output()).toContain("unavailable");
  });
});
