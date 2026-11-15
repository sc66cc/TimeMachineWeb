import type { CloudProjectReference, ResourceSelection } from "../phase1b/cloud-client";

export const LOCAL_PROJECT_DRAFT_KEY = "timemachine:web:phase1a-project";

export interface ProjectCloudContext {
  contextId: string;
  selection: ResourceSelection;
  reference?: CloudProjectReference;
}

export interface ProjectDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains an unsupported field.`);
}

function identifier(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function parseCloudProjectReference(value: unknown): CloudProjectReference {
  if (!record(value) || typeof value.accountEmail !== "string" || typeof value.contentHash !== "string" ||
    !identifier(value.projectId, 1) || !identifier(value.revisionId, 1) || !identifier(value.revisionNumber, 1)) {
    throw new Error("The cloud project reference is invalid.");
  }
  exactKeys(value, ["accountEmail", "contentHash", "projectId", "revisionId", "revisionNumber"], "The cloud project reference");
  return { accountEmail: value.accountEmail, contentHash: value.contentHash,
    projectId: value.projectId, revisionId: value.revisionId, revisionNumber: value.revisionNumber };
}

/** Undefined denotes the explicit legacy format; an invalid context never selects legacy keys. */
export function parseProjectCloudContext(value: unknown): ProjectCloudContext | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || typeof value.contextId !== "string" || !value.contextId.trim() || !record(value.selection)) {
    throw new Error("The project cloud context is invalid.");
  }
  exactKeys(value, ["contextId", "selection", "reference"], "The project cloud context");
  const selection = value.selection;
  exactKeys(selection, ["datasetVersionId", "plateModelId", "plateModelVersionId", "useLocalPlateModelDemo"], "The project resource selection");
  if (!identifier(selection.datasetVersionId, 0) || !identifier(selection.plateModelId, 0) ||
    !identifier(selection.plateModelVersionId, 0) || typeof selection.useLocalPlateModelDemo !== "boolean") {
    throw new Error("The project resource selection is invalid.");
  }
  if (Number(selection.plateModelId > 0) + Number(selection.plateModelVersionId > 0) + Number(selection.useLocalPlateModelDemo) > 1) {
    throw new Error("The project resource selection has conflicting plate model sources.");
  }
  return {
    contextId: value.contextId,
    selection: { datasetVersionId: selection.datasetVersionId, plateModelId: selection.plateModelId,
      plateModelVersionId: selection.plateModelVersionId, useLocalPlateModelDemo: selection.useLocalPlateModelDemo },
    ...(Object.hasOwn(value, "reference") ? { reference: parseCloudProjectReference(value.reference) } : {}),
  };
}

function parseDraft(serialized: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite project value.");
      return item;
    });
  } catch { throw new Error("The local project draft is not finite JSON."); }
  if (!record(value) || value.schemaVersion !== 2) throw new Error("The local project draft requires schema version 2.");
  return value;
}

function readDraft(storage: ProjectDraftStorage): Record<string, unknown> | undefined {
  const serialized = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
  return serialized === null ? undefined : parseDraft(serialized);
}

export function readProjectCloudContext(storage: ProjectDraftStorage): ProjectCloudContext | undefined {
  return parseProjectCloudContext(readDraft(storage)?.cloudContext);
}

/** Local edits retain the latest cloud revision while remaining bound to their original project. */
export function writeProjectDraft(storage: ProjectDraftStorage, serializedDraft: string, expectedContextId: string | undefined): void {
  const draft = parseDraft(serializedDraft);
  const context = readProjectCloudContext(storage);
  if (context?.contextId !== expectedContextId) throw new Error("The active project changed. Reload before saving this session.");
  delete draft.cloudContext;
  if (context) draft.cloudContext = context;
  storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
}

/** Cloud open commits the validated draft, source selection and reference in one storage write. */
export function commitOpenedProject(storage: ProjectDraftStorage, serializedDraft: string, context: ProjectCloudContext): void {
  const draft = parseDraft(serializedDraft);
  draft.cloudContext = parseProjectCloudContext(context)!;
  storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
}

/** Selection and revision updates preserve the current project contents. */
export function updateProjectCloudContext(
  storage: ProjectDraftStorage,
  expectedContextId: string,
  update: (context: ProjectCloudContext) => ProjectCloudContext,
): ProjectCloudContext {
  const draft = readDraft(storage);
  const context = parseProjectCloudContext(draft?.cloudContext);
  if (!draft || !context || context.contextId !== expectedContextId) throw new Error("The active project changed. Reload before updating its cloud context.");
  const next = parseProjectCloudContext(update(context))!;
  if (next.contextId !== expectedContextId) throw new Error("A project update cannot replace its context identity.");
  draft.cloudContext = next;
  storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(draft));
  return next;
}
