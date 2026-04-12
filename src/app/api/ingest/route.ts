// POST /api/ingest              — trigger live price refresh (Dhan for NSE + Yahoo for rest)
// POST /api/ingest?history=true — trigger Dhan 5yr history (NSE) + Yahoo history (rest)
// GET  /api/ingest              — check last ingest timestamp

import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

export async function GET() {
  try {
    // Return the latest PriceData timestamp as "last ingested"
    const latest = await prisma.priceData.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, timestamp: true },
    });

    const count = await prisma.priceData.count();

    return NextResponse.json({
      lastIngested: latest?.createdAt ?? null,
      latestDataPoint: latest?.timestamp ?? null,
      totalRows: count,
      status: count > 0 ? "ok" : "empty",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const history = searchParams.get("history") === "true";

  const scriptPath = path.join(process.cwd(), "scripts", "fetch_prices.py");
  // NSE indices use Dhan (--dhan-history --core3); other assets use Yahoo (--history)
  const mode = history ? "--dhan-history --core3 --days 1825 --history --days 200" : "--live";

  try {
    console.log(`[Ingest] Starting: python3 ${scriptPath} ${mode}`);
    const startTime = Date.now();

    const { stdout, stderr } = await execAsync(
      `python3 "${scriptPath}" ${mode}`,
      {
        timeout: history ? 120_000 : 30_000, // 2 min for history, 30s for live
        env: { ...process.env },
        cwd: process.cwd(),
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Extract JSON output from the script's stdout (last JSON block)
    let parsedOutput: Record<string, unknown> | null = null;
    const jsonMatch = stdout.match(/--- JSON OUTPUT ---\n([\s\S]+)$/);
    if (jsonMatch) {
      try { parsedOutput = JSON.parse(jsonMatch[1].trim()); } catch { /* ignore */ }
    }

    console.log(`[Ingest] Done in ${elapsed}s`);
    if (stderr) console.warn("[Ingest] stderr:", stderr.slice(0, 500));

    return NextResponse.json({
      success:  true,
      mode:     history ? "history" : "live",
      elapsed:  `${elapsed}s`,
      output:   parsedOutput,
      rawLines: stdout.split("\n").filter((l) => l.startsWith("  ✓") || l.startsWith("✅")).slice(0, 20),
    });
  } catch (error: unknown) {
    const err = error as { message?: string; stderr?: string; killed?: boolean };
    console.error("[Ingest] Failed:", err.message);
    return NextResponse.json({
      success: false,
      error:   err.message ?? "Unknown error",
      stderr:  err.stderr?.slice(0, 1000) ?? "",
      timedOut: err.killed ?? false,
    }, { status: 500 });
  }
}
