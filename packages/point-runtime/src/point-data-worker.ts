/// <reference lib="webworker" />

import type { LoadedPointDataset } from "./types";
import { parsePointBinaryHeader } from "./wgp-format";

interface LoadRequest {
  type: "load";
  datasetId: string;
  url: string;
}

interface LoadSuccess {
  type: "loaded";
  payload: LoadedPointDataset;
}

interface LoadFailure {
  type: "error";
  datasetId: string;
  message: string;
}

const worker = self as DedicatedWorkerGlobalScope;

worker.addEventListener("message", async (event: MessageEvent<LoadRequest>) => {
  if (event.data.type !== "load") {
    return;
  }

  const totalStarted = performance.now();
  try {
    const fetchStarted = performance.now();
    const response = await fetch(event.data.url);
    if (!response.ok) {
      throw new Error(
        `${event.data.url} returned HTTP ${response.status}. Run the fixture generator first.`,
      );
    }
    const buffer = await response.arrayBuffer();
    const fetchMs = performance.now() - fetchStarted;

    const decodeStarted = performance.now();
    const header = parsePointBinaryHeader(buffer);
    const decodeMs = performance.now() - decodeStarted;
    const payload: LoadedPointDataset = {
      datasetId: event.data.datasetId,
      header,
      buffer,
      timings: {
        cacheHit: false,
        fetchMs,
        decodeMs,
        totalMs: performance.now() - totalStarted,
      },
    };
    const message: LoadSuccess = { type: "loaded", payload };
    worker.postMessage(message, [buffer]);
  } catch (error) {
    const message: LoadFailure = {
      type: "error",
      datasetId: event.data.datasetId,
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(message);
  }
});

export {};
