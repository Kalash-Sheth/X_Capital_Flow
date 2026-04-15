#!/usr/bin/env python3
"""
FII / DII Daily Flow Pipeline
==============================
Fetches daily FII & DII cash-market buy/sell/net data from NSE India
and stores it in the FiiDiiFlow table.

Source: NSE India  —  /api/fiidiiTradeReact (public, session-auth required)
Data:   FII/FPI and DII net buy/sell values in ₹ Crores, going back to 2010.

Modes:
  full        — fetch ~15 years of history from START_DATE (first-time setup)
  incremental — fetch only since last stored date (daily cron, fast)

Usage:
  python3 scripts/fetch_fii_dii.py                         # full history
  python3 scripts/fetch_fii_dii.py --mode incremental      # update since last date
  python3 scripts/fetch_fii_dii.py --start 01-01-2015      # custom start (DD-MM-YYYY)
"""

import sys
import os
import time
import logging
import argparse
import uuid
from datetime import datetime, date, timedelta
from contextlib import contextmanager

import requests
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
log = logging.getLogger("fii_dii")

DATABASE_URL = os.getenv("DATABASE_URL", "")
if not DATABASE_URL:
    log.error("DATABASE_URL not set in .env / .env.local")
    sys.exit(1)

# ─── Config ───────────────────────────────────────────────────────────────────

NSE_BASE       = "https://www.nseindia.com"
NSE_API        = "https://www.nseindia.com/api/fiidiiTradeReact"
START_DATE     = "01-01-2010"   # DD-MM-YYYY — earliest NSE history available
CHUNK_DAYS     = 90             # days per API request (NSE tolerates ~3 months)
REQUEST_DELAY  = 2.5            # seconds between API calls (be polite)
RETRY_ATTEMPTS = 3
RETRY_DELAY    = 10             # seconds between retries

NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.nseindia.com/reports-indices-foreign-institutional-investment-fiis",
    "X-Requested-With": "XMLHttpRequest",
}

# ─── DB helpers ───────────────────────────────────────────────────────────────

def parse_db_url(url: str) -> dict:
    import urllib.parse as up
    r = up.urlparse(url)
    return dict(
        host=r.hostname, port=r.port or 5432,
        dbname=r.path.lstrip("/"),
        user=up.unquote(r.username or ""),
        password=up.unquote(r.password or ""),
        sslmode="require", connect_timeout=30,
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

def ensure_table():
    """Create FiiDiiFlow table if it doesn't exist (Prisma migrate handles it, but defensive)."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS "FiiDiiFlow" (
                id        TEXT PRIMARY KEY,
                date      DATE NOT NULL UNIQUE,
                "fiiBuy"  DOUBLE PRECISION NOT NULL,
                "fiiSell" DOUBLE PRECISION NOT NULL,
                "fiiNet"  DOUBLE PRECISION NOT NULL,
                "diiBuy"  DOUBLE PRECISION NOT NULL,
                "diiSell" DOUBLE PRECISION NOT NULL,
                "diiNet"  DOUBLE PRECISION NOT NULL,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        cur.execute('CREATE INDEX IF NOT EXISTS idx_fiidii_date ON "FiiDiiFlow"(date)')
    log.info("Table FiiDiiFlow ready")

def get_last_date() -> date | None:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute('SELECT MAX(date) FROM "FiiDiiFlow"')
        row = cur.fetchone()
        return row[0] if row and row[0] else None

# ─── NSE Session ──────────────────────────────────────────────────────────────

def build_session() -> requests.Session:
    """Create a requests session with NSE cookies (required for API access)."""
    session = requests.Session()
    session.headers.update(NSE_HEADERS)

    log.info("Initialising NSE session (fetching cookies)...")
    try:
        # Hit the homepage to get session cookies
        r = session.get(NSE_BASE, timeout=15)
        r.raise_for_status()
        log.info(f"  NSE session ready — cookies: {list(session.cookies.keys())}")
    except Exception as e:
        log.warning(f"  Could not load NSE homepage: {e} — proceeding without cookies")

    time.sleep(1)
    return session

# ─── Fetch one date range ─────────────────────────────────────────────────────

def fetch_chunk(
    session: requests.Session,
    start: date,
    end: date,
    attempt: int = 1,
) -> list[dict] | None:
    """
    Fetch FII/DII data for a date range.
    Returns list of dicts with keys: date, fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet
    Returns None on unrecoverable failure.
    """
    start_str = start.strftime("%d-%m-%Y")
    end_str   = end.strftime("%d-%m-%Y")
    url       = f"{NSE_API}?startDate={start_str}&endDate={end_str}"

    try:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        data = r.json()

        if not isinstance(data, list) or len(data) == 0:
            log.debug(f"  Empty response for {start_str} → {end_str}")
            return []

        # NSE returns rows like:
        # {"date":"17-Apr-2024","category":"FII/FPI","buyValue":"12345.67","sellValue":"11234.56","netValue":"1111.11"}
        # {"date":"17-Apr-2024","category":"DII",    "buyValue":"...","sellValue":"...","netValue":"..."}
        # Group by date
        by_date: dict[str, dict] = {}
        for row in data:
            d        = row.get("date", "")
            category = row.get("category", "").upper()
            try:
                # Parse "17-Apr-2024" → date object
                parsed = datetime.strptime(d, "%d-%b-%Y").date()
            except ValueError:
                try:
                    parsed = datetime.strptime(d, "%d-%m-%Y").date()
                except ValueError:
                    continue

            key = parsed.isoformat()
            if key not in by_date:
                by_date[key] = {"date": parsed}

            buy  = safe_float(row.get("buyValue",  "0"))
            sell = safe_float(row.get("sellValue", "0"))
            net  = safe_float(row.get("netValue",  "0"))

            if "FII" in category or "FPI" in category:
                by_date[key]["fiiBuy"]  = buy
                by_date[key]["fiiSell"] = sell
                by_date[key]["fiiNet"]  = net
            elif "DII" in category:
                by_date[key]["diiBuy"]  = buy
                by_date[key]["diiSell"] = sell
                by_date[key]["diiNet"]  = net

        # Only keep rows with both FII and DII data
        result = []
        for rec in by_date.values():
            if all(k in rec for k in ("fiiBuy", "fiiSell", "fiiNet", "diiBuy", "diiSell", "diiNet")):
                result.append(rec)

        return result

    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 401:
            # Session expired — rebuild
            log.warning("  401 from NSE — session expired, rebuilding...")
            session.cookies.clear()
            try:
                session.get(NSE_BASE, timeout=15)
            except Exception:
                pass
            time.sleep(3)
        if attempt < RETRY_ATTEMPTS:
            log.warning(f"  HTTP error ({e}), retry {attempt+1}/{RETRY_ATTEMPTS} in {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY * attempt)
            return fetch_chunk(session, start, end, attempt + 1)
        log.error(f"  Failed after {RETRY_ATTEMPTS} attempts: {e}")
        return None

    except Exception as e:
        if attempt < RETRY_ATTEMPTS:
            log.warning(f"  Error ({e}), retry {attempt+1}/{RETRY_ATTEMPTS} in {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY * attempt)
            return fetch_chunk(session, start, end, attempt + 1)
        log.error(f"  Failed after {RETRY_ATTEMPTS} attempts: {e}")
        return None


def safe_float(val) -> float:
    try:
        return float(str(val).replace(",", ""))
    except (ValueError, TypeError):
        return 0.0

# ─── DB Insert ────────────────────────────────────────────────────────────────

def upsert_rows(rows: list[dict]) -> int:
    if not rows:
        return 0
    records = [
        (
            str(uuid.uuid4()),
            r["date"],
            r["fiiBuy"], r["fiiSell"], r["fiiNet"],
            r["diiBuy"], r["diiSell"], r["diiNet"],
        )
        for r in rows
    ]
    with get_conn() as conn:
        cur = conn.cursor()
        execute_values(
            cur,
            """
            INSERT INTO "FiiDiiFlow" (id, date, "fiiBuy", "fiiSell", "fiiNet", "diiBuy", "diiSell", "diiNet", "createdAt", "updatedAt")
            VALUES %s
            ON CONFLICT (date) DO UPDATE SET
                "fiiBuy"  = EXCLUDED."fiiBuy",
                "fiiSell" = EXCLUDED."fiiSell",
                "fiiNet"  = EXCLUDED."fiiNet",
                "diiBuy"  = EXCLUDED."diiBuy",
                "diiSell" = EXCLUDED."diiSell",
                "diiNet"  = EXCLUDED."diiNet",
                "updatedAt" = NOW()
            """,
            records,
            template="(%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())",
            page_size=500,
        )
    return len(records)

# ─── Main pipeline ────────────────────────────────────────────────────────────

def run_pipeline(mode: str = "full", custom_start: str | None = None):
    start_time = time.time()

    ensure_table()

    today = date.today()

    if mode == "incremental":
        last = get_last_date()
        if last:
            fetch_from = last + timedelta(days=1)
            log.info(f"Incremental mode: fetching from {fetch_from} (last stored: {last})")
        else:
            log.info("No existing data — switching to full mode")
            mode = "full"
            fetch_from = datetime.strptime(START_DATE, "%d-%m-%Y").date()
    elif custom_start:
        fetch_from = datetime.strptime(custom_start, "%d-%m-%Y").date()
        log.info(f"Custom start: {fetch_from}")
    else:
        fetch_from = datetime.strptime(START_DATE, "%d-%m-%Y").date()
        log.info(f"Full mode: fetching from {fetch_from}")

    if fetch_from >= today:
        log.info("Already up-to-date. Nothing to fetch.")
        return

    # Build date chunks
    chunks: list[tuple[date, date]] = []
    cur = fetch_from
    while cur < today:
        chunk_end = min(cur + timedelta(days=CHUNK_DAYS - 1), today - timedelta(days=1))
        chunks.append((cur, chunk_end))
        cur = chunk_end + timedelta(days=1)

    log.info(f"Chunks: {len(chunks)} × ~{CHUNK_DAYS} days")
    log.info("─" * 60)

    session     = build_session()
    total_rows  = 0
    failed      = 0

    for i, (c_start, c_end) in enumerate(chunks):
        log.info(f"  [{i+1}/{len(chunks)}] {c_start.strftime('%d-%m-%Y')} → {c_end.strftime('%d-%m-%Y')}")
        rows = fetch_chunk(session, c_start, c_end)

        if rows is None:
            log.warning(f"    Skipping chunk (unrecoverable error)")
            failed += 1
        elif len(rows) == 0:
            log.debug(f"    No data returned (market holidays / weekend only range)")
        else:
            inserted = upsert_rows(rows)
            total_rows += inserted
            log.info(f"    ✓ {inserted} rows upserted")

        # Respect NSE rate limits
        if i < len(chunks) - 1:
            time.sleep(REQUEST_DELAY)

    elapsed = time.time() - start_time
    log.info("─" * 60)
    log.info(f"DONE in {elapsed:.1f}s")
    log.info(f"  Total rows upserted : {total_rows:>6,}")
    log.info(f"  Failed chunks       : {failed:>6}")
    log.info("─" * 60)

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FII/DII daily flow pipeline (NSE India)")
    parser.add_argument(
        "--mode", choices=["full", "incremental"], default="full",
        help="full = history from 2010; incremental = since last stored date",
    )
    parser.add_argument(
        "--start", type=str, default=None,
        help="Custom start date in DD-MM-YYYY format (overrides mode start)",
    )
    args = parser.parse_args()

    run_pipeline(mode=args.mode, custom_start=args.start)
    sys.exit(0)
