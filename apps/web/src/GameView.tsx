import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { boardSpaces, type GameAction, type GameSnapshot, type TradeOffer } from "@monopoly/game-engine";
import type { RoomState } from "@monopoly/shared-types";
import { playerTokens } from "./assets";
import { PropertyCardModal } from "./PropertyCard";
import { GameCardModal, type DrawnCardEvent } from "./GameCard";
import { CodedBoard } from "./CodedBoard";

type SendAction = (action: GameAction) => void;
export type GameEvent = { id: number; text: string };
export type DiceResult = { id: number; playerId: string; dice: [number, number]; fromPosition: number; position: number; moved: boolean; fromJail: boolean };

type RollPhase = "rolling" | "result" | "double" | "moving";
type RollPresentation = { result: DiceResult; phase: RollPhase; faces: [number, number]; position: number; isInJail: boolean };

const spaceByPosition = new Map(boardSpaces.map((space) => [space.posistion, space]));
const propertyName = (position: number) => spaceByPosition.get(position)?.name ?? `Space ${position}`;
const playerColors = ["#d43f3f", "#315dc4", "#2c9763", "#d18a22", "#7442a5", "#292d32"];
const playerColor = (icon: number) => playerColors[icon] ?? playerColors[0];

const dieFaces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function DiceDisplay({ result, playerName, presentation }: { result: DiceResult; playerName: string; presentation: RollPresentation | null }) {
  const rolling = presentation?.result.id === result.id && presentation.phase === "rolling";
  const faces = rolling ? presentation.faces : result.dice;
  return <div className={`dice-result${rolling ? " rolling" : ""}`} aria-live="polite" aria-label={rolling ? `${playerName} is rolling the dice` : `${playerName} rolled ${result.dice[0]} and ${result.dice[1]}`}>
    <span>{rolling ? `${playerName} is rolling…` : `${playerName} rolled`}</span>
    <div className="dice-pair" aria-hidden="true"><i>{dieFaces[faces[0]]}</i><i>{dieFaces[faces[1]]}</i></div>
    <strong>{rolling ? "Wait for it…" : `Total ${result.dice[0] + result.dice[1]}`}</strong>
  </div>;
}

function TradePanel({ game, playerId, send, interactionLocked }: { game: GameSnapshot; playerId: string; send: SendAction; interactionLocked: boolean }) {
  const me = game.players.find((player) => player.id === playerId);
  const [tradeTo, setTradeTo] = useState("");
  const [offeredCash, setOfferedCash] = useState(0);
  const [requestedCash, setRequestedCash] = useState(0);
  const [offeredPositions, setOfferedPositions] = useState<number[]>([]);
  const [requestedPositions, setRequestedPositions] = useState<number[]>([]);
  const recipient = game.players.find((player) => player.id === tradeTo);
  const canPropose = !interactionLocked && game.currentPlayerId === playerId && game.phase === "awaiting-roll" && game.selectedMode.AllowDeals && !game.pendingTrade;
  const toggle = (values: number[], position: number) => values.includes(position) ? values.filter((value) => value !== position) : [...values, position];
  const summary = (offer: TradeOffer) => `${game.players.find((player) => player.id === offer.from)?.username ?? "Player"} offers $${offer.offeredCash}${offer.offeredPositions.length ? ` and ${offer.offeredPositions.map(propertyName).join(", ")}` : ""} for $${offer.requestedCash}${offer.requestedPositions.length ? ` and ${offer.requestedPositions.map(propertyName).join(", ")}` : ""}.`;

  return <section className="panel trade-panel">
    <h3>Trades</h3>
    {game.pendingTrade ? <>
      <p>{summary(game.pendingTrade)}</p>
      <div className="actions">
        {game.pendingTrade.to === playerId && <><button onClick={() => send({ type: "trade-accept" })}>Accept trade</button><button className="secondary" onClick={() => send({ type: "trade-reject" })}>Reject</button></>}
        {game.pendingTrade.from === playerId && <button className="secondary" onClick={() => send({ type: "trade-cancel" })}>Cancel offer</button>}
      </div>
    </> : canPropose ? <>
      <label>Trade with<select value={tradeTo} onChange={(event) => { setTradeTo(event.target.value); setRequestedPositions([]); }}><option value="">Choose player</option>{game.players.filter((player) => player.id !== playerId).map((player) => <option value={player.id} key={player.id}>{player.username}</option>)}</select></label>
      <div className="cash-grid"><label>You offer<input type="number" min="0" value={offeredCash} onChange={(event) => setOfferedCash(Math.max(0, Math.floor(Number(event.target.value) || 0)))} /></label><label>You request<input type="number" min="0" value={requestedCash} onChange={(event) => setRequestedCash(Math.max(0, Math.floor(Number(event.target.value) || 0)))} /></label></div>
      <div className="trade-properties"><fieldset><legend>Your properties</legend>{me?.properties.length ? me.properties.map((property) => <label key={property.posistion}><input type="checkbox" checked={offeredPositions.includes(property.posistion)} onChange={() => setOfferedPositions((values) => toggle(values, property.posistion))} />{propertyName(property.posistion)}</label>) : <small>None</small>}</fieldset><fieldset><legend>Their properties</legend>{recipient?.properties.length ? recipient.properties.map((property) => <label key={property.posistion}><input type="checkbox" checked={requestedPositions.includes(property.posistion)} onChange={() => setRequestedPositions((values) => toggle(values, property.posistion))} />{propertyName(property.posistion)}</label>) : <small>{recipient ? "None" : "Choose a player"}</small>}</fieldset></div>
      <button disabled={!tradeTo} onClick={() => { if (!tradeTo) return; send({ type: "trade-propose", to: tradeTo, offeredPositions, requestedPositions, offeredCash, requestedCash }); }}>Send offer</button>
    </> : <p className="muted">{game.selectedMode.AllowDeals ? "Trades can be proposed at the start of your turn." : "Trades are disabled in this mode."}</p>}
  </section>;
}

export function GameView({ room, game, playerId, connection, error, events, diceResults, onDicePresented, drawnCard, dismissDrawnCard, send, leaveRoom }: { room: RoomState; game: GameSnapshot; playerId: string; connection: string; error: string; events: GameEvent[]; diceResults: DiceResult[]; onDicePresented: (id: number) => void; drawnCard: DrawnCardEvent | null; dismissDrawnCard: () => void; send: SendAction; leaveRoom: () => void }) {
  const [, tick] = useState(0);
  const [auctionBid, setAuctionBid] = useState(1);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const [selectedPropertyPosition, setSelectedPropertyPosition] = useState<number | null>(null);
  const [rollPresentation, setRollPresentation] = useState<RollPresentation | null>(null);
  const [lastDiceResult, setLastDiceResult] = useState<DiceResult | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const closePropertyCard = useCallback(() => setSelectedPropertyPosition(null), []);
  const highlightPlayer = useCallback((selectedPlayerId: string) => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    setHighlightedPlayerId(selectedPlayerId);
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedPlayerId(null);
      highlightTimer.current = null;
    }, 3000);
  }, []);
  useEffect(() => { if (!room.turnDeadline) return; const timer = setInterval(() => tick((value) => value + 1), 1000); return () => clearInterval(timer); }, [room.turnDeadline]);
  useEffect(() => () => { if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current); }, []);
  const activeDiceResult = diceResults[0] ?? null;
  useLayoutEffect(() => {
    if (!activeDiceResult) return;
    let cancelled = false;
    const timeouts: Array<{ id: number; resolve: () => void }> = [];
    const wait = (duration: number) => new Promise<void>((resolve) => timeouts.push({ id: window.setTimeout(resolve, duration), resolve }));
    const rollingInterval = window.setInterval(() => {
      setRollPresentation((current) => current?.result.id === activeDiceResult.id ? { ...current, faces: [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1] } : current);
    }, 85);

    setRollPresentation({ result: activeDiceResult, phase: "rolling", faces: [1, 6], position: activeDiceResult.fromPosition, isInJail: activeDiceResult.fromJail });
    void (async () => {
      await wait(850);
      window.clearInterval(rollingInterval);
      if (cancelled) return;
      setLastDiceResult(activeDiceResult);
      setRollPresentation((current) => current?.result.id === activeDiceResult.id ? { ...current, phase: "result", faces: activeDiceResult.dice } : current);
      await wait(700);
      if (cancelled) return;

      if (activeDiceResult.dice[0] === activeDiceResult.dice[1]) {
        setRollPresentation((current) => current?.result.id === activeDiceResult.id ? { ...current, phase: "double" } : current);
        await wait(950);
        if (cancelled) return;
      }

      if (activeDiceResult.moved) {
        setRollPresentation((current) => current?.result.id === activeDiceResult.id ? { ...current, phase: "moving", isInJail: false } : current);
        const steps = activeDiceResult.dice[0] + activeDiceResult.dice[1];
        for (let step = 1; step <= steps; step += 1) {
          setRollPresentation((current) => current?.result.id === activeDiceResult.id ? { ...current, position: (activeDiceResult.fromPosition + step) % 40 } : current);
          await wait(190);
          if (cancelled) return;
        }
      }

      await wait(260);
      if (cancelled) return;
      setRollPresentation(null);
      onDicePresented(activeDiceResult.id);
    })();

    return () => {
      cancelled = true;
      window.clearInterval(rollingInterval);
      timeouts.forEach((timeout) => { window.clearTimeout(timeout.id); timeout.resolve(); });
    };
  }, [activeDiceResult, onDicePresented]);
  const me = game.players.find((player) => player.id === playerId);
  const current = game.players.find((player) => player.id === game.currentPlayerId);
  const myTurn = current?.id === playerId;
  const auctionSpace = game.pendingAuction ? spaceByPosition.get(game.pendingAuction.position) : undefined;
  const passedAuction = game.pendingAuction?.passedPlayerIds.includes(playerId) ?? false;
  const winner = game.players.find((player) => player.id === game.winnerId);
  const secondsLeft = room.turnDeadline ? Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000)) : null;
  const playersWithConnection = game.players.map((player) => ({ ...player, connected: room.players.find((candidate) => candidate.playerId === player.id)?.connected ?? false }));
  const presentationBusy = rollPresentation !== null || diceResults.length > 0;
  const landingPropertyPosition = game.phase === "awaiting-landing" ? game.pendingLanding?.position ?? null : null;
  const displayedPropertyPosition = presentationBusy ? null : landingPropertyPosition ?? selectedPropertyPosition;
  const selectedPropertySpace = displayedPropertyPosition === null ? undefined : spaceByPosition.get(displayedPropertyPosition);
  const selectedPropertyOwner = displayedPropertyPosition === null ? undefined : game.players.find((player) => player.properties.some((property) => property.posistion === displayedPropertyPosition));
  const selectedPropertyState = selectedPropertyOwner?.properties.find((property) => property.posistion === displayedPropertyPosition);
  const displayedDiceResult = activeDiceResult ?? lastDiceResult;
  const dicePlayerName = game.players.find((player) => player.id === displayedDiceResult?.playerId)?.username ?? "Player";
  const cardPlayerName = game.players.find((player) => player.id === drawnCard?.playerId)?.username ?? "Player";
  const rollingPlayerName = game.players.find((player) => player.id === rollPresentation?.result.playerId)?.username ?? "Player";

  return <main className="game-shell">
    <header className="game-header"><div><span className="eyebrow">Room {room.roomCode}</span><h1>Monopoly</h1></div><div className="status"><span className={`connection ${connection}`}>{connection}</span>{secondsLeft !== null && <span>{secondsLeft}s left</span>}<button className="text-button" onClick={leaveRoom}>Leave</button></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    {winner && <section className="winner"><span className="eyebrow">Winner</span><h2>{winner.id === playerId ? "You won!" : `${winner.username} won!`}</h2></section>}
    <div className="game-layout">
      <CodedBoard game={game} highlightedPlayerId={highlightedPlayerId} animatedToken={rollPresentation ? { playerId: rollPresentation.result.playerId, position: rollPresentation.position, isInJail: rollPresentation.isInJail, moving: rollPresentation.phase === "moving" } : null} onSelectProperty={setSelectedPropertyPosition} playerColor={playerColor} propertyName={propertyName} />
      <aside className="sidebar">
        <section className="panel turn-panel">
          <span className="eyebrow">{game.phase === "awaiting-auction" ? "Property auction" : "Current turn"}</span>
          <h2>{rollPresentation ? rollPresentation.result.playerId === playerId ? "You're rolling" : `${rollingPlayerName} is rolling` : game.phase === "awaiting-auction" ? auctionSpace?.name ?? "Auction" : myTurn ? "Your turn" : current?.username ?? "Waiting"}</h2>
          {displayedDiceResult && <DiceDisplay result={displayedDiceResult} playerName={dicePlayerName} presentation={rollPresentation} />}
          {game.pausedPlayerId && <p>Paused while {game.players.find((player) => player.id === game.pausedPlayerId)?.username ?? "a player"} reconnects.</p>}
          {!presentationBusy && myTurn && game.phase === "awaiting-roll" && <div className="actions">{me?.isInJail && <><button onClick={() => send({ type: "unjail", option: "pay" })}>Pay $50</button>{me.getoutCards > 0 && <button onClick={() => send({ type: "unjail", option: "card" })}>Use jail card</button>}</>}<button className="primary" onClick={() => send({ type: "roll" })}>Roll dice</button></div>}
          {game.phase === "awaiting-auction" && game.pendingAuction && <><p>Highest bid: <strong>${game.pendingAuction.highestBid}</strong>{game.pendingAuction.highestBidderId ? ` by ${game.players.find((player) => player.id === game.pendingAuction?.highestBidderId)?.username ?? "player"}` : ""}</p>{passedAuction ? <p className="muted">You passed. Waiting for the remaining bidders.</p> : <div className="actions"><input aria-label="Auction bid" type="number" min={game.pendingAuction.highestBid + 1} max={me?.balance} value={auctionBid} onChange={(event) => setAuctionBid(Math.max(1, Math.floor(Number(event.target.value) || 1)))} /><button className="primary" onClick={() => send({ type: "auction-bid", amount: auctionBid })}>Bid</button><button className="secondary" onClick={() => send({ type: "auction-pass" })}>Pass</button></div>}</>}
        </section>
        <section className="panel"><h3>Players</h3><div className="players">{playersWithConnection.map((player) => <button type="button" className={`player-card player-card-button ${player.id === game.currentPlayerId ? "active" : ""}${player.id === highlightedPlayerId ? " selected" : ""}`} style={{ "--player-color": playerColor(player.icon) } as React.CSSProperties} aria-label={`Highlight ${player.username} on the board for 3 seconds`} aria-pressed={player.id === highlightedPlayerId} onClick={() => highlightPlayer(player.id)} key={player.id}><span className={`token token-${player.icon}`}><img src={playerTokens[player.icon] ?? playerTokens[0]} alt="" /></span><span><strong>{player.username}{player.id === playerId ? " (you)" : ""}</strong><small>${player.balance} · {propertyName(player.position)}{player.isInJail ? " · Jail" : ""}</small></span><i className={player.connected ? "online" : "offline"} /></button>)}</div></section>
        <section className="panel"><h3>Your properties</h3>{me?.properties.length ? <ul className="property-list">{me.properties.map((property) => <li key={property.posistion}><span><strong>{propertyName(property.posistion)}</strong><small>{property.count === "h" ? "Hotel" : `${property.count} houses`}{property.mortgaged ? " · Mortgaged" : ""}</small></span>{!presentationBusy && myTurn && game.phase === "awaiting-roll" && <span className="mini-actions"><button onClick={() => send({ type: "build", position: property.posistion })}>Build</button>{property.count !== 0 && <button onClick={() => send({ type: "sell-building", position: property.posistion })}>Sell</button>}<button onClick={() => send({ type: property.mortgaged ? "unmortgage" : "mortgage", position: property.posistion })}>{property.mortgaged ? "Redeem" : "Mortgage"}</button></span>}</li>)}</ul> : <p className="muted">No properties yet.</p>}<small className="muted">Bank: {game.bankSupply.houses} houses · {game.bankSupply.hotels} hotels</small></section>
        <TradePanel game={game} playerId={playerId} send={send} interactionLocked={presentationBusy} />
        <section className="panel events"><h3>Game events</h3>{events.length ? <ol>{events.map((event) => <li key={event.id}>{event.text}</li>)}</ol> : <p className="muted">Rolls, cards and payments will appear here.</p>}</section>
      </aside>
    </div>
    {rollPresentation?.phase === "double" && <div className="roll-announcement" role="status"><strong>{rollingPlayerName} rolled a double!</strong><span>Another roll follows this move.</span></div>}
    {!presentationBusy && drawnCard ? <GameCardModal event={drawnCard} playerName={cardPlayerName} onClose={dismissDrawnCard} /> : selectedPropertySpace && <PropertyCardModal space={selectedPropertySpace} ownerName={selectedPropertyOwner?.username} mortgaged={selectedPropertyState?.mortgaged} development={selectedPropertyState?.count} sourcePosition={landingPropertyPosition ?? undefined} onClose={landingPropertyPosition === null ? closePropertyCard : undefined} actions={landingPropertyPosition !== null && myTurn ? { onBuy: () => send({ type: "landing", decision: "buy" }), onAuction: () => send({ type: "landing", decision: "skip" }) } : undefined} />}
  </main>;
}

export function LobbyView({ room, game, playerId, connection, error, send, leaveRoom }: { room: RoomState; game: GameSnapshot; playerId: string; connection: string; error: string; send: SendAction; leaveRoom: () => void }) {
  const me = game.players.find((player) => player.id === playerId);
  return <main className="lobby-shell"><section className="lobby-card"><span className="eyebrow">Room code</span><h1>{room.roomCode}</h1><p>Share this code with up to five other players.</p><div className="lobby-status"><span className={`connection ${connection}`}>{connection}</span><span>{game.selectedMode.Name}</span></div>{error && <p className="error" role="alert">{error}</p>}<h2>Players</h2><div className="players">{game.players.map((player) => <div className="player-card" style={{ "--player-color": playerColor(player.icon) } as React.CSSProperties} key={player.id}><span className={`token token-${player.icon}`}><img src={playerTokens[player.icon] ?? playerTokens[0]} alt="" /></span><strong>{player.username}{player.id === playerId ? " (you)" : ""}</strong><span>{player.ready ? "Ready" : "Not ready"}</span></div>)}</div>{room.hostPlayerId === playerId && <fieldset className="mode-picker"><legend>Game mode</legend>{([['classic', 'Classic'], ['monopol', 'Monopol'], ['run-down', 'Run-Down']] as const).map(([modeId, label]) => <button className={game.modeId === modeId ? "selected" : "secondary"} onClick={() => send({ type: "select-mode", modeId })} key={modeId}>{label}</button>)}</fieldset>}<button className="primary ready-button" onClick={() => send({ type: "ready", ready: !me?.ready })}>{me?.ready ? "Not ready" : "Ready to play"}</button><button className="text-button" onClick={leaveRoom}>Leave room</button></section></main>;
}
