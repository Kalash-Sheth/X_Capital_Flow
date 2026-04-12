/**
 * Dhan API Token Manager
 *
 * Dhan access tokens expire after 24 hours and CANNOT be renewed once expired.
 * Strategy:
 *   1. Store the active token + expiry in the `SystemConfig` DB table.
 *   2. On every call, if < 4 hours remain → proactively renew via GET /v2/RenewToken.
 *   3. Bootstrap: if no DB record exists, seed from DHAN_ACCESS_TOKEN env var and
 *      immediately renew it (so future cold starts don't need the env var to be fresh).
 *   4. If renewal fails (token already expired), return the current token so the
 *      caller gets a proper 401 from Dhan rather than a silent null.
 *
 * IMPORTANT: Call `seedDhanToken()` once after setting a new token in the env var.
 * After that, the system self-renews indefinitely as long as the app receives at
 * least one request every 20 hours (renewal triggers at < 4h remaining).
 */

import { prisma } from "@/lib/prisma";

const DB_KEY      = "dhan_access_token";
const RENEW_URL   = "https://api.dhan.co/v2/RenewToken";
// Renew when fewer than this many hours remain on the current token
const RENEW_THRESHOLD_HOURS = 4;
// Assumed token lifetime when Dhan doesn't return an expiry in the response
const TOKEN_LIFETIME_HOURS  = 23.5; // slightly under 24h to be safe

// Module-level in-flight promise — prevents concurrent renewals within the
// same process (relevant for dev server; Vercel is stateless between requests)
let renewalInFlight: Promise<string | null> | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a valid Dhan access token, renewing it automatically when needed.
 * Call this instead of `process.env.DHAN_ACCESS_TOKEN` everywhere.
 */
export async function getDhanToken(): Promise<string | null> {
  const record = await readRecord();

  if (record) {
    const hoursLeft = (record.expiresAt.getTime() - Date.now()) / 3_600_000;

    if (hoursLeft > RENEW_THRESHOLD_HOURS) {
      return record.token; // ✓ plenty of time left
    }

    if (hoursLeft > 0) {
      // Approaching expiry → renew proactively
      console.log(`[dhan-auth] Token expires in ${hoursLeft.toFixed(1)}h — renewing proactively`);
      return renewAndStore(record.token);
    }

    // Token in DB has expired — attempt renewal anyway (will likely fail,
    // but log the error so the operator knows to update the token)
    console.warn("[dhan-auth] DB token is expired. Attempting renewal — this will fail if Dhan has invalidated it.");
    const renewed = await renewAndStore(record.token);
    if (renewed) return renewed;
    // Fall through to env var bootstrap
  }

  // No DB record or renewal failed → bootstrap from env var
  const envToken = process.env.DHAN_ACCESS_TOKEN;
  if (!envToken) {
    console.error("[dhan-auth] No token in DB and DHAN_ACCESS_TOKEN env var is not set.");
    return null;
  }

  console.log("[dhan-auth] Bootstrapping from DHAN_ACCESS_TOKEN env var");
  const bootstrapped = await renewAndStore(envToken);
  // If renewal fails (env token expired) return it anyway so the caller gets
  // an explicit Dhan 401 rather than a silent no-op
  return bootstrapped ?? envToken;
}

/**
 * Manually seed a fresh token into the DB.
 * Call this once after pasting a new token into the env var / dashboard.
 *
 * Example (in a one-off script or admin endpoint):
 *   await seedDhanToken(process.env.DHAN_ACCESS_TOKEN!);
 */
export async function seedDhanToken(token: string): Promise<void> {
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_HOURS * 3_600_000);
  await upsertRecord(token, expiresAt);
  console.log(`[dhan-auth] Token seeded, expires ${expiresAt.toISOString()}`);
}

/**
 * Returns the stored token metadata without triggering a renewal.
 * Useful for admin/debug endpoints.
 */
export async function getDhanTokenStatus(): Promise<{
  hasToken:  boolean;
  expiresAt: string | null;
  hoursLeft: number | null;
  isExpired: boolean;
} | null> {
  const record = await readRecord();
  if (!record) return { hasToken: false, expiresAt: null, hoursLeft: null, isExpired: true };
  const hoursLeft = (record.expiresAt.getTime() - Date.now()) / 3_600_000;
  return {
    hasToken:  true,
    expiresAt: record.expiresAt.toISOString(),
    hoursLeft: parseFloat(hoursLeft.toFixed(2)),
    isExpired: hoursLeft <= 0,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function renewAndStore(currentToken: string): Promise<string | null> {
  // Deduplicate concurrent renewal calls within the same process
  if (renewalInFlight) return renewalInFlight;

  renewalInFlight = (async () => {
    try {
      return await callRenewEndpoint(currentToken);
    } finally {
      renewalInFlight = null;
    }
  })();

  return renewalInFlight;
}

async function callRenewEndpoint(currentToken: string): Promise<string | null> {
  const clientId = process.env.DHAN_CLIENT_ID;
  if (!clientId) {
    console.error("[dhan-auth] DHAN_CLIENT_ID env var is not set — cannot renew token.");
    return null;
  }

  try {
    const resp = await fetch(RENEW_URL, {
      method:  "GET",
      headers: {
        "access-token": currentToken,
        "dhanClientId": clientId,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[dhan-auth] RenewToken returned ${resp.status}: ${body}`);
      return null;
    }

    const data = await resp.json() as Record<string, unknown>;

    // Dhan's response format isn't fully documented — try common field names
    const newToken =
      (data.accessToken  as string | undefined) ??
      (data.access_token as string | undefined) ??
      (data.token        as string | undefined) ??
      (data.jwt          as string | undefined);

    if (!newToken) {
      console.error("[dhan-auth] RenewToken response had no recognisable token field:", JSON.stringify(data));
      return null;
    }

    // Parse expiry from response if provided, otherwise assume 23.5h
    let expiresAt: Date;
    const rawExpiry =
      (data.tokenExpiry   as string | number | undefined) ??
      (data.expiresAt     as string | number | undefined) ??
      (data.expires_at    as string | number | undefined) ??
      (data.expiry        as string | number | undefined);

    if (rawExpiry) {
      const parsed = new Date(
        typeof rawExpiry === "number" && rawExpiry < 1e12
          ? rawExpiry * 1000   // Unix seconds → ms
          : rawExpiry,
      );
      expiresAt = isNaN(parsed.getTime())
        ? new Date(Date.now() + TOKEN_LIFETIME_HOURS * 3_600_000)
        : parsed;
    } else {
      expiresAt = new Date(Date.now() + TOKEN_LIFETIME_HOURS * 3_600_000);
    }

    await upsertRecord(newToken, expiresAt);
    console.log(`[dhan-auth] Token renewed successfully, expires ${expiresAt.toISOString()}`);
    return newToken;

  } catch (err) {
    console.error("[dhan-auth] RenewToken request failed:", err);
    return null;
  }
}

interface TokenRecord { token: string; expiresAt: Date }

async function readRecord(): Promise<TokenRecord | null> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: DB_KEY } });
    if (!row) return null;
    const meta = row.meta ? (JSON.parse(row.meta) as { expiresAt: string }) : null;
    const expiresAt = meta?.expiresAt ? new Date(meta.expiresAt) : new Date(0);
    return { token: row.value, expiresAt };
  } catch {
    return null;
  }
}

async function upsertRecord(token: string, expiresAt: Date): Promise<void> {
  const meta = JSON.stringify({ expiresAt: expiresAt.toISOString() });
  await prisma.systemConfig.upsert({
    where:  { key: DB_KEY },
    update: { value: token, meta },
    create: { key: DB_KEY, value: token, meta },
  });
}
