import { AtlasTimeError, type AtlasTimePreparationOptions, type AtlasTimeTicket, type PaleoAtlasLayerController } from "@timemachine/raster-runtime";

export type AtlasTimeGroup = Pick<AtlasTimeTicket, "ready" | "activate" | "canConfirm" | "rollback" | "retire"> & { accept(): void };

/** Aggregate only the existing Atlas tickets; the viewport owns the actual frame. */
export function prepareAtlasTimeGroup(
  controllers: ReadonlyArray<Pick<PaleoAtlasLayerController, "prepareTime">>,
  ageMa: number,
  options: AtlasTimePreparationOptions,
): AtlasTimeGroup {
  const tickets: AtlasTimeTicket[] = [];
  const cleanup = (operation: "rollback" | "retire", failures: unknown[] = []): void => {
    for (const ticket of tickets) {
      try { ticket[operation](); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `Atlas group ${operation} failed.`);
  };
  try {
    for (const controller of controllers) {
      const ticket = controller.prepareTime(ageMa, options);
      tickets.push(ticket);
      // Partial allocation can reject an earlier ticket before the group exists.
      // Preserve its rejection for Promise.all while consuming that early branch.
      void ticket.ready.catch(() => undefined);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const ticket of tickets) {
      try { ticket.rollback(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Atlas group preparation and rollback failed.");
    throw error;
  }
  return {
    ready: Promise.all(tickets.map(ticket => ticket.ready)).then(() => undefined),
    activate() { for (const ticket of tickets) ticket.activate(); },
    canConfirm: () => tickets.every(ticket => ticket.canConfirm()),
    accept() {
      if (!tickets.every(ticket => ticket.canConfirm())) throw new AtlasTimeError("invalid", "Not every Atlas instance has confirmed its target frame.");
      // Native ticket acceptance is synchronous and has no observer callbacks.
      for (const ticket of tickets) ticket.accept();
    },
    rollback() { cleanup("rollback"); },
    retire() { cleanup("retire"); },
  };
}
