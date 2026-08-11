export type SalaryPresentation = {
  id: number;
  playerId: string;
  amount: 200;
  fromPosition: number;
  position: number;
  reason: "passed" | "advanced";
};

export function parseSalaryPresentation(payload: unknown, id: number): SalaryPresentation | null {
  const event = payload as Partial<Omit<SalaryPresentation, "id">> & { type?: unknown } | null;
  if (event?.type !== "salary" || typeof event.playerId !== "string" || event.amount !== 200 || !Number.isInteger(event.fromPosition) || !Number.isInteger(event.position) || (event.reason !== "passed" && event.reason !== "advanced")) return null;
  const fromPosition = Number(event.fromPosition);
  const position = Number(event.position);
  if (fromPosition < 0 || fromPosition >= 40 || position < 0 || position >= 40) return null;
  return { id, playerId: event.playerId, amount: 200, fromPosition, position, reason: event.reason };
}

export function removeSalaryPresentation(events: SalaryPresentation[], id: number): SalaryPresentation[] {
  return events.filter((event) => event.id !== id);
}

export function readySalaryPresentations(events: SalaryPresentation[], playersWithPendingMovement: ReadonlySet<string>): SalaryPresentation[] {
  return events.filter((event) => !playersWithPendingMovement.has(event.playerId));
}

export function matchingSalaryPresentationId(playerId: string, amount: number, events: SalaryPresentation[], consumedIds: ReadonlySet<number>): number | null {
  if (amount !== 200) return null;
  return events.find((event) => event.playerId === playerId && !consumedIds.has(event.id))?.id ?? null;
}
