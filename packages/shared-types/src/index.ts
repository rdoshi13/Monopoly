function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * Shared by both transports so the Node server and the Worker cannot drift.
 * A localhost configuration accepts any localhost port, which keeps local
 * development workable without loosening a production origin.
 */
export function isAllowedOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) return true;
  return isLocalOrigin(configuredOrigin) && isLocalOrigin(origin);
}

export type ModeId = "classic" | "monopol" | "run-down";

export interface MonopolyMode {
  WinningMode: "last-standing" | "monopols" | "monopols & trains";
  AllowDeals: boolean;
  Name: string;
  startingCash: number;
  mortageAllowed: boolean;
  turnTimer: number | undefined;
}

export interface PlayerProperty {
  posistion: number;
  count: 0 | 1 | 2 | 3 | 4 | "h";
  group: string;
  rent?: number;
  mortgaged?: boolean;
}

export interface GuestSession {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

export interface RoomPlayer {
  playerId: string;
  name: string;
  sessionToken: string;
  connected: boolean;
}

export interface RoomState {
  roomCode: string;
  hostPlayerId: string;
  players: Array<Pick<RoomPlayer, "playerId" | "name" | "connected">>;
  locked: boolean;
  turnDeadline?: number | null;
  /** Server clock at send time, so clients can offset an absolute deadline. */
  serverTime: number;
}

export interface WireMessage {
  event: string;
  payload?: unknown;
}
