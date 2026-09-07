/**
 * The platform adapter: the two Plivo routes, their handlers, and the bridge
 * between Plivo Audio Streaming and the realtime voice session.
 *
 * The sink below is what the realtime layer consumes, so the heart of this file
 * is the mapping between its four operations and Plivo's four frame names, plus
 * the inbound direction carrying caller audio back into the session.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import {
  createRealtimeVoiceBridgeSession,
  extendRealtimeVoiceOutputEchoSuppression,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  answerXml,
  checkpoint,
  clearAudio,
  hangupXml,
  parseFrame,
  playAudio,
  PLIVO_WS_SUBPROTOCOL,
  sendDtmf,
  type PlivoMediaFrame,
  type PlivoPhoneConfig,
  type PlivoStartFrame,
} from "./audio-streaming.js";
import {
  callerAllowed,
  CHANNEL_ID,
  configWarnings,
  readFormBody,
  resolveConfig,
  routeUrls,
  streamTokens,
  streamUrlFor,
  verifyAnswerCallback,
} from "./utils.js";
import { autoWire } from "./setup.js";

type ChannelsConfig = {
  channels?: Record<string, Partial<PlivoPhoneConfig> | undefined>;
};

/**
 * The channel descriptor. Registration below mounts the routes, while this
 * object is what the rest of the host reads to list the channel, decide what it
 * is able to do, and resolve its account.
 *
 * A call is one caller talking to one agent, so the only chat type is "direct".
 * The reaction, threading and media surfaces are left off because a phone call
 * has no counterpart to any of them, and a descriptor that claims a surface it
 * cannot serve makes the host offer the caller something that then fails.
 */
export const plugin: ChannelPlugin<PlivoPhoneConfig | null> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Plivo Phone",
    selectionLabel: "Plivo Phone",
    docsPath: "docs/openclaw-phone.mdx",
    blurb: "Real-time voice conversations over Plivo Audio Streaming",
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config: {
    // A configuration carries one Plivo number, so there is a single account and
    // it counts as present only once credentials and that number are both set.
    listAccountIds: (cfg: OpenClawConfig) =>
      resolveConfig((cfg as ChannelsConfig)?.channels?.[CHANNEL_ID])
        ? ["default"]
        : [],
    resolveAccount: (cfg: OpenClawConfig) =>
      resolveConfig((cfg as ChannelsConfig)?.channels?.[CHANNEL_ID]),
  },
};

/**
 * Every api.* call must happen before the first await. The loader wraps `api` in
 * a guarded proxy that disables its methods as soon as the synchronous portion
 * of registration returns, so a registration placed after an await becomes a
 * silent no-op and the route never reaches the HTTP route registry. There are
 * two registrations and provisioning to do, so the routes are mounted first and
 * the Plivo side is wired in a detached task afterwards.
 */
export function register(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(
    (api.config as ChannelsConfig)?.channels?.[CHANNEL_ID],
  );
  if (!cfg) {
    api.logger?.warn?.(
      `[${CHANNEL_ID}] no channels.${CHANNEL_ID} authId and authToken found, skipping registration`,
    );
    return;
  }

  const openCall = (ws: WebSocket, callId: string) => {
    const provider = resolveConfiguredRealtimeVoiceProvider({
      cfg: api.config,
    });
    if (!provider) {
      api.logger?.error?.(
        `[${CHANNEL_ID}] no realtime voice provider is configured, so the call has nothing to talk to`,
      );
      ws.close();
      return;
    }

    // The sink has to exist before the session, because the session writes to
    // it, and the session has to exist before frames arrive, because they
    // drive it. The stream is created with a placeholder session and its real
    // one is attached once the bridge is up.
    const pending: {
      session?: ReturnType<typeof createRealtimeVoiceBridgeSession>;
    } = {};
    const stream = createPlivoStream({
      ws,
      session: {
        sendAudio: (audio) => pending.session?.sendAudio(audio),
        // The pinned openclaw 2026.7.1 acknowledges without naming a mark,
        // so Plivo's playedStream name is dropped rather than passed through.
        acknowledgeMark: () => pending.session?.acknowledgeMark(),
        sendDigit: (digit) =>
          pending.session?.sendUserMessage(`The caller pressed ${digit}.`),
        close: () => pending.session?.close(),
      },
      onLog: (message) => api.logger?.info?.(message),
    });

    pending.session = createRealtimeVoiceBridgeSession({
      provider: provider.provider,
      providerConfig: provider.providerConfig,
      cfg: api.config,
      // G.711 mu-law at 8 kHz, which is what the stream is opened with.
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
      audioSink: stream.sink,
      // Plivo answers a checkpoint with playedStream, so marks are bridged to
      // the transport rather than acked locally. Acking immediately would
      // report a reply delivered while it was still only handed over.
      markStrategy: "transport",
      interruptResponseOnInputAudio: true,
      onError: (err) => api.logger?.error?.(`[${CHANNEL_ID}] ${err.message}`),
      onClose: () => ws.close(),
    });

    attachCloseHandling({
      ws,
      session: {
        ...stream.sink,
        ...pending.session,
        close: () => pending.session?.close(),
      } as never,
      onLog: (message) => api.logger?.info?.(message),
    });

    ws.on("message", (data: unknown) => stream.handleFrame(String(data)));
    pending.session.connect().catch((err: Error) => {
      api.logger?.error?.(
        `[${CHANNEL_ID}] could not open the voice bridge: ${err.message}`,
      );
      ws.close();
    });
  };

  api.registerHttpRoute({
    path: cfg.answerPath,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      await handleAnswer({ req, res, cfg, logger: api.logger });
    },
  });

  api.registerHttpRoute({
    path: cfg.streamPath,
    auth: "plugin",
    match: "exact",
    handler: (_req, res) => {
      // The stream path only exists to be upgraded. A plain GET is a
      // misconfigured proxy that passes HTTP but not upgrades.
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("This route requires a WebSocket upgrade.\n");
    },
    handleUpgrade: createStreamUpgradeHandler({
      cfg,
      onCall: openCall,
      logger: api.logger,
    }),
  });

  const { answerUrl } = routeUrls(cfg);
  api.logger?.info?.(
    `[${CHANNEL_ID}] registered the answer webhook at ${cfg.answerPath} and the audio stream at ${cfg.streamPath}`,
  );
  for (const warning of configWarnings(cfg)) {
    api.logger?.warn?.(`[${CHANNEL_ID}] ${warning}`);
  }

  if (!cfg.autoWire || !cfg.fromNumber || !cfg.publicWebhookUrl) {
    if (cfg.autoWire) {
      api.logger?.warn?.(
        `[${CHANNEL_ID}] skipped Plivo provisioning, because fromNumber and publicWebhookUrl are both required for it`,
      );
    }
    return;
  }

  // Detached deliberately. Provisioning is several Plivo round-trips and
  // belongs nowhere near the synchronous registration window above.
  void autoWire({
    authId: cfg.authId,
    authToken: cfg.authToken,
    number: cfg.fromNumber,
    publicBaseUrl: cfg.publicWebhookUrl,
    answerPath: cfg.answerPath,
  })
    .then((result) => {
      if (result.wired) {
        api.logger?.info?.(
          `[${CHANNEL_ID}] READY. Call ${cfg.fromNumber} to talk to the agent.`,
        );
      } else {
        api.logger?.warn?.(`[${CHANNEL_ID}] ${result.note}`);
      }
    })
    .catch((err: Error) => {
      api.logger?.error?.(
        `[${CHANNEL_ID}] Plivo provisioning failed: ${err.message}. Point an application's answer URL at ${answerUrl} by hand, or fix the credentials and restart.`,
      );
    });
}

export type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function respondXml(res: ServerResponse, xml: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/xml" });
  res.end(xml);
}

/**
 * Answers a call, or refuses it before any stream exists.
 *
 * Refusing here costs nothing, whereas a call that connects and then goes quiet
 * is billed and reads to the caller as the agent hanging up on them.
 */
export async function handleAnswer(params: {
  req: IncomingMessage;
  res: ServerResponse;
  cfg: PlivoPhoneConfig;
  logger?: Logger;
}): Promise<void> {
  const { req, res, cfg, logger } = params;

  if ((req.method ?? "").toUpperCase() !== "POST") {
    // The application is registered with answer_method POST, so anything else
    // is not Plivo.
    respondXml(res, hangupXml(), 405);
    return;
  }

  let form: Record<string, string>;
  try {
    form = await readFormBody(req);
  } catch (err) {
    logger?.warn?.(`[plivo-phone] unreadable answer callback: ${String(err)}`);
    respondXml(res, hangupXml(), 400);
    return;
  }

  const { answerUrl } = routeUrls(cfg);
  if (
    !verifyAnswerCallback({
      req,
      url: answerUrl,
      authToken: cfg.authToken,
      form,
    })
  ) {
    // Fail closed. A request this plugin cannot attribute to Plivo does not get
    // a stream, and the reason is logged rather than returned to the caller.
    logger?.warn?.(
      "[plivo-phone] refused an answer callback with no valid Plivo signature",
    );
    respondXml(res, hangupXml(), 403);
    return;
  }

  const caller = form.From ?? "";
  if (!callerAllowed(caller, cfg.dmSecurity, cfg.allowFrom)) {
    logger?.info?.("[plivo-phone] refused a caller outside the allowlist");
    respondXml(res, hangupXml());
    return;
  }

  const callId = form.CallUUID ?? form.RequestUUID ?? "";
  const token = streamTokens.mint(callId);
  respondXml(res, answerXml(streamUrlFor(cfg, token)));
  logger?.info?.(
    `[plivo-phone] answered a call and opened a stream for ${callId || "an unknown call"}`,
  );
}

/**
 * Completes the WebSocket handshake for the audio stream.
 *
 * OpenClaw hands an upgrade over as a raw Duplex rather than a WebSocket, so
 * the handshake is this plugin's to perform. The server is created without its
 * own HTTP listener and driven by handleUpgrade.
 */
export function createStreamUpgradeHandler(params: {
  cfg: PlivoPhoneConfig;
  onCall: (ws: WebSocket, callId: string) => void;
  logger?: Logger;
}) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => PLIVO_WS_SUBPROTOCOL,
  });

  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let token = "";
    try {
      token =
        new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ??
        "";
    } catch {
      token = "";
    }

    const callId = token ? streamTokens.redeem(token) : null;
    if (callId === null) {
      // The answer callback is signed and this connection is not, so an absent
      // or spent token is the only thing standing between the stream route and
      // anyone who guessed the path.
      params.logger?.warn?.(
        "[plivo-phone] refused a stream connection with no valid token",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      params.logger?.info?.(
        `[plivo-phone] audio stream connected for ${callId || "an unknown call"}`,
      );
      params.onCall(ws, callId);
    });
    return true;
  };
}

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
  /**
   * Caller frames dropped as our own echo. A count that keeps climbing while
   * nobody is speaking means the tail is too long for this line.
   */
  suppressedFrames: () => number;
};

/**
 * Mu-law at 8 kHz on the Plivo wire is 8000 samples a second at one byte each,
 * so a millisecond of audio is eight bytes.
 */
const WIRE_BYTES_PER_MS = 8;

/**
 * How long after the last byte of a reply the caller's line is still assumed to
 * carry it. Audio is handed to Plivo ahead of real time, so the send returning
 * is not the caller having heard it, and a speakerphone keeps returning it for
 * a moment after that.
 */
const ECHO_TAIL_MS = 250;

export function createPlivoStream(params: {
  ws: WebSocket;
  session: StreamSession;
  onStart?: (start: PlivoStartFrame["start"]) => void;
  onLog?: (message: string) => void;
  /** Injectable clock, so the echo guard is testable without waiting. */
  now?: () => number;
}): PlivoStreamHandle {
  let streamId = "";
  let callId = "";
  let closed = false;

  // The agent hears itself on a speakerphone, and the transcript that comes
  // back reads as the caller talking, so the agent answers its own reply and
  // the call spirals. The host already screens transcripts for that
  // (isLikelyRealtimeVoiceAssistantEchoTranscript), but that runs after
  // recognition has paid for the turn. Suppressing the audio here means the
  // echo never reaches recognition at all.
  const clock = params.now ?? Date.now;
  let lastOutputPlayableUntilMs = 0;
  let suppressInputUntilMs = 0;
  let suppressedFrames = 0;

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
      params.onLog?.(
        `plivo-phone: dropped a frame on a closing socket: ${String(err)}`,
      );
    }
  };

  return {
    sink: {
      isOpen,
      sendAudio: (audio: Buffer) => {
        const next = extendRealtimeVoiceOutputEchoSuppression({
          audio,
          bytesPerMs: WIRE_BYTES_PER_MS,
          tailMs: ECHO_TAIL_MS,
          nowMs: clock(),
          lastOutputPlayableUntilMs,
          suppressInputUntilMs,
        });
        lastOutputPlayableUntilMs = next.lastOutputPlayableUntilMs;
        suppressInputUntilMs = next.suppressInputUntilMs;
        send(playAudio(audio.toString("base64")));
      },
      clearAudio: () => {
        // A barge-in ends the suppression rather than extending it. Plivo has
        // just been told to drop what it buffered, so there is nothing left to
        // echo, and the caller is mid-sentence. Leaving the window open here
        // would discard the very speech that caused the interruption, which is
        // the one thing a caller notices immediately.
        lastOutputPlayableUntilMs = 0;
        suppressInputUntilMs = 0;
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
          if (!payload) {
            return;
          }
          if (clock() < suppressInputUntilMs) {
            // Our own reply coming back. Counted rather than logged per frame,
            // because a frame is 20 ms and logging each one would bury the call.
            suppressedFrames += 1;
            return;
          }
          params.session.sendAudio(Buffer.from(payload, "base64"));
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
    suppressedFrames: () => suppressedFrames,
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
