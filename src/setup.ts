/**
 * Everything this plugin asks of the Plivo REST API.
 *
 * Provisioning is idempotent and safe to run on every start. The call-control
 * requests live here too, because Hermes keeps its Plivo REST calls in setup
 * rather than in a separate client.
 *
 * Finds or creates the application for this number, points its answer URL at
 * this plugin, and attaches the number. An application this plugin did not
 * create is never modified, so a number wired to something else is left alone.
 */

/**
 * One application per number so several numbers coexist. Never a fixed unkeyed
 * name. The digits-only suffix is what makes an application recognisable as
 * ours on a later start, so this string is persisted state in the customer's
 * Plivo account and renaming it orphans the application.
 */
export const APP_NAME_PREFIX = "openclaw-plivo-phone";

export function appNameFor(number: string): string {
  return `${APP_NAME_PREFIX}-${number.replace(/\D/g, "")}`;
}

export function isOurApp(appName: string): boolean {
  return appName.startsWith(`${APP_NAME_PREFIX}-`);
}

type PlivoApp = { app_id?: string | number; app_name?: string };

async function api(
  path: string,
  init: { method: string; authId: string; authToken: string; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const auth = Buffer.from(`${init.authId}:${init.authToken}`).toString(
    "base64",
  );
  const res = await fetch(`${PLIVO_API_BASE}/${init.authId}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/**
 * Paginates. Plivo returns 20 applications per page by default, so a single
 * unpaginated read on an account with more than that misses the existing
 * application and creates a duplicate on every start.
 */
async function findApp(params: {
  authId: string;
  authToken: string;
  appName: string;
}): Promise<PlivoApp | null> {
  const limit = 20;
  for (let offset = 0; offset < 500; offset += limit) {
    const { status, json } = await api(
      `/Application/?limit=${limit}&offset=${offset}`,
      {
        method: "GET",
        authId: params.authId,
        authToken: params.authToken,
      },
    );
    if (status === 401 || status === 403) {
      throw new Error(
        "Plivo rejected the credentials. Check authId and authToken against https://cx.plivo.com.",
      );
    }
    const objects = (json.objects as PlivoApp[] | undefined) ?? [];
    const hit = objects.find((app) => app.app_name === params.appName);
    if (hit) {
      return hit;
    }
    if (objects.length < limit) {
      return null;
    }
  }
  return null;
}

export type WireResult = {
  wired: boolean;
  appId: string;
  answerUrl: string;
  note: string;
};

export async function autoWire(params: {
  authId: string;
  authToken: string;
  number: string;
  publicBaseUrl: string;
  answerPath: string;
}): Promise<WireResult> {
  const digits = params.number.replace(/\D/g, "");
  const appName = appNameFor(digits);
  const answerUrl = `${params.publicBaseUrl.replace(/\/+$/, "")}${params.answerPath}`;

  const existing = await findApp({
    authId: params.authId,
    authToken: params.authToken,
    appName,
  });

  let appId = String(existing?.app_id ?? "");
  if (existing) {
    await api(`/Application/${appId}/`, {
      method: "POST",
      authId: params.authId,
      authToken: params.authToken,
      body: { answer_url: answerUrl, answer_method: "POST" },
    });
  } else {
    const created = await api("/Application/", {
      method: "POST",
      authId: params.authId,
      authToken: params.authToken,
      body: { app_name: appName, answer_url: answerUrl, answer_method: "POST" },
    });
    appId = String(created.json.app_id ?? "");
    if (!appId) {
      throw new Error(`Plivo did not return an app_id for ${appName}`);
    }
  }

  // Read the number before writing. A number held by an application this plugin
  // did not create belongs to something else, and claiming it would silently
  // break whatever owns it.
  const held = await api(`/Number/${digits}/`, {
    method: "GET",
    authId: params.authId,
    authToken: params.authToken,
  });
  const heldBy = String(held.json.application ?? "");
  if (heldBy && !heldBy.includes(appId)) {
    const owner = await ownerAppName({
      authId: params.authId,
      authToken: params.authToken,
      applicationUri: heldBy,
    });
    if (owner && !isOurApp(owner)) {
      return {
        wired: false,
        appId,
        answerUrl,
        note:
          `+${digits} answers through the Plivo application "${owner}", which this plugin did ` +
          `not create, so it was left alone. Detach the number in the Plivo console, or point ` +
          `that application's answer URL at ${answerUrl}.`,
      };
    }
  }

  const attach = await api(`/Number/${digits}/`, {
    method: "POST",
    authId: params.authId,
    authToken: params.authToken,
    body: { app_id: appId },
  });
  if (attach.status >= 300) {
    throw new Error(
      `Plivo refused to attach +${digits} (HTTP ${attach.status})`,
    );
  }
  return { wired: true, appId, answerUrl, note: "" };
}

async function ownerAppName(params: {
  authId: string;
  authToken: string;
  applicationUri: string;
}): Promise<string> {
  const id = params.applicationUri.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!id) {
    return "";
  }
  const { json } = await api(`/Application/${id}/`, {
    method: "GET",
    authId: params.authId,
    authToken: params.authToken,
  });
  return String(json.app_name ?? "");
}

/**
 * Provisioning runs on every start and has nothing that undoes it, so removing
 * the plugin would leave Plivo routing calls to a webhook that no longer
 * answers, and the next integration wanting the number would be refused
 * because an application it did not create holds it.
 */
export async function unwire(params: {
  authId: string;
  authToken: string;
  number: string;
}): Promise<{ detached: boolean; note: string }> {
  const digits = params.number.replace(/\D/g, "");
  const appName = appNameFor(digits);
  const app = await findApp({
    authId: params.authId,
    authToken: params.authToken,
    appName,
  });
  if (!app) {
    return {
      detached: false,
      note: `No application named ${appName}, so nothing to undo.`,
    };
  }
  const appId = String(app.app_id ?? "");
  const held = await api(`/Number/${digits}/`, {
    method: "GET",
    authId: params.authId,
    authToken: params.authToken,
  });
  if (!String(held.json.application ?? "").includes(appId)) {
    return {
      detached: false,
      note: `+${digits} is not on ${appName}, so it was left alone.`,
    };
  }
  const res = await api(`/Number/${digits}/`, {
    method: "POST",
    authId: params.authId,
    authToken: params.authToken,
    body: { app_id: "" },
  });
  if (res.status >= 300) {
    return {
      detached: false,
      note: `Could not detach +${digits} (HTTP ${res.status})`,
    };
  }
  return { detached: true, note: `Detached +${digits} from ${appName}.` };
}

export const PLIVO_API_BASE = "https://api.plivo.com/v1/Account";

function authHeader(authId: string, authToken: string): string {
  return `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`;
}

export function normalizeE164(number: string): string {
  const trimmed = number.trim();
  if (!trimmed.startsWith("+")) {
    throw new Error(
      `Phone number must be E.164, for example +15551234567, got: ${number}`,
    );
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
    throw new Error(
      `Plivo refused the call (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = JSON.parse(text) as { request_uuid?: string | string[] };
  const uuid = Array.isArray(json.request_uuid)
    ? json.request_uuid[0]
    : json.request_uuid;
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
  const res = await fetch(
    `${PLIVO_API_BASE}/${params.authId}/Call/${params.callUuid}/`,
    {
      method: "DELETE",
      headers: { Authorization: authHeader(params.authId, params.authToken) },
    },
  );
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
  const res = await fetch(
    `${PLIVO_API_BASE}/${params.authId}/Number/${digits}/`,
    {
      headers: { Authorization: authHeader(params.authId, params.authToken) },
    },
  );
  if (res.status >= 300) {
    return "";
  }
  const json = (await res.json()) as { application?: string };
  const appUri = String(json.application ?? "");
  const appId = appUri.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!appId) {
    return "";
  }
  const app = await fetch(
    `${PLIVO_API_BASE}/${params.authId}/Application/${appId}/`,
    {
      headers: { Authorization: authHeader(params.authId, params.authToken) },
    },
  );
  if (app.status >= 300) {
    return "";
  }
  const appJson = (await app.json()) as { answer_url?: string };
  return String(appJson.answer_url ?? "");
}
