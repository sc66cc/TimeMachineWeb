import { AgentActionValidationError } from "../agent-actions/registry";

export interface SelectionKey {
  viewportId: string;
  layerId: number;
  featureId: string;
}
export type SelectionSource = "ui" | "api" | "runtime";
export interface SelectionSnapshot {
  key: SelectionKey | null;
  source: SelectionSource;
}

function checkedKey(key: SelectionKey): SelectionKey {
  if (!key || typeof key.viewportId !== "string" || !key.viewportId.trim() ||
      !Number.isSafeInteger(key.layerId) || key.layerId <= 0 ||
      typeof key.featureId !== "string" || !key.featureId.length) {
    throw new AgentActionValidationError("A selection needs a viewport, positive layer ID and nonempty feature ID.");
  }
  return { viewportId: key.viewportId, layerId: key.layerId, featureId: key.featureId };
}

/** One current selection shared by UI and API. Native/source owners stay private. */
export class FeatureSelection {
  private key: SelectionKey | null = null;
  private source: SelectionSource = "runtime";
  private owner: object | undefined;
  private generation = 0;

  constructor(private readonly onChange: (snapshot: SelectionSnapshot) => void = () => {}) {}

  snapshot(): SelectionSnapshot {
    return { key: this.key && { ...this.key }, source: this.source };
  }

  select(key: SelectionKey, source: SelectionSource, owner: object): void {
    const next = checkedKey(key);
    if (!owner || typeof owner !== "object") throw new AgentActionValidationError("Selection source owner is required.");
    this.generation++;
    this.commit(next, source, owner);
  }

  clear(source: SelectionSource = "runtime"): void {
    this.generation++;
    this.commit(null, source);
  }

  /** Also called when a committed camera/time/source changes during a pick. */
  invalidatePending(): void { this.generation++; }
  beginPick(): number { return ++this.generation; }

  commitPick(generation: number, key: SelectionKey | null, owner?: object): boolean {
    if (generation !== this.generation) return false;
    if (key) {
      if (!owner) throw new AgentActionValidationError("A picked feature needs its source owner.");
      this.select(key, "ui", owner);
    } else this.clear("ui");
    return true;
  }

  /** Same row/feature IDs in a new source must not inherit an old selection. */
  reconcile(resolveOwner: (key: SelectionKey) => object | undefined): boolean {
    if (!this.key) return false;
    const generation = this.generation;
    const owner = resolveOwner({ ...this.key });
    if (generation !== this.generation || owner === this.owner) return false;
    this.clear("runtime");
    return true;
  }

  private commit(key: SelectionKey | null, source: SelectionSource, owner?: object): void {
    const sameKey = key === null ? this.key === null : this.key !== null &&
      key.viewportId === this.key.viewportId && key.layerId === this.key.layerId && key.featureId === this.key.featureId;
    if (sameKey && this.source === source && this.owner === owner) return;
    this.key = key; this.source = source; this.owner = owner;
    this.onChange(this.snapshot());
  }
}
