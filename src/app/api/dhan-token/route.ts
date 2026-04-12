// GET  /api/dhan-token        → returns token status (no secrets exposed)
// POST /api/dhan-token        → seeds a new token from request body { token }
//
// Protected by ADMIN_SECRET header — set ADMIN_SECRET in your env vars.
// In dev you can leave ADMIN_SECRET unset and it will skip the check.

import { NextResponse } from "next/server";
import { getDhanTokenStatus, seedDhanToken } from "@/lib/dhan-auth";

export const dynamic = "force-dynamic";

function isAuthorised(req: Request): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return true; // dev mode — no secret configured
  return req.headers.get("x-admin-secret") === secret;
}

// ── GET: check current token status ──────────────────────────────────────────
export async function GET(req: Request) {
  if (!isAuthorised(req))
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const status = await getDhanTokenStatus();
  return NextResponse.json(status ?? { hasToken: false });
}

// ── POST: seed a fresh token ──────────────────────────────────────────────────
export async function POST(req: Request) {
  if (!isAuthorised(req))
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { token?: string };
  try {
    body = await req.json() as { token?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = body.token?.trim();
  if (!token) return NextResponse.json({ error: "Missing `token` field" }, { status: 400 });

  await seedDhanToken(token);
  const status = await getDhanTokenStatus();
  return NextResponse.json({ ok: true, ...status });
}
