/**
 * Offline service catalog for the generated Server contract snapshot.
 *
 * The only generated sources are `packages/generated-api/src/snapshot/code_ex/*_invoker.ts`.
 * This module reads those files as text and projects the endpoint metadata the
 * generators already encoded: module URL, endpoint route, HTTP verb, declared
 * `@authorize` roles, TypeScript parameter types, transport field names and the
 * declared return type. It never imports, executes or rewrites the generated
 * code, and it never contacts a Server.
 *
 * Two limits are deliberate:
 *
 * 1. Parameter and return *types* are projected as names. Field-level DTO
 *    projection is not provided, so `schemaStatus` says only whether a
 *    generated declaration file for that type name was found. A caller must
 *    open the `schemaRefs` path for fields; a name match is not a schema.
 * 2. Adapter routing is an explicit table. An endpoint is callable only when
 *    an existing page action performs exactly that business operation. Derived
 *    summaries are never substituted for a raw DTO.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Two read-only sources, scanned with the same extractor:
 *
 * - `active-snapshot` is what this application actually ships and runs
 *   (`packages/generated-api`).
 * - `dplanet-sdk` is the complete upstream SDK source tree. It is read for
 *   discovery only; nothing here imports, compiles or executes it, and the
 *   runtime CLI reads the generated JSON catalog instead of touching it.
 */
const SOURCE_ROOTS = Object.freeze([
  { id: "active-snapshot", base: "packages/generated-api/src/snapshot", required: true },
  { id: "dplanet-sdk", base: "DPlanet/TypeScript/src", required: false },
]);
const ACTIVE_ROOT_ID = "active-snapshot";
const MANIFEST_PATH = "packages/generated-api/source-manifest.json";
const CATALOG_PATH = "scripts/tm-api/service-catalog.json";

/**
 * Every previously claimed adapter route was withdrawn. Each of the nine
 * endpoints looked close to an existing page action, but none performs exactly
 * that endpoint's business operation with that endpoint's contract, so none is
 * routed. They are recorded here only to make the refusal specific — the
 * `reason` explains the mismatch and names the adjacent action so a caller is
 * not left guessing — and `relatedActionId` is reported as a *different* entry
 * point that this interface never invokes on the endpoint's behalf.
 */
const WITHDRAWN_ADAPTERS = Object.freeze({
  "service.Login.Login": {
    actionId: "auth.login",
    reason: "The auth.login action hashes the password, applies its own mode and context rules and returns an application session, not this RPC's request/response DTO. Equivalence is unproven.",
  },
  "service.LoginMail.Login": {
    actionId: "auth.login",
    reason: "Same unproven equivalence as service.Login.Login: auth.login runs the application's own email-code flow (mode, hashing, context) instead of this RPC's declared contract.",
  },
  "service.LoginMail.SendMailCode": {
    actionId: "auth.sendCode",
    reason: "auth.sendCode drives the application's own code-issuing flow with its own throttling and context; this RPC's parameters and result are not proven equivalent.",
  },
  "service.Logout.Logout": {
    actionId: "auth.logout",
    reason: "auth.logout clears the application's own session state. The operation looks close, but request/result equivalence is unverified, so it stays reserved rather than becoming an unverified exception.",
  },
  "service.TimeMachineWorkspace.CreateProject": {
    actionId: "project.save",
    reason: "project.save persists whatever document the editor currently holds and decides by itself whether a create or a save is needed, so it cannot be driven as this RPC with a caller-specified project payload.",
  },
  "service.TimeMachineWorkspace.SaveProject": {
    actionId: "project.save",
    reason: "Same mismatch as CreateProject: project.save writes the current editor document and chooses create-versus-save itself instead of taking this RPC's request.",
  },
  "service.TimeMachineWorkspace.GetProjectRevision": {
    actionId: "project.open",
    reason: "project.open resolves a revision through the local project catalog and reloads the document; it does not issue this RPC with the caller's request and does not return its DTO.",
  },
  "service.TimeMachineIngest.CreateDatasetIngestJob": {
    actionId: "upload.run",
    reason: "upload.run depends on a real File object and the page's current form fields; no page action accepts this RPC's parameters or returns its job DTO.",
  },
  "service.TimeMachineIngest.CancelJob": {
    actionId: "upload.cancel",
    reason: "upload.cancel cancels the job the UI currently tracks, not an arbitrary jobId passed by a caller, so it cannot serve this endpoint's contract.",
  },
});

/** No endpoint is routed until an action is proven to implement its contract. */
const ADAPTER_ROUTES = Object.freeze({});

/**
 * Endpoints with no exact action route, but a specific reason worth stating
 * instead of a generic "not implemented". Every entry describes the current
 * application, not a planned feature.
 */
const BLOCKED_REASONS = Object.freeze({
  "service.UserPlateModel.Create": "The generated invoker posts a JSON body, but the ASP.NET controller parses multipart form data. Only the read paths were re-implemented (src/plate-model/shared-plate-client.ts), so no verified write adapter exists.",
  "service.UserPlateModel.Update": "Same JSON-versus-multipart mismatch as Create; no verified write adapter exists.",
  "service.UserPlateModel.SetState": "Same JSON-versus-multipart mismatch as Create; no verified write adapter exists.",
  "service.UserPlateModel.SetAccessRange": "Same JSON-versus-multipart mismatch as Create; no verified write adapter exists.",
  "service.UserPlateModel.Delete": "Same JSON-versus-multipart mismatch as Create; no verified write adapter exists.",
  "service.UserPlateModel.Display": "The application reaches this endpoint through the catalog.refresh action, which returns a derived count/status summary rather than PageRO<PlateModelSimpleRO>. A derived summary is not substituted for the service result here.",
  "service.UserPlateModel.DisplayMine": "Reached only through the shared plate-model client during workspace refresh; no page action returns PlateModelSimpleRO[].",
  "service.UserPlateModel.GetDetail": "Reached only through the shared plate-model client while loading a selected model; no page action returns PlateModelRO.",
  "service.Account.Display": "Folded into the workspace state snapshot during bootstrap; no page action returns the account DTO.",
  "service.TimeMachinePlatform.GetCapabilities": "Bootstrap handshake only. The derived CapabilitySnapshot drives UI availability and is not exposed as the capabilities DTO.",
  "service.TimeMachinePlatform.RecordTelemetry": "Fire-and-forget telemetry inside the platform runtime; no page action exposes it.",
  "service.SystemOpenAPI.GetOssURL": "Chunked asset upload protocol used internally by the ingest client.",
  "service.SystemOpenAPI.GetManifestAssetURL": "Internal asset URL resolution used by the ingest client.",
  "service.TimeMachineCatalog.DisplayPublicPlateModelVersions": "Consumed during workspace bootstrap; the resulting catalog is state, not an action result.",
  "service.TimeMachineCatalog.DisplayPublicDatasetVersions": "Consumed during workspace bootstrap; the resulting catalog is state, not an action result.",
  "service.TimeMachineWorkspace.DisplayPlateModelVersions": "Consumed during workspace bootstrap; no page action returns the page DTO.",
  "service.TimeMachineWorkspace.DisplayDatasetVersions": "Consumed during workspace bootstrap; no page action returns the page DTO.",
  "service.TimeMachineWorkspace.DisplayLatestProjectRevisions": "Consumed during workspace bootstrap; no page action returns the page DTO.",
});

const GENERIC_RESERVED_REASON =
  "No page action performs exactly this operation. Raw RPC dispatch is not provided, so this endpoint is discoverable but not callable.";

/** The concrete reason a reserved endpoint cannot be called. */
function reservedReason(id) {
  const withdrawn = WITHDRAWN_ADAPTERS[id];
  const specific = withdrawn?.reason ?? BLOCKED_REASONS[id] ?? GENERIC_RESERVED_REASON;
  if (!withdrawn) return specific;
  return `${specific} The application's ${withdrawn.actionId} action is a different business entry point with its own contract; it is not this endpoint and is never invoked automatically here.`;
}

const PRIMITIVES = new Set(["boolean", "bigint", "number", "string"]);
/** JavaScript/runtime names that never have a generated declaration file. */
const BUILTINS = new Set([
  ...PRIMITIVES, "undefined", "void", "null", "Array", "Map", "Record", "Set",
  "ArrayBuffer", "Blob", "Date", "File", "Uint8Array", "Uint8ClampedArray",
]);
const TRANSPORT_TYPES = new Set(["RPCFile", "RPCUploadStream", "RPCDownloadStream"]);
const WRAPPER_TYPES = new Set(["ViFKey", "ViEnum32", "ViMask32", "ViMask64"]);

/** Split on top-level commas so `Map<string, number>` and defaults survive. */
function splitTopLevel(text, separator = ",") {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "<" || char === "(" || char === "[" || char === "{") depth++;
    else if (char === ">" || char === ")" || char === "]" || char === "}") depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** Index of the bracket that closes the one opened at `start`. */
function closingBracket(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Normalized declaration text without a trailing `| undefined` or spaces. */
function normalize(declared) {
  return declared.replace(/\s*\|\s*undefined\s*$/, "").replace(/\s+/g, "");
}

/** Classify a declared TypeScript type without pretending to resolve it. */
function classifyType(declared) {
  const text = normalize(declared);
  if (text === "RPCUploadStream" || text === "RPCDownloadStream") return "stream";
  if (text === "RPCFile") return "file";
  if (/^ViFKey\b/.test(text)) return "fkey";
  if (/^ViEnum32</.test(text)) return "enum32";
  if (/^ViMask(?:32|64)</.test(text)) return "mask";
  if (PRIMITIVES.has(text)) return "primitive";
  if (/\[\]$/.test(text) || /^Array</.test(text)) return "array";
  return "declaration";
}

/**
 * Generated type names a declaration refers to, unwrapping Vi/Array generics.
 * Transport and primitive names yield no reference; they are not files.
 */
function referencedTypes(declared) {
  let text = normalize(declared);
  const array = /^Array<(.+)>$/.exec(text);
  if (array) text = array[1];
  const wrapper = /^(ViEnum32|ViMask32|ViMask64)<(.+)>$/.exec(text);
  if (wrapper) text = wrapper[2];
  if (WRAPPER_TYPES.has(text) || TRANSPORT_TYPES.has(text) || BUILTINS.has(text)) return [];
  const generic = /^(\w+)<(.+)>$/.exec(text);
  if (generic) {
    return [generic[1], ...splitTopLevel(generic[2]).filter(name => /^[A-Za-z_]\w*$/.test(name) && !BUILTINS.has(name))];
  }
  return /^[A-Za-z_]\w*$/.test(text) ? [text] : [];
}

function parseParams(text, descriptions, fields) {
  return splitTopLevel(text).map(entry => {
    const withoutDefault = entry.replace(/\s*=\s*[\s\S]*$/, "").trim();
    const match = /^(?:readonly\s+)?(\w+)\s*\??\s*:\s*([\s\S]+)$/.exec(withoutDefault);
    if (!match) {
      return {
        name: withoutDefault || "(unparsed)",
        classified: false,
        classification: "unparsed",
        transportParam: false,
        jsonShape: false,
      };
    }
    const [, name, declaredType] = match;
    const declared = declaredType.trim();
    const transportField = fields.find(field => field.name === name)?.field;
    return {
      name,
      declaredType: declared,
      ...(descriptions.has(name) ? { description: descriptions.get(name) } : {}),
      transportParam: TRANSPORT_TYPES.has(normalize(declared)),
      ...(transportField ? { transportField } : {}),
      classification: classifyType(declared),
      jsonShape: classifyType(declared) !== "stream" && classifyType(declared) !== "file",
    };
  });
}

/** Every `export class|enum` in the snapshot, so a type name maps to its file. */
function buildTypeIndex(files) {
  const index = new Map();
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/^export (?:abstract )?(class|enum) (\w+)/gm)) {
      const kind = match[1] === "enum" ? "enum" : "struct";
      if (!index.has(match[2])) index.set(match[2], { kind, path });
    }
  }
  return index;
}

function listFiles(root, predicate) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (predicate(path)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Repository-relative path, so both sources stay identifiable. */
function repoRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

/** The declared return: `RPCResult<T>`, bare `RPCResult`, or a download stream. */
function parseReturn(head) {
  const promiseStart = head.indexOf("Promise<");
  if (promiseStart === -1) return { declaresReturn: false, returnKind: "unknown", inner: undefined };
  const innerStart = promiseStart + "Promise<".length;
  const innerEnd = closingBracket(head, innerStart - 1, "<", ">");
  if (innerEnd === -1) return { declaresReturn: false, returnKind: "unknown", inner: undefined };
  const inner = head.slice(innerStart, innerEnd).trim();
  if (inner === "RPCDownloadStream" || inner.startsWith("RPCDownloadStream<")) {
    // A download stream may still name the payload it encodes.
    const open = inner.indexOf("<");
    const payload = open === -1 ? undefined : inner.slice(open + 1, inner.lastIndexOf(">")).trim();
    return { declaresReturn: true, returnKind: "download-stream", inner: payload || undefined };
  }
  if (!inner.startsWith("RPCResult")) return { declaresReturn: false, returnKind: "unknown", inner };
  const genericStart = inner.indexOf("<");
  if (genericStart === -1) return { declaresReturn: true, returnKind: "result", inner: undefined };
  const genericEnd = closingBracket(inner, genericStart, "<", ">");
  if (genericEnd === -1) return { declaresReturn: false, returnKind: "unknown", inner };
  return { declaresReturn: true, returnKind: "result", inner: inner.slice(genericStart + 1, genericEnd).trim() };
}

function parseInvoker(path, root) {
  const text = readFileSync(path, "utf8");
  const className = /export class (\w+)/.exec(text)?.[1];
  const moduleUrl = /static readonly URL = "([^"]+)"/.exec(text)?.[1];
  if (!className || !moduleUrl) return [];
  const service = className.replace(/Invoker$/, "");
  const endpoints = [];
  // Generated files place `URL_X` first and the doc block immediately before
  // the method, so the endpoint boundary is the URL marker, not the comment.
  for (const match of text.matchAll(/static readonly URL_(\w+) = "([^"]+)";/g)) {
    const [, suffix, route] = match;
    const afterUrl = match.index + match[0].length;
    const signatureStart = text.indexOf("static ", afterUrl);
    if (signatureStart === -1) continue;
    const doc = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(afterUrl, signatureStart))?.[1] ?? "";
    const authorize = /@authorize:\s*\[([^\]]*)\]/.exec(doc)?.[1]
      ?.split(",").map(role => role.trim()).filter(Boolean) ?? [];
    const title = (doc.split("\n").map(line => line.replace(/^\s*\*?\s?/, "").trim())
      .find(line => line && !line.startsWith("@")) ?? "").trim();
    const openParen = text.indexOf("(", signatureStart);
    const closeParen = openParen === -1 ? -1 : closingBracket(text, openParen, "(", ")");
    if (closeParen === -1) continue;
    const method = /^static (\w+)/.exec(text.slice(signatureStart))?.[1];
    if (!method) continue;
    const signature = text.slice(openParen + 1, closeParen);
    const bodyStart = text.indexOf("{", closeParen);
    const head = text.slice(closeParen, bodyStart === -1 ? undefined : bodyStart);
    const transferred = parseReturn(head);
    const params = parseParams(signature, new Map(
      [...doc.matchAll(/@param (\w+) ([^\n*]*)/g)].map(entry => [entry[1], entry[2].trim()]),
    ), [...text.slice(bodyStart).matchAll(/AddField\("(\w+)",\s*(\w+)\)/g)]
      .slice(0, 64).map(field => ({ field: field[1], name: field[2] })));
    const bodyEnd = text.indexOf("static ", bodyStart === -1 ? closeParen : bodyStart);
    const body = text.slice(bodyStart === -1 ? closeParen : bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
    endpoints.push({
      id: `service.${service}.${method}`,
      service,
      invoker: className,
      module: moduleUrl,
      route,
      suffix,
      httpMethod: /RPCInvoker\.Request\("(\w+)"/.exec(body)?.[1],
      ...(authorize.length ? { authorize } : {}),
      ...(title ? { title } : {}),
      params,
      ...transferred,
      stream: {
        upload: params.some(param => param.declaredType && normalize(param.declaredType) === "RPCUploadStream"),
        download: transferred.returnKind === "download-stream",
        file: params.some(param => param.declaredType && normalize(param.declaredType) === "RPCFile"),
      },
      source: { path: repoRelative(root, path), line: text.slice(0, match.index).split("\n").length },
    });
  }
  return endpoints;
}

/** A stable signature, used only to detect a same-route difference between sources. */
function signatureOf(endpoint) {
  const params = endpoint.params.map(param => `${param.name}:${param.declaredType ?? "?"}`).join(",");
  const returns = endpoint.returnKind === "download-stream" ? "RPCDownloadStream" : `RPCResult${endpoint.inner ? `<${endpoint.inner}>` : ""}`;
  return `${endpoint.httpMethod ?? "?"} ${endpoint.route}(${params}) -> ${returns}`;
}

/**
 * One source's view of a route, recorded so a same-route difference is visible
 * instead of being overwritten. Only the signature and its location are kept:
 * the winning endpoint carries the full parameter list.
 */
function variantOf(endpoint, rootId) {
  return { root: rootId, signature: signatureOf(endpoint), source: endpoint.source };
}

/** Scans one source root; returns undefined when the tree is not in this checkout. */
function scanSource(root, source) {
  const codeRoot = join(root, source.base, "code_ex");
  if (!existsSync(codeRoot)) return undefined;
  // `code_ex` declares DTOs; `vi` declares the Vi wrappers/blob types the
  // invokers import from a sibling directory. Both are indexed so a wrapper
  // type is not misreported as unresolved.
  const declarationFiles = listFiles(codeRoot, path => path.endsWith(".ts"));
  const viRoot = join(root, source.base, "vi");
  if (existsSync(viRoot)) declarationFiles.push(...listFiles(viRoot, path => path.endsWith(".ts")));
  const typeIndex = buildTypeIndex(declarationFiles);
  const invokers = [];
  const endpoints = [];
  for (const path of listFiles(codeRoot, path => path.endsWith("_invoker.ts"))) {
    const text = readFileSync(path, "utf8");
    const parsed = parseInvoker(path, root);
    invokers.push({
      source: source.id,
      invoker: /export class (\w+)/.exec(text)?.[1],
      path: repoRelative(root, path),
      sha256: sha256(text),
      endpoints: parsed.length,
    });
    endpoints.push(...parsed);
  }
  return { source: source.id, base: source.base, present: true, typeIndex, invokers, endpoints };
}

function withSchemaRefs(endpoint, typeIndex, root) {
  const refFor = (role, declaredType) => referencedTypes(declaredType).map(name => {
    const resolved = typeIndex.get(name);
    return {
      role, declaredType, name,
      status: resolved ? "resolved" : "unresolved",
      kind: resolved?.kind,
      path: resolved ? repoRelative(root, resolved.path) : undefined,
    };
  });
  const schemaRefs = [
    ...(endpoint.inner ? refFor("return", endpoint.inner) : []),
    ...endpoint.params.flatMap(param => param.declaredType ? refFor("parameter", param.declaredType) : []),
  ];
  const unresolvedTypes = [...new Set(schemaRefs.filter(ref => ref.status === "unresolved").map(ref => `${ref.role}:${ref.name}`))];
  endpoint.schemaStatus = unresolvedTypes.length ? "unresolved" : "resolved";
  endpoint.unresolvedTypes = unresolvedTypes;
  endpoint.schemaRefs = schemaRefs;

  return endpoint;
}

const UNPORTED_REASON = "Present in the DPlanet SDK source tree but absent from this application's generated snapshot. No runtime client, adapter or v2 contract exists here, so it is discoverable and reserved: no raw RPC dispatch is provided.";

/**
 * Projects both sources.
 *
 * The active snapshot is the contract this application runs. The full SDK is a
 * superset used for discovery. A route present in both keeps one entry that
 * records both signatures; when they differ the entry is marked `conflict` and
 * the active snapshot still wins for runtime routing. Nothing is overwritten.
 */
export function buildServiceCatalog(root = process.cwd(), options = {}) {
  const includeFullSdk = options.includeFullSdk !== false;
  const scanned = [];
  for (const source of SOURCE_ROOTS) {
    if (source.id !== ACTIVE_ROOT_ID && !includeFullSdk) continue;
    const result = scanSource(root, source);
    scanned.push({ source, result });
  }
  const active = scanned.find(entry => entry.source.id === ACTIVE_ROOT_ID)?.result;
  const full = scanned.find(entry => entry.source.id !== ACTIVE_ROOT_ID)?.result;

  const activeEndpoints = active?.endpoints ?? [];
  const fullEndpoints = full?.endpoints ?? [];
  const keyOf = endpoint => `${endpoint.module}|${endpoint.route}`;
  const activeByKey = new Map(activeEndpoints.map(endpoint => [keyOf(endpoint), endpoint]));
  const fullByKey = new Map(fullEndpoints.map(endpoint => [keyOf(endpoint), endpoint]));

  const endpoints = [];
  for (const endpoint of activeEndpoints) {
    const twin = fullByKey.get(keyOf(endpoint));
    const variants = [variantOf(endpoint, ACTIVE_ROOT_ID)];
    if (twin) variants.push(variantOf(twin, full?.source ?? "dplanet-sdk"));
    const conflict = variants.length > 1 && variants[0].signature !== variants[1].signature;
    const adapter = ADAPTER_ROUTES[endpoint.id];
    withSchemaRefs(endpoint, active.typeIndex, root);
    endpoint.provenance = {
      inActiveSnapshot: true,
      presentInFullSdk: Boolean(twin),
      unported: false,
      conflict,
      roots: [ACTIVE_ROOT_ID, ...(twin ? [full?.source ?? "dplanet-sdk"] : [])],
      // Only a route that exists in both sources has competing variants.
      ...(twin ? { sourceVariants: variants } : {}),
      ...(conflict ? {
        conflictNote: "The active snapshot and the SDK source declare different signatures for this route. The snapshot stays authoritative for runtime routing; the SDK variant is recorded, not applied.",
      } : {}),
      ...(twin ? {} : { note: "This route exists only in the active snapshot; it is not present in the current SDK source scan." }),
    };
    endpoint.transport = {
      protocol: endpoint.stream.download ? "rpc-download-stream" : "rpc-json-multipart",
      invoker: "@timemachine/api-client RPCInvoker.Request",
      httpMethod: endpoint.httpMethod ?? "unknown",
      callability: adapter ? "adapter" : "reserved",
      ...(adapter ? { adapter } : {
        reason: reservedReason(endpoint.id),
        ...(WITHDRAWN_ADAPTERS[endpoint.id] ? { relatedActionId: WITHDRAWN_ADAPTERS[endpoint.id].actionId } : {}),
      }),
    };
    endpoints.push(endpoint);
  }
  for (const endpoint of fullEndpoints) {
    if (activeByKey.has(keyOf(endpoint))) continue;
    withSchemaRefs(endpoint, full.typeIndex, root);
    endpoint.provenance = {
      inActiveSnapshot: false,
      presentInFullSdk: true,
      unported: true,
      conflict: false,
      roots: [full.source],
    };
    endpoint.transport = {
      protocol: endpoint.stream.download ? "rpc-download-stream" : "rpc-json-multipart",
      invoker: "@timemachine/api-client RPCInvoker.Request",
      httpMethod: endpoint.httpMethod ?? "unknown",
      callability: "reserved",
      reason: UNPORTED_REASON,
    };
    endpoints.push(endpoint);
  }

  endpoints.sort((left, right) => left.id.localeCompare(right.id));
  const ids = endpoints.map(endpoint => endpoint.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const invokers = [...(active?.invokers ?? []), ...(full?.invokers ?? [])];

  const manifestPath = join(root, MANIFEST_PATH);
  // A missing manifest is a distinct, verifiable state from an unreadable one;
  // neither is reported as a hash match.
  let manifest = { status: "absent" };
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      const declared = new Map((parsed.files ?? []).map(file => [file.path, file]));
      const mismatched = [];
      for (const invoker of active?.invokers ?? []) {
        // Manifest paths are relative to packages/generated-api.
        const manifestPathKey = invoker.path.replace("packages/generated-api/", "");
        const entry = declared.get(manifestPathKey);
        if (!entry) mismatched.push({ path: invoker.path, reason: "absent-from-manifest" });
        else if (entry.sha256 !== invoker.sha256) mismatched.push({ path: invoker.path, reason: "sha256-mismatch" });
      }
      manifest = {
        status: mismatched.length ? "mismatch" : "match",
        sourceClosureSha256: parsed.sourceClosureSha256,
        files: (parsed.files ?? []).length,
        checked: active?.invokers.length ?? 0,
        mismatched,
      };
    } catch (error) {
      manifest = { status: "unreadable", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const activeCount = endpoints.filter(endpoint => endpoint.provenance.inActiveSnapshot).length;
  const unportedCount = endpoints.filter(endpoint => endpoint.provenance.unported).length;
  return {
    schemaVersion: 2,
    generatedFrom: SOURCE_ROOTS.map(source => source.base),
    schemaNote: "Type names only. Field-level DTO projection is not provided; open schemaRefs paths. Inherited fields are not projected.",
    sources: SOURCE_ROOTS.map(source => {
      const found = scanned.find(entry => entry.source.id === source.id)?.result;
      return {
        id: source.id,
        base: source.base,
        role: source.id === ACTIVE_ROOT_ID ? "active-contract" : "full-sdk-reference",
        present: Boolean(found),
        invokers: found?.invokers.length ?? 0,
        endpoints: found?.endpoints.length ?? 0,
      };
    }),
    counts: {
      invokers: active?.invokers.length ?? 0,
      endpoints: endpoints.length,
      activeSnapshotInvokers: active?.invokers.length ?? 0,
      activeSnapshotEndpointCount: activeCount,
      fullSourceInvokerCount: full?.invokers.length ?? 0,
      fullSourceEndpointCount: full?.endpoints.length ?? 0,
      unportedEndpointCount: unportedCount,
      snapshotOnlyEndpointCount: endpoints.filter(endpoint => endpoint.provenance.inActiveSnapshot && !endpoint.provenance.presentInFullSdk).length,
      conflictCount: endpoints.filter(endpoint => endpoint.provenance.conflict).length,
      callable: endpoints.filter(endpoint => endpoint.transport.callability === "adapter").length,
      reserved: endpoints.filter(endpoint => endpoint.transport.callability === "reserved").length,
      unresolvedSchema: endpoints.filter(endpoint => endpoint.schemaStatus === "unresolved").length,
    },
    invokers,
    endpoints,
    manifest,
    duplicates,
  };
}

/**
 * Writes the generated catalog the runtime CLI loads.
 *
 * Regeneration is all-or-nothing: it refuses when either source is absent (a
 * full-SDK-less scan would silently replace 289 endpoints, 235 of them
 * reserved, with the 54 active ones), when the projection has duplicate ids,
 * or when the result fails its own invariants and hash checks. The artifact is
 * written to a temporary file and renamed, so a failure cannot leave a partial
 * catalog behind or damage the previous one.
 */
export function writeServiceCatalogJson(root = process.cwd(), path = join(root, CATALOG_PATH)) {
  const catalog = buildServiceCatalog(root);
  const absent = catalog.sources.filter(source => !source.present).map(source => source.id);
  if (absent.length) {
    throw new Error(`Refusing to write the service catalog: source ${absent.join(", ")} is absent from this checkout, so a regeneration would drop the endpoints that source contributes.`);
  }
  if (catalog.duplicates.length) {
    throw new Error(`Refusing to write the service catalog: duplicate endpoint ids ${catalog.duplicates.join(", ")}.`);
  }
  const check = checkServiceCatalog(catalog, root);
  if (!check.ok) {
    throw new Error(`Refusing to write the service catalog: ${check.failures.join("; ")}.`);
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(catalog)}\n`);
  renameSync(temporary, path);
  return catalog;
}

/**
 * Loads the generated JSON catalog. The runtime does not scan the SDK tree; if
 * the artifact is missing the caller gets a live projection labelled as such.
 */
export function readServiceCatalog(root = process.cwd()) {
  const path = join(root, CATALOG_PATH);
  if (existsSync(path)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("The generated service catalog is not valid JSON; regenerate it with `services catalog --write`.");
    }
    if (parsed.schemaVersion !== 2) {
      throw new Error(`Generated service catalog schemaVersion ${parsed.schemaVersion} is not supported; regenerate it.`);
    }
    return { ...parsed, loadedFrom: "generated-catalog" };
  }
  return { ...buildServiceCatalog(root), loadedFrom: "live-build" };
}

/** Invariants plus on-disk hash verification. */
export function checkServiceCatalog(catalog, root = process.cwd()) {
  const failures = [];
  const absentSources = [];
  const active = catalog.sources.find(source => source.id === ACTIVE_ROOT_ID);
  if (!active?.present) failures.push("the active snapshot source is absent");
  else {
    if (active.invokers !== 11) failures.push(`expected 11 active invokers, found ${active.invokers}`);
    if (active.endpoints !== 54) failures.push(`expected 54 active endpoints, found ${active.endpoints}`);
  }
  if (catalog.counts.activeSnapshotEndpointCount !== active?.endpoints) {
    failures.push("activeSnapshotEndpointCount does not match the active source scan");
  }
  if (catalog.duplicates.length) failures.push(`duplicate endpoint ids: ${catalog.duplicates.join(", ")}`);
  for (const endpoint of catalog.endpoints) {
    if (!endpoint.httpMethod) failures.push(`${endpoint.id}: no RPCInvoker.Request verb`);
    if (!endpoint.declaresReturn) failures.push(`${endpoint.id}: no declared Promise return type`);
    if (endpoint.params.some(param => param.classification === "unparsed")) failures.push(`${endpoint.id}: unparsed parameter declaration`);
    if (endpoint.provenance.conflict && endpoint.transport.callability === "adapter") {
      failures.push(`${endpoint.id}: a conflicting route must not be routed through an adapter`);
    }
    if (endpoint.provenance.unported && endpoint.transport.callability !== "reserved") {
      failures.push(`${endpoint.id}: an unported endpoint must stay reserved`);
    }
  }
  if (catalog.manifest.status !== "match") {
    failures.push(`source manifest ${catalog.manifest.status}${catalog.manifest.mismatched?.length
      ? `: ${catalog.manifest.mismatched.map(entry => `${entry.path} ${entry.reason}`).join(", ")}`
      : ""}`);
  }
  // Every endpoint is reserved: no page action has been proven to implement an
  // endpoint's contract, so a routed endpoint is a regression, not a feature.
  for (const endpoint of catalog.endpoints) {
    if (endpoint.transport.callability === "adapter" || endpoint.transport.adapter) {
      failures.push(`${endpoint.id}: routed through an action whose contract is not proven equivalent`);
    }
    if (endpoint.transport.callability === "reserved" && !endpoint.transport.reason) {
      failures.push(`${endpoint.id}: a reserved endpoint must state why it cannot be called`);
    }
  }
  if (catalog.counts.callable !== 0) failures.push(`expected 0 callable endpoints, found ${catalog.counts.callable}`);
  // Hashes are verified only for files that exist in this checkout.
  for (const invoker of catalog.invokers) {
    const path = join(root, invoker.path);
    if (!existsSync(path)) {
      if (invoker.source === ACTIVE_ROOT_ID) failures.push(`${invoker.path}: active source file is missing`);
      else absentSources.push(invoker.path);
      continue;
    }
    if (sha256(readFileSync(path, "utf8")) !== invoker.sha256) {
      failures.push(`${invoker.path}: sha256-mismatch`);
    }
  }
  return { ok: failures.length === 0, failures, absentSources };
}

export { ADAPTER_ROUTES, BLOCKED_REASONS, CATALOG_PATH, SOURCE_ROOTS, WITHDRAWN_ADAPTERS };
