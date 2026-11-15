import { createHash, webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";

import * as generatedApi from "@timemachine/generated-api";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = resolve(root, "packages/generated-api");

describe("portable generated contracts", () => {
  it("bundles SDK and account login without access to a neighboring checkout", async () => {
    const aliases = Object.fromEntries(
      readdirSync(resolve(root, "packages")).map((name) => [
        `@timemachine/${name}`,
        resolve(root, "packages", name, "src/index.ts"),
      ]),
    );
    const resolvedFiles = new Set<string>();
    const result = await build({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      resolve: { alias: aliases },
      plugins: [{
        name: "isolated-contract-boundary",
        enforce: "pre",
        async resolveId(source, importer, options) {
          const resolved = await this.resolve(source, importer, {
            ...options,
            skipSelf: true,
          });
          if (!resolved || !isAbsolute(resolved.id)) return resolved;
          const file = relative(root, resolved.id).replaceAll("\\", "/");
          // The diagnostic logger reads this checkout's application version.
          // Its root manifest is present in a clean Web checkout; neighboring
          // sources and every other root file remain outside this boundary.
          if (file !== "package.json" && !/^(?:packages|src|node_modules)\//.test(file)) {
            throw new Error(`Module is unavailable in an isolated Web checkout: ${file}`);
          }
          resolvedFiles.add(file);
          return resolved;
        },
      }],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: {
            contracts: resolve(packageRoot, "src/index.ts"),
            login: resolve(root, "src/phase1b/cloud-client.ts"),
          },
          formats: ["es"],
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) =>
      "output" in output
        ? output.output.flatMap((chunk) => chunk.type === "chunk" ? [chunk] : [])
        : [],
    );
    const exports = chunks.flatMap((chunk) => chunk.exports);
    expect(exports).toContain("TimeMachinePlatformInvoker");
    expect(exports).toContain("ProjectDocumentV2TO");
    expect(exports).toContain("Phase1BCloudClient");
    expect(resolvedFiles).toContain("packages/generated-api/src/snapshot/code_ex/d_planet/module/time_machine_platform_invoker.ts");
    expect(resolvedFiles).toContain("node_modules/crypto-js/sha256.js");
    expect(resolvedFiles).toContain("package.json");
    expect([...resolvedFiles].filter((file) => /(?:crypto-js\/md5|ts-md5)/.test(file))).toEqual([]);
    const cryptoChunks = chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => id.includes("/crypto-js/")));
    expect(cryptoChunks.length).toBeGreaterThan(0);
    expect(cryptoChunks.every((chunk) => chunk.isDynamicEntry && !chunk.isEntry)).toBe(true);
  });

  it("matches the frozen source hashes without requiring the source checkout", () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "source-manifest.json"), "utf8")) as {
      files: { path: string; bytes: number; sha256: string }[];
    };
    expect(manifest.files.length).toBeGreaterThan(100);
    for (const entry of manifest.files) {
      const bytes = readFileSync(resolve(packageRoot, entry.path));
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
    }
  });

  it("stops synchronization when the reviewed account digest source changes", () => {
    const source = mkdtempSync(resolve(tmpdir(), "timemachine-digest-source-"));
    mkdirSync(resolve(source, "utils"));
    writeFileSync(resolve(source, "utils/encrypt.ts"), "// synthetic changed digest source\n");
    const manifestPath = resolve(packageRoot, "source-manifest.json");
    const before = readFileSync(manifestPath, "utf8");
    const result = spawnSync(process.execPath, [
      resolve(root, "scripts/sync-generated-api.mjs"), "--source-root", source,
    ], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Account digest source changed; review the adapter and golden tests");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });
});

describe("portable account digest", () => {
  afterEach(() => vi.unstubAllGlobals());
  const digest = generatedApi.GetPassword;

  it.each([
    ["fixture-account", "fixture-input"],
    ["地球用户", "重建🌍"],
    [" a\u0000", "b \n"],
    ["", ""],
  ])("retains SHA-256 UTF-8 semantics for synthetic input %#", async (account, password) => {
    expect(digest).toBeTypeOf("function");
    const expected = createHash("sha256")
      .update(`${account}${password}DPlanet-456852`, "utf8")
      .digest("hex");
    expect(await digest(account, password)).toBe(expected);
  });

  it("rejects malformed UTF-16 instead of hashing replacement characters", async () => {
    expect(digest).toBeTypeOf("function");
    await expect(digest("fixture", "\ud800")).rejects.toThrow();
    await expect(digest("fixture", "\udc00")).rejects.toThrow();
  });

  it("preserves login digest support when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(digest).toBeTypeOf("function");
    const expected = createHash("sha256").update("地球🌍DPlanet-456852", "utf8").digest("hex");
    expect(await digest("地球", "🌍")).toBe(expected);
    await expect(digest("fixture", "\ud800")).rejects.toThrow();
  });

  it("uses the native digest when Web Crypto is available", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const spy = vi.spyOn(webcrypto.subtle, "digest");
    try {
      expect(await digest("fixture", "input")).toBe(
        createHash("sha256").update("fixtureinputDPlanet-456852").digest("hex"),
      );
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
