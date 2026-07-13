import type { WireMessage } from "@monopoly/shared-types";

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) return true;
  return isLocalOrigin(configuredOrigin) && isLocalOrigin(origin);
}

export function parseWireMessage(raw: string | ArrayBuffer): WireMessage | null {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const message = value as Record<string, unknown>;
    if (typeof message.event !== "string" || !message.event) return null;
    return { event: message.event, ...(Object.prototype.hasOwnProperty.call(message, "payload") ? { payload: message.payload } : {}) };
  } catch {
    return null;
  }
}
