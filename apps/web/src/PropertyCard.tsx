import { useEffect, useLayoutEffect, useRef } from "react";
import type { BoardSpace } from "@monopoly/game-engine";
import { artwork } from "./assets";

interface PropertyCardModalProps {
  space: BoardSpace;
  ownerName?: string;
  mortgaged?: boolean;
  development?: number | "h";
  sourcePosition?: number;
  onClose?: () => void;
  actions?: { onBuy: () => void; onAuction: () => void };
}

const groupColors: Record<string, string> = {
  Purple: "#955436",
  lightgreen: "#aae0fa",
  Violet: "#d93a96",
  Orange: "#f7941d",
  Red: "#ed1b24",
  Yellow: "#fef200",
  darkgreen: "#1fb25a",
  darkblue: "#0072bb",
};

function MoneyRow({ label, amount }: { label: string; amount: number }) {
  return <li><span>{label}</span><strong>${amount}</strong></li>;
}

function StreetDetails({ space }: { space: BoardSpace }) {
  const rents = space.multpliedrent ?? [];
  return <>
    <header className="deed-card-header" style={{ "--deed-color": groupColors[space.group] ?? "#777" } as React.CSSProperties}>
      <span>Title deed</span>
      <h2 id="property-card-title">{space.name}</h2>
    </header>
    <ul className="deed-rents">
      <MoneyRow label="Rent" amount={space.rent ?? 0} />
      <MoneyRow label="Rent with color set" amount={(space.rent ?? 0) * 2} />
      {rents.slice(0, 4).map((rent, index) => <MoneyRow label={`Rent with ${index + 1} house${index ? "s" : ""}`} amount={rent} key={index} />)}
      <MoneyRow label="Rent with hotel" amount={rents[4] ?? 0} />
    </ul>
    <ul className="deed-costs">
      <MoneyRow label="House cost" amount={space.housecost ?? 0} />
      <li><span>Hotel cost</span><strong>${space.housecost ?? 0} each<small>(plus 4 houses)</small></strong></li>
    </ul>
  </>;
}

function RailroadDetails({ space }: { space: BoardSpace }) {
  return <>
    <header className="deed-card-icon-header">
      <img src={artwork.railroad} alt="" />
      <h2 id="property-card-title">{space.name}</h2>
    </header>
    <ul className="deed-rents">
      <MoneyRow label="Rent" amount={25} />
      <MoneyRow label="If 2 railroads are owned" amount={50} />
      <MoneyRow label="If 3 railroads are owned" amount={100} />
      <MoneyRow label="If 4 railroads are owned" amount={200} />
    </ul>
    <p className="deed-rule">Railroad rent depends on how many railroads the owner holds.</p>
  </>;
}

function UtilityDetails({ space }: { space: BoardSpace }) {
  const isWater = space.id === "waterworks";
  return <>
    <header className="deed-card-icon-header utility">
      <img src={isWater ? artwork.water : artwork.electricity} alt="" />
      <h2 id="property-card-title">{space.name}</h2>
    </header>
    <div className="utility-rules">
      <p>If one utility is owned, rent is <strong>4 times</strong> the amount shown on the dice.</p>
      <p>If both utilities are owned, rent is <strong>10 times</strong> the amount shown on the dice.</p>
    </div>
  </>;
}

export function PropertyCardModal({ space, ownerName, mortgaged = false, development = 0, sourcePosition, onClose, actions }: PropertyCardModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const buyButtonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const hasActions = actions !== undefined;

  useLayoutEffect(() => {
    if (sourcePosition === undefined || !cardRef.current) return;
    const source = document.querySelector<HTMLElement>(`[data-board-position="${sourcePosition}"]`);
    if (!source) return;
    const sourceBounds = source.getBoundingClientRect();
    const cardBounds = cardRef.current.getBoundingClientRect();
    cardRef.current.style.setProperty("--deed-from-x", `${sourceBounds.left + (sourceBounds.width / 2) - (cardBounds.left + (cardBounds.width / 2))}px`);
    cardRef.current.style.setProperty("--deed-from-y", `${sourceBounds.top + (sourceBounds.height / 2) - (cardBounds.top + (cardBounds.height / 2))}px`);
  }, [sourcePosition]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose?.(); };
    if (onClose) document.addEventListener("keydown", onKeyDown);
    (closeButtonRef.current ?? buyButtonRef.current ?? cardRef.current)?.focus();
    return () => {
      if (onClose) document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, hasActions]);

  const isRailroad = space.group === "Railroad";
  const isUtility = space.group === "Utilities";
  const developmentLabel = development === "h" ? "Hotel" : development > 0 ? `${development} house${development === 1 ? "" : "s"}` : undefined;

  return <div className={`property-modal${sourcePosition !== undefined ? " landing-property-modal" : ""}`} onMouseDown={(event) => { if (onClose && event.target === event.currentTarget) onClose(); }}>
    <section className={`deed-card${sourcePosition !== undefined ? " landing-deed-card" : ""}`} role="dialog" aria-modal="true" aria-labelledby="property-card-title" aria-describedby="property-card-status" tabIndex={-1} ref={cardRef}>
      {onClose && <button className="deed-close" type="button" onClick={onClose} aria-label="Close property card" ref={closeButtonRef}>×</button>}
      {isRailroad ? <RailroadDetails space={space} /> : isUtility ? <UtilityDetails space={space} /> : <StreetDetails space={space} />}
      <div className="deed-status" id="property-card-status">
        <span>{ownerName ? `Owned by ${ownerName}` : "Unowned"}{mortgaged ? " · Mortgaged" : ""}{developmentLabel ? ` · ${developmentLabel}` : ""}</span>
        <span>Mortgage value <strong>${Math.floor((space.price ?? 0) / 2)}</strong></span>
      </div>
      <footer className="deed-price"><span>Purchase price</span><strong>${space.price ?? 0}</strong></footer>
      {actions && <div className="deed-actions"><button className="primary" type="button" onClick={actions.onBuy} ref={buyButtonRef}>Buy</button><button className="secondary" type="button" onClick={actions.onAuction}>Auction</button></div>}
    </section>
  </div>;
}
