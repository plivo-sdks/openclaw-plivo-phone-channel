/**
 * Channel registration and configuration resolution.
 *
 * The answer webhook and the audio WebSocket are two routes on one origin, and
 * the public URL has to forward upgrades as well as HTTP for both to work.
 */

import { StreamTokens } from "./webhook.js";
import type { PlivoPhoneConfig } from "./audio-streaming.js";

export const CHANNEL_ID = "plivo-phone";

const DEFAULTS = {
  answerPath: "/plivo-phone/answer",
  streamPath: "/plivo-phone/stream",
  autoWire: true,
  dmSecurity: "allowlist" as const,
  idleTimeoutSeconds: 60,
  maxCallSeconds: 600,
};

type RawConfig = Partial<PlivoPhoneConfig> | undefined;

export function resolveConfig(raw: RawConfig): PlivoPhoneConfig | null {
  if (!raw?.authId || !raw?.authToken) {
    return null;
  }
  return {
    authId: raw.authId,
    authToken: raw.authToken,
    fromNumber: raw.fromNumber,
    publicWebhookUrl: raw.publicWebhookUrl,
    answerPath: raw.answerPath ?? DEFAULTS.answerPath,
    streamPath: raw.streamPath ?? DEFAULTS.streamPath,
    autoWire: raw.autoWire ?? DEFAULTS.autoWire,
    dmSecurity: raw.dmSecurity ?? DEFAULTS.dmSecurity,
    allowFrom: raw.allowFrom ?? [],
    idleTimeoutSeconds: raw.idleTimeoutSeconds ?? DEFAULTS.idleTimeoutSeconds,
    maxCallSeconds: raw.maxCallSeconds ?? DEFAULTS.maxCallSeconds,
  };
}

/**
 * Warnings a reader can act on, reported at startup rather than discovered on
 * a call that connects and then goes quiet.
 */
export function configWarnings(cfg: PlivoPhoneConfig): string[] {
  const out: string[] = [];
  if (!cfg.publicWebhookUrl) {
    out.push(
      "publicWebhookUrl is unset, so Plivo has nowhere to reach the answer webhook or the audio stream.",
    );
  } else if (!cfg.publicWebhookUrl.startsWith("https://")) {
    out.push("publicWebhookUrl must be https, because Plivo derives the wss stream URL from it.");
  }
  if (!cfg.fromNumber) {
    out.push("fromNumber is unset, so no number can be attached and no outbound call can be placed.");
  }
  if (cfg.dmSecurity === "allowlist" && cfg.allowFrom.length === 0) {
    out.push(
      "dmSecurity is allowlist with an empty allowFrom, so every caller is refused. Add numbers, or set dmSecurity to open.",
    );
  }
  const prefixed = cfg.allowFrom.filter((entry) => entry.trim().startsWith("+"));
  if (prefixed.length > 0) {
    // Plivo reports the caller without a leading plus. Matching is digits-only
    // here, so this is a note rather than a failure, but a reader comparing the
    // list with the console will otherwise wonder which form is required.
    out.push(
      `${prefixed.length} allowFrom entr${prefixed.length === 1 ? "y" : "ies"} carr${
        prefixed.length === 1 ? "ies" : "y"
      } a leading plus. Plivo reports the caller without one, and matching ignores it.`,
    );
  }
  if (cfg.dmSecurity === "open") {
    out.push("dmSecurity is open, so any caller reaches the agent and every call spends tokens.");
  }
  return out;
}

/** Derived once so the answer webhook and the stream route cannot disagree. */
export function routeUrls(cfg: PlivoPhoneConfig): { answerUrl: string; streamBase: string } {
  const base = (cfg.publicWebhookUrl ?? "").replace(/\/+$/, "");
  return {
    answerUrl: `${base}${cfg.answerPath}`,
    streamBase: `${base.replace(/^https:/, "wss:")}${cfg.streamPath}`,
  };
}

export function streamUrlFor(cfg: PlivoPhoneConfig, token: string): string {
  const { streamBase } = routeUrls(cfg);
  return `${streamBase}?token=${encodeURIComponent(token)}`;
}

/** One token store per process, shared by the answer route and the stream route. */
export const streamTokens = new StreamTokens();
