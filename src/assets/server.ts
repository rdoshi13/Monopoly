import { GameEngine } from "./gameEngine";
import { Server, Socket } from "./sockets";

export interface HostSocket {
    id: string;
    on(event: string, handler: (args: unknown) => void): void;
    emit(event: string, args?: unknown): void;
    disconnect(): void;
}

export interface HostController {
    engine: GameEngine;
    attach(socket: HostSocket, log?: (message: string) => void): void;
}

/**
 * Transport-independent bridge between the authority engine and peer sockets.
 * Exported so protocol behavior can be tested without a live PeerJS connection.
 */
export function createHostController(playersCount: number, random?: () => number): HostController {
    const maxPlayers = Math.max(1, Math.min(Math.floor(playersCount) || 6, 6));
    const engine = new GameEngine(maxPlayers, random);
    const clients = new Map<string, HostSocket>();
    const broadcast = (event: string, args: unknown) => clients.forEach((socket) => socket.emit(event, args));

    engine.on((event) => {
        if (event.type === "state") broadcast("game-state", event.state);
        else if (event.type === "rejected") clients.get(event.playerId)?.emit("action-rejected", event.reason);
        else broadcast(`game-${event.type}`, event);
    });

    return {
        engine,
        attach(socket, log = () => undefined) {
            socket.emit("state", 0);
            socket.on("name", (name) => {
                clients.set(socket.id, socket);
                if (!engine.connect(socket.id, typeof name === "string" ? name : "")) {
                    clients.delete(socket.id);
                    socket.emit("state", 2);
                    socket.disconnect();
                }
            });
            socket.on("action", (action) => engine.handle(socket.id, action));
            socket.on("message", (message) => {
                if (typeof message !== "string") return;
                const player = engine.snapshot().players.find((candidate) => candidate.id === socket.id);
                if (player) broadcast("message", { from: player.username, message: message.slice(0, 500) });
            });
            socket.on("mouse", (position) => {
                if (!position || typeof position !== "object") return;
                const { x, y } = position as { x?: unknown; y?: unknown };
                if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
                    clients.forEach((client, id) => { if (id !== socket.id) client.emit("mouse", { id: socket.id, x, y }); });
                }
            });
            socket.on("disconnect", () => { clients.delete(socket.id); engine.disconnect(socket.id); });
            log(`Peer ${socket.id} connected`);
        },
    };
}

/** Starts the browser-hosted authority. Clients may only send name, action, chat, and cursor events. */
export async function main(playersCount: number, started?: (host: string, server: Server) => void) {
    const host = createHostController(playersCount);
    return new Server(
        (peer) => started?.(peer.code, peer),
        (socket: Socket, peer: Server) => host.attach(socket, (message) => peer.logFunction(message))
    );
}
