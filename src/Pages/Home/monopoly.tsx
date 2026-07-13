import { useEffect, useMemo, useState } from "react";
import { Server, Socket } from "../../assets/sockets";
import { Card, GameAction, GameSnapshot, ModeId, TradeOffer } from "../../assets/gameEngine";
import monopolyJSON from "../../assets/monopoly.json";
import "../../monopoly.css";

const modes: Array<[ModeId, string]> = [["classic", "Classic"], ["monopol", "Monopol"], ["run-down", "Run-Down"]];

function togglePosition(positions: number[], position: number) {
    return positions.includes(position) ? positions.filter((candidate) => candidate !== position) : [...positions, position];
}

function action(socket: Socket, value: GameAction) {
    socket.emit("action", value);
}

function offerSummary(offer: TradeOffer, names: Map<number, string>) {
    const properties = (positions: number[]) => positions.length ? positions.map((position) => names.get(position) ?? `Space ${position}`).join(", ") : "no properties";
    return `Offers $${offer.offeredCash} and ${properties(offer.offeredPositions)} for $${offer.requestedCash} and ${properties(offer.requestedPositions)}`;
}

export default function Monopoly({ socket, name, server }: { socket: Socket; name: string; server?: Server }) {
    const [state, setState] = useState<GameSnapshot>();
    const [error, setError] = useState("");
    const [events, setEvents] = useState<string[]>([]);
    const [tradeTo, setTradeTo] = useState("");
    const [offeredPositions, setOfferedPositions] = useState<number[]>([]);
    const [requestedPositions, setRequestedPositions] = useState<number[]>([]);
    const [offeredCash, setOfferedCash] = useState(0);
    const [requestedCash, setRequestedCash] = useState(0);
    const propertyNames = useMemo(() => new Map(monopolyJSON.properties.map((property) => [property.posistion, property.name])), []);

    useEffect(() => {
        const record = (message: string) => setEvents((previous) => [message, ...previous].slice(0, 8));
        socket.on("game-state", (next: GameSnapshot) => setState(next));
        socket.on("action-rejected", (reason: string) => setError(reason));
        socket.on("game-dice", (event: { playerId: string; dice: [number, number]; position: number }) => record(`${event.playerId} rolled ${event.dice[0]} + ${event.dice[1]} and moved to ${event.position}`));
        socket.on("game-card", (event: { playerId: string; card: Card }) => record(`${event.playerId} drew: ${event.card.title}`));
        socket.on("game-history", (event: { action: string }) => record(event.action));
        socket.emit("name", name);
        if (server) server.RenderLogs(() => undefined);
    }, [socket, name, server]);

    if (!state) return <main className="monopoly"><p>Connecting to the host…</p></main>;
    const me = state.players.find((player) => player.id === socket.id);
    const opponent = state.players.find((player) => player.id === tradeTo);
    const myTurn = state.currentPlayerId === socket.id;
    const canTrade = myTurn && state.phase === "awaiting-roll" && state.selectedMode.AllowDeals && !state.pendingTrade;
    const send = (next: GameAction) => { setError(""); action(socket, next); };
    const submitTrade = () => {
        if (!tradeTo) return setError("Choose a player to trade with");
        send({ type: "trade-propose", to: tradeTo, offeredPositions, requestedPositions, offeredCash, requestedCash });
        setOfferedPositions([]);
        setRequestedPositions([]);
        setOfferedCash(0);
        setRequestedCash(0);
    };

    return (
        <main className="monopoly">
            <header><h1>Monopoly</h1><p>{state.phase.replace("-", " ")}</p></header>
            {error && <p role="alert">{error}</p>}
            {state.winnerId && <h2>{state.winnerId === socket.id ? "You won!" : `${state.players.find((player) => player.id === state.winnerId)?.username ?? "A player"} won!`}</h2>}
            <section>
                <h2>Players</h2>
                <ul>{state.players.map((player) => <li key={player.id}>{player.username}: ${player.balance} — space {player.position}{player.isInJail ? " (in jail)" : ""}</li>)}</ul>
            </section>
            {state.phase === "lobby" && <section>
                <h2>Lobby</h2>
                {state.lobbyHostId === socket.id && modes.map(([id, label]) => <button key={id} disabled={state.modeId === id} onClick={() => send({ type: "select-mode", modeId: id })}>{label}</button>)}
                <button onClick={() => send({ type: "ready", ready: !me?.ready })}>{me?.ready ? "Not ready" : "Ready"}</button>
                <p>Two ready players are required to start.</p>
            </section>}
            {state.phase !== "lobby" && state.phase !== "finished" && <section>
                <h2>{myTurn ? "Your turn" : `${state.players.find((player) => player.id === state.currentPlayerId)?.username ?? "Player"}'s turn`}</h2>
                {myTurn && state.phase === "awaiting-roll" && <>
                    {me?.isInJail && <><button onClick={() => send({ type: "unjail", option: "pay" })}>Pay $50 to leave jail</button>{me.getoutCards > 0 && <button onClick={() => send({ type: "unjail", option: "card" })}>Use jail card</button>}</>}
                    <button onClick={() => send({ type: "roll" })}>Roll dice</button>
                </>}
                {myTurn && state.phase === "awaiting-landing" && <><button onClick={() => send({ type: "landing", decision: "buy" })}>Buy property</button><button onClick={() => send({ type: "landing", decision: "skip" })}>Skip</button></>}
            </section>}
            <section>
                <h2>Your properties</h2>
                <ul>{me?.properties.map((property) => <li key={property.posistion}>
                    {propertyNames.get(property.posistion) ?? property.posistion} — {property.count === "h" ? "hotel" : `${property.count} houses`}{property.mortgaged ? " (mortgaged)" : ""}
                    {myTurn && state.phase === "awaiting-roll" && <><button onClick={() => send({ type: "build", position: property.posistion })}>Build</button>{property.mortgaged ? <button onClick={() => send({ type: "unmortgage", position: property.posistion })}>Unmortgage</button> : <button onClick={() => send({ type: "mortgage", position: property.posistion })}>Mortgage</button>}</>}
                </li>)}</ul>
            </section>
            {canTrade && <section>
                <h2>Propose trade</h2>
                <label>Player <select value={tradeTo} onChange={(event) => { setTradeTo(event.target.value); setRequestedPositions([]); }}><option value="">Choose player</option>{state.players.filter((player) => player.id !== socket.id).map((player) => <option key={player.id} value={player.id}>{player.username}</option>)}</select></label>
                <label>Your cash <input type="number" min="0" value={offeredCash} onChange={(event) => setOfferedCash(Math.max(0, Number(event.target.value) || 0))} /></label>
                <label>Their cash <input type="number" min="0" value={requestedCash} onChange={(event) => setRequestedCash(Math.max(0, Number(event.target.value) || 0))} /></label>
                <p>You offer</p><ul>{me?.properties.map((property) => <li key={property.posistion}><label><input type="checkbox" checked={offeredPositions.includes(property.posistion)} onChange={() => setOfferedPositions((positions) => togglePosition(positions, property.posistion))} />{propertyNames.get(property.posistion) ?? property.posistion}</label></li>)}</ul>
                {opponent && <><p>You request</p><ul>{opponent.properties.map((property) => <li key={property.posistion}><label><input type="checkbox" checked={requestedPositions.includes(property.posistion)} onChange={() => setRequestedPositions((positions) => togglePosition(positions, property.posistion))} />{propertyNames.get(property.posistion) ?? property.posistion}</label></li>)}</ul></>}
                <button onClick={submitTrade}>Send trade offer</button>
            </section>}
            {state.pendingTrade && <section>
                <h2>Pending trade</h2>
                <p>{offerSummary(state.pendingTrade, propertyNames)}</p>
                {state.pendingTrade.to === socket.id && <><button onClick={() => send({ type: "trade-accept" })}>Accept</button><button onClick={() => send({ type: "trade-reject" })}>Reject</button></>}
                {state.pendingTrade.from === socket.id && <button onClick={() => send({ type: "trade-cancel" })}>Cancel offer</button>}
            </section>}
            <section aria-live="polite"><h2>Game events</h2><ul>{events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}</ul></section>
        </main>
    );
}
