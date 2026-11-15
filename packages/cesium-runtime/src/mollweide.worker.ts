import { BoundingSphere, Cartesian3, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, GeometryAttributes, Matrix3, Matrix4, PrimitiveType, Quaternion } from "@cesium/engine";
import type { MollweideWorkerRequest, MollweideWorkerReply } from "./mollweide-worker-client";
import type { PlatePolygonMeshSnapshot } from "./plate-mesh-snapshot";

// The app's Cesium plugin externalizes `cesium` imports. Supply only the CPU
// public exports in this worker realm, before loading the shared production algorithm.
Object.assign(globalThis, { Cesium: { BoundingSphere, Cartesian3, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, GeometryAttributes, Matrix3, Matrix4, PrimitiveType, Quaternion } });
const runtimeReady = Promise.all([import("./plate-mollweide-frame"), import("./mollweide-worker-packet")]);
let snapshots: readonly PlatePolygonMeshSnapshot[] | undefined;
let busy = false;
let lastFinished: number | undefined;
// SAFETY: Vite loads this entry only as a dedicated Worker. The shared DOM
// tsconfig types self as Window; this view exposes only the Worker's message port.
const port = self as unknown as {
  onmessage: ((event: MessageEvent<MollweideWorkerRequest>) => void) | null;
  postMessage(reply: MollweideWorkerReply, transfers?: Transferable[]): void;
};
port.onmessage = async ({ data }) => {
  if (data.kind === "init") {
    if (!snapshots && !busy) snapshots = data.snapshots;
    return;
  }
  if (busy) { port.postMessage({ ticket: data.ticket, error: "Mollweide worker already preparing a frame." }); return; }
  busy = true;
  try {
    const [{ buildMollweidePlateCpuFrame }, { packMollweideFrame }] = await runtimeReady;
    if (!snapshots) throw new Error("Mollweide worker not initialized.");
    const start = performance.now();
    const idleMs = lastFinished === undefined ? 0 : start - lastFinished;
    const frame = await buildMollweidePlateCpuFrame(snapshots, data.age, new Map(data.rotations), new AbortController().signal);
    const prepared = performance.now();
    const { packet, transfers } = packMollweideFrame(frame, snapshots);
    const sent = performance.now();
    port.postMessage({ ticket: data.ticket, packet, prepareMs: prepared - start, packMs: sent - prepared, sentEpochMs: performance.timeOrigin + sent, idleMs }, transfers);
    lastFinished = performance.now();
  } catch (error) {
    port.postMessage({ ticket: data.ticket, error: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
