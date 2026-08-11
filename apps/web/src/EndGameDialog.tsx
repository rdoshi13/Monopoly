import { useEffect, useRef } from "react";
import { NET_WORTH_RULE, NET_WORTH_TIE_RULE } from "./endGameViewState";

const focusableSelector = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function EndGameDialog({ dispatching, onConfirm, onClose }: { dispatching: boolean; onConfirm: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return <div className="modal-overlay end-game-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="end-game-dialog" role="alertdialog" aria-modal="true" aria-labelledby="end-game-title" aria-describedby="end-game-description" aria-busy={dispatching} ref={dialogRef}>
      <button className="deed-close" type="button" onClick={onClose} aria-label="Close end game confirmation">×</button>
      <span className="eyebrow">Host action</span>
      <h2 id="end-game-title">End this game?</h2>
      <p id="end-game-description">This immediately ends play and calculates the final standings for everyone.</p>
      <div className="scoring-summary">
        <strong>Net worth calculation</strong>
        <p>{NET_WORTH_RULE}</p>
        <small>{NET_WORTH_TIE_RULE}</small>
      </div>
      <div className="actions"><button className="danger" type="button" onClick={onConfirm} disabled={dispatching} ref={confirmRef}>{dispatching ? "Ending game…" : "Confirm end game"}</button><button className="secondary" type="button" onClick={onClose}>Cancel</button></div>
    </section>
  </div>;
}
