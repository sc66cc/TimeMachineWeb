/**
 * Transport for the shell API: one `agent-browser` call per command.
 *
 * The dispatcher below is the *entire* vocabulary the page accepts. Command
 * arguments travel to the page as a JSON literal inside a fixed script that is
 * written to the child's stdin, so neither a shell nor the child argv ever sees
 * user data. There is no `eval` of caller-supplied code, no string
 * concatenation of an operation name into source, and no polling slot on
 * `window`.
 *
 * `evaluate()` is called with `eval --stdin`; the page receives
 * `(async () => { <dispatcher>; return await __tmDispatch(<payload>); })()`
 * and its returned JSON is unwrapped from agent-browser's
 * `{success, data:{origin, result}, error}` envelope.
 */

import { execFileSync } from "node:child_process";

const BINARY = process.env.TM_API_AGENT_BROWSER ?? "agent-browser";
const MAX_BUFFER = 64 * 1024 * 1024;

/** A transport-level problem: the browser, session or page is not usable. */
export class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The fixed page-side dispatcher. It is serialized with `toString()` and must
 * therefore stay self-contained: no imports, no module references, no
 * TypeScript. It never trusts `payload.op` beyond this switch.
 */
async function pageDispatch(payload) {
  const facade = window.timeMachineAgent;
  const api = facade && facade.v2;
  const requireFacade = () => {
    if (!facade || !api) {
      const error = new Error("The timeMachineAgent v2 facade is not installed on this document.");
      error.tmCode = "NO_FACADE";
      throw error;
    }
  };
  const settle = options => (options === undefined ? undefined : options);
  switch (payload.op) {
    case "ping": {
      const bootId = facade ? facade.getState().bootId : null;
      return {
        installed: Boolean(facade && api),
        origin: String(location.origin),
        href: String(location.href),
        bootId,
        facadeVersion: facade ? facade.version : null,
        apiVersion: api ? api.version : null,
        actionCount: facade ? facade.listActions().length : 0,
      };
    }
    case "catalog": {
      requireFacade();
      return { catalog: api.catalog.list(payload.filter) };
    }
    case "describe": {
      requireFacade();
      return { descriptor: (await api.catalog.describe(payload.id)) ?? null };
    }
    case "describeMany": {
      requireFacade();
      const ids = payload.ids.slice(0, 200);
      const descriptors = [];
      for (const id of ids) descriptors.push((await api.catalog.describe(id)) ?? null);
      return { descriptors };
    }
    case "execute": {
      requireFacade();
      const result = payload.apiVersion === 1
        ? await facade.execute(payload.id, payload.input)
        : await api.execute(payload.id, payload.input, settle(payload.options));
      return { result, apiVersion: payload.apiVersion === 1 ? 1 : 2 };
    }
    case "query": {
      requireFacade();
      return { result: await api.query(payload.id, payload.input) };
    }
    case "jobGet": {
      requireFacade();
      return { job: api.jobs.get(payload.jobId) ?? null };
    }
    case "jobWait": {
      requireFacade();
      return { result: await api.jobs.wait(payload.jobId, settle(payload.options)) };
    }
    case "jobCancel": {
      requireFacade();
      return { result: await api.jobs.cancel(payload.jobId) };
    }
    case "logsQuery": {
      requireFacade();
      return { page: api.logs.query(payload.filter) };
    }
    case "logsExport": {
      requireFacade();
      return { text: await api.logs.export(payload.filter).text() };
    }
    case "logsClear": {
      requireFacade();
      api.logs.clear();
      return { cleared: true };
    }
    case "eventsCollect": {
      requireFacade();
      const limit = Math.max(1, Math.min(Number(payload.maxEvents) || 200, 1000));
      const durationMs = Math.max(1, Math.min(Number(payload.durationMs) || 2000, 60000));
      const events = [];
      let overflow = 0;
      const startedAt = new Date().toISOString();
      const startedHr = performance.now();
      const unsubscribe = api.events.subscribe(payload.filter, event => {
        if (events.length >= limit) {
          overflow++;
          return;
        }
        events.push(event);
      });
      try {
        await new Promise(resolve => setTimeout(resolve, durationMs));
      } finally {
        unsubscribe();
      }
      return {
        events,
        overflow,
        window: {
          mode: "collect-window",
          startedAt,
          observedMs: Math.round(performance.now() - startedHr),
          requestedMs: durationMs,
          note: "Bounded observation window, not a live tail. Events outside the window were never delivered to this subscriber; the queue may drop notifications under load.",
        },
        bootId: facade.getState().bootId,
      };
    }
    case "batch": {
      requireFacade();
      const items = payload.items;
      const concurrency = Math.max(1, Math.min(Number(payload.concurrency) || 1, 4));
      const results = new Array(items.length);
      let nextIndex = 0;
      const runOne = async (item, index) => {
        try {
          if (item.op === "query") {
            results[index] = { index, op: "query", id: item.id, apiVersion: 2, result: await api.query(item.id, item.input) };
          } else if (item.apiVersion === 1) {
            results[index] = { index, op: "execute", id: item.id, apiVersion: 1, result: await facade.execute(item.id, item.input) };
          } else {
            results[index] = { index, op: "execute", id: item.id, apiVersion: 2, result: await api.execute(item.id, item.input, settle(item.options)) };
          }
        } catch (error) {
          results[index] = {
            index, op: item.op, id: item.id,
            threw: { message: String((error && error.message) || error) },
          };
        }
      };
      const worker = async () => {
        for (;;) {
          const index = nextIndex++;
          if (index >= items.length) return;
          await runOne(items[index], index);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      return { results, concurrency };
    }
    default:
      throw new Error("Unsupported shell API operation.");
  }
}

const DISPATCH_SOURCE = pageDispatch.toString();

/** JSON that is also a safe JavaScript literal inside the fixed script. */
function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Labels whose value is a credential; matches a bare or JSON-quoted label. */
const SENSITIVE_LABELS =
  "authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|passwd|pwd|secret|token|digest|credential|cookie|code";

/**
 * `"apiKey":"v"`, `Authorization: Bearer v`, `password='v'` — one rule for
 * every diagnostic form observed so far. The value keeps the label's quoting so
 * a JSON fragment stays parseable after redaction, and an auth scheme word
 * (`Bearer`) is consumed with the credential instead of being left behind.
 */
const LABELLED_ASSIGNMENT = new RegExp(
  `("(?:${SENSITIVE_LABELS})"|'(?:${SENSITIVE_LABELS})'|\\b(?:${SENSITIVE_LABELS})\\b)` +
    "(\\s*[:=]\\s*)" +
    "(?:(?:bearer|basic|digest|negotiate)\\s+)?" +
    "(?:\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*\"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|\\[redacted\\]|[^\\s,;)}\\]]+)",
  "gi",
);

/**
 * Every literal form a secret can take in text: as parsed, and as it appears
 * once `JSON.stringify` has escaped it (`p@ss"word` → `p@ss\\"word`).
 */
function literalForms(secret) {
  const forms = [secret];
  const escaped = JSON.stringify(secret).slice(1, -1);
  if (escaped !== secret) forms.push(escaped);
  return forms;
}

/**
 * Removes credentials from a diagnostic string. Only text passes through here,
 * so output payloads keep their exact DTO shape; see docs/shell-api.md for the
 * scrubbing boundary this does and does not cover.
 */
export function scrubSecrets(text, secrets) {
  let output = String(text ?? "");
  // Every collected non-empty string is swapped, whatever its length: a
  // 3-character password is still a password. Longest first, so a short
  // credential cannot split a longer one before it is replaced.
  const ordered = secrets
    .filter(secret => typeof secret === "string" && secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    for (const form of literalForms(secret)) output = output.split(form).join("[redacted]");
  }
  return output.replace(LABELLED_ASSIGNMENT, (_match, label, separator, _value) => {
    // Quoting follows the *label*: a quoted label means the fragment came from
    // JSON, so the replacement must stay a JSON string to keep it parseable.
    const quote = /^["']/.test(label) ? label[0] : "";
    return `${label}${separator}${quote}[redacted]${quote}`;
  });
}

/** Longest diagnostic fragment kept after scrubbing. */
const MAX_REASON = 400;

const SCRIPT_OMITTED = "[script omitted]";

/**
 * Markers unique to the injected page script: its fixed identifiers and its
 * opening expression. They survive JSON escaping, so a truncated or re-encoded
 * copy still matches here even though it no longer equals the source string that
 * `redactions` removes.
 */
const SCRIPT_MARKER = /__tmDispatch|pageDispatch|\(async \(\) => \{/;

/** Base64 forms of a fragment, so an encoded copy is removed with its source. */
function encodedForms(fragment) {
  const base64 = Buffer.from(fragment, "utf8").toString("base64");
  return [base64, base64.replace(/=+$/, "")];
}

/**
 * One scrubbed, bounded reason. `redactions` are whole strings that must never
 * be quoted back — the injected page script (which carries the caller's
 * parameters) is the only such string today. Scripts are removed **before** the
 * secret swap: replacing a secret first would alter the script text and stop it
 * from matching, leaving the whole script (and its other parameters) in place.
 */
export function safeReason(raw, { secrets = [], redactions = [] } = {}) {
  let text = String(raw ?? "");
  for (const fragment of redactions) {
    if (typeof fragment !== "string" || fragment.length === 0) continue;
    for (const form of [fragment, ...encodedForms(fragment)]) text = text.split(form).join(SCRIPT_OMITTED);
  }
  // A truncated or escaped copy of the script matches neither its source nor
  // its base64 form. Any surviving marker means the text still carries page
  // script (and therefore the caller's parameters), so only the part before it
  // is quoted back.
  const marker = SCRIPT_MARKER.exec(text);
  if (marker) text = `${text.slice(0, marker.index).trimEnd()} ${SCRIPT_OMITTED}`;
  text = scrubSecrets(text, secrets);
  if (text.length > MAX_REASON) text = `${text.slice(0, MAX_REASON)}… [truncated ${text.length} chars]`;
  return text;
}

/** Runs one agent-browser subcommand and returns its `--json` envelope. */
function runCli(args, { input, timeoutMs, secrets, redactions }) {
  let stdout;
  try {
    stdout = execFileSync(BINARY, [...args], {
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    const code = error && error.code === "ENOENT" ? "BROWSER_MISSING" : "BROWSER_FAILED";
    // The child may echo the script it was given. The envelope is written to
    // stdout, so it is read on its own: mixing stderr into the same buffer can
    // make the whole document unparseable and fall back to raw child text.
    const envelope = extractEnvelope(error?.stdout);
    const reason = envelope?.error
      ? String(envelope.error.message ?? envelope.error.code ?? "browser reported an error")
      : String(error?.message ?? error?.stderr ?? "agent-browser failed");
    throw new BridgeError(code, safeReason(reason, { secrets, redactions }), {
      exitCode: typeof error?.status === "number" ? error.status : undefined,
      timedOut: Boolean(error?.signal),
    });
  }
  const envelope = extractEnvelope(stdout);
  if (!envelope) throw new BridgeError("BAD_ENVELOPE", "agent-browser returned no JSON envelope.", {});
  if (envelope.success !== true) {
    const reason = envelope.error
      ? String(envelope.error.message ?? envelope.error.code ?? "browser reported an error")
      : "browser reported an unsuccessful command";
    throw new BridgeError("BROWSER_REPORTED_FAILURE", safeReason(reason, { secrets, redactions }), {});
  }
  return envelope;
}

/** Tolerates a log line before/after the JSON document without guessing. */
function extractEnvelope(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Navigates the session. Only `connect` calls this. */
export function openPage({ session, url, timeoutMs = 120_000, secrets = [] }) {
  return runCli(["--session", session, "--json", "open", url], { timeoutMs, secrets });
}

/**
 * Runs the fixed dispatcher in the page and returns its result.
 *
 * `payload` never becomes argv: the whole script is written to the child's
 * stdin, and the payload is embedded as one JSON literal inside it.
 */
export function callPage({ session, payload, timeoutMs = 120_000, secrets = [] }) {
  const source = `(async () => {\nconst __tmDispatch = ${DISPATCH_SOURCE};\nreturn await __tmDispatch(${jsLiteral(payload)});\n})()`;
  let envelope;
  try {
    envelope = runCli(["--session", session, "--json", "eval", "--stdin"], {
      input: source, timeoutMs, secrets,
      // A browser that echoes the script back must not have the caller's
      // parameters quoted back at them.
      redactions: [source],
    });
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("BROWSER_FAILED", scrubSecrets(String(error?.message ?? error), secrets), {});
  }
  const data = envelope.data ?? {};
  if (!Object.hasOwn(data, "result")) {
    throw new BridgeError("NO_RESULT", "The page returned no result.", {});
  }
  return { origin: data.origin, result: data.result };
}
