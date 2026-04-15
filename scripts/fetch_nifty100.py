#!/usr/bin/env python3
"""
Nifty 100 Historical Price Pipeline
=====================================
Fetches daily OHLCV data for all 100 Nifty 100 constituents from Yahoo Finance
and stores in Nifty100Stock + Nifty100Price tables.

Used for:
  - Advance/Decline Ratio  (advances vs declines each day)
  - % Above 200 DMA        (stocks trading above their 200-day SMA)

Modes:
  full        — fetch 10 years of history (first-time setup, ~1-2 min)
  incremental — fetch only since last stored date (daily cron, ~15 sec)

Usage:
  python3 scripts/fetch_nifty100.py                         # full 10Y
  python3 scripts/fetch_nifty100.py --mode incremental      # update since last date
  python3 scripts/fetch_nifty100.py --mode full --years 5   # custom window
  python3 scripts/fetch_nifty100.py --batch-size 25         # tune batch size

Performance design:
  - 25 tickers per batch  →  4 batches total
  - 2 concurrent workers
  - psycopg2 execute_values for bulk DB inserts (10x faster than ORM)
  - Estimated full run: ~1-2 minutes
"""

import sys
import os
import csv
import time
import logging
import argparse
import uuid
from datetime import datetime, date, timedelta
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager

import yfinance as yf
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

# ─── Setup ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.join(SCRIPT_DIR, "..")

load_dotenv(os.path.join(ROOT_DIR, ".env"))
load_dotenv(os.path.join(ROOT_DIR, ".env.local"), override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("nifty100")

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    log.error("DATABASE_URL not set in .env / .env.local")
    sys.exit(1)

CONSTITUENTS_CSV = os.path.join(ROOT_DIR, "data", "nifty100_constituents.csv")

# ─── Config ───────────────────────────────────────────────────────────────────

DEFAULT_YEARS      = 15
DEFAULT_BATCH_SIZE = 25    # tickers per yfinance download call
DEFAULT_WORKERS    = 2     # concurrent batch workers (keep low to avoid rate-limits)
RETRY_ATTEMPTS     = 3
RETRY_DELAY        = 8     # seconds between retries
INTER_BATCH_DELAY  = 3.0   # seconds between batch submissions
DB_INSERT_CHUNK    = 5000  # rows per execute_values call

# ─── DB helpers ───────────────────────────────────────────────────────────────

def parse_db_url(url: str) -> dict:
    """Parse postgresql://user:pass@host:port/dbname into psycopg2 kwargs."""
    import urllib.parse as up
    r = up.urlparse(url)
    return dict(
        host=r.hostname,
        port=r.port or 5432,
        dbname=r.path.lstrip("/"),
        user=up.unquote(r.username or ""),
        password=up.unquote(r.password or ""),
        sslmode="require",
        connect_timeout=30,
    )

@contextmanager
def get_conn():
    conn = psycopg2.connect(**parse_db_url(DATABASE_URL))
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

# ─── Load constituents ────────────────────────────────────────────────────────

def load_constituents() -> list[dict]:
    """Read nifty100_constituents.csv → list of {symbol, ticker, name, industry, isin}."""
    stocks = []
    with open(CONSTITUENTS_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ticker = row.get("Ticker", "").strip()
            symbol = row.get("Symbol", "").strip()
            if not ticker or not symbol:
                continue
            stocks.append({
                "symbol":   symbol,
                "ticker":   ticker,
                "name":     row.get("Company Name", "").strip(),
                "industry": row.get("Industry", "").strip() or None,
                "isin":     row.get("ISIN Code", "").strip() or None,
            })
    log.info(f"Loaded {len(stocks)} constituents from CSV")
    return stocks

# ─── Upsert stock metadata ────────────────────────────────────────────────────

def upsert_stocks(stocks: list[dict]) -> dict[str, str]:
    """
    Upsert all stocks into Nifty100Stock table.
    Returns {ticker: stock_id} mapping.
    """
    ticker_to_id: dict[str, str] = {}

    with get_conn() as conn:
        cur = conn.cursor()

        # Ensure table exists (defensive — Prisma migrate should handle this)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS "Nifty100Stock" (
                id        TEXT PRIMARY KEY,
                symbol    TEXT UNIQUE NOT NULL,
                ticker    TEXT UNIQUE NOT NULL,
                name      TEXT NOT NULL,
                industry  TEXT,
                isin      TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        for s in stocks:
            stock_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO "Nifty100Stock" (id, symbol, ticker, name, industry, isin, "createdAt", "updatedAt")
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (ticker) DO UPDATE SET
                    name      = EXCLUDED.name,
                    industry  = EXCLUDED.industry,
                    isin      = EXCLUDED.isin,
                    "updatedAt" = NOW()
                RETURNING id
            """, (stock_id, s["symbol"], s["ticker"], s["name"], s["industry"], s["isin"]))
            row = cur.fetchone()
            if row:
                ticker_to_id[s["ticker"]] = row[0]

        # Also create price table if needed
        cur.execute("""
            CREATE TABLE IF NOT EXISTS "Nifty100Price" (
                id        TEXT PRIMARY KEY,
                "stockId" TEXT NOT NULL REFERENCES "Nifty100Stock"(id) ON DELETE CASCADE,
                date      DATE NOT NULL,
                open      DOUBLE PRECISION NOT NULL,
                high      DOUBLE PRECISION NOT NULL,
                low       DOUBLE PRECISION NOT NULL,
                close     DOUBLE PRECISION NOT NULL,
                volume    BIGINT,
                UNIQUE ("stockId", date)
            )
        """)
        cur.execute('CREATE INDEX IF NOT EXISTS idx_n100price_stockdate ON "Nifty100Price"("stockId", date)')
        cur.execute('CREATE INDEX IF NOT EXISTS idx_n100price_date ON "Nifty100Price"(date)')

    log.info(f"Upserted {len(ticker_to_id)} stocks into Nifty100Stock")
    return ticker_to_id

# ─── Get last stored date per ticker ─────────────────────────────────────────

def get_last_dates(ticker_to_id: dict[str, str]) -> dict[str, Optional[date]]:
    """Return {ticker: last_date_stored} for incremental mode."""
    id_to_ticker = {v: k for k, v in ticker_to_id.items()}
    result: dict[str, Optional[date]] = {t: None for t in ticker_to_id}

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT "stockId", MAX(date)
            FROM "Nifty100Price"
            GROUP BY "stockId"
        """)
        for stock_id, max_date in cur.fetchall():
            ticker = id_to_ticker.get(stock_id)
            if ticker:
                result[ticker] = max_date

    covered = sum(1 for v in result.values() if v is not None)
    log.info(f"Incremental mode: {covered}/{len(result)} tickers have existing data")
    return result

# ─── Download one batch of tickers ───────────────────────────────────────────

def _extract_ticker_df(raw: pd.DataFrame, ticker: str) -> pd.DataFrame | None:
    """
    Extract a single ticker's OHLCV from a multi-ticker yfinance DataFrame.
    Handles both MultiIndex structures yfinance produces across versions:
      - (Price, Ticker): level-0 = Open/Close/..., level-1 = ticker  [older]
      - (Ticker, Price): level-0 = ticker, level-1 = Open/Close/...  [newer group_by]
    """
    cols = raw.columns
    if not isinstance(cols, pd.MultiIndex):
        return None

    # Try group_by='ticker' layout: raw[ticker] gives flat OHLCV
    try:
        df = raw[ticker].copy()
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(-1)
        needed = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
        if "Close" not in needed:
            return None
        df = df[needed].dropna(subset=["Close"])
        return df if not df.empty else None
    except (KeyError, TypeError):
        pass

    # Fallback: (Price, Ticker) layout — xs on level 1
    try:
        df = raw.xs(ticker, axis=1, level=1)[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.dropna(subset=["Close"], inplace=True)
        return df if not df.empty else None
    except (KeyError, TypeError):
        pass

    # Fallback: (Ticker, Price) layout — xs on level 0
    try:
        df = raw.xs(ticker, axis=1, level=0)[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.dropna(subset=["Close"], inplace=True)
        return df if not df.empty else None
    except (KeyError, TypeError):
        pass

    return None


def download_batch(
    tickers: list[str],
    start: str,
    end: str,
    attempt: int = 1,
) -> dict[str, pd.DataFrame]:
    """
    Download OHLCV for a batch of tickers. Returns {ticker: df} mapping.
    df columns: Open, High, Low, Close, Volume  (index = Date)
    """
    try:
        raw = yf.download(
            tickers=tickers,
            start=start,
            end=end,
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=True,
            group_by="ticker",
        )
        if raw.empty:
            return {}

        result: dict[str, pd.DataFrame] = {}

        if len(tickers) == 1:
            t = tickers[0]
            try:
                df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
            except KeyError:
                df = _extract_ticker_df(raw, t)
                if df is None:
                    return {}
            df.dropna(subset=["Close"], inplace=True)
            if not df.empty:
                result[t] = df
        else:
            for t in tickers:
                df = _extract_ticker_df(raw, t)
                if df is not None:
                    result[t] = df

        hit_rate = len(result) / len(tickers)
        if hit_rate < 0.20 and attempt < RETRY_ATTEMPTS:
            log.warning(
                f"Only {len(result)}/{len(tickers)} tickers returned data "
                f"({hit_rate:.0%}) — likely rate-limited. "
                f"Waiting {RETRY_DELAY * attempt}s before retry {attempt+1}/{RETRY_ATTEMPTS}..."
            )
            time.sleep(RETRY_DELAY * attempt)
            return download_batch(tickers, start, end, attempt + 1)

        return result

    except Exception as e:
        if attempt < RETRY_ATTEMPTS:
            log.warning(f"Batch download attempt {attempt} failed: {e}. Retrying in {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY * attempt)
            return download_batch(tickers, start, end, attempt + 1)
        else:
            log.error(f"Batch failed after {RETRY_ATTEMPTS} attempts: {e}")
            return {}

# ─── Bulk insert price rows ───────────────────────────────────────────────────

def bulk_insert_prices(
    ticker_dfs: dict[str, pd.DataFrame],
    ticker_to_id: dict[str, str],
    conn: psycopg2.extensions.connection,
) -> int:
    """Bulk-upsert price rows into Nifty100Price. Returns count of rows processed."""
    rows = []

    for ticker, df in ticker_dfs.items():
        stock_id = ticker_to_id.get(ticker)
        if not stock_id:
            continue

        for dt, row in df.iterrows():
            close  = row.get("Close")
            if pd.isna(close) or close <= 0:
                continue

            open_  = row.get("Open",   close)
            high   = row.get("High",   close)
            low    = row.get("Low",    close)
            vol    = row.get("Volume")

            if hasattr(dt, "date"):
                d = dt.date()
            else:
                d = pd.Timestamp(dt).date()

            rows.append((
                str(uuid.uuid4()),
                stock_id,
                d,
                float(open_) if not pd.isna(open_) else float(close),
                float(high)  if not pd.isna(high)  else float(close),
                float(low)   if not pd.isna(low)   else float(close),
                float(close),
                int(vol) if vol is not None and not pd.isna(vol) else None,
            ))

    if not rows:
        return 0

    cur = conn.cursor()
    for i in range(0, len(rows), DB_INSERT_CHUNK):
        chunk = rows[i : i + DB_INSERT_CHUNK]
        execute_values(
            cur,
            """
            INSERT INTO "Nifty100Price" (id, "stockId", date, open, high, low, close, volume)
            VALUES %s
            ON CONFLICT ("stockId", date) DO UPDATE SET
                open   = EXCLUDED.open,
                high   = EXCLUDED.high,
                low    = EXCLUDED.low,
                close  = EXCLUDED.close,
                volume = EXCLUDED.volume
            """,
            chunk,
            page_size=1000,
        )
    conn.commit()
    return len(rows)

# ─── Main pipeline ────────────────────────────────────────────────────────────

def run_pipeline(mode: str = "full", years: int = DEFAULT_YEARS, batch_size: int = DEFAULT_BATCH_SIZE):
    start_time = time.time()

    # 1. Load constituent list
    stocks      = load_constituents()
    all_tickers = [s["ticker"] for s in stocks]

    # 2. Upsert metadata → get {ticker: id}
    ticker_to_id = upsert_stocks(stocks)

    # 3. Determine fetch window
    today    = date.today()
    end_str  = today.strftime("%Y-%m-%d")

    if mode == "incremental":
        last_dates = get_last_dates(ticker_to_id)
        stored_dates = [d for d in last_dates.values() if d is not None]
        if stored_dates:
            min_last  = min(stored_dates) + timedelta(days=1)
            start_str = min_last.strftime("%Y-%m-%d")
        else:
            log.info("No existing data found — switching to full mode")
            mode      = "full"
            start_str = (today - timedelta(days=365 * years)).strftime("%Y-%m-%d")
    else:
        start_str = (today - timedelta(days=365 * years)).strftime("%Y-%m-%d")

    log.info(f"Mode: {mode} | Fetch window: {start_str} → {end_str}")
    log.info(f"Tickers: {len(all_tickers)} | Batch size: {batch_size}")

    # 4. Split into batches
    batches = [all_tickers[i : i + batch_size] for i in range(0, len(all_tickers), batch_size)]
    log.info(f"Batches: {len(batches)} | Workers: {DEFAULT_WORKERS}")

    # 5. Download batches in parallel
    total_rows    = 0
    batch_results: dict[str, pd.DataFrame] = {}

    log.info("─" * 60)
    log.info("PHASE 1: Downloading from Yahoo Finance...")
    log.info("─" * 60)

    lock_results: dict[int, dict[str, pd.DataFrame]] = {}

    def fetch_batch(idx: int, batch: list[str]) -> tuple[int, dict[str, pd.DataFrame]]:
        log.info(f"  Batch {idx+1}/{len(batches)}: downloading {len(batch)} tickers [{batch[0]} … {batch[-1]}]")
        result  = download_batch(batch, start_str, end_str)
        missing = [t for t in batch if t not in result]
        if missing:
            log.warning(f"  Batch {idx+1}: {len(missing)} tickers returned no data: {missing[:5]}{'...' if len(missing)>5 else ''}")
        return idx, result

    with ThreadPoolExecutor(max_workers=DEFAULT_WORKERS) as executor:
        futures = {}
        for i, batch in enumerate(batches):
            if i > 0:
                time.sleep(INTER_BATCH_DELAY)
            futures[executor.submit(fetch_batch, i, batch)] = i

        for future in as_completed(futures):
            idx, result = future.result()
            lock_results[idx] = result
            log.info(f"  ✓ Batch {idx+1} complete: {len(result)} tickers with data")

    for result in lock_results.values():
        batch_results.update(result)

    log.info(f"\nDownload complete: {len(batch_results)}/{len(all_tickers)} tickers fetched")

    # 6. Bulk insert into DB
    log.info("─" * 60)
    log.info("PHASE 2: Inserting into database...")
    log.info("─" * 60)

    insert_batch_size = 50
    ticker_list = list(batch_results.keys())

    with get_conn() as conn:
        for i in range(0, len(ticker_list), insert_batch_size):
            sub = {t: batch_results[t] for t in ticker_list[i : i + insert_batch_size]}
            rows_inserted = bulk_insert_prices(sub, ticker_to_id, conn)
            total_rows += rows_inserted
            log.info(f"  Inserted rows {i+1}–{min(i+insert_batch_size, len(ticker_list))}: +{rows_inserted:,} rows")

    # 7. Summary
    elapsed = time.time() - start_time
    log.info("─" * 60)
    log.info(f"DONE in {elapsed:.1f}s")
    log.info(f"  Tickers fetched : {len(batch_results):>6}")
    log.info(f"  Tickers missing : {len(all_tickers) - len(batch_results):>6}")
    log.info(f"  Total rows      : {total_rows:>6,}")
    log.info("─" * 60)

    return {
        "tickers_fetched": len(batch_results),
        "tickers_missing": len(all_tickers) - len(batch_results),
        "total_rows":      total_rows,
        "elapsed_sec":     round(elapsed, 1),
    }

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Nifty 100 historical price pipeline")
    parser.add_argument(
        "--mode", choices=["full", "incremental"], default="full",
        help="full = 10Y history; incremental = since last stored date",
    )
    parser.add_argument(
        "--years", type=int, default=DEFAULT_YEARS,
        help=f"Years of history for full mode (default: {DEFAULT_YEARS})",
    )
    parser.add_argument(
        "--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
        help=f"Tickers per yfinance batch (default: {DEFAULT_BATCH_SIZE})",
    )
    args = parser.parse_args()

    stats = run_pipeline(
        mode=args.mode,
        years=args.years,
        batch_size=args.batch_size,
    )
    sys.exit(0)
