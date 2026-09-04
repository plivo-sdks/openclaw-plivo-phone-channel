import { describe, expect, it } from "vitest";
import { callerAllowed, computeSignature, StreamTokens, verifySignature } from "./webhook.js";

/**
 * The signature fixture and every listed mistake come from
 * plivo-kb/webhook-signature-v3.md. That entry caught a shipped bug in another
 * integration where the literal "?" was missing from the signed string, so the
 * canonical form is asserted rather than assumed.
 */
describe("the V3 canonical string", () => {
  const authToken = "test-token";
  const nonce = "12345";

  it("keeps the literal question mark even with no query", async () => {
    const withMark = computeSignature({
      url: "https://example.com/answer",
      nonce,
      authToken,
      form: { CallUUID: "abc" },
    });
    // Recomputing without the "?" must not agree, or the missing-"?" bug would
    // pass unnoticed exactly as it did before.
    const { createHmac } = await import("node:crypto");
    const withoutMark = createHmac("sha256", authToken)
      .update(`https://example.com/answerCallUUIDabc.${nonce}`)
      .digest("base64");
    expect(withMark).not.toBe(withoutMark);
  });

  it("joins body params as key then value with no separator, sorted by key", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", authToken)
      .update(`https://example.com/answer?AaBbCc.${nonce}`)
      .digest("base64");
    expect(
      computeSignature({
        url: "https://example.com/answer",
        nonce,
        authToken,
        form: { C: "c", A: "a", B: "b" },
      }),
    ).toBe(expected);
  });

  it("is stable regardless of the order params arrive in", () => {
    const one = computeSignature({
      url: "https://example.com/answer",
      nonce,
      authToken,
      form: { From: "14155550100", To: "14155550111" },
    });
    const two = computeSignature({
      url: "https://example.com/answer",
      nonce,
      authToken,
      form: { To: "14155550111", From: "14155550100" },
    });
    expect(one).toBe(two);
  });
});

describe("verification", () => {
  const authToken = "test-token";
  const url = "https://example.com/answer";
  const nonce = "n-1";
  const form = { CallUUID: "abc", From: "14155550100" };
  const good = computeSignature({ url, nonce, authToken, form });

  it("accepts the matching signature", () => {
    expect(verifySignature({ signatures: [good], nonce, url, authToken, form })).toBe(true);
  });

  it("accepts a match among comma-separated candidates", () => {
    // An account with several auth tokens receives one signature per token.
    expect(
      verifySignature({ signatures: [`bogus,${good},alsobogus`], nonce, url, authToken, form }),
    ).toBe(true);
  });

  it("accepts the voice header or the messaging header, since both may arrive", () => {
    expect(verifySignature({ signatures: ["", good], nonce, url, authToken, form })).toBe(true);
  });

  it("fails closed when no signature is present", () => {
    expect(verifySignature({ signatures: [], nonce, url, authToken, form })).toBe(false);
    expect(verifySignature({ signatures: ["", ""], nonce, url, authToken, form })).toBe(false);
  });

  it("fails closed with no nonce", () => {
    expect(verifySignature({ signatures: [good], nonce: undefined, url, authToken, form })).toBe(
      false,
    );
  });

  it("rejects a body that was altered in flight", () => {
    expect(
      verifySignature({
        signatures: [good],
        nonce,
        url,
        authToken,
        form: { ...form, From: "14155550999" },
      }),
    ).toBe(false);
  });
});

describe("the per-call stream token", () => {
  it("redeems once and then refuses a replay", () => {
    const tokens = new StreamTokens();
    const token = tokens.mint("call-1");
    expect(tokens.redeem(token)).toBe("call-1");
    expect(tokens.redeem(token)).toBeNull();
  });

  it("refuses a token that was never issued", () => {
    expect(new StreamTokens().redeem("made-up")).toBeNull();
  });

  it("refuses an expired token", () => {
    const tokens = new StreamTokens();
    const token = tokens.mint("call-1", 0);
    expect(tokens.redeem(token, 61_000)).toBeNull();
  });
});

describe("the caller allowlist", () => {
  it("matches a number written without the leading plus, which is how Plivo sends it", () => {
    expect(callerAllowed("14155550100", "allowlist", ["14155550100"])).toBe(true);
  });

  it("still matches when the list carries a plus the caller ID does not", () => {
    // The Hermes plugin shipped a bug here: a list entry written with a leading
    // plus never matched, and the call connected before going silent.
    expect(callerAllowed("14155550100", "allowlist", ["+1 (415) 555-0100"])).toBe(true);
  });

  it("refuses a caller not on the list", () => {
    expect(callerAllowed("14155559999", "allowlist", ["14155550100"])).toBe(false);
  });

  it("admits every caller when the policy is open", () => {
    expect(callerAllowed("14155559999", "open", [])).toBe(true);
  });

  it("refuses every caller when the policy is allowlist and the list is empty", () => {
    // An empty allowlist must not mean "allow all". Every call spends tokens.
    expect(callerAllowed("14155550100", "allowlist", [])).toBe(false);
  });
});
