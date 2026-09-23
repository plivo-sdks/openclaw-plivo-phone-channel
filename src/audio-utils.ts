/**
 * Audio measurement, kept out of the adapter.
 *
 * The plugin conventions put every codec transform, resample and energy
 * calculation in one audio module and keep audio maths out of the adapter,
 * which holds host glue and event handling only.
 */

import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";

/**
 * Root-mean-square above which a frame counts as speech rather than line noise.
 *
 * The host has its own gate for this, but `calculateMulawRms` and
 * `createSpeechThresholdGate` are internal to the realtime handler and are NOT
 * re-exported by `openclaw/plugin-sdk/realtime-voice` in 2026.7.1. Only
 * `mulawToPcm` is public, and it is enough.
 */
export const SPEECH_RMS_THRESHOLD = 500;

/**
 * Whether a frame of caller audio carries speech.
 *
 * Plivo streams continuously, so a silent caller still produces a frame every
 * 20 ms. Counting frames would therefore never register an idle call, which is
 * why idleTimeoutSeconds needs an energy test rather than a packet test.
 *
 * This decides nothing about what reaches the session. Every frame is still
 * forwarded; see the note in createPlivoStream on why a transport must never
 * hold caller audio back.
 */
export function callerSpeaking(
  mulaw: Buffer,
  threshold: number = SPEECH_RMS_THRESHOLD,
): boolean {
  if (mulaw.length === 0) {
    return false;
  }
  const pcm = mulawToPcm(mulaw);
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return false;
  }
  let sumSquares = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples) >= threshold;
}
