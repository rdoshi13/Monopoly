import { useEffect, useRef } from "react";
import type { Card, CardDeckName } from "@monopoly/game-engine";
import { artwork } from "./assets";

export interface DrawnCardEvent {
  playerId: string;
  deck: CardDeckName;
  card: Card;
}

export function GameCardModal({ event, playerName, onClose }: { event: DrawnCardEvent; playerName: string; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isChance = event.deck === "chance";
  const deckName = isChance ? "Chance" : "Community Chest";

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return <div className="property-modal" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}>
    <section className={`game-card ${isChance ? "chance" : "community"}`} role="dialog" aria-modal="true" aria-labelledby="game-card-title" aria-describedby="game-card-text">
      <button className="deed-close" type="button" onClick={onClose} aria-label={`Close ${deckName} card`} ref={closeButtonRef}>×</button>
      <span className="game-card-player">{playerName} drew</span>
      <div className="game-card-art"><img src={isChance ? artwork.chance : artwork.chest} alt="" /></div>
      <h2 id="game-card-title">{deckName}</h2>
      <p id="game-card-text">{event.card.title}</p>
      <button className="primary game-card-continue" type="button" onClick={onClose}>Continue</button>
    </section>
  </div>;
}
