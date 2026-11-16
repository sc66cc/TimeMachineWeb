// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { mountAppShell } from "./support/mount-app-shell";

/**
 * The add-layer panel is a UI-owned region: its close control and Escape must
 * write the same `open` state as `ui.addPanel.setVisible`, return focus to the
 * trigger, and select a tab on demand. Group/layer feedback is rendered by the
 * sidebar, not by this panel (see the dedicated retry/instance suites).
 */
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing add-panel UI: ${selector}`);
  return node;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ui = () => agentActions.getState().ui as Record<string, unknown>;

describe("AppShell add-layer panel", () => {
  it("closes from its own control exactly once and returns focus to the trigger", async () => {
    mounted = await mountAppShell();
    const execute = vi.spyOn(agentActions, "execute");
    const trigger = element<HTMLButtonElement>('button[data-action="ui.addPanel.setVisible"]');
    trigger.click();
    await settle();
    expect(ui()).toMatchObject({ addPanelOpen: true, addPanelKind: "group" });
    const panel = element<HTMLElement>("#add-layer-panel");
    expect(panel.style.display).not.toBe("none");
    expect(document.querySelector('form[aria-label="Add layer group"]')).not.toBeNull();

    element<HTMLButtonElement>('button[aria-label="Close add panel"]').click();
    await settle();
    expect(ui()).toMatchObject({ addPanelOpen: false });
    expect(panel.style.display).toBe("none");
    expect(document.activeElement).toBe(trigger);
    // Closing is local panel state, not a second facade dispatch.
    expect(execute).not.toHaveBeenCalledWith(AGENT_ACTIONS.addPanelSetVisible, expect.anything());
  });

  it("closes on Escape and leaves exactly the open flag false", async () => {
    mounted = await mountAppShell();
    const trigger = element<HTMLButtonElement>('button[data-action="ui.addPanel.setVisible"]');
    trigger.click();
    await settle();
    const panel = element<HTMLElement>("#add-layer-panel");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(ui()).toMatchObject({ addPanelOpen: false, addPanelKind: "group" });
    expect(document.activeElement).toBe(trigger);
  });

  it("selects the requested kind through the public action and mounts only that form", async () => {
    mounted = await mountAppShell();
    const result = await agentActions.execute(AGENT_ACTIONS.addPanelSetVisible, {
      visible: true,
      kind: "atlas",
    });
    await settle();
    expect(result).toMatchObject({ ok: true, data: { visible: true, kind: "atlas" } });
    expect(ui()).toMatchObject({ addPanelOpen: true, addPanelKind: "atlas" });
    expect(document.querySelector('form[aria-label="Add Atlas layer"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Atlas layer name"]')).not.toBeNull();
    expect(document.querySelector('form[aria-label="Add layer group"]')).toBeNull();
  });
});
