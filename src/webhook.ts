/**
 * Answer-callback authenticity and the per-call stream token.
 *
 * Voice callbacks are signed under X-Plivo-Signature-V3. Inbound messaging uses
 * X-Plivo-Signature-MA-V3 instead, and verifying the wrong family rejects every
 * genuine request. Both are accepted here because which one arrives depends on
 * the channel and Plivo's own docs disagree about which exists. The algorithm is
 * the one in plivo-kb/webhook-signature-v3.md.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as querystring from "node:querystring";

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

export function parseFormBody(body: string): Record<string, string> {
  const parsed = querystring.parse(body);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = firstString(value);
  }
  return out;
}

export async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
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
    : { base: withoutFragment.slice(0, cut), query: withoutFragment.slice(cut + 1) };
}

function sortedQueryString(query: string): string {
  const parsed = querystring.parse(query);
  return Object.keys(parsed)
    .sort()
    .map((key) => `${key}${firstString(parsed[key])}`)
    .join("");
}

function sortedParamsString(form: Record<string, string>): string {
  return Object.keys(form)
    .sort()
    .map((key) => `${key}${form[key] ?? ""}`)
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
  form: Record<string, string>;
}): string {
  const { base, query } = splitUrlQuery(params.url);
  const querySegment = query ? `${sortedQueryString(query)}.` : "";
  const signedString = `${base}?${querySegment}${sortedParamsString(params.form)}.${params.nonce}`;
  return createHmac("sha256", params.authToken).update(signedString).digest("base64");
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
  form: Record<string, string>;
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

export function verifyAnswerCallback(params: {
  req: IncomingMessage;
  url: string;
  authToken: string;
  form: Record<string, string>;
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
  private readonly issued = new Map<string, { callId: string; expiresAt: number }>();

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

/** Plivo reports the caller without a leading plus, so the list is matched the same way. */
export function callerAllowed(
  caller: string,
  policy: "allowlist" | "open",
  allowFrom: string[],
): boolean {
  if (policy === "open") {
    return true;
  }
  const digits = caller.replace(/\D/g, "");
  return allowFrom.some((entry) => entry.replace(/\D/g, "") === digits);
}
