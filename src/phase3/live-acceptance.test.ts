/**
 * Live acceptance against a running local Server. Skipped unless
 * TIMEMACHINE_LIVE_ACCEPTANCE=1, so CI stays hermetic.
 *
 * Exercises the browser transport itself (RPCInvoker + generated invokers), the complete
 * upload → ingest → manifest → WGP1 chain, deduplication, cancel, and end-to-end verification.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { RPCInvoker } from "@timemachine/api-client";
import {
	DatasetGeometryType,
	DatasetIngestRequestVO,
	DatasetUploadRequestVO,
	LoginMailInvoker,
	ProcessingJobStatus,
	SystemOpenAPIInvoker,
	TimeMachineCatalogInvoker,
	TimeMachineIngestInvoker,
	TimeMachineWorkspaceInvoker,
	ViFKey,
} from "@timemachine/generated-api";
import { md5HexOfBlob } from "./md5";

const BASE_URL =
	process.env.TIMEMACHINE_LIVE_BASE_URL ?? "http://127.0.0.1:5130";
const LIVE = process.env.TIMEMACHINE_LIVE_ACCEPTANCE === "1";
const ACCOUNT_EMAIL =
	process.env.TIMEMACHINE_LIVE_EMAIL ?? "acceptance@local.test";

// Small test CSV: 5 rows with coordinates and ages (max_ma >= min_ma, older to younger).
// The 6th row carries a unique probe so every live run exercises the real upload→ingest
// pipeline instead of being reused by the server's input-hash idempotency path.
function buildUniqueTestCsv(): string {
	const probe = `-179.9,-89.9,${(12.345 + Math.floor(Math.random() * 1e6) / 1e6).toFixed(6)},${(
		10 + Math.floor(Math.random() * 1e6) / 1e6
	).toFixed(6)},1`;
	return [
		"lng,lat,max_ma,min_ma,occurrences",
		"-73.5,45.5,100.0,90.0,3",
		"10.0,51.0,200.0,180.0,1",
		"120.0,-33.0,50.0,40.0,5",
		"-100.0,30.0,300.0,270.0,2",
		probe,
	].join("\n");
}

// Minimal CSV for cancel test (different content to avoid dedup with A)
const TEST_CSV_B = [
	"lng,lat,max_ma,min_ma",
	"15.0,10.0,160.0,140.0",
	"25.0,20.0,260.0,240.0",
].join("\n");

function enumValue(value: number | { Value: number }): number {
	return typeof value === "number" ? value : value.Value;
}

function foreignKeyValue(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "object" && value !== null && "Value" in value)
		return (value as { Value: number }).Value;
	return 0;
}

function requireData<T>(result: {
	Code: number;
	Data?: T;
	Message: string;
}): T {
	if (result.Code !== 200 || result.Data === undefined) {
		throw new Error(`RPC failed (${result.Code}): ${result.Message}`);
	}
	return result.Data;
}

function requireSuccess(result: { Code: number; Message: string }): void {
	if (result.Code !== 200)
		throw new Error(`RPC failed (${result.Code}): ${result.Message}`);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadCsvAndCreateJob(
	csvContent: string,
	name: string,
	plateModelId: number,
): Promise<number> {
	const blob = new Blob([csvContent], { type: "text/csv" });
	const md5 = await md5HexOfBlob(blob);

	const uploadReq = new DatasetUploadRequestVO();
	uploadReq.FileName = `${name}.csv`;
	uploadReq.MD5 = md5;
	uploadReq.Extention = "csv";
	uploadReq.Size = blob.size;

	const ticket = requireData(
		await TimeMachineIngestInvoker.CreateDatasetUpload(uploadReq),
	);

	if (!ticket.AlreadyUploaded) {
		const r = await fetch(ticket.UploadURL, {
			method: "PUT",
			headers: { "Content-Type": "text/csv" },
			body: blob,
		});
		if (!r.ok) throw new Error(`Upload PUT failed: ${r.status}`);
		requireSuccess(
			await TimeMachineIngestInvoker.CompleteDatasetUpload(
				new ViFKey(foreignKeyValue(ticket.OssFile)),
			),
		);
	}

	const ingestReq = new DatasetIngestRequestVO();
	ingestReq.Name = name;
	ingestReq.Description = "live acceptance test";
	ingestReq.SourceOssFile.Value = foreignKeyValue(ticket.OssFile);
	ingestReq.PlateModel.Value = plateModelId;
	ingestReq.GeometryType.Value = DatasetGeometryType.Point;
	ingestReq.Mapping.LongitudeColumn = "lng";
	ingestReq.Mapping.LatitudeColumn = "lat";
	// AgeStart is the older bound; the reader rejects rows where validFromMa < validToMa.
	ingestReq.Mapping.AgeStartColumn = "max_ma";
	ingestReq.Mapping.AgeEndColumn = "min_ma";
	ingestReq.Mapping.OccurrenceColumn = "occurrences";
	ingestReq.Mapping.PlateIDColumn = "";

	const created = requireData(
		await TimeMachineIngestInvoker.CreateDatasetIngestJob(ingestReq),
	);
	return foreignKeyValue(created.Job.ID);
}

async function pollJobUntilTerminal(jobId: number, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(1000);
		const job = requireData(
			await TimeMachineIngestInvoker.GetJob(new ViFKey(jobId)),
		);
		const status = enumValue(job.Status);
		if (
			status === ProcessingJobStatus.Succeeded ||
			status === ProcessingJobStatus.Failed ||
			status === ProcessingJobStatus.Cancelled
		) {
			return job;
		}
	}
	throw new Error(
		`Job ${jobId} did not reach terminal state within ${timeoutMs}ms`,
	);
}

describe.skipIf(!LIVE)("live point ingest acceptance", () => {
	let accessToken = "";
	let plateModelId = 0;
	// Shared across the chain test (which uploads it) and the dedup test (which
	// re-requests the same content hash). Random probe keeps each live run real.
	const uniqueCsv = buildUniqueTestCsv();

	beforeAll(async () => {
		RPCInvoker.Configure({
			baseUrl: BASE_URL,
			getAccessToken: () => accessToken || null,
		});

		const LOGIN_CODE = process.env.TIMEMACHINE_LIVE_CODE ?? "123456";
		const mailResult = await LoginMailInvoker.SendMailCode(ACCOUNT_EMAIL);
		if (mailResult.Code !== 200)
			throw new Error(
				`SendMailCode failed (${mailResult.Code}): ${mailResult.Message}`,
			);

		const prepareResult = await LoginMailInvoker.Prepare(
			ACCOUNT_EMAIL,
			LOGIN_CODE,
		);
		if (prepareResult.Code !== 200)
			throw new Error(
				`Prepare failed (${prepareResult.Code}): ${prepareResult.Message}`,
			);

		const account = requireData(
			await LoginMailInvoker.Login(ACCOUNT_EMAIL, LOGIN_CODE),
		);
		accessToken = account.Token;

		const models = requireData(
			await TimeMachineIngestInvoker.DisplayIngestPlateModels(),
		);
		const usable = models.filter((m) => m.PlatePolygonCount > 0);
		if (!usable[0]) throw new Error("No usable plate model found");
		plateModelId = foreignKeyValue(usable[0].PlateModel);
	}, 60_000);

	it("lists ingest plate models over the JSON transport", async () => {
		const models = requireData(
			await TimeMachineIngestInvoker.DisplayIngestPlateModels(),
		);
		expect(models.length).toBeGreaterThan(0);
		const usable = models.filter((model) => model.PlatePolygonCount > 0);
		const first = usable[0];
		expect(first).toBeDefined();
		expect(first?.Name.length).toBeGreaterThan(0);
	});

	it("exposes the published dataset version with a readable manifest", async () => {
		const versions = requireData(
			await TimeMachineCatalogInvoker.DisplayPublicDatasetVersions(
				new ViFKey(0),
			),
		);
		const entry = versions[0];
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(enumValue(entry.Version.Status as never)).toBe(2);
		expect(entry.Version.RowCount).toBeGreaterThan(0);
		expect(entry.Manifest.AccessToken.length).toBeGreaterThan(0);
	});

	it("runs full upload → ingest → manifest → WGP1 chain", async () => {
		const jobId = await uploadCsvAndCreateJob(
			uniqueCsv,
			"live-acceptance-chain",
			plateModelId,
		);
		expect(jobId).toBeGreaterThan(0);

		const job = await pollJobUntilTerminal(jobId);
		expect(enumValue(job.Status)).toBe(ProcessingJobStatus.Succeeded);

		const versionId = foreignKeyValue(job.DatasetVersion);
		expect(versionId).toBeGreaterThan(0);

		// Retrieve the manifest access token from the workspace catalog
		const allVersions = requireData(
			await TimeMachineWorkspaceInvoker.DisplayDatasetVersions(new ViFKey(0)),
		);
		const versionEntry = allVersions.find(
			(v) => foreignKeyValue(v.Version.ID) === versionId,
		);
		expect(versionEntry).toBeDefined();
		const manifestAccessToken = versionEntry!.Manifest.AccessToken;
		expect(manifestAccessToken.length).toBeGreaterThan(0);

		const manifestUrl = requireData(
			await SystemOpenAPIInvoker.GetOssURL(manifestAccessToken),
		);
		// Manifest URL must resolve to local server
		expect(manifestUrl.startsWith("http://127.0.0.1")).toBe(true);

		// Fetch and parse manifest JSON
		// eslint-disable-next-line no-restricted-syntax -- intentional localhost fetch in acceptance test
		const manifestResp = await fetch(manifestUrl);
		expect(manifestResp.ok).toBe(true);
		const manifest = await manifestResp.json();
		expect(manifest.basePointCount).toBeGreaterThan(0);
		expect(manifest.source.plateModelId).toBe(plateModelId);
		expect(Array.isArray(manifest.datasets)).toBe(true);
		expect(manifest.datasets.length).toBeGreaterThan(0);
		expect(manifest.datasets[0].activeCountsByIntegerMa).toHaveLength(1101);

		// The manifest must store a stable relative asset path, never an absolute signed URL.
		const storedDatasetUrl = manifest.datasets[0].url as string;
		expect(storedDatasetUrl).not.toMatch(/^https?:\/\//);
		expect(storedDatasetUrl).toMatch(/\.wgp$/);

		// Exchange the relative path for a short-lived URL via GetManifestAssetURL.
		const wgpUrl = requireData(
			await SystemOpenAPIInvoker.GetManifestAssetURL(
				manifestAccessToken,
				storedDatasetUrl,
			),
		);
		expect(wgpUrl.startsWith("http://127.0.0.1")).toBe(true);
		// eslint-disable-next-line no-restricted-syntax -- intentional localhost fetch in acceptance test
		const wgpResp = await fetch(wgpUrl);
		expect(wgpResp.ok).toBe(true);
		const wgpBuffer = await wgpResp.arrayBuffer();

		// WGP1 header: magic[4] version[4] headerBytes[4] recordStride[4] pointCount[4] ...
		expect(wgpBuffer.byteLength).toBeGreaterThan(64);
		// Use DataView.getUint8 (returns number) rather than Uint8Array indexing
		// (returns number|undefined under noUncheckedIndexedAccess)
		const headerView = new DataView(wgpBuffer);
		const magic = String.fromCharCode(
			headerView.getUint8(0),
			headerView.getUint8(1),
			headerView.getUint8(2),
			headerView.getUint8(3),
		);
		expect(magic).toBe("WGP1");

		const view = headerView;
		expect(view.getUint32(4, true)).toBe(1); // version
		expect(view.getUint32(8, true)).toBe(64); // headerBytes
		expect(view.getUint32(12, true)).toBe(20); // recordStride
		const pointCount = view.getUint32(16, true);
		expect(pointCount).toBe(manifest.basePointCount);

		// Payload size matches declared point count
		expect(wgpBuffer.byteLength).toBe(64 + pointCount * 20);
	}, 120_000);

	it("deduplicates uploads with the same content hash", async () => {
		// Upload the same CSV again - should get AlreadyUploaded = true
		const blob = new Blob([uniqueCsv], { type: "text/csv" });
		const md5 = await md5HexOfBlob(blob);

		const uploadReq = new DatasetUploadRequestVO();
		uploadReq.FileName = "live-acceptance-dedup.csv";
		uploadReq.MD5 = md5;
		uploadReq.Extention = "csv";
		uploadReq.Size = blob.size;

		const ticket = requireData(
			await TimeMachineIngestInvoker.CreateDatasetUpload(uploadReq),
		);
		expect(ticket.AlreadyUploaded).toBe(true);
	}, 30_000);

	it("cancels a queued job before processing or accepts Succeeded on race", async () => {
		const jobId = await uploadCsvAndCreateJob(
			TEST_CSV_B,
			"live-acceptance-cancel",
			plateModelId,
		);
		expect(jobId).toBeGreaterThan(0);

		// Attempt immediate cancel — worker may or may not have picked it up yet
		const cancelResult = await TimeMachineIngestInvoker.CancelJob(
			new ViFKey(jobId),
		);
		// CancelJob returns 200 + updated job when successful, or non-200 if already terminal
		if (cancelResult.Code === 200) {
			const job = await pollJobUntilTerminal(jobId);
			const finalStatus = enumValue(job.Status);
			// Either Cancelled (cancel won) or Succeeded (worker finished first)
			expect(
				finalStatus === ProcessingJobStatus.Cancelled ||
					finalStatus === ProcessingJobStatus.Succeeded,
			).toBe(true);
		} else {
			// Non-200 means the job was already in a terminal state — verify the code is reasonable
			expect([400, 403, 422]).toContain(cancelResult.Code);
		}
	}, 120_000);
});
