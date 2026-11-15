import { describe, expect, it, vi } from "vitest";
import { resolveStartupResources, type StartupResourceClient } from "../startup/resolve-startup-resources";
import type { ResourceSelection, RuntimeDataUrlOverrides } from "../phase1b/cloud-client";

const selection = (extra: Partial<ResourceSelection> = {}): ResourceSelection => ({
  plateModelId: 0, plateModelVersionId: 0, datasetVersionId: 0, useLocalPlateModelDemo: false, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function observe<T>(promise: Promise<T>) {
  const state: { status: string; value?: T; error?: unknown } = { status: "pending" };
  void promise.then(value => { state.status = "ready"; state.value = value; }, error => { state.status = "error"; state.error = error; });
  return state;
}
function client(selected: ResourceSelection): StartupResourceClient {
  return {
    snapshot: { selection: selected, serverUrl: "", v2WorkspaceAvailable: false },
    resolveSelectedRuntimeUrls: vi.fn(async () => ({ polygons: "/protected/polygons", rotations: "/protected/rotations" })),
  };
}

describe("source-dependent startup readiness", () => {
  it.each([false, true])("does not wait for cloud when the explicit local/empty selection has no remote dataset (demo=%s)", async demo => {
    const cloud = deferred<void>();
    const source = client(selection({ useLocalPlateModelDemo: demo }));
    const startup = observe(resolveStartupResources(source, cloud.promise));
    await flush();
    expect(startup.status).toBe("ready");
    expect(startup.value).toEqual({ selection: selection({ useLocalPlateModelDemo: demo }), serverUrl: "", runtimeUrlOverrides: {}, requiresCloud: false });
    expect(source.resolveSelectedRuntimeUrls).not.toHaveBeenCalled();
    // A late catalog/session update cannot mutate the already chosen local source.
    source.snapshot.selection.plateModelId = 42;
    cloud.resolve();
    await flush();
    expect(startup.value?.selection.plateModelId).toBe(0);
  });

  it.each([{ plateModelId: 42 }, { plateModelVersionId: 7 }, { useLocalPlateModelDemo: true, datasetVersionId: 9 }])("keeps required cloud initialization for %j", async selected => {
    const cloud = deferred<void>();
    const source = client(selection(selected));
    const startup = observe(resolveStartupResources(source, cloud.promise));
    await flush();
    expect(startup.status).toBe("pending");
    source.snapshot.v2WorkspaceAvailable = true;
    cloud.resolve();
    await flush();
    expect(startup.status).toBe("ready");
    expect(startup.value?.requiresCloud).toBe(true);
    expect(startup.value?.selection).toEqual(selection(selected));
    expect(startup.value?.runtimeUrlOverrides).toEqual({ polygons: "/protected/polygons", rotations: "/protected/rotations" });
  });

  it("waits for required versioned URLs rather than treating authentication as content readiness", async () => {
    const urls = deferred<RuntimeDataUrlOverrides>();
    const source = client(selection({ plateModelVersionId: 7 }));
    source.snapshot.v2WorkspaceAvailable = true;
    source.resolveSelectedRuntimeUrls = () => urls.promise;
    const startup = observe(resolveStartupResources(source, Promise.resolve()));
    await flush();
    expect(startup.status).toBe("pending");
    urls.resolve({ polygons: "/version-7/polygons", rotations: "/version-7/rotations" });
    await flush();
    expect(startup.value?.runtimeUrlOverrides.polygons).toBe("/version-7/polygons");
  });

  it("retains a failed versioned selection and exposes its URL error without selecting the local demo", async () => {
    const failure = new Error("Synthetic versioned manifest failure");
    const source = client(selection({ plateModelVersionId: 7 }));
    source.snapshot.v2WorkspaceAvailable = true;
    source.resolveSelectedRuntimeUrls = async () => { throw failure; };
    const result = await resolveStartupResources(source, Promise.resolve());
    expect(result.selection).toEqual(selection({ plateModelVersionId: 7 }));
    expect(result.runtimeUrlOverrides).toEqual({});
    expect(result.runtimeUrlError).toBe(failure);
  });

  it("does not require unavailable V2 URLs for a shared model", async () => {
    const source = client(selection({ plateModelId: 42 }));
    const result = await resolveStartupResources(source, Promise.resolve());
    expect(result.selection.plateModelId).toBe(42);
    expect(result.runtimeUrlOverrides).toEqual({});
    expect(result.requiresCloud).toBe(true);
    expect(source.resolveSelectedRuntimeUrls).not.toHaveBeenCalled();
  });

  it("does not silently turn a failed required cloud dependency into local success", async () => {
    const source = client(selection({ plateModelId: 42 }));
    const failure = new Error("Synthetic required startup failure");
    await expect(resolveStartupResources(source, Promise.reject(failure))).rejects.toBe(failure);
  });
});
