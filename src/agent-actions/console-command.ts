import { validateApiInput, type FrontendApiV2 } from "./contracts";
import { REDACTED, redactErrorMessage } from "./types";
import type { LogFilter } from "../diagnostics/logger";

export interface ConsoleCommand {
  kind: "execute" | "query" | "catalog" | "jobs" | "logs" | "help";
  id?: string;
  operation?: "get" | "wait" | "cancel";
  input: Record<string, unknown>;
  summary: string;
}
export interface ConsoleResult { output: string; failed: boolean }
const sensitiveKey = /authorization|digest|password|passwd|pwd|secret|token|api[_-]?key/i;
const identifier = /^[a-zA-Z][a-zA-Z0-9_.:-]*$/;
const HELP = `Commands use the existing window.timeMachineAgent.v2 API:
time.set {"ageMa":110}          Execute an action with a JSON object
query project.snapshot        Query state (optional JSON object)
catalog                       List API ids and live availability
catalog time.set              Show one API contract
jobs get <jobId>               Inspect an actual job
jobs wait <jobId>              Wait for its terminal result
jobs cancel <jobId>            Request cancellation
logs {"traceId":"<traceId>"}    Query structured logs (optional filter)
help                          Show this local help

Job actions return accepted + jobId. Use jobs wait to check completion.
ready / unavailable / not-implemented / out-of-scope are live catalog states.
Only sanitized results remain in this session. Clear output removes this history.
No JavaScript evaluation. API truncation and pagination fields remain visible.`;

function jsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid JSON object. Use double-quoted property names and values."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be a JSON object.");
  return value as Record<string, unknown>;
}

export function parseConsoleCommand(line: string): ConsoleCommand {
  if (/[\r\n]/.test(line)) throw new Error("Enter one command on a single line.");
  const match = line.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) throw new Error("Enter a command. Type help for examples.");
  const verb = match[1]!, rest = match[2] ?? "";
  let command: Omit<ConsoleCommand, "summary">;
  if (verb === "help") {
    if (rest) throw new Error("Usage: help");
    command = { kind: "help", input: {} };
  } else if (verb === "catalog") {
    if (rest && !identifier.test(rest)) throw new Error("Usage: catalog [api.id]");
    command = { kind: "catalog", id: rest || undefined, input: {} };
  } else if (verb === "jobs") {
    const job = rest.match(/^(get|wait|cancel)\s+([a-zA-Z0-9_.:-]+)$/);
    if (!job) throw new Error("Usage: jobs get|wait|cancel <jobId>");
    command = { kind: "jobs", operation: job[1] as ConsoleCommand["operation"], id: job[2], input: {} };
  } else if (verb === "logs") {
    command = { kind: "logs", input: jsonObject(rest) };
  } else if (verb === "query") {
    const query = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!query || !identifier.test(query[1]!)) throw new Error("Usage: query api.id [JSON object]");
    command = { kind: "query", id: query[1], input: jsonObject(query[2] ?? "") };
  } else {
    if (!identifier.test(verb)) throw new Error("Invalid action id. Type help for command syntax.");
    command = { kind: "execute", id: verb, input: jsonObject(rest) };
  }
  const prefix = command.kind === "execute" ? command.id : [command.kind, command.operation, command.id].filter(Boolean).join(" ");
  const summary = `${JSON.parse(summarizeConsoleValue(prefix, command.input))}${Object.keys(command.input).length ? ` ${summarizeConsoleValue(command.input, command.input)}` : ""}`;
  return { ...command, summary };
}

/** Uses the existing API privacy rules; the API owns result limits and truncation. */
export function summarizeConsoleValue(value: unknown, input: Record<string, unknown> = {}): string {
  const secrets: Record<string, string> = {};
  JSON.stringify(input, (key, item: unknown) => {
    if (sensitiveKey.test(key) && typeof item === "string" && item) secrets[`secret${Object.keys(secrets).length}`] = item;
    return item;
  });
  return JSON.stringify(value, (key, item: unknown) => {
    if (sensitiveKey.test(key)) return REDACTED;
    if (typeof item !== "string") return item;
    return redactErrorMessage(item, secrets)
      .replace(/\b(?:https?|wss?|file|ftp):\/\/[^\s<>"']+/gi, REDACTED)
      .replace(/\b(?:data|blob):[^\s<>"']+/gi, REDACTED)
      .replace(/["'](?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|pwd|secret|token|digest)["']\s*:\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/gi, REDACTED)
      .replace(/(?:\/|\.{1,2}\/)[^\s"'<>?]*\?[^\s"'<>]+/g, REDACTED)
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;)}\]"']+/gi, REDACTED)
      .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED);
  }, 2);
}

export async function runConsoleCommand(command: ConsoleCommand, api: FrontendApiV2 | undefined): Promise<ConsoleResult> {
  if (command.kind === "help") return { failed: false, output: HELP };
  if (!api) return { failed: true, output: "Frontend v2 API is unavailable. Wait for application startup and retry." };
  try {
    let result: unknown;
    switch (command.kind) {
      case "catalog":
        result = command.id ? await api.catalog.describe(command.id) : api.catalog.list();
        if (result === undefined) throw new Error("API id not found. Use catalog to list ids.");
        break;
      case "execute": {
        const metadata = api.catalog.list({ idPrefix: command.id }).find(entry => entry.id === command.id);
        result = await api.execute(command.id!, command.input, metadata?.execution === "job" ? { completion: "accepted" } : undefined);
        break;
      }
      case "query": result = await api.query(command.id!, command.input); break;
      case "jobs":
        result = await api.jobs[command.operation!](command.id!);
        if (result === undefined) throw new Error("Job not found or no longer retained. Check the jobId and current boot session.");
        break;
      case "logs": {
        const descriptor = await api.catalog.describe("logs.query");
        if (!descriptor) throw new Error("The logs.query API contract is unavailable.");
        const invalid = validateApiInput(descriptor.inputSchema, { filter: command.input });
        if (invalid) throw new Error(invalid);
        result = api.logs.query(command.input as LogFilter);
        break;
      }
    }
    return { failed: typeof result === "object" && result !== null && "ok" in result && result.ok === false, output: summarizeConsoleValue(result, command.input) };
  } catch (error) {
    return { failed: true, output: summarizeConsoleValue({ error: error instanceof Error ? error.message : String(error) }, command.input) };
  }
}
