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

  it("shows API startup absence without pretending execution succeeded", async () => {
    await mount(); delete window.timeMachineAgent;
    await enter("query project.snapshot"); expect(output()).toContain("[failed]"); expect(output()).toContain("unavailable");
  });
});
