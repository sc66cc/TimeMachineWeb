import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_PROJECT_DRAFT_KEY, commitOpenedProject, parseProjectCloudContext,
  readProjectCloudContext, updateProjectCloudContext, writeProjectDraft, type ProjectCloudContext,
} from "../project/project-cloud-context";

const context = (contextId = "project-a"): ProjectCloudContext => ({ contextId,
  selection: { datasetVersionId: 0, plateModelId: 42, plateModelVersionId: 0, useLocalPlateModelDemo: false },
  reference: { accountEmail: "fixture@example.test", contentHash: "fixture-hash", projectId: 7, revisionId: 11, revisionNumber: 1 },
});
function storageWith(draft?: unknown) {
  const records = new Map<string, string>();
  if (draft !== undefined) records.set(LOCAL_PROJECT_DRAFT_KEY, typeof draft === "string" ? draft : JSON.stringify(draft));
  return { records, getItem: vi.fn((key: string) => records.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { records.set(key, value); }) };
}

describe("project cloud context single-key persistence", () => {
  it("commits the new draft, sources and reference in one write without changing legacy keys", () => {
    const storage = storageWith({ schemaVersion: 2, name: "Old" });
    storage.records.set("timemachine:web:phase1b-cloud-reference", "legacy-reference");
    storage.records.set("timemachine:web:phase1b-resource-selection", "legacy-selection");
    commitOpenedProject(storage, JSON.stringify({ schemaVersion: 2, name: "New", cloudDocument: { Description: "Preserve" } }), context());
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)!)).toEqual({ schemaVersion: 2, name: "New", cloudDocument: { Description: "Preserve" }, cloudContext: context() });
    expect(storage.records.get("timemachine:web:phase1b-cloud-reference")).toBe("legacy-reference");
    expect(storage.records.get("timemachine:web:phase1b-resource-selection")).toBe("legacy-selection");
  });

  it("merges the latest cloud revision into local edits instead of restoring a stale serialized context", () => {
    const current = context(); current.reference!.revisionId = 12; current.reference!.revisionNumber = 2;
    const storage = storageWith({ schemaVersion: 2, cloudContext: current });
    writeProjectDraft(storage, JSON.stringify({ schemaVersion: 2, currentTimeMa: 110, cloudContext: context() }), "project-a");
    expect(JSON.parse(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)!)).toEqual({ schemaVersion: 2, currentTimeMa: 110, cloudContext: current });
  });

  it.each([
    [undefined, context("project-b")], ["project-a", context("project-b")], ["project-a", undefined],
  ])("rejects a stale runtime without overwriting the new draft (%s)", (expected, current) => {
    const storage = storageWith({ schemaVersion: 2, name: "Current", ...(current ? { cloudContext: current } : {}) });
    const original = storage.records.get(LOCAL_PROJECT_DRAFT_KEY);
    expect(() => writeProjectDraft(storage, JSON.stringify({ schemaVersion: 2, name: "Stale" }), expected as string | undefined)).toThrow(/active project changed/i);
    expect(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)).toBe(original); expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retains explicit legacy storage when both context IDs are absent", () => {
    const storage = storageWith({ schemaVersion: 2, name: "Old" });
    expect(readProjectCloudContext(storage)).toBeUndefined();
    writeProjectDraft(storage, JSON.stringify({ schemaVersion: 2, name: "Edited" }), undefined);
    expect(JSON.parse(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)!)).toEqual({ schemaVersion: 2, name: "Edited" });
  });

  it("keeps no-reference contexts detached from legacy references", () => {
    const { reference: _reference, ...local } = context();
    const storage = storageWith({ schemaVersion: 2, cloudContext: local });
    expect(readProjectCloudContext(storage)).toEqual(local);
    expect(readProjectCloudContext(storage)?.reference).toBeUndefined();
  });

  it("rejects invalid or unknown context fields instead of treating them as legacy data", () => {
    for (const invalid of [null, {}, { ...context(), extra: true }, { ...context(), contextId: " " },
      { ...context(), reference: null }, { ...context(), selection: { ...context().selection, plateModelVersionId: 9 } },
      { ...context(), selection: { ...context().selection, datasetVersionId: NaN } }]) {
      expect(() => parseProjectCloudContext(invalid)).toThrow();
    }
    expect(parseProjectCloudContext(undefined)).toBeUndefined();
  });

  it("preserves the original draft when commit fails because storage rejects the write", () => {
    const storage = storageWith({ schemaVersion: 2, name: "Keep" });
    const original = storage.records.get(LOCAL_PROJECT_DRAFT_KEY);
    storage.setItem.mockImplementation(() => { throw new DOMException("Quota reached", "QuotaExceededError"); });
    expect(() => commitOpenedProject(storage, JSON.stringify({ schemaVersion: 2, name: "New" }), context())).toThrow(/Quota/);
    expect(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)).toBe(original);
  });

  it("preserves all project fields when updating only a source selection or reference", () => {
    const storage = storageWith({ schemaVersion: 2, currentTimeMa: 110, unknown: { payload: [1, 2] }, cloudContext: context() });
    updateProjectCloudContext(storage, "project-a", current => ({ ...current, selection: { ...current.selection, datasetVersionId: 4 } }));
    expect(JSON.parse(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)!)).toMatchObject({ currentTimeMa: 110, unknown: { payload: [1, 2] }, cloudContext: { selection: { datasetVersionId: 4 }, reference: { revisionId: 11 } } });
    expect(() => updateProjectCloudContext(storage, "project-b", current => current)).toThrow(/active project changed/i);
  });

  it("rejects corrupt, future and non-finite drafts without rewriting their original bytes", () => {
    for (const serialized of ["broken", '{"schemaVersion":3}', '{"schemaVersion":2,"unknown":1e400}']) {
      const storage = storageWith(serialized);
      expect(() => readProjectCloudContext(storage)).toThrow();
      expect(storage.records.get(LOCAL_PROJECT_DRAFT_KEY)).toBe(serialized); expect(storage.setItem).not.toHaveBeenCalled();
    }
  });
});
