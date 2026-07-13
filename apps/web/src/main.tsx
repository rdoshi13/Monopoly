import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GuestSession, RoomState } from "@monopoly/shared-types";
import type { Card, GameAction, GameSnapshot } from "@monopoly/game-engine";
import { createGameSocket, type GameSocket } from "./socket";
import { GameView, LobbyView, type DiceResult, type GameEvent } from "./GameView";
import type { DrawnCardEvent } from "./GameCard";
import { playSound } from "./assets";
import "./styles.css";

const api = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";
const SESSION_KEY = "monopoly.session";

function readStoredSession(): GuestSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Partial<GuestSession> | null;
    if (value && typeof value.roomCode === "string" && typeof value.playerId === "string" && typeof value.sessionToken === "string") {
      return { roomCode: value.roomCode, playerId: value.playerId, sessionToken: value.sessionToken };
    }
  } catch {
    // Invalid local state is discarded below.
  }
  localStorage.removeItem(SESSION_KEY);
  return null;
}

function App() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<GuestSession | null>(readStoredSession);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [diceResults, setDiceResults] = useState<DiceResult[]>([]);
  const [drawnCard, setDrawnCard] = useState<DrawnCardEvent | null>(null);
  const eventSequence = useRef(0);
  const diceSequence = useRef(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const socket = useRef<GameSocket | null>(null);

  useEffect(() => {
    if (!session) return;

    setConnection("connecting");
    const client = createGameSocket();
    socket.current = client;
    client.on("socket:open", () => {
      setConnection("connected");
      setError("");
      client.emit("room:join", session);
    });
    client.on("socket:close", () => setConnection("disconnected"));
    client.on("socket:error", (payload) => {
      setConnection("disconnected");
      setError(typeof payload === "string" ? payload : "Unable to connect to the game server");
    });
    client.on("room:state", (payload) => setRoom(payload as RoomState));
    client.on("game:state", (payload) => {
      const snapshot = payload as GameSnapshot;
      setGame((previous) => {
        if (snapshot.winnerId && snapshot.winnerId !== previous?.winnerId) playSound("win");
        return snapshot;
      });
    });
    const record = (text: string) => setEvents((current) => [{ id: eventSequence.current++, text }, ...current].slice(0, 20));
    client.on("game:dice", (payload) => {
      const event = payload as { playerId?: unknown; dice?: unknown; fromPosition?: unknown; position?: unknown; moved?: unknown; fromJail?: unknown };
      if (typeof event.playerId !== "string" || !Array.isArray(event.dice) || event.dice.length !== 2 || !event.dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 6) || !Number.isInteger(event.fromPosition) || !Number.isInteger(event.position) || typeof event.moved !== "boolean" || typeof event.fromJail !== "boolean") return;
      const result: DiceResult = { id: diceSequence.current++, playerId: event.playerId, dice: [Number(event.dice[0]), Number(event.dice[1])], fromPosition: Number(event.fromPosition), position: Number(event.position), moved: event.moved, fromJail: event.fromJail };
      setDiceResults((current) => [...current, result]);
      playSound("roll");
      record(result.moved ? `A player rolled ${result.dice[0]} + ${result.dice[1]} and moved to space ${result.position}.` : `A player rolled ${result.dice[0]} + ${result.dice[1]}.`);
    });
    client.on("game:card", (payload) => {
      const event = payload as { playerId?: unknown; deck?: unknown; card?: Partial<Card> };
      if (typeof event.playerId === "string" && (event.deck === "chance" || event.deck === "communitychest") && typeof event.card?.title === "string" && typeof event.card.action === "string") {
        setDrawnCard({ playerId: event.playerId, deck: event.deck, card: event.card as Card });
        playSound(event.card.title.toLowerCase().includes("jail") ? "jail" : "card");
        record(event.card.title);
      }
    });
    client.on("game:history", (payload) => {
      const event = payload as { action?: unknown };
      if (typeof event?.action === "string") {
        if (event.action.includes("bought")) playSound("buy");
        else if (event.action.includes("bid") || event.action.includes("paid")) playSound("notification");
        record(event.action);
      }
    });
    client.on("game:message", (payload) => {
      const event = payload as { from?: unknown; message?: unknown };
      if (typeof event?.message === "string") record(`${typeof event.from === "string" ? event.from : "Player"}: ${event.message}`);
    });
    client.on("game:error", (payload) => {
      const problem = payload as { code?: unknown; message?: unknown };
      const message = typeof problem?.message === "string" ? problem.message : "Unable to connect to the room";
      setError(message);
      if (problem?.code === "AUTH_FAILED" || problem?.code === "ROOM_NOT_FOUND") {
        localStorage.removeItem(SESSION_KEY);
        setRoom(null);
        setGame(null);
        setSession(null);
      }
    });
    return () => {
      client.disconnect();
      if (socket.current === client) socket.current = null;
    };
  }, [session]);

  const useSession = (next: GuestSession) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setError("");
    setRoom(null);
    setGame(null);
    setEvents([]);
    setDiceResults([]);
    setDrawnCard(null);
    setSession(next);
  };

  const leaveRoom = () => {
    socket.current?.disconnect();
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setRoom(null);
    setGame(null);
    setEvents([]);
    setDiceResults([]);
    setDrawnCard(null);
    setConnection("disconnected");
    setError("");
  };

  const request = async (path: string, body: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as GuestSession | { error: string };
    if (!response.ok) throw new Error((payload as { error: string }).error);
    return payload as GuestSession;
  };

  const send = (action: GameAction) => socket.current?.emit("game:action", action);
  const onDicePresented = useCallback((id: number) => setDiceResults((current) => current.filter((result) => result.id !== id)), []);

  if (!session) {
    return <main className="entry-shell"><section className="entry-card">
      <span className="eyebrow">Authoritative multiplayer</span>
      <h1>Monopoly</h1>
      <p>Create a private room or join with a six-character code.</p>
      {error && <p role="alert">{error}</p>}
      <div className="entry-grid"><label>Your name<input placeholder="Your name" value={name} onChange={(event) => setName(event.target.value)} /></label><button className="primary" onClick={() => request("/rooms", { name }).then(useSession).catch((reason) => setError(reason.message))}>Create room</button><div className="join-row"><input aria-label="Room code" placeholder="Room code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} /><button onClick={() => request(`/rooms/${code}/join`, { name }).then(useSession).catch((reason) => setError(reason.message))}>Join room</button></div></div>
    </section></main>;
  }

  if (!room) {
    return <main className="entry-shell"><section className="entry-card">
      <h1>Monopoly</h1>
      <p>{error || (connection === "connecting" ? "Connecting to your room…" : "Reconnecting to your room…")}</p>
      <button onClick={leaveRoom}>Leave room / create another</button>
    </section></main>;
  }

  if (!game) return <main className="entry-shell"><section className="entry-card"><h1>Monopoly</h1><p>Synchronizing game state…</p><button onClick={leaveRoom}>Leave room</button></section></main>;
  if (game.phase === "lobby") return <LobbyView room={room} game={game} playerId={session.playerId} connection={connection} error={error} send={send} leaveRoom={leaveRoom} />;
  return <GameView room={room} game={game} playerId={session.playerId} connection={connection} error={error} events={events} diceResults={diceResults} onDicePresented={onDicePresented} drawnCard={drawnCard} dismissDrawnCard={() => setDrawnCard(null)} send={send} leaveRoom={leaveRoom} />;
}

createRoot(document.getElementById("root")!).render(<App />);
