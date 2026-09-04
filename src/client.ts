/** Plivo Voice REST calls this plugin makes outside provisioning. */

export const PLIVO_API_BASE = "https://api.plivo.com/v1/Account";

function authHeader(authId: string, authToken: string): string {
  return `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`;
}

export function normalizeE164(number: string): string {
  const trimmed = number.trim();
  if (!trimmed.startsWith("+")) {
    throw new Error(`Phone number must be E.164, for example +15551234567, got: ${number}`);
  }
  const digits = `+${trimmed.replace(/\D/g, "")}`;
  if (digits.length < 8) {
    throw new Error(`Phone number looks too short: ${number}`);
  }
  return digits;
}

export function maskNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length < 4 ? "***" : `***-***-${digits.slice(-4)}`;
}

/**
 * Places a call answered by this plugin's own answer webhook, so an outbound
 * call joins the same media stream, endpointer and turn loop an inbound caller
 * reaches. Nothing about the conversation differs once the leg is up.
 */
export async function placeCall(params: {
  authId: string;
  authToken: string;
  from: string;
  to: string;
  answerUrl: string;
}): Promise<{ requestUuid: string }> {
  const res = await fetch(`${PLIVO_API_BASE}/${params.authId}/Call/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(params.authId, params.authToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: normalizeE164(params.from),
      to: normalizeE164(params.to),
      answer_url: params.answerUrl,
      answer_method: "POST",
    }),
  });
  const text = await res.text();
  if (res.status >= 300) {
    throw new Error(`Plivo refused the call (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { request_uuid?: string | string[] };
  const uuid = Array.isArray(json.request_uuid) ? json.request_uuid[0] : json.request_uuid;
  return { requestUuid: String(uuid ?? "") };
}

/**
 * Ends a live call. The answer webhook can refuse a call before any stream
 * exists by returning hangup XML, but a call already streaming is terminated
 * over REST. A 404 means the call is already over rather than that the request
 * failed.
 */
export async function hangupCall(params: {
  authId: string;
  authToken: string;
  callUuid: string;
}): Promise<void> {
  const res = await fetch(`${PLIVO_API_BASE}/${params.authId}/Call/${params.callUuid}/`, {
    method: "DELETE",
    headers: { Authorization: authHeader(params.authId, params.authToken) },
  });
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`Plivo refused the hangup (HTTP ${res.status})`);
  }
}

/**
 * Reads back the answer URL Plivo currently holds for a number, so a caller can
 * be told where Plivo will actually send the call rather than where this plugin
 * believes it should go.
 */
export async function answerUrlOnFile(params: {
  authId: string;
  authToken: string;
  number: string;
}): Promise<string> {
  const digits = params.number.replace(/\D/g, "");
  const res = await fetch(`${PLIVO_API_BASE}/${params.authId}/Number/${digits}/`, {
    headers: { Authorization: authHeader(params.authId, params.authToken) },
  });
  if (res.status >= 300) {
    return "";
  }
  const json = (await res.json()) as { application?: string };
  const appUri = String(json.application ?? "");
  const appId = appUri.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!appId) {
    return "";
  }
  const app = await fetch(`${PLIVO_API_BASE}/${params.authId}/Application/${appId}/`, {
    headers: { Authorization: authHeader(params.authId, params.authToken) },
  });
  if (app.status >= 300) {
    return "";
  }
  const appJson = (await app.json()) as { answer_url?: string };
  return String(appJson.answer_url ?? "");
}
