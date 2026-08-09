import { io, type Socket as IoSocket } from "socket.io-client";
import type { WireMessage } from "@monopoly/shared-types";

type Handler = (payload: unknown) => void;

export interface GameSocket {
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: Handler): void;
  disconnect(): void;
}

class NativeSocket implements GameSocket {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Handler>();
  private queuedMessages: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      const queued = this.queuedMessages.splice(0);
      for (const message of queued) socket.send(message);
      this.handlers.get("socket:open")?.(undefined);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as WireMessage;
        if (message && typeof message.event === "string") this.handlers.get(message.event)?.(message.payload);
      } catch {
        this.handlers.get("socket:error")?.("Invalid message received from the server");
      }
    });
    socket.addEventListener("error", () => this.handlers.get("socket:error")?.("Unable to connect to the game server"));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.handlers.get("socket:close")?.(undefined);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });
  }

  emit(event: string, payload?: unknown) {
    const message = JSON.stringify({ event, payload });
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
    else this.queuedMessages.push(message);
  }

  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }

  disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.queuedMessages = [];
    this.socket?.close();
    this.socket = null;
  }
}

class SocketIoSocket implements GameSocket {
  constructor(private readonly socket: IoSocket) {}

  emit(event: string, payload?: unknown) {
    this.socket.emit(event, payload);
  }

  on(event: string, handler: Handler) {
    if (event === "socket:open") {
      this.socket.on("connect", () => handler(undefined));
      if (this.socket.connected) queueMicrotask(() => handler(undefined));
      return;
    }
    if (event === "socket:close") {
      this.socket.on("disconnect", () => handler(undefined));
      return;
    }
    if (event === "socket:error") {
      this.socket.on("connect_error", (error) => handler(error.message));
      return;
    }
    this.socket.on(event, handler);
  }

  disconnect() {
    this.socket.disconnect();
  }
}

/**
 * The Worker shards one Durable Object per room, so the room code must be on the
 * upgrade URL for the socket to reach the right room. The Socket.IO transport
 * routes by event instead and ignores it.
 */
export const createGameSocket = (roomCode: string): GameSocket => {
  const base = import.meta.env.VITE_SOCKET_BASE ?? "http://localhost:4000";
  return import.meta.env.VITE_SOCKET_TRANSPORT === "socketio"
    ? new SocketIoSocket(io(base))
    : new NativeSocket(`${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws?room=${encodeURIComponent(roomCode)}`);
};
