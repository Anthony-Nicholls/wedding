/**
 * Donations API — stores messages in KV, redirects guests to a Stripe Payment Link.
 * GET  /        — list public donations
 * POST /donate  — save name/message/amount, return Payment Link URL with amount prefilled
 * Cron         — daily backup of the donations list into dated KV keys
 */

const LIST_KEY = "donations";
const BACKUP_PREFIX = "donations-backup-";
const MAX_DONATIONS = 500;
const MAX_BACKUPS = 30;
const MIN_AMOUNT_PENCE = 100; // £1
const MAX_AMOUNT_PENCE = 1000000; // £10,000

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(request, env, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/donate") {
        return corsResponse(request, env, await handleDonate(request, env));
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/donations")
      ) {
        return corsResponse(request, env, await handleList(env));
      }

      return corsResponse(request, env, json({ error: "Not found" }, 404));
    } catch (error) {
      return corsResponse(
        request,
        env,
        json(
          {
            error: "Request failed",
            detail: error instanceof Error ? error.message : String(error),
          },
          502
        )
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(backupDonations(env));
  },
};

async function handleList(env) {
  if (!env.DONATIONS) {
    return json({ error: "Donations store not configured" }, 500);
  }

  const donations = (await env.DONATIONS.get(LIST_KEY, "json")) || [];
  return json(
    { donations },
    200,
    { "Cache-Control": "private, max-age=30" }
  );
}

async function handleDonate(request, env) {
  if (!env.DONATIONS) {
    return json({ error: "Donations store not configured" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const invitation =
    payload.invitation === "evening" ? "evening" : "day";
  const donationUrl =
    invitation === "evening"
      ? env.DONATION_URL_EVENING
      : env.DONATION_URL_DAY;

  if (!donationUrl) {
    return json({ error: "Payment link not configured" }, 500);
  }

  const name = clean(payload.name);
  if (!name) {
    return json({ error: "Please enter your name." }, 400);
  }

  const amountPence = parseAmountPence(payload.amount);
  if (amountPence == null) {
    return json(
      {
        error: `Enter an amount between £${MIN_AMOUNT_PENCE / 100} and £${MAX_AMOUNT_PENCE / 100}.`,
      },
      400
    );
  }

  const message = clean(payload.message);
  if (!message) {
    return json({ error: "Please enter a note." }, 400);
  }

  const amount = Math.round(amountPence) / 100;
  const donation = {
    from: name,
    message,
    amount,
    created: Math.floor(Date.now() / 1000),
  };

  const existing = (await env.DONATIONS.get(LIST_KEY, "json")) || [];
  existing.unshift(donation);
  await env.DONATIONS.put(
    LIST_KEY,
    JSON.stringify(existing.slice(0, MAX_DONATIONS))
  );

  const payUrl = new URL(donationUrl);
  payUrl.searchParams.set("__prefilled_amount", String(amountPence));

  return json({ url: payUrl.toString() }, 200, { "Cache-Control": "no-store" });
}

async function backupDonations(env) {
  if (!env.DONATIONS) {
    return;
  }

  const raw = await env.DONATIONS.get(LIST_KEY);
  const payload = raw == null ? "[]" : raw;
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const backupKey = `${BACKUP_PREFIX}${stamp}`;

  await env.DONATIONS.put(backupKey, payload);

  const listed = await env.DONATIONS.list({ prefix: BACKUP_PREFIX });
  const backupKeys = listed.keys
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const stale = backupKeys.slice(MAX_BACKUPS);
  await Promise.all(stale.map((key) => env.DONATIONS.delete(key)));
}

function parseAmountPence(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const pence = Math.round(value * 100);
  if (pence < MIN_AMOUNT_PENCE || pence > MAX_AMOUNT_PENCE) {
    return null;
  }
  return pence;
}

function clean(value) {
  if (value == null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function corsResponse(request, env, response) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);

  const headers = new Headers(response.headers);
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
