import type { Viewer } from "cesium";

export interface PerformanceSnapshot {
  fps: number | undefined;
  frameP95Ms: number | undefined;
  interactionLatencyMs: number | undefined;
  sampleCount: number;
  usedJsHeapBytes: number | undefined;
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? Number.NaN;
}

export class PerformanceMonitor {
  private readonly frameIntervalsMs: number[] = [];
  private readonly removePostRenderListener: () => void;
  private previousRenderAt: number | undefined;
  private interactionStartedAt: number | undefined;
  private interactionLatencyMs: number | undefined;

  constructor(viewer: Viewer) {
    this.removePostRenderListener = viewer.scene.postRender.addEventListener(
      () => {
        const now = performance.now();
        if (this.previousRenderAt !== undefined) {
          const interval = now - this.previousRenderAt;
          // requestRenderMode intentionally sleeps while idle. Those gaps are
          // not frame times and must not be included in FPS percentiles.
          if (
            this.interactionStartedAt !== undefined &&
            interval > 0 &&
            interval <= 2_000
          ) {
            this.frameIntervalsMs.push(interval);
            if (this.frameIntervalsMs.length > 240) {
              this.frameIntervalsMs.shift();
            }
          }
        }
        this.previousRenderAt = now;
        if (this.interactionStartedAt !== undefined) {
          this.interactionLatencyMs = now - this.interactionStartedAt;
          this.interactionStartedAt = undefined;
        }
      },
    );
  }

  markInteraction(): void {
    this.interactionStartedAt = performance.now();
  }

  resetFrameSamples(): void {
    this.frameIntervalsMs.length = 0;
    this.previousRenderAt = undefined;
    this.interactionLatencyMs = undefined;
  }

  snapshot(): PerformanceSnapshot {
    const sorted = [...this.frameIntervalsMs].sort((left, right) => left - right);
    const medianMs = percentile(sorted, 0.5);
    const p95Ms = percentile(sorted, 0.95);
    const runtimePerformance = performance as PerformanceWithMemory;
    return {
      fps: Number.isFinite(medianMs) ? 1_000 / medianMs : undefined,
      frameP95Ms: Number.isFinite(p95Ms) ? p95Ms : undefined,
      interactionLatencyMs: this.interactionLatencyMs,
      sampleCount: sorted.length,
      usedJsHeapBytes: runtimePerformance.memory?.usedJSHeapSize,
    };
  }

  destroy(): void {
    this.removePostRenderListener();
  }
}
