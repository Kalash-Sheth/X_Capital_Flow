#!/usr/bin/env python3
"""
X-Capital Flow — Dhan WebSocket Live Feed

Streams real-time LTP + OHLC for NIFTY50, NIFTY_100, NIFTY_BANK via Dhan
Live Market Feed WebSocket (v2). Writes live prices to PriceData every ~5s.

Runs alongside pipeline.py (REST scheduler). Start both in separate terminals:
  Terminal 1: python3 scripts/pipeline.py       # REST: history + EOD + options
  Terminal 2: python3 scripts/ws_feed.py        # WebSocket: live price stream

Refs: https://dhanhq.co/docs/v2/live-market-feed/
"""

import sys
import os
import asyncio
import signal
from datetime import datetime, timezone, timedelta, date

from dotenv import load_dotenv

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_BASE, '.env'))
load_dotenv(os.path.join(_BASE, '.env.local'), override=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import get_conn, ensure_assets_exist, DHAN_ENABLED

# ─── Config ───────────────────────────────────────────────────────────────────

DHAN_ACCESS_TOKEN = os.environ.get('DHAN_ACCESS_TOKEN', '')
DHAN_CLIENT_ID    = os.environ.get('DHAN_CLIENT_ID', '')

IST = timezone(timedelta(hours=5, minutes=30))

# NSE index instruments for DhanFeed
# Format: (exchange_segment_constant, security_id_int)
# securityId must be int for the SDK
NSE_INSTRUMENTS = {
    'NIFTY50':   13,
    'NIFTY_100': 13316,
    'NIFTY_BANK': 25,
}

# ─── Market hours ─────────────────────────────────────────────────────────────

def now_ist() -> datetime:
    return datetime.now(IST)


def is_market_hours() -> bool:
    t = now_ist()
    if t.weekday() >= 5:
        return False
    open_  = t.replace(hour=9,  minute=10, second=0, microsecond=0)
    close_ = t.replace(hour=15, minute=40, second=0, microsecond=0)
    return open_ <= t <= close_


def seconds_to_open() -> float:
    """Seconds until next 09:10 IST (today or tomorrow)."""
    t = now_ist()
    nxt = t.replace(hour=9, minute=10, second=0, microsecond=0)
    if nxt <= t:
        nxt += timedelta(days=1)
    return (nxt - t).total_seconds()


# ─── Price writer ─────────────────────────────────────────────────────────────

class PriceWriter:
    """
    Buffers live tick data and flushes to PriceData DB every flush_interval seconds.
    Uses upsert on (assetId, timestamp=today midnight UTC) so each day has one row
    that gets updated continuously during market hours.
    """

    def __init__(self, asset_ids: dict, flush_interval: int = 5):
        self._asset_ids     = asset_ids
        self._flush_interval = flush_interval
        self._buffer: dict[str, dict] = {}  # {ticker: latest_data}
        self._last_flush    = 0.0

    def update(self, ticker: str, price: float, open_: float, high: float, low: float, volume: float):
        self._buffer[ticker] = {
            'price':  price,
            'open':   open_,
            'high':   high,
            'low':    low,
            'volume': volume,
            'ts':     datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0),
        }

    def maybe_flush(self):
        import time
        now = time.time()
        if now - self._last_flush < self._flush_interval:
            return
        self._flush()
        self._last_flush = now

    def _flush(self):
        if not self._buffer:
            return
        try:
            conn = get_conn()
            with conn.cursor() as cur:
                for ticker, d in self._buffer.items():
                    asset_id = self._asset_ids.get(ticker)
                    if not asset_id:
                        continue
                    cur.execute(
                        '''
                        INSERT INTO "PriceData"
                          (id, "assetId", timestamp, open, high, low, close, volume, source, "createdAt")
                        VALUES
                          (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, 'dhan_ws', NOW())
                        ON CONFLICT ("assetId", timestamp)
                        DO UPDATE SET
                          open      = EXCLUDED.open,
                          high      = EXCLUDED.high,
                          low       = EXCLUDED.low,
                          close     = EXCLUDED.close,
                          volume    = EXCLUDED.volume,
                          source    = EXCLUDED.source,
                          "createdAt" = NOW()
                        ''',
                        (asset_id, d['ts'],
                         d['open'], d['high'], d['low'], d['price'], d['volume']),
                    )
            conn.commit()
            conn.close()
            t = now_ist().strftime('%H:%M:%S IST')
            lines = [f'{tk}: ₹{v["price"]:,.2f}' for tk, v in self._buffer.items()]
            print(f'[{t}] WS flush → {" | ".join(lines)}')
            self._buffer = {}
        except Exception as e:
            print(f'[WS] DB flush error: {e}')


# ─── WebSocket feed ───────────────────────────────────────────────────────────

async def run_feed(asset_ids: dict):
    """Connect to Dhan WS v2, stream Quote data, flush to DB."""
    from dhanhq import marketfeed

    instruments = [
        (marketfeed.IDX, sid, marketfeed.Quote)
        for sid in NSE_INSTRUMENTS.values()
    ]

    writer = PriceWriter(asset_ids, flush_interval=5)

    # Reverse map: security_id (int) → ticker
    sid_to_ticker = {v: k for k, v in NSE_INSTRUMENTS.items()}

    feed = marketfeed.DhanFeed(
        client_id    = DHAN_CLIENT_ID,
        access_token = DHAN_ACCESS_TOKEN,
        instruments  = instruments,
        version      = 'v2',
    )

    print(f'[WS] Connecting to Dhan Live Feed v2...')
    print(f'[WS] Instruments: {list(NSE_INSTRUMENTS.keys())}')

    # Connect
    await feed.connect()
    print('[WS] Connected. Streaming live quotes...\n')

    stop_event = asyncio.get_event_loop().create_future()

    def _handle_signal():
        if not stop_event.done():
            stop_event.set_result(None)

    try:
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGINT,  _handle_signal)
        loop.add_signal_handler(signal.SIGTERM, _handle_signal)
    except NotImplementedError:
        pass  # Windows doesn't support add_signal_handler

    try:
        while not stop_event.done():
            if not is_market_hours():
                wait = seconds_to_open()
                h, m = divmod(int(wait // 60), 60)
                print(f'[WS] Market closed. Reconnecting at 09:10 IST (in {h}h {m}m)...')
                await asyncio.sleep(min(wait, 3600))
                continue

            try:
                data = await asyncio.wait_for(feed.get_data(), timeout=30)
                if not data:
                    continue

                # data can be a dict or list of dicts depending on SDK version
                items = data if isinstance(data, list) else [data]
                for item in items:
                    sid   = item.get('security_id') or item.get('securityId')
                    if sid is None:
                        continue
                    sid    = int(sid)
                    ticker = sid_to_ticker.get(sid)
                    if not ticker:
                        continue

                    ltp    = float(item.get('LTP')    or item.get('last_price') or 0)
                    open_  = float(item.get('open')   or ltp)
                    high   = float(item.get('high')   or ltp)
                    low    = float(item.get('low')    or ltp)
                    volume = float(item.get('volume') or 0)

                    if ltp > 0:
                        writer.update(ticker, ltp, open_, high, low, volume)

                writer.maybe_flush()

            except asyncio.TimeoutError:
                # No data for 30s — send a keepalive by reconnecting
                print('[WS] No data for 30s — reconnecting...')
                await feed.connect()
            except Exception as e:
                print(f'[WS] Error: {e} — reconnecting in 5s...')
                await asyncio.sleep(5)
                try:
                    await feed.connect()
                except Exception:
                    pass

    finally:
        try:
            feed.close_connection()
        except Exception:
            pass
        print('\n[WS] Feed stopped.')


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    print('═══════════════════════════════════════════════════════')
    print('      X-Capital Flow — Dhan WebSocket Live Feed        ')
    print(f'  Started : {now_ist().strftime("%Y-%m-%d %H:%M:%S IST")}')
    print(f'  Market  : {"OPEN" if is_market_hours() else "CLOSED"}')
    print('═══════════════════════════════════════════════════════\n')

    if not DHAN_ENABLED:
        print('[ERROR] DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID must be set in .env')
        sys.exit(1)

    # Get asset IDs once
    conn      = get_conn()
    asset_ids = ensure_assets_exist(conn)
    conn.close()

    print(f'[WS] Asset IDs loaded: {list(asset_ids.keys())}\n')

    asyncio.run(run_feed(asset_ids))


if __name__ == '__main__':
    main()
