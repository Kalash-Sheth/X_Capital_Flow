#!/usr/bin/env python3
"""
X-Capital Flow — Live Price Ingestion Script
Fetches real-time prices for all tracked assets via yfinance
and stores them in NeonDB (PriceData table).

Usage:
  python3 scripts/fetch_prices.py           # live snapshot only (fast, ~5s)
  python3 scripts/fetch_prices.py --history # full OHLCV history ingest
  python3 scripts/fetch_prices.py --days 365 --history
  python3 scripts/fetch_prices.py --all     # live + history
  python3 scripts/fetch_prices.py --no-cache # bypass live cache

Fixes:
  - Sunday/holiday % day change bug: live snapshot stored with actual last
    trading date (not today), so prev-close comparison is always correct.
  - History uses start-date parameter (not unreliable 'Xd' period string).
  - Single yfinance download for live mode (was 2 sequential calls).
  - File-based TTL cache (5 min) for rapid re-runs of live mode.
  - Optional Redis cache: set REDIS_URL in .env.local.
  - Parallel DB upserts via ThreadPoolExecutor in history mode.
"""

import sys
import os
import json
import time
import argparse
import tempfile
from datetime import datetime, timezone, timedelta, date
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
import pandas as pd
import psycopg2
from dotenv import load_dotenv

# ─── Load env ────────────────────────────────────────────────────────────────
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'), override=True)

DATABASE_URL = os.getenv('DATABASE_URL')
if not DATABASE_URL:
    print('[ERROR] DATABASE_URL not set in .env.local', file=sys.stderr)
    sys.exit(1)

DHAN_ACCESS_TOKEN = os.getenv('DHAN_ACCESS_TOKEN', '')
DHAN_CLIENT_ID    = os.getenv('DHAN_CLIENT_ID', '')
DHAN_ENABLED      = bool(DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID)

# ─── Optional Redis ───────────────────────────────────────────────────────────
_redis_client = None
try:
    import redis as _redis_mod
    _REDIS_URL = os.getenv('REDIS_URL')
    if _REDIS_URL:
        _redis_client = _redis_mod.from_url(_REDIS_URL, socket_timeout=2)
        _redis_client.ping()
        print('[cache] Redis connected')
except Exception:
    pass  # Redis not available — fallback to file cache

# ─── File cache config ────────────────────────────────────────────────────────
_CACHE_FILE = os.path.join(tempfile.gettempdir(), 'xcapital_live_cache.json')
_CACHE_TTL  = 300  # 5 minutes


def _cache_get(key: str):
    """Read from Redis (preferred) or file cache. Returns None if miss/expired."""
    try:
        if _redis_client:
            raw = _redis_client.get(key)
            return json.loads(raw) if raw else None
    except Exception:
        pass
    # File fallback
    try:
        with open(_CACHE_FILE) as f:
            entry = json.load(f)
        if entry.get('key') == key and time.time() - entry['ts'] < _CACHE_TTL:
            return entry['data']
    except Exception:
        pass
    return None


def _cache_set(key: str, data):
    """Write to Redis (preferred) or file cache."""
    try:
        if _redis_client:
            _redis_client.setex(key, _CACHE_TTL, json.dumps(data))
            return
    except Exception:
        pass
    # File fallback
    try:
        with open(_CACHE_FILE, 'w') as f:
            json.dump({'key': key, 'ts': time.time(), 'data': data}, f)
    except Exception:
        pass


# ─── Ticker mappings ─────────────────────────────────────────────────────────
TICKER_MAP = {
    # NSE Equity Indices are handled exclusively by Dhan API (real volume).
    # They are intentionally excluded here so Yahoo Finance never overwrites
    # Dhan data in the database.
    #
    # ── Commodities ───────────────────────────────────────────────────────────
    'GOLD':        'GC=F',
    'SILVER':      'SI=F',
    'COPPER':      'HG=F',
    'CRUDE_OIL':   'CL=F',
    'NATURAL_GAS': 'NG=F',
    'ALUMINUM':    'ALI=F',
    'ZINC':        'ZNC=F',
    # ── Currencies ────────────────────────────────────────────────────────────
    'DXY':       'DX-Y.NYB',
    'USDINR':    'USDINR=X',
    # ── US Market ─────────────────────────────────────────────────────────────
    'SPX':       '^GSPC',
    # ── Fixed income ──────────────────────────────────────────────────────────
    'US10Y':     '^TNX',
    'US2Y':      '^IRX',
    # ── BSE Index (price only — no Dhan historical for BSE segment) ───────────
    'SENSEX':    '^BSESN',
    # ── India VIX (market fear gauge — NSE) ───────────────────────────────────
    'INDIAVIX':  '^INDIAVIX',
    # ── NSE Smallcap — Dhan DH-905 blocks historical; Yahoo Finance fallback ──
    'NIFTY_SMALLCAP': '^CNXSC',
}

# Metadata for auto-creating Asset records in DB
ASSET_META = {
    # NSE Equity Indices — Core
    'NIFTY50':       {'name': 'Nifty 50',             'assetClass': 'EQUITY', 'sector': 'Broad Market',  'currency': 'INR'},
    'NIFTY_100':     {'name': 'Nifty 100',            'assetClass': 'EQUITY', 'sector': 'Broad Market',  'currency': 'INR'},
    'NIFTY_BANK':    {'name': 'Nifty Bank',           'assetClass': 'EQUITY', 'sector': 'Banking',       'currency': 'INR'},
    'FINNIFTY':      {'name': 'Fin Nifty',            'assetClass': 'EQUITY', 'sector': 'Financial',     'currency': 'INR'},
    # NSE Equity Indices — Macro Sensitive
    'NIFTY_IT':      {'name': 'Nifty IT',             'assetClass': 'EQUITY', 'sector': 'Technology',    'currency': 'INR'},
    'NIFTY_METAL':   {'name': 'Nifty Metal',          'assetClass': 'EQUITY', 'sector': 'Metal',         'currency': 'INR'},
    'NIFTY_ENERGY':  {'name': 'Nifty Energy',         'assetClass': 'EQUITY', 'sector': 'Energy',        'currency': 'INR'},
    # NSE Equity Indices — Defensive
    'NIFTY_PHARMA':  {'name': 'Nifty Pharma',         'assetClass': 'EQUITY', 'sector': 'Pharma',        'currency': 'INR'},
    'NIFTY_FMCG':    {'name': 'Nifty FMCG',           'assetClass': 'EQUITY', 'sector': 'FMCG',          'currency': 'INR'},
    # NSE Equity Indices — High Beta / Liquidity
    'NIFTY_SMALLCAP':{'name': 'Nifty Smallcap 100',  'assetClass': 'EQUITY', 'sector': 'Smallcap',      'currency': 'INR'},
    'NIFTY_AUTO':    {'name': 'Nifty Auto',           'assetClass': 'EQUITY', 'sector': 'Auto',          'currency': 'INR'},
    'NIFTY_INFRA':   {'name': 'Nifty Infra',          'assetClass': 'EQUITY', 'sector': 'Infrastructure', 'currency': 'INR'},
    'NIFTY_REALTY':  {'name': 'Nifty Realty',         'assetClass': 'EQUITY', 'sector': 'Realty',        'currency': 'INR'},
    'NIFTY_MEDIA':   {'name': 'Nifty Media',          'assetClass': 'EQUITY', 'sector': 'Media',         'currency': 'INR'},
    # BSE Index (via Yahoo Finance — price only, no Dhan)
    'SENSEX':        {'name': 'BSE Sensex',           'assetClass': 'EQUITY', 'sector': 'Broad Market',  'currency': 'INR'},
    # Commodities — precious metals
    'GOLD':        {'name': 'Gold',              'assetClass': 'COMMODITY', 'sector': 'Precious Metal', 'currency': 'USD'},
    'SILVER':      {'name': 'Silver',            'assetClass': 'COMMODITY', 'sector': 'Precious Metal', 'currency': 'USD'},
    # Commodities — energy
    'CRUDE_OIL':   {'name': 'Crude Oil (WTI)',   'assetClass': 'COMMODITY', 'sector': 'Energy',         'currency': 'USD'},
    'NATURAL_GAS': {'name': 'Natural Gas',       'assetClass': 'COMMODITY', 'sector': 'Energy',         'currency': 'USD'},
    # Commodities — base metals
    'COPPER':      {'name': 'Copper',            'assetClass': 'COMMODITY', 'sector': 'Base Metal',     'currency': 'USD'},
    'ALUMINUM':    {'name': 'Aluminum',          'assetClass': 'COMMODITY', 'sector': 'Base Metal',     'currency': 'USD'},
    'ZINC':        {'name': 'Zinc',              'assetClass': 'COMMODITY', 'sector': 'Base Metal',     'currency': 'USD'},
    # Currencies
    'DXY':       {'name': 'US Dollar Index','assetClass': 'CURRENCY',     'sector': None,           'currency': 'USD'},
    'USDINR':    {'name': 'USD / INR',      'assetClass': 'CURRENCY',     'sector': None,           'currency': 'INR'},
    # US Market
    'SPX':       {'name': 'S&P 500',        'assetClass': 'EQUITY',       'sector': 'Broad Market', 'currency': 'USD'},
    # Fixed income
    'US10Y':     {'name': 'US 10-Year Yield','assetClass': 'FIXED_INCOME','sector': None,           'currency': 'USD'},
    'US2Y':      {'name': 'US 2-Year Yield', 'assetClass': 'FIXED_INCOME','sector': None,           'currency': 'USD'},
    # India VIX — market fear index
    'INDIAVIX':  {'name': 'India VIX',       'assetClass': 'EQUITY',      'sector': 'Volatility',   'currency': 'INR'},
}

# Yahoo Finance-sourced commodity tickers (fetched via yfinance, not Dhan)
YAHOO_COMMODITY_TICKERS = {'GOLD', 'SILVER', 'CRUDE_OIL', 'NATURAL_GAS', 'COPPER', 'ALUMINUM', 'ZINC', 'INDIAVIX'}

# All Yahoo-sourced cross-market assets (non-Dhan, non-equity-index)
# Includes commodities + FX + bonds + VIX — all gap-filled via Yahoo history
YAHOO_CROSSMARKET_TICKERS = YAHOO_COMMODITY_TICKERS | {'DXY', 'USDINR', 'US10Y', 'US2Y', 'INDIAVIX', 'SPX', 'SENSEX'}

# ─── DB helpers ───────────────────────────────────────────────────────────────

def get_conn():
    return psycopg2.connect(
        DATABASE_URL,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
        connect_timeout=30,
    )


def get_asset_id_map(conn) -> dict:
    """Returns {ticker: id} for all assets in DB."""
    with conn.cursor() as cur:
        cur.execute('SELECT ticker, id FROM "Asset"')
        return {row[0]: row[1] for row in cur.fetchall()}


def ensure_assets_exist(conn) -> dict:
    """Upserts all ASSET_META entries into the Asset table. Returns updated {ticker: id} map."""
    with conn.cursor() as cur:
        for ticker, meta in ASSET_META.items():
            cur.execute(
                '''
                INSERT INTO "Asset" (id, ticker, name, "assetClass", sector, region, currency, "isActive", "createdAt", "updatedAt")
                VALUES (
                    gen_random_uuid(), %s, %s,
                    %s::"AssetClass",
                    %s, %s, %s, TRUE, NOW(), NOW()
                )
                ON CONFLICT (ticker) DO UPDATE SET
                    name        = EXCLUDED.name,
                    "assetClass"= EXCLUDED."assetClass",
                    sector      = EXCLUDED.sector,
                    currency    = EXCLUDED.currency,
                    "updatedAt" = NOW()
                ''',
                (
                    ticker,
                    meta['name'],
                    meta['assetClass'],
                    meta.get('sector'),
                    'India' if meta.get('currency') == 'INR' else 'Global',
                    meta.get('currency', 'USD'),
                ),
            )
    conn.commit()
    print(f'[DB] Ensured {len(ASSET_META)} asset records exist')
    return get_asset_id_map(conn)


def upsert_indicators(conn, asset_id: str, ticker: str, indicators: dict, ts: datetime):
    """
    Upserts computed indicator values into the Indicator table.
    indicators = {name: value} e.g. {'RSI_14': 58.2, 'MACD_HIST': 12.3, ...}
    """
    if not indicators:
        return
    with conn.cursor() as cur:
        for name, value in indicators.items():
            if value is None or (isinstance(value, float) and (value != value)):  # NaN check
                continue
            cur.execute(
                '''
                INSERT INTO "Indicator" (id, "assetId", name, value, timestamp, "createdAt")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, NOW())
                ON CONFLICT ("assetId", name, timestamp)
                DO UPDATE SET value = EXCLUDED.value, "createdAt" = NOW()
                ''',
                (asset_id, name, float(value), ts),
            )
    conn.commit()


def upsert_signal(conn, asset_id: str, direction: str, strength: str,
                  confidence: float, rationale: str, source: str = 'sector_rotation'):
    """
    Upserts a Signal row. Deactivates existing active signal for this asset first.
    direction: BULLISH | BEARISH | NEUTRAL
    strength:  STRONG | MODERATE | WEAK
    """
    with conn.cursor() as cur:
        # Deactivate old active signals for this asset from same source
        cur.execute(
            'UPDATE "Signal" SET "isActive" = FALSE, "updatedAt" = NOW() '
            'WHERE "assetId" = %s AND source = %s AND "isActive" = TRUE',
            (asset_id, source),
        )
        cur.execute(
            '''
            INSERT INTO "Signal" (id, "assetId", direction, strength, confidence, source, rationale,
                                  "isActive", "triggeredAt", "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), %s, %s::"SignalDirection", %s::"SignalStrength",
                    %s, %s, %s, TRUE, NOW(), NOW(), NOW())
            ''',
            (asset_id, direction, strength, confidence, source, rationale),
        )
    conn.commit()


def upsert_rotation_log(conn, from_id: Optional[str], to_id: Optional[str],
                        regime: str, alloc_pct: float, rationale: str,
                        momentum: float, rel_strength: float):
    """Inserts a RotationLog entry for a detected sector rotation."""
    with conn.cursor() as cur:
        cur.execute(
            '''
            INSERT INTO "RotationLog" (id, "fromAssetId", "toAssetId", regime,
                "allocationPct", rationale, momentum, "relativeStrength", "executedAt", "createdAt")
            VALUES (gen_random_uuid(), %s, %s, %s::"RegimeType", %s, %s, %s, %s, NOW(), NOW())
            ''',
            (from_id, to_id, regime, alloc_pct, rationale, momentum, rel_strength),
        )
    conn.commit()


def upsert_price_rows(conn, rows: list[dict]) -> int:
    """Bulk upsert into PriceData. rows = [{assetId, timestamp, open, high, low, close, volume, source}]"""
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            '''
            INSERT INTO "PriceData" (id, "assetId", timestamp, open, high, low, close, volume, source, "createdAt")
            VALUES (
                gen_random_uuid(),
                %(assetId)s,
                %(timestamp)s,
                %(open)s,
                %(high)s,
                %(low)s,
                %(close)s,
                %(volume)s,
                %(source)s,
                NOW()
            )
            ON CONFLICT ("assetId", timestamp)
            DO UPDATE SET
                open        = EXCLUDED.open,
                high        = EXCLUDED.high,
                low         = EXCLUDED.low,
                close       = EXCLUDED.close,
                volume      = EXCLUDED.volume,
                source      = EXCLUDED.source,
                "createdAt" = NOW()
            ''',
            rows,
        )
    conn.commit()
    return len(rows)


def upsert_live_snapshot(conn, snapshot: list[dict]) -> int:
    """
    Stores live snapshot in PriceData with the ACTUAL last trading date.

    Fix: previously used today_midnight, so on Sunday you'd write Friday's price
    to Sunday's row. Then frontend sees two rows with the same price (Friday row +
    Sunday row) → % change = 0. Now we write to the actual trading date, so
    ON CONFLICT updates Friday's row correctly and prev-close stays Thursday.
    """
    rows = []
    for s in snapshot:
        # Use actual last trading date from yfinance index, not today
        actual_ts = s.get('actualDate')
        if actual_ts is None:
            # Fallback: use today midnight (old behaviour for non-trading days)
            actual_ts = datetime.now(timezone.utc).replace(
                hour=0, minute=0, second=0, microsecond=0
            )

        rows.append({
            'assetId':   s['assetId'],
            'timestamp': actual_ts,
            'open':      s.get('open',   s['price']),
            'high':      s.get('high',   s['price']),
            'low':       s.get('low',    s['price']),
            'close':     s['price'],
            'volume':    s.get('volume', 0),
            'source':    'yfinance_live',
        })
    return upsert_price_rows(conn, rows)


# ─── Fetch helpers ────────────────────────────────────────────────────────────

def fetch_live_snapshot(use_cache: bool = True) -> list[dict]:
    """
    Fetches the current price + 1D / 1M change for all assets.
    Returns list of dicts:
      {symbol, yahooTicker, price, open, high, low, prevClose,
       change1D, change1M, volume, actualDate}

    Key improvement: single 35-day download (previously 7d + 35d = 2 calls).
    actualDate = last trading day's date from yfinance index (fixes Sunday bug).
    """
    cache_key = 'xcapital_live_snapshot'
    if use_cache:
        cached = _cache_get(cache_key)
        if cached:
            print('[cache] Returning cached live snapshot (< 5 min old)')
            return cached

    yf_tickers = list(TICKER_MAP.values())

    # Single download: 35 days covers both same-day and ~1-month comparisons
    print(f'[yfinance] Downloading 35-day snapshot for {len(yf_tickers)} tickers...')
    data = yf.download(
        yf_tickers,
        period='35d',
        interval='1d',
        progress=False,
        auto_adjust=True,
    )

    results = []
    for symbol, yf_ticker in TICKER_MAP.items():
        try:
            close_col = data['Close'][yf_ticker].dropna()

            if len(close_col) < 2:
                print(f'  [SKIP] Insufficient data for {symbol} ({yf_ticker})')
                continue

            price      = float(close_col.iloc[-1])
            prev_close = float(close_col.iloc[-2])
            change_1d  = ((price - prev_close) / prev_close) * 100 if prev_close else 0.0

            # Actual last trading day date (UTC midnight) — fixes Sunday bug
            last_ts = close_col.index[-1]
            if hasattr(last_ts, 'tzinfo') and last_ts.tzinfo:
                d = last_ts.astimezone(timezone.utc).date()
            else:
                d = pd.Timestamp(last_ts).date()
            actual_date = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)

            # Actual open/high/low from that bar (not flat O=H=L=C)
            try:
                open_val = float(data['Open'][yf_ticker].dropna().iloc[-1])
                high_val = float(data['High'][yf_ticker].dropna().iloc[-1])
                low_val  = float(data['Low'][yf_ticker].dropna().iloc[-1])
            except Exception:
                open_val = high_val = low_val = price

            # Volume
            try:
                vol_col = data['Volume'][yf_ticker].dropna()
                volume  = float(vol_col.iloc[-1]) if len(vol_col) else 0.0
            except Exception:
                volume = 0.0

            # 1-month change (~20 trading days)
            try:
                change_1m = ((price - float(close_col.iloc[-20])) / float(close_col.iloc[-20])) * 100 \
                            if len(close_col) >= 20 else 0.0
            except Exception:
                change_1m = 0.0

            results.append({
                'symbol':      symbol,
                'yahooTicker': yf_ticker,
                'price':       round(price,      4),
                'open':        round(open_val,   4),
                'high':        round(high_val,   4),
                'low':         round(low_val,    4),
                'prevClose':   round(prev_close, 4),
                'change1D':    round(change_1d,  4),
                'change1M':    round(change_1m,  4),
                'volume':      volume,
                'actualDate':  actual_date,
            })

            trading_day = d.strftime('%a %Y-%m-%d')
            print(f'  ✓ {symbol:15s} {price:>12.2f}  {change_1d:+.2f}%  (1M: {change_1m:+.2f}%)  [{trading_day}]')

        except Exception as e:
            print(f'  [ERROR] {symbol}: {e}')

    if use_cache and results:
        _cache_set(cache_key, [
            {k: v for k, v in r.items() if k != 'actualDate'}  # strip datetime before caching
            for r in results
        ])

    return results


def fetch_ohlcv_history(days: int = 365) -> dict[str, pd.DataFrame]:
    """
    Fetches OHLCV history for all tickers.
    Returns {symbol: DataFrame with columns [open, high, low, close, volume]}.

    Fix: uses start-date parameter instead of unreliable 'Xd' period string.
    """
    yf_tickers = list(TICKER_MAP.values())

    # Use explicit start date — more reliable than period='Xd' with yfinance
    start_dt = (datetime.now(timezone.utc) - timedelta(days=days + 45)).strftime('%Y-%m-%d')
    end_dt   = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    print(f'[yfinance] Downloading {days}-day OHLCV history ({start_dt} → {end_dt}) for {len(yf_tickers)} tickers...')
    data = yf.download(
        yf_tickers,
        start=start_dt,
        end=end_dt,
        interval='1d',
        progress=False,
        auto_adjust=True,
    )

    result = {}
    for symbol, yf_ticker in TICKER_MAP.items():
        try:
            df = pd.DataFrame({
                'open':   data['Open'][yf_ticker],
                'high':   data['High'][yf_ticker],
                'low':    data['Low'][yf_ticker],
                'close':  data['Close'][yf_ticker],
                'volume': data['Volume'][yf_ticker] if 'Volume' in data else 0,
            }).dropna(subset=['close'])

            df = df.tail(days)
            result[symbol] = df
            if len(df):
                print(f'  ✓ {symbol:15s} {len(df):>4} rows  ({df.index[0].date()} → {df.index[-1].date()})')
            else:
                print(f'  [WARN] {symbol}: 0 rows returned')
        except Exception as e:
            print(f'  [ERROR] {symbol}: {e}')

    return result


def fetch_yahoo_history_ticker(symbol: str, days: int = 1825) -> Optional[pd.DataFrame]:
    """
    Fetches OHLCV history for a single Yahoo Finance ticker.
    Returns DataFrame with columns [open, high, low, close, volume] or None on failure.
    Used for per-ticker commodity gap-fill in the pipeline.
    """
    yf_ticker = TICKER_MAP.get(symbol)
    if not yf_ticker:
        print(f'  [WARN] No Yahoo ticker for {symbol}')
        return None

    start_dt = (datetime.now(timezone.utc) - timedelta(days=days + 10)).strftime('%Y-%m-%d')
    end_dt   = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    try:
        raw = yf.download(yf_ticker, start=start_dt, end=end_dt, interval='1d',
                          progress=False, auto_adjust=True)
        if raw is None or raw.empty:
            print(f'  [WARN] {symbol} ({yf_ticker}): no data from Yahoo')
            return None

        # Flatten multi-index if present (single ticker usually flat)
        if isinstance(raw.columns, pd.MultiIndex):
            raw = raw.droplevel(1, axis=1)

        df = pd.DataFrame({
            'open':   raw['Open'],
            'high':   raw['High'],
            'low':    raw['Low'],
            'close':  raw['Close'],
            'volume': raw['Volume'] if 'Volume' in raw.columns else 0,
        }).dropna(subset=['close'])

        print(f'  ✓ {symbol:15s} {len(df):>4} rows  ({df.index[0].date()} → {df.index[-1].date()})')
        return df
    except Exception as e:
        print(f'  [ERROR] {symbol} ({yf_ticker}): {e}')
        return None


# ─── Main modes ───────────────────────────────────────────────────────────────

def run_live(conn, asset_ids: dict, use_cache: bool = True):
    """Fetch live snapshot and store in PriceData."""
    print('\n═══ LIVE SNAPSHOT MODE ═══')
    snapshot = fetch_live_snapshot(use_cache=use_cache)

    if not snapshot:
        print('[ERROR] No data fetched.')
        return

    live_rows = []
    for item in snapshot:
        asset_id = asset_ids.get(item['symbol'])
        if not asset_id:
            print(f'  [WARN] Asset not found in DB: {item["symbol"]}')
            continue
        item['assetId'] = asset_id
        live_rows.append(item)

    # Reconnect if the SSL connection dropped during the long Yahoo download
    try:
        conn.cursor().execute('SELECT 1')
    except Exception:
        print('  [reconnect] SSL dropped — reopening connection before upsert')
        try: conn.close()
        except Exception: pass
        conn = get_conn()

    upsert_live_snapshot(conn, live_rows)
    print(f'\n✅ Stored {len(live_rows)} live prices in PriceData')

    output = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'assets': [
            {
                'symbol':      s['symbol'],
                'price':       s['price'],
                'change1D':    s['change1D'],
                'change1M':    s['change1M'],
                'volume':      s['volume'],
                'tradingDate': s['actualDate'].isoformat() if isinstance(s.get('actualDate'), datetime) else None,
            }
            for s in live_rows
        ]
    }
    print('\n--- JSON OUTPUT ---')
    print(json.dumps(output, default=str))
    return output


def _upsert_symbol(symbol: str, df: pd.DataFrame, asset_id: str) -> tuple[str, int]:
    """Worker: upsert one symbol's history rows in its own connection."""
    conn = get_conn()
    try:
        rows = []
        for ts, row in df.iterrows():
            if hasattr(ts, 'tzinfo') and ts.tzinfo:
                ts_utc = ts.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            else:
                ts_utc = datetime(ts.year, ts.month, ts.day, tzinfo=timezone.utc)

            rows.append({
                'assetId':   asset_id,
                'timestamp': ts_utc,
                'open':      round(float(row['open']),   4),
                'high':      round(float(row['high']),   4),
                'low':       round(float(row['low']),    4),
                'close':     round(float(row['close']),  4),
                'volume':    float(row['volume']) if row['volume'] else 0.0,
                'source':    'yfinance_history',
            })

        count = upsert_price_rows(conn, rows)
        return symbol, count
    finally:
        conn.close()


def _compute_rsi(closes: list, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 2)


def _compute_macd_hist(closes: list) -> float:
    def ema(data, n):
        k = 2 / (n + 1)
        e = data[0]
        for v in data[1:]:
            e = v * k + e * (1 - k)
        return e
    if len(closes) < 26:
        return 0.0
    e12 = ema(closes[-26:], 12)
    e26 = ema(closes[-26:], 26)
    macd = e12 - e26
    signal = ema([macd], 9)  # simplified single-value signal
    return round(macd - signal, 4)


def compute_and_save_indicators(conn, asset_ids: dict, histories: dict):
    """
    After history ingest: compute RSI, MACD, momentum, relative strength
    for each sector and save to Indicator + Signal tables.
    Also writes RotationLog entries for detected sector rotations.
    """
    print('\n═══ COMPUTING INDICATORS & SIGNALS ═══')

    bench_closes = []
    if 'NIFTY50' in histories:
        bench_closes = histories['NIFTY50']['close'].tolist()

    sector_scores = {}  # {ticker: flow_score}
    sector_data = {}    # {ticker: {rsi, macd_hist, mom1m, rs}}

    ts_now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    for symbol, df in histories.items():
        asset_id = asset_ids.get(symbol)
        if not asset_id or len(df) < 20:
            continue

        closes = df['close'].tolist()
        rsi     = _compute_rsi(closes)
        macd_h  = _compute_macd_hist(closes)
        mom1d   = round((closes[-1] / closes[-2] - 1) * 100, 4) if len(closes) >= 2 else 0.0
        mom5d   = round((closes[-1] / closes[-5] - 1) * 100, 4) if len(closes) >= 5 else 0.0
        mom1m   = round((closes[-1] / closes[-20] - 1) * 100, 4) if len(closes) >= 20 else 0.0
        mom3m   = round((closes[-1] / closes[-60] - 1) * 100, 4) if len(closes) >= 60 else 0.0

        # Relative strength vs NIFTY50 (60-day rebase)
        rs = 100.0
        if bench_closes and len(bench_closes) >= 60 and len(closes) >= 60:
            s0, sn = closes[-60], closes[-1]
            b0, bn = bench_closes[-60], bench_closes[-1]
            if s0 and b0:
                rs = round((sn / s0) / (bn / b0) * 100, 2)

        # Flow score: RSI component + momentum + RS
        rsi_sc   = (rsi - 50) * 1.4
        macd_sc  = max(-15, min(15, macd_h * 5))
        mom_sc   = max(-20, min(20, mom1m * 2))
        rs_sc    = max(-15, min(15, (rs - 100) * 0.5))
        flow_score = max(-100, min(100, rsi_sc + macd_sc + mom_sc + rs_sc))

        sector_scores[symbol] = flow_score
        sector_data[symbol]   = {'rsi': rsi, 'macd_hist': macd_h, 'mom1m': mom1m, 'rs': rs, 'flow': flow_score}

        # Save indicators to DB
        indicators = {
            'RSI_14':      rsi,
            'MACD_HIST':   macd_h,
            'MOM_1D':      mom1d,
            'MOM_5D':      mom5d,
            'MOM_1M':      mom1m,
            'MOM_3M':      mom3m,
            'REL_STR_60D': rs,
            'FLOW_SCORE':  round(flow_score, 2),
        }

        # Save Signal direction
        if flow_score > 20:
            direction = 'BULLISH'
            strength  = 'STRONG' if flow_score > 50 else 'MODERATE'
            conf      = min(0.92, 0.45 + abs(flow_score) * 0.006)
            rationale = f'{symbol} showing inflow signal: RSI={rsi:.1f}, Mom1M={mom1m:+.2f}%, RS={rs:.1f}'
        elif flow_score < -20:
            direction = 'BEARISH'
            strength  = 'STRONG' if flow_score < -50 else 'MODERATE'
            conf      = min(0.92, 0.45 + abs(flow_score) * 0.006)
            rationale = f'{symbol} showing outflow signal: RSI={rsi:.1f}, Mom1M={mom1m:+.2f}%, RS={rs:.1f}'
        else:
            direction = 'NEUTRAL'
            strength  = 'WEAK'
            conf      = 0.45
            rationale = f'{symbol} neutral: RSI={rsi:.1f}, Mom1M={mom1m:+.2f}%'

        # Reconnect if the SSL connection was dropped during computation
        try:
            conn.cursor().execute('SELECT 1')
        except Exception:
            print(f'  [reconnect] SSL dropped — reopening connection before {symbol}')
            try: conn.close()
            except Exception: pass
            conn = get_conn()

        upsert_indicators(conn, asset_id, symbol, indicators, ts_now)
        upsert_signal(conn, asset_id, direction, strength, conf, rationale)
        print(f'  ✓ {symbol:15s}  RSI={rsi:5.1f}  Mom1M={mom1m:+6.2f}%  RS={rs:6.1f}  Flow={flow_score:+6.1f}  → {direction}')

    # ─── Rotation Log: detect top inflow vs outflow sector rotation ───────────
    equity_sectors = [t for t in sector_scores if t.startswith('NIFTY_') or t == 'SMALLCAP']
    if len(equity_sectors) >= 2:
        sorted_sectors = sorted(equity_sectors, key=lambda t: sector_scores[t], reverse=True)
        top_inflow  = sorted_sectors[0]
        top_outflow = sorted_sectors[-1]

        in_id  = asset_ids.get(top_inflow)
        out_id = asset_ids.get(top_outflow)

        # Map cycle to RegimeType enum
        in_flow  = sector_scores.get(top_inflow, 0)
        out_flow = sector_scores.get(top_outflow, 0)
        regime = 'CONTRACTION' if out_flow < -20 else 'EXPANSION' if in_flow > 20 else 'UNKNOWN'

        if in_id and out_id and abs(in_flow - out_flow) > 20:
            upsert_rotation_log(
                conn, out_id, in_id, regime,
                alloc_pct=round(abs(in_flow - out_flow) / 2, 1),
                rationale=(
                    f'Sector rotation: capital moving from {top_outflow} (score {out_flow:+.1f}) '
                    f'to {top_inflow} (score {in_flow:+.1f})'
                ),
                momentum=round(sector_data.get(top_inflow, {}).get('mom1m', 0), 2),
                rel_strength=round(sector_data.get(top_inflow, {}).get('rs', 100), 2),
            )
            print(f'\n  [RotationLog] {top_outflow} → {top_inflow}  regime={regime}')

    print(f'\n✅ Indicators & signals saved for {len(sector_data)} assets')


def run_history(conn, asset_ids: dict, days: int):
    """Fetch full OHLCV history and store in PriceData (parallel upserts)."""
    print(f'\n═══ HISTORY MODE ({days} days) ═══')
    histories = fetch_ohlcv_history(days)

    # Parallel upserts using ThreadPoolExecutor (one connection per worker)
    tasks = {}
    total = 0
    with ThreadPoolExecutor(max_workers=min(8, len(histories))) as pool:
        for symbol, df in histories.items():
            asset_id = asset_ids.get(symbol)
            if not asset_id:
                print(f'  [WARN] Asset not found in DB: {symbol}')
                continue
            tasks[pool.submit(_upsert_symbol, symbol, df, asset_id)] = symbol

        for future in as_completed(tasks):
            symbol = tasks[future]
            try:
                sym, count = future.result()
                total += count
                print(f'  ✓ {sym}: {count} rows upserted')
            except Exception as e:
                print(f'  [ERROR] {symbol}: {e}')

    print(f'\n✅ Total: {total} price rows stored in NeonDB')

    # Open a FRESH connection for indicator computation — the main conn may have
    # timed out during the long parallel history download.
    ind_conn = get_conn()
    try:
        compute_and_save_indicators(ind_conn, asset_ids, {
            sym: df for sym, df in histories.items() if len(df) >= 20
        })
    finally:
        ind_conn.close()


# ─── FII / DII institutional flow scraper ────────────────────────────────────

import urllib.request

def fetch_fii_dii_nse() -> list[dict]:
    """
    Fetches daily FII/DII equity cash-market flows from NSE.
    NSE requires a session cookie obtained by hitting the homepage first.
    Returns list of dicts: {date, category, buyValue, sellValue, netValue}
    """
    import http.cookiejar
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    opener.addheaders = [
        ('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                       '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
        ('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
        ('Accept-Language', 'en-US,en;q=0.5'),
        ('Connection', 'keep-alive'),
    ]

    # Step 1: hit homepage to get session cookies
    try:
        opener.open('https://www.nseindia.com', timeout=12)
        time.sleep(1.2)
    except Exception as e:
        print(f'  [WARN] NSE homepage fetch failed: {e}')

    # Step 2: call FII/DII API
    api_req = urllib.request.Request(
        'https://www.nseindia.com/api/fiidiiTradeReact',
        headers={
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.nseindia.com/reports-detail?type=fiidii',
        }
    )
    try:
        with opener.open(api_req, timeout=15) as resp:
            raw = json.loads(resp.read().decode('utf-8'))
        print(f'  [NSE] FII/DII API returned {len(raw)} rows')
        return raw
    except Exception as e:
        print(f'  [ERROR] FII/DII API call failed: {e}')
        return []


def parse_fii_dii_date(date_str: str) -> Optional[datetime]:
    """Parse NSE date format 'DD-Mon-YYYY' → UTC midnight datetime."""
    for fmt in ('%d-%b-%Y', '%d-%B-%Y', '%Y-%m-%d'):
        try:
            d = datetime.strptime(date_str.strip(), fmt)
            return d.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def store_fii_dii(conn, asset_ids: dict, rows: list[dict]) -> int:
    """
    Parses and upserts FII/DII rows into the Indicator table.
    Indicator names: FII_BUY_CRORE, FII_SELL_CRORE, FII_NET_CRORE,
                     DII_BUY_CRORE, DII_SELL_CRORE, DII_NET_CRORE
    Attached to NIFTY50 asset (broad market proxy).
    """
    nifty_id = asset_ids.get('NIFTY50')
    if not nifty_id:
        print('  [WARN] NIFTY50 not in DB — cannot store FII/DII')
        return 0

    grouped: dict[str, dict] = {}  # {date_str: {fii: ..., dii: ...}}
    for row in rows:
        date_str = row.get('date', '').strip()
        category = (row.get('category') or '').upper()
        ts = parse_fii_dii_date(date_str)
        if not ts:
            continue
        key = ts.strftime('%Y-%m-%d')
        if key not in grouped:
            grouped[key] = {'ts': ts}
        prefix = 'FII' if 'FII' in category else 'DII' if 'DII' in category else None
        if not prefix:
            continue
        try:
            grouped[key][f'{prefix}_BUY']  = float(str(row.get('buyValue',  0)).replace(',', '') or 0)
            grouped[key][f'{prefix}_SELL'] = float(str(row.get('sellValue', 0)).replace(',', '') or 0)
            grouped[key][f'{prefix}_NET']  = float(str(row.get('netValue',  0)).replace(',', '') or 0)
        except (ValueError, TypeError):
            continue

    stored = 0
    with conn.cursor() as cur:
        for key, d in grouped.items():
            ts = d['ts']
            for name, val in [
                ('FII_BUY_CRORE',  d.get('FII_BUY',  0)),
                ('FII_SELL_CRORE', d.get('FII_SELL', 0)),
                ('FII_NET_CRORE',  d.get('FII_NET',  0)),
                ('DII_BUY_CRORE',  d.get('DII_BUY',  0)),
                ('DII_SELL_CRORE', d.get('DII_SELL', 0)),
                ('DII_NET_CRORE',  d.get('DII_NET',  0)),
            ]:
                if val == 0:
                    continue
                cur.execute(
                    '''
                    INSERT INTO "Indicator" (id, "assetId", name, value, timestamp, "createdAt")
                    VALUES (gen_random_uuid(), %s, %s, %s, %s, NOW())
                    ON CONFLICT ("assetId", name, timestamp)
                    DO UPDATE SET value = EXCLUDED.value, "createdAt" = NOW()
                    ''',
                    (nifty_id, name, float(val), ts),
                )
                stored += 1
    conn.commit()
    return stored


def run_fii_dii(conn, asset_ids: dict):
    """Fetch FII/DII institutional flow data from NSE and persist to DB."""
    print('\n═══ FII/DII INSTITUTIONAL FLOW MODE ═══')
    rows = fetch_fii_dii_nse()
    if not rows:
        print('  [WARN] No FII/DII data received from NSE')
        return
    count = store_fii_dii(conn, asset_ids, rows)
    print(f'\n✅ Stored {count} FII/DII indicator values in NeonDB')


# ─── Dhan API Integration ────────────────────────────────────────────────────
# Primary data source for NSE indices — provides real volume + options OI.
# Falls back to Yahoo Finance if DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID not set.
#
# Dhan security IDs for NSE indices (IDX_I segment):
#   Source: https://images.dhan.co/api-data/api-scrip-master.csv
#
# For options chain, underlying scrip IDs:
#   NIFTY → 13, BANKNIFTY → 25

DHAN_INDEX_MAP = {
    # ticker: {securityId, exchangeSegment, instrument, optionScrip}
    # Verified via: https://images.dhan.co/api-data/api-scrip-master.csv (IDX_I segment)
    #
    # ── Core ──────────────────────────────────────────────────────────────────
    'NIFTY50':          {'securityId': '13', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': 13},
    'NIFTY_100':        {'securityId': '17', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_BANK':       {'securityId': '25', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': 25},
    'FINNIFTY':         {'securityId': '27', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': 27},
    # ── Macro Sensitive ───────────────────────────────────────────────────────
    'NIFTY_IT':         {'securityId': '29', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_METAL':      {'securityId': '31', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_ENERGY':     {'securityId': '42', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    # ── Defensive ─────────────────────────────────────────────────────────────
    'NIFTY_PHARMA':     {'securityId': '32', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_FMCG':       {'securityId': '28', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    # ── High Beta / Liquidity ─────────────────────────────────────────────────
    # NIFTY_SMALLCAP = Nifty Smallcap 250 (scId=3). Nifty Smallcap 100 is scId=5.
    'NIFTY_SMALLCAP':   {'securityId': '3',  'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_AUTO':       {'securityId': '14', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_INFRA':      {'securityId': '43', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_REALTY':     {'securityId': '34', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    'NIFTY_MEDIA':      {'securityId': '30', 'exchangeSegment': 'IDX_I', 'instrument': 'INDEX', 'optionScrip': None},
    # ── BSE (fetched via Yahoo Finance ^BSESN, not Dhan IDX_I) ───────────────
    # SENSEX is excluded from DHAN_INDEX_MAP — handled by run_live() via yfinance
}

# All 14 NSE indices available via Dhan OHLC/history
DHAN_TICKERS = set(DHAN_INDEX_MAP.keys())

# All 15 equity index tickers tracked in DB (14 NSE via Dhan + SENSEX via Yahoo)
ALL_INDEX_TICKERS = DHAN_TICKERS | {'SENSEX'}

# Legacy alias kept for backward compat
CORE_3_TICKERS = {'NIFTY50', 'NIFTY_100', 'NIFTY_BANK'}

# Options OI: NIFTY, BANKNIFTY, FINNIFTY have liquid options on NSE
DHAN_OPTION_UNDERLYINGS = [
    {'nseSymbol': 'NIFTY',     'dbTicker': 'NIFTY50',    'scId': 13, 'seg': 'IDX_I'},
    {'nseSymbol': 'BANKNIFTY', 'dbTicker': 'NIFTY_BANK', 'scId': 25, 'seg': 'IDX_I'},
    {'nseSymbol': 'FINNIFTY',  'dbTicker': 'FINNIFTY',   'scId': 27, 'seg': 'IDX_I'},
]


def _dhan_client():
    """Return an initialised dhanhq client or None if credentials not set."""
    if not DHAN_ENABLED:
        return None
    try:
        from dhanhq import dhanhq
        return dhanhq(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
    except Exception as e:
        print(f'  [WARN] Dhan SDK init failed: {e}')
        return None


def fetch_dhan_history(ticker: str, from_date: str, to_date: str, dhan) -> Optional[pd.DataFrame]:
    """
    Fetch daily OHLCV history from Dhan /charts/historical.
    Returns DataFrame with columns: open, high, low, close, volume, date
    or None on failure.
    """
    cfg = DHAN_INDEX_MAP.get(ticker)
    if not cfg or dhan is None:
        return None
    try:
        resp = dhan.historical_daily_data(
            security_id    = cfg['securityId'],
            exchange_segment = cfg['exchangeSegment'],
            instrument_type  = cfg['instrument'],
            expiry_code      = 0,
            from_date        = from_date,
            to_date          = to_date,
        )
        if not resp or resp.get('status') == 'failure':
            return None
        # Response: {'status': ..., 'data': {'open': [], 'high': [], ..., 'timestamp': []}}
        payload = resp.get('data') or {}
        if not isinstance(payload, dict):
            return None
        opens  = payload.get('open',      [])
        highs  = payload.get('high',      [])
        lows   = payload.get('low',       [])
        closes = payload.get('close',     [])
        vols   = payload.get('volume',    [])
        times  = payload.get('timestamp', [])
        if not closes:
            return None
        df = pd.DataFrame({
            'open':   opens,
            'high':   highs,
            'low':    lows,
            'close':  closes,
            'volume': vols if vols else [0] * len(closes),
            'date':   [datetime.fromtimestamp(t, tz=timezone.utc).strftime('%Y-%m-%d') for t in times],
        })
        df = df.dropna(subset=['close'])
        df = df[df['close'] > 0]
        return df
    except Exception as e:
        print(f'  [WARN] Dhan history {ticker}: {e}')
        return None


def fetch_dhan_live_snapshot(tickers: list[str], dhan) -> dict[str, dict]:
    """
    Fetch live OHLC + volume for a list of tickers via Dhan /marketfeed/ohlc.
    Returns {ticker: {open, high, low, close, volume, last_price}}
    """
    if dhan is None:
        return {}

    # Build request payload grouped by exchange segment
    by_seg: dict[str, list[int]] = {}
    ticker_by_seg_id: dict[tuple, str] = {}
    for ticker in tickers:
        cfg = DHAN_INDEX_MAP.get(ticker)
        if not cfg:
            continue
        seg = cfg['exchangeSegment']
        sid = int(cfg['securityId'])
        by_seg.setdefault(seg, []).append(sid)
        ticker_by_seg_id[(seg, sid)] = ticker

    if not by_seg:
        return {}

    try:
        resp = dhan.ohlc_data(by_seg)
        result: dict[str, dict] = {}
        if not resp or resp.get('status') == 'failure':
            return {}
        # Response: {'status': ..., 'data': {'data': {'IDX_I': {'13': {last_price, ohlc}}}, 'status': ...}}
        outer = resp.get('data') or {}
        data  = outer.get('data') if isinstance(outer, dict) else outer
        if not isinstance(data, dict):
            return {}
        for seg, seg_data in data.items():
            if not isinstance(seg_data, dict):
                continue
            for sid_str, item in seg_data.items():
                if not isinstance(item, dict):
                    continue
                try:
                    sid = int(sid_str)
                except (ValueError, TypeError):
                    continue
                ticker = ticker_by_seg_id.get((seg, sid))
                if not ticker:
                    continue
                ohlc = item.get('ohlc', {})
                result[ticker] = {
                    'open':       ohlc.get('open',  0),
                    'high':       ohlc.get('high',  0),
                    'low':        ohlc.get('low',   0),
                    'close':      ohlc.get('close', 0),
                    'last_price': item.get('last_price', ohlc.get('close', 0)),
                    'volume':     item.get('volume', 0),
                }
        return result
    except Exception as e:
        print(f'  [WARN] Dhan live snapshot failed: {e}')
        return {}


def fetch_dhan_option_chain(underlying: dict, dhan) -> Optional[dict]:
    """
    Fetch options chain for NIFTY / BANKNIFTY from Dhan.
    underlying = {'nseSymbol', 'dbTicker', 'scId', 'seg'}
    Returns parsed metrics dict or None.
    """
    if dhan is None:
        return None
    try:
        # Get nearest expiry
        expiry_resp = dhan.expiry_list(
            under_security_id      = underlying['scId'],
            under_exchange_segment = underlying['seg'],
        )
        if not expiry_resp or expiry_resp.get('status') == 'failure':
            return None
        # Response: {'status': ..., 'data': {'data': ['2026-04-07', ...], 'status': ...}}
        expiry_outer = expiry_resp.get('data') or {}
        expiries = expiry_outer.get('data', []) if isinstance(expiry_outer, dict) else []
        if not expiries or not isinstance(expiries, list):
            return None
        nearest_expiry = expiries[0]  # e.g. "2026-04-07"

        # Fetch option chain for nearest expiry
        chain_resp = dhan.option_chain(
            under_security_id      = underlying['scId'],
            under_exchange_segment = underlying['seg'],
            expiry                 = nearest_expiry,
        )
        if not chain_resp or chain_resp.get('status') == 'failure':
            return None

        # Response: {'status': ..., 'data': {'data': {'last_price': ..., 'oc': {'strike': {ce:{}, pe:{}}}}, ...}}
        chain_outer = chain_resp.get('data') or {}
        chain_inner = chain_outer.get('data') if isinstance(chain_outer, dict) else None
        if not isinstance(chain_inner, dict):
            return None

        underlying_price = float(chain_inner.get('last_price', 0) or 0)
        oc = chain_inner.get('oc', {})
        if not isinstance(oc, dict) or not oc:
            return None

        total_ce_oi = 0.0
        total_pe_oi = 0.0
        ce_oi_by_strike: dict[float, float] = {}
        pe_oi_by_strike: dict[float, float] = {}
        atm_iv = 0.0
        atm_dist = float('inf')

        for strike_str, legs in oc.items():
            try:
                strike = float(strike_str)
            except (ValueError, TypeError):
                continue
            ce = legs.get('ce', {}) or {}
            pe = legs.get('pe', {}) or {}
            ce_oi = float(ce.get('oi', 0) or 0)
            pe_oi = float(pe.get('oi', 0) or 0)
            ce_iv = float(ce.get('implied_volatility', 0) or 0)
            pe_iv = float(pe.get('implied_volatility', 0) or 0)

            total_ce_oi += ce_oi
            total_pe_oi += pe_oi
            ce_oi_by_strike[strike] = ce_oi
            pe_oi_by_strike[strike] = pe_oi

            dist = abs(strike - underlying_price)
            if dist < atm_dist:
                atm_dist = dist
                atm_iv   = round((ce_iv + pe_iv) / 2, 2) if (ce_iv + pe_iv) > 0 else 0.0

        if total_ce_oi == 0 and total_pe_oi == 0:
            return None

        pcr = round(total_pe_oi / total_ce_oi, 4) if total_ce_oi > 0 else 1.0

        # Max pain
        max_pain = underlying_price
        min_pain = float('inf')
        for candidate in ce_oi_by_strike:
            pain = sum(oi * max(0, s - candidate) for s, oi in ce_oi_by_strike.items())
            pain += sum(oi * max(0, candidate - s) for s, oi in pe_oi_by_strike.items())
            if pain < min_pain:
                min_pain = pain
                max_pain = candidate

        top_ce_strike = max(ce_oi_by_strike, key=lambda s: ce_oi_by_strike[s], default=underlying_price)
        top_pe_strike = max(pe_oi_by_strike, key=lambda s: pe_oi_by_strike[s], default=underlying_price)

        return {
            'pcr':           pcr,
            'total_ce_oi':   round(total_ce_oi / 1_00_000, 2),   # lakhs
            'total_pe_oi':   round(total_pe_oi / 1_00_000, 2),
            'max_pain':      max_pain,
            'top_ce_strike': top_ce_strike,
            'top_pe_strike': top_pe_strike,
            'atm_iv':        atm_iv,
            'atm_strike':    underlying_price,
            'expiry':        nearest_expiry,
        }
    except Exception as e:
        print(f'  [WARN] Dhan option chain {underlying["nseSymbol"]}: {e}')
        return None


def _upsert_dhan_df(conn, asset_id: str, df: pd.DataFrame) -> int:
    """Upsert a Dhan OHLCV DataFrame into PriceData. Returns row count."""
    count = 0
    with conn.cursor() as cur:
        for _, row in df.iterrows():
            ts = datetime.strptime(row['date'], '%Y-%m-%d').replace(tzinfo=timezone.utc)
            cur.execute(
                '''
                INSERT INTO "PriceData"
                  (id, "assetId", timestamp, open, high, low, close, volume, source, "createdAt")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, 'dhan_history', NOW())
                ON CONFLICT ("assetId", timestamp)
                DO UPDATE SET
                  open=%s, high=%s, low=%s, close=%s, volume=%s,
                  source='dhan_history', "createdAt"=NOW()
                ''',
                (asset_id, ts,
                 float(row['open']), float(row['high']), float(row['low']),
                 float(row['close']), float(row['volume']),
                 float(row['open']), float(row['high']), float(row['low']),
                 float(row['close']), float(row['volume'])),
            )
            count += 1
    conn.commit()
    return count


def run_dhan_history(conn, asset_ids: dict, days: int, tickers_filter: set = None):
    """
    Fetch daily OHLCV for NSE indices from Dhan (real volume).
    Fetches in 365-day chunks with delays to respect Dhan rate limits.
    tickers_filter: restrict to a subset. None = all DHAN_TICKERS (all 14 NSE indices).
    """
    active = tickers_filter or DHAN_TICKERS
    print(f'\n═══ DHAN HISTORY MODE ({days} days, {len(active)} NSE indices) ═══')
    dhan = _dhan_client()
    if not dhan:
        print('  [SKIP] Dhan credentials not set')
        return {}

    CHUNK_DAYS  = 365          # Dhan is stable up to ~365d per call
    CHUNK_DELAY = 3            # seconds between API calls (rate limit)

    to_dt   = date.today()
    from_dt = to_dt - timedelta(days=days)
    results: dict[str, pd.DataFrame] = {}

    for ticker in sorted(active):
        asset_id = asset_ids.get(ticker)
        if not asset_id:
            print(f'  [SKIP] {ticker} not in DB')
            continue

        print(f'  {ticker}: fetching {days}d in {CHUNK_DAYS}d chunks...')
        frames = []

        chunk_to   = to_dt
        chunk_from = max(from_dt, chunk_to - timedelta(days=CHUNK_DAYS))

        while chunk_from >= from_dt:
            df_chunk = fetch_dhan_history(
                ticker,
                chunk_from.strftime('%Y-%m-%d'),
                chunk_to.strftime('%Y-%m-%d'),
                dhan,
            )
            if df_chunk is not None and len(df_chunk) > 0:
                frames.append(df_chunk)
                print(f'    chunk {chunk_from} → {chunk_to}: {len(df_chunk)} rows', flush=True)
            else:
                print(f'    chunk {chunk_from} → {chunk_to}: no data', flush=True)

            chunk_to   = chunk_from - timedelta(days=1)
            chunk_from = max(from_dt, chunk_to - timedelta(days=CHUNK_DAYS))

            if chunk_to < from_dt:
                break

            time.sleep(CHUNK_DELAY)

        if not frames:
            print(f'  [WARN] {ticker}: no data returned from Dhan')
            continue

        df = pd.concat(frames).drop_duplicates(subset=['date']).sort_values('date').reset_index(drop=True)
        count = _upsert_dhan_df(conn, asset_id, df)
        results[ticker] = df
        vol_rows = (df['volume'] > 0).sum()
        avg_vol  = df.loc[df['volume'] > 0, 'volume'].mean() if vol_rows else 0
        print(f'  ✓ {ticker:15s}  {count} rows upserted  vol_rows={vol_rows}'
              f'  avg_vol={avg_vol:,.0f}  ({df["date"].iloc[0]} → {df["date"].iloc[-1]})')

        time.sleep(CHUNK_DELAY)  # delay before next ticker

    print(f'\n✅ Dhan history: {sum(len(v) for v in results.values())} rows stored for {len(results)} NSE indices')
    return results


def run_dhan_live(conn, asset_ids: dict):
    """
    Fetch live OHLC + volume snapshot for NSE indices from Dhan.
    Returns {ticker: price_data} dict — caller can merge with Yahoo results.
    """
    dhan = _dhan_client()
    if not dhan:
        return {}

    tickers = list(DHAN_TICKERS)
    snap    = fetch_dhan_live_snapshot(tickers, dhan)
    stored  = 0

    for ticker, d in snap.items():
        asset_id = asset_ids.get(ticker)
        if not asset_id or not d.get('close'):
            continue
        ts = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        with conn.cursor() as cur:
            cur.execute(
                '''
                INSERT INTO "PriceData"
                  (id, "assetId", timestamp, open, high, low, close, volume, source, "createdAt")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, 'dhan_live', NOW())
                ON CONFLICT ("assetId", timestamp)
                DO UPDATE SET
                  open=%s, high=%s, low=%s, close=%s, volume=%s,
                  source='dhan_live', "createdAt"=NOW()
                ''',
                (asset_id, ts,
                 d['open'], d['high'], d['low'], d['close'], d['volume'],
                 d['open'], d['high'], d['low'], d['close'], d['volume']),
            )
            stored += 1
    if stored:
        conn.commit()
    return snap


def run_dhan_options(conn, asset_ids: dict):
    """Fetch NIFTY + BANKNIFTY options OI from Dhan and store as Indicator rows."""
    print('\n═══ DHAN OPTIONS OI / PCR ═══')
    dhan = _dhan_client()
    if not dhan:
        print('  [SKIP] Dhan credentials not set — set DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID in .env')
        return

    for underlying in DHAN_OPTION_UNDERLYINGS:
        asset_id = asset_ids.get(underlying['dbTicker'])
        if not asset_id:
            continue

        print(f'  Fetching {underlying["nseSymbol"]} options chain…', end=' ', flush=True)
        metrics = fetch_dhan_option_chain(underlying, dhan)
        if not metrics:
            print('no data')
            continue

        count = store_options_indicators(conn, asset_id, underlying['dbTicker'], metrics)
        pcr_label = ('Bullish (PCR>1.2)' if metrics['pcr'] > 1.2 else
                     'Bearish (PCR<0.8)' if metrics['pcr'] < 0.8 else 'Neutral')
        print(f'PCR={metrics["pcr"]:.3f} → {pcr_label}')
        print(f'    CE OI={metrics["total_ce_oi"]:.1f}L  PE OI={metrics["total_pe_oi"]:.1f}L  '
              f'MaxPain={metrics["max_pain"]:.0f}  ATM IV={metrics["atm_iv"]:.1f}%  '
              f'Resistance={metrics["top_ce_strike"]:.0f}  Support={metrics["top_pe_strike"]:.0f}')
        print(f'    Expiry: {metrics["expiry"]}  → {count} indicators stored')


# ─── NSE Options Chain scraper ───────────────────────────────────────────────
# Fetches full CE/PE option chain from NSE for NIFTY and BANKNIFTY.
# Computes: total CE OI, total PE OI, PCR (Put-Call Ratio), max pain strike,
#           top CE OI strike (resistance), top PE OI strike (support).
# Stores as Indicator rows on the respective index asset.
#
# PCR interpretation:
#   > 1.2  → Bullish (more put writing = market makers expect upside / hedging)
#   0.8–1.2 → Neutral
#   < 0.8  → Bearish (more call writing = resistance overhead)

NSE_OPTION_SYMBOLS = {
    'NIFTY':     'NIFTY50',
    'BANKNIFTY': 'NIFTY_BANK',
}


def _nse_session():
    """
    Build a requests.Session with full browser headers for NSE scraping.
    Establishes a session cookie by hitting the homepage first.
    Falls back gracefully if requests is not installed.
    """
    try:
        import requests
    except ImportError:
        print('  [WARN] requests library not installed — run: pip3 install requests')
        return None

    session = requests.Session()
    session.headers.update({
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,'
                           'image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
        'Sec-Fetch-Dest':  'document',
        'Sec-Fetch-Mode':  'navigate',
        'Sec-Fetch-Site':  'none',
        'Sec-Fetch-User':  '?1',
        'Upgrade-Insecure-Requests': '1',
    })
    try:
        session.get('https://www.nseindia.com', timeout=15)
        time.sleep(2.0)
    except Exception as e:
        print(f'  [WARN] NSE session init failed: {e}')
    return session


def fetch_options_chain(nse_symbol: str, session) -> Optional[dict]:
    """
    Fetch NSE options chain for a given symbol (e.g. 'NIFTY', 'BANKNIFTY').
    Returns the raw JSON dict or None on failure.
    """
    if session is None:
        return None
    url = f'https://www.nseindia.com/api/option-chain-indices?symbol={nse_symbol}'
    try:
        resp = session.get(url, timeout=20, headers={
            'Accept':           'application/json, text/plain, */*',
            'Referer':          'https://www.nseindia.com/option-chain',
            'Sec-Fetch-Dest':   'empty',
            'Sec-Fetch-Mode':   'cors',
            'Sec-Fetch-Site':   'same-origin',
        })
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f'  [ERROR] Options chain for {nse_symbol}: {e}')
        return None


def parse_options_chain(data: dict, nse_symbol: str) -> dict:
    """
    Compute summary metrics from raw NSE options chain JSON.
    Returns dict with: pcr, total_ce_oi, total_pe_oi, max_pain,
                       top_ce_strike (resistance), top_pe_strike (support),
                       atm_strike, atm_iv, expiry
    """
    records = data.get('records', {})
    expiry  = (records.get('expiryDates') or [''])[0]
    atm     = records.get('underlyingValue', 0)

    rows = records.get('data', [])
    # Filter to nearest expiry only
    rows = [r for r in rows if r.get('expiryDate', '') == expiry]

    total_ce_oi = 0
    total_pe_oi = 0
    ce_by_strike: dict[float, float] = {}
    pe_by_strike: dict[float, float] = {}
    ce_oi_by_strike: dict[float, float] = {}
    pe_oi_by_strike: dict[float, float] = {}
    atm_ce_iv = 0.0
    atm_pe_iv = 0.0
    atm_dist  = float('inf')

    for row in rows:
        strike = float(row.get('strikePrice', 0))
        ce = row.get('CE', {}) or {}
        pe = row.get('PE', {}) or {}

        ce_oi = float(ce.get('openInterest', 0) or 0)
        pe_oi = float(pe.get('openInterest', 0) or 0)
        total_ce_oi += ce_oi
        total_pe_oi += pe_oi
        ce_oi_by_strike[strike] = ce_oi
        pe_oi_by_strike[strike] = pe_oi

        # Track OI-weighted for max pain
        ce_by_strike[strike] = float(ce.get('totalTradedVolume', 0) or 0)
        pe_by_strike[strike] = float(pe.get('totalTradedVolume', 0) or 0)

        # ATM IV: nearest strike to underlying
        dist = abs(strike - atm)
        if dist < atm_dist:
            atm_dist  = dist
            atm_ce_iv = float(ce.get('impliedVolatility', 0) or 0)
            atm_pe_iv = float(pe.get('impliedVolatility', 0) or 0)

    pcr = round(total_pe_oi / total_ce_oi, 4) if total_ce_oi > 0 else 1.0
    atm_iv = round((atm_ce_iv + atm_pe_iv) / 2, 2) if (atm_ce_iv + atm_pe_iv) > 0 else 0.0

    # Max pain: strike where total options loss is minimised for writers
    max_pain_strike = atm
    min_pain_val    = float('inf')
    for candidate in ce_oi_by_strike:
        pain = 0.0
        for strike, ce_oi in ce_oi_by_strike.items():
            pain += ce_oi * max(0, strike - candidate)
        for strike, pe_oi in pe_oi_by_strike.items():
            pain += pe_oi * max(0, candidate - strike)
        if pain < min_pain_val:
            min_pain_val    = pain
            max_pain_strike = candidate

    top_ce_strike = max(ce_oi_by_strike, key=lambda s: ce_oi_by_strike[s], default=atm)
    top_pe_strike = max(pe_oi_by_strike, key=lambda s: pe_oi_by_strike[s], default=atm)

    return {
        'pcr':            pcr,
        'total_ce_oi':    round(total_ce_oi / 1_00_000, 2),   # in lakhs
        'total_pe_oi':    round(total_pe_oi / 1_00_000, 2),
        'max_pain':       max_pain_strike,
        'top_ce_strike':  top_ce_strike,   # resistance (most call OI)
        'top_pe_strike':  top_pe_strike,   # support (most put OI)
        'atm_iv':         atm_iv,
        'atm_strike':     atm,
        'expiry':         expiry,
    }


def store_options_indicators(conn, asset_id: str, symbol: str, metrics: dict) -> int:
    """
    Upsert options metrics into Indicator table on today's timestamp.
    Names: OPT_PCR, OPT_CE_OI_LAKH, OPT_PE_OI_LAKH, OPT_MAX_PAIN,
           OPT_RESISTANCE, OPT_SUPPORT, OPT_ATM_IV
    """
    ts_now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = [
        ('OPT_PCR',          metrics['pcr']),
        ('OPT_CE_OI_LAKH',   metrics['total_ce_oi']),
        ('OPT_PE_OI_LAKH',   metrics['total_pe_oi']),
        ('OPT_MAX_PAIN',     metrics['max_pain']),
        ('OPT_RESISTANCE',   metrics['top_ce_strike']),
        ('OPT_SUPPORT',      metrics['top_pe_strike']),
        ('OPT_ATM_IV',       metrics['atm_iv']),
    ]
    stored = 0
    with conn.cursor() as cur:
        for name, value in rows:
            if value == 0:
                continue
            cur.execute(
                '''
                INSERT INTO "Indicator" (id, "assetId", name, value, timestamp, "createdAt")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, NOW())
                ON CONFLICT ("assetId", name, timestamp)
                DO UPDATE SET value = EXCLUDED.value, "createdAt" = NOW()
                ''',
                (asset_id, name, float(value), ts_now),
            )
            stored += 1
    conn.commit()
    return stored


def run_options(conn, asset_ids: dict):
    """Fetch NSE options chain for NIFTY + BANKNIFTY and persist metrics to DB."""
    print('\n═══ NSE OPTIONS OI / PCR MODE ═══')
    opener = _nse_session()

    for nse_sym, db_ticker in NSE_OPTION_SYMBOLS.items():
        asset_id = asset_ids.get(db_ticker)
        if not asset_id:
            print(f'  [SKIP] {db_ticker} not in DB')
            continue

        print(f'  Fetching options chain: {nse_sym}…', end=' ', flush=True)
        raw = fetch_options_chain(nse_sym, opener)
        if not raw:
            print('failed')
            continue

        metrics = parse_options_chain(raw, nse_sym)
        count   = store_options_indicators(conn, asset_id, db_ticker, metrics)

        pcr_label = (
            'Bullish (PCR > 1.2)' if metrics['pcr'] > 1.2 else
            'Bearish (PCR < 0.8)' if metrics['pcr'] < 0.8 else
            'Neutral'
        )
        print(f'PCR={metrics["pcr"]:.3f} → {pcr_label}')
        print(f'    CE OI={metrics["total_ce_oi"]:.1f}L  PE OI={metrics["total_pe_oi"]:.1f}L  '
              f'MaxPain={metrics["max_pain"]:.0f}  ATM IV={metrics["atm_iv"]:.1f}%  '
              f'Resistance={metrics["top_ce_strike"]:.0f}  Support={metrics["top_pe_strike"]:.0f}')
        print(f'    Expiry: {metrics["expiry"]}  → {count} indicators stored')

    print()


def main():
    parser = argparse.ArgumentParser(description='X-Capital Flow price ingestion')
    parser.add_argument('--live',         action='store_true', help='Live snapshot only (fast, default)')
    parser.add_argument('--history',      action='store_true', help='Full OHLCV history ingest via Yahoo')
    parser.add_argument('--fii',          action='store_true', help='Fetch FII/DII institutional flows from NSE')
    parser.add_argument('--options',      action='store_true', help='Fetch options OI + PCR from Dhan (NIFTY50 + NIFTY_BANK)')
    parser.add_argument('--dhan-history', action='store_true', help='Fetch NSE index OHLCV history from Dhan (real volume)')
    parser.add_argument('--core3',        action='store_true', help='Restrict Dhan history to NIFTY50, NIFTY_100, NIFTY_BANK only')
    parser.add_argument('--days',         type=int, default=1825, help='Days of history (default 1825 = 5 years)')
    parser.add_argument('--all',          action='store_true', help='live + history + fii + options (Dhan if configured)')
    parser.add_argument('--no-cache',     action='store_true', help='Bypass live snapshot cache')
    parser.add_argument('--ticker',       type=str, nargs='+', help='Restrict to specific ticker(s), e.g. --ticker NIFTY_SMALLCAP NIFTY_AUTO')
    args = parser.parse_args()

    run_live_mode         = args.live or args.all or (not args.live and not args.history and not args.fii and not args.options and not args.dhan_history)
    run_history_mode      = args.history or args.all
    run_dhan_history_mode = args.dhan_history or args.all
    run_fii_mode          = args.fii or args.all
    run_options_mode      = args.options or args.all
    use_cache             = not args.no_cache
    dhan_filter           = set(args.ticker) if args.ticker else (CORE_3_TICKERS if args.core3 else None)

    print('X-Capital Flow — Price Ingestion')
    dhan_status = f'Dhan ✓ (client={DHAN_CLIENT_ID[:6]}…)' if DHAN_ENABLED else 'Dhan ✗ (no credentials)'
    print(f'  Mode:    {"live " if run_live_mode else ""}{"history " if run_history_mode else ""}{"dhan-history " if run_dhan_history_mode else ""}{"fii " if run_fii_mode else ""}{"options" if run_options_mode else ""}')
    print(f'  Days:    {args.days}')
    print(f'  Cache:   {"enabled" if use_cache else "disabled (--no-cache)"}')
    print(f'  DB:      NeonDB ({"connected" if DATABASE_URL else "NOT SET"})')
    print(f'  {dhan_status}')
    print()

    conn = get_conn()
    try:
        asset_ids = ensure_assets_exist(conn)
        print(f'  Found {len(asset_ids)} assets in DB: {", ".join(sorted(asset_ids.keys()))}')
        print()

        if run_live_mode:
            # Dhan live for NSE indices (real volume), Yahoo for rest
            if DHAN_ENABLED:
                dhan_snap = run_dhan_live(conn, asset_ids)
                if dhan_snap:
                    print(f'  [Dhan] Live snapshot: {len(dhan_snap)} NSE indices updated with real volume')
            run_live(conn, asset_ids, use_cache=use_cache)

        if run_dhan_history_mode:
            run_dhan_history(conn, asset_ids, args.days, tickers_filter=dhan_filter)

        if run_history_mode:
            run_history(conn, asset_ids, args.days)

        if run_fii_mode:
            run_fii_dii(conn, asset_ids)

        if run_options_mode:
            # Dhan options (primary) — no NSE Akamai dependency
            run_dhan_options(conn, asset_ids)

    finally:
        conn.close()


if __name__ == '__main__':
    main()
