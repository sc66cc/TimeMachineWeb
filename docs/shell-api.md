# Shell API (`tm-api`)

A shell interface over the frontend v2 contracts that already exist in the page
(`window.timeMachineAgent.v2`) plus an **offline** catalog of the generated
Server endpoints. It adds no BFF, no Server endpoint, no new transport and no
second task system: a command drives the real handler the UI drives, through the
app's own facade.

```sh
npm run api:shell -- <command> [args]
# equivalently
sh scripts/tm-api.sh <command> [args]
```

Transport is `agent-browser` with one persistent session. Each command is one
`eval --stdin` against the already-open page, so a command never re-navigates
and never rebuilds the Viewer. Only `connect` navigates.

## Commands

| Command | Needs a page | What it returns |
| --- | --- | --- |
| `connect --url <url> [--demo]` | navigates | session identity, `bootId`, facade versions, action count |
| `ping` | yes | whether the facade is installed on the current document |
| `catalog [--kind K] [--scope S] [--availability A] [--prefix P]` | yes | v2 catalog summaries (runtime availability) |
| `catalog --check` | yes | schema-resolution drift report |
| `describe <id>` | yes | full v2 descriptor (input/output schema, examples) |
| `exec <id> [--api-version 1\|2] [--completion committed\|accepted] [--timeout-ms N]` | yes | the untouched `ApiResult` (or v1 `AgentActionResult`) |
| `query <id>` | yes | the untouched `ApiResult` |
| `jobs get\|wait\|cancel <jobId> [--timeout-ms N]` | yes | job snapshot / terminal result / cancellation acceptance |
| `logs query\|export\|clear` | yes | `LogPage`, NDJSON text, or `{cleared:true}` |
| `events collect [--types a,b] [--duration-ms N] [--max-events N]` | yes | NDJSON: one window line, then the events |
| `batch [--concurrency 1..4]` | yes | per-item results plus a partial-failure summary |
| `services catalog [--scope active\|unported\|all] [--check] [--summary] [--full] [--write]` | **no** | every Server endpoint from both sources |
| `services describe <id>` | **no** | one endpoint, its types, provenance and `schemaRefs` |
| `services call <id>` | **no** | an honest not-implemented error for every endpoint |

Input is JSON from `--input-file <path>` or stdin. **Parameters never travel
through argv**; empty stdin means `{}`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success (`completed`, or `accepted` when the caller asked for acceptance) |
| 1 | internal / unexpected |
| 2 | usage error or API validation error, including an unknown/expired job id |
| 3 | `not-implemented` / `unsupported` — the operation exists but this build cannot run it |
| 4 | transport or page unavailable (no session, no facade, browser failure) |
| 5 | authentication/authorization |
| 6 | a `jobs wait` timeout — **the job was not cancelled** |
| 7 | batch partial failure (at least one item failed) |
| 8 | contract drift (`catalog --check`, `services catalog --check`) |

Every JSON payload repeats its exit code as `exitCode`, so a wrapper can check
either.

## Completion semantics

- `exec` sends job options **only** when you pass `--completion`/`--timeout-ms`.
  An inline operation is never handed a job wait it did not ask for; v2 rejects
  those options for inline operations and the CLI refuses to send them for v1.
- `status: "accepted"` is an accepted job, not a finished one. Follow it with
  `jobs wait`.
- A `jobs wait` timeout is `status: "unknown"` with `error.code === "TIMEOUT"`.
  The job keeps running; `jobs cancel` is a separate, explicit decision.
- `jobs cancel` returning `accepted` means the request was delivered. The owner
  still has to settle the job; query `jobs get` for the terminal state.
- Page-reload operations (`model.select`, `dataset.select`, `project.open`,
  `upload.run`) are `not-implemented` in v2 by design. Run them with
  `exec <id> --api-version 1`; the result carries `reloadRequired: true` and
  `status: "page-reload-required"`. Wait for `ping`'s `bootId` to change before
  reading state again. v2 never silently falls back to v1.
- `connect --demo` is the only way this tool selects the local PALEOMAP demo,
  and it does so by running the real v1 `model.select` action — never by writing
  app storage from outside.

## Events

`events collect` opens one subscriber, waits for a bounded window
(`--duration-ms`, 1..60000 ms), unsubscribes in a `finally`, and prints NDJSON.
The first line is a `collection` record whose `note` says the window is finite
and **not a live tail**; events outside it were never delivered to this
subscriber. Use `droppedCount`/`overflow` to detect gaps and the authoritative
`query`/`jobs` calls after a gap.

## Services (offline catalog)

Two read-only sources are projected with the same text extractor:

| Source | Base | Role |
| --- | --- | --- |
| `active-snapshot` | `packages/generated-api/src/snapshot` | the contract this application **runs** |
| `dplanet-sdk` | `DPlanet/TypeScript/src` | the **complete** upstream SDK source tree |

Counts for the current checkout, reported separately:

| Measure | Value |
| --- | --- |
| active snapshot | 11 invokers / **54 endpoints** |
| full SDK source | 51 invokers / **289 endpoints** |
| unported (SDK-only, reserved) | **235 endpoints** |
| snapshot-only (in the app, absent from the SDK scan) | 0 |
| same-route signature conflicts | 0 (recorded as `sourceVariants` when they appear) |
| routed through a page action | **0** |
| reserved / not callable | **289** |

The extractor reads module URL, route, verb, `@authorize` roles, TypeScript
parameter types, transport field names and the declared return type. It never
imports, executes or rewrites generated code, and it never contacts a Server.

**The runtime loads the generated artifact**, `scripts/tm-api/service-catalog.json`.
It does not scan, compile or import the neighbouring DPlanet source tree;
`--check` reads the JSON, then re-scans only to prove the artifact is not stale.

`services catalog --write` regenerates that artifact. It is the **only** command
that accepts `--write`; every other command refuses the flag with exit 2 instead
of ignoring it, so nothing is written by accident. Regeneration is
all-or-nothing:

- it refuses when either source is absent (a scan without the SDK tree would
  replace 289 endpoints — 235 of them reserved — with the 54 active ones);
- it refuses when the projection has duplicate ids or fails its own invariants
  and per-file hash checks;
- it writes to a temporary file and renames, so a failure leaves the previous
  artifact byte-identical and no partial file behind.

A refused regeneration exits 1 with `error.kind: "write-refused"` and
`written: null`.

Two honesty limits are built in:

1. **Types, not fields.** `schemaStatus` says whether a generated declaration
   file for a type name exists. Field-level DTO projection is not provided; open
   the `schemaRefs` path. An unresolved name is reported as `unresolved`, never
   as an empty "anything goes" schema. `vi/` wrapper declarations are indexed
   next to `code_ex/` so `ViFKey`, `ViEnum32<…>` and `ViBlob` are not mislabelled.
2. **Provenance is explicit.** Every endpoint carries
   `provenance: {inActiveSnapshot, presentInFullSdk, unported, conflict, roots}`.
   A route present in both sources keeps **both** signatures in
   `sourceVariants`; when they differ the entry is flagged `conflict`, the active
   snapshot still wins for routing, and no adapter is applied. An SDK-only
   endpoint is `unported: true` and always `callable: "reserved"` — it is
   discoverable, never silently callable and never presented as linearized.

**No endpoint is routed through a page action.** An adapter was withdrawn for
all nine endpoints that once looked close to one, because none of those actions
performs that endpoint's business operation with that endpoint's contract:

| Endpoint | Adjacent action | Why it is not this endpoint |
| --- | --- | --- |
| `service.Login.Login` | `auth.login` | hashes the password, applies its own mode/context rules and returns an application session, not the RPC DTO |
| `service.LoginMail.Login` | `auth.login` | same email-code flow, not the RPC's declared contract |
| `service.LoginMail.SendMailCode` | `auth.sendCode` | own code-issuing flow, throttling and context |
| `service.Logout.Logout` | `auth.logout` | clears the app's session state; request/result equivalence unverified |
| `service.TimeMachineWorkspace.CreateProject` | `project.save` | saves the current editor document and decides create-versus-save itself |
| `service.TimeMachineWorkspace.SaveProject` | `project.save` | same mismatch as `CreateProject` |
| `service.TimeMachineWorkspace.GetProjectRevision` | `project.open` | resolves a revision through the local catalog and reloads, not the RPC request |
| `service.TimeMachineIngest.CreateDatasetIngestJob` | `upload.run` | needs a real `File` and the page's form fields |
| `service.TimeMachineIngest.CancelJob` | `upload.cancel` | cancels the job the UI tracks, not a caller-supplied `jobId` |

`services call <id>` therefore returns
`status: "not-implemented"` with exit 3 for **all 289 endpoints**, plus
`dtoReturned: false`, `rawRpcDispatched: false`, and the concrete reason for
that endpoint. When an adjacent action exists it is reported as
`relatedAction: {actionId, invoked: false, note}` and in the reason text, worded
as a **different business entry point with its own contract** — never as this
endpoint. It is not invoked, and calling `tm-api exec <actionId>` instead is a
different operation with a different contract, not an adaptation of the endpoint.

Reserved stays reserved even where the operations look alike: no unverified
exception is kept. `service.UserPlateModel.Display` still cannot be served by
`catalog.refresh`'s derived count/status, and the five `UserPlateModel` write
endpoints remain blocked by a real JSON-versus-multipart mismatch.

`services catalog --check` re-verifies 11 active invokers / 54 active endpoints,
that every endpoint declares a verb and a return type, that **no** endpoint is
routed and `callable` is 0, that every reserved endpoint states a reason, that
each scanned file's SHA-256 still matches the artifact and the snapshot
manifest, and that the artifact equals a fresh scan (drift). Exit code 8 on any
mismatch.

**Discoverable is not the same as verified live.** None of the 289 endpoints —
neither the 235 unported ones nor the 54 active ones — is callable through this
tool, and none has been exercised against a running Server by this work.

## Security

- Parameters and credentials go to the page inside a fixed script written to the
  child's stdin. argv only ever contains `--session`, `--json`, `eval`,
  `--stdin` (or `open <url>`).
- The page script is a fixed `switch` over a closed operation list. No operation
  name, id or parameter is ever concatenated into JavaScript, and there is no
  `window` result slot to poll.
- `connect` parses `--url` and accepts only a public application URL: `http`,
  `https` or `file`, with **no** userinfo (`user:password@host`), **no** query and
  **no** fragment. Rejection happens before any child process exists, and the
  error never echoes the URL it refused. The app routes itself, and a password
  or login code does not belong in an address.
  `file://` and ordinary `http(s)` base URLs with a path keep working. Every
  `href` the page reports is rebuilt from its own structure before it is
  printed — for `connect`, for the post-reload ping of `connect --demo`, and for
  a standalone `ping` — dropping `username`, `password`, `search` and `hash` and
  keeping the public protocol, host and path, so a redirected address cannot
  leak a credential whatever its length. The rebuilt address then goes through
  the label scrub as well. An address that does not parse is not echoed; the
  field reads `[unparseable address omitted]` instead.
- stdout is machine output only. stderr carries one short line.

### What the scrubbing covers — and what it does not

**Covered:** every diagnostic the CLI itself emits (the `error.message` of a
failed command, the one-line stderr note, transport failure reasons).

- Sensitive keys are matched after stripping punctuation and case, so `apiKey`,
  `api-key` and `API_KEY` are all collected, at any depth, for **any** length —
  a 3-character password is still a password — and arrays of secrets are walked
  instead of skipped.
- Literal values are swapped wherever they appear, at **any** length (a
  3-character password and a short numeric-looking token included), longest
  first so a short credential cannot split a longer one, and including their
  `JSON.stringify`-escaped form, so a credential containing `"` is still found
  inside an echoed JSON blob.
- Failed results are scrubbed at one output boundary, not per command: the
  `error` of a failed `ApiResult` (`exec`, `query`, `jobs wait`, `jobs cancel`,
  `services call`), a `jobs get` snapshot whose nested `result` failed even
  though the command itself reports `ok: true`, and a failed `batch` item or its
  `threw.message`. Only diagnostic text changes: `kind`, `code`, `retryable`,
  every `status` and the exit code are carried through, so a timeout is still a
  timeout and an auth failure still exits 5.
- Assigned credentials of any length are redacted by label, in both bare
  (`password: p@1`) and JSON (`"password":"p@1"`) form. The replacement keeps
  the label's quoting, so a redacted JSON fragment is still parseable, and an
  auth scheme word (`Authorization: Bearer …`) is consumed together with the
  credential instead of being left behind.
- Non-string credential values (`true`, `1234`) are never swapped blindly; the
  label rule replaces the whole value with a JSON string, so the fragment still
  parses as JSON.
- A browser that echoes the injected script back does not get it quoted back:
  the script is removed (`[script omitted]`) **before** the secret swap, and the
  remaining reason is bounded to 400 characters. The fix does not depend on an
  exact match: a truncated copy, a JSON-escaped copy and a base64 copy are
  recognised by markers that survive escaping, and anything from the first
  script marker onward is dropped together with the parameters it carried. A
  script-free transport error is still reported in full, and the error kind and
  transport code are preserved — a failure stays a failure, it is not rewritten
  as an empty success.

**Not covered — do not read stdout as sanitized:**

- Success payloads are the application's own DTOs and are passed through
  unchanged, including `batch` item results, the `data` of a successful result
  and `logs export` NDJSON. The CLI does not rewrite a page's data, and the
  boundary scrubber never enters a success `data` subtree.
- Values that appear with neither a sensitive label nor as a collected input
  value are not guessed at, and a sensitive key in a *response* is not scrubbed.
  `jobs get|wait|cancel` take a job id and no input, so a diagnostic produced by
  a *different* invocation is covered by the label and script rules only; an
  unlabelled literal there is not knowable to this process and is not claimed.
- Scrubbing is a diagnostic safety net for this tool, not a guarantee that a
  page, a Server or a browser extension will not log the same parameters.

The CLI reuses the browser session you already have. It never reads a token,
account file or vault, and it never starts a Server.

## Live verification status

`scripts/tm-api/cli.mjs` and the catalogs are covered by
`src/test/shell-api-*.test.ts` (contract coverage, service-catalog projection
including an unresolved-type fixture and the write guard, and a synthetic
transport that records argv/stdin and echoes adversarial diagnostics). Real
browser runs are recorded separately; see the handoff notes for the exact
commands, timings and raw evidence paths.

The synthetic transport exercises these properties directly: a JSON-quoted
`apiKey`, a quoted and an unquoted `Bearer` header, a 3-character password, a
credential whose escaped form differs from its parsed form, boolean/numeric
credential values that must stay parseable, an echoed script that must not be
quoted back (whole, truncated and JSON-escaped), a failed `ApiResult` from the
transport's own success envelope for `exec`/`query`, a nested failure inside a
`jobs get` snapshot, `jobs wait`/`jobs cancel` failure results, a `batch` with a
successful item, a failed item and a thrown message, a successful DTO that must
survive unchanged, page `href`s that lose userinfo/query/fragment on all three
ping paths and a malformed one that is not echoed, a credential URL that must
not start a child process, and the nine withdrawn endpoints that must not reach
a page handler.
