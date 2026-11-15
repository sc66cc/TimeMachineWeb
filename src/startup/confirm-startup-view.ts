export interface StartupViewState {
  status: "idle" | "preparing" | "ready" | "error";
  committedId: string;
  committedTimeMa: number;
  revision: number;
  lastError?: { message: string };
}
export interface StartupViewScene {
  postRender: { addEventListener(listener: () => void): () => void };
  renderError: { addEventListener(listener: (scene: unknown, error: unknown) => void): () => void };
  requestRender(): void;
  isDestroyed(): boolean;
}
export function confirmStartupView(
  scene: StartupViewScene, read: () => StartupViewState,
  prepare: (state: StartupViewState) => void, signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || scene.isDestroyed()) return Promise.reject(new Error("Initial view was cancelled."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let prepared: StartupViewState | undefined;
    let removeFrame = () => {};
    let removeError = () => {};
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      for (const remove of [removeFrame, removeError]) { try { remove(); } catch { /* settled guards any retained native callback */ } }
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Initial view was cancelled."));
    const sameView = (a: StartupViewState, b: StartupViewState) =>
      a.status === "ready" && b.status === "ready" && a.committedId === b.committedId &&
      a.committedTimeMa === b.committedTimeMa && a.revision === b.revision;
    const timer = setTimeout(() => finish(new Error("Initial view did not render within 30 seconds.")), 30_000);
    try {
      removeFrame = scene.postRender.addEventListener(() => {
        if (settled) return;
        try {
          if (scene.isDestroyed()) { abort(); return; }
          const state = read();
          if (state.status === "error") { finish(new Error(state.lastError?.message ?? "Initial view failed.")); return; }
          if (prepared && sameView(prepared, state)) { finish(); return; }
          prepared = undefined;
          if (state.status === "ready") {
            // Globe primitives are created synchronously. Their instance attributes
            // become accessible after native update; changes here render NEXT frame.
            const candidate = { ...state };
            prepare(candidate);
            if (settled) return;
            if (sameView(candidate, read())) prepared = candidate;
          }
          scene.requestRender();
        } catch (error) { finish(error); }
      });
      removeError = scene.renderError.addEventListener((_scene, error) => finish(
        error instanceof Error ? error : new Error("Initial view failed during rendering."),
      ));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      if (!settled) scene.requestRender();
    } catch (error) { finish(error); }
  });
}
