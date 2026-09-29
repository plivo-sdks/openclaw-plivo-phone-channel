/**
 * Wire shapes for Plivo Audio Streaming, and the answer XML that opens a stream.
 *
 * Only the frames this plugin consumes are typed.
 */

export type PlivoPhoneConfig = {
  authId: string;
  authToken: string;
  fromNumber?: string;
  publicWebhookUrl?: string;
  answerPath: string;
  streamPath: string;
  autoWire: boolean;
  dmSecurity: "allowlist" | "open";
  allowFrom: string[];
  /**
   * Numbers the agent may call. Independent of allowFrom and of dmSecurity,
   * because an outbound call spends money and rings a stranger, where an
   * unexpected inbound call only spends tokens. Empty refuses every outbound
   * call.
   */
  allowDestinations: string[];
  idleTimeoutSeconds: number;
  maxCallSeconds: number;
  /**
   * System prompt for the caller-facing agent. Without one the caller reaches a
   * bare realtime model with no brief at all, which is rarely what a phone
   * number is for.
   */
  instructions?: string;
  /**
   * What the agent says on answering, before the caller speaks. A phone call
   * that opens with silence reads as a dead line and gets hung up on, so this
   * defaults to a greeting rather than to nothing. An empty string disables it
   * and waits for the caller to speak first.
   */
  greeting?: string;
  /**
   * Log transcribed speech. Off by default, because a phone transcript is the
   * content of somebody's conversation.
   */
  logTranscripts?: boolean;
};

/** Plivo negotiates this exact subprotocol; the handshake fails otherwise. */
export const PLIVO_WS_SUBPROTOCOL = "audio.plivo.com";

/**
 * G.711 mu-law at 8 kHz. Plivo defaults <Stream> to audio/x-l16;rate=8000, so
 * this has to be set explicitly. The rate is 8 kHz in both directions, never
 * 16 kHz.
 */
export const STREAM_CONTENT_TYPE = "audio/x-mulaw;rate=8000";
export const PLAY_AUDIO_CONTENT_TYPE = "audio/x-mulaw";
export const PLIVO_SAMPLE_RATE = 8000;

export type PlivoStartFrame = {
  event: "start";
  sequenceNumber?: number;
  start: {
    callId: string;
    streamId: string;
    accountId?: string;
    tracks?: string[];
    mediaFormat?: { encoding?: string; sampleRate?: number };
  };
};

export type PlivoMediaFrame = {
  event: "media";
  sequenceNumber?: number;
  streamId?: string;
  media: {
    track?: string;
    timestamp?: string;
    chunk?: number;
    payload: string;
  };
};

export type PlivoDtmfFrame = { event: "dtmf"; dtmf: { digit: string } };

/**
 * playedStream answers a checkpoint and clearedAudio answers a clearAudio.
 * Both arrive from Plivo despite being replies to something this plugin sent.
 */
export type PlivoAckFrame = {
  event: "playedStream" | "clearedAudio";
  name?: string;
};

/**
 * Undocumented in the current protocol reference, which lists no stop input and
 * says termination reaches the server on statusCallbackUrl. It still appears
 * across Plivo's own examples, so it is handled and socket close remains the
 * authoritative end of stream.
 */
export type PlivoStopFrame = { event: "stop" };

export type PlivoInboundFrame =
  | PlivoStartFrame
  | PlivoMediaFrame
  | PlivoDtmfFrame
  | PlivoAckFrame
  | PlivoStopFrame;

export function parseFrame(raw: string): PlivoInboundFrame | null {
  try {
    const parsed = JSON.parse(raw) as { event?: string };
    return parsed && typeof parsed.event === "string"
      ? (parsed as PlivoInboundFrame)
      : null;
  } catch {
    return null;
  }
}

/**
 * Attributes are ordered alphabetically to match the reference document, which was
 * generated from plivoxml. The WebSocket URL is element text rather than an
 * attribute.
 */
export function answerXml(
  wsUrl: string,
  contentType: string = STREAM_CONTENT_TYPE,
): string {
  return (
    "<Response><Stream " +
    'bidirectional="true" ' +
    `contentType="${escapeXml(contentType)}" ` +
    'keepCallAlive="true">' +
    escapeXml(wsUrl) +
    "</Stream></Response>"
  );
}

export function hangupXml(): string {
  return "<Response><Hangup/></Response>";
}

/** Server to Plivo. Fixture F4. */
export function playAudio(payloadBase64: string): string {
  return JSON.stringify({
    event: "playAudio",
    media: {
      contentType: PLAY_AUDIO_CONTENT_TYPE,
      sampleRate: PLIVO_SAMPLE_RATE,
      payload: payloadBase64,
    },
  });
}

/**
 * Plivo answers a checkpoint with playedStream once it has actually played up
 * to the mark. Frames are paced ahead of real time, so the send loop returning
 * means the audio was handed over rather than heard, and anything sequenced
 * after a reply waits on the ack.
 */
export function checkpoint(streamId: string, name: string): string {
  return JSON.stringify({ event: "checkpoint", streamId, name });
}

/** Flushes what Plivo has buffered. Stopping the send loop alone does not. */
export function clearAudio(streamId: string): string {
  return JSON.stringify({ event: "clearAudio", streamId });
}

/** Drives an IVR on the far end. Digits 0-9, star, hash and A to D. */
export function sendDtmf(digits: string): string {
  return JSON.stringify({ event: "sendDTMF", dtmf: digits });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
