export type StartupManifestResult<T> = { ok: true; value: T } | { ok: false; error: Error };

/** Starts alongside core loading; failures remain handled even before a consumer awaits. */
export function requestStartupManifest<T>(url: string, signal: AbortSignal): Promise<StartupManifestResult<T>> {
  if (signal.aborted) return Promise.resolve({ ok: false, error: new Error("Startup manifest request was cancelled.") });
  return new Promise(resolve => {
    const transport = new AbortController();
    let settled = false;
    const finish = (result: StartupManifestResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = (): void => {
      finish({ ok: false, error: new Error("Startup manifest request was cancelled.") });
      transport.abort();
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error("Startup manifest did not load within 30 seconds.") });
      transport.abort();
    }, 30_000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    void (async () => {
      try {
        const response = await fetch(url, { signal: transport.signal });
        if (settled) return;
        if (!response.ok) {
          finish({ ok: false, error: new Error(`Startup manifest request failed (HTTP ${response.status}).`) });
          return;
        }
        const value = await response.json() as T;
        finish({ ok: true, value });
      } catch {
        // URLs and decoder errors may include signed query values or response text.
        finish({ ok: false, error: new Error("Startup manifest transport or JSON decoding failed.") });
      }
    })();
  });
}
