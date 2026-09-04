/**
 * The answer webhook and the audio-stream upgrade.
 *
 * Both routes are here because they are two halves of one decision: the answer
 * route decides whether a call is allowed and mints the token, and the stream
 * route refuses any connection that cannot present it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { routeUrls, streamTokens, streamUrlFor } from "./channel.js";
import { answerXml, hangupXml, PLIVO_WS_SUBPROTOCOL, type PlivoPhoneConfig } from "./types.js";
import { callerAllowed, readFormBody, verifyAnswerCallback } from "./webhook.js";

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
