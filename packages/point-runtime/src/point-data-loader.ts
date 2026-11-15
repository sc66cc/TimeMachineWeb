import type { LoadedPointDataset } from "./types";

interface WorkerSuccess {
  type: "loaded";
  payload: LoadedPointDataset;
}

interface WorkerFailure {
  type: "error";
  datasetId: string;
  message: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

export interface PointDatasetLoadOptions {
  cache?: PointDatasetCache;
  signal?: AbortSignal;
}

interface CachedPointDataset {
  key: string;
  value: LoadedPointDataset;
}

export class PointDatasetCache {
  private readonly values = new Map<string, CachedPointDataset>();
  private usedBytes = 0;

  constructor(readonly maximumBytes = 128 * 1024 * 1024) {}

  get sizeBytes(): number {
    return this.usedBytes;
  }

  get(datasetId: string, url: string): LoadedPointDataset | undefined {
    const key = this.key(datasetId, url);
    const cached = this.values.get(key);
    if (!cached) {
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, cached);
    return {
      ...cached.value,
      timings: {
        cacheHit: true,
        decodeMs: 0,
        fetchMs: 0,
        totalMs: 0,
      },
    };
  }

  set(datasetId: string, url: string, value: LoadedPointDataset): void {
    const byteLength = value.buffer.byteLength;
    if (byteLength > this.maximumBytes) {
      return;
    }
    const key = this.key(datasetId, url);
    const existing = this.values.get(key);
    if (existing) {
      this.usedBytes -= existing.value.buffer.byteLength;
      this.values.delete(key);
    }
    this.values.set(key, { key, value });
    this.usedBytes += byteLength;
    while (this.usedBytes > this.maximumBytes) {
      const oldest = this.values.values().next().value as
        | CachedPointDataset
        | undefined;
      if (!oldest) {
        break;
      }
      this.values.delete(oldest.key);
      this.usedBytes -= oldest.value.buffer.byteLength;
    }
  }

  clear(): void {
    this.values.clear();
    this.usedBytes = 0;
  }

  private key(datasetId: string, url: string): string {
    return `${datasetId}\n${url}`;
  }
}

export const defaultPointDatasetCache = new PointDatasetCache();

export function loadPointDataset(
  datasetId: string,
  url: string,
  options: PointDatasetLoadOptions = {},
): Promise<LoadedPointDataset> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException("Point-data load aborted.", "AbortError"));
  }
  const cache = options.cache ?? defaultPointDatasetCache;
  const cached = cache.get(datasetId, url);
  if (cached) {
    return Promise.resolve(cached);
  }
  const worker = new Worker(
    new URL("./point-data-worker.ts", import.meta.url),
    { type: "module" },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      worker.terminate();
      callback();
    };
    const abort = (): void => {
      finish(() =>
        reject(new DOMException("Point-data load aborted.", "AbortError")),
      );
    };
    const message = (event: MessageEvent<WorkerResponse>): void => {
      const data = event.data;
      if (data.type === "loaded") {
        const payload = data.payload;
        finish(() => {
          cache.set(datasetId, url, payload);
          resolve(payload);
        });
      } else {
        finish(() => reject(new Error(data.message)));
      }
    };
    const error = (event: ErrorEvent): void => {
      finish(() =>
        reject(new Error(event.message || "Point-data Worker failed.")),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", message, { once: true });
    worker.addEventListener("error", error, { once: true });
    worker.postMessage({ type: "load", datasetId, url });
  });
}
