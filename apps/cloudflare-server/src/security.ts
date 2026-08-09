import type { WireMessage } from "@monopoly/shared-types";

// Both transports share one origin check; see @monopoly/shared-types.
export { isAllowedOrigin } from "@monopoly/shared-types";

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
