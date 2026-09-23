import { describe, expect, it } from "vitest";
import { pcmToMulaw } from "openclaw/plugin-sdk/realtime-voice";
import { callerSpeaking } from "./audio-utils.js";

/** Builds one frame of mu-law audio at a given amplitude. */
function mulawFrame(amplitude: number, samples = 160): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // Alternating sign, so the frame has energy rather than a DC offset.
    pcm.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return pcmToMulaw(pcm);
}

describe("detecting caller speech", () => {
  it("reads a loud frame as speech", () => {
    expect(callerSpeaking(mulawFrame(8000))).toBe(true);
  });

  it("reads a silent frame as silence, which is what Plivo keeps sending", () => {
    // The point of measuring energy at all. A caller who says nothing still
    // produces a frame every 20 ms, so counting frames never detects an idle
    // call and idleTimeoutSeconds would never fire.
    expect(callerSpeaking(mulawFrame(0))).toBe(false);
  });

  it("treats an empty frame as silence rather than dividing by zero", () => {
    expect(callerSpeaking(Buffer.alloc(0))).toBe(false);
  });
});
