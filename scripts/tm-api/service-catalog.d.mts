/**
 * Types for the offline service catalog projection.
 *
 * The implementation is plain ESM (`service-catalog.mjs`) because it runs from
 * the shell entry point without a build step. This declaration lets the test
 * suite read the projection without weakening it to `any`.
 */

export type ServiceCallability = "adapter" | "reserved";
export type ServiceSchemaStatus = "resolved" | "unresolved";
export type ServiceSourceId = "active-snapshot" | "dplanet-sdk";

export interface ServiceParam {
  name: string;
  declaredType?: string;
  description?: string;
  transportParam: boolean;
  transportField?: string;
  classification: "array" | "declaration" | "enum32" | "fkey" | "file" | "mask" | "primitive" | "stream" | "unparsed";
  jsonShape: boolean;
}

export interface ServiceSchemaRef {
  role: "parameter" | "return";
  declaredType: string;
  name: string;
  status: ServiceSchemaStatus;
  kind?: "enum" | "struct";
  path?: string;
}

export interface ServiceAdapter {
  actionId: string;
  apiVersion: 1 | 2;
  reloadRequired?: boolean;
  input?: Record<string, unknown>;
}

export interface ServiceSourceVariant {
  root: ServiceSourceId;
  signature: string;
  source: { path: string; line: number };
}

export interface ServiceEndpoint {
  id: string;
  service: string;
  invoker: string;
  module: string;
  route: string;
  suffix: string;
  httpMethod?: string;
  authorize?: string[];
  title?: string;
  params: ServiceParam[];
  declaresReturn: boolean;
  returnKind: "result" | "download-stream" | "unknown";
  inner?: string;
  stream: { upload: boolean; download: boolean; file: boolean };
  source: { path: string; line: number };
  transport: {
    protocol: string;
    invoker: string;
    httpMethod: string;
    callability: ServiceCallability;
    adapter?: ServiceAdapter;
    reason?: string;
    /**
     * A page action with a *different* business contract that a caller might
     * reach for. It is never invoked on the endpoint's behalf.
     */
    relatedActionId?: string;
  };
  schemaStatus: ServiceSchemaStatus;
  unresolvedTypes: string[];
  schemaRefs: ServiceSchemaRef[];
  provenance: {
    inActiveSnapshot: boolean;
    presentInFullSdk: boolean;
    unported: boolean;
    conflict: boolean;
    roots: ServiceSourceId[];
    /** Only present when the route exists in both sources. */
    sourceVariants?: ServiceSourceVariant[];
    conflictNote?: string;
    note?: string;
  };
}

export interface ServiceCatalog {
  schemaVersion: number;
  generatedFrom: string[];
  schemaNote: string;
  sources: {
    id: ServiceSourceId;
    base: string;
    role: "active-contract" | "full-sdk-reference";
    present: boolean;
    invokers: number;
    endpoints: number;
  }[];
  counts: {
    invokers: number;
    endpoints: number;
    activeSnapshotInvokers: number;
    activeSnapshotEndpointCount: number;
    fullSourceInvokerCount: number;
    fullSourceEndpointCount: number;
    unportedEndpointCount: number;
    snapshotOnlyEndpointCount: number;
    conflictCount: number;
    callable: number;
    reserved: number;
    unresolvedSchema: number;
  };
  invokers: { source: ServiceSourceId; invoker?: string; path: string; sha256: string; endpoints: number }[];
  endpoints: ServiceEndpoint[];
  manifest: {
    status: "match" | "mismatch" | "absent" | "unreadable";
    sourceClosureSha256?: string;
    files?: number;
    checked?: number;
    mismatched?: { path: string; reason: string }[];
    detail?: string;
  };
  duplicates: string[];
}

export function buildServiceCatalog(root?: string, options?: { includeFullSdk?: boolean }): ServiceCatalog;
export function writeServiceCatalogJson(root?: string, path?: string): ServiceCatalog;
export function readServiceCatalog(root?: string): ServiceCatalog & { loadedFrom: "generated-catalog" | "live-build" };
export function checkServiceCatalog(
  catalog: ServiceCatalog,
  root?: string,
): { ok: boolean; failures: string[]; absentSources: string[] };
/** Empty by design: no action is proven to implement an endpoint's contract. */
export const ADAPTER_ROUTES: Readonly<Record<string, ServiceAdapter>>;
export const BLOCKED_REASONS: Readonly<Record<string, string>>;
export const WITHDRAWN_ADAPTERS: Readonly<Record<string, { actionId: string; reason: string }>>;
export const CATALOG_PATH: string;
export const SOURCE_ROOTS: readonly { id: ServiceSourceId; base: string; required: boolean }[];
