import { AgentActionUnsupportedError } from "../agent-actions/registry";
import { SYNTHETIC_POINT_SOURCE, SYNTHETIC_LINE_SOURCE, SYNTHETIC_POLYGON_SOURCE } from "./instance-actions";
import type { VectorLayerSource } from "./vector-bindings";
import { OperationInterruptedError } from "../agent-actions/operation";

const readFixture = async (): Promise<string> => (await import("../../data/goal-fixtures/vectors.geojson?raw")).default;

/** Import transport cannot be aborted, but no source consumer must wait on it forever. */
function readFixtureText(signal: AbortSignal | undefined, read: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error !== undefined) reject(error); else resolve(text!);
    };
    const cancel = (): void => finish(signal?.reason instanceof OperationInterruptedError ? signal.reason : new OperationInterruptedError("cancelled"));
    const timer = setTimeout(() => finish(new Error("Synthetic vector source did not load within 30 seconds.")), 30_000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    // Both handlers stay attached after cancellation: a late chunk is discarded
    // without creating a native layer, and its rejection remains consumed.
    try { void read().then(text => finish(undefined, text), error => finish(error)); }
    catch (error) { finish(error); }
  });
}

/** Explicit synthetic source, loaded on demand; never a failed-service fallback. */
export async function loadSyntheticPointSource(sourceRef: string, signal?: AbortSignal, read: () => Promise<string> = readFixture): Promise<VectorLayerSource> {
  if (sourceRef !== SYNTHETIC_POINT_SOURCE) throw new AgentActionUnsupportedError("Unknown synthetic point source.");
  return loadSyntheticVectorSource(sourceRef, signal, read);
}

export async function loadSyntheticVectorSource(sourceRef: string, signal?: AbortSignal, read: () => Promise<string> = readFixture): Promise<VectorLayerSource> {
  if (![SYNTHETIC_POINT_SOURCE, SYNTHETIC_LINE_SOURCE, SYNTHETIC_POLYGON_SOURCE].includes(sourceRef)) throw new AgentActionUnsupportedError("Unknown synthetic vector source.");
  const kind = sourceRef === SYNTHETIC_POLYGON_SOURCE ? "polygon" : sourceRef === SYNTHETIC_LINE_SOURCE ? "line" : "point";
  const raw = await readFixtureText(signal, read);
  const collection = JSON.parse(raw) as { features: { id: string; geometry: { type: string } }[] };
  const ids = kind === "polygon" ? ["ordinary-polygon", "polygon-hole", "seam-polygon", "split-seam-multipolygon", "polar-polygon", "reversed-winding-polygon"]
    : kind === "line" ? ["ordinary-line", "seam-line", "multiple-lines"] : ["origin", "origin-other-id", "world-points"];
  const types = kind === "polygon" ? ["Polygon", "MultiPolygon"] : kind === "line" ? ["LineString", "MultiLineString"] : ["Point", "MultiPoint"];
  const features = ids.map(id => {
    const matches = collection.features.filter(feature => feature.id === id);
    if (matches.length !== 1 || !types.includes(matches[0]!.geometry.type)) {
      throw new Error(`Synthetic vector fixture entry ${id} is missing, duplicate or has changed geometry.`);
    }
    return matches[0]!;
  });
  return { sourceRef, kind, geojson: { type: "FeatureCollection", features } };
}
