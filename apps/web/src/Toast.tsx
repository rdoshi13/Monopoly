import { useEffect } from "react";

const TOAST_MS = 5000;

/**
 * Transient message. Rejections used to render inline and stay until another
 * one replaced them, which both shifted the layout and left stale complaints on
 * screen. Remount this with a changing key to re-arm the timer for a repeat.
 */
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  if (!message) return null;
  return <div className="toast" role="alert">
    <span>{message}</span>
    <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss message">×</button>
  </div>;
}
