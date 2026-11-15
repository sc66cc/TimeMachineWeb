import { describe, expect, it } from "vitest";
import { LOCAL_PROJECT_DRAFT_KEY, ProjectSession } from "../project/project-session";
import { commitOpenedProject, type ProjectCloudContext } from "../project/project-cloud-context";

const context = (contextId = "opened-project"): ProjectCloudContext => ({
  contextId, selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: true },
  reference: { accountEmail: "fixture@example.invalid", contentHash: "fixture", projectId: 1, revisionId: 2, revisionNumber: 1 },
});
const storage = () => {
  let data: string | null = null;
  return { getItem: () => data, setItem: (_key: string, value: string) => { data = value; } };
};

describe("project session cloud context ownership", () => {
  it("prepares the complete cloud compatibility baseline without saving or clearing dirty state", () => {
    const document = new ProjectSession("Original").toDocument();
    Object.assign(document, { FutureField: { value: "retained" } });
    const session = ProjectSession.fromDocument(document);
    session.setTime(110);
    const before = session.localSaveState;
    const prepared = session.serializeLocalDraft(new Date(0));
    expect(JSON.parse(prepared)).toMatchObject({ currentTimeMa: 110, cloudDocument: { FutureField: { value: "retained" } } });
    expect(session.localSaveState).toEqual(before);
    const target = storage(); commitOpenedProject(target, prepared, context());
    const restored = ProjectSession.restore(target)!;
    expect(restored.compatibilityReport).toMatchObject({ writable: true, cloudWritable: true });
    expect(restored.toDocument()).toMatchObject({ CurrentTimeMa: 110, FutureField: { value: "retained" } });
    expect(restored.toDocument()).not.toHaveProperty("cloudContext");
    expect(restored.toSnapshot()).not.toHaveProperty("cloudContext");
  });

  it("keeps a newer cloud revision when saving current local edits", () => {
    const target = storage(); commitOpenedProject(target, new ProjectSession().serializeLocalDraft(), context());
    const session = ProjectSession.restore(target)!;
    const latest = JSON.parse(target.getItem()!);
    latest.cloudContext.reference.revisionId = 3; latest.cloudContext.reference.revisionNumber = 2;
    target.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(latest));
    session.setTime(120); session.save(target);
    expect(JSON.parse(target.getItem()!)).toMatchObject({ currentTimeMa: 120, cloudContext: {
      contextId: "opened-project", reference: { revisionId: 3, revisionNumber: 2 },
    } });
    expect(session.localSaveState.status).toBe("saved");
  });

  it.each(["legacy-to-opened", "opened-to-other", "opened-to-legacy"])("rejects a stale %s session and preserves the active draft", transition => {
    const target = storage(); const initial = new ProjectSession().serializeLocalDraft();
    if (transition === "legacy-to-opened") target.setItem(LOCAL_PROJECT_DRAFT_KEY, initial);
    else commitOpenedProject(target, initial, context());
    const session = ProjectSession.restore(target)!;
    if (transition === "opened-to-legacy") target.setItem(LOCAL_PROJECT_DRAFT_KEY, initial);
    else commitOpenedProject(target, new ProjectSession("New project").serializeLocalDraft(), context("new-project"));
    const active = target.getItem(); session.setTime(125);
    expect(() => session.save(target)).toThrow(/active project changed/);
    expect(target.getItem()).toBe(active); expect(session.timeMa).toBe(125);
    expect(session.localSaveState.status).toBe("error");
  });

  it("rejects malformed local context and reserved metadata in cloud documents", () => {
    const target = storage();
    target.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify({ ...new ProjectSession().toSnapshot(), cloudContext: { contextId: "broken" } }));
    const before = target.getItem();
    expect(ProjectSession.restoreWithReport(target)).toMatchObject({ status: "invalid", compatibility: { writable: false } });
    expect(target.getItem()).toBe(before);
    const document = new ProjectSession().toDocument(); Object.assign(document, { cloudContext: context() });
    const imported = ProjectSession.fromDocument(document);
    expect(imported.isReadOnly).toBe(true);
    expect(() => imported.toDocument()).toThrow();
  });
});
