import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Exercises the real shell entry point against a synthetic transport.
 *
 * The fake stands in for `agent-browser` and records exactly what it received,
 * so the security properties are observed rather than asserted from reading the
 * code: parameters and credentials must reach the page through stdin and never
 * through argv, and neither stdout nor stderr may echo a secret.
 */
const ROOT = process.cwd();
const CLI = join(ROOT, "scripts/tm-api/cli.mjs");

const FAKE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const source = Buffer.concat(chunks).toString("utf8");
  const dir = process.env.TM_FAKE_DIR;
  const argvPath = join(dir, "argv.json");
  const existing = existsSync(argvPath)
    ? JSON.parse(readFileSync(argvPath, "utf8"))
    : [];
  existing.push(process.argv.slice(2));
  writeFileSync(argvPath, JSON.stringify(existing, null, 1));
  appendFileSync(join(dir, "stdin.txt"), source + "\\n");
  const mode = process.env.TM_FAKE_MODE ?? "ok";
  if (mode === "leak") {
    const secret = /dummysecret/.test(source) ? "password=dummysecret" : "password=unknown";
    process.stderr.write("fake browser rejected: " + secret + " while evaluating " + source + "\\n");
    process.stdout.write(JSON.stringify({ success: false, data: null, error: { code: "SCRIPT_ERROR", message: "evaluate failed for " + secret } }) + "\\n");
    process.exit(1);
  }
  if (mode === "echo") {
    // Adversarial transport: echoes a caller-chosen diagnostic *and* the whole
    // script it received, which is the worst case a real browser can produce.
    // \`TM_FAKE_ECHO_STYLE\` truncates or JSON-escapes that copy, so a partial
    // or re-encoded echo is exercised too.
    const style = process.env.TM_FAKE_ECHO_STYLE ?? "full";
    const echoed = style === "trunc" ? source.slice(0, 180) : style === "escaped" ? JSON.stringify(source) : source;
    const message = (process.env.TM_FAKE_ECHO ?? "") + " | script:" + echoed;
    process.stderr.write(message + "\\n");
    process.stdout.write(JSON.stringify({ success: false, data: null, error: { code: "SCRIPT_ERROR", message } }) + "\\n");
    process.exit(1);
  }
  if (process.argv.includes("open")) {
    process.stdout.write(JSON.stringify({ success: true, data: { origin: "http://fake.test" }, error: null }) + "\\n");
    return;
  }
  // Exact native envelope for one command's evaluated value: a real page result
  // is nested as \`data.result\` and an execute/query value is \`{result, ...}\`.
  const spec = process.env.TM_FAKE_PAGE_RESULT;
  if (spec) {
    process.stdout.write(JSON.stringify({ success: true, data: { origin: "http://fake.test", result: JSON.parse(spec) }, error: null }) + "\\n");
    return;
  }
  const isPing = source.includes('"op":"ping"');
  const demo = process.env.TM_FAKE_DEMO === "1";
  const bootPath = join(dir, "boot.txt");
  const nextBootId = () => {
    const seen = existsSync(bootPath) ? Number(readFileSync(bootPath, "utf8")) : 0;
    writeFileSync(bootPath, String(seen + 1));
    return "boot-" + (seen + 1);
  };
  const isV1Execute = source.includes('"op":"execute"') && source.includes('"apiVersion":1');
  const result = isPing
    ? { installed: true, origin: "http://fake.test", href: process.env.TM_FAKE_HREF || "http://fake.test/",
        bootId: demo ? nextBootId() : "boot-test",
        facadeVersion: "1.0.0", apiVersion: "2.0.0", actionCount: 64 }
    : demo && isV1Execute
      ? { result: { actionId: "model.select", ok: true, status: "completed", reloadRequired: true }, apiVersion: 1 }
      : mode === "invalid"
      ? { result: { ok: false, status: "failed", traceId: "boot-test:action-1",
          error: { kind: "validation", code: "VALIDATION", message: "input.ageMa: required.", retryable: false } } }
      : source.includes('"op":"jobCancel"')
        ? { result: { ok: true, status: "accepted", traceId: "boot-test:action-7", jobId: "boot-test:job-7" } }
      : source.includes('"op":"eventsCollect"')
        ? { events: [], overflow: 0, bootId: "boot-test",
            window: { mode: "collect-window", startedAt: "1970-01-01T00:00:00.000Z", observedMs: 5, requestedMs: 5, note: "Bounded observation window." } }
        : { result: { ok: true, status: "completed", traceId: "boot-test:action-1", revision: 1, data: { acknowledged: true } }, apiVersion: 2 };
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "http://fake.test", result }, error: null }) + "\\n");
});
`;

let directory: string;

interface RunOptions {
  input?: string;
  mode?: string;
  echo?: string;
  echoStyle?: "full" | "trunc" | "escaped";
  /** The page's evaluated value, delivered through the native envelope. */
  pageResult?: unknown;
  href?: string;
  demo?: boolean;
  cwd?: string;
}

function run(args: string[], { input = "", mode = "ok", echo = "", echoStyle = "full", pageResult, href, demo = false, cwd = ROOT }: RunOptions = {}) {
  const result = { stdout: "", stderr: "", code: 0 };
  try {
    result.stdout = execFileSync(process.execPath, [CLI, ...args], {
      input,
      encoding: "utf8",
      cwd,
      env: {
        ...process.env,
        TM_FAKE_DIR: directory, TM_FAKE_MODE: mode, TM_FAKE_ECHO: echo, TM_FAKE_ECHO_STYLE: echoStyle,
        TM_FAKE_PAGE_RESULT: pageResult === undefined ? "" : JSON.stringify(pageResult),
        TM_FAKE_HREF: href ?? "", TM_FAKE_DEMO: demo ? "1" : "",
        TM_API_AGENT_BROWSER: join(directory, "agent-browser"), TM_API_SESSION: "shell-test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (caught) {
    // execFileSync throws a process result; keep its captured streams.
    const error = caught as { stdout?: string; stderr?: string; status?: number };
    result.stdout = String(error.stdout ?? "");
    result.stderr = String(error.stderr ?? "");
    result.code = typeof error.status === "number" ? error.status : -1;
  }
  return result;
}

/** Runs one `exec` whose transport echoes `echo` and the received script. */
function runEchoing(echo: string, input: Record<string, unknown>) {
  return run(["exec", "auth.login"], { input: JSON.stringify(input), mode: "echo", echo });
}

function recorded(): { argv: string[][]; stdin: string } {
  return {
    argv: existsSync(join(directory, "argv.json"))
      ? JSON.parse(readFileSync(join(directory, "argv.json"), "utf8"))
      : [],
    stdin: existsSync(join(directory, "stdin.txt")) ? readFileSync(join(directory, "stdin.txt"), "utf8") : "",
  };
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "tm-api-cli-"));
  writeFileSync(join(directory, "agent-browser"), FAKE, { mode: 0o755 });
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("shell api command surface", () => {
  it("prints usage and exits zero", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tm-api connect");
    expect(result.stdout).toContain("Exit codes:");
  });

  it("rejects an unknown command and an unknown flag with a usage exit", () => {
    const unknownCommand = run(["nonsense"]);
    expect(unknownCommand.code).toBe(2);
    expect(JSON.parse(unknownCommand.stdout)).toMatchObject({ ok: false, status: "usage", exitCode: 2 });
    const unknownFlag = run(["catalog", "--not-a-flag"]);
    expect(unknownFlag.code).toBe(2);
    expect(JSON.parse(unknownFlag.stdout).status).toBe("usage");
  });

  it("connects through the recorded session without navigating again", () => {
    const result = run(["connect", "--url", "http://fake.test/"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "connected", session: "shell-test" });
    expect(body.ping).toMatchObject({ installed: true, bootId: "boot-test", actionCount: 64 });
    // One navigation for connect, then the ping eval.
    const calls = recorded().argv;
    expect(calls[0]).toEqual(["--session", "shell-test", "--json", "open", "http://fake.test/"]);
    expect(calls[1]).toEqual(["--session", "shell-test", "--json", "eval", "--stdin"]);
  });

  it("refuses to connect without an explicit url", () => {
    const result = run(["connect"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toContain("--url");
  });

  it("sends parameters only through stdin and never through argv", () => {
    const result = run(["exec", "time.set"], { input: JSON.stringify({ ageMa: 66, password: "dummysecret" }) });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "ok", apiVersion: 2, actionId: "time.set" });
    expect(body.result).toMatchObject({ ok: true, status: "completed", data: { acknowledged: true } });

    const { argv, stdin } = recorded();
    const lastArgv = argv[argv.length - 1];
    expect(lastArgv).toEqual(["--session", "shell-test", "--json", "eval", "--stdin"]);
    expect(JSON.stringify(argv)).not.toContain("dummysecret");
    expect(JSON.stringify(argv)).not.toContain("ageMa");
    // The value reached the page inside the fixed script instead.
    expect(stdin).toContain("dummysecret");
    expect(stdin).toContain("__tmDispatch");
    // And the machine output does not echo it.
    expect(result.stdout).not.toContain("dummysecret");
  });

  it("maps an API validation failure to the usage exit code", () => {
    const result = run(["exec", "time.set"], { input: JSON.stringify({ ageMa: 66 }), mode: "invalid" });
    expect(result.code).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, status: "failed", exitCode: 2 });
    expect(body.result.error).toMatchObject({ kind: "validation", code: "VALIDATION" });
  });

  it("scrubs a secret that the browser echoes back on failure", () => {
    const result = run(["exec", "auth.login"], { input: JSON.stringify({ mode: "account", password: "dummysecret" }), mode: "leak" });
    expect(result.code).toBe(4);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, status: "unavailable", exitCode: 4 });
    expect(body.transport.code).toBe("BROWSER_FAILED");
    expect(result.stdout).not.toContain("dummysecret");
    expect(result.stderr).not.toContain("dummysecret");
    // The browser really did echo it: the recording proves the test is not vacuous.
    expect(recorded().stdin).toContain("dummysecret");
  });

  it("does not present a cancellation request as completed cleanup", () => {
    const result = run(["jobs", "cancel", "boot-test:job-7"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "accepted", jobId: "boot-test:job-7" });
    expect(body.result.status).toBe("accepted");
    expect(body.note).toContain("not confirmed");
  });

  it("keeps job options out of v1 and out of unrequested inline runs", () => {
    const v1Options = run(["exec", "model.select", "--api-version", "1", "--timeout-ms", "1000"]);
    expect(v1Options.code).toBe(2);
    expect(JSON.parse(v1Options.stdout).error.message).toContain("v2 job options");

    const before = recorded().stdin.length;
    run(["exec", "camera.reset"]);
    const appended = recorded().stdin.slice(before);
    // Only the dispatch call site matters; the dispatcher body itself mentions
    // options in its own source.
    const literal = appended.slice(appended.lastIndexOf("__tmDispatch("));
    expect(literal).toContain('"id":"camera.reset"');
    expect(literal).not.toContain("options");
    expect(literal).not.toContain("completion");
    expect(literal).not.toContain("timeoutMs");
  });

  it("emits NDJSON for a collected event window and says it is not a tail", () => {
    const result = run(["events", "collect", "--duration-ms", "5", "--types", "job.changed"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ kind: "collection", mode: "collect-window" });
    expect(lines[0].note).toContain("not a live tail");
    expect(recorded().stdin).toContain('"op":"eventsCollect"');
  });

  it("reports a reserved service endpoint as not implemented with a real reason", () => {
    const callsBefore = recorded().argv.length;
    const result = run(["services", "call", "service.UserPlateModel.Create"]);
    expect(result.code).toBe(3);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({
      ok: false, status: "not-implemented", callability: "reserved",
      dtoReturned: false, rawRpcDispatched: false, exitCode: 3,
    });
    expect(body.error.message).toContain("multipart");
    // No browser call was made for an endpoint this build cannot run.
    expect(recorded().argv.length).toBe(callsBefore);
  });

  it("keeps every former adapter endpoint reserved and calls no page handler", () => {
    // Nine endpoints once looked close to an existing page action. Each was
    // withdrawn, because no action implements that endpoint's contract.
    const withdrawn = [
      "service.Login.Login",
      "service.LoginMail.Login",
      "service.LoginMail.SendMailCode",
      "service.Logout.Logout",
      "service.TimeMachineWorkspace.CreateProject",
      "service.TimeMachineWorkspace.SaveProject",
      "service.TimeMachineWorkspace.GetProjectRevision",
      "service.TimeMachineIngest.CreateDatasetIngestJob",
      "service.TimeMachineIngest.CancelJob",
    ];
    const callsBefore = recorded().argv.length;
    const stdinBefore = recorded().stdin.length;
    for (const id of withdrawn) {
      const result = run(["services", "call", id], { input: "{}" });
      expect(result.code, id).toBe(3);
      const body = JSON.parse(result.stdout);
      expect(body, id).toMatchObject({
        ok: false, status: "not-implemented", callability: "reserved",
        dtoReturned: false, rawRpcDispatched: false, exitCode: 3,
      });
      // The adjacent action is named as a *different* contract, never invoked.
      expect(body.relatedAction.invoked).toBe(false);
      expect(body.relatedAction.actionId).toMatch(/^[a-z]+\.[A-Za-z.]+$/);
      expect(body.relatedAction.note).toContain("different business entry point");
      expect(body.error.message).toContain("different business entry point");
      expect(body.error.message).toContain(body.relatedAction.actionId);
    }
    // Nothing reached the page: no argv, no stdin, for any of the nine.
    expect(recorded().argv.length).toBe(callsBefore);
    expect(recorded().stdin.length).toBe(stdinBefore);
  });
});

describe("diagnostic scrubbing", () => {
  /** The inner diagnostic, before the omitted-script marker. */
  function innerMessage(stdout: string): string {
    return JSON.parse(stdout).error.message.split(" | script:")[0];
  }

  it("scrubs a JSON-quoted apiKey that the browser echoes back", () => {
    // `apiKey` is not one of the historical labels, and the value is short, so
    // only the quoted-label rule can catch this.
    const result = runEchoing('{"apiKey":"p@1","note":"failed"}', { apiKey: "p@1" });
    expect(result.code).toBe(4);
    const body = JSON.parse(result.stdout);
    expect(body.transport.code).toBe("BROWSER_FAILED");
    expect(result.stdout).not.toContain("p@1");
    expect(result.stderr).not.toContain("p@1");
    // Quoting is preserved, so the fragment is still valid JSON.
    expect(JSON.parse(innerMessage(result.stdout))).toEqual({ apiKey: "[redacted]", note: "failed" });
  });

  it("scrubs a whole Authorization value including the Bearer scheme", () => {
    const result = runEchoing("Authorization: Bearer p@1", { Authorization: "p@1" });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("p@1");
    expect(innerMessage(result.stdout)).toBe("Authorization: [redacted]");
  });

  it("scrubs a quoted Authorization header value", () => {
    const result = runEchoing('{"Authorization":"Bearer p@1"}', { Authorization: "p@1" });
    expect(result.code).toBe(4);
    expect(JSON.parse(innerMessage(result.stdout))).toEqual({ Authorization: "[redacted]" });
  });

  it("scrubs a three-character password", () => {
    const result = runEchoing('{"password":"p@1"}', { password: "p@1" });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("p@1");
    expect(JSON.parse(innerMessage(result.stdout))).toEqual({ password: "[redacted]" });
  });

  it("scrubs a credential whose JSON escaping differs from the parsed value", () => {
    const secret = 'p@ss"word';
    // As parsed, and as JSON.stringify escapes it inside the echoed script.
    const result = runEchoing('{"password":"p@ss\\"word"} at p@ss\\"word', { password: secret });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("p@ss");
    const inner = innerMessage(result.stdout);
    // Both the escaped quoted value and the bare escaped literal are gone.
    expect(inner).toBe('{"password":"[redacted]"} at [redacted]');
    expect(JSON.parse(inner.slice(0, inner.indexOf(" at ")))).toEqual({ password: "[redacted]" });
  });

  it("keeps boolean and numeric credential values parseable", () => {
    const result = runEchoing('{"password":true,"apiKey":1234}', { password: true, apiKey: 1234 });
    expect(result.code).toBe(4);
    const body = JSON.parse(result.stdout);
    // A literal `true`/`1234` is never swapped blindly: the label rule replaces
    // the whole value with a JSON string, so the fragment still parses.
    expect(JSON.parse(innerMessage(result.stdout))).toEqual({ password: "[redacted]", apiKey: "[redacted]" });
    expect(innerMessage(result.stdout)).not.toContain("true");
    expect(innerMessage(result.stdout)).not.toContain("1234");
    expect(body.error.kind).toBe("unavailable");
  });

  it("scrubs a collected value that the browser echoes without a label", () => {
    const result = runEchoing("rejected at dummysecret", { apiKey: "dummysecret" });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("dummysecret");
    expect(innerMessage(result.stdout)).toBe("rejected at [redacted]");
  });

  it("never quotes the injected script back in an error", () => {
    const result = runEchoing("transport died", { apiKey: "dummysecret" });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("__tmDispatch");
    expect(result.stderr).not.toContain("__tmDispatch");
    expect(JSON.parse(result.stdout).error.message).toContain("[script omitted]");
    // The echo really did carry the script and the parameter.
    expect(recorded().stdin).toContain("__tmDispatch");
    expect(recorded().stdin).toContain("dummysecret");
  });
});

describe("connect target validation", () => {
  it("refuses a URL with credentials or a query before starting any child", () => {
    const argvBefore = recorded().argv.length;
    const stdinBefore = recorded().stdin.length;
    const userinfo = run(["connect", "--url", "http://user:dummysecret@127.0.0.1:9/?token=dummysecret"]);
    expect(userinfo.code).toBe(2);
    expect(JSON.parse(userinfo.stdout)).toMatchObject({ ok: false, status: "usage", exitCode: 2 });
    // The rejection never echoes the URL it rejected.
    expect(userinfo.stdout).not.toContain("dummysecret");
    expect(userinfo.stderr).not.toContain("dummysecret");
    expect(userinfo.stdout).not.toContain("127.0.0.1");

    const query = run(["connect", "--url", "http://127.0.0.1:9/?token=dummysecret"]);
    expect(query.code).toBe(2);
    expect(JSON.parse(query.stdout).error.message).toContain("query");
    expect(query.stdout).not.toContain("dummysecret");

    const fragment = run(["connect", "--url", "http://127.0.0.1:9/#token=dummysecret"]);
    expect(fragment.code).toBe(2);
    expect(JSON.parse(fragment.stdout).error.message).toContain("fragment");

    // No navigation and no eval reached the browser for any of them.
    expect(recorded().argv.length).toBe(argvBefore);
    expect(recorded().stdin.length).toBe(stdinBefore);
  });

  it("keeps an ordinary public app URL, including its path", () => {
    const result = run(["connect", "--url", "https://app.example.test/viewer/workspace"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "connected", url: "https://app.example.test/viewer/workspace" });
    const calls = recorded().argv;
    const open = calls[calls.length - 2];
    expect(open).toEqual(["--session", "shell-test", "--json", "open", "https://app.example.test/viewer/workspace"]);
  });

  it("keeps file URLs working", () => {
    const result = run(["connect", "--url", "file:///tmp/app/index.html"]);
    expect(result.code).toBe(0);
    const calls = recorded().argv;
    expect(calls[calls.length - 2]).toContain("file:///tmp/app/index.html");
  });
});

describe("catalog regeneration", () => {
  const artifact = join(ROOT, "scripts/tm-api/service-catalog.json");

  it("accepts --write on services catalog and regenerates idempotently", () => {
    const before = readFileSync(artifact, "utf8");
    const result = run(["services", "catalog", "--write"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "ok", written: "scripts/tm-api/service-catalog.json" });
    expect(body.counts).toMatchObject({
      activeSnapshotInvokers: 11, activeSnapshotEndpointCount: 54,
      fullSourceInvokerCount: 51, fullSourceEndpointCount: 289,
      unportedEndpointCount: 235, callable: 0, reserved: 289,
    });
    // A second generation must produce the same artifact, byte for byte.
    expect(readFileSync(artifact, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(artifact, "utf8")).endpoints.length).toBe(289);
  });

  it("refuses --write on every other command without writing anything", () => {
    const before = readFileSync(artifact, "utf8");
    for (const args of [["catalog", "--write"], ["services", "describe", "service.Login.Login", "--write"], ["ping", "--write"]]) {
      const result = run(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(JSON.parse(result.stdout).error.message).toContain("services catalog --write");
    }
    expect(readFileSync(artifact, "utf8")).toBe(before);
  });

  it("refuses --write together with --check", () => {
    const before = readFileSync(artifact, "utf8");
    const result = run(["services", "catalog", "--write", "--check"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toContain("--write");
    expect(readFileSync(artifact, "utf8")).toBe(before);
  });

  it("refuses to regenerate without both sources and keeps the old artifact", () => {
    const empty = mkdtempSync(join(tmpdir(), "tm-api-write-empty-"));
    try {
      const path = join(empty, "scripts/tm-api");
      mkdirSync(path, { recursive: true });
      const sentinel = '{"sentinel":"previous artifact"}\n';
      writeFileSync(join(path, "service-catalog.json"), sentinel);
      // No sources in this working directory at all.
      const result = run(["services", "catalog", "--write"], { cwd: empty });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "failed", written: null });
      expect(JSON.parse(result.stdout).error.kind).toBe("write-refused");
      expect(readFileSync(join(path, "service-catalog.json"), "utf8")).toBe(sentinel);
      // No temporary file was left behind either.
      expect(readdirSync(path)).toEqual(["service-catalog.json"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

const LONG_SECRET = "dummysecret";
const SHORT_SECRET = "p@1";
const TOKEN_SECRET = "longsecret";
/** `p@ss"word` as the page would carry it after `JSON.stringify`. */
const ESCAPED_IN_TEXT = 'p@ss\\"word';

/**
 * The confirmed real leak, reproduced: collected values with no label, a token
 * array, quoted labels, an escaped form, and typed values that are not
 * credentials and must stay legible.
 */
function leakyMessage(): string {
  return [
    `rejected at ${LONG_SECRET} and ${SHORT_SECRET}`,
    `tokens ${TOKEN_SECRET} ${SHORT_SECRET}`,
    `"password":"${LONG_SECRET}"`,
    `"apiKey":"${SHORT_SECRET}"`,
    `escaped ${ESCAPED_IN_TEXT}`,
    "flag true",
    "pin 1234",
  ].join("; ");
}

/** The exact native envelope: `data.result` is the page value `{result, ...}`. */
function failedPage(result: Record<string, unknown>) {
  return { result, apiVersion: 2 };
}

describe("failure diagnostics at the output boundary", () => {
  it("scrubs a failed exec ApiResult message and keeps its typed metadata", () => {
    const result = run(["exec", "auth.login"], {
      input: JSON.stringify({
        password: LONG_SECRET, apiKey: SHORT_SECRET, tokens: [TOKEN_SECRET, SHORT_SECRET],
        nested: { tokens: [TOKEN_SECRET, SHORT_SECRET] }, escapedPassword: 'p@ss"word',
        passwordFlag: true, apiKeyNum: 1234,
      }),
      pageResult: failedPage({
        ok: false, status: "failed", traceId: "boot-test:action-1",
        error: { kind: "auth", code: "AUTH_FAILED", message: leakyMessage(), retryable: false },
      }),
    });
    expect(result.code).toBe(5);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, status: "failed", apiVersion: 2, actionId: "auth.login", exitCode: 5 });
    expect(body.result).toMatchObject({
      status: "failed", error: { kind: "auth", code: "AUTH_FAILED", retryable: false },
    });
    for (const needle of [LONG_SECRET, SHORT_SECRET, TOKEN_SECRET, "p@ss"]) {
      expect(result.stdout).not.toContain(needle);
      expect(result.stderr).not.toContain(needle);
    }
    // A literal `true`/`1234` in the prose is not a credential.
    expect(body.result.error.message).toContain("flag true");
    expect(body.result.error.message).toContain("pin 1234");
    expect(body.result.error.message).toContain("[redacted]");
  });

  it("scrubs a failed query message including its JSON-escaped form", () => {
    const result = run(["query", "auth.session"], {
      input: JSON.stringify({ password: 'p@ss"word', apiKey: SHORT_SECRET }),
      pageResult: failedPage({
        ok: false, status: "unknown", traceId: "boot-test:action-2",
        error: { kind: "timeout", code: "TIMEOUT", message: `no answer for ${ESCAPED_IN_TEXT} and ${SHORT_SECRET}`, retryable: true },
      }),
    });
    // The wait timeout keeps exit 6 and `status: unknown`: scrubbing does not
    // change how a failure is classified.
    expect(result.code).toBe(6);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, status: "timeout", exitCode: 6 });
    expect(body.result).toMatchObject({ status: "unknown", error: { kind: "timeout", code: "TIMEOUT", retryable: true } });
    expect(result.stdout).not.toContain("p@ss");
    expect(result.stdout).not.toContain(SHORT_SECRET);
  });

  it("reaches a nested job failure that the command itself reports as ok", () => {
    const result = run(["jobs", "get", "boot-test:job-1"], {
      pageResult: {
        job: {
          jobId: "boot-test:job-1", bootId: "boot-test", traceId: "boot-test:action-1", actionId: "auth.login",
          status: "failed", cancellationSupported: false, cancellationRequested: false,
          startedAt: "1970-01-01T00:00:00.000Z",
          result: {
            ok: false, status: "failed", traceId: "boot-test:action-1",
            error: {
              kind: "auth", code: "AUTH_FAILED", retryable: false,
              message: `rejected: {"password":"${LONG_SECRET}","apiKey":"${SHORT_SECRET}"}`,
            },
          },
        },
      },
    });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    // The command still succeeds; only the stored failure is scrubbed.
    expect(body).toMatchObject({ ok: true, status: "failed", exitCode: 0 });
    const message: string = body.job.result.error.message;
    expect(message).not.toContain(LONG_SECRET);
    expect(message).not.toContain(SHORT_SECRET);
    expect(body.job.result.error).toMatchObject({ kind: "auth", code: "AUTH_FAILED", retryable: false });
    // The redacted fragment is still valid JSON.
    expect(JSON.parse(message.slice(message.indexOf("{")))).toEqual({ password: "[redacted]", apiKey: "[redacted]" });
  });

  it("scrubs the failure results stored by jobs wait and jobs cancel", () => {
    const failure = () => ({
      result: {
        ok: false, status: "failed", traceId: "boot-test:action-1",
        error: {
          kind: "auth", code: "AUTH_FAILED", retryable: false,
          message: `Authorization: Bearer ${SHORT_SECRET}; password=${LONG_SECRET}`,
        },
      },
    });
    const wait = run(["jobs", "wait", "boot-test:job-1"], { pageResult: failure() });
    const cancel = run(["jobs", "cancel", "boot-test:job-1"], { pageResult: failure() });
    for (const outcome of [wait, cancel]) {
      expect(outcome.code, outcome.stdout).toBe(5);
      expect(outcome.stdout).not.toContain(SHORT_SECRET);
      expect(outcome.stdout).not.toContain(LONG_SECRET);
      const body = JSON.parse(outcome.stdout);
      expect(body.result).toMatchObject({ status: "failed", error: { kind: "auth", code: "AUTH_FAILED" } });
      expect(body.result.error.message).toContain("[redacted]");
    }
  });

  it("scrubs failed batch items and thrown messages but leaves successful items exact", () => {
    const successNote = `kept as the page sent it: ${LONG_SECRET} ${SHORT_SECRET}`;
    const result = run(["batch"], {
      input: JSON.stringify({
        items: [
          { id: "camera.reset", input: { apiKey: SHORT_SECRET } },
          { id: "auth.login", input: { password: LONG_SECRET, apiKey: SHORT_SECRET, tokens: [TOKEN_SECRET, SHORT_SECRET], escapedPassword: 'p@ss"word' } },
          { id: "job.cancel", input: { password: LONG_SECRET } },
        ],
      }),
      pageResult: {
        concurrency: 2,
        results: [
          { index: 0, op: "execute", id: "camera.reset", apiVersion: 2, result: { ok: true, status: "completed", data: { note: successNote } } },
          { index: 1, op: "execute", id: "auth.login", apiVersion: 2,
            result: { ok: false, status: "failed", traceId: "boot-test:action-2", error: { kind: "auth", code: "AUTH_FAILED", message: leakyMessage(), retryable: false } } },
          { index: 2, op: "query", id: "job.cancel", threw: { message: `handler threw after ${LONG_SECRET} and ${SHORT_SECRET}` } },
        ],
      },
    });
    expect(result.code).toBe(7);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, status: "partial", failed: 2, exitCode: 7 });
    // A successful item is the page's own payload and is not rewritten.
    expect(body.results[0]).toEqual({
      index: 0, op: "execute", id: "camera.reset", apiVersion: 2,
      result: { ok: true, status: "completed", data: { note: successNote } },
    });
    expect(body.results[1].result.error).toMatchObject({ kind: "auth", code: "AUTH_FAILED", retryable: false });
    for (const needle of [LONG_SECRET, SHORT_SECRET, TOKEN_SECRET, "p@ss"]) {
      expect(body.results[1].result.error.message).not.toContain(needle);
      expect(body.results[2].threw.message).not.toContain(needle);
    }
    expect(body.results[2].threw.message).toContain("[redacted]");
  });

  it("keeps a successful DTO exactly as the page returned it", () => {
    const note = `echoed ${LONG_SECRET} ${SHORT_SECRET}`;
    const result = run(["exec", "camera.reset"], {
      input: JSON.stringify({ password: LONG_SECRET }),
      pageResult: failedPage({ ok: true, status: "completed", traceId: "boot-test:action-1", data: { note } }),
    });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, status: "ok", exitCode: 0 });
    // Declared boundary: success data is passed through, not scrubbed.
    expect(body.result).toEqual({ ok: true, status: "completed", traceId: "boot-test:action-1", data: { note } });
  });
});

describe("page address redaction", () => {
  it("removes userinfo, query and fragment from a connect href", () => {
    const long = run(["connect", "--url", "https://app.example.test/viewer/workspace"], {
      href: `https://alice:${LONG_SECRET}@evil.test/back?token=${LONG_SECRET}#frag`,
    });
    const short = run(["connect", "--url", "https://app.example.test/viewer/workspace"], {
      href: `https://user:${SHORT_SECRET}@evil.test/back`,
    });
    for (const outcome of [long, short]) {
      expect(outcome.code).toBe(0);
      const body = JSON.parse(outcome.stdout);
      expect(body.ping.href).toBe("https://evil.test/back");
      expect(outcome.stdout).not.toContain("alice");
      expect(outcome.stdout).not.toContain(LONG_SECRET);
      expect(outcome.stdout).not.toContain(SHORT_SECRET);
    }
    // The validated input URL keeps its exact public path.
    expect(JSON.parse(long.stdout).url).toBe("https://app.example.test/viewer/workspace");
  });

  it("removes userinfo from the post-demo reload ping", () => {
    const result = run(["connect", "--url", "https://app.example.test/viewer", "--demo", "--wait-ms", "1000"], {
      demo: true, href: `https://user:${SHORT_SECRET}@evil.test/back`,
    });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ demo: true, bootIdChanged: true, exitCode: 0 });
    expect(body.ping.href).toBe("https://evil.test/back");
    expect(result.stdout).not.toContain(SHORT_SECRET);
  });

  it("removes userinfo, query and fragment from a standalone ping href", () => {
    const result = run(["ping"], { href: `https://user:${SHORT_SECRET}@evil.test/a?b=1#c` });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ping.href).toBe("https://evil.test/a");
  });

  it("does not echo an address that is not a parseable url", () => {
    const result = run(["ping"], { href: `::not a url:: user:${LONG_SECRET}@host` });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ping.href).toContain("unparseable");
    expect(result.stdout).not.toContain(LONG_SECRET);
    expect(result.stdout).not.toContain("not a url");
  });

  it("leaves an ordinary page address alone", () => {
    const result = run(["ping"], { href: "https://app.example.test/viewer/workspace" });
    expect(JSON.parse(result.stdout).ping.href).toBe("https://app.example.test/viewer/workspace");
  });
});

describe("injected script omission", () => {
  it("omits a truncated copy of the injected script", () => {
    const result = run(["exec", "auth.login"], {
      input: JSON.stringify({ password: LONG_SECRET, apiKey: SHORT_SECRET }),
      mode: "echo", echo: `rejected ${LONG_SECRET} ${SHORT_SECRET}`, echoStyle: "trunc",
    });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("__tmDispatch");
    expect(result.stderr).not.toContain("__tmDispatch");
    expect(result.stdout).not.toContain(LONG_SECRET);
    expect(result.stdout).not.toContain(SHORT_SECRET);
    expect(JSON.parse(result.stdout).error.message).toContain("[script omitted]");
    // The echo really did carry the script, so this is not vacuous.
    expect(recorded().stdin).toContain("__tmDispatch");
  });

  it("omits a JSON-escaped copy of the injected script", () => {
    const result = run(["exec", "auth.login"], {
      input: JSON.stringify({ password: LONG_SECRET, apiKey: SHORT_SECRET }),
      mode: "echo", echo: `rejected ${LONG_SECRET}`, echoStyle: "escaped",
    });
    expect(result.code).toBe(4);
    expect(result.stdout).not.toContain("__tmDispatch");
    expect(result.stderr).not.toContain("__tmDispatch");
    expect(result.stdout).not.toContain(LONG_SECRET);
    expect(result.stdout).not.toContain("requireFacade");
    expect(JSON.parse(result.stdout).error.message).toContain("[script omitted]");
  });

  it("keeps a script-free transport failure diagnosable", () => {
    const result = run(["exec", "auth.login"], {
      input: JSON.stringify({ password: LONG_SECRET }), mode: "leak",
    });
    expect(result.code).toBe(4);
    const body = JSON.parse(result.stdout);
    expect(body.error.message).toContain("evaluate failed for");
    expect(body.error.message).toContain("password=[redacted]");
    expect(body.transport.code).toBe("BROWSER_FAILED");
    expect(result.stdout).not.toContain(LONG_SECRET);
  });
});
