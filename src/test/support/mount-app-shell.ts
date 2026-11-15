import { vi } from "vitest";

import { createApp } from "vue";
import { ProjectSession } from "../../project/project-session";
import { PROJECT_STATE_EVENT, type ProjectStateDetail } from "../../project/project-events";

/**
 * Mounts the real AppShell in jsdom with an in-page storage stub and a fetch
 * that always fails, so no test ever reaches a network or a real Server.
 *
 * `fetchErrorMessage` only changes the failure text the offline fetch throws;
 * it never makes a request succeed. The component is imported dynamically on
 * purpose: the cloud client captures `window.localStorage` when it is
 * constructed, so the stub must exist first.
 */
export async function mountAppShell(
  options: { fetchErrorMessage?: string; publishProjectState?: boolean } = {},
): Promise<{ unmount: () => void }> {
  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
  const fetchErrorMessage =
    options.fetchErrorMessage ?? "offline test environment";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(fetchErrorMessage);
    }),
  );
  const AppShell = (await import("../../AppShell.vue")).default;
  const host = document.createElement("div");
  host.id = "app";
  document.body.appendChild(host);
  const app = createApp(AppShell);
  app.mount(host);
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (options.publishProjectState !== false) {
    const project = new ProjectSession();
    const detail: ProjectStateDetail = { restoreStatus: "empty", compatibility: project.compatibilityReport,
      localSave: project.localSaveState, cloudSave: { status: "idle" }, originalAvailable: false };
    window.dispatchEvent(new CustomEvent(PROJECT_STATE_EVENT, { detail }));
    await Promise.resolve();
  }
  return {
    unmount: () => {
      app.unmount();
      host.remove();
      vi.unstubAllGlobals();
    },
  };
}

/**
 * Provides the in-page storage without ever reading `window.localStorage`.
 *
 * Reading it directly is what emits Node's `ExperimentalWarning` (the global
 * getter runs before jsdom's own storage exists), so the existing property is
 * inspected through its descriptor instead. The stub is installed once and
 * then left alone: the cloud client singleton captures `window.localStorage`
 * when it is constructed, so replacing the stub on a later mount would leave
 * that singleton writing into a storage object nobody reads.
 */
function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  const existing = Object.getOwnPropertyDescriptor(window, name);
  if (existing?.value) {
    return;
  }
  Object.defineProperty(window, name, {
    configurable: true,
    value: memoryStorage(),
  });
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}
