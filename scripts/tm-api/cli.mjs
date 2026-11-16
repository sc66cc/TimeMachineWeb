#!/usr/bin/env node
/**
 * `tm-api` — a shell interface over the frontend v2 contracts that already
 * exist in the page (`window.timeMachineAgent.v2`) plus an offline catalog of
 * the generated Server endpoints.
 *
 * Design constraints this file keeps:
 *
 * - stdout is machine output and nothing else (one JSON object, or NDJSON for
 *   `logs export`). Diagnostics go to stderr and are scrubbed.
 * - Request parameters never appear in argv. They arrive through
 *   `--input-file` or stdin, are serialized into one JSON literal, and are
 *   embedded in a fixed page script that is written to the child's stdin.
 * - The API decides completion. Inline operations are never given a job wait
 *   or an `accepted` completion the caller did not ask for, and a wait timeout
 *   never cancels the job.
 * - Exit codes are stable (see EXIT_CODES) and repeated in the JSON payload.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BridgeError, callPage, openPage, scrubSecrets } from "./bridge.mjs";
import { buildServiceCatalog, checkServiceCatalog, readServiceCatalog, writeServiceCatalogJson } from "./service-catalog.mjs";

const EXIT_CODES = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  "not-implemented": 3,
  unavailable: 4,
  auth: 5,
  timeout: 6,
  partial: 7,
  drift: 8,
});

const USAGE = `tm-api — call the TimeMachine frontend v2 contracts from a shell

  tm-api connect --url <url> [--demo] [--session S] [--wait-ms N]
  tm-api ping [--session S]
  tm-api catalog [--kind K] [--scope S] [--availability A] [--prefix P] [--check]
  tm-api describe <id>
  tm-api exec <id> [--api-version 1|2] [--completion committed|accepted] [--timeout-ms N]
  tm-api query <id>
  tm-api jobs get <jobId>
  tm-api jobs wait <jobId> [--timeout-ms N]
  tm-api jobs cancel <jobId>
  tm-api logs query | logs export [--format ndjson|json] | logs clear
  tm-api events collect [--types a,b] [--sections s,...] [--duration-ms N] [--max-events N]
  tm-api batch [--concurrency N]
  tm-api services catalog [--check] [--summary] [--full] [--write]
  tm-api services describe <id>
  tm-api services call <id> [--api-version N]

Input (exec/query/batch/logs/events/services call) is JSON from --input-file or
stdin; it is never read from argv. Empty stdin means {}.

"services catalog --write" regenerates scripts/tm-api/service-catalog.json. It is
the only command that accepts --write, and it refuses to write when a source is
absent or the generated catalog fails its own invariants, so the previous
artifact is never replaced by a partial scan.

Global: --session <name> (default tm-api) --pretty --bridge-timeout-ms N --help

Exit codes: 0 ok, 1 internal, 2 usage/validation, 3 not-implemented,
4 transport/unavailable, 5 auth, 6 job wait timeout, 7 batch partial failure,
8 contract drift.
`;

const VALUE_FLAGS = new Set([
  "session", "url", "wait-ms", "kind", "scope", "availability", "prefix",
  "api-version", "completion", "timeout-ms", "input-file", "format", "types",
  "sections", "duration-ms", "max-events", "concurrency", "bridge-timeout-ms",
]);
const BOOLEAN_FLAGS = new Set(["demo", "check", "summary", "full", "write", "pretty", "help", "debug"]);

class UsageError extends Error {}

/** Strict flag parsing: an unknown flag is a usage error, never ignored. */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown flag --${name}.`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`Flag --${name} needs a value.`);
    flags[name] = value;
  }
  return { flags, positionals };
}

function integerFlag(flags, name, { min = 1, max = 2_147_483_647 } = {}) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`--${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

/** A key that can carry a credential, compared without punctuation or case. */
const SENSITIVE_KEY = /(token|password|passwd|pwd|secret|digest|code|apikey|authorization|credential|cookie)/;

function normalizeKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Every string inside a subtree, so `{tokens: [..]}` is not silently skipped. */
function stringsIn(value, found) {
  if (typeof value === "string") found.push(value);
  else if (value && typeof value === "object") for (const nested of Object.values(value)) stringsIn(nested, found);
  return found;
}

/**
 * Values worth scrubbing from anything this process prints. Sensitive keys are
 * matched after stripping punctuation and case (`apiKey`, `api-key`, `API_KEY`),
 * and collected at any depth and any length: a 3-character password is still a
 * password. Non-string credentials are left to the label rule in
 * `scrubSecrets`, so a literal `true`/`1234` is never swapped blindly.
 */
function collectSecrets(value, found = []) {
  if (value === null || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(normalizeKey(key))) stringsIn(nested, found);
    else if (nested && typeof nested === "object") collectSecrets(nested, found);
  }
  return [...new Set(found.filter(secret => secret.length > 0))];
}

function readInput(flags, { requireObject = true } = {}) {
  let text;
  if (flags["input-file"]) {
    text = readFileSync(resolve(flags["input-file"]), "utf8");
  } else if (process.stdin.isTTY) {
    text = "";
  } else {
    text = readFileSync(0, "utf8");
  }
  if (!text.trim()) return requireObject ? {} : undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("Input is not valid JSON. Pass parameters through --input-file or stdin.");
  }
  if (requireObject && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new UsageError("Input must be a JSON object.");
  }
  return parsed;
}

/** Exit code for one v2 ApiResult or one v1 AgentActionResult. */
function exitForResult(result) {
  if (!result || typeof result !== "object") return EXIT_CODES.internal;
  if (result.ok === true) return EXIT_CODES.ok;
  const kind = String(result.error?.kind ?? "");
  const code = String(result.error?.code ?? "").toUpperCase();
  // v1 uses numeric HTTP-like codes; v2 uses an upper-case kind string.
  if (code === "400") return EXIT_CODES.usage;
  if (code === "401") return EXIT_CODES.auth;
  if (code === "501") return EXIT_CODES["not-implemented"];
  if (code === "409" || code === "500") return EXIT_CODES.internal;
  if (code === "TIMEOUT" || kind === "timeout") return EXIT_CODES.timeout;
  if (code === "EXPIRED_JOB" || kind === "expired-job") return EXIT_CODES.usage;
  if (kind === "not-implemented" || kind === "unsupported" || code === "NOT_IMPLEMENTED" || code === "UNSUPPORTED") {
    return EXIT_CODES["not-implemented"];
  }
  if (kind === "auth") return EXIT_CODES.auth;
  if (kind === "validation") return EXIT_CODES.usage;
  if (kind === "runtime-disposed" || kind === "no-facade") return EXIT_CODES.unavailable;
  return EXIT_CODES.internal;
}

function statusForResult(result, { reloadRequired = false } = {}) {
  if (reloadRequired) return "page-reload-required";
  if (result && result.ok === true) return result.status === "accepted" ? "accepted" : "ok";
  return (result && (result.status === "unknown" ? "timeout" : "failed")) || "failed";
}

/**
 * A failed result's own diagnostics. Only `message` is rewritten; the typed
 * metadata (`kind`, `code`, `retryable`, any `status`) is carried through
 * untouched, so exit-code mapping and branching behave exactly as before.
 */
function sanitizeError(error, secrets) {
  if (typeof error.message !== "string") return error;
  const message = scrubSecrets(error.message, secrets);
  return message === error.message ? error : { ...error, message };
}

/**
 * Scrubs failure diagnostics anywhere in an outgoing payload: a failed
 * `ApiResult`, a `jobs get` snapshot whose nested `result` failed while the
 * command itself succeeded, a `batch` item's failure or thrown message. The
 * `data` subtree is never entered — that is the page's own DTO (or a successful
 * item's payload) and is passed through unchanged — and no other key is
 * rewritten. Nothing is mutated; a changed branch is copied.
 */
function sanitizeDiagnostics(value, secrets) {
  if (Array.isArray(value)) return value.map(entry => sanitizeDiagnostics(entry, secrets));
  if (!value || typeof value !== "object") return value;
  let output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "data" || !nested || typeof nested !== "object") continue;
    let next;
    if (value.ok !== true && key === "error") next = sanitizeError(nested, secrets);
    else if (value.ok !== true && key === "threw" && typeof nested.message === "string") {
      next = { ...nested, message: scrubSecrets(nested.message, secrets) };
    } else next = sanitizeDiagnostics(nested, secrets);
    if (next !== nested) (output ??= { ...value })[key] = next;
  }
  return output ?? value;
}

class Cli {
  constructor(flags) {
    this.flags = flags;
    this.session = flags.session ?? process.env.TM_API_SESSION ?? "tm-api";
    this.pretty = flags.pretty === true;
    this.secrets = [];
    this.bridgeTimeoutMs = Number(flags["bridge-timeout-ms"] ?? 120_000);
  }

  async page(payload, { timeoutMs } = {}) {
    // The transport is synchronous (one child process per command); the method
    // stays async so every caller awaits the same shape.
    const envelope = callPage({
      session: this.session,
      payload,
      timeoutMs: timeoutMs ?? Math.max(this.bridgeTimeoutMs, 120_000),
      secrets: this.secrets,
    });
    return envelope.result;
  }

  emit(payload, exitCode) {
    // One output boundary: a command that emits a page result directly must not
    // be able to leak its failure message, so diagnostics are scrubbed here
    // rather than in each caller.
    const body = { ...sanitizeDiagnostics(payload, this.secrets), exitCode };
    process.stdout.write(`${JSON.stringify(body, null, this.pretty ? 2 : 0)}\n`);
    return exitCode;
  }

  fail(status, message, extra = {}) {
    const exitCode = EXIT_CODES[status] ?? EXIT_CODES.internal;
    const safe = scrubSecrets(message, this.secrets);
    process.stderr.write(`tm-api: ${status}: ${safe}\n`);
    return this.emit({ ok: false, status, error: { kind: status, message: safe }, ...extra }, exitCode);
  }
}

/**
 * The connect target becomes the child's `open` argv, so it must be a public
 * application URL: no userinfo, no query and no fragment. Refusals happen
 * before any child process exists and never echo the URL that was rejected.
 */
function requirePublicUrl(raw) {
  if (!raw) throw new UsageError("connect needs --url <url>; there is no implicit demo or localhost default.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError("--url must be an absolute http(s) or file URL.");
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new UsageError("--url must be an http(s) or file URL.");
  }
  if (parsed.username || parsed.password) {
    throw new UsageError("--url must not embed credentials (user:password@host). Open the app URL and sign in inside the page.");
  }
  if (parsed.search || parsed.hash) {
    const parts = [parsed.search ? "query" : undefined, parsed.hash ? "fragment" : undefined].filter(Boolean);
    throw new UsageError(`--url must not carry a ${parts.join(" or ")}: the app routes itself and a login code or token does not belong in the address.`);
  }
  return raw;
}

/**
 * A page-reported address, rebuilt from its structure. userinfo, query and
 * fragment are dropped, so a redirect cannot leak a credential whatever its
 * length, label or key name; the public protocol, host and path stay. Text that
 * is not a parseable URL is never quoted back.
 */
function publicHref(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return "[unparseable address omitted]";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  // The label scrub still runs over the rebuilt address: a value that arrived
  // as path text (`/back Authorization: Basic ...`) is not a URL field.
  return parsed.href;
}

/** Every ping this tool prints goes through the same structural redaction. */
function redactHref(ping, secrets) {
  if (!ping || typeof ping.href !== "string") return ping;
  return { ...ping, href: publicHref(scrubSecrets(ping.href, secrets)) };
}

async function commandPing(cli) {
  const ping = await cli.page({ op: "ping" });
  return cli.emit({
    ok: ping.installed === true,
    status: ping.installed ? "ok" : "unavailable",
    session: cli.session,
    ping: redactHref(ping, cli.secrets),
  }, ping.installed ? EXIT_CODES.ok : EXIT_CODES.unavailable);
}

async function commandConnect(cli) {
  const url = requirePublicUrl(cli.flags.url);
  const waitMs = integerFlag(cli.flags, "wait-ms", { min: 0, max: 120_000 }) ?? 20_000;
  const startedAt = Date.now();
  openPage({ session: cli.session, url, timeoutMs: Math.max(cli.bridgeTimeoutMs, 120_000), secrets: cli.secrets });
  const ping = await waitForFacade(cli, waitMs);
  if (!ping.installed) {
    return cli.emit({
      ok: false, status: "unavailable",
      error: { kind: "no-facade", message: "The page loaded but window.timeMachineAgent.v2 was never installed." },
      session: cli.session, url: scrubSecrets(url, cli.secrets), waitedMs: Date.now() - startedAt,
    }, EXIT_CODES.unavailable);
  }
  const summary = {
    ok: true, status: "connected", session: cli.session,
    url: scrubSecrets(url, cli.secrets), ping: redactHref(ping, cli.secrets),
    connectedMs: Date.now() - startedAt, demo: false,
  };
  if (cli.flags.demo) {
    // Explicit opt-in only: the local PALEOMAP demo is a v1 page-reload action.
    const before = ping.bootId;
    const selected = await cli.page({ op: "execute", apiVersion: 1, id: "model.select", input: { source: "local-demo" } });
    if (!selected.result?.ok) {
      return cli.emit({
        ok: false, status: "failed", session: cli.session, url, demo: true,
        error: selected.result?.error ?? { kind: "internal", message: "model.select returned no result." },
        result: selected.result,
      }, exitForResult(selected.result));
    }
    if (!selected.result.reloadRequired) {
      return cli.emit({
        ok: false, status: "failed", session: cli.session, url, demo: true,
        error: { kind: "internal", message: "model.select did not report reloadRequired, so the demo source is not committed." },
        result: selected.result,
      }, EXIT_CODES.internal);
    }
    const after = await waitForBootId(cli, before, Math.max(waitMs, 60_000));
    return cli.emit({ ...summary, demo: true, ping: redactHref(after, cli.secrets), bootIdChanged: after.bootId !== before,
      reloadMs: Date.now() - startedAt }, EXIT_CODES.ok);
  }
  return cli.emit(summary, EXIT_CODES.ok);
}

async function waitForFacade(cli, waitMs) {
  const deadline = Date.now() + waitMs;
  let last = { installed: false };
  for (;;) {
    try {
      last = await cli.page({ op: "ping" });
      if (last.installed) return last;
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      last = { installed: false, transport: error.code, message: error.message };
    }
    if (Date.now() >= deadline) return last;
    await new Promise(res => setTimeout(res, 500));
  }
}

async function waitForBootId(cli, previous, waitMs) {
  const deadline = Date.now() + waitMs;
  let last = { installed: false };
  for (;;) {
    try {
      last = await cli.page({ op: "ping" });
      if (last.installed && last.bootId !== previous) return last;
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      last = { installed: false, transport: error.code, message: error.message };
    }
    if (Date.now() >= deadline) return last;
    await new Promise(res => setTimeout(res, 400));
  }
}

function catalogFilter(flags) {
  const filter = {};
  if (flags.kind) filter.kind = flags.kind;
  if (flags.scope) filter.scope = flags.scope;
  if (flags.availability) filter.availability = flags.availability;
  if (flags.prefix) filter.idPrefix = flags.prefix;
  return filter;
}

async function commandCatalog(cli) {
  const filter = catalogFilter(cli.flags);
  const { catalog } = await cli.page({ op: "catalog", filter });
  if (!cli.flags.check) {
    return cli.emit({ ok: true, status: "ok", count: catalog.length, filter, items: catalog }, EXIT_CODES.ok);
  }
  const ids = catalog.map(item => item.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const missing = [];
  const unresolved = [];
  const generic = [];
  // One page call for the whole sweep: the check reuses the warm document
  // instead of paying a browser round trip per id.
  const { descriptors } = await cli.page({ op: "describeMany", ids });
  for (const [index, id] of ids.entries()) {
    const descriptor = descriptors[index];
    if (!descriptor) {
      missing.push(id);
      continue;
    }
    const input = descriptor.inputSchema ?? {};
    const output = descriptor.outputSchema ?? {};
    // A reserved entry documents intent in `description` and has no type; that
    // is reported as reserved-metadata, never as a resolved schema.
    const reservedMetadata = descriptor.availability === "not-implemented" && !input.type && !output.type;
    const genericOutput = output.type === "object" && output.additionalProperties === true && !output.properties && !output.required;
    if (!reservedMetadata && !input.type) unresolved.push(id);
    if (genericOutput) generic.push(id);
  }
  const ok = missing.length === 0 && duplicates.length === 0 && unresolved.length === 0;
  return cli.emit({
    ok, status: ok ? "ok" : "drift",
    count: catalog.length,
    byAvailability: catalog.reduce((acc, item) => ({ ...acc, [item.availability]: (acc[item.availability] ?? 0) + 1 }), {}),
    byKind: catalog.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {}),
    duplicates, missingDescriptors: missing, unresolvedInputSchema: unresolved,
    genericOutputIds: generic,
  }, ok ? EXIT_CODES.ok : EXIT_CODES.drift);
}

async function commandDescribe(cli, id) {
  if (!id) throw new UsageError("describe needs an operation id.");
  const { descriptor } = await cli.page({ op: "describe", id });
  if (!descriptor) {
    return cli.emit({ ok: false, status: "failed", id,
      error: { kind: "validation", message: "Unknown operation id." } }, EXIT_CODES.usage);
  }
  return cli.emit({ ok: true, status: "ok", descriptor }, EXIT_CODES.ok);
}

async function commandExec(cli, id) {
  if (!id) throw new UsageError("exec needs an operation id.");
  const apiVersion = Number(cli.flags["api-version"] ?? 2);
  if (![1, 2].includes(apiVersion)) throw new UsageError("--api-version must be 1 or 2.");
  const input = readInput(cli.flags);
  cli.secrets = collectSecrets(input);
  const completion = cli.flags.completion;
  if (completion !== undefined && !["committed", "accepted"].includes(completion)) {
    throw new UsageError("--completion must be committed or accepted.");
  }
  const timeoutMs = integerFlag(cli.flags, "timeout-ms");
  if (apiVersion === 1 && (completion !== undefined || timeoutMs !== undefined)) {
    throw new UsageError("--completion/--timeout-ms are v2 job options; v1 executes through the legacy action.");
  }
  // Options are only sent when the caller asked for them: an inline operation
  // must not be handed a job wait it never requested.
  const options = completion === undefined && timeoutMs === undefined
    ? undefined
    : { ...(completion === undefined ? {} : { completion }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const payload = apiVersion === 1
    ? { op: "execute", apiVersion: 1, id, input }
    : { op: "execute", apiVersion: 2, id, input, options };
  const { result } = await cli.page(payload, {
    timeoutMs: Math.max(cli.bridgeTimeoutMs, (timeoutMs ?? 0) + 30_000),
  });
  const reloadRequired = apiVersion === 1 && result?.reloadRequired === true;
  const exitCode = exitForResult(result);
  return cli.emit({
    ok: result?.ok === true, status: statusForResult(result, { reloadRequired }),
    apiVersion, actionId: id, result,
    ...(reloadRequired ? { note: "The action scheduled a page reload. Re-run ping/query after the document changes; bootId identifies the new document." } : {}),
  }, exitCode);
}

async function commandQuery(cli, id) {
  if (!id) throw new UsageError("query needs an operation id.");
  const input = readInput(cli.flags);
  cli.secrets = collectSecrets(input);
  const { result } = await cli.page({ op: "query", id, input });
  return cli.emit({ ok: result?.ok === true, status: statusForResult(result), actionId: id, result }, exitForResult(result));
}

async function commandJobs(cli, sub, jobId) {
  if (!["get", "wait", "cancel"].includes(sub ?? "")) throw new UsageError("jobs needs get, wait or cancel.");
  if (!jobId) throw new UsageError(`jobs ${sub} needs a job id.`);
  if (sub === "get") {
    const { job } = await cli.page({ op: "jobGet", jobId });
    if (!job) {
      return cli.emit({ ok: false, status: "failed", jobId,
        error: { kind: "expired-job", message: "Unknown, expired or previous-document job." } }, EXIT_CODES.usage);
    }
    return cli.emit({ ok: true, status: job.status, job }, EXIT_CODES.ok);
  }
  if (sub === "wait") {
    const timeoutMs = integerFlag(cli.flags, "timeout-ms");
    const options = timeoutMs === undefined ? undefined : { timeoutMs };
    const { result } = await cli.page({ op: "jobWait", jobId, options }, {
      timeoutMs: Math.max(cli.bridgeTimeoutMs, (timeoutMs ?? 0) + 30_000),
    });
    return cli.emit({ ok: result?.ok === true, status: statusForResult(result), jobId, result }, exitForResult(result));
  }
  const { result } = await cli.page({ op: "jobCancel", jobId });
  return cli.emit({
    ok: result?.ok === true, status: statusForResult(result), jobId, result,
    ...(result?.status === "accepted"
      ? { note: "Cancellation was requested, not confirmed. The owner must settle the job; query jobs get." }
      : {}),
  }, exitForResult(result));
}

async function commandLogs(cli, sub) {
  if (sub === "query") {
    const filter = readInput(cli.flags);
    cli.secrets = collectSecrets(filter);
    const { page } = await cli.page({ op: "logsQuery", filter });
    return cli.emit({ ok: true, status: "ok", page }, EXIT_CODES.ok);
  }
  if (sub === "clear") {
    const { cleared } = await cli.page({ op: "logsClear" });
    return cli.emit({ ok: cleared === true, status: "ok" }, EXIT_CODES.ok);
  }
  if (sub === "export") {
    const filter = readInput(cli.flags);
    cli.secrets = collectSecrets(filter);
    const { text } = await cli.page({ op: "logsExport", filter });
    const format = cli.flags.format ?? "ndjson";
    if (format === "ndjson") {
      // The Blob already begins with the app's diagnostic-summary line.
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return EXIT_CODES.ok;
    }
    if (format !== "json") throw new UsageError("--format must be ndjson or json.");
    return cli.emit({ ok: true, status: "ok", format: "ndjson", text }, EXIT_CODES.ok);
  }
  throw new UsageError("logs needs query, export or clear.");
}

async function commandEvents(cli, sub) {
  if (sub !== "collect") throw new UsageError("events needs collect.");
  const input = readInput(cli.flags);
  cli.secrets = collectSecrets(input);
  const types = cli.flags.types ? String(cli.flags.types).split(",").map(v => v.trim()).filter(Boolean) : input.types;
  const sections = cli.flags.sections ? String(cli.flags.sections).split(",").map(v => v.trim()).filter(Boolean) : input.sections;
  const filter = {
    ...(types === undefined ? {} : { types }),
    ...(sections === undefined ? {} : { sections }),
  };
  const durationMs = integerFlag(cli.flags, "duration-ms", { min: 1, max: 60_000 })
    ?? (input.durationMs === undefined ? 2000 : Number(input.durationMs));
  const maxEvents = integerFlag(cli.flags, "max-events", { min: 1, max: 1000 })
    ?? (input.maxEvents === undefined ? 200 : Number(input.maxEvents));
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 60_000) throw new UsageError("durationMs must be 1..60000.");
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new UsageError("maxEvents must be 1..1000.");
  const collected = await cli.page({ op: "eventsCollect", filter, durationMs, maxEvents }, {
    timeoutMs: Math.max(cli.bridgeTimeoutMs, durationMs + 30_000),
  });
  const lines = [
    { kind: "collection", ...collected.window, events: collected.events.length,
      overflow: collected.overflow, bootId: collected.bootId,
      note: `${collected.window.note} This NDJSON stream is a finite window, not a live tail.` },
    ...collected.events.map(event => ({ kind: "event", ...event })),
  ];
  process.stdout.write(`${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
  return EXIT_CODES.ok;
}

async function commandBatch(cli) {
  const input = readInput(cli.flags, { requireObject: false });
  const items = Array.isArray(input) ? input : input?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new UsageError("batch needs a non-empty JSON array (or {items:[...]}) of {op,id,input} objects.");
  }
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") throw new UsageError(`item ${index} needs a string id.`);
    if (item.op !== undefined && !["execute", "query"].includes(item.op)) throw new UsageError(`item ${index} op must be execute or query.`);
    if (item.apiVersion !== undefined && ![1, 2].includes(item.apiVersion)) throw new UsageError(`item ${index} apiVersion must be 1 or 2.`);
  }
  cli.secrets = collectSecrets(items);
  const concurrency = integerFlag(cli.flags, "concurrency", { min: 1, max: 4 }) ?? 1;
  const { results } = await cli.page({
    op: "batch",
    concurrency,
    items: items.map(item => ({
      op: item.op ?? "execute",
      id: item.id,
      input: item.input ?? {},
      apiVersion: item.apiVersion ?? 2,
      options: item.options,
    })),
  });
  const failures = results.filter(row => !row.result || row.result.ok !== true);
  const exitCode = failures.length === 0 ? EXIT_CODES.ok : EXIT_CODES.partial;
  return cli.emit({
    ok: failures.length === 0,
    status: failures.length === 0 ? "ok" : "partial",
    concurrency, total: results.length, failed: failures.length,
    results,
  }, exitCode);
}

/** Filters the catalog listing; `active` is what this app can reach today. */
function serviceScopeFilter(endpoints, scope) {
  if (scope === "active") return endpoints.filter(endpoint => endpoint.provenance.inActiveSnapshot);
  if (scope === "unported") return endpoints.filter(endpoint => endpoint.provenance.unported);
  if (scope !== undefined && scope !== "all") throw new UsageError("--scope must be active, unported or all.");
  return endpoints;
}

function compactEndpoint(endpoint, full) {
  return {
    id: endpoint.id,
    route: endpoint.route,
    httpMethod: endpoint.transport.httpMethod,
    callability: endpoint.transport.callability,
    schemaStatus: endpoint.schemaStatus,
    activeSnapshot: endpoint.provenance.inActiveSnapshot,
    unported: endpoint.provenance.unported,
    ...(endpoint.provenance.conflict ? { conflict: true } : {}),
    ...(endpoint.authorize ? { authorize: endpoint.authorize } : {}),
    ...(endpoint.inner ? { returnType: endpoint.inner } : {}),
    ...(endpoint.unresolvedTypes.length ? { unresolvedTypes: endpoint.unresolvedTypes } : {}),
    ...(endpoint.transport.adapter ? { adapter: endpoint.transport.adapter } : {}),
    ...(full ? {
      title: endpoint.title,
      module: endpoint.module,
      params: endpoint.params,
      returnKind: endpoint.returnKind,
      stream: endpoint.stream,
      schemaRefs: endpoint.schemaRefs,
      provenance: endpoint.provenance,
      transport: endpoint.transport,
      source: endpoint.source,
    } : {}),
  };
}

async function commandServices(cli, sub, id) {
  if (sub === "catalog") {
    if (cli.flags.write) {
      if (cli.flags.check) throw new UsageError("Choose one of --write or --check.");
      let written;
      try {
        written = writeServiceCatalogJson();
      } catch (error) {
        // A refused regeneration keeps the previous artifact byte-identical.
        return cli.emit({
          ok: false, status: "failed", written: null,
          artifact: "scripts/tm-api/service-catalog.json",
          error: { kind: "write-refused", message: scrubSecrets(String(error?.message ?? error), cli.secrets) },
        }, EXIT_CODES.internal);
      }
      return cli.emit({
        ok: true, status: "ok", written: "scripts/tm-api/service-catalog.json",
        counts: written.counts, sources: written.sources,
        check: "Regenerated from both sources and verified against their hashes.",
      }, EXIT_CODES.ok);
    }
    const catalog = readServiceCatalog();
    if (cli.flags.check) {
      const check = checkServiceCatalog(catalog);
      // When the SDK tree is in this checkout, compare the generated artifact
      // with a fresh scan so a stale JSON cannot pass as current.
      let drift;
      const live = buildServiceCatalog();
      const liveIds = new Set(live.endpoints.map(endpoint => endpoint.id));
      const jsonIds = new Set(catalog.endpoints.map(endpoint => endpoint.id));
      const added = [...liveIds].filter(candidate => !jsonIds.has(candidate));
      const removed = [...jsonIds].filter(candidate => !liveIds.has(candidate));
      if (added.length || removed.length) {
        drift = { added: added.slice(0, 20), removed: removed.slice(0, 20), addedCount: added.length, removedCount: removed.length };
      }
      const ok = check.ok && drift === undefined;
      return cli.emit({
        ok, status: ok ? "ok" : "drift",
        loadedFrom: catalog.loadedFrom,
        counts: catalog.counts, sources: catalog.sources, manifest: catalog.manifest,
        failures: check.failures, absentSources: check.absentSources.length,
        ...(drift ? { drift } : {}),
        hint: ok ? undefined : "Regenerate with: npm run api:shell -- services catalog --write",
      }, ok ? EXIT_CODES.ok : EXIT_CODES.drift);
    }
    if (cli.flags.summary) {
      return cli.emit({
        ok: true, status: "ok", loadedFrom: catalog.loadedFrom,
        counts: catalog.counts, sources: catalog.sources, manifest: catalog.manifest,
      }, EXIT_CODES.ok);
    }
    const scope = cli.flags.scope;
    const endpoints = serviceScopeFilter(catalog.endpoints, scope);
    const full = cli.flags.full === true;
    return cli.emit({
      ok: true, status: "ok", loadedFrom: catalog.loadedFrom,
      counts: catalog.counts, sources: catalog.sources, manifest: catalog.manifest,
      scope: scope ?? "all", listed: endpoints.length,
      endpoints: endpoints.map(endpoint => compactEndpoint(endpoint, full)),
    }, EXIT_CODES.ok);
  }
  if (sub === "describe") {
    if (!id) throw new UsageError("services describe needs an endpoint id.");
    const catalog = readServiceCatalog();
    const endpoint = catalog.endpoints.find(candidate => candidate.id === id);
    if (!endpoint) {
      const known = catalog.endpoints.filter(candidate => candidate.id.toLowerCase().includes(id.toLowerCase())).slice(0, 10).map(candidate => candidate.id);
      return cli.emit({ ok: false, status: "failed", id,
        error: { kind: "validation", message: "Unknown service endpoint id." },
        suggestions: known }, EXIT_CODES.usage);
    }
    return cli.emit({
      ok: true, status: "ok", endpoint, schemaNote: catalog.schemaNote,
      ...(endpoint.transport.adapter
        ? { adapterInputSchemaRef: `action:${endpoint.transport.adapter.actionId}#inputSchema`, adapterDescribe: `tm-api describe ${endpoint.transport.adapter.actionId}` }
        : {}),
    }, EXIT_CODES.ok);
  }
  if (sub === "call") {
    if (!id) throw new UsageError("services call needs an endpoint id.");
    const catalog = readServiceCatalog();
    const endpoint = catalog.endpoints.find(candidate => candidate.id === id);
    if (!endpoint) {
      return cli.emit({ ok: false, status: "failed", serviceId: id,
        error: { kind: "validation", message: "Unknown service endpoint id." } }, EXIT_CODES.usage);
    }
    const adapter = endpoint.transport.adapter;
    if (!adapter) {
      return cli.emit({
        ok: false, status: "not-implemented", serviceId: id,
        callability: "reserved",
        activeSnapshot: endpoint.provenance.inActiveSnapshot,
        unported: endpoint.provenance.unported,
        dtoReturned: false, rawRpcDispatched: false,
        error: { kind: "not-implemented", message: endpoint.transport.reason },
        ...(endpoint.transport.relatedActionId
          ? {
            relatedAction: {
              actionId: endpoint.transport.relatedActionId,
              invoked: false,
              note: "A different business entry point with its own contract, not this endpoint. Run it explicitly with tm-api exec if that is the operation you want; it is never called on this endpoint's behalf.",
            },
          }
          : {}),
        endpoint: { route: endpoint.route, httpMethod: endpoint.transport.httpMethod, module: endpoint.module },
      }, EXIT_CODES["not-implemented"]);
    }
    const input = readInput(cli.flags);
    cli.secrets = collectSecrets(input);
    const payload = adapter.apiVersion === 1
      ? { op: "execute", apiVersion: 1, id: adapter.actionId, input: { ...(adapter.input ?? {}), ...input } }
      : { op: "execute", apiVersion: 2, id: adapter.actionId, input: { ...(adapter.input ?? {}), ...input } };
    const { result } = await cli.page(payload);
    const reloadRequired = adapter.reloadRequired === true && result?.reloadRequired === true;
    const adaptedStatus = reloadRequired ? "page-reload-required" : "adapted";
    return cli.emit({
      ok: result?.ok === true,
      status: result?.ok === true ? adaptedStatus : statusForResult(result),
      serviceId: id,
      dtoReturned: false,
      rawRpcDispatched: false,
      adapter: { actionId: adapter.actionId, apiVersion: adapter.apiVersion, ...(adapter.reloadRequired ? { reloadRequired: true } : {}) },
      note: "This runs the application's existing action, which performs this endpoint's business operation. The raw RPC DTO is not returned; a token or other credential is never exposed.",
      result,
    }, exitForResult(result));
  }
  throw new UsageError("services needs catalog, describe or call.");
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (caught) {
    if (!(caught instanceof UsageError)) throw caught;
    // Argument errors are reported before any session or page can be touched.
    process.stderr.write(`tm-api: usage: ${caught.message}\n`);
    process.stdout.write(`${JSON.stringify({
      ok: false, status: "usage", exitCode: EXIT_CODES.usage,
      error: { kind: "usage", message: caught.message },
    })}\n`);
    return EXIT_CODES.usage;
  }
  const { flags, positionals } = parsed;
  if (flags.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return EXIT_CODES.ok;
  }
  const cli = new Cli(flags);
  const [command, ...rest] = positionals;
  try {
    // `--write` mutates a repository artifact, so exactly one command accepts it
    // and every other command refuses instead of ignoring the flag.
    if (flags.write && !(command === "services" && rest[0] === "catalog")) {
      throw new UsageError("--write is only accepted by: services catalog --write.");
    }
    switch (command) {
      case "connect": return await commandConnect(cli);
      case "ping": return await commandPing(cli);
      case "catalog": return await commandCatalog(cli);
      case "describe": return await commandDescribe(cli, rest[0]);
      case "exec": return await commandExec(cli, rest[0]);
      case "query": return await commandQuery(cli, rest[0]);
      case "jobs": return await commandJobs(cli, rest[0], rest[1]);
      case "logs": return await commandLogs(cli, rest[0]);
      case "events": return await commandEvents(cli, rest[0]);
      case "batch": return await commandBatch(cli);
      case "services": return await commandServices(cli, rest[0], rest[1]);
      default: throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) return cli.fail("usage", error.message);
    if (error instanceof BridgeError) {
      return cli.fail("unavailable", error.message, {
        transport: { code: error.code, ...error.detail },
        hint: "Check that the session is connected (tm-api connect --url ...) and the page is still open.",
      });
    }
    return cli.fail("internal", String(error?.message ?? error));
  }
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}, error => {
  process.stderr.write(`tm-api: internal: ${String(error?.message ?? error)}\n`);
  process.exitCode = EXIT_CODES.internal;
});
