import { describe, expect, it } from "vitest";
import { appNameFor, APP_NAME_PREFIX, isOurApp } from "./setup.js";

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
