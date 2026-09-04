/**
 * The Plivo Audio Streaming transport, expressed as a RealtimeVoiceAudioSink.
 *
 * OpenClaw's realtime voice layer owns the conversation, the codec helpers, the
 * speech gate and the barge-in decision. This file is only the mapping between
 * its four sink operations and Plivo's four frame names, plus the inbound
 * direction back into the session.
 *
 *   sink.sendAudio   -> playAudio      media -> session.sendAudio
 *   sink.clearAudio  -> clearAudio     playedStream -> session.acknowledgeMark
 *   sink.sendMark    -> checkpoint     clearedAudio -> nothing to do
 *   sink.isOpen      -> socket state   socket close -> session.close
 *
 * Frame names are the difference from the bundled voice-call plugin's Twilio
 * path, which speaks streamSid, media, mark and clear.
 */

import type { WebSocket } from "ws";
import {
  checkpoint,
  clearAudio,
  parseFrame,
  playAudio,
  sendDtmf,
  type PlivoMediaFrame,
  type PlivoStartFrame,
} from "./types.js";

export type StreamSession = {
  /** Fed each caller audio chunk, already mu-law decoded by the caller. */
  sendAudio: (audio: Buffer) => void;
  /** Called when Plivo confirms playback reached a mark. */
  acknowledgeMark: (markName?: string) => void;
  /** Called with a keypad digit. */
  sendDigit?: (digit: string) => void;
  close: () => void;
};

export type PlivoStreamHandle = {
  /** Handed to createRealtimeVoiceBridgeSession as its audioSink. */
  sink: {
    isOpen: () => boolean;
    sendAudio: (audio: Buffer) => void;
    clearAudio: () => void;
    sendMark: (markName: string) => void;
  };
  /** Drives one Plivo text frame into the session. */
  handleFrame: (raw: string) => void;
  /** Sends keypad digits to the far end, for an agent driving an IVR. */
  sendDigits: (digits: string) => void;
  callId: () => string;
  streamId: () => string;
};

export function createPlivoStream(params: {
  ws: WebSocket;
  session: StreamSession;
  onStart?: (start: PlivoStartFrame["start"]) => void;
  onLog?: (message: string) => void;
}): PlivoStreamHandle {
  let streamId = "";
  let callId = "";
  let closed = false;

  const isOpen = () => !closed && params.ws.readyState === 1;

  const send = (payload: string) => {
    if (!isOpen()) {
      return;
    }
    try {
      params.ws.send(payload);
    } catch (err) {
      // The socket may already be gone with the call. Losing a frame at that
      // point is expected rather than an error worth surfacing.
      params.onLog?.(`plivo-phone: dropped a frame on a closing socket: ${String(err)}`);
    }
  };

  return {
    sink: {
      isOpen,
      sendAudio: (audio: Buffer) => send(playAudio(audio.toString("base64"))),
      clearAudio: () => {
        if (streamId) {
          send(clearAudio(streamId));
        }
      },
      sendMark: (markName: string) => {
        if (streamId) {
          send(checkpoint(streamId, markName));
        }
      },
    },

    handleFrame: (raw: string) => {
      const frame = parseFrame(raw);
      if (!frame) {
        return;
      }
      switch (frame.event) {
        case "start": {
          const start = (frame as PlivoStartFrame).start;
          streamId = String(start?.streamId ?? "");
          callId = String(start?.callId ?? "");
          params.onStart?.(start);
          return;
        }
        case "media": {
          const payload = (frame as PlivoMediaFrame).media?.payload;
          if (payload) {
            params.session.sendAudio(Buffer.from(payload, "base64"));
          }
          return;
        }
        case "dtmf": {
          const digit = (frame as { dtmf?: { digit?: string } }).dtmf?.digit;
          if (digit) {
            params.session.sendDigit?.(digit);
          }
          return;
        }
        case "playedStream": {
          // The only signal that audio was heard rather than merely handed over.
          params.session.acknowledgeMark((frame as { name?: string }).name);
          return;
        }
        case "clearedAudio":
          return;
        case "stop": {
          // Undocumented in the current protocol reference, so socket close
          // stays the authoritative end of stream and this is an early exit.
          closed = true;
          params.session.close();
          return;
        }
        default:
          return;
      }
    },

    sendDigits: (digits: string) => send(sendDtmf(digits)),
    callId: () => callId,
    streamId: () => streamId,
  };
}

/**
 * Socket close ends the call.
 *
 * The protocol reference documents no stop frame arriving on the socket and
 * says termination reaches the server on statusCallbackUrl, so a server that
 * waits for stop can wait forever. With keepCallAlive set, an unreaped dead
 * stream leaves the call billing until streamTimeout, which defaults to 86400
 * seconds.
 */
export function attachCloseHandling(params: {
  ws: WebSocket;
  session: StreamSession;
  onLog?: (message: string) => void;
}): void {
  const end = (why: string) => {
    params.onLog?.(`plivo-phone: stream ended (${why})`);
    params.session.close();
  };
  params.ws.on("close", () => end("socket closed"));
  params.ws.on("error", (err: Error) => end(`socket error: ${err.message}`));
}
