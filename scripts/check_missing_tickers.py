#!/usr/bin/env python3
"""
Check which Nifty500 tickers are missing from DB and test them against Yahoo Finance.
Prints: ticker | available? | date_range | row_count | suggested_fix
"""

import os, sys, csv
from datetime import date, timedelta
import yfinance as yf
import psycopg2
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.join(SCRIPT_DIR, "..")
load_dotenv(os.path.join(ROOT_DIR, ".env"))
load_dotenv(os.path.join(ROOT_DIR, ".env.local"), override=True)

DATABASE_URL      = os.getenv("DATABASE_URL", "")
CONSTITUENTS_CSV  = os.path.join(ROOT_DIR, "data", "nifty500_constituents.csv")

def parse_db_url(url):
    import urllib.parse as up
    r = up.urlparse(url)
    return dict(
        host=r.hostname, port=r.port or 5432,
        dbname=r.path.lstrip("/"),
        user=up.unquote(r.username or ""),
        password=up.unquote(r.password or ""),
        sslmode="require", connect_timeout=30,
    )

# ── Load all tickers from CSV ─────────────────────────────────────────────────
all_tickers = {}
with open(CONSTITUENTS_CSV, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        t = row.get("Ticker","").strip()
        s = row.get("Symbol","").strip()
        n = row.get("Company Name","").strip()
        if t: all_tickers[t] = {"symbol": s, "name": n}

# ── Find tickers with 0 rows in DB ────────────────────────────────────────────
conn = psycopg2.connect(**parse_db_url(DATABASE_URL))
cur  = conn.cursor()
cur.execute("""
    SELECT s.ticker, COUNT(p.id) AS rows
    FROM "Nifty500Stock" s
    LEFT JOIN "Nifty500Price" p ON p."stockId" = s.id
    GROUP BY s.ticker
    HAVING COUNT(p.id) = 0
""")
zero_rows = {row[0] for row in cur.fetchall()}

# Tickers not even in Nifty500Stock
cur.execute('SELECT ticker FROM "Nifty500Stock"')
in_db = {row[0] for row in cur.fetchall()}
conn.close()

not_in_db = set(all_tickers.keys()) - in_db
missing   = zero_rows | not_in_db

print(f"Total tickers in CSV  : {len(all_tickers)}")
print(f"Tickers in DB         : {len(in_db)}")
print(f"Tickers with 0 prices : {len(zero_rows)}")
print(f"Tickers not in DB     : {len(not_in_db)}")
print(f"Total missing         : {len(missing)}\n")

if not missing:
    print("✅  All tickers have data — nothing to check.")
    sys.exit(0)

print(f"Checking {len(missing)} missing tickers against Yahoo Finance...")
print("─" * 90)
print(f"{'Ticker':<20} {'Symbol':<15} {'YF Available':<14} {'Date Range':<28} {'Rows':<8} {'Note'}")
print("─" * 90)

end   = date.today()
start = end - timedelta(days=365*10)

found_count = 0
not_found   = []
results     = []

for ticker in sorted(missing):
    meta = all_tickers.get(ticker, {})
    try:
        df = yf.download(
            tickers=ticker,
            start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            interval="1d",
            auto_adjust=True,
            progress=False,
        )
        if df is None or df.empty:
            avail = "NO"
            date_range = "—"
            rows = 0
            note = "No data on Yahoo Finance"
            not_found.append(ticker)
        else:
            avail = "YES"
            first = df.index[0].strftime("%Y-%m-%d")
            last  = df.index[-1].strftime("%Y-%m-%d")
            rows  = len(df)
            years = rows / 252
            date_range = f"{first} → {last}"
            note = f"~{years:.1f}y of data"
            found_count += 1
        results.append((ticker, meta.get("symbol",""), avail, date_range, rows, note))
    except Exception as e:
        results.append((ticker, meta.get("symbol",""), "ERROR", "—", 0, str(e)[:40]))
        not_found.append(ticker)

# Sort: available first
results.sort(key=lambda x: (0 if x[2]=="YES" else 1, x[0]))

for ticker, symbol, avail, dr, rows, note in results:
    avail_str = "✅ YES" if avail=="YES" else ("❌ NO" if avail=="NO" else "⚠️  ERR")
    print(f"{ticker:<20} {symbol:<15} {avail_str:<14} {dr:<28} {rows:<8} {note}")

print("─" * 90)
print(f"\nSummary:")
print(f"  Available on Yahoo : {found_count}/{len(missing)}")
print(f"  Not available      : {len(not_found)}/{len(missing)}")

if not_found:
    print(f"\n  Tickers with no Yahoo Finance data:")
    for t in sorted(not_found):
        m = all_tickers.get(t, {})
        print(f"    {t:<20}  ({m.get('symbol','?')})  {m.get('name','')}")
