/// <reference lib="webworker" />

interface InitializeRequest {
  buffer: ArrayBuffer;
  headerBytes: number;
  pointCount: number;
  recordStrideBytes: number;
  type: "initialize";
}

interface PickRequest {
  filterPlateId: number | null;
  maximumAngularDistance: number;
  maximumOccurrence: number;
  minimumOccurrence: number;
  requestId: number;
  rotationData: Float32Array;
  target: readonly [number, number, number];
  timeDeciMa: number;
  type: "pick";
}

type PointPickRequest = InitializeRequest | PickRequest;

interface PointPickResponse {
  requestId: number;
  rowId: number | null;
  type: "picked";
}

const worker = self as DedicatedWorkerGlobalScope;
let pointBuffer: ArrayBuffer | undefined;
let headerBytes = 0;
let pointCount = 0;
let recordStrideBytes = 0;

worker.addEventListener(
  "message",
  (event: MessageEvent<PointPickRequest>) => {
    const request = event.data;
    if (request.type === "initialize") {
      pointBuffer = request.buffer;
      headerBytes = request.headerBytes;
      pointCount = request.pointCount;
      recordStrideBytes = request.recordStrideBytes;
      return;
    }
    const buffer = pointBuffer;
    if (!buffer) {
      worker.postMessage({
        requestId: request.requestId,
        rowId: null,
        type: "picked",
      } satisfies PointPickResponse);
      return;
    }

    const view = new DataView(buffer);
    const maximumDistanceCosine = Math.cos(request.maximumAngularDistance);
    let bestDot = maximumDistanceCosine;
    let bestRowId: number | null = null;
    for (let rowId = 0; rowId < pointCount; rowId += 1) {
      const offset = headerBytes + rowId * recordStrideBytes;
      const validFromDeciMa = view.getUint16(offset + 12, true);
      const validToDeciMa = view.getUint16(offset + 14, true);
      if (
        request.timeDeciMa > validFromDeciMa ||
        request.timeDeciMa < validToDeciMa
      ) {
        continue;
      }
      const plateId = view.getUint16(offset + 16, true);
      const occurrenceCount = view.getUint16(offset + 18, true);
      if (
        (request.filterPlateId !== null &&
          plateId !== request.filterPlateId) ||
        occurrenceCount < request.minimumOccurrence ||
        occurrenceCount > request.maximumOccurrence
      ) {
        continue;
      }
      const quaternionOffset = plateId * 4;
      if (quaternionOffset + 3 >= request.rotationData.length) {
        continue;
      }
      const qx = request.rotationData[quaternionOffset] ?? 0;
      const qy = request.rotationData[quaternionOffset + 1] ?? 0;
      const qz = request.rotationData[quaternionOffset + 2] ?? 0;
      const qw = request.rotationData[quaternionOffset + 3] ?? 0;
      if (qx * qx + qy * qy + qz * qz + qw * qw < 0.5) {
        continue;
      }

      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      const tx = 2 * (qy * z - qz * y);
      const ty = 2 * (qz * x - qx * z);
      const tz = 2 * (qx * y - qy * x);
      const rotatedX = x + qw * tx + (qy * tz - qz * ty);
      const rotatedY = y + qw * ty + (qz * tx - qx * tz);
      const rotatedZ = z + qw * tz + (qx * ty - qy * tx);
      const dot =
        rotatedX * request.target[0] +
        rotatedY * request.target[1] +
        rotatedZ * request.target[2];
      if (dot > bestDot) {
        bestDot = dot;
        bestRowId = rowId;
      }
    }
    worker.postMessage({
      requestId: request.requestId,
      rowId: bestRowId,
      type: "picked",
    } satisfies PointPickResponse);
  },
);

export {};
