import type { Phase1BState, ResourceSelection, RuntimeDataUrlOverrides } from "../phase1b/cloud-client";
import { resolvePlateModelSource } from "../plate-model/plate-source";

export interface StartupResourceClient {
  readonly snapshot: Pick<Phase1BState, "selection" | "serverUrl" | "v2WorkspaceAvailable">;
  resolveSelectedRuntimeUrls(): Promise<RuntimeDataUrlOverrides>;
}
export interface StartupResources {
  selection: ResourceSelection;
  serverUrl: string;
  runtimeUrlOverrides: RuntimeDataUrlOverrides;
  requiresCloud: boolean;
  runtimeUrlError?: unknown;
}

export async function resolveStartupResources(client: StartupResourceClient, initialization: Promise<unknown>): Promise<StartupResources> {
  const initial = client.snapshot;
  const source = resolvePlateModelSource(initial.selection);
  const requiresCloud = source.kind === "shared" || source.kind === "v2" || initial.selection.datasetVersionId > 0;
  // The caller owns/report errors from background initialization. Local content
  // does not await it and must not inherit URLs from a later remote selection.
  if (!requiresCloud) return {
    selection: { ...initial.selection }, serverUrl: initial.serverUrl,
    runtimeUrlOverrides: {}, requiresCloud: false,
  };
  await initialization;
  const state = client.snapshot;
  const result: StartupResources = {
    selection: { ...state.selection }, serverUrl: state.serverUrl,
    runtimeUrlOverrides: {}, requiresCloud,
  };
  if (state.v2WorkspaceAvailable) {
    try { result.runtimeUrlOverrides = await client.resolveSelectedRuntimeUrls(); }
    catch (error) { result.runtimeUrlError = error; }
  }
  return result;
}
