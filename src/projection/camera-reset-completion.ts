import type { Viewer } from "cesium";
import { OperationInterruptedError } from "../agent-actions/operation";

interface FlightCallbacks {
  complete: () => void;
  cancel: () => void;
}

function cameraState(viewer: Viewer): number[] {
  const camera = viewer.camera;
  const state = [camera.positionWC, camera.directionWC, camera.upWC].flatMap(v => [v.x, v.y, v.z]);
  const frustum = camera.frustum as unknown as Record<string, unknown>;
  for (const key of ["width", "aspectRatio", "fov", "near", "far", "left", "right", "top", "bottom", "xOffset", "yOffset"]) {
    state.push(typeof frustum[key] === "number" ? frustum[key] as number : NaN);
  }
  return state;
}

/** The pose part (position/direction/up) must be complete before completion. */
function poseIsFinite(state: number[]): boolean {
  return state.slice(0, 9).every(value => Number.isFinite(value));
}

function sameCamera(a: number[], b: number[]): boolean {
  return a.every((value, i) => Object.is(value, b[i]) || Math.abs(value - b[i]!) <= 1e-12 * Math.max(1, Math.abs(value)));
}

/** One camera reset owner: native flight acknowledgement, then a real frame. */
export class CameraResetCompletion {
  private stopPending?: (error: Error) => void;
  private destroyed = false;

  constructor(private readonly viewer: Viewer) {}

  run(start: (callbacks: FlightCallbacks) => void, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.destroyed || this.viewer.scene.isDestroyed()) return Promise.reject(new Error("Camera reset owner is destroyed."));
    if (options.signal?.aborted) return Promise.reject(new OperationInterruptedError("cancelled"));
    this.cancel("superseded");
    this.viewer.useDefaultRenderLoop = true;
    const scene = this.viewer.scene;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let flightActive = true;
      let flightComplete = false;
      let targetCamera: number[] | undefined;
      let stoppingError: Error | undefined;
      let removeFrame = () => {};
      let removeError = () => {};
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        removeFrame(); removeError();
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        if (this.stopPending === stop) this.stopPending = undefined;
        if (error) reject(error); else resolve();
      };
      const stop = (error: Error): void => {
        if (settled) return;
        stoppingError = error;
        try {
          if (flightActive) this.viewer.camera.cancelFlight();
        } catch (cancelError) {
          finish(cancelError instanceof Error ? cancelError : new Error("Camera flight cancellation failed."));
          return;
        }
        // Cesium acknowledges a live flight synchronously; no current flight is
        // also safe to stop. Late native callbacks cannot settle a later owner.
        finish(error);
      };
      const abort = () => stop(new OperationInterruptedError("cancelled"));
      const timer = setTimeout(() => stop(new Error("Camera reset did not render within 30 seconds.")), 30_000);
      removeFrame = scene.postRender.addEventListener(() => {
        if (!flightComplete || !targetCamera) return;
        const rendered = cameraState(this.viewer);
        if (!poseIsFinite(rendered)) {
          finish(new Error("The camera pose is not finite after the reset frame."));
          return;
        }
        finish(sameCamera(targetCamera, rendered) ? undefined
          : new OperationInterruptedError("superseded", "Another camera change replaced the reset before it rendered."));
      });
      removeError = scene.renderError.addEventListener((_scene, error) => stop(
        error instanceof Error ? error : new Error("Camera reset failed during rendering."),
      ));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.stopPending = stop;
      try {
        start({
          complete: () => {
            if (settled) return;
            flightActive = false;
            flightComplete = true;
            targetCamera = cameraState(this.viewer);
            // Never turn a NaN target into a "successful" reset: Object.is(NaN,
            // NaN) would otherwise match on the next frame.
            if (!poseIsFinite(targetCamera)) {
              finish(new Error("Camera reset completed on a non-finite camera pose."));
              return;
            }
            scene.requestRender();
          },
          cancel: () => {
            flightActive = false;
            finish(stoppingError ?? new OperationInterruptedError("cancelled", "Camera flight was interrupted."));
          },
        });
        scene.requestRender();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Camera reset could not start."));
      }
    });
  }

  cancel(reason: "cancelled" | "superseded" = "cancelled"): void {
    this.stopPending?.(new OperationInterruptedError(reason));
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
  }
}
