// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { mountAppShell } from "./support/mount-app-shell";

/**
 * The drawer has exactly one visible entry point, it is the leading control of
 * the top bar, and closing the drawer puts focus back on it. The future global
 * menu keeps its honest disabled state next to it.
 */

let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
// Closing the drawer mounts reka-ui presence hooks that need a size observer;
// jsdom has none (this stub only observes nothing).
class SizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = SizeObserverStub;
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});
async function settle(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing shell control: ${selector}`);
  return node;
}

describe("AppShell drawer entry point", () => {
  it("exposes a single, enabled drawer toggle as the leading top-bar control", async () => {
    mounted = await mountAppShell();
    const toggles = [...document.querySelectorAll<HTMLElement>('[data-action="ui.sidebar.setVisible"]')];
    expect(toggles).toHaveLength(1);
    const toggle = toggles[0]!;
    expect(toggle.tagName).toBe("BUTTON");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(toggle.getAttribute("aria-controls")).toBe("tm-sidebar");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const topbar = toggle.closest(".topbar");
    expect(topbar).not.toBeNull();
    // It keeps the one handler/action and gains the sticky leading placement.
    expect(toggle.classList.contains("topbar__sidebar-toggle")).toBe(true);
    const controls = [...topbar!.querySelectorAll<HTMLElement>("button, input, select")];
    expect(controls[0]).toBe(toggle);
    // The not-yet-implemented global menu is still there, still disabled.
    const futureMenu = element<HTMLButtonElement>('[data-action="ui.menu.toggle"]');
    expect(futureMenu.disabled).toBe(true);
    expect(futureMenu.getAttribute("title")).toContain("Not implemented");
    expect(futureMenu.getAttribute("aria-describedby")).toBe("tm-future-note");
    expect(futureMenu.textContent?.trim()).not.toBe("");
  });

  it("closes the drawer through the shared action and returns focus to the visible toggle", async () => {
    mounted = await mountAppShell();
    const toggle = element<HTMLButtonElement>('[data-action="ui.sidebar.setVisible"]');
    const sidebar = element("#tm-sidebar");
    const inner = element<HTMLButtonElement>("#tm-sidebar button");
    // jsdom reflects `:inert="false"` as an attribute string; a browser drops the
    // attribute (the real DOM state is checked in the browser evidence).
    expect(sidebar.getAttribute("inert")).toBe("false");
    expect(sidebar.getAttribute("aria-hidden")).toBeNull();
    inner.focus();
    expect(document.activeElement).toBe(inner);

    expect(await agentActions.execute(AGENT_ACTIONS.sidebarSetVisible, { visible: false }))
      .toMatchObject({ ok: true, data: { visible: false } });
    await settle();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(element("#tm-sidebar")).toBe(sidebar);
    expect(sidebar.getAttribute("inert")).toBe("true");
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");

    // Reopening keeps the same toggle and the same sidebar node.
    expect(await agentActions.execute(AGENT_ACTIONS.sidebarSetVisible, { visible: true }))
      .toMatchObject({ ok: true, data: { visible: true } });
    await settle();
    expect(element("#tm-sidebar")).toBe(sidebar);
    expect(sidebar.getAttribute("inert")).toBe("false");
    expect(document.querySelectorAll('[data-action="ui.sidebar.setVisible"]')).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
  });
});
