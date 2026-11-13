import type { Quaternion } from "@timemachine/reconstruction-core";

import { buildQuaternionTextureData } from "./gpu-point-renderer";
import type { PointStyleExpression } from "./style-expression";
import type { LoadedPointDataset } from "./types";

interface PointPickResponse {
  requestId: number;
  rowId: number | null;
  type: "picked";
}

export interface PointPickRequest {
  maximumAngularDistance: number;
  rotationMap: ReadonlyMap<number, Quaternion>;
  style: PointStyleExpression;
  target: readonly [number, number, number];
  timeMa: number;
}

export const MAX_PICKABLE_POINT_COUNT = 500_000;

export class PointPicker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    (rowId: number | undefined) => void
  >();
  private nextRequestId = 1;

  constructor(dataset: LoadedPointDataset) {
    if (dataset.header.pointCount > MAX_PICKABLE_POINT_COUNT) {
      throw new Error(
        `Point picking supports at most ${MAX_PICKABLE_POINT_COUNT.toLocaleString()} resident points.`,
      );
    }
    this.worker = new Worker(
      new URL("./point-pick-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<PointPickResponse>) => {
        if (event.data.type !== "picked") {
          return;
        }
        const resolve = this.pending.get(event.data.requestId);
        this.pending.delete(event.data.requestId);
        resolve?.(event.data.rowId ?? undefined);
      },
    );
    const buffer = dataset.buffer.slice(0);
    this.worker.postMessage(
      {
        buffer,
        headerBytes: dataset.header.headerBytes,
        pointCount: dataset.header.pointCount,
        recordStrideBytes: dataset.header.recordStrideBytes,
        type: "initialize",
      },
      [buffer],
    );
  }

  pick(request: PointPickRequest): Promise<number | undefined> {
    const requestId = this.nextRequestId++;
    const rotationData = buildQuaternionTextureData(
      Math.max(1, ...request.rotationMap.keys()) + 1,
      request.rotationMap,
    );
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.worker.postMessage(
        {
          filterPlateId: request.style.filter.plateId,
          maximumAngularDistance: request.maximumAngularDistance,
          maximumOccurrence: request.style.filter.maximumOccurrence,
          minimumOccurrence: request.style.filter.minimumOccurrence,
          requestId,
          rotationData,
          target: request.target,
          timeDeciMa: request.timeMa * 10,
          type: "pick",
        },
        [rotationData.buffer],
      );
    });
  }

  destroy(): void {
    this.worker.terminate();
    for (const resolve of this.pending.values()) {
      resolve(undefined);
    }
    this.pending.clear();
  }
}
