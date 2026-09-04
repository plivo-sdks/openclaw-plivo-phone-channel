/** Plugin entry: registers the plivo-phone channel, its answer webhook, and the audio stream. */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import type { WebSocket } from "ws";
import { createStreamUpgradeHandler, handleAnswer } from "./src/answer.js";
import { CHANNEL_ID, configWarnings, resolveConfig, routeUrls } from "./src/channel.js";
import { attachCloseHandling, createPlivoStream } from "./src/stream.js";
import { autoWire } from "./src/setup.js";
import type { PlivoPhoneConfig } from "./src/types.js";

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
