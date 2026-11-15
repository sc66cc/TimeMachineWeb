export interface OptionalLayerAttachmentBoundary {
  isPreparing(): boolean;
  onSettled(listener: () => void): () => void;
  signal: AbortSignal;
}

/** Optional manifests are independent of core startup; installing their layers is not. */
export function attachOptionalLayer(
  boundary: OptionalLayerAttachmentBoundary, install: () => void,
): Promise<void> {
  if (boundary.signal.aborted) return Promise.reject(new Error("Optional layer attachment was cancelled."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeBoundary = () => {};
    const cleanup = (): void => {
      clearTimeout(timer);
      removeBoundary();
      boundary.signal.removeEventListener("abort", cancel);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new Error("Optional layer attachment was cancelled."));
    const attach = (): void => {
      if (settled) return;
      if (boundary.signal.aborted) { cancel(); return; }
      settled = true;
      cleanup();
      // A provider failure belongs to this optional layer, never to the view's commit callback.
      try { install(); resolve(); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => fail(new Error("Optional layer attachment did not settle within 30 seconds.")), 30_000);
    try {
      removeBoundary = boundary.onSettled(attach);
      if (settled) { removeBoundary(); return; }
      boundary.signal.addEventListener("abort", cancel, { once: true });
      if (boundary.signal.aborted) cancel();
      else if (!boundary.isPreparing()) attach();
    } catch (error) { fail(error); }
  });
}
