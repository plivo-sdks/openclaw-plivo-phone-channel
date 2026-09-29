/**
 * Everything this plugin asks of the Plivo REST API.
 *
 * Provisioning is idempotent and safe to run on every start. It finds or
 * creates the application for this number, points its answer URL at this
 * plugin, and attaches the number. An application this plugin did not create is
 * never modified, so a number wired to something else is left alone.
 *
 * Hanging up lives here too, since every Plivo REST call belongs in one place.
 * Dialling does not. An outbound call is
 * placed by the Plivo tools plugin, which points its answer URL at this
 * plugin's answer route, so the call joins the same stream an inbound caller
 * reaches. Holding a second dialling path here would mean two answer-URL
 * policies to keep in step.
 */

/**
 * One application per number so several numbers coexist. Never a fixed unkeyed
 * name. The digits-only suffix is what makes an application recognisable as
 * ours on a later start, so this string is persisted state in the customer's
 * Plivo account and renaming it orphans the application.
 */
export const APP_NAME_PREFIX = "openclaw-plivo-phone";

/** Every Plivo request gets a deadline, so a stalled API cannot wedge a call. */
const REQUEST_TIMEOUT_MS = 15_000;

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
    // Without a deadline a stalled Plivo request hangs the caller forever. That
    // matters most on teardown, where this is the only thing that stops a leg
    // billing.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    if (status >= 300) {
      // Treating any other failure as "no such application" would create a
      // duplicate on the next start and orphan the first.
      throw new Error(
        `Plivo could not list applications (HTTP ${status}). Refusing to decide whether ` +
          `${params.appName} exists from a failed response.`,
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
    const updated = await api(`/Application/${appId}/`, {
      method: "POST",
      authId: params.authId,
      authToken: params.authToken,
      body: { answer_url: answerUrl, answer_method: "POST" },
    });
    if (updated.status >= 300) {
      throw new Error(
        `Plivo refused to update application ${appId} (HTTP ${updated.status}). Its answer URL ` +
          `still points somewhere else, so attaching the number would route calls away from here.`,
      );
    }
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
  if (held.status >= 300) {
    // Reading the body of a failed response yields no application, which would
    // read as "nobody holds this number" and claim it. A lookup that did not
    // answer says nothing about ownership.
    return {
      wired: false,
      appId,
      answerUrl,
      note:
        `+${digits} could not be read from Plivo (HTTP ${held.status}), so the number was left ` +
        `alone rather than claimed from whatever may own it. Retry once the Plivo API is reachable.`,
    };
  }
  // Compare ids rather than testing for a substring, or application 1234 would
  // read as already ours whenever the number is held by 12345.
  const heldBy = String(held.json.application ?? "");
  if (heldBy && applicationIdFromUri(heldBy) !== appId) {
    const owner = await ownerAppName({
      authId: params.authId,
      authToken: params.authToken,
      applicationUri: heldBy,
    });
    if (!owner.known) {
      return {
        wired: false,
        appId,
        answerUrl,
        note:
          `+${digits} is held by Plivo application ${applicationIdFromUri(heldBy)}, and its name ` +
          `could not be read, so the number was left alone rather than claimed from whatever owns ` +
          `it. Retry once the Plivo API is reachable, or attach the number by hand.`,
      };
    }
    if (!isOurApp(owner.appName)) {
      return {
        wired: false,
        appId,
        answerUrl,
        note:
          `+${digits} answers through the Plivo application "${owner.appName}", which this plugin did ` +
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

/** Reads the id out of a Plivo resource URI, which is how a Number reports its application. */
export function applicationIdFromUri(uri: string): string {
  return uri.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Who owns a number, and whether that could be established at all.
 *
 * `known` is false when the lookup failed or returned no name. The caller must
 * treat that as "do not claim", because a request that 401s or 500s says nothing
 * about who holds the number, and assuming nobody does is how a number wired to
 * another application gets taken.
 */
async function ownerAppName(params: {
  authId: string;
  authToken: string;
  applicationUri: string;
}): Promise<{ known: boolean; appName: string }> {
  const id = applicationIdFromUri(params.applicationUri);
  if (!id) {
    return { known: false, appName: "" };
  }
  const { status, json } = await api(`/Application/${id}/`, {
    method: "GET",
    authId: params.authId,
    authToken: params.authToken,
  });
  if (status >= 300) {
    return { known: false, appName: "" };
  }
  const appName = String(json.app_name ?? "");
  return { known: appName !== "", appName };
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
  if (held.status >= 300) {
    return {
      detached: false,
      note: `Could not read +${digits} from Plivo (HTTP ${held.status}), so nothing was detached.`,
    };
  }
  // Same id comparison as autoWire. A substring test would read application 1234
  // as ours whenever the number is held by 12345.
  if (applicationIdFromUri(String(held.json.application ?? "")) !== appId) {
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

export function maskNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length < 4 ? "***" : `***-***-${digits.slice(-4)}`;
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (res.status >= 300 && res.status !== 404) {
    throw new Error(`Plivo refused the hangup (HTTP ${res.status})`);
  }
}
