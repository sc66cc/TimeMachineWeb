import type { Quaternion } from "@timemachine/reconstruction-core";
import type { PlatePolygonMeshSnapshot } from "./plate-mesh-snapshot";
import { unpackMollweideFrame, type MollweideFramePacket } from "./mollweide-worker-packet";
import type { MollweideCpuFrame } from "./plate-mollweide-frame";

export type MollweideWorkerRequest = { kind: "init"; snapshots: readonly PlatePolygonMeshSnapshot[] } | { kind: "frame"; ticket: number; age: number; rotations: [number, Quaternion][] };
export type MollweideWorkerReply = { ticket: number; error: string } | { ticket: number; packet: MollweideFramePacket; prepareMs: number; packMs: number; sentEpochMs: number; idleMs: number };
export interface MollweideWorkerTransport {
  postMessage(message: MollweideWorkerRequest): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  terminate(): void;
}

/** One model, one worker, one active job. Cancellation terminates rather than leaking a busy worker. */
export class MollweideWorkerClient {
  private worker: MollweideWorkerTransport | undefined;
  private ticket = 0;
  private active: { reject: (error: Error) => void; cleanup: () => void } | undefined;
  lastTiming: { prepareMs: number; packMs: number; roundTripMs: number; receiveMs: number; transferMs: number; idleMs: number } | undefined;
  constructor(private readonly snapshots: readonly PlatePolygonMeshSnapshot[], private readonly createWorker: () => MollweideWorkerTransport = () => new Worker(new URL("./mollweide.worker.ts", import.meta.url), { type: "module" })) {}

  prepare(age: number, rotations: ReadonlyMap<number, Quaternion>, signal: AbortSignal): Promise<MollweideCpuFrame> {
    if (signal.aborted) return Promise.reject(new DOMException("Mollweide preparation aborted", "AbortError"));
    if (this.active) return Promise.reject(new Error("Mollweide worker already preparing a frame."));
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        // Structured clone copies buffers; the retained main-thread source must never be transferred.
        this.worker.postMessage({ kind: "init", snapshots: this.snapshots });
      }
    } catch (error) { this.dispose(); return Promise.reject(error); }
    const worker = this.worker;
    const ticket = ++this.ticket;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", failure);
        worker.removeEventListener("messageerror", failure);
        signal.removeEventListener("abort", abort);
        this.active = undefined;
      };
      const fail = (error: Error): void => { cleanup(); this.dispose(); reject(error); };
      const message: EventListener = event => {
        const reply = (event as MessageEvent<MollweideWorkerReply>).data;
        if (reply.ticket !== ticket || this.worker !== worker) return;
        if ("error" in reply) { fail(new Error(reply.error)); return; }
        try {
          const received = performance.now();
          const frame = unpackMollweideFrame(reply.packet, this.snapshots);
          this.lastTiming = { prepareMs: reply.prepareMs, packMs: reply.packMs, roundTripMs: received - started, receiveMs: performance.now() - received, transferMs: Math.max(0, performance.timeOrigin + received - reply.sentEpochMs), idleMs: reply.idleMs };
          cleanup(); resolve(frame);
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      const failure: EventListener = () => fail(new Error("Mollweide worker transport failed."));
      const abort = (): void => fail(new DOMException("Mollweide preparation aborted", "AbortError"));
      // A lost worker must settle; this is not a frame-rate deadline.
      const timeout = setTimeout(() => fail(new Error("Mollweide worker did not respond within 60 seconds.")), 60000);
      this.active = { reject, cleanup };
      worker.addEventListener("message", message);
      worker.addEventListener("error", failure);
      worker.addEventListener("messageerror", failure);
      signal.addEventListener("abort", abort, { once: true });
      try { worker.postMessage({ kind: "frame", ticket, age, rotations: [...rotations] }); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  dispose(): void {
    const active = this.active;
    active?.cleanup();
    this.worker?.terminate();
    this.worker = undefined;
    active?.reject(new DOMException("Mollweide worker disposed", "AbortError"));
  }
}
