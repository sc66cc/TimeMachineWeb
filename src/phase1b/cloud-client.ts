import {
  AccountInvoker,
  GetPassword,
  LoginInvoker,
  LoginMailInvoker,
  LogoutInvoker,
  ProjectLayerType,
  SystemOpenAPIInvoker,
  TimeMachineCatalogInvoker,
  TimeMachineIngestInvoker,
  TimeMachineWorkspaceInvoker,
  ViFKey,
  type AccountRO,
  type DatasetVersionCatalogRO,
  type PlateModelIngestOptionRO,
  type PlateModelSimpleRO,
  type PlateModelVersionCatalogRO,
  type ProjectDocumentV2TO,
  type ProjectRevisionRO,
  type ProjectRevisionSummaryRO,
} from "@timemachine/generated-api";

import {
  bootstrapTimeMachinePlatform,
  getTimeMachineServerUrl,
  isTimeMachineServerConfigured,
  TIME_MACHINE_ACCESS_TOKEN_KEY,
} from "../platform-bootstrap";
import { RPCInvoker, RPCHttpError, RPCUploadStream, type RPCClientOptions, type RPCRequestOptions } from "@timemachine/api-client";
import { withRpcDiagnostics } from "../diagnostics/rpc-options";
import { AgentActionBusyError } from "../agent-actions/registry";
import { OperationInterruptedError } from "../agent-actions/operation";
import {
  commitOpenedProject,
  parseCloudProjectReference,
  readProjectCloudContext,
  updateProjectCloudContext,
  type ProjectCloudContext,
} from "../project/project-cloud-context";

import { SharedPlateModelClient } from "../plate-model/shared-plate-client";
import {
  applyPlateModelSource,
  plateModelSourceFromRef,
} from "../plate-model/plate-source";

const ACCOUNT_SESSION_KEY = "timemachine:web:phase1b-account";
const CLOUD_REFERENCE_KEY = "timemachine:web:phase1b-cloud-reference";
const RESOURCE_SELECTION_KEY = "timemachine:web:phase1b-resource-selection";

/** `ResourceAccessRange` mask the Unity client uses for its public catalog:
 *  Public (1) | Publish (2). */
export const PUBLIC_ACCESS_RANGE_MASK = 6;

/** `PageIndex.Size` contract maximum. */
const SHARED_PLATE_PAGE_SIZE = 100;

/** Guards the pagination loop against a server that keeps returning pages. */
const SHARED_PLATE_MAX_PAGES = 64;

export type SharedPlateCatalogStatus =
  | "idle"
  | "loading"
  | "ready"
  | "incomplete"
  | "error";

export interface CloudAccount {
  email: string;
  name: string;
  tokenExpiresAt: string;
}

export interface CloudProjectReference {
  accountEmail: string;
  contentHash: string;
  projectId: number;
  revisionId: number;
  revisionNumber: number;
}

export class CloudProjectSaveError extends Error {
  constructor(readonly reference: CloudProjectReference, readonly phase: "local-reference" | "workspace-refresh", cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cloud revision ${reference.revisionNumber} was saved, but ${phase === "local-reference" ? "its local reference could not be saved; open the cloud project before saving again" : "the workspace could not be refreshed"}: ${reason}`);
    this.name = "CloudProjectSaveError";
  }
}

export interface ResourceSelection {
  datasetVersionId: number;
  /** Shared (V1) plate model ID from `UserPlateModel`. Not a versioned ID. */
  plateModelId: number;
  /** Versioned (V2) plate model ID. Kept separate from `plateModelId`. */
  plateModelVersionId: number;
  /** Explicit opt-in to the built-in local demo model. Never set implicitly. */
  useLocalPlateModelDemo: boolean;
}

export interface RuntimeDataUrlOverrides {
  pointManifest?: string;
  /** Manifest access token; the loader exchanges relative asset paths through
   *  SystemOpenAPI.GetManifestAssetURL for short-lived URLs. */
  pointManifestAccessToken?: string;
  polygons?: string;
  rotations?: string;
}

export interface Phase1BState {
  account?: CloudAccount;
  /** Safe UI state; reading the template does not access or mutate storage. */
  cloudReference?: CloudProjectReference;
  projectContextError?: string;
  datasets: readonly DatasetVersionCatalogRO[];
  message: string;
  plateModels: readonly PlateModelVersionCatalogRO[];
  /** Ingest binds to this catalog directly, so no PlateModelVersion row has to exist. */
  plateModelCatalog: readonly PlateModelIngestOptionRO[];
  projects: readonly ProjectRevisionSummaryRO[];
  selection: ResourceSelection;
  /** Base URL of the connected Server, or "" when none is configured. */
  serverUrl: string;
  /** Shared (V1) plate models: public catalog plus the signed-in user's own. */
  sharedPlateModels: readonly PlateModelSimpleRO[];
  /** Separate from `message` so a real V1 catalog failure is never hidden by V2 noise. */
  sharedPlateModelsError: string;
  /** IDs that came from `DisplayMine`, so the UI can label them as the user's own. */
  sharedPlateModelsMineIds: readonly number[];
  sharedPlateModelsStatus: SharedPlateCatalogStatus;
  /** `PageRO.Total` reported by the server for the public query. */
  sharedPlateModelsTotal: number;
  status: "disabled" | "loading" | "signed-out" | "signed-in" | "error";
  /** False when the Server does not implement the TimeMachine V2 endpoints. */
  v2WorkspaceAvailable: boolean;
}

type Phase1BListener = (state: Phase1BState) => void;

interface ProjectOperationOwner {
  kind: "open" | "save";
  contextId: string | undefined;
  accountGeneration: number;
  accountEmail: string | undefined;
  reference: CloudProjectReference | undefined;
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface Phase1BCloudClientOptions {
  /** Injected for tests; defaults to `bootstrapTimeMachinePlatform`. */
  bootstrapPlatform?: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  sessionStorage?: StorageLike;
  sharedPlateClient?: SharedPlateModelClient;
  storage?: StorageLike;
}

class CloudRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message || `Server request failed (${code}).`);
    this.name = "CloudRpcError";
  }
}

function requireData<T>(result: {
  Code: number;
  Data?: T;
  Message: string;
}): T {
  if (result.Code !== 200 || result.Data === undefined) {
    throw new CloudRpcError(result.Code, result.Message);
  }
  return result.Data;
}

function requireSuccess(result: { Code: number; Message: string }): void {
  if (result.Code !== 200) {
    throw new Error(
      result.Message || `Server request failed (${result.Code}).`,
    );
  }
}

export function foreignKeyValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "Value" in value &&
    typeof value.Value === "number"
  ) {
    return value.Value;
  }
  return 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Older builds stored only `datasetVersionId` and `plateModelVersionId`, so a
 * stored selection must be migrated rather than trusted field by field.
 */
export function normalizeSelection(raw: unknown): ResourceSelection {
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as Partial<ResourceSelection>)
      : {};
  return {
    datasetVersionId: finiteNumber(value.datasetVersionId),
    plateModelId: finiteNumber(value.plateModelId),
    plateModelVersionId: finiteNumber(value.plateModelVersionId),
    useLocalPlateModelDemo: value.useLocalPlateModelDemo === true,
  };
}

function toCloudAccount(account: AccountRO): CloudAccount {
  // The Server may leave Name and Email empty for an account created by other
  // means, so never index into a possibly-empty string.
  const email = account.Email ?? "";
  return {
    email,
    name: account.Name || email.split("@")[0] || "TimeMachine user",
    tokenExpiresAt: new Date(account.TokenExpireTime).toISOString(),
  };
}

/**
 * Digest the Server expects in `LoginInvoker.Login`.
 *
 * `LoginService.Login` compares the submitted string against
 * `LoginPrivateEntity.Password`. `AccountAssistant.GetPassword(name, raw)` =
 * `ViCryptography.Sign(name + raw + ConstValue.AccountPasswordMD5Key)` writes
 * that column for the admin-side account creation path, i.e. SHA-256 over
 * `account + password + "DPlanet-456852"` in lowercase hex. The Unity register
 * and change-password paths submit the same client-side digest, and so does
 * the project's own web store (`useUserStore.ts`), which is why this client
 * computes the digest locally instead of sending a plain password.
 *
 * `encrypt.ts` also exports `MD5Value`, which is plain MD5. Nothing on the
 * Server ever writes an MD5 digest into that column, so `MD5Value` cannot
 * match a stored password; it is kept out of this path on purpose.
 */
async function accountPasswordDigest(
  account: string,
  password: string,
): Promise<string> {
  return GetPassword(account, password);
}

function resolveManifestUrl(value: string, manifestUrl: string): string {
  return new URL(value, manifestUrl).toString();
}

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

function defaultStorage(kind: "local" | "session"): StorageLike {
  if (typeof window === "undefined") {
    return memoryStorage();
  }
  const storage = kind === "local" ? window.localStorage : window.sessionStorage;
  return {
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => storage.removeItem(key),
    setItem: (key, value) => storage.setItem(key, value),
  };
}

export class Phase1BCloudClient {
  private readonly listeners = new Set<Phase1BListener>();
  private readonly options: Phase1BCloudClientOptions;
  private readonly storage: StorageLike;
  private readonly sessionStorage: StorageLike;
  private readonly sharedPlateClient: SharedPlateModelClient;
  private readonly serverUrl: string;
  private initializePromise: Promise<Phase1BState> | undefined;
  private accountGeneration = 0;
  private projectOperation?: ProjectOperationOwner;
  private unpersistedCloudSave?: { contextId: string | undefined; error: CloudProjectSaveError };
  private state: Phase1BState = {
    datasets: [],
    message: "",
    plateModelCatalog: [],
    plateModels: [],
    projects: [],
    selection: {
      datasetVersionId: 0,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    },
    serverUrl: "",
    sharedPlateModels: [],
    sharedPlateModelsError: "",
    sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "idle",
    sharedPlateModelsTotal: 0,
    status: "loading",
    v2WorkspaceAvailable: false,
  };

  constructor(options: Phase1BCloudClientOptions = {}) {
    this.options = options;
    this.storage = options.storage ?? defaultStorage("local");
    this.sessionStorage = options.sessionStorage ?? defaultStorage("session");
    this.serverUrl = getTimeMachineServerUrl()?.trim() ?? "";
    this.sharedPlateClient =
      options.sharedPlateClient ??
      new SharedPlateModelClient(withRpcDiagnostics({
        baseUrl: this.serverUrl,
        fetch: options.fetch,
        getAccessToken: () => this.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY),
      }));
  }

  get snapshot(): Phase1BState {
    return this.state;
  }

  subscribe(listener: Phase1BListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<Phase1BState> {
    this.initializePromise ??= this.initializeInternal();
    return this.initializePromise;
  }

  async sendLoginCode(email: string): Promise<void> {
    await this.ensureConfigured();
    requireSuccess(await LoginMailInvoker.SendMailCode(email.trim()));
  }

  async login(email: string, code: string): Promise<Phase1BState> {
    this.accountGeneration++;
    await this.ensureConfigured();
    requireSuccess(await LoginMailInvoker.Prepare(email.trim(), code.trim()));
    const account = requireData(
      await LoginMailInvoker.Login(email.trim(), code.trim()),
    );
    return this.completeLogin(account.Token);
  }

  /**
   * Unity account/password login. Only the resulting token is persisted;
   * neither the password nor its digest is stored or logged.
   */
  async loginWithPassword(
    account: string,
    password: string,
  ): Promise<Phase1BState> {
    this.accountGeneration++;
    await this.ensureConfigured();
    const trimmedAccount = account.trim();
    const result = await LoginInvoker.Login(
      trimmedAccount,
      await GetPassword(trimmedAccount, password),
    );
    if (result.Code !== 200 || result.Data === undefined) {
      throw new Error(
        result.Message || `Sign-in failed (${result.Code}).`,
      );
    }
    return this.completeLogin(result.Data.Token);
  }

  async logout(): Promise<void> {
    this.accountGeneration++;
    try {
      if (this.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY)) {
        requireSuccess(await LogoutInvoker.Logout());
      }
    } finally {
      try { this.clearCloudReference(); }
      finally {
        this.clearSession();
        this.setState({ account: undefined, message: "", projects: [], status: "signed-out" });
      }
      await this.refreshSharedPlateModels();
    }
  }

  async refreshCatalogs(options?: RPCRequestOptions): Promise<Phase1BState> {
    await this.refreshSharedPlateModels(options);
    if (this.state.v2WorkspaceAvailable) {
      return this.state.account
        ? this.refreshWorkspace(options)
        : this.refreshPublicCatalogs(options);
    }
    return this.state;
  }

  async refreshWorkspace(options?: RPCRequestOptions): Promise<Phase1BState> {
    if (!this.state.account) {
      return this.state;
    }
    if (!this.state.v2WorkspaceAvailable) {
      this.setState({
        message:
          "This Server does not expose the TimeMachine V2 workspace endpoints, so versioned catalogs and cloud projects are unavailable. Shared plate models below still work.",
      status: "signed-in",
      });
      return this.state;
    }
    this.setState({ message: "Refreshing cloud workspace…" });
    const [plateModels, datasets, projects, plateModelCatalog] =
      await Promise.all([
        TimeMachineWorkspaceInvoker.DisplayPlateModelVersions(new RPCUploadStream({ ...options, businessSuccessCode: 200 })).then(
          requireData,
        ),
        TimeMachineWorkspaceInvoker.DisplayDatasetVersions(new ViFKey(0), new RPCUploadStream({ ...options, businessSuccessCode: 200 })).then(
          requireData,
        ),
        TimeMachineWorkspaceInvoker.DisplayLatestProjectRevisions(new RPCUploadStream({ ...options, businessSuccessCode: 200 })).then(
          requireData,
        ),
        this.fetchPlateModelCatalog(options),
      ]);
    this.setState({
      datasets,
      message: "",
      plateModelCatalog,
      plateModels,
      projects,
      status: "signed-in",
    });
    return this.state;
  }

  /**
   * Reads the shared (V1) plate model catalog. Public pages are walked to
   * `PageRO.Total`; when signed in, `DisplayMine` is merged and de-duplicated.
   */
  async refreshSharedPlateModels(options?: RPCRequestOptions): Promise<Phase1BState> {
    if (!this.serverUrl) {
      this.setState({
        sharedPlateModels: [],
        sharedPlateModelsError: "",
        sharedPlateModelsMineIds: [],
        sharedPlateModelsStatus: "idle",
        sharedPlateModelsTotal: 0,
      });
      return this.state;
    }
    this.setState({
      sharedPlateModelsError: "",
      sharedPlateModelsStatus: "loading",
    });
    try {
      const publicModels: PlateModelSimpleRO[] = [];
      // Pages can overlap, so identity is the row id, not the row count: a
      // server that repeats a row must not inflate the collected set past
      // `Total` and hide the pages that were never read.
      const seenIds = new Set<number>();
      let total = 0;
      let complete = false;
      for (let index = 1; index <= SHARED_PLATE_MAX_PAGES; index += 1) {
        const page = await this.sharedPlateClient.display({
          accessRangeMask: PUBLIC_ACCESS_RANGE_MASK,
          pageIndex: index,
          pageSize: SHARED_PLATE_PAGE_SIZE,
        }, options);
        total = page.Total;
        for (const model of page.List) {
          const id = foreignKeyValue(model.ID);
          if (seenIds.has(id)) {
            continue;
          }
          seenIds.add(id);
          publicModels.push(model);
        }
        if (publicModels.length >= total) {
          complete = true;
          break;
        }
        if (page.List.length === 0) {
          // An early empty page means the server stopped before Total.
          break;
        }
      }
      const mineModels = this.state.account
        ? await this.sharedPlateClient.displayMine(options)
        : [];
      const merged: PlateModelSimpleRO[] = [...publicModels];
      const mineIds = new Set<number>();
      for (const model of mineModels) {
        const id = foreignKeyValue(model.ID);
        mineIds.add(id);
        if (!merged.some((existing) => foreignKeyValue(existing.ID) === id)) {
          merged.push(model);
        }
      }
      if (complete) {
        this.setState({
          sharedPlateModels: merged,
          sharedPlateModelsMineIds: [...mineIds],
          sharedPlateModelsStatus: "ready",
          sharedPlateModelsTotal: total,
        });
      } else {
        // Never report a partial read as ready: the caller must be able to
        // tell that models are still missing.
        this.setState({
          sharedPlateModels: merged,
          sharedPlateModelsError:
            `Shared plate model catalog is incomplete: ${merged.length} of ${total} rows were read before the ${SHARED_PLATE_MAX_PAGES}-page guard stopped the walk or a page came back empty.`,
          sharedPlateModelsMineIds: [...mineIds],
          sharedPlateModelsStatus: "incomplete",
          sharedPlateModelsTotal: total,
        });
      }
    } catch (error) {
      this.setState({
        sharedPlateModels: [],
        sharedPlateModelsError:
          error instanceof Error
            ? error.message
            : "Shared plate model catalog could not be read.",
        sharedPlateModelsMineIds: [],
        sharedPlateModelsStatus: "error",
        sharedPlateModelsTotal: 0,
      });
    }
    return this.state;
  }

  /** Selects a shared (V1) plate model and clears any V2 version selection. */
  selectSharedPlateModel(id: number): void {
    this.persistSelection({
      ...this.state.selection,
      plateModelId: id,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  }

  /** Explicit opt-in to the built-in local demo model. */
  selectLocalPlateModelDemo(): void {
    this.persistSelection({
      ...this.state.selection,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: true,
    });
  }

  selectPlateModel(versionId: number): void {
    this.persistSelection({
      ...this.state.selection,
      plateModelId: 0,
      plateModelVersionId: versionId,
      useLocalPlateModelDemo: false,
    });
  }

  selectDataset(versionId: number): void {
    this.persistSelection({
      ...this.state.selection,
      datasetVersionId: versionId,
    });
  }

  async saveProject(
    document: ProjectDocumentV2TO,
  ): Promise<CloudProjectReference> {
    if (!this.state.v2WorkspaceAvailable) {
      throw new Error(
        "This Server does not implement the TimeMachine V2 workspace endpoints, so cloud projects cannot be saved.",
      );
    }
    await this.initialize();
    if (!this.state.account) {
      throw new Error("Sign in before saving a cloud project.");
    }
    const owner = this.beginProjectOperation("save");
    try {
      if (owner.reference && owner.reference.accountEmail !== owner.accountEmail) {
        throw new Error("This cloud project belongs to a different account. Open it with the current account before saving.");
      }
      const request = structuredClone(document);
      const plateModelVersionId = this.state.selection.plateModelVersionId;
      if (foreignKeyValue(request.PlateModelVersion) !== plateModelVersionId) {
        Object.assign(request, { PlateModelVersion: typeof request.PlateModelVersion === "object" && request.PlateModelVersion !== null
          ? { ...request.PlateModelVersion, Value: plateModelVersionId } : new ViFKey(plateModelVersionId) });
      }
      let revision: ProjectRevisionRO;
      if (!owner.reference) {
        revision = requireData(await TimeMachineWorkspaceInvoker.CreateProject(request));
      } else {
        const saved = requireData(await TimeMachineWorkspaceInvoker.SaveProject(
          new ViFKey(owner.reference.projectId), new ViFKey(owner.reference.revisionId), request,
        ));
        if (saved.Conflict) {
          throw new Error(`Cloud project changed in another browser (revision ${saved.CurrentRevision.RevisionNumber || "new"}). Open the latest revision before saving again.`);
        }
        revision = saved.Revision;
      }
      this.assertProjectOwner(owner);
      const reference = this.referenceFromRevision(revision, owner.accountEmail ?? "");
      try { this.persistCloudReference(reference, owner.contextId); }
      catch (cause) {
        const error = new CloudProjectSaveError(reference, "local-reference", cause);
        this.unpersistedCloudSave = { contextId: owner.contextId, error };
        this.reportProjectContextError(error);
        throw error;
      }
      owner.reference = reference;
      this.assertProjectOwner(owner);
      try { await this.refreshWorkspace(); }
      catch (cause) { throw new CloudProjectSaveError(reference, "workspace-refresh", cause); }
      this.assertProjectOwner(owner);
      return reference;
    } finally {
      if (this.projectOperation === owner) this.projectOperation = undefined;
    }
  }

  async openProject(
    summary: ProjectRevisionSummaryRO,
    prepareDraft: (document: ProjectDocumentV2TO, original: string) => string,
  ): Promise<{ contextId: string; reference: CloudProjectReference }> {
    if (!this.state.v2WorkspaceAvailable) {
      throw new Error(
        "This Server does not implement the TimeMachine V2 workspace endpoints, so cloud projects cannot be opened.",
      );
    }
    await this.initialize();
    const owner = this.beginProjectOperation("open");
    try {
      const revision = requireData(await TimeMachineWorkspaceInvoker.GetProjectRevision(new ViFKey(foreignKeyValue(summary.Revision))));
      this.assertProjectOwner(owner);
      const document = JSON.parse(revision.DocumentJson) as ProjectDocumentV2TO;
      const serializedDraft = prepareDraft(document, revision.DocumentJson);
      this.assertProjectOwner(owner);
      const extensions = document.LegacyExtensions instanceof Map
        ? Object.fromEntries(document.LegacyExtensions) : document.LegacyExtensions as unknown as Record<string, string> | undefined;
      const plateLayer = document.LayerList.find(layer => foreignKeyValue(layer.Type) === ProjectLayerType.PlateModel);
      const pointLayer = document.LayerList.find(layer => foreignKeyValue(layer.Type) === ProjectLayerType.Point);
      const plateSource = plateModelSourceFromRef(plateLayer ? extensions?.[`sourceRef:${plateLayer.ID}`] : undefined);
      const datasetSource = pointLayer ? extensions?.[`sourceRef:${pointLayer.ID}`] : undefined;
      const datasetVersionId = datasetSource?.startsWith("resource:dataset-version:") ? Number(datasetSource.split(":").at(-1)) : 0;
      const selection = applyPlateModelSource({ datasetVersionId, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false }, plateSource);
      const reference = this.referenceFromRevision(revision, owner.accountEmail ?? "");
      const context = { contextId: crypto.randomUUID(), selection, reference };
      try { commitOpenedProject(this.storage, serializedDraft, context); }
      catch (error) { this.reportProjectContextError(error); throw error; }
      this.unpersistedCloudSave = undefined;
      owner.contextId = context.contextId;
      owner.reference = reference;
      this.setState({ selection, cloudReference: reference, projectContextError: undefined });
      this.assertProjectOwner(owner);
      return { contextId: context.contextId, reference };
    } finally {
      if (this.projectOperation === owner) this.projectOperation = undefined;
    }
  }

  getCloudReference(): CloudProjectReference | undefined {
    const context = this.readCloudContext();
    return context ? context.reference : this.readLegacyCloudReference();
  }

  clearCloudReference(): void {
    const context = this.readCloudContext();
    try {
      if (context) updateProjectCloudContext(this.storage, context.contextId, current => {
        const { reference: _reference, ...rest } = current;
        return rest;
      });
      else this.storage.removeItem(CLOUD_REFERENCE_KEY);
    } catch (error) { this.reportProjectContextError(error); throw error; }
    this.setState({ cloudReference: undefined, projectContextError: undefined });
  }

  /**
   * Only the V2 manifest overrides are resolved here. The shared (V1) plate
   * model is loaded by `main.ts` straight from `UserPlateModel`, so this never
   * supplies a local fallback for it.
   */
  async resolveSelectedRuntimeUrls(): Promise<RuntimeDataUrlOverrides> {
    await this.initialize();
    if (!this.state.v2WorkspaceAvailable || !this.state.account) {
      return {};
    }
    const overrides: RuntimeDataUrlOverrides = {};
    const selectedPlateModel = this.state.plateModels.find(
      (item) =>
        foreignKeyValue(item.Version.ID) ===
        this.state.selection.plateModelVersionId,
    );
    if (selectedPlateModel?.Manifest.AccessToken) {
      const manifestUrl = requireData(
        await SystemOpenAPIInvoker.GetOssURL(
          selectedPlateModel.Manifest.AccessToken,
        ),
      );
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(
          `Plate model manifest failed to load (HTTP ${response.status}).`,
        );
      }
      const manifest = (await response.json()) as {
        platePolygonsUrl?: string;
        polygonUrl?: string;
        rotationModelUrl?: string;
        rotationUrl?: string;
      };
      const rotationUrl = manifest.rotationModelUrl ?? manifest.rotationUrl;
      const polygonUrl = manifest.platePolygonsUrl ?? manifest.polygonUrl;
      if (!rotationUrl || !polygonUrl) {
        throw new Error(
          "Plate model manifest must define rotationModelUrl and platePolygonsUrl.",
        );
      }
      overrides.rotations = resolveManifestUrl(rotationUrl, manifestUrl);
      overrides.polygons = resolveManifestUrl(polygonUrl, manifestUrl);
    }

    const selectedDataset = this.state.datasets.find(
      (item) =>
        foreignKeyValue(item.Version.ID) ===
        this.state.selection.datasetVersionId,
    );
    if (selectedDataset?.Manifest.AccessToken) {
      overrides.pointManifest = requireData(
        await SystemOpenAPIInvoker.GetOssURL(
          selectedDataset.Manifest.AccessToken,
        ),
      );
      overrides.pointManifestAccessToken = selectedDataset.Manifest.AccessToken;
    }
    return overrides;
  }

  private async completeLogin(token: string): Promise<Phase1BState> {
    const previousToken = this.sessionStorage.getItem(
      TIME_MACHINE_ACCESS_TOKEN_KEY,
    );
    this.sessionStorage.setItem(TIME_MACHINE_ACCESS_TOKEN_KEY, token);
    let account: AccountRO;
    try {
      account = requireData(await AccountInvoker.Display());
    } catch (error) {
      // The token is already written, so a failed identity check has to be
      // rolled back: either the previous session is restored intact or the
      // session is cleared completely. Never a new token beside an old identity.
      if (previousToken === null) {
        this.sessionStorage.removeItem(TIME_MACHINE_ACCESS_TOKEN_KEY);
        this.sessionStorage.removeItem(ACCOUNT_SESSION_KEY);
      } else {
        this.sessionStorage.setItem(
          TIME_MACHINE_ACCESS_TOKEN_KEY,
          previousToken,
        );
      }
      throw error;
    }
    this.persistAccount(toCloudAccount(account));
    await this.refreshSharedPlateModels();
    if (this.state.v2WorkspaceAvailable) {
      // A catalog failure after a verified sign-in must not invalidate the
      // token that the Server just accepted.
      try {
        await this.refreshWorkspace();
      } catch (error) {
        console.warn(
          "Cloud workspace refresh failed after sign-in; the session is still valid.",
          error,
        );
        this.setState({
          message:
            "Signed in, but the cloud workspace could not be refreshed.",
          status: "signed-in",
        });
      }
    } else {
      this.setState({ status: "signed-in" });
    }
    return this.state;
  }

  private async initializeInternal(): Promise<Phase1BState> {
    const context = this.readCloudContext();
    const selection = context ? context.selection : normalizeSelection(this.readLegacyProjectValue(RESOURCE_SELECTION_KEY));
    const cloudReference = context ? context.reference : this.readLegacyCloudReference();
    this.setState({ cloudReference, projectContextError: undefined });
    this.serverUrlState(selection);
    if (!this.serverUrl) {
      this.setState({
        message: "Email sign-in service is not configured.",
        selection,
        status: "disabled",
      });
      return this.state;
    }

    // The V2 capability handshake also configures RPCInvoker, which Login and
    // Account need, so it must run even when the Server does not implement V2.
    // Its failure only marks V2 unavailable; it never clears a valid token.
    let bootstrapFailed = false;
    try {
      await (this.options.bootstrapPlatform ?? bootstrapTimeMachinePlatform)();
    } catch (error) {
      bootstrapFailed = true;
      console.warn(
        "TimeMachine V2 capability handshake failed; continuing with V1 RPC.",
        error,
      );
    }
    // `bootstrapTimeMachinePlatform` configures RPCInvoker before it can fail,
    // but a stubbed or absent bootstrap may not have. Re-configuring with the
    // same base URL and token source is idempotent, so this is unconditional.
    this.ensureRpcConfigured();
    this.setState({
      message: bootstrapFailed
        ? "TimeMachine V2 capabilities could not be confirmed. Shared plate models and account sign-in remain available; versioned catalogs and cloud projects are currently unavailable."
        : "",
      v2WorkspaceAvailable: !bootstrapFailed,
    });

    try {
      await this.refreshSharedPlateModels();
    } catch (error) {
      console.warn("Shared plate model catalog could not be read.", error);
    }

    const token = this.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY);
    if (!token) {
      this.setState({ message: this.state.message, status: "signed-out" });
      return this.state;
    }
    let restoredAccount: CloudAccount;
    try {
      const account = requireData(await AccountInvoker.Display());
      restoredAccount = toCloudAccount(account);
    } catch (error) {
      // Only an explicit authentication rejection invalidates credentials.
      // Network/decode/server failures leave storage intact but never publish
      // the cached identity as a verified signed-in account.
      const code = error instanceof CloudRpcError ? error.code : error instanceof RPCHttpError ? error.status : undefined;
      const rejected = code === 401 || code === 403;
      if (rejected) this.clearSession();
      this.setState({
        account: undefined,
        message:
          error instanceof Error ? error.message : "Session restore failed.",
        status: rejected ? "signed-out" : "error",
      });
      return this.state;
    }
    // The identity is published only after the Server confirmed it.
    this.persistAccount(restoredAccount);
    await this.refreshSharedPlateModels();
    if (this.state.v2WorkspaceAvailable) {
      // Catalog and V2 workspace failures are reported, never treated as an
      // authentication failure: the verified V1 identity stays valid.
      try {
        await this.refreshWorkspace();
      } catch (error) {
        console.warn(
          "Cloud workspace could not be refreshed; the signed-in session is still valid.",
          error,
        );
        this.setState({
          message:
            "Cloud workspace could not be refreshed; the shared plate model catalog and account sign-in are still valid.",
          status: "signed-in",
        });
      }
    } else {
      this.setState({ status: "signed-in" });
    }
    return this.state;
  }

  private serverUrlState(selection: ResourceSelection): void {
    this.setState({ selection, serverUrl: this.serverUrl });
  }

  /**
   * `LoginInvoker` and `AccountInvoker` dispatch through the global
   * `RPCInvoker`, so it must be configured even when the V2 capability
   * handshake failed. Uses the same base URL and token source as the platform
   * bootstrap, so configuring twice is harmless.
   */
  private ensureRpcConfigured(): void {
    const options: RPCClientOptions = {
      baseUrl: this.serverUrl,
      fetch: this.options.fetch,
      getAccessToken: () =>
        this.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY),
      getRequestToken: (path) => this.sessionStorage.getItem(path),
    };
    if (typeof window !== "undefined") {
      options.onAuthEvent = (event) => {
        window.dispatchEvent(
          new CustomEvent("timemachine:auth", { detail: event }),
        );
      };
    }
    RPCInvoker.Configure(withRpcDiagnostics(options));
  }

  private async refreshPublicCatalogs(options?: RPCRequestOptions): Promise<Phase1BState> {
    const [plateModels, datasets, plateModelCatalog] = await Promise.all([
      TimeMachineCatalogInvoker.DisplayPublicPlateModelVersions(new RPCUploadStream({ ...options, businessSuccessCode: 200 })).then(
        requireData,
      ),
      TimeMachineCatalogInvoker.DisplayPublicDatasetVersions(
        new ViFKey(0),
        new RPCUploadStream({ ...options, businessSuccessCode: 200 }),
      ).then(requireData),
      this.fetchPlateModelCatalog(options),
    ]);
    this.setState({
      datasets,
      message: "",
      plateModelCatalog,
      plateModels,
      projects: [],
      status: this.state.account ? "signed-in" : "signed-out",
    });
    return this.state;
  }

  /**
   * Reads the PlateModel catalog the ingest wizard binds to. A failure here must not break
   * the workspace refresh, because the rest of the catalog is still usable without upload.
   */
  private async fetchPlateModelCatalog(options?: RPCRequestOptions): Promise<
    readonly PlateModelIngestOptionRO[]
  > {
    try {
      return requireData(
        await TimeMachineIngestInvoker.DisplayIngestPlateModels(new RPCUploadStream({ ...options, businessSuccessCode: 200 })),
      );
    } catch {
      // Request diagnostics already carry the safe route, status and trace.
      // Server-provided error messages can contain credentials or resource data.
      console.warn("Plate model catalog could not be read.");
      return [];
    }
  }

  private async ensureConfigured(): Promise<void> {
    await this.initialize();
    if (!this.serverUrl) {
      throw new Error("TimeMachine email sign-in service is not configured.");
    }
  }

  private referenceFromRevision(
    revision: ProjectRevisionRO,
    accountEmail: string,
  ): CloudProjectReference {
    return parseCloudProjectReference({
      accountEmail,
      contentHash: revision.ContentHash,
      projectId: foreignKeyValue(revision.Project),
      revisionId: foreignKeyValue(revision.ID),
      revisionNumber: revision.RevisionNumber,
    });
  }

  private persistAccount(account: CloudAccount): void {
    this.sessionStorage.setItem(ACCOUNT_SESSION_KEY, JSON.stringify(account));
    this.setState({ account, message: "", status: "signed-in" });
  }

  private persistCloudReference(reference: CloudProjectReference, expectedContextId: string | undefined): void {
    const context = this.readCloudContext();
    if (context?.contextId !== expectedContextId) throw new OperationInterruptedError("superseded");
    try {
      if (context) updateProjectCloudContext(this.storage, context.contextId, current => ({ ...current, reference }));
      else this.storage.setItem(CLOUD_REFERENCE_KEY, JSON.stringify(reference));
    } catch (error) { this.reportProjectContextError(error); throw error; }
    this.setState({ cloudReference: reference, projectContextError: undefined });
  }

  private persistSelection(selection: ResourceSelection): void {
    if (this.projectOperation?.kind === "open") throw new AgentActionBusyError("Wait for the project to finish opening before changing its source selection.");
    const context = this.readCloudContext();
    try {
      if (context) updateProjectCloudContext(this.storage, context.contextId, current => ({ ...current, selection }));
      else this.storage.setItem(RESOURCE_SELECTION_KEY, JSON.stringify(selection));
    } catch (error) { this.reportProjectContextError(error); throw error; }
    this.setState({ selection, projectContextError: undefined });
  }

  private readLegacyProjectValue(key: string): unknown {
    try {
      const serialized = this.storage.getItem(key);
      if (serialized === null) return undefined;
      try { return JSON.parse(serialized); }
      catch { throw new Error("The legacy project context contains invalid JSON."); }
    } catch (error) { this.reportProjectContextError(error); throw error; }
  }

  private readLegacyCloudReference(): CloudProjectReference | undefined {
    try {
      const value = this.readLegacyProjectValue(CLOUD_REFERENCE_KEY);
      return value === undefined ? undefined : parseCloudProjectReference(value);
    } catch (error) { this.reportProjectContextError(error); throw error; }
  }

  private readCloudContext(): ProjectCloudContext | undefined {
    try { return readProjectCloudContext(this.storage); }
    catch (error) { this.reportProjectContextError(error); throw error; }
  }

  private reportProjectContextError(error: unknown): void {
    this.setState({ cloudReference: undefined, projectContextError: error instanceof Error ? error.message : "The project cloud context could not be read or saved." });
  }

  private beginProjectOperation(kind: ProjectOperationOwner["kind"]): ProjectOperationOwner {
    if (this.projectOperation) throw new AgentActionBusyError("A cloud project is already being opened or saved.");
    const context = this.readCloudContext();
    const pending = this.unpersistedCloudSave;
    if (kind === "save" && pending && pending.contextId === context?.contextId &&
      pending.error.reference.accountEmail === this.state.account?.email) {
      throw pending.error;
    }
    const owner: ProjectOperationOwner = {
      kind, contextId: context?.contextId, accountGeneration: this.accountGeneration,
      accountEmail: this.state.account?.email, reference: context ? context.reference : this.readLegacyCloudReference(),
    };
    this.projectOperation = owner;
    return owner;
  }

  private assertProjectOwner(owner: ProjectOperationOwner): void {
    const context = this.readCloudContext();
    const reference = context ? context.reference : this.readLegacyCloudReference();
    if (this.projectOperation !== owner || owner.accountGeneration !== this.accountGeneration ||
      owner.accountEmail !== this.state.account?.email || owner.contextId !== context?.contextId ||
      JSON.stringify(owner.reference) !== JSON.stringify(reference)) throw new OperationInterruptedError("superseded");
  }

  private clearSession(): void {
    this.accountGeneration++;
    this.sessionStorage.removeItem(TIME_MACHINE_ACCESS_TOKEN_KEY);
    this.sessionStorage.removeItem(ACCOUNT_SESSION_KEY);
    // Storage and in-memory identity are cleared together, so no half
    // signed-in state can survive a failed sign-in.
    this.setState({ account: undefined });
  }

  private setState(update: Partial<Phase1BState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export const phase1BCloudClient = new Phase1BCloudClient();
