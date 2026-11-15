import { describe, expect, it, vi } from "vitest";
import { FeatureSelection, type SelectionKey } from "../layers/selection";

const key = (layerId = 103, featureId = "same", viewportId = "main"): SelectionKey => ({ viewportId, layerId, featureId });

describe("authoritative feature selection", () => {
  it("starts empty and keeps complete viewport/layer/feature identity", () => {
    const changes = vi.fn(), selection = new FeatureSelection(changes), source = {};
    expect(selection.snapshot()).toEqual({ key: null, source: "runtime" });
    selection.select(key(), "ui", source);
    expect(selection.snapshot()).toEqual({ key: key(), source: "ui" });
    selection.select(key(104), "api", source);
    expect(selection.snapshot().key?.layerId).toBe(104);
    selection.select(key(104, "same", "other"), "api", source);
    expect(selection.snapshot().key?.viewportId).toBe("other");
    expect(changes).toHaveBeenCalledTimes(3);
  });
  it("never shares mutable keys with callers or observers", () => {
    const input = key();
    const selection = new FeatureSelection(snapshot => { if (snapshot.key) snapshot.key.featureId = "observer mutation"; });
    selection.select(input, "api", {}); input.featureId = "caller mutation";
    const snapshot = selection.snapshot(); snapshot.key!.layerId = 99;
    expect(selection.snapshot().key).toEqual(key());
  });
  it("invalidates an old asynchronous pick on select and clear", () => {
    const selection = new FeatureSelection(), source = {};
    const pending = selection.beginPick(); selection.select(key(104), "api", source);
    expect(selection.commitPick(pending, key(), source)).toBe(false);
    expect(selection.snapshot().key).toEqual(key(104));
    const second = selection.beginPick(); selection.clear("api");
    expect(selection.commitPick(second, key(), source)).toBe(false);
    expect(selection.snapshot()).toEqual({ key: null, source: "api" });
  });
  it("only commits the newest pick, including a valid empty hit", () => {
    const selection = new FeatureSelection(), source = {};
    const old = selection.beginPick(), current = selection.beginPick();
    expect(selection.commitPick(old, key(), source)).toBe(false);
    expect(selection.commitPick(current, key(104), source)).toBe(true);
    expect(selection.commitPick(current, key(105), source)).toBe(false);
    const empty = selection.beginPick();
    expect(selection.commitPick(empty, null)).toBe(true);
    expect(selection.snapshot()).toEqual({ key: null, source: "ui" });
  });
  it("does not keep a selected row when its layer source generation changes", () => {
    const changes = vi.fn(), selection = new FeatureSelection(changes), source = {}, replacement = {};
    selection.select(key(), "ui", source);
    expect(selection.reconcile(candidate => candidate.layerId === 103 ? source : undefined)).toBe(false);
    expect(selection.reconcile(() => replacement)).toBe(true);
    expect(selection.snapshot()).toEqual({ key: null, source: "runtime" });
    expect(changes).toHaveBeenCalledTimes(2);
  });
  it("clears removal and cancels pending pick even if already empty", () => {
    const selection = new FeatureSelection(), source = {};
    selection.select(key(), "api", source);
    expect(selection.reconcile(() => undefined)).toBe(true);
    const pending = selection.beginPick(); selection.invalidatePending();
    expect(selection.commitPick(pending, key(), source)).toBe(false);
    expect(selection.snapshot().key).toBeNull();
  });
  it("does not overwrite a newer selection made during reconciliation", () => {
    const selection = new FeatureSelection(), source = {};
    selection.select(key(), "ui", source);
    expect(selection.reconcile(() => { selection.select(key(104), "api", source); return undefined; })).toBe(false);
    expect(selection.snapshot().key).toEqual(key(104));
  });
  it("does not publish no-op selection but still invalidates older picks", () => {
    const changes = vi.fn(), selection = new FeatureSelection(changes), source = {};
    selection.select(key(), "api", source); const pending = selection.beginPick();
    selection.select(key(), "api", source);
    expect(selection.commitPick(pending, null)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    selection.select(key(), "ui", source);
    expect(changes).toHaveBeenCalledTimes(2);
  });
  it.each([key(0), key(1.5), key(103, ""), key(103, "same", "")])("rejects invalid identity without replacing a valid selection", invalid => {
    const selection = new FeatureSelection(), source = {};
    selection.select(key(), "api", source);
    expect(() => selection.select(invalid, "api", source)).toThrow();
    expect(selection.snapshot().key).toEqual(key());
  });
});
