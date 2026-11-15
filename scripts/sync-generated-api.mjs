import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages/generated-api");
const snapshotRoot = resolve(packageRoot, "src/snapshot");
const manifestPath = resolve(packageRoot, "source-manifest.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portablePath = (path) => path.replaceAll("\\", "/");
const imports = (text) => [...text.matchAll(/\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
const entries = () => imports(readFileSync(resolve(packageRoot, "src/index.ts"), "utf8"))
  .filter((path) => path.startsWith("./snapshot/"))
  .map((path) => path.slice("./snapshot/".length) + ".ts").sort();
const fileList = (directory) => existsSync(directory)
  ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? fileList(resolve(directory, entry.name)) : [resolve(directory, entry.name)])
  : [];

function assertInside(directory, path) {
  const local = relative(directory, path);
  if (local.startsWith("..") || local.startsWith("/")) throw new Error("Source dependency escapes the approved root");
}

function readClosure(sourceRoot, entryFiles) {
  const files = new Map();
  const pending = [...entryFiles];
  while (pending.length) {
    const source = pending.pop();
    if (files.has(source)) continue;
    const absolute = realpathSync(resolve(sourceRoot, source));
    assertInside(sourceRoot, absolute);
    const bytes = readFileSync(absolute);
    const text = bytes.toString("utf8");
    // Report filenames only: never print a value detected in a source file.
    if (/https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)
      || /\b(?:password|passwd|token|secret|access[_-]?key|private[_-]?key)\s*(?::\s*string\s*)?[:=]\s*["'][^"']{4,}["']/i.test(text)) {
      throw new Error(`Review possible embedded service configuration before copying: ${source}`);
    }
    files.set(source, bytes);
    for (const specifier of imports(text)) {
      if (specifier === "@timemachine/api-client") continue;
      if (!specifier.startsWith(".")) throw new Error(`Unapproved source dependency in ${source}`);
      const base = resolve(dirname(absolute), specifier);
      const dependency = [base, `${base}.ts`, resolve(base, "index.ts")].find((path) => existsSync(path) && path.endsWith(".ts"));
      if (!dependency) throw new Error(`Unresolved source dependency in ${source}`);
      assertInside(sourceRoot, dependency);
      pending.push(portablePath(relative(sourceRoot, dependency)));
    }
  }
  return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function check() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(entries()) !== JSON.stringify(manifest.entryFiles)) throw new Error("Export roots changed; sync the source snapshot");
  const expectedPaths = manifest.files.map((entry) => resolve(packageRoot, entry.path)).sort();
  if (JSON.stringify(fileList(snapshotRoot).sort()) !== JSON.stringify(expectedPaths)) throw new Error("Snapshot file set differs from manifest");
  for (const entry of manifest.files) {
    const path = resolve(packageRoot, entry.path);
    assertInside(snapshotRoot, path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Snapshot checksum mismatch: ${entry.path}`);
  }
  const closure = readClosure(snapshotRoot, manifest.entryFiles);
  if (closure.length !== manifest.files.length) throw new Error("Snapshot dependency closure changed");
  const digest = hash(manifest.files.map((entry) => `${entry.sha256}  ${entry.sourcePath}\n`).join(""));
  if (digest !== manifest.sourceClosureSha256) throw new Error("Source manifest checksum mismatch");
  console.log(`Verified ${manifest.files.length} portable source files (${digest}).`);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") {
  check();
} else if (args.length === 2 && args[0] === "--source-root") {
  const sourceRoot = realpathSync(resolve(args[1]));
  const encryptPath = realpathSync(resolve(sourceRoot, "utils/encrypt.ts"));
  assertInside(sourceRoot, encryptPath);
  const encryptSourceSha256 = hash(readFileSync(encryptPath));
  const reviewedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (encryptSourceSha256 !== reviewedManifest.accountDigestAdapter.sourceSha256) {
    throw new Error("Account digest source changed; review the adapter and golden tests before explicitly updating its reviewed source hash");
  }
  const sourceRepository = execFileSync("git", ["-C", sourceRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (...args) => execFileSync("git", ["-C", sourceRepository, ...args], { encoding: "utf8" }).trim();
  const entryFiles = entries();
  if (entryFiles.length === 0) throw new Error("No generated export roots found");
  const closure = readClosure(sourceRoot, entryFiles);
  const trackedFiles = new Set(git("ls-files", "-z").split("\0"));
  const modifiedFiles = new Set(git("diff", "HEAD", "--name-only", "-z").split("\0"));
  const files = closure.map(([source, bytes]) => {
    const sourcePath = portablePath(relative(sourceRepository, resolve(sourceRoot, source)));
    return {
      path: `src/snapshot/${source}`,
      sourcePath,
      bytes: bytes.length,
      sha256: hash(bytes),
      sourceState: !trackedFiles.has(sourcePath) ? "untracked" : modifiedFiles.has(sourcePath) ? "modified" : "tracked",
    };
  });
  const wanted = new Set(files.map((entry) => resolve(packageRoot, entry.path)));
  if (fileList(snapshotRoot).some((path) => !wanted.has(path))) {
    throw new Error("Snapshot contains obsolete files; review their removal explicitly before syncing");
  }
  const manifest = {
    schemaVersion: 1,
    source: {
      repository: "DPlanet",
      root: portablePath(relative(sourceRepository, sourceRoot)),
      gitHead: git("rev-parse", "HEAD"),
      gitBranch: git("branch", "--show-current"),
      producer: "MetaMaker (code_ex source headers); generator version not embedded",
      definitionDirectory: "MetaMaker2/Define",
      capture: "Current working-tree bytes, including modified and untracked generated files; not a HEAD-only export",
      authorization: "Internal reuse for the user-authorized application migration; no independent redistribution license asserted",
    },
    entryFiles,
    allowedExternalImports: ["@timemachine/api-client"],
    sourceClosureSha256: hash(files.map((entry) => `${entry.sha256}  ${entry.sourcePath}\n`).join("")),
    accountDigestAdapter: {
      sourcePath: portablePath(relative(sourceRepository, encryptPath)),
      sourceSha256: encryptSourceSha256,
      implementation: "src/account-password.ts (handwritten adapter, not generated DTO)",
      semantics: "SHA-256 of UTF-8(account + password + public protocol suffix), lowercase hex; malformed UTF-16 rejected",
      fallbackDependency: "crypto-js/sha256 4.2.0 (MIT), matching the source application's installed version; no MD5 imported",
    },
    files,
  };
  // Validate every input before writing any snapshot file; preserve original BOM and line endings.
  for (const [source, bytes] of closure) {
    const destination = resolve(snapshotRoot, source);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  check();
} else {
  throw new Error("Usage: node scripts/sync-generated-api.mjs --check | --source-root <DPlanet TypeScript src directory>");
}
