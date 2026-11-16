import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_ROUTES,
  CATALOG_PATH,
  WITHDRAWN_ADAPTERS,
  buildServiceCatalog,
  checkServiceCatalog,
  readServiceCatalog,
  writeServiceCatalogJson,
} from "../../scripts/tm-api/service-catalog.mjs";

/**
 * The service catalog is derived from two read-only sources with one extractor:
 * the generated snapshot this application runs, and the complete DPlanet SDK
 * source tree. These assertions pin the coverage numbers, the provenance of
 * every endpoint, and the fact that the committed JSON artifact is not stale.
 */
const ROOT = process.cwd();

describe("generated service catalog", () => {
  const catalog = buildServiceCatalog(ROOT);

  it("counts both sources without conflating them", () => {
    expect(catalog.sources).toEqual([
      {
        id: "active-snapshot", base: "packages/generated-api/src/snapshot",
        role: "active-contract", present: true, invokers: 11, endpoints: 54,
      },
      {
        id: "dplanet-sdk", base: "DPlanet/TypeScript/src",
        role: "full-sdk-reference", present: true, invokers: 51, endpoints: 289,
      },
    ]);
    expect(catalog.counts).toMatchObject({
      activeSnapshotInvokers: 11,
      activeSnapshotEndpointCount: 54,
      fullSourceInvokerCount: 51,
      fullSourceEndpointCount: 289,
      unportedEndpointCount: 235,
      snapshotOnlyEndpointCount: 0,
      conflictCount: 0,
      callable: 0,
      reserved: 289,
    });
    // The listing is the union of both sources, never the active snapshot alone.
    expect(catalog.counts.endpoints).toBe(289);
    expect(catalog.endpoints.length).toBe(289);
    expect(catalog.duplicates).toEqual([]);
    expect(catalog.invokers.length).toBe(62);
  });

  it("labels every endpoint with its provenance", () => {
    const active = catalog.endpoints.filter(endpoint => endpoint.provenance.inActiveSnapshot);
    const unported = catalog.endpoints.filter(endpoint => endpoint.provenance.unported);
    expect(active.length).toBe(54);
    expect(unported.length).toBe(235);
    // The snapshot is generated from this SDK, so no active route is orphaned.
    expect(catalog.endpoints.filter(endpoint => endpoint.provenance.inActiveSnapshot && !endpoint.provenance.presentInFullSdk)).toEqual([]);
    for (const endpoint of active) {
      expect(endpoint.provenance.roots).toContain("active-snapshot");
      expect(endpoint.provenance.sourceVariants?.length, endpoint.id).toBe(2);
      expect(endpoint.source.path.startsWith("packages/generated-api/"), endpoint.id).toBe(true);
    }
    for (const endpoint of unported) {
      // An unported endpoint can never look callable.
      expect(endpoint.transport.callability, endpoint.id).toBe("reserved");
      expect(endpoint.transport.adapter, endpoint.id).toBeUndefined();
      expect(endpoint.transport.reason, endpoint.id).toContain("absent from this application's generated snapshot");
      expect(endpoint.source.path.startsWith("DPlanet/"), endpoint.id).toBe(true);
    }
  });

  it("records both signatures when a route exists in both sources", () => {
    for (const endpoint of catalog.endpoints.filter(candidate => candidate.provenance.presentInFullSdk && candidate.provenance.inActiveSnapshot)) {
      const variants = endpoint.provenance.sourceVariants;
      expect(variants, endpoint.id).toBeDefined();
      expect(variants!.length, endpoint.id).toBe(2);
      const activeVariant = variants![0]!;
      const sdkVariant = variants![1]!;
      expect(activeVariant.root).toBe("active-snapshot");
      expect(sdkVariant.root).toBe("dplanet-sdk");
      expect(activeVariant.signature.length, endpoint.id).toBeGreaterThan(0);
      // Recorded difference, never a silent overwrite.
      expect(endpoint.provenance.conflict, endpoint.id).toBe(activeVariant.signature !== sdkVariant.signature);
      if (endpoint.provenance.conflict) expect(endpoint.transport.adapter, endpoint.id).toBeUndefined();
    }
  });

  it("records one route, verb and declared return per endpoint", () => {
    for (const endpoint of catalog.endpoints) {
      expect(endpoint.id.startsWith("service."), endpoint.id).toBe(true);
      expect(endpoint.module.length, endpoint.id).toBeGreaterThan(0);
      expect(endpoint.route.length, endpoint.id).toBeGreaterThan(0);
      expect(endpoint.transport.httpMethod, endpoint.id).toBe("POST");
      expect(endpoint.declaresReturn, endpoint.id).toBe(true);
      for (const param of endpoint.params) {
        expect(param.classification, `${endpoint.id}.${param.name}`).not.toBe("unparsed");
        if (param.transportParam) expect(param.jsonShape, `${endpoint.id}.${param.name}`).toBe(false);
      }
    }
  });

  it("routes no endpoint through an action whose contract is unproven", () => {
    // Nine endpoints once looked close to an existing page action; each was
    // withdrawn, so the table is empty and nothing may be presented as callable.
    expect(Object.keys(ADAPTER_ROUTES)).toEqual([]);
    const routed = catalog.endpoints.filter(endpoint =>
      endpoint.transport.callability !== "reserved" || endpoint.transport.adapter !== undefined);
    expect(routed).toEqual([]);
    expect(catalog.endpoints.length).toBe(289);
    for (const endpoint of catalog.endpoints) {
      expect(endpoint.transport.reason, endpoint.id).toBeTruthy();
      expect(endpoint.transport.reason!.length, endpoint.id).toBeGreaterThan(30);
    }
  });

  it("names the adjacent action for each withdrawn adapter without routing it", () => {
    const withdrawn = Object.entries(WITHDRAWN_ADAPTERS);
    expect(withdrawn.length).toBe(9);
    for (const [id, entry] of withdrawn) {
      const endpoint = catalog.endpoints.find(candidate => candidate.id === id);
      expect(endpoint, id).toBeDefined();
      expect(endpoint!.provenance.inActiveSnapshot, id).toBe(true);
      expect(endpoint!.transport.callability, id).toBe("reserved");
      expect(endpoint!.transport.adapter, id).toBeUndefined();
      expect(endpoint!.transport.relatedActionId, id).toBe(entry.actionId);
      expect(endpoint!.transport.reason, id).toContain(entry.reason);
      // The action is named as a *different* contract, never as this endpoint.
      expect(endpoint!.transport.reason, id).toContain("different business entry point");
      expect(endpoint!.transport.reason, id).toContain(entry.actionId);
    }
    // The rest of the 289 endpoints are reserved too, with a stated reason.
    expect(catalog.counts.reserved).toBe(289);
    expect(catalog.counts.callable).toBe(0);
  });

  it("matches the generated source manifest and passes its own invariants", () => {
    expect(catalog.manifest.status).toBe("match");
    expect(catalog.manifest.checked).toBe(11);
    expect(checkServiceCatalog(catalog, ROOT)).toMatchObject({ ok: true, failures: [], absentSources: [] });
  });

  it("keeps the committed catalog artifact identical to a fresh scan", () => {
    const loaded = readServiceCatalog(ROOT);
    expect(loaded.loadedFrom).toBe("generated-catalog");
    const { loadedFrom: _loadedFrom, ...artifact } = loaded;
    expect(JSON.stringify(artifact)).toBe(JSON.stringify(catalog));
    // The artifact is the runtime source: the SDK tree is not needed to read it.
    expect(JSON.parse(readFileSync(join(ROOT, CATALOG_PATH), "utf8")).counts.endpoints).toBe(289);
  });

  it("reports an unresolvable type instead of an empty schema", () => {
    const root = mkdtempSync(join(tmpdir(), "tm-api-catalog-"));
    try {
      const moduleDirectory = join(root, "packages/generated-api/src/snapshot/code_ex/demo/module");
      const structDirectory = join(root, "packages/generated-api/src/snapshot/code_ex/demo/struct");
      mkdirSync(moduleDirectory, { recursive: true });
      mkdirSync(structDirectory, { recursive: true });
      writeFileSync(join(structDirectory, "known_ro.ts"), "export class KnownRO\n{\n\tValue = 0;\n}\n");
      writeFileSync(join(moduleDirectory, "demo_invoker.ts"), [
        "export class DemoInvoker",
        "{",
        '\tstatic readonly URL = "demo/module";',
        '\tstatic readonly URL_Known = "known";',
        "\tstatic Known(ID: number, requestStream: RPCUploadStream | undefined = undefined): Promise<RPCResult<KnownRO>>",
        "\t{",
        '\t\treturn RPCInvoker.Request("POST", DemoInvoker.URL, DemoInvoker.URL_Known, requestStream);',
        "\t}",
        '\tstatic readonly URL_Missing = "missing";',
        '\tstatic Missing(Property: MissingVO): Promise<RPCResult<MissingRO>>',
        "\t{",
        '\t\treturn RPCInvoker.Request("POST", DemoInvoker.URL, DemoInvoker.URL_Missing);',
        "\t}",
        "}",
        "",
      ].join("\n"));

      const fixture = buildServiceCatalog(root);
      expect(fixture.counts.endpoints).toBe(2);
      // No SDK tree in this fixture: the second source is absent, not empty.
      expect(fixture.sources[1]).toMatchObject({ id: "dplanet-sdk", present: false, invokers: 0, endpoints: 0 });
      const known = fixture.endpoints.find(endpoint => endpoint.id === "service.Demo.Known")!;
      expect(known.schemaStatus).toBe("resolved");
      expect(known.schemaRefs[0]).toMatchObject({ role: "return", name: "KnownRO", status: "resolved" });
      const missing = fixture.endpoints.find(endpoint => endpoint.id === "service.Demo.Missing")!;
      expect(missing.schemaStatus).toBe("unresolved");
      expect([...missing.unresolvedTypes].sort()).toEqual(["parameter:MissingVO", "return:MissingRO"]);
      // A missing manifest is reported, not treated as a match.
      expect(fixture.manifest.status).toBe("absent");
      expect(checkServiceCatalog(fixture, root).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the check when a scanned file changed on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "tm-api-catalog-drift-"));
    try {
      const moduleDirectory = join(root, "packages/generated-api/src/snapshot/code_ex/demo/module");
      mkdirSync(moduleDirectory, { recursive: true });
      const invokerPath = join(moduleDirectory, "demo_invoker.ts");
      writeFileSync(invokerPath, [
        "export class DemoInvoker",
        "{",
        '\tstatic readonly URL = "demo/module";',
        '\tstatic readonly URL_List = "list";',
        "\tstatic List(ID: number): Promise<RPCResult>",
        "\t{",
        '\t\treturn RPCInvoker.Request("POST", DemoInvoker.URL, DemoInvoker.URL_List);',
        "\t}",
        "}",
        "",
      ].join("\n"));
      const before = buildServiceCatalog(root);
      expect(checkServiceCatalog(before, root).absentSources).toEqual([]);
      // The recorded hash is now stale for this file.
      writeFileSync(invokerPath, `${readFileSync(invokerPath, "utf8")}// drifted\n`);
      const after = checkServiceCatalog(before, root);
      expect(after.ok).toBe(false);
      expect(after.failures.some(failure => failure.includes("sha256-mismatch"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite the artifact when a source is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tm-api-catalog-write-"));
    try {
      // An active snapshot with no SDK tree: a regeneration here would replace
      // the 289-endpoint catalog with the 54 active ones.
      const moduleDirectory = join(root, "packages/generated-api/src/snapshot/code_ex/demo/module");
      mkdirSync(moduleDirectory, { recursive: true });
      writeFileSync(join(moduleDirectory, "demo_invoker.ts"), [
        "export class DemoInvoker",
        "{",
        '\tstatic readonly URL = "demo/module";',
        '\tstatic readonly URL_List = "list";',
        "\tstatic List(ID: number): Promise<RPCResult>",
        "\t{",
        '\t\treturn RPCInvoker.Request("POST", DemoInvoker.URL, DemoInvoker.URL_List);',
        "\t}",
        "}",
        "",
      ].join("\n"));
      const path = join(root, CATALOG_PATH);
      mkdirSync(join(root, "scripts/tm-api"), { recursive: true });
      const sentinel = '{"sentinel":"previous artifact"}\n';
      writeFileSync(path, sentinel);

      expect(() => writeServiceCatalogJson(root, path)).toThrow(/absent from this checkout/);
      // The refusal keeps the previous artifact byte-identical.
      expect(readFileSync(path, "utf8")).toBe(sentinel);
      expect(readdirSync(join(root, "scripts/tm-api"))).toEqual(["service-catalog.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
