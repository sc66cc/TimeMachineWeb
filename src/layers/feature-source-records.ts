import type { PlateFeature } from "@timemachine/reconstruction-core";
import type { LoadedPointDataset, PointRecord } from "../../packages/point-runtime/src/types";
import { readPointRecord } from "../../packages/point-runtime/src/wgp-format";
import { AgentActionValidationError } from "../agent-actions/registry";

export type PointFeatureAttributes = { datasetId: string } & { [K in keyof PointRecord]: PointRecord[K] };
export type PlateFeatureAttributes = Pick<PlateFeature, "id" | "name" | "description" | "plateId" | "validFromMa" | "validToMa" | "sourceIndex">;

function encodedDatasetId(datasetId: string): string {
  if (typeof datasetId !== "string" || !datasetId.trim()) {
    throw new AgentActionValidationError("A point feature requires a nonempty dataset ID.");
  }
  try {
    return encodeURIComponent(datasetId);
  } catch {
    throw new AgentActionValidationError("Point dataset ID contains invalid Unicode.");
  }
}

/** Source identity is exact: no whitespace trimming or Unicode normalization. */
export function createPointFeatureId(datasetId: string, rowId: number): string {
  if (!Number.isSafeInteger(rowId) || rowId < 0) {
    throw new AgentActionValidationError("Point row ID must be a nonnegative safe integer.");
  }
  return `wgp:${encodedDatasetId(datasetId)}:row:${rowId}`;
}

/** Validate against the currently loaded header before reading any record bytes. */
export function parsePointFeatureId(featureId: string, dataset: LoadedPointDataset): number {
  const prefix = `wgp:${encodedDatasetId(dataset.datasetId)}:row:`;
  if (typeof featureId !== "string" || !featureId.startsWith(prefix)) {
    throw new AgentActionValidationError("Point feature ID does not match the loaded dataset.");
  }
  const rowText = featureId.slice(prefix.length);
  const rowId = Number(rowText);
  if (rowText.length > 16 || !Number.isSafeInteger(rowId) || rowId < 0
    || String(rowId) !== rowText) {
    throw new AgentActionValidationError("Point feature ID must use a canonical nonnegative row number.");
  }
  const pointCount = dataset.header.pointCount;
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new Error("Loaded point dataset has an invalid point count.");
  }
  if (rowId >= pointCount) {
    throw new AgentActionValidationError("Point feature row is outside the loaded dataset.");
  }
  return rowId;
}

/** Only WGP's actual record fields plus datasetId, not the original PBDB row. */
export function readPointFeatureAttributes(dataset: LoadedPointDataset, featureId: string): PointFeatureAttributes {
  const rowId = parsePointFeatureId(featureId, dataset);
  return { datasetId: dataset.datasetId, ...readPointRecord(dataset.buffer, rowId) };
}

/** Keep source infinities/NaN intact; the bounded attribute summary encodes them. */
export function projectPlateFeatureAttributes(feature: PlateFeature): PlateFeatureAttributes {
  const { id, name, description, plateId, validFromMa, validToMa, sourceIndex } = feature;
  return { id, name, description, plateId, validFromMa, validToMa, sourceIndex };
}
