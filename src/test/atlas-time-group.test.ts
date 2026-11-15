import { describe, expect, it, vi } from "vitest";
import type { AtlasTimePreparationOptions, AtlasTimeTicket } from "@timemachine/raster-runtime";
import { prepareAtlasTimeGroup } from "../layers/atlas-time-group";

function participant(name: string, events: string[]) {
  let readyResolve!: () => void;
  const ticket: AtlasTimeTicket = {
    owner: {}, generation: 1, requestedAgeMa: 20,
    ready: new Promise<void>(resolve => { readyResolve = resolve; }),
    activate: vi.fn(() => { events.push(`${name}:activate`); }),
    canConfirm: vi.fn(() => true),
    accept: vi.fn(() => { events.push(`${name}:accept`); return { status: "ready" as const, requestedAgeMa: 20, generation: 1, actualFrameAgeMa: 20, sourceId: name }; }),
    rollback: vi.fn(() => { events.push(`${name}:rollback`); }),
    retire: vi.fn(() => { events.push(`${name}:retire`); }),
  };
  const controller = { prepareTime: vi.fn((_age: number, _options: AtlasTimePreparationOptions) => { events.push(`${name}:prepare`); return ticket; }) };
  return { controller, ticket, readyResolve };
}
const options = () => ({ owner: {}, signal: new AbortController().signal });

describe("Atlas instance time group", () => {
  it("prepares every independent owner and waits for all, then activates/accepts/retires in one stack", async () => {
    const events: string[] = [];
    const a = participant("a", events), b = participant("b", events);
    const context = options();
    const group = prepareAtlasTimeGroup([a.controller, b.controller], 20, context);
    let ready = false;
    void group.ready.then(() => { ready = true; });
    a.readyResolve(); await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    b.readyResolve(); await group.ready;
    expect(a.controller.prepareTime).toHaveBeenCalledWith(20, context);
    expect(b.controller.prepareTime).toHaveBeenCalledWith(20, context);
    group.activate(); expect(group.canConfirm()).toBe(true); group.accept(); group.retire();
    expect(events).toEqual(["a:prepare", "b:prepare", "a:activate", "b:activate", "a:accept", "b:accept", "a:retire", "b:retire"]);
  });

  it("cannot accept any owner until every participant confirms its frame", () => {
    const events: string[] = [];
    const a = participant("a", events), b = participant("b", events);
    vi.mocked(b.ticket.canConfirm).mockReturnValue(false);
    const group = prepareAtlasTimeGroup([a.controller, b.controller], 20, options());
    expect(group.canConfirm()).toBe(false);
    expect(() => group.accept()).toThrow(/confirmed/);
    expect(a.ticket.accept).not.toHaveBeenCalled(); expect(b.ticket.accept).not.toHaveBeenCalled();
  });

  it("rolls back earlier tickets if a later preparation throws", () => {
    const events: string[] = [];
    const a = participant("a", events), b = participant("b", events);
    const failure = new Error("second native owner unavailable");
    b.controller.prepareTime.mockImplementation(() => { throw failure; });
    expect(() => prepareAtlasTimeGroup([a.controller, b.controller], 20, options())).toThrow(failure);
    expect(a.ticket.rollback).toHaveBeenCalledTimes(1);
    expect(a.ticket.accept).not.toHaveBeenCalled();
  });

  it("keeps preparation and cleanup errors when partial allocation rollback fails", () => {
    const events: string[] = [];
    const a = participant("a", events), b = participant("b", events);
    const failure = new Error("prepare"), cleanup = new Error("release");
    b.controller.prepareTime.mockImplementation(() => { throw failure; });
    vi.mocked(a.ticket.rollback).mockImplementation(() => { throw cleanup; });
    try { prepareAtlasTimeGroup([a.controller, b.controller], 20, options()); expect.fail("must reject"); }
    catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([failure, cleanup]); }
  });

  for (const operation of ["rollback", "retire"] as const) {
    it(`attempts every ${operation} despite the first native cleanup failure`, () => {
      const events: string[] = [];
      const a = participant("a", events), b = participant("b", events);
      const failure = new Error("first cleanup");
      vi.mocked(a.ticket[operation]).mockImplementation(() => { throw failure; });
      const group = prepareAtlasTimeGroup([a.controller, b.controller], 20, options());
      expect(() => group[operation]()).toThrow(AggregateError);
      expect(b.ticket[operation]).toHaveBeenCalledTimes(1);
    });
  }

  it("a failed readiness remains a rejection and the owner can roll every ticket back", async () => {
    const events: string[] = [];
    const a = participant("a", events), b = participant("b", events);
    const failure = new Error("tiles unavailable");
    Object.assign(b.ticket, { ready: Promise.reject(failure) });
    const group = prepareAtlasTimeGroup([a.controller, b.controller], 20, options());
    a.readyResolve(); await expect(group.ready).rejects.toBe(failure);
    group.rollback(); expect(events.slice(-2)).toEqual(["a:rollback", "b:rollback"]);
  });

  it("an empty set creates no fake native work", async () => {
    const group = prepareAtlasTimeGroup([], 20, options());
    await group.ready; expect(group.canConfirm()).toBe(true);
    group.activate(); group.accept(); group.rollback(); group.retire();
  });
});
