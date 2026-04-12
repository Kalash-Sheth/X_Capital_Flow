/**
 * prisma/seed.ts — Seeds the Asset master table with all 16 tracked instruments.
 * Run: npx ts-node --project tsconfig.json prisma/seed.ts
 * Or add "prisma": { "seed": "ts-node prisma/seed.ts" } to package.json
 */

import { PrismaClient, AssetClass } from "@prisma/client";

const prisma = new PrismaClient();

const ASSETS = [
  // ── Indian Equities ────────────────────────────────────────────────────────
  { ticker: "NIFTY50",      name: "Nifty 50 Index",          assetClass: AssetClass.EQUITY,       sector: "Broad Market", region: "India",  currency: "INR" },
  { ticker: "SENSEX",       name: "BSE Sensex",              assetClass: AssetClass.EQUITY,       sector: "Broad Market", region: "India",  currency: "INR" },
  { ticker: "NIFTY_BANK",   name: "Nifty Bank Index",        assetClass: AssetClass.EQUITY,       sector: "Banking",      region: "India",  currency: "INR" },
  { ticker: "NIFTY_IT",     name: "Nifty IT Index",          assetClass: AssetClass.EQUITY,       sector: "Technology",   region: "India",  currency: "INR" },
  { ticker: "NIFTY_PHARMA", name: "Nifty Pharma Index",      assetClass: AssetClass.EQUITY,       sector: "Healthcare",   region: "India",  currency: "INR" },
  { ticker: "NIFTY_FMCG",   name: "Nifty FMCG Index",        assetClass: AssetClass.EQUITY,       sector: "Consumer",     region: "India",  currency: "INR" },
  { ticker: "SMALLCAP",     name: "Nifty Smallcap 100",      assetClass: AssetClass.EQUITY,       sector: "Small Cap",    region: "India",  currency: "INR" },

  // ── US Equities ────────────────────────────────────────────────────────────
  { ticker: "SPX",          name: "S&P 500 Index",           assetClass: AssetClass.EQUITY,       sector: "Broad Market", region: "US",     currency: "USD" },

  // ── Commodities ────────────────────────────────────────────────────────────
  { ticker: "GOLD",         name: "Gold Spot (XAU/USD)",     assetClass: AssetClass.COMMODITY,    sector: "Precious Metals", region: "Global", currency: "USD" },
  { ticker: "SILVER",       name: "Silver Spot (XAG/USD)",   assetClass: AssetClass.COMMODITY,    sector: "Precious Metals", region: "Global", currency: "USD" },
  { ticker: "COPPER",       name: "Copper Futures",          assetClass: AssetClass.COMMODITY,    sector: "Industrial Metals", region: "Global", currency: "USD" },
  { ticker: "CRUDE_OIL",    name: "WTI Crude Oil",           assetClass: AssetClass.COMMODITY,    sector: "Energy",       region: "Global", currency: "USD" },

  // ── Currencies ─────────────────────────────────────────────────────────────
  { ticker: "DXY",          name: "US Dollar Index",         assetClass: AssetClass.CURRENCY,     sector: "FX",           region: "Global", currency: "USD" },
  { ticker: "USDINR",       name: "USD / INR",               assetClass: AssetClass.CURRENCY,     sector: "FX",           region: "India",  currency: "INR" },

  // ── Fixed Income ───────────────────────────────────────────────────────────
  { ticker: "US10Y",        name: "US 10-Year Treasury Yield", assetClass: AssetClass.FIXED_INCOME, sector: "Government Bonds", region: "US", currency: "USD" },
  { ticker: "US2Y",         name: "US 2-Year Treasury Yield",  assetClass: AssetClass.FIXED_INCOME, sector: "Government Bonds", region: "US", currency: "USD" },
];

async function main() {
  console.log("🌱 Seeding Asset master table...");

  let created = 0;
  let skipped = 0;

  for (const asset of ASSETS) {
    const result = await prisma.asset.upsert({
      where:  { ticker: asset.ticker },
      update: { name: asset.name, assetClass: asset.assetClass, sector: asset.sector, region: asset.region, currency: asset.currency, isActive: true },
      create: { ...asset, isActive: true },
    });
    const isNew = result.createdAt.getTime() === result.updatedAt.getTime();
    if (isNew) { created++; console.log(`  ✅ Created: ${asset.ticker} — ${asset.name}`); }
    else        { skipped++; console.log(`  ⏭  Updated: ${asset.ticker}`); }
  }

  console.log(`\n✅ Seed complete — ${created} created, ${skipped} updated`);
}

main()
  .catch((e) => { console.error("❌ Seed failed:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
