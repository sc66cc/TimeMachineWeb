import {
  DatasetGeometryType,
  DatasetIngestRequestVO,
  DatasetUploadRequestVO,
  ProcessingJobStatus,
  TimeMachineIngestInvoker,
  ViFKey,
  type DatasetIngestJobRO,
  type ProcessingJobRO,
} from "@timemachine/generated-api";

import { md5HexOfBlob } from "./md5";

export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ["csv", "tsv", "txt"] as const;
const POLL_INTERVAL_MS = 1200;

export interface ColumnMapping {
  ageEndColumn: string;
  ageStartColumn: string;
  latitudeColumn: string;
  longitudeColumn: string;
  occurrenceColumn: string;
  plateIdColumn: string;
}

export interface IngestProgress {
  message: string;
  progress: number;
  stage: string;
}

export interface IngestOutcome {
  datasetVersionId: number;
  job: ProcessingJobRO;
}

function requireData<T>(result: {
  Code: number;
  Data?: T;
  Message: string;
}): T {
  if (result.Code !== 200 || result.Data === undefined) {
    throw new Error(result.Message || `Server request failed (${result.Code}).`);
  }
  return result.Data;
}

function requireSuccess(result: { Code: number; Message: string }): void {
  if (result.Code !== 200) {
    throw new Error(result.Message || `Server request failed (${result.Code}).`);
  }
}

function foreignKeyValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "Value" in value &&
    typeof (value as { Value: unknown }).Value === "number"
  ) {
    return (value as { Value: number }).Value;
  }
  return 0;
}

function enumValue(value: unknown): number {
  return foreignKeyValue(value);
}

export function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : "";
}

export function validateSourceFile(file: File): string {
  if (file.size <= 0) {
    return "The file is empty.";
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return `The file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is 256 MB.`;
  }
  const extension = fileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension as (typeof ALLOWED_EXTENSIONS)[number])) {
    return "Only csv, tsv, and txt sources are supported.";
  }
  return "";
}

export function validateMapping(mapping: ColumnMapping): string {
  if (!mapping.longitudeColumn || !mapping.latitudeColumn) {
    return "Longitude and latitude columns are required.";
  }
  const hasStart = Boolean(mapping.ageStartColumn);
  const hasEnd = Boolean(mapping.ageEndColumn);
  if (hasStart !== hasEnd) {
    return "Map both age columns, or neither.";
  }
  return "";
}

async function putSource(
  uploadUrl: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  // XHR is used over fetch purely for upload progress events on a 256 MB PUT.
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl, true);
    request.setRequestHeader("Content-Type", "text/csv");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      reject(new Error(`Upload rejected by storage (HTTP ${request.status}).`));
    });
    request.addEventListener("error", () =>
      reject(new Error("Upload failed; the storage endpoint is unreachable.")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("Upload was cancelled.")),
    );
    request.send(file);
  });
}

/**
 * Uploads the CSV, queues the ingest job, and resolves once the worker finishes.
 * Rejects with the worker's ErrorCode/ErrorMessage when the job fails, so no half-ready
 * dataset is ever reported as usable.
 */
export async function ingestPointCsv(options: {
  description: string;
  file: File;
  mapping: ColumnMapping;
  name: string;
  onJobCreated?: (jobId: number) => void;
  onProgress: (progress: IngestProgress) => void;
  plateModelId: number;
  signal?: AbortSignal;
}): Promise<IngestOutcome> {
  const { description, file, mapping, name, onProgress, plateModelId } = options;

  const fileError = validateSourceFile(file);
  if (fileError) {
    throw new Error(fileError);
  }
  const mappingError = validateMapping(mapping);
  if (mappingError) {
    throw new Error(mappingError);
  }
  if (plateModelId <= 0) {
    throw new Error("Select a plate model before ingesting.");
  }

  onProgress({ message: "Hashing the file…", progress: 0.02, stage: "hash" });
  const md5 = await md5HexOfBlob(file);

  const uploadRequest = new DatasetUploadRequestVO();
  uploadRequest.FileName = file.name;
  uploadRequest.MD5 = md5;
  uploadRequest.Extention = fileExtension(file.name);
  uploadRequest.Size = file.size;

  onProgress({ message: "Reserving storage…", progress: 0.08, stage: "ticket" });
  const ticket = requireData(
    await TimeMachineIngestInvoker.CreateDatasetUpload(uploadRequest),
  );
  const ossFileId = foreignKeyValue(ticket.OssFile);

  if (!ticket.AlreadyUploaded) {
    onProgress({ message: "Uploading…", progress: 0.1, stage: "upload" });
    await putSource(ticket.UploadURL, file, (fraction) => {
      onProgress({
        message: `Uploading… ${Math.round(fraction * 100)}%`,
        progress: 0.1 + fraction * 0.35,
        stage: "upload",
      });
    });
    onProgress({ message: "Verifying the upload…", progress: 0.46, stage: "verify" });
    requireSuccess(
      await TimeMachineIngestInvoker.CompleteDatasetUpload(new ViFKey(ossFileId)),
    );
  } else {
    onProgress({
      message: "This content was already stored; skipping the upload.",
      progress: 0.46,
      stage: "verify",
    });
  }

  const ingestRequest = new DatasetIngestRequestVO();
  ingestRequest.Name = name.trim();
  ingestRequest.Description = description;
  ingestRequest.SourceOssFile.Value = ossFileId;
  ingestRequest.PlateModel.Value = plateModelId;
  ingestRequest.GeometryType.Value = DatasetGeometryType.Point;
  ingestRequest.Mapping.LongitudeColumn = mapping.longitudeColumn;
  ingestRequest.Mapping.LatitudeColumn = mapping.latitudeColumn;
  ingestRequest.Mapping.AgeStartColumn = mapping.ageStartColumn;
  ingestRequest.Mapping.AgeEndColumn = mapping.ageEndColumn;
  ingestRequest.Mapping.OccurrenceColumn = mapping.occurrenceColumn;
  ingestRequest.Mapping.PlateIDColumn = mapping.plateIdColumn;

  onProgress({ message: "Queueing the ingest job…", progress: 0.5, stage: "queue" });
  const created: DatasetIngestJobRO = requireData(
    await TimeMachineIngestInvoker.CreateDatasetIngestJob(ingestRequest),
  );
  const jobId = foreignKeyValue(created.Job.ID);
  const datasetVersionId = foreignKeyValue(created.DraftVersion.ID);
  // The caller needs the ID before the wait so a cancel mid-run can reach the job.
  options.onJobCreated?.(jobId);

  const job = await waitForJob(jobId, onProgress, options.signal);
  return { datasetVersionId, job };
}

export async function waitForJob(
  jobId: number,
  onProgress: (progress: IngestProgress) => void,
  signal?: AbortSignal,
): Promise<ProcessingJobRO> {
  for (;;) {
    if (signal?.aborted) {
      throw new Error("Tracking was cancelled; the job keeps running on the server.");
    }
    const job = requireData(
      await TimeMachineIngestInvoker.GetJob(new ViFKey(jobId)),
    );
    const status = enumValue(job.Status);
    // The server progress covers the pipeline; the client half of the bar ends at 0.5.
    onProgress({
      message: job.Stage ? `Processing: ${job.Stage}` : "Processing…",
      progress: 0.5 + Math.max(0, Math.min(1, job.Progress)) * 0.5,
      stage: job.Stage || "processing",
    });
    if (status === ProcessingJobStatus.Succeeded) {
      onProgress({ message: "Ready.", progress: 1, stage: "done" });
      return job;
    }
    if (status === ProcessingJobStatus.Failed) {
      throw new Error(
        job.ErrorMessage
          ? `${job.ErrorCode}: ${job.ErrorMessage}`
          : `Ingest failed (${job.ErrorCode || "unknown"}).`,
      );
    }
    if (status === ProcessingJobStatus.Cancelled) {
      throw new Error("The ingest job was cancelled.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function cancelJob(jobId: number): Promise<void> {
  requireSuccess(await TimeMachineIngestInvoker.CancelJob(new ViFKey(jobId)));
}
