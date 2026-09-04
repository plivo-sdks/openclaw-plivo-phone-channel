import { describe, expect, it } from "vitest";
import { configWarnings, resolveConfig, routeUrls, streamUrlFor } from "./channel.js";

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
      idleTimeoutSeconds: 60,
      maxCallSeconds: 600,
    });
  });

  it("keeps an explicit false for autoWire rather than defaulting it back to true", () => {
    expect(resolveConfig({ ...minimal, autoWire: false })?.autoWire).toBe(false);
  });

  it("keeps an explicit zero for the timeouts, which means disabled", () => {
    const cfg = resolveConfig({ ...minimal, idleTimeoutSeconds: 0, maxCallSeconds: 0 });
    expect([cfg?.idleTimeoutSeconds, cfg?.maxCallSeconds]).toEqual([0, 0]);
  });
});

describe("startup warnings", () => {
  it("names a missing public URL, since Plivo then has nowhere to connect", () => {
    const cfg = resolveConfig(minimal)!;
    expect(configWarnings(cfg).join(" ")).toContain("publicWebhookUrl is unset");
  });

  it("rejects a non-https public URL, because the stream URL derives from it", () => {
    const cfg = resolveConfig({ ...minimal, publicWebhookUrl: "http://example.com" })!;
    expect(configWarnings(cfg).join(" ")).toContain("must be https");
  });

  it("names an allowlist that would refuse every caller", () => {
    const cfg = resolveConfig({ ...minimal, dmSecurity: "allowlist", allowFrom: [] })!;
    expect(configWarnings(cfg).join(" ")).toContain("every caller is refused");
  });

  it("notes a leading plus in the allowlist, which is the form Plivo does not send", () => {
    const cfg = resolveConfig({ ...minimal, allowFrom: ["+14155550100"] })!;
    expect(configWarnings(cfg).join(" ")).toContain("leading plus");
  });

  it("says so when the policy admits every caller", () => {
    const cfg = resolveConfig({ ...minimal, dmSecurity: "open" })!;
    expect(configWarnings(cfg).join(" ")).toContain("any caller reaches the agent");
  });

  it("stays quiet on a complete configuration", () => {
    const cfg = resolveConfig({
      ...minimal,
      fromNumber: "+14155550100",
      publicWebhookUrl: "https://agent.example.com",
      allowFrom: ["14155550111"],
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
    expect(routeUrls(cfg).streamBase).toBe("wss://agent.example.com/plivo-phone/stream");
  });

  it("strips a trailing slash from the base so paths do not double up", () => {
    expect(routeUrls(cfg).answerUrl).toBe("https://agent.example.com/plivo-phone/answer");
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
