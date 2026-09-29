/**
 * Configuration reading and Plivo callback signature verification (V3).
 *
 * Voice callbacks are signed under X-Plivo-Signature-V3. Inbound messaging uses
 * X-Plivo-Signature-MA-V3 instead, and verifying the wrong family rejects every
 * genuine request. Both are accepted because which one arrives depends on the
 * channel and Plivo's own docs disagree about which exists. The algorithm is the
 * one in plivo-kb/webhook-signature-v3.md.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as querystring from "node:querystring";
import type { PlivoPhoneConfig } from "./audio-streaming.js";

const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const TOKEN_TTL_MS = 60_000;

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return firstString(value[0]);
  }
  return typeof value === "string" ? value : "";
}

export function headerValue(value: string | string[] | undefined): string {
  return firstString(value).trim();
}

/** A parsed callback body. A repeated key keeps every value, because the signature covers them all. */
export type PlivoForm = Record<string, string | string[] | undefined>;

/** The single value a caller means when it reads a field such as From or CallUUID. */
export function field(form: PlivoForm, key: string): string {
  return firstString(form[key]);
}

export function parseFormBody(body: string): PlivoForm {
  return querystring.parse(body) as PlivoForm;
}

export async function readFormBody(
  req: IncomingMessage,
): Promise<PlivoForm> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > WEBHOOK_BODY_LIMIT_BYTES) {
      throw new Error("answer callback body exceeded the size limit");
    }
    chunks.push(buf);
  }
  return parseFormBody(Buffer.concat(chunks).toString("utf8"));
}

function splitUrlQuery(url: string): { base: string; query: string } {
  const withoutFragment = url.split("#")[0] ?? "";
  const cut = withoutFragment.indexOf("?");
  return cut === -1
    ? { base: withoutFragment, query: "" }
    : {
        base: withoutFragment.slice(0, cut),
        query: withoutFragment.slice(cut + 1),
      };
}

function sortedQueryString(query: string): string {
  const parsed = querystring.parse(query) as PlivoForm;
  const pairs: string[] = [];
  for (const key of Object.keys(parsed).sort()) {
    for (const value of valuesOf(parsed[key])) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs.join("&");
}

/** A repeated key contributes every value, sorted, which is what the SDK signs. */
function valuesOf(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return [...value].sort();
  }
  return [value ?? ""];
}

function sortedParamsString(form: PlivoForm): string {
  return Object.keys(form)
    .sort()
    .map((key) => valuesOf(form[key]).map((value) => `${key}${value}`).join(""))
    .join("");
}

/**
 * The literal "?" belongs in the string even with no query, and body params are
 * joined key+value with no separator. Both are places an implementation
 * silently diverges and then rejects every real request.
 */
export function computeSignature(params: {
  url: string;
  nonce: string;
  authToken: string;
  form: PlivoForm;
}): string {
  const { base, query } = splitUrlQuery(params.url);
  const querySegment = query ? `${sortedQueryString(query)}.` : "";
  const signedString = `${base}?${querySegment}${sortedParamsString(params.form)}.${params.nonce}`;
  return createHmac("sha256", params.authToken)
    .update(signedString)
    .digest("base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * A header can carry several comma-separated signatures when the account holds
 * more than one auth token, so every candidate is compared.
 */
export function verifySignature(params: {
  signatures: string[];
  nonce: string | undefined;
  url: string;
  authToken: string;
  form: PlivoForm;
}): boolean {
  if (!params.nonce || !params.url || !params.authToken) {
    return false;
  }
  const present = params.signatures.filter((value) => value.length > 0);
  if (present.length === 0) {
    return false;
  }
  const expected = computeSignature({
    url: params.url,
    nonce: params.nonce,
    authToken: params.authToken,
    form: params.form,
  });
  return present
    .flatMap((header) => header.split(","))
    .some((candidate) => constantTimeEquals(candidate.trim(), expected));
}

/**
 * Deliberately V3 only. Plivo also sends the older V2 family, and the KB entry
 * recommends accepting every family, but V2 signs the base URL and the nonce and
 * folds in no body at all. This callback's body is what decides the allowlist, and
 * nonces are not tracked, so honouring V2 would let anyone who has seen one
 * legitimate callback replay its nonce with a forged From and walk through
 * allowFrom. Widening this is a security regression, not a compatibility fix.
 */
export function verifyAnswerCallback(params: {
  req: IncomingMessage;
  url: string;
  authToken: string;
  form: PlivoForm;
}): boolean {
  return verifySignature({
    signatures: [
      headerValue(params.req.headers["x-plivo-signature-v3"]),
      headerValue(params.req.headers["x-plivo-signature-ma-v3"]),
    ],
    nonce: headerValue(params.req.headers["x-plivo-signature-v3-nonce"]),
    url: params.url,
    authToken: params.authToken,
    form: params.form,
  });
}

/**
 * Per-call token carried on the audio WebSocket URL.
 *
 * The answer callback is signature-verified, the stream connection is not, so
 * without this the stream route would accept any connection that guessed the
 * path. Short-lived because Plivo connects within seconds of the answer.
 */
export class StreamTokens {
  private readonly issued = new Map<
    string,
    { callId: string; expiresAt: number }
  >();

  mint(callId: string, now: number = Date.now()): string {
    this.sweep(now);
    const token = randomBytes(24).toString("base64url");
    this.issued.set(token, { callId, expiresAt: now + TOKEN_TTL_MS });
    return token;
  }

  redeem(token: string, now: number = Date.now()): string | null {
    this.sweep(now);
    const entry = this.issued.get(token);
    if (!entry) {
      return null;
    }
    // Single use. A replayed token must not open a second stream on the call.
    this.issued.delete(token);
    return entry.expiresAt >= now ? entry.callId : null;
  }

  private sweep(now: number): void {
    for (const [token, entry] of this.issued) {
      if (entry.expiresAt < now) {
        this.issued.delete(token);
      }
    }
  }
}

/**
 * Plivo names the remote party differently by direction. On an inbound call the
 * caller is in From, and on an outbound call From holds this account's own
 * number while To holds the person being called. Reading From either way gates
 * an outbound call on the Plivo number rather than on the destination.
 */
export function remoteParty(form: PlivoForm): {
  number: string;
  outbound: boolean;
} {
  const outbound = field(form, "Direction").toLowerCase().startsWith("outbound");
  return { number: field(form, outbound ? "To" : "From"), outbound };
}

/**
 * Plivo reports the caller without a leading plus, so the list is matched the
 * same way.
 *
 * Both sides are reduced to digits, so an entry holding no digits reduces to
 * the empty string. Such an entry is dropped rather than compared, because it
 * would otherwise match only a call arriving with no number at all. An entry of
 * `*` reads as admitting everyone and did the opposite, admitting anonymous
 * callers alone while refusing every real number.
 */
export function callerAllowed(
  caller: string,
  policy: "allowlist" | "open",
  allowFrom: string[],
): boolean {
  if (policy === "open") {
    return true;
  }
  const digits = caller.replace(/\D/g, "");
  if (digits === "") {
    return false;
  }
  return allowFrom.some((entry) => {
    const allowed = entry.replace(/\D/g, "");
    return allowed !== "" && allowed === digits;
  });
}

/**
 * Whether the agent may call this number.
 *
 * Deliberately reads neither allowFrom nor dmSecurity. Letting the inbound list
 * stand in for this one would mean permission to call the agent also granted
 * permission to be called by it, which is not the same decision. An empty list
 * refuses every outbound call, so dialling is off until the numbers are named.
 */
export function destinationAllowed(
  destination: string,
  allowDestinations: string[],
): boolean {
  const digits = destination.replace(/\D/g, "");
  if (digits === "") {
    return false;
  }
  return allowDestinations.some((entry) => {
    const allowed = entry.replace(/\D/g, "");
    return allowed !== "" && allowed === digits;
  });
}

export const CHANNEL_ID = "plivo-phone";

const DEFAULTS = {
  answerPath: "/plivo-phone/answer",
  streamPath: "/plivo-phone/stream",
  autoWire: true,
  dmSecurity: "allowlist" as const,
  idleTimeoutSeconds: 60,
  maxCallSeconds: 600,
  greeting:
    "Greet the caller in one short sentence and ask how you can help. Keep it under three seconds.",
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
    allowDestinations: raw.allowDestinations ?? [],
    idleTimeoutSeconds: raw.idleTimeoutSeconds ?? DEFAULTS.idleTimeoutSeconds,
    maxCallSeconds: raw.maxCallSeconds ?? DEFAULTS.maxCallSeconds,
    instructions: raw.instructions,
    // ?? rather than ||, so an explicit empty string survives and means "say
    // nothing until the caller speaks" instead of falling back to the default.
    greeting: raw.greeting ?? DEFAULTS.greeting,
    logTranscripts: raw.logTranscripts ?? false,
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
    out.push(
      "publicWebhookUrl must be https, because Plivo derives the wss stream URL from it.",
    );
  }
  if (!cfg.fromNumber) {
    out.push(
      "fromNumber is unset, so no number can be attached and no outbound call can be placed.",
    );
  }
  if (cfg.dmSecurity === "allowlist" && cfg.allowFrom.length === 0) {
    out.push(
      "dmSecurity is allowlist with an empty allowFrom, so every caller is refused. Add numbers, or set dmSecurity to open.",
    );
  }
  const prefixed = cfg.allowFrom.filter((entry) =>
    entry.trim().startsWith("+"),
  );
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
    out.push(
      "dmSecurity is open, so any caller reaches the agent and every call spends tokens.",
    );
  }
  if (cfg.allowDestinations.length === 0) {
    out.push(
      "allowDestinations is empty, so the agent places no outbound calls. dmSecurity and allowFrom do not grant this, because permission to call the agent is a different decision from permission to be called by it.",
    );
  }
  const prefixedDestinations = cfg.allowDestinations.filter((entry) =>
    entry.trim().startsWith("+"),
  );
  if (prefixedDestinations.length > 0) {
    out.push(
      `${prefixedDestinations.length} allowDestinations entr${
        prefixedDestinations.length === 1 ? "y" : "ies"
      } carr${
        prefixedDestinations.length === 1 ? "ies" : "y"
      } a leading plus. Plivo reports the number without one, and matching ignores it.`,
    );
  }
  return out;
}

/** Derived once so the answer webhook and the stream route cannot disagree. */
export function routeUrls(cfg: PlivoPhoneConfig): {
  answerUrl: string;
  streamBase: string;
} {
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
