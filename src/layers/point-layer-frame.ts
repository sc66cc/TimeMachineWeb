import type { Viewer } from "cesium";
import type { GpuPointRenderer } from "@timemachine/point-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";

interface PointLayerFrameOptions {
  signal?: AbortSignal;
  isCurrent: () => boolean;
  timeMa: number;
  show: boolean;
}

/**
 * Confirm an installed layer or restoration to no layer. For undefined, the
 * caller must remove the candidate and include that absence in isCurrent.
 */
export function waitForPointLayerFrame(
  viewer: Viewer,
  renderer: GpuPointRenderer | undefined,
  options: PointLayerFrameOptions,
): Promise<void> {
  const scene = viewer.scene;
  return new Promise((resolve, reject) => {
    let settled = false;
    let confirming = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const removers: Array<() => void> = [];
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanupErrors: unknown[] = [];
      for (const remove of removers.splice(0)) {
        try { remove(); } catch (failure) { cleanupErrors.push(failure); }
      }
      if (cleanupErrors.length) reject(new AggregateError(
        error === undefined ? cleanupErrors : [error, ...cleanupErrors], "Point frame listener cleanup failed.",
      ));
      else if (error !== undefined) reject(error);
      else resolve();
    };
    const assertOwner = (): void => {
      if (options.signal?.aborted) throw options.signal.reason instanceof OperationInterruptedError
        ? options.signal.reason : new OperationInterruptedError("cancelled");
      if (scene.isDestroyed()) throw new OperationInterruptedError("cancelled", "The point scene was destroyed.");
      if (!options.isCurrent()) throw new OperationInterruptedError("superseded", "The point layer owner changed before its frame.");
    };
    const assertFrame = (): void => {
      assertOwner();
      if (renderer && !renderer.matchesFrameState(options.timeMa, options.show)) {
        throw new OperationInterruptedError("superseded", "The point layer no longer matches the requested frame.");
      }
    };
    const abort = (): void => {
      try { assertOwner(); } catch (error) { finish(error); }
    };
    try {
      if (!Number.isFinite(options.timeMa)) throw new Error("Point frame age must be finite.");
      assertOwner();
      removers.push(scene.postRender.addEventListener(() => {
        if (settled || confirming) return;
        try {
          assertFrame();
          confirming = true;
          // Keep renderError subscribed until the native frame stack unwinds.
          // Cesium can emit postRender even after that frame's rendering failed.
          void Promise.resolve().then(() => {
            if (settled) return;
            try { assertFrame(); finish(); } catch (error) { finish(error); }
          });
        } catch (error) { finish(error); }
      }));
      removers.push(scene.renderError.addEventListener((_scene, error) => finish(
        error instanceof Error ? error : new Error("Point layer rendering failed."),
      )));
      options.signal?.addEventListener("abort", abort, { once: true });
      removers.push(() => options.signal?.removeEventListener("abort", abort));
      timer = setTimeout(() => {
        try { assertOwner(); finish(new Error("Point layer did not render within 30 seconds.")); }
        catch (error) { finish(error); }
      }, 30_000);
      assertOwner();
      if (settled) return;
      if (viewer.useDefaultRenderLoop === false) viewer.useDefaultRenderLoop = true;
      assertOwner();
      if (!settled) scene.requestRender();
    } catch (error) { finish(error); }
  });
}
