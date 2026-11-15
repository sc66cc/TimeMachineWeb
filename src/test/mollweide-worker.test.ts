import { describe, expect, it, vi } from "vitest";
import type { PlateFeature } from "@timemachine/reconstruction-core";
import { triangulatePlatePolygon } from "../../packages/cesium-runtime/src/geometry";
import { capturePlatePolygonMesh } from "../../packages/cesium-runtime/src/plate-mesh-snapshot";
import { buildMollweidePlateCpuFrame } from "../../packages/cesium-runtime/src/plate-mollweide-frame";
import { packMollweideFrame, unpackMollweideFrame } from "../../packages/cesium-runtime/src/mollweide-worker-packet";
import { MollweideWorkerClient, type MollweideWorkerRequest, type MollweideWorkerTransport } from "../../packages/cesium-runtime/src/mollweide-worker-client";

class Transport extends EventTarget implements MollweideWorkerTransport {
  messages: MollweideWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: MollweideWorkerRequest) { this.messages.push(structuredClone(message)); }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  count = 0;
  override addEventListener(type: string, fn: EventListener) { this.count++; super.addEventListener(type, fn); }
  override removeEventListener(type: string, fn: EventListener) { this.count--; super.removeEventListener(type, fn); }
}
const rotations = new Map([[1, { x: 0, y: 0, z: 0, w: 1 }]]);
function fixture() {
  const feature: PlateFeature = { id: "worker-source", plateId: 1, name: "fixture", description: "", sourceIndex: 0, validFromMa: 4500, validToMa: -1,
    polygons: [{ exterior: [[0,0],[5,0],[5,5],[0,0]], holes: [] }] };
  return capturePlatePolygonMesh(feature, 0, triangulatePlatePolygon(feature.polygons[0]!).geometry);
}
async function packet(source = fixture()) {
  return packMollweideFrame(await buildMollweidePlateCpuFrame([source], 100, rotations, new AbortController().signal), [source]);
}

describe("production Mollweide worker transport", () => {
  it("transfers frame buffers without detaching retained sources and rebinds the original pick feature", async () => {
    const source = fixture();
    const { packet: data, transfers } = await packet(source);
    const original = data.plates[0]!.polygons[0]!.positions;
    const coordinates = Array.from(original);
    const indices = Array.from(data.plates[0]!.polygons[0]!.indices);
    const received = structuredClone(data, { transfer: transfers });
    expect(original.byteLength).toBe(0);
    expect(source.positions.byteLength).toBeGreaterThan(0);
    expect(source.indices.byteLength).toBeGreaterThan(0);
    const frame = unpackMollweideFrame(received, [source]);
    expect(frame.plates[0]!.polygons[0]!.pick.feature).toBe(source.feature);
    expect(frame.plates[0]!.polygons[0]!.feature).toBe(source.feature);
    expect(frame.plates[0]!.polygons[0]!.geometry.attributes.position!.values).toBe(received.plates[0]!.polygons[0]!.positions);
    expect(Array.from(frame.plates[0]!.polygons[0]!.geometry.attributes.position!.values)).toEqual(coordinates);
    expect(Array.from(frame.plates[0]!.polygons[0]!.geometry.indices!)).toEqual(indices);
    const outlines = frame.plates[0]!.polygons[0]!.outlineRings.flatMap(ring => ring.flatMap(p => [p.x,p.y,p.z]));
    expect(outlines).toEqual(Array.from(received.plates[0]!.polygons[0]!.outlines));
    expect(frame.timeState).toEqual(data.timeState);
    expect(frame.mollweideStats).toEqual(data.mollweideStats);
    expect(transfers).not.toContain(source.positions.buffer);
  });
  it("initializes once, sends only age/rotations/ticket for each frame and cleans listeners", async () => {
    const source = fixture(), worker = new Transport();
    const client = new MollweideWorkerClient([source], () => worker);
    const { packet: data } = await packet(source);
    for (let ticket = 1; ticket <= 2; ticket++) {
      const result = client.prepare(100, rotations, new AbortController().signal);
      const request = worker.messages.at(-1)!;
      expect(Object.keys(request).sort()).toEqual(["age", "kind", "rotations", "ticket"]);
      worker.reply({ ticket, packet: data, prepareMs: 1, packMs: 0, idleMs: 0, sentEpochMs: performance.timeOrigin + performance.now() });
      expect((await result).plates[0]!.polygons[0]!.feature).toBe(source.feature);
      expect(worker.count).toBe(0);
    }
    expect(worker.messages.filter(x => x.kind === "init")).toHaveLength(1);
    expect(source.positions.byteLength).toBeGreaterThan(0);
    client.dispose(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it.each(["error", "messageerror", "abort", "dispose"])("settles %s, ignores old tickets and recreates on explicit retry", async failure => {
    const workers: Transport[] = [];
    const source = fixture(), client = new MollweideWorkerClient([source], () => { const w = new Transport(); workers.push(w); return w; });
    const abort = new AbortController();
    const first = client.prepare(100, rotations, abort.signal);
    const rejected = expect(first).rejects.toThrow();
    const old = workers[0]!;
    if (failure === "abort") abort.abort();
    else if (failure === "dispose") client.dispose();
    else old.dispatchEvent(new Event(failure));
    await rejected;
    expect(old.count).toBe(0); expect(old.terminate).toHaveBeenCalledOnce();
    const second = client.prepare(101, rotations, new AbortController().signal);
    const { packet: data } = await packet(source);
    let settled = false; void second.then(() => { settled = true; });
    old.reply({ ticket: 1, packet: data });
    workers[1]!.reply({ ticket: 1, packet: data });
    await Promise.resolve(); expect(settled).toBe(false);
    workers[1]!.reply({ ticket: 2, packet: data, prepareMs: 1, packMs: 0, idleMs: 0, sentEpochMs: performance.timeOrigin + performance.now() });
    await second; expect(workers[1]!.count).toBe(0); client.dispose();
  });
  it("settles a silent worker and removes all listeners after the bounded liveness timeout", async () => {
    vi.useFakeTimers();
    try {
      const worker = new Transport(), client = new MollweideWorkerClient([], () => worker);
      const job = client.prepare(1, rotations, new AbortController().signal);
      const rejected = expect(job).rejects.toThrow("60 seconds");
      await vi.advanceTimersByTimeAsync(60000); await rejected;
      expect(worker.count).toBe(0); expect(worker.terminate).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("settles worker-reported algorithm errors and source initialization exceptions", async () => {
    const worker = new Transport(), client = new MollweideWorkerClient([], () => worker);
    const job = client.prepare(1, rotations, new AbortController().signal);
    const rejected = expect(job).rejects.toThrow("invalid geometry");
    worker.reply({ ticket: 1, error: "invalid geometry" }); await rejected;
    expect(worker.count).toBe(0); expect(worker.terminate).toHaveBeenCalledOnce();
    const broken = new Transport(); broken.postMessage = () => { throw new Error("clone failed"); };
    await expect(new MollweideWorkerClient([], () => broken).prepare(1, rotations, new AbortController().signal)).rejects.toThrow("clone failed");
    expect(broken.terminate).toHaveBeenCalledOnce();
  });
  it("rejects concurrent CPU jobs rather than queueing history", async () => {
    const worker = new Transport(), client = new MollweideWorkerClient([], () => worker);
    const active = client.prepare(1, rotations, new AbortController().signal);
    const aborted = expect(active).rejects.toThrow();
    await expect(client.prepare(2, rotations, new AbortController().signal)).rejects.toThrow("already preparing");
    client.dispose(); await aborted;
  });
});
