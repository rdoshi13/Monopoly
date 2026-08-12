import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { boardSpaces, type GameAction, type GameSnapshot, type TradeOffer } from "@monopoly/game-engine";
import type { RoomState } from "@monopoly/shared-types";
import { playerTokens, playSound } from "./assets";
import { PropertyCardModal } from "./PropertyCard";
import { GameCardModal, type DrawnCardEvent } from "./GameCard";
import { CodedBoard } from "./CodedBoard";
import { isStreetGroup } from "./boardColors";
import { buildAvailability, compareBalances, landingPresentationKey, mortgageConfirmationProperty, purchaseAvailability, sellAvailability } from "./gameViewState";
import { matchingSalaryPresentationId, readySalaryPresentations, type SalaryPresentation } from "./salaryPresentation";
import { Toast } from "./Toast";
import { EndGameDialog } from "./EndGameDialog";
import { NET_WORTH_TIE_RULE, acquireEndGameDispatch, canHostEndGame } from "./endGameViewState";

type SendAction = (action: GameAction) => void;
export type GameEvent = { id: number; text: string; playerId?: string };
export type DiceResult = { id: number; playerId: string; dice: [number, number]; fromPosition: number; position: number; moved: boolean; fromJail: boolean };
export type CardResult = DrawnCardEvent & { id: number; fromPosition: number; position: number; moved: boolean; fromJail: boolean; toJail: boolean };
export type GamePresentationEvent = { kind: "dice"; result: DiceResult } | { kind: "card"; result: CardResult };

type RollPhase = "rolling" | "result" | "double" | "moving";
type RollPresentation = { result: DiceResult; phase: RollPhase; faces: [number, number]; position: number; isInJail: boolean };
type CardPresentation = { result: CardResult; phase: "card" | "moving"; position: number; isInJail: boolean };

const spaceByPosition = new Map(boardSpaces.map((space) => [space.posistion, space]));
export const propertyName = (position: number) => spaceByPosition.get(position)?.name ?? `Space ${position}`;
const playerColors = ["#d43f3f", "#315dc4", "#2c9763", "#d18a22", "#7442a5", "#292d32"];
const playerColor = (icon: number) => playerColors[icon] ?? playerColors[0];

const dieFaces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const dialogFocusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function cardMovementPath(result: CardResult) {
  if (!result.moved) return [];
  if (result.toJail) return [result.position];
  if (typeof result.card.count === "number") {
    const direction = Math.sign(result.card.count);
    return Array.from({ length: Math.abs(result.card.count) }, (_, index) => (result.fromPosition + direction * (index + 1) + 40) % 40);
  }
  const steps = (result.position - result.fromPosition + 40) % 40;
  return Array.from({ length: steps }, (_, index) => (result.fromPosition + index + 1) % 40);
}

function DiceDisplay({ result, playerName, presentation, stale = false }: { result: DiceResult; playerName: string; presentation: RollPresentation | null; stale?: boolean }) {
  const rolling = presentation?.result.id === result.id && presentation.phase === "rolling";
  const faces = rolling ? presentation.faces : result.dice;
  return <div className={`dice-result${rolling ? " rolling" : ""}${stale ? " stale" : ""}`} aria-live="polite" aria-label={rolling ? `${playerName} is rolling the dice` : `${playerName} rolled ${result.dice[0]} and ${result.dice[1]}`}>
    {stale && <span className="dice-stale-label">Previous roll</span>}
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
  const [composerOpen, setComposerOpen] = useState(false);
  const offerDialogRef = useRef<HTMLElement>(null);
  const offerAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const composerDialogRef = useRef<HTMLElement>(null);
  const composerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const recipient = game.players.find((player) => player.id === tradeTo);
  const canPropose = !interactionLocked && game.currentPlayerId === playerId && game.phase === "awaiting-roll" && game.selectedMode.AllowDeals && !game.pendingTrade;
  const toggle = (values: number[], position: number) => values.includes(position) ? values.filter((value) => value !== position) : [...values, position];
  const summary = (offer: TradeOffer) => `${game.players.find((player) => player.id === offer.from)?.username ?? "Player"} offers £${offer.offeredCash}${offer.offeredPositions.length ? ` and ${offer.offeredPositions.map(propertyName).join(", ")}` : ""} for £${offer.requestedCash}${offer.requestedPositions.length ? ` and ${offer.requestedPositions.map(propertyName).join(", ")}` : ""}.`;

  const incomingTrade = game.pendingTrade && game.pendingTrade.to === playerId ? game.pendingTrade : null;
  const incomingTradeOpen = incomingTrade !== null;
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  useEffect(() => { if (!canPropose) setComposerOpen(false); }, [canPropose]);
  useEffect(() => {
    const dialog = incomingTradeOpen ? offerDialogRef.current : composerOpen ? composerDialogRef.current : null;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialFocus = incomingTradeOpen ? offerAcceptButtonRef.current : composerCloseButtonRef.current;
    initialFocus?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && composerOpen && !incomingTradeOpen) {
        event.preventDefault();
        closeComposer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [incomingTradeOpen, composerOpen, closeComposer]);

  return <section className="panel trade-panel">
    <h3>Trades</h3>
    {game.pendingTrade ? <>
      <p>{summary(game.pendingTrade)}</p>
      {game.pendingTrade.from === playerId && <div className="actions"><button className="secondary" onClick={() => send({ type: "trade-cancel" })}>Cancel offer</button></div>}
      {game.pendingTrade.to === playerId && <p className="muted">Waiting for your decision.</p>}
    </> : <>
      <button className="primary" disabled={!canPropose} onClick={() => setComposerOpen(true)}>Propose trade</button>
      {!canPropose && <p className="muted">{game.selectedMode.AllowDeals ? "Trades can be proposed at the start of your turn." : "Trades are disabled in this mode."}</p>}
    </>}
    {incomingTrade && <div className="modal-overlay trade-offer-overlay">
      <section className="trade-dialog trade-offer" role="alertdialog" aria-modal="true" aria-labelledby="trade-offer-title" ref={offerDialogRef}>
        <span className="eyebrow">Trade offer</span>
        <h2 id="trade-offer-title">{game.players.find((player) => player.id === incomingTrade.from)?.username ?? "A player"} wants to trade</h2>
        <div className="trade-offer-columns">
          <div><h3>You receive</h3><ul>{incomingTrade.offeredCash > 0 && <li>£{incomingTrade.offeredCash}</li>}{incomingTrade.offeredPositions.map((position) => <li key={position}>{propertyName(position)}</li>)}{!incomingTrade.offeredCash && !incomingTrade.offeredPositions.length && <li className="muted">Nothing</li>}</ul></div>
          <div><h3>You give</h3><ul>{incomingTrade.requestedCash > 0 && <li>£{incomingTrade.requestedCash}</li>}{incomingTrade.requestedPositions.map((position) => <li key={position}>{propertyName(position)}</li>)}{!incomingTrade.requestedCash && !incomingTrade.requestedPositions.length && <li className="muted">Nothing</li>}</ul></div>
        </div>
        <div className="actions"><button className="primary" onClick={() => send({ type: "trade-accept" })} ref={offerAcceptButtonRef}>Accept trade</button><button className="secondary" onClick={() => send({ type: "trade-reject" })}>Reject</button></div>
      </section>
    </div>}
    {composerOpen && canPropose && <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer(); }}>
      <section className="trade-dialog" role="dialog" aria-modal="true" aria-labelledby="trade-dialog-title" ref={composerDialogRef}>
        <button className="deed-close" type="button" onClick={closeComposer} aria-label="Close trade composer" ref={composerCloseButtonRef}>×</button>
        <h2 id="trade-dialog-title">Propose a trade</h2>
        <label>Trade with<select value={tradeTo} onChange={(event) => { setTradeTo(event.target.value); setRequestedPositions([]); }}><option value="">Choose player</option>{game.players.filter((player) => player.id !== playerId).map((player) => <option value={player.id} key={player.id}>{player.username}</option>)}</select></label>
        <div className="cash-grid"><label>You offer<input type="number" min="0" value={offeredCash} onChange={(event) => setOfferedCash(Math.max(0, Math.floor(Number(event.target.value) || 0)))} /></label><label>You request<input type="number" min="0" value={requestedCash} onChange={(event) => setRequestedCash(Math.max(0, Math.floor(Number(event.target.value) || 0)))} /></label></div>
        <div className="trade-properties"><fieldset><legend>Your properties</legend>{me?.properties.length ? me.properties.map((property) => <label key={property.posistion}><input type="checkbox" checked={offeredPositions.includes(property.posistion)} onChange={() => setOfferedPositions((values) => toggle(values, property.posistion))} />{propertyName(property.posistion)}</label>) : <small>None</small>}</fieldset><fieldset><legend>Their properties</legend>{recipient?.properties.length ? recipient.properties.map((property) => <label key={property.posistion}><input type="checkbox" checked={requestedPositions.includes(property.posistion)} onChange={() => setRequestedPositions((values) => toggle(values, property.posistion))} />{propertyName(property.posistion)}</label>) : <small>{recipient ? "None" : "Choose a player"}</small>}</fieldset></div>
        <div className="actions"><button className="primary" disabled={!tradeTo} onClick={() => { if (!tradeTo) return; send({ type: "trade-propose", to: tradeTo, offeredPositions, requestedPositions, offeredCash, requestedCash }); closeComposer(); }}>Send offer</button><button className="secondary" onClick={closeComposer}>Cancel</button></div>
      </section>
    </div>}
  </section>;
}

export function GameView({ room, game, playerId, connection, error, events, presentationEvents, onPresentationComplete, salaryEvents, onSalaryPresentationComplete, clockOffset, errorNonce, onDismissError, send, leaveRoom }: { room: RoomState; game: GameSnapshot; playerId: string; connection: string; error: string; events: GameEvent[]; presentationEvents: GamePresentationEvent[]; onPresentationComplete: (id: number) => void; salaryEvents: SalaryPresentation[]; onSalaryPresentationComplete: (id: number) => void; clockOffset: number; errorNonce: number; onDismissError: () => void; send: SendAction; leaveRoom: () => void }) {
  const [, tick] = useState(0);
  const [auctionBid, setAuctionBid] = useState(1);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);
  const [selectedPropertyPosition, setSelectedPropertyPosition] = useState<number | null>(null);
  const [mortgageConfirmationPosition, setMortgageConfirmationPosition] = useState<number | null>(null);
  const [dismissedLanding, setDismissedLanding] = useState<string | null>(null);
  const [endGameConfirmationOpen, setEndGameConfirmationOpen] = useState(false);
  const [endGameDispatching, setEndGameDispatching] = useState(false);
  const [moneyDeltas, setMoneyDeltas] = useState<Array<{ id: number; playerId: string; amount: number }>>([]);
  const previousBalances = useRef<Record<string, number> | null>(null);
  const deltaSequence = useRef(0);
  const moneyDeltaTimers = useRef<Map<number, number>>(new Map());
  const salaryTimers = useRef<Map<number, number>>(new Map());
  const consumedSalaryEvents = useRef<Set<number>>(new Set());
  const [rollPresentation, setRollPresentation] = useState<RollPresentation | null>(null);
  const [cardPresentation, setCardPresentation] = useState<CardPresentation | null>(null);
  const [lastDiceResult, setLastDiceResult] = useState<DiceResult | null>(null);
  const presentableSalaryEvents = useMemo(() => readySalaryPresentations(salaryEvents, new Set(presentationEvents.map((presentation) => presentation.result.playerId))), [salaryEvents, presentationEvents]);
  const highlightTimer = useRef<number | null>(null);
  const mortgageDispatchPending = useRef(false);
  const endGameDispatchPending = useRef(false);
  const closePropertyCard = useCallback(() => setSelectedPropertyPosition(null), []);
  const closeEndGameConfirmation = useCallback(() => {
    endGameDispatchPending.current = false;
    setEndGameDispatching(false);
    setEndGameConfirmationOpen(false);
  }, []);
  const openEndGameConfirmation = useCallback(() => {
    endGameDispatchPending.current = false;
    setEndGameDispatching(false);
    setEndGameConfirmationOpen(true);
  }, []);
  const closeMortgageConfirmation = useCallback(() => {
    mortgageDispatchPending.current = false;
    setMortgageConfirmationPosition(null);
  }, []);
  const openMortgageConfirmation = useCallback((position: number) => {
    mortgageDispatchPending.current = false;
    setMortgageConfirmationPosition(position);
  }, []);
  const highlightPlayer = useCallback((selectedPlayerId: string) => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    setHighlightedPlayerId(selectedPlayerId);
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedPlayerId(null);
      highlightTimer.current = null;
    }, 3000);
  }, []);
  useEffect(() => {
    const { current, changes } = compareBalances(previousBalances.current, game.players);
    previousBalances.current = current;
    const unsuppressed = changes.filter((change) => {
      const salaryId = matchingSalaryPresentationId(change.playerId, change.amount, salaryEvents, consumedSalaryEvents.current);
      if (salaryId === null) return true;
      consumedSalaryEvents.current.add(salaryId);
      return false;
    });
    const fresh = unsuppressed.map((change) => ({ id: deltaSequence.current++, ...change }));
    if (!fresh.length) return;
    setMoneyDeltas((existing) => [...existing, ...fresh]);
    for (const delta of fresh) {
      const timer = window.setTimeout(() => {
        setMoneyDeltas((existing) => existing.filter((candidate) => candidate.id !== delta.id));
        moneyDeltaTimers.current.delete(delta.id);
      }, 1600);
      moneyDeltaTimers.current.set(delta.id, timer);
    }
  }, [game.players, salaryEvents]);
  useEffect(() => {
    const liveIds = new Set(salaryEvents.map((event) => event.id));
    for (const consumedId of consumedSalaryEvents.current) if (!liveIds.has(consumedId)) consumedSalaryEvents.current.delete(consumedId);
    for (const event of presentableSalaryEvents) {
      if (salaryTimers.current.has(event.id)) continue;
      const timer = window.setTimeout(() => {
        salaryTimers.current.delete(event.id);
        onSalaryPresentationComplete(event.id);
      }, 1800);
      salaryTimers.current.set(event.id, timer);
    }
  }, [salaryEvents, presentableSalaryEvents, onSalaryPresentationComplete]);
  useEffect(() => { if (!room.turnDeadline) return; const timer = setInterval(() => tick((value) => value + 1), 1000); return () => clearInterval(timer); }, [room.turnDeadline]);
  useEffect(() => () => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    moneyDeltaTimers.current.forEach((timer) => window.clearTimeout(timer));
    moneyDeltaTimers.current.clear();
    salaryTimers.current.forEach((timer) => window.clearTimeout(timer));
    salaryTimers.current.clear();
  }, []);
  const activePresentationEvent = presentationEvents[0] ?? null;
  const activeDiceResult = activePresentationEvent?.kind === "dice" ? activePresentationEvent.result : null;
  const activeCardResult = activePresentationEvent?.kind === "card" ? activePresentationEvent.result : null;
  useEffect(() => {
    if (activeDiceResult) playSound("roll");
  }, [activeDiceResult]);
  useEffect(() => {
    if (activeCardResult) playSound(activeCardResult.card.title.toLowerCase().includes("jail") ? "jail" : "card");
  }, [activeCardResult]);
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
      onPresentationComplete(activeDiceResult.id);
    })();

    return () => {
      cancelled = true;
      window.clearInterval(rollingInterval);
      timeouts.forEach((timeout) => { window.clearTimeout(timeout.id); timeout.resolve(); });
    };
  }, [activeDiceResult, onPresentationComplete]);
  useLayoutEffect(() => {
    if (!activeCardResult) {
      setCardPresentation(null);
      return;
    }
    setCardPresentation({ result: activeCardResult, phase: "card", position: activeCardResult.fromPosition, isInJail: activeCardResult.fromJail });
  }, [activeCardResult]);
  useLayoutEffect(() => {
    if (cardPresentation?.phase !== "moving") return;
    const result = cardPresentation.result;
    let cancelled = false;
    const timeouts: Array<{ id: number; resolve: () => void }> = [];
    const wait = (duration: number) => new Promise<void>((resolve) => timeouts.push({ id: window.setTimeout(resolve, duration), resolve }));

    void (async () => {
      for (const position of cardMovementPath(result)) {
        setCardPresentation((current) => current?.result.id === result.id ? { ...current, position, isInJail: result.toJail && position === result.position } : current);
        await wait(190);
        if (cancelled) return;
      }
      await wait(260);
      if (cancelled) return;
      setCardPresentation(null);
      onPresentationComplete(result.id);
    })();

    return () => {
      cancelled = true;
      timeouts.forEach((timeout) => { window.clearTimeout(timeout.id); timeout.resolve(); });
    };
  }, [cardPresentation?.phase, cardPresentation?.result, onPresentationComplete]);
  const continueCardPresentation = useCallback(() => {
    if (!cardPresentation || cardPresentation.phase !== "card") return;
    if (!cardPresentation.result.moved) {
      setCardPresentation(null);
      onPresentationComplete(cardPresentation.result.id);
      return;
    }
    setCardPresentation((current) => current ? { ...current, phase: "moving", isInJail: false } : current);
  }, [cardPresentation, onPresentationComplete]);
  const me = game.players.find((player) => player.id === playerId);
  const current = game.players.find((player) => player.id === game.currentPlayerId);
  const myTurn = current?.id === playerId;
  const auctionSpace = game.pendingAuction ? spaceByPosition.get(game.pendingAuction.position) : undefined;
  const passedAuction = game.pendingAuction?.passedPlayerIds.includes(playerId) ?? false;
  const winner = game.players.find((player) => player.id === game.winnerId);
  const endGameEligible = canHostEndGame(room, game, playerId);
  useEffect(() => { if (!endGameEligible) closeEndGameConfirmation(); }, [endGameEligible, closeEndGameConfirmation]);
  const confirmEndGame = useCallback(() => {
    if (!canHostEndGame(room, game, playerId)) {
      closeEndGameConfirmation();
      return;
    }
    if (!acquireEndGameDispatch(endGameDispatchPending)) return;
    setEndGameDispatching(true);
    send({ type: "end-game" });
  }, [room, game, playerId, send, closeEndGameConfirmation]);
  const secondsLeft = room.turnDeadline ? Math.max(0, Math.ceil((room.turnDeadline - (Date.now() + clockOffset)) / 1000)) : null;
  // Run-Down's clock is a game rule and always shows. Every other mode only has
  // an idle backstop, which should stay invisible until it is about to fire.
  const showCountdown = secondsLeft !== null && (game.selectedMode.turnTimer !== undefined || secondsLeft <= 60);
  const playersWithConnection = game.players.map((player) => ({ ...player, connected: room.players.find((candidate) => candidate.playerId === player.id)?.connected ?? false }));
  const presentationBusy = rollPresentation !== null || cardPresentation !== null || presentationEvents.length > 0;
  const pendingMortgageProperty = mortgageConfirmationPosition === null ? null : mortgageConfirmationProperty(game, playerId, mortgageConfirmationPosition, presentationBusy);
  const mortgageConfirmationEligible = pendingMortgageProperty !== null;
  useEffect(() => {
    if (mortgageConfirmationPosition !== null && !mortgageConfirmationEligible) closeMortgageConfirmation();
  }, [mortgageConfirmationPosition, mortgageConfirmationEligible, closeMortgageConfirmation]);
  const confirmMortgage = useCallback(() => {
    if (mortgageConfirmationPosition === null || mortgageDispatchPending.current) return;
    const liveProperty = mortgageConfirmationProperty(game, playerId, mortgageConfirmationPosition, presentationBusy);
    if (!liveProperty) {
      closeMortgageConfirmation();
      return;
    }
    mortgageDispatchPending.current = true;
    send({ type: "mortgage", position: liveProperty.posistion });
    setMortgageConfirmationPosition(null);
  }, [mortgageConfirmationPosition, game, playerId, presentationBusy, closeMortgageConfirmation, send]);
  // Players who are not deciding may dismiss the deed to see the board. The key
  // is per landing, so the next one reopens it rather than staying hidden.
  const landingKey = landingPresentationKey(game.pendingLanding, game.turnRevision);
  const landingPropertyPosition = game.phase === "awaiting-landing" && landingKey !== null && dismissedLanding !== landingKey ? game.pendingLanding?.position ?? null : null;
  const displayedPropertyPosition = presentationBusy ? null : landingPropertyPosition ?? pendingMortgageProperty?.posistion ?? selectedPropertyPosition;
  const selectedPropertySpace = displayedPropertyPosition === null ? undefined : spaceByPosition.get(displayedPropertyPosition);
  const selectedPropertyOwner = displayedPropertyPosition === null ? undefined : game.players.find((player) => player.properties.some((property) => property.posistion === displayedPropertyPosition));
  const selectedPropertyState = selectedPropertyOwner?.properties.find((property) => property.posistion === displayedPropertyPosition);
  const displayedDiceResult = activeDiceResult ?? lastDiceResult;
  const dicePlayerName = game.players.find((player) => player.id === displayedDiceResult?.playerId)?.username ?? "Player";
  const cardPlayerName = game.players.find((player) => player.id === cardPresentation?.result.playerId)?.username ?? "Player";
  const rollingPlayerName = game.players.find((player) => player.id === rollPresentation?.result.playerId)?.username ?? "Player";
  const animatedPresentation = rollPresentation
    ? { playerId: rollPresentation.result.playerId, position: rollPresentation.position, isInJail: rollPresentation.isInJail, moving: rollPresentation.phase === "moving" }
    : cardPresentation
      ? { playerId: cardPresentation.result.playerId, position: cardPresentation.position, isInJail: cardPresentation.isInJail, moving: cardPresentation.phase === "moving" }
      : null;

  return <main className="game-shell">
    <header className="game-header"><div><span className="eyebrow">Room {room.roomCode}</span><h1>Monopoly</h1></div><div className="status"><span className={`connection ${connection}`}>{connection}</span>{showCountdown && <span>{secondsLeft}s left</span>}{endGameEligible && <button className="danger compact" type="button" onClick={openEndGameConfirmation}>End game</button>}<button className="text-button" onClick={leaveRoom}>Leave</button></div></header>
    <Toast key={errorNonce} message={error} onDismiss={onDismissError} />
    {game.finalStandings ? <section className="winner final-results"><span className="eyebrow">Final standings</span><h2>{game.finalStandings[0]?.playerId === playerId ? "You won!" : `${game.finalStandings[0]?.username ?? "The winner"} won!`}</h2><ol>{game.finalStandings.map((standing) => <li key={standing.playerId}><strong><span>{standing.rank}. {standing.username}{standing.playerId === playerId ? " (you)" : ""}</span><span>£{standing.netWorth}</span></strong><small>Cash £{standing.cash} · Unmortgaged £{standing.unmortgagedPropertyValue} · Mortgaged £{standing.mortgagedPropertyValue} · Buildings £{standing.buildingValue}</small></li>)}</ol><p>{NET_WORTH_TIE_RULE}</p>{room.hostPlayerId === playerId ? <button className="primary rematch-button" onClick={() => send({ type: "restart" })}>Play again with the same players</button> : <p className="muted">Waiting for the host to start a new game.</p>}</section> : winner && <section className="winner"><span className="eyebrow">Winner</span><h2>{winner.id === playerId ? "You won!" : `${winner.username} won!`}</h2></section>}
    <div className="game-layout">
      <CodedBoard game={game} highlightedPlayerId={highlightedPlayerId} animatedToken={animatedPresentation} onSelectProperty={setSelectedPropertyPosition} playerColor={playerColor} propertyName={propertyName} />
      <aside className="sidebar">
        <section className="panel turn-panel">
          <span className="eyebrow">{game.phase === "finished" ? "Game over" : game.phase === "awaiting-auction" ? "Property auction" : "Current turn"}</span>
          <h2>{game.phase === "finished" ? "No further turns" : rollPresentation ? rollPresentation.result.playerId === playerId ? "You're rolling" : `${rollingPlayerName} is rolling` : cardPresentation?.phase === "moving" ? `${cardPlayerName} is moving` : game.phase === "awaiting-auction" ? auctionSpace?.name ?? "Auction" : myTurn ? "Your turn" : current?.username ?? "Waiting"}</h2>
          {game.phase !== "finished" && displayedDiceResult && <DiceDisplay result={displayedDiceResult} playerName={dicePlayerName} presentation={rollPresentation} stale={!rollPresentation && displayedDiceResult.playerId !== game.currentPlayerId} />}
          {game.pausedPlayerId && <p>Paused while {game.players.find((player) => player.id === game.pausedPlayerId)?.username ?? "a player"} reconnects.</p>}
          {!presentationBusy && myTurn && game.phase === "awaiting-roll" && <div className="actions">{me?.isInJail && <><button onClick={() => send({ type: "unjail", option: "pay" })}>Pay £50</button>{me.getoutCards > 0 && <button onClick={() => send({ type: "unjail", option: "card" })}>Use jail card</button>}</>}<button className="primary" onClick={() => send({ type: "roll" })}>Roll dice</button></div>}
          {game.phase === "awaiting-auction" && game.pendingAuction && <><p>Highest bid: <strong>£{game.pendingAuction.highestBid}</strong>{game.pendingAuction.highestBidderId ? ` by ${game.players.find((player) => player.id === game.pendingAuction?.highestBidderId)?.username ?? "player"}` : ""}</p>{passedAuction ? <p className="muted">You passed. Waiting for the remaining bidders.</p> : <div className="actions"><input aria-label="Auction bid" type="number" min={game.pendingAuction.highestBid + 1} max={me?.balance} value={auctionBid} onChange={(event) => setAuctionBid(Math.max(1, Math.floor(Number(event.target.value) || 1)))} /><button className="primary" onClick={() => send({ type: "auction-bid", amount: auctionBid })}>Bid</button><button className="secondary" onClick={() => send({ type: "auction-pass" })}>Pass</button></div>}</>}
        </section>
        <section className="panel"><h3>Players</h3><div className="players">{playersWithConnection.map((player) => <button type="button" className={`player-card player-card-button ${player.id === game.currentPlayerId ? "active" : ""}${player.id === highlightedPlayerId ? " selected" : ""}`} style={{ "--player-color": playerColor(player.icon) } as React.CSSProperties} aria-label={`Highlight ${player.username} on the board for 3 seconds`} aria-pressed={player.id === highlightedPlayerId} onClick={() => highlightPlayer(player.id)} key={player.id}><span className={`token token-${player.icon}`}><img src={playerTokens[player.icon] ?? playerTokens[0]} alt="" /></span><span><strong>{player.username}{player.id === playerId ? " (you)" : ""}</strong><small>£{player.balance} · {player.isInJail ? "In jail" : propertyName(player.position)}</small></span><i className={player.connected ? "online" : "offline"} />{moneyDeltas.filter((delta) => delta.playerId === player.id).map((delta) => <span className={`money-delta ${delta.amount > 0 ? "gain" : "loss"}`} key={delta.id} aria-hidden="true">{delta.amount > 0 ? "+" : "−"}£{Math.abs(delta.amount)}</span>)}{presentableSalaryEvents.filter((event) => event.playerId === player.id).map((event) => <span className="go-salary" key={event.id} aria-hidden="true">{event.reason === "advanced" ? "Advanced to Go" : "Passed Go"} · +£{event.amount}</span>)}</button>)}</div>{presentableSalaryEvents.slice(-1).map((event) => <span className="visually-hidden" role="status" key={event.id}>{game.players.find((player) => player.id === event.playerId)?.username ?? "A player"} {event.reason === "advanced" ? "advanced to Go" : "passed Go"} and collected £{event.amount}</span>)}</section>
        <section className="panel"><h3>Your properties</h3>{me?.properties.length ? <ul className="property-list">{me.properties.map((property) => {
          const street = isStreetGroup(property.group);
          const build = buildAvailability(game, playerId, property.posistion);
          const sell = sellAvailability(game, playerId, property.posistion);
          return <li key={property.posistion}><span><strong>{propertyName(property.posistion)}</strong><small>{street ? property.count === "h" ? "Hotel" : `${property.count} ${property.count === 1 ? "house" : "houses"}` : property.group === "Railroad" ? "Station" : "Utility"}{property.mortgaged ? " · Mortgaged" : ""}</small></span>{!presentationBusy && myTurn && game.phase === "awaiting-roll" && <span className="mini-actions">{street && <><button disabled={!build.allowed} title={build.reason} onClick={() => send({ type: "build", position: property.posistion })}>Build</button><button disabled={!sell.allowed} title={sell.reason} onClick={() => send({ type: "sell-building", position: property.posistion })}>Sell</button></>}<button onClick={() => property.mortgaged ? send({ type: "unmortgage", position: property.posistion }) : openMortgageConfirmation(property.posistion)}>{property.mortgaged ? "Redeem" : "Mortgage"}</button></span>}</li>;
        })}</ul> : <p className="muted">No properties yet.</p>}<small className="muted">Bank: {game.bankSupply.houses} houses · {game.bankSupply.hotels} hotels</small></section>
        <TradePanel game={game} playerId={playerId} send={send} interactionLocked={presentationBusy} />
        <section className="panel events"><h3>Game events</h3>{events.length ? <ol>{events.map((event) => <li key={event.id}>{event.playerId ? `${game.players.find((player) => player.id === event.playerId)?.username ?? "A player"} ${event.text}` : event.text}</li>)}</ol> : <p className="muted">Rolls, cards and payments will appear here.</p>}</section>
      </aside>
    </div>
    {rollPresentation?.phase === "double" && <div className="roll-announcement" role="status"><strong>{rollingPlayerName} rolled a double!</strong><span>Another roll follows this move.</span></div>}
    {cardPresentation?.phase === "card" ? <GameCardModal event={cardPresentation.result} playerName={cardPlayerName} onClose={continueCardPresentation} /> : selectedPropertySpace && <PropertyCardModal space={selectedPropertySpace} ownerName={selectedPropertyOwner?.username} mortgaged={selectedPropertyState?.mortgaged} development={selectedPropertyState?.count} sourcePosition={landingPropertyPosition ?? undefined} balance={me?.balance} onClose={landingPropertyPosition !== null ? myTurn ? undefined : () => setDismissedLanding(landingKey) : pendingMortgageProperty ? closeMortgageConfirmation : closePropertyCard} actions={landingPropertyPosition !== null && myTurn ? { onBuy: () => send({ type: "landing", decision: "buy" }), onAuction: () => send({ type: "landing", decision: "skip" }), buy: purchaseAvailability(game, playerId, landingPropertyPosition) } : undefined} mortgageConfirmation={landingPropertyPosition === null && pendingMortgageProperty ? { onConfirm: confirmMortgage, onCancel: closeMortgageConfirmation } : undefined} />}
    {endGameConfirmationOpen && endGameEligible && <EndGameDialog dispatching={endGameDispatching} onConfirm={confirmEndGame} onClose={closeEndGameConfirmation} />}
  </main>;
}

export function LobbyView({ room, game, playerId, connection, error, errorNonce, onDismissError, send, leaveRoom }: { room: RoomState; game: GameSnapshot; playerId: string; connection: string; error: string; errorNonce: number; onDismissError: () => void; send: SendAction; leaveRoom: () => void }) {
  const me = game.players.find((player) => player.id === playerId);
  return <main className="lobby-shell"><section className="lobby-card"><span className="eyebrow">Room code</span><h1>{room.roomCode}</h1><p>Share this code with up to five other players.</p><div className="lobby-status"><span className={`connection ${connection}`}>{connection}</span><span>{game.selectedMode.Name}</span></div><h2>Players</h2><div className="players">{game.players.map((player) => <div className="player-card" style={{ "--player-color": playerColor(player.icon) } as React.CSSProperties} key={player.id}><span className={`token token-${player.icon}`}><img src={playerTokens[player.icon] ?? playerTokens[0]} alt="" /></span><strong>{player.username}{player.id === playerId ? " (you)" : ""}</strong><span>{player.ready ? "Ready" : "Not ready"}</span></div>)}</div>{room.hostPlayerId === playerId && <fieldset className="mode-picker"><legend>Game mode</legend>{([['classic', 'Classic'], ['monopol', 'Monopol'], ['run-down', 'Run-Down']] as const).map(([modeId, label]) => <button className={game.modeId === modeId ? "selected" : "secondary"} onClick={() => send({ type: "select-mode", modeId })} key={modeId}>{label}</button>)}</fieldset>}<button className="primary ready-button" onClick={() => send({ type: "ready", ready: !me?.ready })}>{me?.ready ? "Not ready" : "Ready to play"}</button><button className="text-button" onClick={leaveRoom}>Leave room</button></section><Toast key={errorNonce} message={error} onDismiss={onDismissError} /></main>;
}
