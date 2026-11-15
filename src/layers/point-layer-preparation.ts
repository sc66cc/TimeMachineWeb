import type { Viewer } from "cesium";
import type { Quaternion } from "@timemachine/reconstruction-core";
import {
  GpuPointRenderer, loadPointDataset,
  type PointDatasetManifestEntry, type LoadedPointDataset,
} from "@timemachine/point-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";

interface CommittedPointFrame {
  timeMa: number;
  rotationMap: ReadonlyMap<number, Quaternion>;
}

interface PointPreparationOptions {
  viewer: Viewer;
  entry: Pick<PointDatasetManifestEntry, "id" | "pointCount">;
  resolveUrl(): Promise<string>;
  readCommittedFrame(): CommittedPointFrame;
  onUploading(): void;
  onCleanupError?(error: unknown): void;
  onCleanupPending?(resource: { destroy(): void }): void;
  /** Take ownership before attempting release, retaining any failed handle. */
  releaseRenderer?(renderer: GpuPointRenderer): void;
  signal: AbortSignal;
}

function interrupted(signal: AbortSignal): OperationInterruptedError {
  return signal.reason instanceof OperationInterruptedError
    ? signal.reason : new OperationInterruptedError("cancelled");
}

// URL resolution can wait on authentication; it has no cancellable transport.
// Stop this consumer immediately and discard any late result from each stage.
function pointStage<T>(start: () => Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      run();
    };
    const abort = (): void => finish(() => reject(interrupted(signal)));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw interrupted(signal);
      return start();
    }).then(value => {
      if (settled) { discard?.(value); return; }
      finish(() => resolve(value));
    }, error => finish(() => reject(signal.aborted ? interrupted(signal) : error)));
  });
}

/** Prepare the point layer without publishing it into the application's state. */
export async function preparePointLayer(options: PointPreparationOptions): Promise<{
  dataset: LoadedPointDataset;
  renderer: GpuPointRenderer;
}> {
  const { entry, signal } = options;
  const url = await pointStage(options.resolveUrl, signal);
  const dataset = await pointStage(() => loadPointDataset(entry.id, url, { signal }), signal);
  if (dataset.header.pointCount !== entry.pointCount) {
    throw new Error(`数据点数 ${dataset.header.pointCount.toLocaleString()} 与清单 ${entry.pointCount.toLocaleString()} 不一致。`);
  }
  if (signal.aborted) throw interrupted(signal);
  options.onUploading();
  const frame = options.readCommittedFrame();
  const reportDiscardError = (error: unknown): void => {
    try {
      void Promise.resolve(options.onCleanupError?.(error)).catch(() => undefined);
    } catch { /* diagnostics cannot replace the original preparation failure */ }
  };
  const discard = (renderer: GpuPointRenderer) => {
    if (!options.releaseRenderer) {
      disposePointLayer({ renderer }, options.onCleanupError);
      return;
    }
    try {
      // The callback owns this handle even if its release attempt throws. Do
      // not destroy it again here or lose its caller-managed retry reference.
      void Promise.resolve(options.releaseRenderer(renderer)).catch(reportDiscardError);
    } catch (error) { reportDiscardError(error); }
  };
  const renderer = await pointStage(
    () => GpuPointRenderer.create(options.viewer, dataset, frame.timeMa, frame.rotationMap, {
      signal, show: false, onCleanupError: options.onCleanupError,
      ...(options.onCleanupPending ? { onCleanupPending: options.onCleanupPending } : {}),
    }),
    signal, discard,
  );
  try {
    if (signal.aborted) throw interrupted(signal);
    // The committed frame may have advanced while a GPU allocation was pending.
    const latest = options.readCommittedFrame();
    renderer.setTime(latest.timeMa, latest.rotationMap);
    return { dataset, renderer };
  } catch (error) {
    discard(renderer);
    throw error;
  }
}

/** Release both resources even when one destroy call fails; never wait for rAF. */
export function disposePointLayer(
  resources: { renderer?: { destroy(): void }; picker?: { destroy(): void } },
  report?: (error: unknown) => void,
): boolean {
  let released = true;
  for (const key of ["renderer", "picker"] as const) {
    try {
      resources[key]?.destroy();
      resources[key] = undefined;
    }
    catch (error) {
      released = false;
      try { report?.(error); } catch { /* diagnostics must not stop disposal */ }
    }
  }
  return released;
}
