import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationIdFromUri,
  appNameFor,
  APP_NAME_PREFIX,
  autoWire,
  isOurApp,
} from "./setup.js";

describe("the Plivo application name", () => {
  it("is keyed by the number so several numbers coexist", () => {
    expect(appNameFor("+14155550100")).toBe("openclaw-plivo-phone-14155550100");
  });

  it("strips every non-digit, however the number was written", () => {
    expect(appNameFor("+1 (415) 555-0100")).toBe(appNameFor("14155550100"));
  });

  it("is never a fixed unkeyed name", () => {
    expect(appNameFor("14155550100")).not.toBe(APP_NAME_PREFIX);
    expect(appNameFor("14155550100")).not.toBe(appNameFor("14155550111"));
  });

  it("recognises an application this plugin created", () => {
    expect(isOurApp("openclaw-plivo-phone-14155550100")).toBe(true);
  });

  it("does not claim an application belonging to something else", () => {
    // Deciding wrongly here rewires a number away from whatever owns it.
    for (const foreign of [
      "hermes-plivo-voice-14155550100",
      "my-own-app",
      "openclaw-plivo-sms-14155550100",
      "",
    ]) {
      expect(isOurApp(foreign)).toBe(false);
    }
  });

  it("does not treat the bare prefix as one of ours", () => {
    // A bare prefix with no number is not a name this plugin produces, and
    // matching it would let an unkeyed application be modified.
    expect(isOurApp(APP_NAME_PREFIX)).toBe(false);
  });
});

describe("reading an application id out of a resource URI", () => {
  it("takes the trailing id", () => {
    expect(applicationIdFromUri("/v1/Account/MA1/Application/12345/")).toBe("12345");
  });

  it("returns empty for an empty URI", () => {
    expect(applicationIdFromUri("")).toBe("");
  });

  it("distinguishes ids where one is a prefix of the other", () => {
    // A substring test would read 12345 as already ours when our id is 1234.
    expect(applicationIdFromUri("/v1/Account/MA1/Application/12345/")).not.toBe("1234");
  });
});

describe("claiming a number that something else already holds", () => {
  const creds = { authId: "MA1", authToken: "tok" };
  const base = {
    number: "+14155550100",
    publicBaseUrl: "https://agent.example.com",
    answerPath: "/plivo-phone/answer",
  };

  /** Routes each Plivo call to a canned response, and records what was requested. */
  function stubPlivo(routes: Array<[RegExp, string, number, unknown]>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace("https://api.plivo.com/v1/Account/MA1", "")}`);
      for (const [pattern, wantMethod, status, body] of routes) {
        if (pattern.test(url) && method === wantMethod) {
          return {
            status,
            text: async () => JSON.stringify(body),
          } as unknown as Response;
        }
      }
      return { status: 404, text: async () => "{}" } as unknown as Response;
    });
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves the number alone when the owning application cannot be read", async () => {
    // A 500 says nothing about who holds the number. Treating that as "nobody"
    // is how a number wired to another application gets taken.
    const calls = stubPlivo([
      [/\/Application\/\?/, "GET", 200, { objects: [] }],
      [/\/Application\/$/, "POST", 201, { app_id: "999" }],
      [/\/Number\/14155550100\/$/, "GET", 200, { application: "/v1/Account/MA1/Application/777/" }],
      [/\/Application\/777\/$/, "GET", 500, {}],
    ]);

    const result = await autoWire({ ...creds, ...base });

    expect(result.wired).toBe(false);
    expect(result.note).toContain("could not be read");
    // The decisive assertion: the number was never claimed.
    expect(calls.some((c) => c.startsWith("POST /Number/"))).toBe(false);
  });

  it("leaves the number alone when a foreign application owns it", async () => {
    const calls = stubPlivo([
      [/\/Application\/\?/, "GET", 200, { objects: [] }],
      [/\/Application\/$/, "POST", 201, { app_id: "999" }],
      [/\/Number\/14155550100\/$/, "GET", 200, { application: "/v1/Account/MA1/Application/777/" }],
      [/\/Application\/777\/$/, "GET", 200, { app_name: "someone-elses-app" }],
    ]);

    const result = await autoWire({ ...creds, ...base });

    expect(result.wired).toBe(false);
    expect(result.note).toContain("someone-elses-app");
    expect(calls.some((c) => c.startsWith("POST /Number/"))).toBe(false);
  });

  it("claims a number that is free", async () => {
    const calls = stubPlivo([
      [/\/Application\/\?/, "GET", 200, { objects: [] }],
      [/\/Application\/$/, "POST", 201, { app_id: "999" }],
      [/\/Number\/14155550100\/$/, "GET", 200, { application: "" }],
      [/\/Number\/14155550100\/$/, "POST", 202, {}],
    ]);

    const result = await autoWire({ ...creds, ...base });

    expect(result.wired).toBe(true);
    expect(calls.some((c) => c.startsWith("POST /Number/"))).toBe(true);
  });
});
