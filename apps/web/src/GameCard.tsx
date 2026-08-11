import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Card, CardDeckName } from "@monopoly/game-engine";
import { artwork } from "./assets";

export interface DrawnCardEvent {
  playerId: string;
  deck: CardDeckName;
  card: Card;
}

/** Long enough to read the card sliding back onto the pile before it unmounts. */
const RETURN_MS = 420;

export function GameCardModal({ event, playerName, onClose }: { event: DrawnCardEvent; playerName: string; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const returnTimerRef = useRef<number | null>(null);
  const returningRef = useRef(false);
  const [returning, setReturning] = useState(false);
  const isChance = event.deck === "chance";
  const deckName = isChance ? "Chance" : "Community Chest";

  /**
   * Fly the card between its pile on the board and the centre of the screen, so
   * a draw reads as coming off the top of that deck rather than appearing from
   * nowhere. Falls back to a plain centre animation if the pile is off-screen.
   */
  useLayoutEffect(() => {
    const pile = document.querySelector<HTMLElement>(`[data-deck="${event.deck}"]`);
    if (!pile || !cardRef.current) return;
    const from = pile.getBoundingClientRect();
    const to = cardRef.current.getBoundingClientRect();
    cardRef.current.style.setProperty("--card-from-x", `${from.left + (from.width / 2) - (to.left + (to.width / 2))}px`);
    cardRef.current.style.setProperty("--card-from-y", `${from.top + (from.height / 2) - (to.top + (to.height / 2))}px`);
  }, [event.deck]);

  // Let the card travel back to the pile before the queue advances.
  const dismiss = useCallback(() => {
    if (returningRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    returningRef.current = true;
    setReturning(true);
    returnTimerRef.current = window.setTimeout(onClose, RETURN_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (returnTimerRef.current !== null) window.clearTimeout(returnTimerRef.current);
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") dismiss(); };
    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [dismiss]);

  return <div className={`modal-overlay${returning ? " card-returning" : ""}`} onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) dismiss(); }}>
    <section className={`game-card ${isChance ? "chance" : "community"}${returning ? " returning" : ""}`} role="dialog" aria-modal="true" aria-labelledby="game-card-title" aria-describedby="game-card-text" ref={cardRef}>
      <button className="deed-close" type="button" onClick={dismiss} aria-label={`Close ${deckName} card`} ref={closeButtonRef}>×</button>
      <span className="game-card-player">{playerName} drew</span>
      <div className="game-card-art"><img src={isChance ? artwork.chance : artwork.chest} alt="" /></div>
      <h2 id="game-card-title">{deckName}</h2>
      <p id="game-card-text">{event.card.title}</p>
      <button className="primary game-card-continue" type="button" onClick={dismiss}>Continue</button>
    </section>
  </div>;
}
