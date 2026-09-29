import { describe, expect, it } from "vitest";
import {
  callerAllowed,
  field,
  computeSignature,
  configWarnings,
  destinationAllowed,
  remoteParty,
  resolveConfig,
  routeUrls,
  streamUrlFor,
  StreamTokens,
  verifySignature,
} from "./utils.js";
const minimal = { authId: "MA123", authToken: "tok" };

describe("configuration resolution", () => {
  it("refuses to resolve without credentials, rather than half-registering", () => {
    expect(resolveConfig(undefined)).toBeNull();
    expect(resolveConfig({ authId: "MA123" })).toBeNull();
    expect(resolveConfig({ authToken: "tok" })).toBeNull();
  });

  it("applies the documented defaults", () => {
    const cfg = resolveConfig(minimal);
    expect(cfg).toMatchObject({
      answerPath: "/plivo-phone/answer",
      streamPath: "/plivo-phone/stream",
      autoWire: true,
      dmSecurity: "allowlist",
      allowFrom: [],
      allowDestinations: [],
      idleTimeoutSeconds: 60,
      maxCallSeconds: 600,
    });
  });

  it("keeps an explicit false for autoWire rather than defaulting it back to true", () => {
    expect(resolveConfig({ ...minimal, autoWire: false })?.autoWire).toBe(
      false,
    );
  });

  it("keeps an explicit zero for the timeouts, which means disabled", () => {
    const cfg = resolveConfig({
      ...minimal,
      idleTimeoutSeconds: 0,
      maxCallSeconds: 0,
    });
    expect([cfg?.idleTimeoutSeconds, cfg?.maxCallSeconds]).toEqual([0, 0]);
  });
});

describe("startup warnings", () => {
  it("names a missing public URL, since Plivo then has nowhere to connect", () => {
    const cfg = resolveConfig(minimal)!;
    expect(configWarnings(cfg).join(" ")).toContain(
      "publicWebhookUrl is unset",
    );
  });

  it("rejects a non-https public URL, because the stream URL derives from it", () => {
    const cfg = resolveConfig({
      ...minimal,
      publicWebhookUrl: "http://example.com",
    })!;
    expect(configWarnings(cfg).join(" ")).toContain("must be https");
  });

  it("names an allowlist that would refuse every caller", () => {
    const cfg = resolveConfig({
      ...minimal,
      dmSecurity: "allowlist",
      allowFrom: [],
    })!;
    expect(configWarnings(cfg).join(" ")).toContain("every caller is refused");
  });

  it("notes a leading plus in the allowlist, which is the form Plivo does not send", () => {
    const cfg = resolveConfig({ ...minimal, allowFrom: ["+14155550100"] })!;
    expect(configWarnings(cfg).join(" ")).toContain("leading plus");
  });

  it("says so when the policy admits every caller", () => {
    const cfg = resolveConfig({ ...minimal, dmSecurity: "open" })!;
    expect(configWarnings(cfg).join(" ")).toContain(
      "any caller reaches the agent",
    );
  });

  it("stays quiet on a complete configuration", () => {
    const cfg = resolveConfig({
      ...minimal,
      fromNumber: "+14155550100",
      publicWebhookUrl: "https://agent.example.com",
      allowFrom: ["14155550111"],
      allowDestinations: ["14155550222"],
    })!;
    expect(configWarnings(cfg)).toEqual([]);
  });
});

describe("route URLs", () => {
  const cfg = resolveConfig({
    ...minimal,
    publicWebhookUrl: "https://agent.example.com/",
    fromNumber: "+14155550100",
  })!;

  it("derives the stream URL as wss from the https base", () => {
    // Plivo refuses a stream URL that is not wss, and deriving it rather than
    // configuring it separately stops the two from drifting apart.
    expect(routeUrls(cfg).streamBase).toBe(
      "wss://agent.example.com/plivo-phone/stream",
    );
  });

  it("strips a trailing slash from the base so paths do not double up", () => {
    expect(routeUrls(cfg).answerUrl).toBe(
      "https://agent.example.com/plivo-phone/answer",
    );
  });

  it("carries the per-call token on the stream URL, escaped", () => {
    // A space, a slash and a plus all change meaning in a query string if they
    // survive unescaped, and a plus in particular decodes back to a space.
    const raw = "a b/+";
    const parsed = new URL(streamUrlFor(cfg, raw).replace(/^wss:/, "https:"));
    expect(parsed.pathname).toBe("/plivo-phone/stream");
    expect(parsed.searchParams.get("token")).toBe(raw);
  });
});

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
    expect(
      verifySignature({ signatures: [good], nonce, url, authToken, form }),
    ).toBe(true);
  });

  it("accepts a match among comma-separated candidates", () => {
    // An account with several auth tokens receives one signature per token.
    expect(
      verifySignature({
        signatures: [`bogus,${good},alsobogus`],
        nonce,
        url,
        authToken,
        form,
      }),
    ).toBe(true);
  });

  it("accepts the voice header or the messaging header, since both may arrive", () => {
    expect(
      verifySignature({ signatures: ["", good], nonce, url, authToken, form }),
    ).toBe(true);
  });

  it("fails closed when no signature is present", () => {
    expect(
      verifySignature({ signatures: [], nonce, url, authToken, form }),
    ).toBe(false);
    expect(
      verifySignature({ signatures: ["", ""], nonce, url, authToken, form }),
    ).toBe(false);
  });

  it("fails closed with no nonce", () => {
    expect(
      verifySignature({
        signatures: [good],
        nonce: undefined,
        url,
        authToken,
        form,
      }),
    ).toBe(false);
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
    expect(callerAllowed("14155550100", "allowlist", ["14155550100"])).toBe(
      true,
    );
  });

  it("still matches when the list carries a plus the caller ID does not", () => {
    // The Hermes plugin shipped a bug here: a list entry written with a leading
    // plus never matched, and the call connected before going silent.
    expect(
      callerAllowed("14155550100", "allowlist", ["+1 (415) 555-0100"]),
    ).toBe(true);
  });

  it("refuses a caller not on the list", () => {
    expect(callerAllowed("14155559999", "allowlist", ["14155550100"])).toBe(
      false,
    );
  });

  it("admits every caller when the policy is open", () => {
    expect(callerAllowed("14155559999", "open", [])).toBe(true);
  });

  it("refuses every caller when the policy is allowlist and the list is empty", () => {
    // An empty allowlist must not mean "allow all". Every call spends tokens.
    expect(callerAllowed("14155550100", "allowlist", [])).toBe(false);
  });

  it("refuses a wildcard entry rather than reading it as allow all", () => {
    // Both sides reduce to digits, so "*" reduced to the empty string and
    // matched only a call carrying no number. The entry read as admitting
    // everyone while admitting anonymous callers alone.
    expect(callerAllowed("14155550100", "allowlist", ["*"])).toBe(false);
    expect(callerAllowed("", "allowlist", ["*"])).toBe(false);
  });

  it("refuses a call that arrives with no number", () => {
    expect(callerAllowed("", "allowlist", ["14155550100"])).toBe(false);
  });
});

describe("the outbound destination list", () => {
  it("permits a number on the list", () => {
    expect(destinationAllowed("14155550100", ["14155550100"])).toBe(true);
  });

  it("ignores a leading plus on either side", () => {
    expect(destinationAllowed("+14155550100", ["14155550100"])).toBe(true);
    expect(destinationAllowed("14155550100", ["+1 (415) 555-0100"])).toBe(true);
  });

  it("refuses every destination when the list is empty", () => {
    // Unlike the inbound default, this one costs money and rings a stranger,
    // so dialling stays off until the numbers are named.
    expect(destinationAllowed("14155550100", [])).toBe(false);
  });

  it("refuses a destination not on the list", () => {
    expect(destinationAllowed("14155559999", ["14155550100"])).toBe(false);
  });

  it("refuses a wildcard entry", () => {
    expect(destinationAllowed("14155550100", ["*"])).toBe(false);
  });
});

describe("the remote party on an answer callback", () => {
  it("reads the caller from From on an inbound call", () => {
    expect(
      remoteParty({ Direction: "inbound", From: "14155550100", To: "14245502321" }),
    ).toEqual({ number: "14155550100", outbound: false });
  });

  it("reads the destination from To on an outbound call", () => {
    // From holds this account's own Plivo number on an outbound leg, so reading
    // From either way gates the call on the Plivo number and refuses it.
    expect(
      remoteParty({ Direction: "outbound", From: "14245502321", To: "14155550100" }),
    ).toEqual({ number: "14155550100", outbound: true });
  });

  it("treats a missing direction as inbound", () => {
    expect(remoteParty({ From: "14155550100" })).toEqual({
      number: "14155550100",
      outbound: false,
    });
  });

  it("matches the direction case-insensitively and by prefix", () => {
    // Plivo has used both "outbound" and "outbound-api" on this field.
    expect(remoteParty({ Direction: "Outbound-API", To: "14155550100" }).outbound).toBe(
      true,
    );
  });
});

describe("the caller-facing agent settings", () => {
  it("greets by default, because a silent line reads as a dead one", () => {
    expect(resolveConfig(minimal)?.greeting).toBeTruthy();
  });

  it("lets an empty greeting mean wait for the caller to speak first", () => {
    // ?? rather than ||, or an explicit empty string would fall back to the
    // default and the agent would open anyway.
    expect(resolveConfig({ ...minimal, greeting: "" })?.greeting).toBe("");
  });

  it("carries the system prompt through untouched", () => {
    expect(
      resolveConfig({ ...minimal, instructions: "Answer as the front desk." })
        ?.instructions,
    ).toBe("Answer as the front desk.");
  });

  it("keeps transcript logging off unless it is asked for", () => {
    // A phone transcript is the content of somebody's conversation.
    expect(resolveConfig(minimal)?.logTranscripts).toBe(false);
    expect(resolveConfig({ ...minimal, logTranscripts: true })?.logTranscripts).toBe(
      true,
    );
  });
});

describe("the V3 canonical string with repeated and query parameters", () => {
  const authToken = "test-token";
  const nonce = "12345";

  it("signs every value of a repeated key, sorted, not just the first", async () => {
    // The SDK folds a list value by sorting it and repeating the key before each
    // entry. Collapsing to the first value produces a different signed string, so
    // a genuine callback carrying a repeated key would be refused with 403.
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", authToken)
      .update(`https://example.com/answer?HAaHBb.${nonce}`)
      .digest("base64");
    expect(
      computeSignature({
        url: "https://example.com/answer",
        nonce,
        authToken,
        form: { H: ["Bb", "Aa"] },
      }),
    ).toBe(expected);
  });

  it("does not agree with the first-value-only form it used to produce", () => {
    const both = computeSignature({
      url: "https://example.com/answer",
      nonce,
      authToken,
      form: { H: ["Aa", "Bb"] },
    });
    const firstOnly = computeSignature({
      url: "https://example.com/answer",
      nonce,
      authToken,
      form: { H: "Aa" },
    });
    expect(both).not.toBe(firstOnly);
  });

  it("folds a URL query as sorted key=value pairs joined by ampersands", async () => {
    // Body params concatenate with no separator, but a query segment keeps its
    // "=" and "&" and is followed by a ".". Reusing the body format here silently
    // rejects every callback on a query-bearing answer URL.
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", authToken)
      .update(`https://example.com/answer?a=1&b=2.From9.${nonce}`)
      .digest("base64");
    expect(
      computeSignature({
        url: "https://example.com/answer?b=2&a=1",
        nonce,
        authToken,
        form: { From: "9" },
      }),
    ).toBe(expected);
  });
});

describe("reading a field from a parsed body", () => {
  it("returns the first value when a key repeats", () => {
    expect(field({ From: ["1", "2"] }, "From")).toBe("1");
  });

  it("returns an empty string for a key that is absent", () => {
    expect(field({}, "From")).toBe("");
  });

  it("reads the far party correctly when the direction field repeats", () => {
    expect(remoteParty({ Direction: ["outbound"], To: ["9"], From: ["1"] })).toEqual({
      number: "9",
      outbound: true,
    });
  });
});
