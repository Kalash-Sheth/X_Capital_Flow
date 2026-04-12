// POST /api/refresh
// Triggers pipeline.py --once which covers:
//   - All 15 NSE equity indices (Dhan history gap-fill)
//   - All 7 commodity assets (Yahoo Finance gap-fill)
//   - Live OHLC snapshot
//   - Options OI (NIFTY, BANKNIFTY, FINNIFTY)
// Streams stdout/stderr line-by-line as Server-Sent Events.

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

// Allow up to 5 min for the script to complete
export const maxDuration = 300;

export async function POST() {
  // Python scripts are not available on Vercel serverless — data is populated
  // via the built-in Yahoo Finance gap-fill routes instead.
  if (process.env.VERCEL) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ line: "⚠️  Python pipeline is not available on Vercel. Data is auto-refreshed via gap-fill on each API route call." })}\n\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, code: 0 })}\n\n`));
        controller.close();
      },
    });
    return new NextResponse(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const projectRoot = path.resolve(process.cwd());
  const scriptPath  = path.join(projectRoot, "scripts", "pipeline.py");

  const python = process.env.PYTHON_BIN ?? "python3";

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (line: string) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ line })}\n\n`));

      send("⏳ Refreshing all assets — indices, commodities, options OI…");

      const proc = spawn(python, [scriptPath, "--once"], {
        cwd: projectRoot,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) send(line);
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) send(`[warn] ${line}`);
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          send("✅ Refresh complete — all indices, commodities & options OI updated.");
        } else {
          send(`❌ Script exited with code ${code}.`);
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, code })}\n\n`));
        controller.close();
      });

      proc.on("error", (err) => {
        send(`❌ Failed to start script: ${err.message}`);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, code: 1 })}\n\n`));
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}

// GET returns the last refresh timestamp stored in-memory (reset on server restart)
let lastRefresh: string | null = null;
export async function GET() {
  return NextResponse.json({ lastRefresh });
}
