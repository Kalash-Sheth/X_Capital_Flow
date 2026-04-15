#!/usr/bin/env node
// Usage:
//   node scripts/import-csv.mjs NIFTY50      ./data/nifty50.csv
//   node scripts/import-csv.mjs NIFTY500     ./data/nifty500.csv
//   node scripts/import-csv.mjs NIFTY_SMALLCAP ./data/smallcap100.csv
//
// The dev server must be running at http://localhost:3000
// ADMIN_SECRET is read from .env automatically

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dir, "../.env");
let adminSecret = "xcapital123";
try {
  const env = readFileSync(envPath, "utf8");
  const match = env.match(/^ADMIN_SECRET="?([^"\n]+)"?/m);
  if (match) adminSecret = match[1];
} catch {}

const [,, ticker, csvPath] = process.argv;

if (!ticker || !csvPath) {
  console.error("Usage: node scripts/import-csv.mjs <TICKER> <path/to/file.csv>");
  console.error("  Tickers: NIFTY50 | NIFTY500 | NIFTY_SMALLCAP | INDIAVIX");
  process.exit(1);
}

const csv = readFileSync(resolve(csvPath), "utf8");
console.log(`Importing ${ticker} from ${csvPath} (${csv.split("\n").length - 1} rows)...`);

const res = await fetch("http://localhost:3000/api/admin/import-prices", {
  method: "POST",
  headers: {
    "Content-Type":   "application/json",
    "x-admin-secret": adminSecret,
  },
  body: JSON.stringify({ ticker, csv }),
});

const json = await res.json();

if (!res.ok) {
  console.error("❌ Error:", json.error);
  process.exit(1);
}

console.log(`\n✅ ${ticker} import complete`);
console.log(`   Total rows  : ${json.totalRows}`);
console.log(`   Added/Updated: ${json.added}`);
console.log(`   Skipped     : ${json.skipped}`);
if (json.errors?.length) {
  console.log(`\n⚠  First errors (${json.errors.length}):`);
  json.errors.slice(0, 5).forEach((e) => console.log("   -", e));
}
