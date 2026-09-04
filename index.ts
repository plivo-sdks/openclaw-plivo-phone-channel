/**
 * Plugin entry: registers the plivo-phone channel, its answer webhook, and the
 * audio stream, and wires each call to OpenClaw's realtime voice bridge.
 *
 * The two route handlers live here rather than in a file of their own, because
 * they are two halves of one decision. The answer route decides whether a call
 * is allowed and mints the token, and the stream route refuses any connection
 * that cannot present it.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CHANNEL_ID,
  configWarnings,
  resolveConfig,
  routeUrls,
  streamTokens,
  streamUrlFor,
} from "./src/config.js";
import { attachCloseHandling, createPlivoStream } from "./src/call-handler.js";
import {
  answerXml,
  hangupXml,
  PLIVO_WS_SUBPROTOCOL,
} from "./src/audio-streaming.js";
import { callerAllowed, readFormBody, verifyAnswerCallback } from "./src/webhook.js";
import { autoWire } from "./src/setup.js";
import type { PlivoPhoneConfig } from "./src/audio-streaming.js";

type ChannelsConfig = { channels?: Record<string, Partial<PlivoPhoneConfig> | undefined> };

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Plivo Phone",
  description: "Real-time voice conversations over Plivo Audio Streaming, inbound and outbound",

  // Every api.* call must happen before the first await. The loader wraps `api`
  // in a guarded proxy that disables its methods as soon as the synchronous
  // portion of register returns, so a registration placed after an await
  // becomes a silent no-op and the route never reaches the HTTP route registry.
  // This plugin has two registrations and provisioning to do, so the routes are
  // mounted first and the Plivo side is wired in a detached task afterwards.
  registerFull(api) {
    const cfg = resolveConfig((api.config as ChannelsConfig)?.channels?.[CHANNEL_ID]);
    if (!cfg) {
      api.logger?.warn?.(
        `[${CHANNEL_ID}] no channels.${CHANNEL_ID} authId and authToken found, skipping registration`,
      );
      return;
    }

    const openCall = (ws: WebSocket, callId: string) => {
      const provider = resolveConfiguredRealtimeVoiceProvider({ cfg: api.config });
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
      const pending: { session?: ReturnType<typeof createRealtimeVoiceBridgeSession> } = {};
      const stream = createPlivoStream({
        ws,
        session: {
          sendAudio: (audio) => pending.session?.sendAudio(audio),
          // The pinned openclaw 2026.7.1 acknowledges without naming a mark,
          // so Plivo's playedStream name is dropped rather than passed through.
          acknowledgeMark: () => pending.session?.acknowledgeMark(),
          sendDigit: (digit) => pending.session?.sendUserMessage(`The caller pressed ${digit}.`),
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
        session: { ...stream.sink, ...pending.session, close: () => pending.session?.close() } as never,
        onLog: (message) => api.logger?.info?.(message),
      });

      ws.on("message", (data: unknown) => stream.handleFrame(String(data)));
      pending.session.connect().catch((err: Error) => {
        api.logger?.error?.(`[${CHANNEL_ID}] could not open the voice bridge: ${err.message}`);
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
      handleUpgrade: createStreamUpgradeHandler({ cfg, onCall: openCall, logger: api.logger }),
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
  },
});


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
  if (!verifyAnswerCallback({ req, url: answerUrl, authToken: cfg.authToken, form })) {
    // Fail closed. A request this plugin cannot attribute to Plivo does not get
    // a stream, and the reason is logged rather than returned to the caller.
    logger?.warn?.("[plivo-phone] refused an answer callback with no valid Plivo signature");
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
  logger?.info?.(`[plivo-phone] answered a call and opened a stream for ${callId || "an unknown call"}`);
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
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => PLIVO_WS_SUBPROTOCOL });

  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let token = "";
    try {
      token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
    } catch {
      token = "";
    }

    const callId = token ? streamTokens.redeem(token) : null;
    if (callId === null) {
      // The answer callback is signed and this connection is not, so an absent
      // or spent token is the only thing standing between the stream route and
      // anyone who guessed the path.
      params.logger?.warn?.("[plivo-phone] refused a stream connection with no valid token");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      params.logger?.info?.(`[plivo-phone] audio stream connected for ${callId || "an unknown call"}`);
      params.onCall(ws, callId);
    });
    return true;
  };
}
