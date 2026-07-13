import { GameSnapshot } from "../gameEngine";
import { io } from "../sockets";
import { botInitial } from "../types";

/** A deliberately simple client bot; it never mutates local game state. */
export async function main(host: string, initials: botInitial) {
    const socket = await io(host);
    socket.on("game-state", (state: GameSnapshot) => {
        const me = state.players.find((player) => player.id === socket.id);
        if (!me) return;
        if (state.phase === "lobby" && !me.ready) socket.emit("action", { type: "ready", ready: true });
        if (state.currentPlayerId !== socket.id) return;
        if (state.phase === "awaiting-roll") socket.emit("action", { type: "roll" });
        if (state.phase === "awaiting-landing") socket.emit("action", { type: "landing", decision: "buy" });
    });
    socket.emit("name", initials.name);
}
