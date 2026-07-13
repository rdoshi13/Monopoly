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
}

export interface WireMessage {
  event: string;
  payload?: unknown;
}
