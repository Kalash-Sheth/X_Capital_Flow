#!/usr/bin/env python3
"""
X-Capital Flow — Real-time Data Pipeline

Continuously stacks live OHLCV and Options OI for all 15 equity indices.

Indices covered:
  NSE (via Dhan OHLC + history, 14 indices):
    NIFTY50, NIFTY_100, NIFTY_BANK, FINNIFTY,
    NIFTY_IT, NIFTY_METAL, NIFTY_ENERGY,
    NIFTY_PHARMA, NIFTY_FMCG,
    NIFTY_SMALLCAP (=Smallcap 250), NIFTY_AUTO, NIFTY_INFRA,
    NIFTY_REALTY, NIFTY_MEDIA
  BSE (via Yahoo Finance, 1 index):
    SENSEX

Options OI (Dhan, 3 liquid underlyings):
  NIFTY50 (NIFTY), NIFTY_BANK (BANKNIFTY), FINNIFTY

Schedule (IST = UTC+5:30, Mon–Fri only):
  Startup     : per-ticker gap-check — back-fill any missing bars for ALL 15 indices
  Every 5 min : Live OHLC snapshot  [09:10–15:40 IST]
  Every 15 min: Options OI + PCR    [09:10–15:35 IST]
  15:45 IST   : EOD bar + final options snapshot
  Midnight    : gap-check for all tickers

Usage:
  python3 scripts/pipeline.py            # continuous mode (run forever)
  python3 scripts/pipeline.py --once     # one-shot: gap-fill + live + options then exit
  python3 scripts/pipeline.py --check    # show DB status only
  python3 scripts/pipeline.py --backfill --days 1825  # force full re-fetch for all
"""

import sys
import os
import time
import argparse
from datetime import datetime, timezone, timedelta, date

from dotenv import load_dotenv
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_BASE, '.env'))
load_dotenv(os.path.join(_BASE, '.env.local'), override=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import (
    get_conn,
    ensure_assets_exist,
    run_dhan_history,
    run_dhan_live,
    run_dhan_options,
    run_live,
    run_history,
    fetch_yahoo_history_ticker,
    _upsert_symbol,
    CORE_3_TICKERS,
    DHAN_TICKERS,
    ALL_INDEX_TICKERS,
    YAHOO_COMMODITY_TICKERS,
    DHAN_ENABLED,
)

IST = timezone(timedelta(hours=5, minutes=30))


def now_ist() -> datetime:
    return datetime.now(IST)


def is_market_open() -> bool:
    t = now_ist()
    if t.weekday() >= 5:
        return False
    mkt_open  = t.replace(hour=9,  minute=10, second=0, microsecond=0)
    mkt_close = t.replace(hour=15, minute=40, second=0, microsecond=0)
    return mkt_open <= t <= mkt_close


def is_weekday() -> bool:
    return now_ist().weekday() < 5


# ─── DB gap check (all 15 indices) ───────────────────────────────────────────

def check_db_status(conn, asset_ids: dict) -> dict:
    """
    Returns per-ticker status for all 15 equity indices.
    {ticker: {count, latest, gap_days, vol_rows, dhan_rows}}
    """
    today  = date.today()
    status = {}
    with conn.cursor() as cur:
        for ticker in sorted(ALL_INDEX_TICKERS):
            asset_id = asset_ids.get(ticker)
            if not asset_id:
                status[ticker] = {'count': 0, 'latest': None, 'gap_days': 9999,
                                  'vol_rows': 0, 'dhan_rows': 0}
                continue
            cur.execute(
                '''
                SELECT
                    COUNT(*) as cnt,
                    MAX(timestamp::date) as latest,
                    SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) as vol_rows,
                    SUM(CASE WHEN source LIKE 'dhan%%' THEN 1 ELSE 0 END) as dhan_rows
                FROM "PriceData"
                WHERE "assetId" = %s
                ''',
                (asset_id,),
            )
            row      = cur.fetchone()
            latest   = row[1]
            gap_days = (today - latest).days if latest else 9999
            status[ticker] = {
                'count':     row[0] or 0,
                'latest':    latest,
                'gap_days':  gap_days,
                'vol_rows':  row[2] or 0,
                'dhan_rows': row[3] or 0,
            }
    return status


def print_db_status(status: dict):
    print('\n╔══════════════════════════════════════════════════════════════╗')
    print('║           Database Status — All 15 Equity Indices           ║')
    print('╠══════════════════════════════════════════════════════════════╣')
    for ticker, s in sorted(status.items()):
        gap  = s['gap_days']
        flag = '✓' if gap <= 3 else '⚠'
        print(f'║  {flag} {ticker:16s}  rows={s["count"]:5d}  dhan={s["dhan_rows"]:5d}'
              f'  vol={s["vol_rows"]:5d}  latest={s["latest"]}  gap={gap}d')
    print('╚══════════════════════════════════════════════════════════════╝\n')


def check_options_status(conn, asset_ids: dict):
    """Print options indicator count per ticker."""
    print('Options OI status:')
    with conn.cursor() as cur:
        for ticker in sorted(ALL_INDEX_TICKERS):
            asset_id = asset_ids.get(ticker)
            if not asset_id:
                continue
            cur.execute(
                'SELECT COUNT(*) FROM "Indicator" WHERE "assetId" = %s AND name LIKE \'OPT_%%\'',
                (asset_id,),
            )
            count = cur.fetchone()[0]
            flag  = '✓' if count > 0 else '✗'
            print(f'  {flag} {ticker:18s}: {count} options indicator rows')


# ─── Commodity (Yahoo Finance) gap-fill ──────────────────────────────────────

def check_commodity_status(conn, asset_ids: dict) -> dict:
    """Returns per-ticker status for all Yahoo commodity tickers."""
    today  = date.today()
    status = {}
    with conn.cursor() as cur:
        for ticker in sorted(YAHOO_COMMODITY_TICKERS):
            asset_id = asset_ids.get(ticker)
            if not asset_id:
                status[ticker] = {'count': 0, 'latest': None, 'gap_days': 9999}
                continue
            cur.execute(
                'SELECT COUNT(*), MAX(timestamp::date) FROM "PriceData" WHERE "assetId" = %s',
                (asset_id,),
            )
            row    = cur.fetchone()
            latest = row[1]
            status[ticker] = {
                'count':    row[0] or 0,
                'latest':   latest,
                'gap_days': (today - latest).days if latest else 9999,
            }
    return status


def backfill_commodities_if_needed(conn, asset_ids: dict, force_days: int = 0):
    """
    Per-ticker gap-fill for all 7 Yahoo Finance commodity assets.
    Fetches 5Y history on first run; only missing gap on subsequent runs.
    """
    status = check_commodity_status(conn, asset_ids)

    print('\n╔══════════════════════════════════════════════════════╗')
    print('║       Database Status — Commodity Assets             ║')
    print('╠══════════════════════════════════════════════════════╣')
    for ticker, s in sorted(status.items()):
        flag = '✓' if s['gap_days'] <= 3 else '⚠'
        print(f'║  {flag} {ticker:16s}  rows={s["count"]:5d}  latest={s["latest"]}  gap={s["gap_days"]}d')
    print('╚══════════════════════════════════════════════════════╝\n')

    if force_days > 0:
        stale = {t: s for t, s in status.items()}
    else:
        stale = {t: s for t, s in status.items() if s['gap_days'] > 3}

    if not stale:
        print('[Pipeline] All commodity assets up-to-date.')
        return

    print(f'[Pipeline] {len(stale)} commodity ticker(s) need gap-fill:')
    for ticker, s in sorted(stale.items()):
        print(f'  • {ticker}: latest={s["latest"]}  gap={s["gap_days"]}d')

    for ticker, s in sorted(stale.items()):
        asset_id = asset_ids.get(ticker)
        if not asset_id:
            continue

        days = force_days if force_days > 0 else (1825 if not s['latest'] else min(s['gap_days'] + 30, 1825))
        print(f'\n[Pipeline] Fetching {ticker} ({days}d)…')
        df = fetch_yahoo_history_ticker(ticker, days=days)
        if df is not None and len(df) > 0:
            _, count = _upsert_symbol(ticker, df, asset_id)
            print(f'  ✓ {ticker}: {count} rows upserted')
        else:
            print(f'  ✗ {ticker}: no data returned')
        time.sleep(1)

    print('\n[Pipeline] Commodity gap-fill complete.')


# ─── Per-ticker gap-fill ──────────────────────────────────────────────────────

def backfill_if_needed(conn, asset_ids: dict, force_days: int = 0):
    """
    Per-ticker gap-fill for ALL 15 equity indices.
    - If force_days > 0: re-fetch that many days for all Dhan tickers.
    - Otherwise: only fetch tickers with gap > 3 trading days.
    SENSEX is skipped here (fetched via Yahoo in run_live).
    """
    status = check_db_status(conn, asset_ids)
    print_db_status(status)

    if force_days > 0:
        print(f'[Pipeline] Force backfill: {force_days} days for all {len(DHAN_TICKERS)} NSE indices…')
        run_dhan_history(conn, asset_ids, days=force_days)
        return

    # Identify tickers that need backfill
    stale = {
        ticker: s for ticker, s in status.items()
        if s['gap_days'] > 3 and ticker in DHAN_TICKERS
    }

    if not stale:
        print('[Pipeline] All NSE indices up-to-date. No backfill needed.')
        return

    print(f'[Pipeline] {len(stale)} ticker(s) need backfill:')
    for ticker, s in sorted(stale.items()):
        print(f'  • {ticker}: latest={s["latest"]}  gap={s["gap_days"]}d  rows={s["count"]}')

    # Per-ticker fetch — only fetch what's missing
    from fetch_prices import _dhan_client, _upsert_dhan_df, fetch_dhan_history
    dhan = _dhan_client()
    if not dhan:
        print('[Pipeline] Dhan client unavailable — cannot backfill.')
        return

    for ticker, s in sorted(stale.items()):
        asset_id = asset_ids.get(ticker)
        if not asset_id:
            continue

        # Fetch from 1 day after latest or 1825 days back if no data
        if s['latest']:
            fetch_days = s['gap_days'] + 10
        else:
            fetch_days = 1825

        to_dt   = date.today()
        from_dt = to_dt - timedelta(days=fetch_days)

        print(f'\n[Pipeline] Backfilling {ticker} ({fetch_days} days)…')

        CHUNK = 365
        frames = []
        chunk_to   = to_dt
        chunk_from = max(from_dt, chunk_to - timedelta(days=CHUNK))

        while chunk_from >= from_dt:
            df_chunk = fetch_dhan_history(
                ticker,
                chunk_from.strftime('%Y-%m-%d'),
                chunk_to.strftime('%Y-%m-%d'),
                dhan,
            )
            if df_chunk is not None and len(df_chunk) > 0:
                frames.append(df_chunk)
                print(f'  chunk {chunk_from} → {chunk_to}: {len(df_chunk)} rows')
            else:
                print(f'  chunk {chunk_from} → {chunk_to}: no data')

            chunk_to   = chunk_from - timedelta(days=1)
            chunk_from = max(from_dt, chunk_to - timedelta(days=CHUNK))
            if chunk_to < from_dt:
                break
            time.sleep(2)

        if frames:
            import pandas as pd
            df = pd.concat(frames).drop_duplicates(subset=['date']).sort_values('date').reset_index(drop=True)
            count = _upsert_dhan_df(conn, asset_id, df)
            print(f'  ✓ {ticker}: {count} rows upserted  ({df["date"].iloc[0]} → {df["date"].iloc[-1]})')
        else:
            print(f'  ✗ {ticker}: no data returned')

        time.sleep(2)

    print('\n[Pipeline] Backfill complete.')


# ─── One-shot mode ────────────────────────────────────────────────────────────

def run_once(conn, asset_ids: dict):
    print('[Pipeline] One-shot: gap-fill → live snapshot → options OI\n')
    backfill_if_needed(conn, asset_ids)
    backfill_commodities_if_needed(conn, asset_ids)

    print('\n[Pipeline] Live OHLC snapshot (all 14 NSE indices + Yahoo commodities)…')
    run_dhan_live(conn, asset_ids)
    run_live(conn, asset_ids, use_cache=False)

    print('\n[Pipeline] Options OI (NIFTY, BANKNIFTY, FINNIFTY)…')
    run_dhan_options(conn, asset_ids)

    print('\n[Pipeline] Done.')


# ─── Continuous scheduler ─────────────────────────────────────────────────────

def run_continuous(asset_ids: dict):
    print('[Pipeline] Continuous mode — Ctrl+C to stop.\n')

    last_live_min:    datetime | None = None
    last_options_min: datetime | None = None
    last_eod_date:    date     | None = None

    while True:
        try:
            t     = now_ist()
            t_min = t.replace(second=0, microsecond=0)
            today = t.date()
            label = t.strftime('%H:%M IST')

            # ── Live OHLC every 5 min during market hours ─────────────────
            live_due = (
                is_market_open()
                and (last_live_min is None or (t_min - last_live_min).seconds >= 300)
            )
            if live_due:
                print(f'\n[{label}] Live OHLC (all 14 NSE indices + Yahoo)…')
                conn = get_conn()
                try:
                    ids = ensure_assets_exist(conn)
                    run_dhan_live(conn, ids)
                    run_live(conn, ids, use_cache=False)
                    last_live_min = t_min
                finally:
                    conn.close()

            # ── Options OI every 15 min during market hours ───────────────
            opts_due = (
                is_market_open()
                and (last_options_min is None or (t_min - last_options_min).seconds >= 900)
            )
            if opts_due:
                print(f'\n[{label}] Options OI (NIFTY, BANKNIFTY, FINNIFTY)…')
                conn = get_conn()
                try:
                    ids = ensure_assets_exist(conn)
                    run_dhan_options(conn, ids)
                    last_options_min = t_min
                finally:
                    conn.close()

            # ── EOD bar at 15:45 IST ──────────────────────────────────────
            eod_trigger = t.replace(hour=15, minute=45, second=0, microsecond=0)
            eod_due = (
                is_weekday()
                and today != last_eod_date
                and t >= eod_trigger
            )
            if eod_due:
                print(f'\n[{label}] EOD: gap-fill all indices + commodities + final options…')
                conn = get_conn()
                try:
                    ids = ensure_assets_exist(conn)
                    backfill_if_needed(conn, ids)
                    backfill_commodities_if_needed(conn, ids)
                    run_dhan_options(conn, ids)
                    last_eod_date = today
                    print(f'[Pipeline] EOD complete for {today}')
                finally:
                    conn.close()

            # ── Midnight gap-check ────────────────────────────────────────
            midnight = t.replace(hour=0, minute=5, second=0, microsecond=0)
            if (is_weekday()
                    and today != last_eod_date
                    and t >= midnight
                    and t < midnight + timedelta(minutes=10)):
                print(f'\n[{label}] Midnight gap-check for all 15 indices + commodities…')
                conn = get_conn()
                try:
                    ids = ensure_assets_exist(conn)
                    backfill_if_needed(conn, ids)
                    backfill_commodities_if_needed(conn, ids)
                finally:
                    conn.close()

            time.sleep(30)

        except KeyboardInterrupt:
            print('\n[Pipeline] Stopped by user.')
            break
        except Exception as e:
            print(f'\n[Pipeline ERROR] {e}')
            print('  Retrying in 60s…')
            time.sleep(60)


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='X-Capital Flow data pipeline')
    parser.add_argument('--once',     action='store_true', help='One-shot then exit')
    parser.add_argument('--check',    action='store_true', help='DB status only')
    parser.add_argument('--backfill', action='store_true', help='Force full re-fetch for all tickers')
    parser.add_argument('--days',     type=int, default=1825, help='Days for forced backfill (default=1825)')
    args = parser.parse_args()

    mode = 'check' if args.check else 'backfill' if args.backfill else 'once' if args.once else 'continuous'

    print('═══════════════════════════════════════════════════════════')
    print('         X-Capital Flow — Real-time Data Pipeline          ')
    print(f'  Started    : {now_ist().strftime("%Y-%m-%d %H:%M:%S IST")}')
    print(f'  Indices    : {len(ALL_INDEX_TICKERS)} equity (14 NSE via Dhan + SENSEX via Yahoo)')
    print(f'  Commodities: {len(YAHOO_COMMODITY_TICKERS)} (Gold/Silver/Crude/NatGas/Copper/Aluminum/Zinc)')
    print(f'  Options    : NIFTY50 / NIFTY_BANK / FINNIFTY')
    print(f'  Dhan       : {"✓ enabled" if DHAN_ENABLED else "✗ token missing — run: python3 scripts/dhan_auth.py"}')
    print(f'  Mode       : {mode}')
    print('═══════════════════════════════════════════════════════════\n')

    if not DHAN_ENABLED:
        print('[ERROR] DHAN_ACCESS_TOKEN not set. Run: python3 scripts/dhan_auth.py')
        sys.exit(1)

    conn      = get_conn()
    asset_ids = ensure_assets_exist(conn)

    # Fix NIFTY_SMALLCAP name → Smallcap 250
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "Asset" SET name = %s WHERE ticker = %s AND name != %s',
            ('Nifty Smallcap 250', 'NIFTY_SMALLCAP', 'Nifty Smallcap 250'),
        )
    conn.commit()

    if args.check:
        status = check_db_status(conn, asset_ids)
        print_db_status(status)
        check_options_status(conn, asset_ids)
        conn.close()
        return

    if args.backfill:
        backfill_if_needed(conn, asset_ids, force_days=args.days)
        backfill_commodities_if_needed(conn, asset_ids, force_days=args.days)
        conn.close()
        return

    if args.once:
        run_once(conn, asset_ids)
        conn.close()
        return

    # Continuous — startup gap-fill then loop
    print('[Pipeline] Startup: checking all indices for missing data…')
    backfill_if_needed(conn, asset_ids)

    print('\n[Pipeline] Startup: checking all commodities for missing data…')
    backfill_commodities_if_needed(conn, asset_ids)

    print('\n[Pipeline] Startup: initial options OI fetch…')
    run_dhan_options(conn, asset_ids)
    conn.close()

    run_continuous(asset_ids)


if __name__ == '__main__':
    main()
