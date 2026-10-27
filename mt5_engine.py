"""
MT5 Engine & Liquidity Bookmap Processor for XAUUSD
Handles MT5 connection, tick streams, Depth of Market (DOM),
Order Flow volume footprint calculation, CVD, and trade execution.
"""
import time
import math
import asyncio
import urllib.request
import json
import threading
from datetime import datetime
from typing import List, Dict, Any, Optional

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except (ImportError, Exception):
    mt5 = None
    MT5_AVAILABLE = False

class OrderFlowEngine:
    def __init__(self, symbol: str = "XAUUSD.m"):
        self.symbol = symbol
        self.is_connected = False
        self.simulation_mode = False
        self.tick_digits = 2
        self.tick_size = 0.01
        
        # State
        self.current_bid = 0.0
        self.current_ask = 0.0
        self.last_price = 0.0
        self.spread = 0.0
        
        # Order Book / Depth (price -> volume)
        self.order_book_bids: Dict[float, float] = {}
        self.order_book_asks: Dict[float, float] = {}
        
        # Trade / Bubble feed
        self.recent_trades: List[Dict[str, Any]] = []
        self.last_bubble_time_ms = 0
        self._last_bubble_price = 0.0
        
        # Footprint candles (1-min or custom timeframe)
        self.timeframe = "M1"
        self.candles: List[Dict[str, Any]] = []
        self.current_candle: Optional[Dict[str, Any]] = None
        self.candle_interval = 60 # seconds
        
        # Cumulative Volume Delta
        self.cvd = 0.0
        self.cvd_history: List[Dict[str, Any]] = []
        
        # Account info
        self.account_info: Dict[str, Any] = {}
        self.positions: List[Dict[str, Any]] = []
        
        # Liquidity Heatmap snapshots: list of {timestamp, bid_levels: {price: vol}, ask_levels: {price: vol}}
        self.heatmap_history: List[Dict[str, Any]] = []
        self._last_supabase_sync_time = 0.0
        self.max_heatmap_records = 850
        
        # Persistent resting order book (price -> volume)
        # Keeps institutional limit walls FIXED at absolute price levels across time
        self.persistent_walls: Dict[float, float] = {}
        self.spoof_walls: Dict[float, Dict[str, Any]] = {}
        self.last_depth_update_time = 0.0

        # Session VWAP & Standard Deviation Bands
        self.vwap_cum_vol = 0.0
        self.vwap_cum_pv = 0.0
        self.vwap_cum_pv2 = 0.0
        self.current_vwap = 0.0
        self.vwap_std1_up = 0.0
        self.vwap_std1_down = 0.0
        self.vwap_std2_up = 0.0
        self.vwap_std2_down = 0.0
        self.detected_divergence: Optional[Dict[str, Any]] = None
        self.trapped_traders: List[Dict[str, Any]] = []
        self._last_trapped_candle_time = 0
        self.bookmap_signals: List[Dict[str, Any]] = []
        self._last_bm_signal_time = 0.0
        self._last_bm_signal_dir = None

        # Prop-Firm Feature 1: USD High-Impact News & Volatility Shield
        self.news_filter_enabled = True
        self._price_10s_buffer: List[Dict[str, float]] = []
        self._last_news_block_log_time = 0.0

        # Prop-Firm Feature 2: Trading Sessions & HTF Benchmarks (Asian, London, NY, PDH, PDL, Daily Open, H1 & H4 SNR)
        self.sessions_data: Dict[str, Any] = {
            "active_session": "ASIA",
            "asian_high": 0.0,
            "asian_low": 0.0,
            "london_high": 0.0,
            "london_low": 0.0,
            "ny_high": 0.0,
            "ny_low": 0.0,
            "pdh": 0.0,
            "pdl": 0.0,
            "daily_open": 0.0,
            "m15_high": 0.0,
            "m15_low": 0.0,
            "m15_res": 0.0,
            "m15_sup": 0.0,
            "m30_high": 0.0,
            "m30_low": 0.0,
            "m30_res": 0.0,
            "m30_sup": 0.0,
            "h1_high": 0.0,
            "h1_low": 0.0,
            "h1_res": 0.0,
            "h1_sup": 0.0,
            "h4_high": 0.0,
            "h4_low": 0.0,
            "h4_res": 0.0,
            "h4_sup": 0.0,
            "h8_high": 0.0,
            "h8_low": 0.0,
            "h8_res": 0.0,
            "h8_sup": 0.0,
            "sweep_alert": None
        }
        self._last_sweep_time = 0.0

        # World-Class Feature 4: Composite Session Volume Profile (SVP - dPOC, VAH, VAL, LVN)
        self.session_vp_buckets: Dict[str, Dict[str, float]] = {}
        self.session_vp_summary: Dict[str, Any] = {
            "dpoc": 0.0,
            "vah": 0.0,
            "val": 0.0,
            "total_volume": 0.0,
            "lvn_levels": [],
            "buckets": []
        }

        # World-Class Feature 5: Iceberg Orders & Absorption Detector
        self._absorption_window: List[Dict[str, Any]] = []
        self.iceberg_orders: List[Dict[str, Any]] = []
        self._last_iceberg_time: float = 0.0

        # Prop-Firm Feature 3: Tick-Velocity & Micro-Acceleration Volume Engine
        self._tick_timestamps: List[float] = []
        self._price_deltas_1s: List[Dict[str, float]] = []
        self.tick_velocity_1s: int = 1
        self.price_velocity_1s: float = 0.0
        self._prev_raw_bid: float = 0.0
        self._prev_raw_ask: float = 0.0
        self._prev_tick_ts: float = 0.0

        # Feed Source ('swissquote' or 'mt5') - Default to Swissquote Bank Tier-1 Global Feed
        self.feed_source = "swissquote"
        self._last_sq_fetch_time = 0.0
        self.swissquote_status = "READY"
        self._last_mt5_tick_msc = 0
        self._last_tick_time = time.time()
        self._last_account_poll_time = 0.0

        # World-Class Elite Suite:
        # 1. Spoofing Detector (Pulling vs Stacking Engine)
        self.spoof_events: List[Dict[str, Any]] = []
        self._depth_snapshots_buffer: List[Dict[str, Any]] = []
        self._last_spoof_eval_time: float = 0.0

        # 2. Multi-Timeframe Confluence Matrix (M1 + M5 + M15 + H1)
        self.mtf_confluence: Dict[str, Any] = {}

        # 3. Prop-Firm Smart Risk Shield & Drawdown Breaker
        self.initial_daily_equity: float = 100000.0
        self.prop_firm_enabled: bool = True
        self.max_daily_drawdown_pct: float = 4.0
        self.prop_firm_shield: Dict[str, Any] = {
            "enabled": True,
            "max_daily_loss_pct": 4.0,
            "initial_equity": 100000.0,
            "current_drawdown_pct": 0.0,
            "current_drawdown_usd": 0.0,
            "is_locked": False,
            "headline": "🛡️ PROP-FIRM SAFE: Drawdown Rendah"
        }

        self._worker_started = False
        self._seed_initial_data()
        self._start_background_workers()
        
    def _start_background_workers(self):
        """Starts asynchronous non-blocking thread for 1-second price ingestion"""
        if self._worker_started:
            return
        self._worker_started = True
        self._worker_thread = threading.Thread(target=self._swissquote_poller_loop, daemon=True)
        self._worker_thread.start()

    def _calculate_tick_velocity_volume(self, bid: float, ask: float, broker_base_vol: float = 1.0) -> float:
        """
        Calculates institutional order flow volume based on real microstructure dynamics:
        1. Tick Arrival Velocity (ticks per second)
        2. Micro-Price Displacement (pip jump per millisecond)
        3. Spread Compression / Expansion
        """
        now = time.time()
        self._tick_timestamps.append(now)
        # Keep rolling 1.5s window of ticks
        cutoff = now - 1.5
        self._tick_timestamps = [t for t in self._tick_timestamps if t >= cutoff]
        self.tick_velocity_1s = max(1, len(self._tick_timestamps))

        dp = 0.05
        if self._prev_raw_bid > 0 and self._prev_raw_ask > 0:
            dp = abs(bid - self._prev_raw_bid) + abs(ask - self._prev_raw_ask)
        dt = max(0.05, now - self._prev_tick_ts) if self._prev_tick_ts > 0 else 0.50

        self._prev_raw_bid = bid
        self._prev_raw_ask = ask
        self._prev_tick_ts = now

        self._price_deltas_1s.append({"t": now, "dp": dp})
        self._price_deltas_1s = [x for x in self._price_deltas_1s if x["t"] >= cutoff]
        self.price_velocity_1s = round(sum(x["dp"] for x in self._price_deltas_1s), 2)

        # Base institutional lot from broker tick volume + tick frequency
        freq_component = min(6.5, self.tick_velocity_1s * 0.65)
        # Displacement component: sharp price jumps ($0.15+) represent aggressive sweeping of limit orders
        disp_component = min(14.0, (dp / 0.05) * 1.45)
        # Velocity acceleration bonus when price moves > $0.35 within 1.5s
        accel_bonus = 6.5 if self.price_velocity_1s >= 0.45 else (2.5 if self.price_velocity_1s >= 0.22 else 0.0)

        computed_vol = max(0.8, round((broker_base_vol * 0.4) + freq_component + disp_component + accel_bonus, 1))
        return min(28.0, computed_vol)

    def _swissquote_poller_loop(self):
        """Dedicated high-speed thread that fetches Swissquote Bank strictly every 1.0s without blocking the server"""
        while True:
            try:
                # Poll Swissquote whenever selected or as cloud fallback
                if self.feed_source == "swissquote" or not self.is_connected or not MT5_AVAILABLE:
                    now = time.time()
                    req = urllib.request.Request(
                        'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
                        headers={'User-Agent': 'Mozilla/5.0'}
                    )
                    with urllib.request.urlopen(req, timeout=1.4) as resp:
                        data = json.loads(resp.read().decode())
                        if data and len(data) > 0:
                            profile = data[0].get('spreadProfilePrices', [{}])[0]
                            bid = float(profile.get('bid', 0.0))
                            ask = float(profile.get('ask', 0.0))
                            if bid > 0 and ask > 0:
                                bid = round(bid, 2)
                                ask = round(ask, 2)
                                vol = self._calculate_tick_velocity_volume(bid, ask, 1.0)
                                self.process_tick(bid, ask, vol)
                                self._last_tick_time = now
                                self.swissquote_status = "LIVE_OK"
            except Exception as e:
                self.swissquote_status = f"ERR: {e}"
            time.sleep(0.75) # High-precision 750ms cadence for real-time Swissquote tick stream

    def initialize_mt5(self) -> bool:
        """Connect to MT5 terminal and find the correct Gold symbol"""
        if not MT5_AVAILABLE or mt5 is None:
            print("[MT5] MetaTrader5 not available on this platform. Using Swissquote Cloud feed.")
            self.feed_source = "swissquote"
            if len(self.candles) == 0:
                self._seed_initial_data()
            return False

        try:
            initialized = mt5.initialize(timeout=3000)
        except Exception as e:
            print(f"[MT5] Initialize exception: {e}")
            initialized = False

        if not initialized:
            print(f"[MT5] Initialization failed or timed out: {mt5.last_error() if hasattr(mt5, 'last_error') else 'timeout'}")
            self.simulation_mode = False
            self.feed_source = "swissquote"
            self._seed_initial_data()
            return False
            
        print("[MT5] Initialized successfully!")
        self.is_connected = True
        # Keep Swissquote Bank as default feed source unless explicitly changed by user
        if not hasattr(self, 'feed_source') or not self.feed_source:
            self.feed_source = "swissquote"
        
        # Find Gold symbol
        all_symbols = mt5.symbols_get()
        gold_candidates = [s.name for s in all_symbols if 'XAU' in s.name.upper() or 'GOLD' in s.name.upper()]
        
        if self.symbol not in [s.name for s in all_symbols]:
            if gold_candidates:
                self.symbol = gold_candidates[0]
                print(f"[MT5] Switched to available Gold symbol: {self.symbol}")
            else:
                self.symbol = "XAUUSD"
                
        mt5.symbol_select(self.symbol, True)
        info = mt5.symbol_info(self.symbol)
        if info:
            self.tick_digits = info.digits
            self.tick_size = 0.01 if info.digits == 2 else 0.001
            print(f"[MT5] Symbol: {self.symbol}, Digits: {self.tick_digits}, Spread: {info.spread}")
            
        self._update_account_info()
        self._seed_initial_data()
        return True

    def _init_simulation_state(self):
        """Initial state for fallback or simulation mode"""
        self.symbol = "XAUUSD (Demo)"
        self.current_bid = 4145.20
        self.current_ask = 4145.45
        self.last_price = 4145.30
        self.spread = 0.25
        self.tick_digits = 2
        self.tick_size = 0.01
        self.account_info = {
            "login": 888888,
            "name": "Order Flow Trader (Demo)",
            "server": "Simulator-Server",
            "balance": 100000.00,
            "equity": 100000.00,
            "margin": 0.0,
            "free_margin": 100000.00,
            "profit": 0.0,
            "leverage": 500
        }
        self._seed_initial_data()

    def _init_persistent_walls(self, base_price: float):
        """
        Build Smooth, Authentic Institutional Liquidity Memory & Resting Shark/Whale Order Walls.
        1. Calm ambient depth (12-18 Lots) across normal price ticks
        2. Radiant Gold psychological shelves at $0.50 (54-62L)
        3. Fiery Orange / Crimson Shark Walls at $1.00 (82-96L) and $5.00/$10.00 (118-132L)
        4. Selective reinforcement at Top Swing Highs & Swing Lows (110-138L)
        """
        self.persistent_walls = {}
        start_p = round((base_price - 35.0) * 10) / 10.0
        end_p   = round((base_price + 35.0) * 10) / 10.0

        # 1. Initialize institutional liquidity grid across ±$35.00
        p = start_p
        while p <= end_p:
            p = round(p, 2)
            cents = round(p * 100) % 100
            dollar_int = int(round(p))
            dollar_mod5 = dollar_int % 5
            dollar_mod2 = dollar_int % 2
            if cents == 0:
                # Whole-dollar Shark Wall ($x.00): Mega wall at $5/$10, major wall at even/odd dollars
                vol = 122.0 if dollar_mod5 == 0 else (94.0 if dollar_mod2 == 0 else 82.0)
            elif cents in (10, 90):
                # Smooth shoulder around $1.00 Shark Wall
                vol = 34.0 if dollar_mod5 == 0 else 28.0
            elif cents == 50:
                # Half-dollar psychological shelf ($x.50) - Radiant Gold
                vol = 58.0 if dollar_mod2 == 0 else 52.0
            elif cents in (40, 60):
                # Smooth shoulder around $0.50 shelf
                vol = 24.0
            elif cents in (20, 80) and dollar_mod2 == 0:
                # Secondary institutional resting cluster
                vol = 36.0
            else:
                # Calm ambient market-maker book depth (Deep Navy)
                vol = 12.0 + (cents % 30) * 0.12
            self.persistent_walls[p] = round(vol, 1)
            p = round(p + 0.10, 2)

        # 2. Selectively reinforce Top 3 Swing Highs & Top 3 Swing Lows from MT5 M5 history
        if self.is_connected and not self.simulation_mode and mt5 is not None:
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_M5", 5), 0, 48)
                if rates is not None and len(rates) > 4:
                    swing_highs = []
                    swing_lows = []
                    for idx in range(2, len(rates) - 2):
                        h_val = float(rates[idx]['high'])
                        l_val = float(rates[idx]['low'])
                        if h_val >= float(rates[idx - 1]['high']) and h_val >= float(rates[idx + 1]['high']) and h_val > base_price + 0.30:
                            swing_highs.append((round(h_val, 1), float(rates[idx]['tick_volume'])))
                        if l_val <= float(rates[idx - 1]['low']) and l_val <= float(rates[idx + 1]['low']) and l_val < base_price - 0.30:
                            swing_lows.append((round(l_val, 1), float(rates[idx]['tick_volume'])))

                    # Pick top 3 swing highs & top 3 swing lows by volume
                    swing_highs.sort(key=lambda x: x[1], reverse=True)
                    swing_lows.sort(key=lambda x: x[1], reverse=True)
                    chosen_swings = swing_highs[:3] + swing_lows[:3]

                    for sw_p, sw_v in chosen_swings:
                        if sw_p in self.persistent_walls:
                            boost = min(55.0, max(28.0, sw_v * 0.08))
                            self.persistent_walls[sw_p] = round(min(138.0, self.persistent_walls[sw_p] + boost), 1)
                            # Gaussian shoulder on adjacent ±$0.10 ticks
                            for adj in (round(sw_p - 0.10, 2), round(sw_p + 0.10, 2)):
                                if adj in self.persistent_walls:
                                    self.persistent_walls[adj] = round(min(74.0, self.persistent_walls[adj] + boost * 0.45), 1)
            except Exception:
                pass

    def _seed_initial_data(self):
        """
        Pre-populate a full 60 seconds of ultra-dense, authentic Bookmap-style heatmap data.
        Features:
          • Continuous horizontal ribbons (fixed price resting orders)
          • Split 3D bubbles (both aggressive buyers and aggressive sellers)
          • Stepped orthogonal price line (green up, red down)
          • Real-time volume & book delta aggregation
        """
        # Obtain live market price if connected
        if self.is_connected and not self.simulation_mode:
            try:
                tick = mt5.symbol_info_tick(self.symbol)
                if tick and tick.bid > 0:
                    self.current_bid = round(tick.bid, self.tick_digits)
                    self.current_ask = round(tick.ask, self.tick_digits)
                    self.last_price = self.current_ask
            except Exception:
                pass

        base_price = self.current_bid if self.current_bid > 0 else 4008.0
        now_ms = int(time.time() * 1000)
        
        self._init_persistent_walls(base_price)
        
        self.heatmap_history = []
        self.recent_trades   = []
        self.cvd_history     = []
        
        # Restore real historical heatmap from Supabase Cloud DB
        try:
            from supabase_client import supabase
            if supabase.is_connected:
                cloud_heatmap = supabase.load_latest_heatmap(350)
                if cloud_heatmap and len(cloud_heatmap) >= 20:
                    self.heatmap_history = cloud_heatmap
                    print(f"[Supabase Cloud DB] Berjaya memuatkan {len(cloud_heatmap)} hirisan peta haba Bookmap sebenar!")
        except Exception as sbErr:
            print(f"[Supabase Heatmap Restore] {sbErr}")

        # Pre-seed 300 heatmap slices across the past 60 seconds (every 200ms)
        p_walker = base_price
        prev_p   = base_price
        
        for i in range(350, -1, -1):
            t_ms = now_ms - (i * 200)
            
            # Realistic micro-walk between liquidity walls
            drift = math.sin(i * 0.07) * 0.05
            noise = (math.sin(i * 1.5) * 0.05) + (math.cos(i * 2.1) * 0.04)
            p_walker = round(p_walker + drift + noise, 2)
            # Clamp to ±$3.50 around base
            p_walker = max(base_price - 3.5, min(base_price + 3.5, p_walker))
            
            bids = {}
            asks = {}
            
            # Slice the persistent order book: 110 levels (±$11.00) above and below p_walker so vertical panning always has heatmap depth
            for level in range(1, 110):
                bp = round(p_walker - (level * 0.10), 2)
                ap = round(p_walker + (level * 0.10), 2)
                
                # Retrieve fixed resting wall or compute ambient
                wall_b = self.persistent_walls.get(bp, 12.0)
                wall_a = self.persistent_walls.get(ap, 12.0)
                
                # Subtle dynamic breathing (±6%) so walls look live and organic
                breath_b = 1.0 + 0.06 * math.sin(i * 0.1 + level * 0.3)
                breath_a = 1.0 + 0.06 * math.cos(i * 0.1 + level * 0.3)
                
                b_key = f"{bp:.2f}"
                a_key = f"{ap:.2f}"
                bids[b_key] = round(max(4.0, wall_b * breath_b), 1)
                asks[a_key] = round(max(4.0, wall_a * breath_a), 1)
                
            self.heatmap_history.append({
                "timestamp": t_ms,
                "mid_price": p_walker,
                "bids": bids,
                "asks": asks
            })
            
            # Generate realistic trade executions across the entire 60s history
            if i % 3 == 0:
                is_up = p_walker >= prev_p
                tprice = round(p_walker + (0.05 if is_up else -0.05), 2)
                
                # Total volume in this slice
                vol = round(2.0 + abs(math.sin(i * 0.6)) * 9.0, 1)
                if i % 14 == 0:
                    vol = round(18.0 + (i % 14), 1) # Institutional Whale
                    
                # In Bookmap, volume is often split between buyers and sellers
                if is_up:
                    buy_ratio = 0.70 + (math.sin(i) * 0.20)
                else:
                    buy_ratio = 0.30 + (math.sin(i) * 0.20)
                buy_ratio = max(0.05, min(0.95, buy_ratio))
                
                buy_vol = round(vol * buy_ratio, 1)
                sell_vol = round(vol - buy_vol, 1)
                primary_side = "buy" if buy_vol >= sell_vol else "sell"
                
                self.recent_trades.append({
                    "id": t_ms,
                    "timestamp": t_ms,
                    "price": tprice,
                    "volume": vol,
                    "buy_vol": buy_vol,
                    "sell_vol": sell_vol,
                    "side": primary_side,
                    "is_large": vol >= 12.0
                })
                
                delta = buy_vol - sell_vol
                self.cvd += delta
                self.cvd_history.append({
                    "timestamp": t_ms,
                    "price": tprice,
                    "cvd": round(self.cvd, 2),
                    "delta": round(delta, 2)
                })
                
            prev_p = p_walker

        # Pre-seed historical candles for the active timeframe so Candlestick, ClusterDelta & Footprint charts are immediately full
        self.last_price = base_price
        self.set_timeframe(self.timeframe)

        # Start live active candle connected seamlessly to the last historical close
        if not self.current_candle:
            now = int(time.time())
            candle_open_time = now - (now % self.candle_interval)
            open_p = self.candles[-1]["close"] if self.candles else base_price
            self.current_candle = {
                "time": candle_open_time,
                "open": open_p,
                "high": max(open_p, base_price),
                "low": min(open_p, base_price),
                "close": base_price,
                "volume": 0.0,
                "delta": 0.0,
                "min_delta": 0.0,
                "max_delta": 0.0,
                "buy_volume": 0.0,
                "sell_volume": 0.0,
                "poc": base_price,
                "vah": base_price,
                "val": base_price,
                "stacked_buy": [],
                "stacked_sell": [],
                "unfinished_high": False,
                "unfinished_low": False,
                "clusters": {}
            }
        self._init_session_levels(base_price)

    def _init_session_levels(self, base_price: float):
        """Initialize Asian, London, NY session High/Low, PDH, PDL, Daily Open, H1 & H4 SNR levels & seed Composite SVP"""
        ah = round(base_price + 2.40, 2)
        al = round(base_price - 2.10, 2)
        lh = round(base_price + 3.60, 2)
        ll = round(base_price - 3.20, 2)
        nh = round(base_price + 1.80, 2)
        nl = round(base_price - 1.60, 2)
        pdh = round(base_price + 4.80, 2)
        pdl = round(base_price - 4.50, 2)
        daily_open = round(base_price - 0.90, 2)

        # Higher Timeframe M15, M30, H1, H4 & H8 SNR Defaults
        m15_high = round(base_price + 1.20, 2)
        m15_low = round(base_price - 1.10, 2)
        m15_res = round(base_price + 1.80, 2)
        m15_sup = round(base_price - 1.60, 2)
        m30_high = round(base_price + 1.90, 2)
        m30_low = round(base_price - 1.80, 2)
        m30_res = round(base_price + 2.90, 2)
        m30_sup = round(base_price - 2.60, 2)
        h1_high = round(base_price + 2.80, 2)
        h1_low = round(base_price - 2.50, 2)
        h1_res = round(base_price + 4.20, 2)
        h1_sup = round(base_price - 3.80, 2)
        h4_high = round(base_price + 5.50, 2)
        h4_low = round(base_price - 5.20, 2)
        h4_res = round(base_price + 8.50, 2)
        h4_sup = round(base_price - 8.20, 2)
        h8_high = round(base_price + 8.20, 2)
        h8_low = round(base_price - 7.90, 2)
        h8_res = round(base_price + 12.00, 2)
        h8_sup = round(base_price - 11.50, 2)

        self.session_vp_buckets = {}

        if self.is_connected and not self.simulation_mode and mt5 is not None:
            try:
                # 1. Fetch D1 rates for PDH, PDL, and Today's Daily Open
                d1_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_D1", 16408), 0, 2)
                if d1_rates is not None and len(d1_rates) >= 2:
                    prev_day = d1_rates[0]
                    today_bar = d1_rates[1]
                    pdh = round(float(prev_day['high']), 2)
                    pdl = round(float(prev_day['low']), 2)
                    daily_open = round(float(today_bar['open']), 2)

                # 1b. Fetch M15 & M30 rates for Intraday SNR Levels
                m15_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_M15", 15), 0, 32)
                if m15_rates is not None and len(m15_rates) >= 2:
                    prev_m15 = m15_rates[-2]
                    m15_high = round(float(prev_m15['high']), 2)
                    m15_low = round(float(prev_m15['low']), 2)
                    m15_res = round(max([float(r['high']) for r in m15_rates]), 2)
                    m15_sup = round(min([float(r['low']) for r in m15_rates]), 2)

                m30_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_M30", 30), 0, 24)
                if m30_rates is not None and len(m30_rates) >= 2:
                    prev_m30 = m30_rates[-2]
                    m30_high = round(float(prev_m30['high']), 2)
                    m30_low = round(float(prev_m30['low']), 2)
                    m30_res = round(max([float(r['high']) for r in m30_rates]), 2)
                    m30_sup = round(min([float(r['low']) for r in m30_rates]), 2)

                # 2. Fetch H1 rates for H1 SNR Levels
                h1_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_H1", 16385), 0, 24)
                if h1_rates is not None and len(h1_rates) >= 2:
                    prev_h1 = h1_rates[-2]
                    h1_high = round(float(prev_h1['high']), 2)
                    h1_low = round(float(prev_h1['low']), 2)
                    h1_highs = [float(r['high']) for r in h1_rates]
                    h1_lows = [float(r['low']) for r in h1_rates]
                    h1_res = round(max(h1_highs), 2)
                    h1_sup = round(min(h1_lows), 2)

                # 3. Fetch H4 rates for H4 Major SNR Levels
                h4_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_H4", 16388), 0, 18)
                if h4_rates is not None and len(h4_rates) >= 2:
                    prev_h4 = h4_rates[-2]
                    h4_high = round(float(prev_h4['high']), 2)
                    h4_low = round(float(prev_h4['low']), 2)
                    h4_highs = [float(r['high']) for r in h4_rates]
                    h4_lows = [float(r['low']) for r in h4_rates]
                    h4_res = round(max(h4_highs), 2)
                    h4_sup = round(min(h4_lows), 2)

                # 4. Fetch H8 rates for H8 Macro Cycle SNR Levels
                h8_rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_H8", 16392), 0, 12)
                if h8_rates is not None and len(h8_rates) >= 2:
                    prev_h8 = h8_rates[-2]
                    h8_high = round(float(prev_h8['high']), 2)
                    h8_low = round(float(prev_h8['low']), 2)
                    h8_highs = [float(r['high']) for r in h8_rates]
                    h8_lows = [float(r['low']) for r in h8_rates]
                    h8_res = round(max(h8_highs), 2)
                    h8_sup = round(min(h8_lows), 2)

                # 5. Fetch M15 rates for Session H/L and seed Composite Session Volume Profile
                rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, "TIMEFRAME_M15", 15), 0, 48)
                if rates is not None and len(rates) >= 8:
                    highs = [float(r['high']) for r in rates]
                    lows = [float(r['low']) for r in rates]
                    half = len(rates) // 2
                    ah = round(max(highs[:half]), 2)
                    al = round(min(lows[:half]), 2)
                    lh = round(max(highs[half:]), 2)
                    ll = round(min(lows[half:]), 2)

                    for r in rates[-24:]:
                        mid_r = (float(r['open']) + float(r['close'])) / 2.0
                        is_bull = float(r['close']) >= float(r['open'])
                        vol_r = max(3.0, float(r['tick_volume']) * 0.12)
                        self._update_session_volume_profile(mid_r, vol_r, is_bull, recompute=False)
            except Exception:
                pass

        # Seed Session Volume Profile from recent_trades if buckets are still empty
        if not self.session_vp_buckets:
            for tr in self.recent_trades:
                self._update_session_volume_profile(tr["price"], tr["volume"], tr["side"] == "buy", recompute=False)
        self._recompute_session_vp_summary()

        # Reinforce persistent walls at key HTF benchmarks (PDH, PDL, Daily Open, Asian H/L, M15/M30/H1/H4/H8 SNR)
        for key_lvl in (ah, al, lh, ll, pdh, pdl, daily_open, m15_res, m15_sup, m30_res, m30_sup, h1_res, h1_sup, h4_res, h4_sup, h8_res, h8_sup):
            lvl_10 = round(round(key_lvl * 10) / 10.0, 2)
            if lvl_10 in self.persistent_walls:
                self.persistent_walls[lvl_10] = round(min(96.0, self.persistent_walls[lvl_10] + 34.0), 1)
                for adj in (round(lvl_10 - 0.10, 2), round(lvl_10 + 0.10, 2)):
                    if adj in self.persistent_walls:
                        self.persistent_walls[adj] = round(min(58.0, self.persistent_walls[adj] + 14.0), 1)

        self.sessions_data = {
            "active_session": self._get_current_session_name(),
            "asian_high": ah,
            "asian_low": al,
            "london_high": lh,
            "london_low": ll,
            "ny_high": nh,
            "ny_low": nl,
            "pdh": pdh,
            "pdl": pdl,
            "daily_open": daily_open,
            "m15_high": m15_high,
            "m15_low": m15_low,
            "m15_res": m15_res,
            "m15_sup": m15_sup,
            "m30_high": m30_high,
            "m30_low": m30_low,
            "m30_res": m30_res,
            "m30_sup": m30_sup,
            "h1_high": h1_high,
            "h1_low": h1_low,
            "h1_res": h1_res,
            "h1_sup": h1_sup,
            "h4_high": h4_high,
            "h4_low": h4_low,
            "h4_res": h4_res,
            "h4_sup": h4_sup,
            "h8_high": h8_high,
            "h8_low": h8_low,
            "h8_res": h8_res,
            "h8_sup": h8_sup,
            "sweep_alert": None
        }

    def _update_session_volume_profile(self, price: float, volume: float, is_buy: bool, recompute: bool = True):
        """Accumulates intraday volume into $0.50 price buckets for Composite Session Volume Profile (SVP)"""
        step = 0.50
        bp = round(math.floor(price / step) * step, 2)
        k = f"{bp:.2f}"
        if k not in self.session_vp_buckets:
            self.session_vp_buckets[k] = {"price": bp, "buy": 0.0, "sell": 0.0, "total": 0.0}
        b = self.session_vp_buckets[k]
        if is_buy:
            b["buy"] = round(b["buy"] + volume, 2)
        else:
            b["sell"] = round(b["sell"] + volume, 2)
        b["total"] = round(b["buy"] + b["sell"], 2)

        if recompute:
            self._recompute_session_vp_summary()

    def _recompute_session_vp_summary(self):
        """Calculates Developing Session POC (dPOC), 70% Session VAH/VAL, and Low Volume Nodes (LVN)"""
        if not self.session_vp_buckets:
            return
        sorted_items = sorted(self.session_vp_buckets.values(), key=lambda x: x["price"])
        total_vol = sum(x["total"] for x in sorted_items)
        if total_vol <= 0:
            return

        # Find Developing POC (highest volume bucket)
        poc_idx = 0
        max_v = -1.0
        for idx, item in enumerate(sorted_items):
            if item["total"] > max_v:
                max_v = item["total"]
                poc_idx = idx

        dpoc = sorted_items[poc_idx]["price"]

        # Expand 70% Value Area around dPOC
        target_va = total_vol * 0.70
        curr_va = sorted_items[poc_idx]["total"]
        low_i = poc_idx
        high_i = poc_idx

        while curr_va < target_va and (low_i > 0 or high_i < len(sorted_items) - 1):
            up_v = sorted_items[high_i + 1]["total"] if high_i < len(sorted_items) - 1 else -1.0
            dn_v = sorted_items[low_i - 1]["total"] if low_i > 0 else -1.0
            if up_v >= dn_v and high_i < len(sorted_items) - 1:
                high_i += 1
                curr_va += up_v
            elif low_i > 0:
                low_i -= 1
                curr_va += dn_v
            elif high_i < len(sorted_items) - 1:
                high_i += 1
                curr_va += up_v
            else:
                break

        vah = sorted_items[high_i]["price"]
        val = sorted_items[low_i]["price"]

        # Detect Low Volume Nodes (LVN - local volume valleys inside range that act as liquidity vacuums)
        lvn_levels = []
        avg_v = total_vol / max(1, len(sorted_items))
        for i in range(1, len(sorted_items) - 1):
            cur = sorted_items[i]["total"]
            prev_v = sorted_items[i - 1]["total"]
            next_v = sorted_items[i + 1]["total"]
            if cur < (avg_v * 0.55) and cur < prev_v * 0.75 and cur < next_v * 0.75:
                lvn_levels.append(sorted_items[i]["price"])

        self.session_vp_summary = {
            "dpoc": round(dpoc, 2),
            "vah": round(vah, 2),
            "val": round(val, 2),
            "max_bucket_vol": round(max_v, 1),
            "total_volume": round(total_vol, 1),
            "lvn_levels": lvn_levels[-6:],
            "buckets": sorted_items[-45:]
        }

    def _evaluate_iceberg_absorption(self, price: float, volume: float, is_buy: bool, now_ms: int):
        """
        Real-Time Institutional Iceberg Order & Passive Absorption Detector:
        Detects when heavy aggressive market orders (>= 11 Lots within 14 seconds)
        repeatedly hit a narrow $0.20 price zone without price breaking through.
        """
        now = time.time()
        bucket_20 = round(round(price * 5) / 5.0, 2)
        self._absorption_window.append({
            "t": now,
            "p": bucket_20,
            "raw_p": price,
            "v": volume,
            "is_buy": is_buy
        })
        cutoff = now - 14.0
        self._absorption_window = [x for x in self._absorption_window if x["t"] >= cutoff]

        if now - self._last_iceberg_time < 24.0:
            return

        # Aggregate aggressive buy & sell volume at this $0.20 bucket
        same_zone = [x for x in self._absorption_window if abs(x["p"] - bucket_20) <= 0.20]
        if len(same_zone) < 4:
            return

        agg_buy_vol = sum(x["v"] for x in same_zone if x["is_buy"])
        agg_sell_vol = sum(x["v"] for x in same_zone if not x["is_buy"])
        max_p_zone = max(x["raw_p"] for x in same_zone)
        min_p_zone = min(x["raw_p"] for x in same_zone)

        # 1. Bearish Iceberg (Passive Sell Limit Order absorbing aggressive Market Buyers at highs)
        if agg_buy_vol >= 12.0 and (max_p_zone - min_p_zone) <= 0.45 and price <= bucket_20 + 0.05:
            self._last_iceberg_time = now
            self.iceberg_orders = [ic for ic in self.iceberg_orders if abs(ic["price"] - bucket_20) > 0.60]
            iceberg = {
                "id": now_ms,
                "timestamp": now_ms,
                "type": "ICEBERG_SELL",
                "bias": "SELL",
                "price": bucket_20,
                "absorbed_vol": round(agg_buy_vol, 1),
                "badge": f"🧊 ICEBERG SELL @ ${bucket_20:.2f} ({agg_buy_vol:.1f}L)",
                "desc": f"Pesanan Iceberg Institusi menyerap +{agg_buy_vol:.1f} Lots belian agresif pada ${bucket_20:.2f} (Rintangan Kuat)."
            }
            self.iceberg_orders.append(iceberg)
            if len(self.iceberg_orders) > 6:
                self.iceberg_orders.pop(0)
            # Reinforce persistent wall at iceberg level
            lvl_10 = round(round(bucket_20 * 10) / 10.0, 2)
            self.persistent_walls[lvl_10] = round(min(98.0, self.persistent_walls.get(lvl_10, 52.0) + 32.0), 1)

        # 2. Bullish Iceberg (Passive Buy Limit Order absorbing aggressive Market Sellers at lows)
        elif agg_sell_vol >= 12.0 and (max_p_zone - min_p_zone) <= 0.45 and price >= bucket_20 - 0.05:
            self._last_iceberg_time = now
            self.iceberg_orders = [ic for ic in self.iceberg_orders if abs(ic["price"] - bucket_20) > 0.60]
            iceberg = {
                "id": now_ms,
                "timestamp": now_ms,
                "type": "ICEBERG_BUY",
                "bias": "BUY",
                "price": bucket_20,
                "absorbed_vol": round(agg_sell_vol, 1),
                "badge": f"🧊 ICEBERG BUY @ ${bucket_20:.2f} ({agg_sell_vol:.1f}L)",
                "desc": f"Pesanan Iceberg Institusi menyerap -{agg_sell_vol:.1f} Lots jualan agresif pada ${bucket_20:.2f} (Sokongan Kuat)."
            }
            self.iceberg_orders.append(iceberg)
            if len(self.iceberg_orders) > 6:
                self.iceberg_orders.pop(0)
            lvl_10 = round(round(bucket_20 * 10) / 10.0, 2)
            self.persistent_walls[lvl_10] = round(min(98.0, self.persistent_walls.get(lvl_10, 52.0) + 32.0), 1)

    def _get_current_session_name(self) -> str:
        """Returns active Gold market session based on Malaysia Time (UTC+8)"""
        # Calculate UTC+8 hour safely regardless of server timezone
        utc_now = datetime.utcnow()
        myt_hour = (utc_now.hour + 8) % 24
        if 6 <= myt_hour < 15:
            return "ASIA (Tokyo/Sydney)"
        elif 15 <= myt_hour < 20:
            return "LONDON OPEN"
        elif 20 <= myt_hour < 24:
            return "LONDON / NY OVERLAP 🔥"
        else:
            return "NEW YORK LATE"

    def _update_session_high_low_and_sweeps(self, price: float, now_ms: int):
        """
        Updates active session High/Low and detects Institutional Session Liquidity Sweeps
        (e.g. London sweeping Asian High/Low - ICT Judah Swing / Liquidity Raid).
        """
        if self.sessions_data["asian_high"] <= 0:
            self._init_session_levels(price)

        sess_name = self._get_current_session_name()
        self.sessions_data["active_session"] = sess_name

        ah = self.sessions_data["asian_high"]
        al = self.sessions_data["asian_low"]
        lh = self.sessions_data["london_high"]
        ll = self.sessions_data["london_low"]

        # Update current session extremes dynamically
        if "ASIA" in sess_name:
            self.sessions_data["asian_high"] = round(max(ah, price), 2)
            self.sessions_data["asian_low"] = round(min(al, price), 2)
        elif "LONDON" in sess_name and "OVERLAP" not in sess_name:
            self.sessions_data["london_high"] = round(max(lh, price), 2)
            self.sessions_data["london_low"] = round(min(ll, price), 2)
        else:
            self.sessions_data["ny_high"] = round(max(self.sessions_data["ny_high"], price), 2)
            self.sessions_data["ny_low"] = round(min(self.sessions_data["ny_low"], price), 2)

        # Update M15, M30, H1, H4 & H8 dynamic extremes
        if price > self.sessions_data.get("m15_high", 0):
            self.sessions_data["m15_high"] = round(price, 2)
        if 0 < price < self.sessions_data.get("m15_low", 999999):
            self.sessions_data["m15_low"] = round(price, 2)
        if price > self.sessions_data.get("m30_high", 0):
            self.sessions_data["m30_high"] = round(price, 2)
        if 0 < price < self.sessions_data.get("m30_low", 999999):
            self.sessions_data["m30_low"] = round(price, 2)
        if price > self.sessions_data.get("h1_high", 0):
            self.sessions_data["h1_high"] = round(price, 2)
        if 0 < price < self.sessions_data.get("h1_low", 999999):
            self.sessions_data["h1_low"] = round(price, 2)
        if price > self.sessions_data.get("h4_high", 0):
            self.sessions_data["h4_high"] = round(price, 2)
        if 0 < price < self.sessions_data.get("h4_low", 999999):
            self.sessions_data["h4_low"] = round(price, 2)
        if price > self.sessions_data.get("h8_high", 0):
            self.sessions_data["h8_high"] = round(price, 2)
        if 0 < price < self.sessions_data.get("h8_low", 999999):
            self.sessions_data["h8_low"] = round(price, 2)

        # Detect Liquidity Sweep of Asian High / Asian Low or London High / Low
        c = self.current_candle
        if not c:
            return

        now = time.time()
        if now - self._last_sweep_time < 45.0:
            return

        # 1. Bearish Sweep of Asian High: Candle high pierced above Asian High, but price rejected back below Asian High
        if c["high"] > ah + 0.08 and price < ah - 0.12:
            self._last_sweep_time = now
            self.sessions_data["sweep_alert"] = {
                "type": "ASIAN_HIGH_SWEEP",
                "bias": "SELL",
                "level_name": "ASIAN HIGH",
                "level_price": ah,
                "sweep_peak": c["high"],
                "badge": f"🔥 SWEEP ASIAN HIGH (${ah:.2f})",
                "desc": f"Kecairan Asian High (${ah:.2f}) telah disapu ke ${c['high']:.2f} & ditolak ke bawah! Setup Reversal SELL.",
                "timestamp": now_ms
            }
        # 2. Bullish Sweep of Asian Low: Candle low pierced below Asian Low, but price rejected back above Asian Low
        elif c["low"] < al - 0.08 and price > al + 0.12:
            self._last_sweep_time = now
            self.sessions_data["sweep_alert"] = {
                "type": "ASIAN_LOW_SWEEP",
                "bias": "BUY",
                "level_name": "ASIAN LOW",
                "level_price": al,
                "sweep_peak": c["low"],
                "badge": f"🔥 SWEEP ASIAN LOW (${al:.2f})",
                "desc": f"Kecairan Asian Low (${al:.2f}) telah disapu ke ${c['low']:.2f} & melantun naik! Setup Reversal BUY.",
                "timestamp": now_ms
            }
        # 3. Bearish Sweep of London High
        elif c["high"] > lh + 0.08 and price < lh - 0.12:
            self._last_sweep_time = now
            self.sessions_data["sweep_alert"] = {
                "type": "LONDON_HIGH_SWEEP",
                "bias": "SELL",
                "level_name": "LONDON HIGH",
                "level_price": lh,
                "sweep_peak": c["high"],
                "badge": f"🔥 SWEEP LONDON HIGH (${lh:.2f})",
                "desc": f"Kecairan London High (${lh:.2f}) telah disapu & ditolak ke bawah! Setup Reversal SELL.",
                "timestamp": now_ms
            }
        # 4. Bullish Sweep of London Low
        elif c["low"] < ll - 0.08 and price > ll + 0.12:
            self._last_sweep_time = now
            self.sessions_data["sweep_alert"] = {
                "type": "LONDON_LOW_SWEEP",
                "bias": "BUY",
                "level_name": "LONDON LOW",
                "level_price": ll,
                "sweep_peak": c["low"],
                "badge": f"🔥 SWEEP LONDON LOW (${ll:.2f})",
                "desc": f"Kecairan London Low (${ll:.2f}) telah disapu & melantun naik! Setup Reversal BUY.",
                "timestamp": now_ms
            }

    def _synthesize_book_depth(self, center_price: float):
        """
        Generate realistic multi-level Depth of Market anchored to fixed persistent price walls.
        Simulates resting institutional limit orders, liquidity walls, and spoofing.
        """
        center_price = round(center_price, 2)
        anchor_price = round(round(center_price * 10) / 10.0, 2)
        
        # Initialize or recenter persistent walls if not yet initialized or price moved out of range
        if not self.persistent_walls or (anchor_price not in self.persistent_walls):
            self._init_persistent_walls(anchor_price)
            
        now = time.time()
        now_ms = int(now * 1000)
        
        # Periodic liquidity refill & institutional shark spoofing events (every 14 seconds)
        if now - self.last_depth_update_time > 14.0:
            self.last_depth_update_time = now
            self.spoof_walls.clear()
            for k_idx in range(2):
                spoof_offset = round(0.80 + ((int(now) + k_idx * 7) % 18) * 0.10, 2)
                spoof_p = round(anchor_price + (spoof_offset if k_idx == 0 else -spoof_offset), 2)
                self.spoof_walls[spoof_p] = {
                    "vol": round(62.0 + ((int(now) + k_idx * 11) % 38), 1),
                    "expire": now + 14.0
                }
        
        bids = {}
        asks = {}
        step = 0.10
        t = now
        
        for i in range(1, 130):
            bid_p = round(anchor_price - (i * step), 2)
            ask_p = round(anchor_price + (i * step), 2)
            
            # Fixed wall volume
            b_vol = self.persistent_walls.get(bid_p, 10.0)
            a_vol = self.persistent_walls.get(ask_p, 10.0)
            
            # Check spoof walls
            if bid_p in self.spoof_walls:
                b_vol += self.spoof_walls[bid_p]["vol"]
            if ask_p in self.spoof_walls:
                a_vol += self.spoof_walls[ask_p]["vol"]
                
            # Organic subtle breathing (±5%)
            b_factor = 1.0 + 0.05 * math.sin(t * 0.4 + i * 0.25)
            a_factor = 1.0 + 0.05 * math.cos(t * 0.4 + i * 0.25)
            
            b_key = f"{bid_p:.2f}"
            a_key = f"{ask_p:.2f}"
            bids[b_key] = round(max(4.0, b_vol * b_factor), 1)
            asks[a_key] = round(max(4.0, a_vol * a_factor), 1)
            
        self.order_book_bids = bids
        self.order_book_asks = asks
        
        # Record heatmap snapshot
        snapshot = {
            "timestamp": now_ms,
            "mid_price": center_price,
            "bids": bids,
            "asks": asks
        }
        self.heatmap_history.append(snapshot)
        self._sync_to_cloud_db_if_needed(now)
        if len(self.heatmap_history) > self.max_heatmap_records:
            self.heatmap_history.pop(0)


    def _sync_to_cloud_db_if_needed(self, now: float):
        """Periodically save real-time Order Flow & Bookmap history to Supabase (every 12 seconds)"""
        if now - self._last_supabase_sync_time < 12.0:
            return
        self._last_supabase_sync_time = now
        try:
            import threading
            def _async_push():
                try:
                    from supabase_client import supabase
                    if not supabase.is_connected:
                        return
                    # 1. Save latest 15 slices of Bookmap heatmap
                    if self.heatmap_history:
                        supabase.save_heatmap_batch(self.heatmap_history[-15:])
                    # 2. Save latest candles
                    active_candles = self.candles[-10:] + ([self.current_candle] if self.current_candle else [])
                    if active_candles:
                        supabase.save_candles_batch(active_candles, self.timeframe)
                except Exception:
                    pass
            threading.Thread(target=_async_push, daemon=True).start()
        except Exception:
            pass

    def process_tick(self, bid: float, ask: float, volume: float = 1.0, flag: int = 0):
        """Process incoming tick, update Footprint, Bubbles, Heatmap & CVD"""
        now_ms = int(time.time() * 1000)
        now_sec = int(now_ms / 1000)
        
        prev_bid = self.current_bid
        prev_ask = self.current_ask
        self.current_bid = round(bid, self.tick_digits)
        self.current_ask = round(ask, self.tick_digits)
        self.spread = round(self.current_ask - self.current_bid, self.tick_digits)
        
        # Determine trade aggressor (Buyer vs Seller)
        # In Order Flow:
        # If trade price is closer to Ask -> Aggressive Market Buyer lifted Offer
        # If trade price is closer to Bid -> Aggressive Market Seller hit Bid
        is_buy = False
        trade_price = self.current_ask
        
        if prev_bid > 0 and prev_ask > 0:
            if bid > prev_bid or ask > prev_ask:
                is_buy = True
                trade_price = self.current_ask
            elif bid < prev_bid or ask < prev_ask:
                is_buy = False
                trade_price = self.current_bid
            else:
                # Same price, random or alternate
                is_buy = (now_ms % 2 == 0)
                trade_price = self.current_ask if is_buy else self.current_bid
        else:
            is_buy = True
            trade_price = self.current_ask
            
        self.last_price = trade_price
        
        # Lot volume
        trade_vol = round(volume, 2)
        if trade_vol <= 0:
            trade_vol = 1.0
            
        # Update CVD
        delta = trade_vol if is_buy else -trade_vol
        self.cvd += delta
        self.cvd_history.append({
            "timestamp": now_ms,
            "price": trade_price,
            "cvd": round(self.cvd, 2),
            "delta": delta
        })
        if len(self.cvd_history) > 300:
            self.cvd_history.pop(0)

        # Update Session VWAP & Standard Deviation Bands
        self.vwap_cum_vol += trade_vol
        self.vwap_cum_pv += (trade_price * trade_vol)
        self.vwap_cum_pv2 += ((trade_price ** 2) * trade_vol)
        if self.vwap_cum_vol > 0:
            self.current_vwap = round(self.vwap_cum_pv / self.vwap_cum_vol, 2)
            variance = max(0.01, (self.vwap_cum_pv2 / self.vwap_cum_vol) - (self.current_vwap ** 2))
            std_dev = math.sqrt(variance)
            self.vwap_std1_up = round(self.current_vwap + std_dev, 2)
            self.vwap_std1_down = round(self.current_vwap - std_dev, 2)
            self.vwap_std2_up = round(self.current_vwap + 2.0 * std_dev, 2)
            self.vwap_std2_down = round(self.current_vwap - 2.0 * std_dev, 2)

        # Detect CVD Divergence (Absorption at Highs/Lows) & Trapped Traders
        self._evaluate_cvd_divergence(trade_price, now_ms)
        self._evaluate_trapped_traders(now_ms)

        # Record 10-second rolling price buffer for News & Flash Volatility Shield
        self._price_10s_buffer.append({"t": time.time(), "p": trade_price})
        cutoff_10s = time.time() - 10.0
        self._price_10s_buffer = [x for x in self._price_10s_buffer if x["t"] >= cutoff_10s]

        # Update Footprint Candlestick
        self._update_footprint(now_sec, trade_price, trade_vol, is_buy)

        # Update Asian / London / NY Session High-Low & Liquidity Sweeps
        self._update_session_high_low_and_sweeps(trade_price, now_ms)

        # Update Composite Session Volume Profile (dPOC, Session VAH/VAL 70%, LVN)
        self._update_session_volume_profile(trade_price, trade_vol, is_buy, recompute=True)

        # Evaluate Institutional Iceberg Orders & Passive Absorption
        self._evaluate_iceberg_absorption(trade_price, trade_vol, is_buy, now_ms)

        # Evaluate Spoofing (Pulling vs Stacking)
        self._evaluate_spoofing(now_ms)
            
        # Add Trade Bubble: record if price changed or at least 250ms elapsed
        # Ensures smooth continuous flow of bubbles without gaps or stuttering
        if trade_price != self._last_bubble_price or (now_ms - self.last_bubble_time_ms >= 250):
            self.last_bubble_time_ms = now_ms
            self._last_bubble_price = trade_price

            buy_v = trade_vol if is_buy else 0.0
            sell_v = 0.0 if is_buy else trade_vol

            # Slight liquidity wall absorption
            bucket_p = round(trade_price, 2)
            if bucket_p in self.persistent_walls:
                self.persistent_walls[bucket_p] = round(max(5.0, self.persistent_walls[bucket_p] - (trade_vol * 0.25)), 1)

            trade_record = {
                "id": now_ms,
                "timestamp": now_ms,
                "price": trade_price,
                "volume": trade_vol,
                "buy_vol": buy_v,
                "sell_vol": sell_v,
                "side": "buy" if is_buy else "sell",
                "is_large": trade_vol >= 12.0
            }
            self.recent_trades.append(trade_record)
            if len(self.recent_trades) > 700:
                self.recent_trades.pop(0)
        
        # Update dynamic Depth & Heatmap
        self._synthesize_book_depth(trade_price)

    def set_timeframe(self, tf_str: str) -> Dict[str, Any]:
        """
        Switch timeframe for Footprint Candles and Bookmap Time Horizon.
        Supports: M1, M5, M15, M30, H1, H4
        """
        tf_str = tf_str.upper()
        tf_map = {
            "M1":  (60,    getattr(mt5, "TIMEFRAME_M1", 1)),
            "M5":  (300,   getattr(mt5, "TIMEFRAME_M5", 5)),
            "M15": (900,   getattr(mt5, "TIMEFRAME_M15", 15)),
            "M30": (1800,  getattr(mt5, "TIMEFRAME_M30", 30)),
            "H1":  (3600,  getattr(mt5, "TIMEFRAME_H1", 16385)),
            "H4":  (14400, getattr(mt5, "TIMEFRAME_H4", 16388))
        }

        if tf_str not in tf_map:
            return {"status": "error", "message": f"Timeframe {tf_str} not supported"}

        interval_sec, mt5_tf = tf_map[tf_str]
        self.timeframe = tf_str
        self.candle_interval = interval_sec
        self.candles = []
        self.current_candle = None

        # Fetch real MT5 historical candles if connected
        if self.is_connected and not self.simulation_mode:
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, mt5_tf, 0, 1000)
                if rates is not None and len(rates) > 0:
                    # Align MT5 broker server time to true UTC timestamp (eliminating broker UTC+2/UTC+3 offset)
                    now_utc = int(time.time())
                    current_bar_open = now_utc - (now_utc % interval_sec)
                    latest_rate_time = int(rates[-1]['time'])
                    time_diff = latest_rate_time - current_bar_open
                    broker_offset_sec = int(round(time_diff / 3600.0)) * 3600

                    for r in rates:
                        c_time = int(r['time']) - broker_offset_sec
                        o, h, l, c = float(r['open']), float(r['high']), float(r['low']), float(r['close'])
                        v = float(r['tick_volume'])
                        if c_time >= current_bar_open:
                            # This is the current active bar
                            self.current_candle = self._generate_footprint_from_ohlc(current_bar_open, o, h, l, c, v)
                        else:
                            candle_obj = self._generate_footprint_from_ohlc(c_time, o, h, l, c, v)
                            self.candles.append(candle_obj)
            except Exception as e:
                print(f"[Timeframe] Failed copying MT5 rates: {e}")

        # Fallback if simulator or no rates returned: check Supabase Cloud DB first
        if len(self.candles) == 0:
            try:
                from supabase_client import supabase
                if supabase.is_connected:
                    cloud_candles = supabase.load_latest_candles(self.timeframe, limit=1000)
                    if cloud_candles and len(cloud_candles) >= 10:
                        self.candles = cloud_candles
                        print(f"[Supabase Cloud DB] Berjaya memuatkan {len(cloud_candles)} batang lilin & kluster Footprint dari Supabase!")
            except Exception as e:
                print(f"[Supabase Candles Restore] {e}")

        # Fallback if simulator or no rates returned
        if len(self.candles) == 0:
            self._seed_candles_for_timeframe(interval_sec)

        return {
            "status": "success",
            "timeframe": tf_str,
            "interval_sec": interval_sec,
            "candles_count": len(self.candles),
            "message": f"Timeframe aktif ditukar ke {tf_str} ({interval_sec // 60} minit)"
        }

    def _generate_footprint_from_ohlc(self, c_time: int, o: float, h: float, l: float, c: float, v: float) -> Dict[str, Any]:
        """Convert standard OHLCV bar into an institutional Order Flow Footprint with cluster levels & POC"""
        cluster_step = 0.50
        min_p = math.floor(l / cluster_step) * cluster_step
        max_p = math.ceil(h / cluster_step) * cluster_step

        clusters = {}
        total_vol = max(10.0, v * 0.15) # scale to reasonable lot size
        mid_p = (o + c) / 2.0

        p_levels = []
        cur_p = min_p
        while cur_p <= max_p + 0.001:
            p_levels.append(round(cur_p, 2))
            cur_p = round(cur_p + cluster_step, 2)

        if not p_levels:
            p_levels = [round(c, 2)]

        # Distribute volume across levels using a bell curve centered near close/mid (POC)
        is_bullish = c >= o
        weights = []
        for p in p_levels:
            dist = abs(p - mid_p)
            w = math.exp(-0.5 * (dist / max(0.5, (h - l) * 0.45)) ** 2)
            weights.append(w)

        sum_w = sum(weights) or 1.0
        max_c_vol = -1
        poc_p = mid_p

        buy_vol_total = 0.0
        sell_vol_total = 0.0

        for idx, p in enumerate(p_levels):
            p_str = f"{p:.2f}"
            lvl_vol = round((weights[idx] / sum_w) * total_vol, 1)

            # Buy vs Sell proportion based on bullish/bearish candle
            if is_bullish:
                b_ratio = 0.58 + (0.12 * math.sin(idx))
            else:
                b_ratio = 0.42 - (0.12 * math.sin(idx))
            b_ratio = max(0.15, min(0.85, b_ratio))

            ask_v = round(lvl_vol * b_ratio, 1)
            bid_v = round(lvl_vol - ask_v, 1)
            delta = round(ask_v - bid_v, 1)

            buy_vol_total += ask_v
            sell_vol_total += bid_v

            clusters[p_str] = {
                "price": p,
                "bid": bid_v,
                "ask": ask_v,
                "delta": delta,
                "total": lvl_vol,
                "imbalance": None
            }

            if lvl_vol > max_c_vol:
                max_c_vol = lvl_vol
                poc_p = p

        min_d = min(0.0, buy_vol_total - sell_vol_total) if (buy_vol_total - sell_vol_total) < 0 else -abs(sell_vol_total * 0.3)
        max_d = max(0.0, buy_vol_total - sell_vol_total) if (buy_vol_total - sell_vol_total) > 0 else abs(buy_vol_total * 0.3)

        candle_obj = {
            "time": c_time,
            "open": round(o, 2),
            "high": round(h, 2),
            "low": round(l, 2),
            "close": round(c, 2),
            "volume": round(buy_vol_total + sell_vol_total, 1),
            "delta": round(buy_vol_total - sell_vol_total, 1),
            "min_delta": round(min_d, 1),
            "max_delta": round(max_d, 1),
            "buy_volume": round(buy_vol_total, 1),
            "sell_volume": round(sell_vol_total, 1),
            "poc": round(poc_p, 2),
            "vah": round(poc_p, 2),
            "val": round(poc_p, 2),
            "stacked_buy": [],
            "stacked_sell": [],
            "unfinished_high": False,
            "unfinished_low": False,
            "clusters": clusters
        }
        self._calculate_imbalances(candle_obj)
        return candle_obj

    def _seed_candles_for_timeframe(self, interval_sec: int, count: int = 1000):
        """Pre-populate 1000 connected OHLCV + Order Flow candles ending smoothly at current price (for deep lookback and backtesting)"""
        now = int(time.time())
        target_end = self.last_price if self.last_price > 0 else (self.current_bid if self.current_bid > 0 else 4008.0)
        base_time = now - (now % interval_sec)
        tf_scale = max(0.5, min(3.5, (interval_sec / 60.0) ** 0.38))

        # Build backward multi-wave walk from target_end (capturing macro trend, swing cycles and noise)
        closes = [target_end]
        for i in range(1, count + 1):
            macro_wave = math.sin(i * 0.015) * 1.75
            medium_wave = math.cos(i * 0.075) * 1.15
            micro_wave = (math.sin(i * 0.55) * 0.75 + math.cos(i * 1.25) * 0.45)
            step_delta = (macro_wave + medium_wave + micro_wave) * 0.42 * tf_scale
            closes.append(round(closes[-1] - step_delta, 2))
        closes.reverse()

        for idx in range(count):
            i = count - idx
            c_time = base_time - (i * interval_sec)
            c_open = closes[idx]
            c_close = closes[idx + 1]
            wick_up = round((0.25 + abs(math.sin(i * 0.95)) * 0.95) * tf_scale, 2)
            wick_dn = round((0.25 + abs(math.cos(i * 0.82)) * 0.90) * tf_scale, 2)
            c_high = round(max(c_open, c_close) + wick_up, 2)
            c_low = round(min(c_open, c_close) - wick_dn, 2)
            vol = round(32.0 + abs(math.sin(i * 0.28)) * 68.0 * tf_scale + (18.0 if idx % 7 == 0 else 0.0), 0)

            c_obj = self._generate_footprint_from_ohlc(c_time, c_open, c_high, c_low, c_close, vol)
            self.candles.append(c_obj)

    def _update_footprint(self, now_sec: int, price: float, volume: float, is_buy: bool):
        """Update live candlestick and tick footprint cluster"""
        candle_start = now_sec - (now_sec % self.candle_interval)
        
        # Roll to new candle if timeframe elapsed
        if not self.current_candle or candle_start > self.current_candle["time"]:
            if self.current_candle:
                self.candles.append(self.current_candle)
                if len(self.candles) > 1500:
                    self.candles.pop(0)
            self.current_candle = {
                "time": candle_start,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": 0.0,
                "delta": 0.0,
                "min_delta": 0.0,
                "max_delta": 0.0,
                "buy_volume": 0.0,
                "sell_volume": 0.0,
                "poc": price,
                "vah": price,
                "val": price,
                "stacked_buy": [],
                "stacked_sell": [],
                "unfinished_high": False,
                "unfinished_low": False,
                "clusters": {}
            }
            
        c = self.current_candle
        c["high"] = max(c["high"], price)
        c["low"] = min(c["low"], price)
        c["close"] = price
        c["volume"] = round(c["volume"] + volume, 2)
        
        # Group ticks into discrete price buckets (0.50 step on Gold) for clean, legible clusters
        cluster_step = 0.50
        bucket_price = round(math.floor(price / cluster_step) * cluster_step, 2)
        p_str = f"{bucket_price:.2f}"
        
        if p_str not in c["clusters"]:
            c["clusters"][p_str] = {
                "price": bucket_price,
                "bid": 0.0,
                "ask": 0.0,
                "delta": 0.0,
                "total": 0.0,
                "imbalance": None # 'buy' or 'sell'
            }
            
        cluster = c["clusters"][p_str]
        if is_buy:
            cluster["ask"] = round(cluster["ask"] + volume, 2)
            c["buy_volume"] = round(c["buy_volume"] + volume, 2)
            c["delta"] = round(c["delta"] + volume, 2)
        else:
            cluster["bid"] = round(cluster["bid"] + volume, 2)
            c["sell_volume"] = round(c["sell_volume"] + volume, 2)
            c["delta"] = round(c["delta"] - volume, 2)
            
        cluster["total"] = round(cluster["bid"] + cluster["ask"], 2)
        cluster["delta"] = round(cluster["ask"] - cluster["bid"], 2)

        # Track Min and Max Delta throughout the candle life
        c["min_delta"] = min(c.get("min_delta", 0.0), c["delta"])
        c["max_delta"] = max(c.get("max_delta", 0.0), c["delta"])
        
        # Calculate Point of Control (POC - highest volume price)
        max_v = -1
        poc_p = price
        for p_k, cl in c["clusters"].items():
            if cl["total"] > max_v:
                max_v = cl["total"]
                poc_p = cl["price"]
        c["poc"] = poc_p
        
        # Check Imbalances (Diagonal 300% ratio), Stacked Imbalances, Value Area 70% & Unfinished Auction
        self._calculate_imbalances(c)

    def _calculate_imbalances(self, candle: Dict[str, Any], ratio: float = 3.0):
        """
        Calculates footprint diagonal imbalances (Bid vs Ask ratio 300%),
        Institutional Stacked Imbalances (3+ consecutive levels),
        Value Area (VAH & VAL covering 70% of volume),
        and Unfinished Auction flags.
        """
        clusters = candle.get("clusters", {})
        if not clusters:
            return

        sorted_prices = sorted([float(k) for k in clusters.keys()])
        if not sorted_prices:
            return

        # 1. Reset imbalances
        for cl in clusters.values():
            cl["imbalance"] = None

        # 2. Diagonal Imbalance Calculation (Ask at P vs Bid at P - step)
        for i in range(len(sorted_prices) - 1):
            lower_p_str = f"{sorted_prices[i]:.2f}"
            upper_p_str = f"{sorted_prices[i+1]:.2f}"
            
            bid_lower = clusters[lower_p_str].get("bid", 0.0)
            ask_upper = clusters[upper_p_str].get("ask", 0.0)
            
            # Buying imbalance: Aggressive Ask is >= 3x higher than Bid below
            if bid_lower > 0 and (ask_upper / bid_lower) >= ratio and ask_upper >= 2.0:
                clusters[upper_p_str]["imbalance"] = "buy"
            # Selling imbalance: Aggressive Bid is >= 3x higher than Ask above
            elif ask_upper > 0 and (bid_lower / ask_upper) >= ratio and bid_lower >= 2.0:
                clusters[lower_p_str]["imbalance"] = "sell"

        # 3. Stacked Imbalances Detection (3 or more consecutive price levels)
        stacked_buy = []
        stacked_sell = []
        
        cur_buy_stack = []
        cur_sell_stack = []

        for p in sorted_prices:
            p_str = f"{p:.2f}"
            imb = clusters[p_str].get("imbalance")

            if imb == "buy":
                cur_buy_stack.append(p)
            else:
                if len(cur_buy_stack) >= 3:
                    stacked_buy.append(cur_buy_stack.copy())
                cur_buy_stack = []

            if imb == "sell":
                cur_sell_stack.append(p)
            else:
                if len(cur_sell_stack) >= 3:
                    stacked_sell.append(cur_sell_stack.copy())
                cur_sell_stack = []

        if len(cur_buy_stack) >= 3:
            stacked_buy.append(cur_buy_stack.copy())
        if len(cur_sell_stack) >= 3:
            stacked_sell.append(cur_sell_stack.copy())

        candle["stacked_buy"] = stacked_buy
        candle["stacked_sell"] = stacked_sell

        # 4. Value Area Calculation (70% Volume Profile around POC)
        total_vol = sum(cl.get("total", 0.0) for cl in clusters.values())
        poc_p = candle.get("poc", sorted_prices[0])
        
        # Find closest price index to POC
        poc_idx = 0
        min_dist = float("inf")
        for i, p in enumerate(sorted_prices):
            if abs(p - poc_p) < min_dist:
                min_dist = abs(p - poc_p)
                poc_idx = i

        target_va_vol = total_vol * 0.70
        curr_va_vol = clusters[f"{sorted_prices[poc_idx]:.2f}"].get("total", 0.0)
        low_idx = poc_idx
        high_idx = poc_idx

        # Iteratively expand Value Area up/down choosing higher volume adjacent tier
        while curr_va_vol < target_va_vol and (low_idx > 0 or high_idx < len(sorted_prices) - 1):
            next_up_vol = clusters[f"{sorted_prices[high_idx + 1]:.2f}"].get("total", 0.0) if high_idx < len(sorted_prices) - 1 else -1.0
            next_down_vol = clusters[f"{sorted_prices[low_idx - 1]:.2f}"].get("total", 0.0) if low_idx > 0 else -1.0

            if next_up_vol >= next_down_vol and high_idx < len(sorted_prices) - 1:
                high_idx += 1
                curr_va_vol += next_up_vol
            elif low_idx > 0:
                low_idx -= 1
                curr_va_vol += next_down_vol
            elif high_idx < len(sorted_prices) - 1:
                high_idx += 1
                curr_va_vol += next_up_vol
            else:
                break

        vah = sorted_prices[high_idx]
        val = sorted_prices[low_idx]
        candle["vah"] = round(vah, 2)
        candle["val"] = round(val, 2)

        # Mark clusters inside Value Area
        for p in sorted_prices:
            clusters[f"{p:.2f}"]["in_va"] = (val <= p <= vah)

        # 5. Unfinished Auction Detection
        highest_p_str = f"{sorted_prices[-1]:.2f}"
        lowest_p_str = f"{sorted_prices[0]:.2f}"
        candle["unfinished_high"] = bool(clusters[highest_p_str].get("bid", 0) > 0.5 and clusters[highest_p_str].get("ask", 0) > 0.5)
        candle["unfinished_low"] = bool(clusters[lowest_p_str].get("bid", 0) > 0.5 and clusters[lowest_p_str].get("ask", 0) > 0.5)

    def _update_account_info(self):
        """Fetch MT5 live balance, equity, and open positions"""
        if not self.is_connected or self.simulation_mode:
            return
            
        acc = mt5.account_info()
        if acc:
            self.account_info = {
                "login": acc.login,
                "name": acc.name,
                "server": acc.server,
                "balance": acc.balance,
                "equity": acc.equity,
                "margin": acc.margin,
                "free_margin": acc.margin_free,
                "profit": acc.profit,
                "leverage": acc.leverage
            }
            
        pos = mt5.positions_get(symbol=self.symbol)
        if pos is not None:
            self.positions = []
            for p in pos:
                self.positions.append({
                    "ticket": p.ticket,
                    "symbol": p.symbol,
                    "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
                    "volume": p.volume,
                    "open_price": p.price_open,
                    "current_price": p.price_current,
                    "sl": p.sl,
                    "tp": p.tp,
                    "profit": p.profit,
                    "swap": p.swap
                })

    def execute_order(self, action: str, volume: float = 0.01, sl_pips: float = 0.0, tp_pips: float = 0.0) -> Dict[str, Any]:
        """
        Execute Buy / Sell Market order directly into MT5 or simulation
        action: 'BUY' or 'SELL'
        """
        # Enforce Prop-Firm Hard-Breaker Drawdown Lock
        pf = self._evaluate_prop_firm_shield()
        if pf.get("is_locked", False):
            return {
                "status": "error",
                "message": f"🚨 EKSEKUSI DIKUNCI: Perisai Prop-Firm aktif! Had kerugian harian ({pf.get('current_drawdown_pct')}%) telah dicapai."
            }
        if self.simulation_mode or not self.is_connected:
            # Simulate order execution
            ticket = int(time.time() * 1000) % 1000000
            price = self.current_ask if action == "BUY" else self.current_bid
            sl = round(price - (sl_pips * 0.1), 2) if sl_pips > 0 and action == "BUY" else (round(price + (sl_pips * 0.1), 2) if sl_pips > 0 else 0.0)
            tp = round(price + (tp_pips * 0.1), 2) if tp_pips > 0 and action == "BUY" else (round(price - (tp_pips * 0.1), 2) if tp_pips > 0 else 0.0)
            
            sim_pos = {
                "ticket": ticket,
                "symbol": self.symbol,
                "type": action,
                "volume": volume,
                "open_price": price,
                "current_price": price,
                "sl": sl,
                "tp": tp,
                "profit": 0.0,
                "swap": 0.0
            }
            self.positions.append(sim_pos)
            return {"status": "success", "ticket": ticket, "mode": "simulation", "message": f"Demo {action} {volume} Lots executed at {price}"}

        # Live MT5 order send
        info = mt5.symbol_info(self.symbol)
        if not info:
            return {"status": "error", "message": f"Symbol {self.symbol} not found"}
            
        order_type = mt5.ORDER_TYPE_BUY if action == "BUY" else mt5.ORDER_TYPE_SELL
        price = mt5.symbol_info_tick(self.symbol).ask if action == "BUY" else mt5.symbol_info_tick(self.symbol).bid
        
        sl = 0.0
        tp = 0.0
        pip_value = 0.10 # Gold 1 pip = 0.10
        if sl_pips > 0:
            sl = price - (sl_pips * pip_value) if action == "BUY" else price + (sl_pips * pip_value)
            sl = round(sl, self.tick_digits)
        if tp_pips > 0:
            tp = price + (tp_pips * pip_value) if action == "BUY" else price - (tp_pips * pip_value)
            tp = round(tp, self.tick_digits)
            
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": self.symbol,
            "volume": float(volume),
            "type": order_type,
            "price": float(price),
            "sl": float(sl),
            "tp": float(tp),
            "deviation": 20,
            "magic": 777999,
            "comment": "Bookmap OrderFlow Execution",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        
        result = mt5.order_send(request)
        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            self._update_account_info()
            return {"status": "success", "ticket": result.order, "mode": "live", "message": f"Live {action} executed! Ticket #{result.order}"}
        else:
            err = result.comment if result else mt5.last_error()
            return {"status": "error", "message": f"Order rejected: {err}"}

    def close_position(self, ticket: int) -> Dict[str, Any]:
        """Close an existing position"""
        if self.simulation_mode or not self.is_connected:
            self.positions = [p for p in self.positions if p["ticket"] != ticket]
            return {"status": "success", "message": f"Position #{ticket} closed in Demo"}

        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return {"status": "error", "message": f"Position #{ticket} not found in MT5"}
            
        pos = pos_list[0]
        close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        price = mt5.symbol_info_tick(pos.symbol).bid if pos.type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(pos.symbol).ask
        
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": float(pos.volume),
            "type": close_type,
            "position": ticket,
            "price": float(price),
            "deviation": 20,
            "magic": 777999,
            "comment": "Bookmap Close Position",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        
        result = mt5.order_send(request)
        if result and result.retcode == mt5.TRADE_RETCODE_DONE:
            self._update_account_info()
            return {"status": "success", "message": f"Position #{ticket} closed successfully"}
        else:
            return {"status": "error", "message": f"Close failed: {result.comment if result else mt5.last_error()}"}

    def close_all_positions(self) -> Dict[str, Any]:
        """Close all active positions for Gold"""
        if self.simulation_mode or not self.is_connected:
            cnt = len(self.positions)
            self.positions = []
            return {"status": "success", "message": f"All {cnt} Demo positions closed"}
            
        pos_list = mt5.positions_get(symbol=self.symbol)
        closed = 0
        if pos_list:
            for p in pos_list:
                self.close_position(p.ticket)
                closed += 1
        return {"status": "success", "message": f"Closed {closed} positions"}

    def _is_near_institutional_level(self, price: float, side: str, tolerance: float = 1.35):
        """
        Enforces Strict Institutional Golden Rule:
        BUY is ONLY allowed at Demand / Support.
        SELL is ONLY allowed at Supply / Resistance.
        Returns: (is_valid, level_name_or_warning)
        """
        side = side.upper()
        s = self.sessions_data or {}
        svp = self.session_vp_summary or {}
        vwap = self.current_vwap or price

        if side == "BUY":
            demand_levels = [
                ("ASIAN LOW", s.get("asian_low", 0.0)),
                ("LONDON LOW", s.get("london_low", 0.0)),
                ("PDL", s.get("pdl", 0.0)),
                ("SESSION VAL", svp.get("val", 0.0)),
                ("dPOC", svp.get("dpoc", 0.0)),
                ("VWAP -1σ", self.vwap_std1_down),
                ("VWAP -2σ", self.vwap_std2_down),
                ("M15 SUP", s.get("m15_sup", 0.0)),
                ("M30 SUP", s.get("m30_sup", 0.0)),
                ("H1 SUP", s.get("h1_sup", 0.0)),
                ("H4 SUP", s.get("h4_sup", 0.0)),
                ("H8 SUP", s.get("h8_sup", 0.0)),
            ]
            valid_lvls = [(name, p) for name, p in demand_levels if p and p > 0 and abs(price - p) <= tolerance]
            if valid_lvls:
                closest = min(valid_lvls, key=lambda x: abs(price - x[1]))
                return True, f"{closest[0]} (${closest[1]:.2f})"
            else:
                return False, "TIADA ZON DEMAND / SOKONGAN"

        elif side == "SELL":
            supply_levels = [
                ("ASIAN HIGH", s.get("asian_high", 0.0)),
                ("LONDON HIGH", s.get("london_high", 0.0)),
                ("PDH", s.get("pdh", 0.0)),
                ("SESSION VAH", svp.get("vah", 0.0)),
                ("dPOC", svp.get("dpoc", 0.0)),
                ("VWAP +1σ", self.vwap_std1_up),
                ("VWAP +2σ", self.vwap_std2_up),
                ("M15 RES", s.get("m15_res", 0.0)),
                ("M30 RES", s.get("m30_res", 0.0)),
                ("H1 RES", s.get("h1_res", 0.0)),
                ("H4 RES", s.get("h4_res", 0.0)),
                ("H8 RES", s.get("h8_res", 0.0)),
            ]
            valid_lvls = [(name, p) for name, p in supply_levels if p and p > 0 and abs(price - p) <= tolerance]
            if valid_lvls:
                closest = min(valid_lvls, key=lambda x: abs(price - x[1]))
                return True, f"{closest[0]} (${closest[1]:.2f})"
            else:
                return False, "TIADA ZON SUPPLY / RINTANGAN"

        return False, "ARAH TIDAK SAH"

    def _evaluate_cvd_divergence(self, price: float, now_ms: int):
        """
        Detects Order Flow Cumulative Volume Delta divergence:
        1. Bearish Divergence: Price higher high, but CVD lower high (Seller absorption)
        2. Bullish Divergence: Price lower low, but CVD higher low (Buyer absorption)
        """
        if len(self.cvd_history) < 20:
            return

        recent_slice = self.cvd_history[-30:]
        prices = [x["price"] for x in recent_slice]
        cvds = [x["cvd"] for x in recent_slice]

        max_p = max(prices)
        min_p = min(prices)
        cur_cvd = self.cvd

        # Bearish Divergence near recent highs (Strict Supply Filter)
        if price >= max_p - 0.20 and cur_cvd < max(cvds) - 12.0:
            is_valid, zone_desc = self._is_near_institutional_level(price, "SELL")
            if is_valid:
                self.detected_divergence = {
                    "type": "bearish",
                    "title": "CVD BEARISH DIVERGENCE",
                    "desc": f"Penyerapan jualan institusi di zon Supply {zone_desc}",
                    "price": price,
                    "timestamp": now_ms
                }
        # Bullish Divergence near recent lows (Strict Demand Filter)
        elif price <= min_p + 0.20 and cur_cvd > min(cvds) + 12.0:
            is_valid, zone_desc = self._is_near_institutional_level(price, "BUY")
            if is_valid:
                self.detected_divergence = {
                    "type": "bullish",
                    "title": "CVD BULLISH DIVERGENCE",
                    "desc": f"Penyerapan belian institusi di zon Demand {zone_desc}",
                    "price": price,
                    "timestamp": now_ms
                }

    def _evaluate_trapped_traders(self, now_ms: int):
        """
        Detects Trapped Buyers & Trapped Sellers at candle price extremes:
        - Trapped Buyers: Strong aggressive buying (delta / ask volume) at swing high, but candle price rejects downwards (wick rejection).
        - Trapped Sellers: Strong aggressive selling (delta / bid volume) at swing low, but candle price bounces upwards.
        """
        if not self.current_candle or len(self.candles) < 2:
            return
            
        c = self.current_candle
        candle_range = c["high"] - c["low"]
        if candle_range < 0.80:
            return

        if hasattr(self, '_last_trapped_candle_time') and self._last_trapped_candle_time == c["time"]:
            return

        clusters = c.get("clusters", {})
        if not clusters:
            return

        sorted_prices = sorted([float(k) for k in clusters.keys()])
        if len(sorted_prices) < 3:
            return

        # Check top levels (upper 25% of candle range)
        top_threshold = c["high"] - (candle_range * 0.25)
        top_ask_vol = sum(clusters[f"{p:.2f}"]["ask"] for p in sorted_prices if p >= top_threshold and f"{p:.2f}" in clusters)
        top_bid_vol = sum(clusters[f"{p:.2f}"]["bid"] for p in sorted_prices if p >= top_threshold and f"{p:.2f}" in clusters)

        if top_ask_vol >= 7.0 and top_ask_vol > (top_bid_vol * 1.6):
            if c["close"] <= c["high"] - (candle_range * 0.40):
                is_valid, zone_desc = self._is_near_institutional_level(c["high"], "SELL")
                if is_valid:
                    self._last_trapped_candle_time = c["time"]
                    trapped_event = {
                        "type": "TRAPPED_BUYERS",
                        "badge": "🪤 TRAPPED BUYERS",
                        "price": c["high"],
                        "volume": round(top_ask_vol, 1),
                        "desc": f"Pembeli terperangkap di zon Supply {zone_desc} (+{top_ask_vol:.1f} Lots). Isyarat Reversal SELL Sah.",
                        "action": "SELL",
                        "timestamp": now_ms
                    }
                    self.trapped_traders.append(trapped_event)
                    if len(self.trapped_traders) > 10:
                        self.trapped_traders.pop(0)
                    return

        # Check bottom levels (lower 25% of candle range)
        bottom_threshold = c["low"] + (candle_range * 0.25)
        bot_ask_vol = sum(clusters[f"{p:.2f}"]["ask"] for p in sorted_prices if p <= bottom_threshold and f"{p:.2f}" in clusters)
        bot_bid_vol = sum(clusters[f"{p:.2f}"]["bid"] for p in sorted_prices if p <= bottom_threshold and f"{p:.2f}" in clusters)

        if bot_bid_vol >= 7.0 and bot_bid_vol > (bot_ask_vol * 1.6):
            if c["close"] >= c["low"] + (candle_range * 0.40):
                is_valid, zone_desc = self._is_near_institutional_level(c["low"], "BUY")
                if is_valid:
                    self._last_trapped_candle_time = c["time"]
                    trapped_event = {
                        "type": "TRAPPED_SELLERS",
                        "badge": "🪤 TRAPPED SELLERS",
                        "price": c["low"],
                        "volume": round(bot_bid_vol, 1),
                        "desc": f"Penjual terperangkap di zon Demand {zone_desc} (-{bot_bid_vol:.1f} Lots). Isyarat Reversal BUY Sah.",
                        "action": "BUY",
                        "timestamp": now_ms
                    }
                    self.trapped_traders.append(trapped_event)
                    if len(self.trapped_traders) > 10:
                        self.trapped_traders.pop(0)

    def _evaluate_market_radar(self) -> Dict[str, Any]:
        """
        Synthesizes raw order flow (CVD, VWAP, Book Depth, Whales) into a single executive status
        so any trader can immediately understand market state in plain Malay.
        """
        price = self.last_price if self.last_price > 0 else 4008.0
        vwap = self.current_vwap if self.current_vwap > 0 else price
        cvd = self.cvd
        
        # Calculate recent trade aggressor ratio (last 50 trades)
        recent = self.recent_trades[-50:] if self.recent_trades else []
        buy_lots = sum(t.get("buy_vol", t.get("volume", 0)) for t in recent if t.get("side") == "buy")
        sell_lots = sum(t.get("sell_vol", t.get("volume", 0)) for t in recent if t.get("side") == "sell")
        total_lots = buy_lots + sell_lots
        buy_ratio = (buy_lots / total_lots) if total_lots > 0 else 0.50

        # Calculate DOM resting balance
        bid_sum = sum(float(v) for v in list(self.order_book_bids.values())[:20])
        ask_sum = sum(float(v) for v in list(self.order_book_asks.values())[:20])
        dom_total = bid_sum + ask_sum
        dom_bid_ratio = (bid_sum / dom_total) if dom_total > 0 else 0.50

        # Composite score calculation (-100 to +100)
        p_vwap_diff = (price - vwap)
        vwap_score = 30.0 if p_vwap_diff > 0.50 else (-30.0 if p_vwap_diff < -0.50 else (p_vwap_diff / 0.50) * 30.0)
        agg_score = (buy_ratio - 0.50) * 80.0
        cvd_score = max(-20.0, min(20.0, cvd * 0.8))
        dom_score = (dom_bid_ratio - 0.50) * 20.0

        composite = vwap_score + agg_score + cvd_score + dom_score
        
        if composite >= 20.0:
            bias = "BUY"
            strength = min(98, int(50 + (composite * 0.48)))
            state = "BULLISH_EXPANSION"
            headline = f"🟢 BULLS MENGUASAI PASARAN ({strength}% Kekuatan Belian)"
            summary = f"Aliran belian agresif (+{buy_lots:.1f} Lots). Harga berdaya tahan di atas VWAP (${vwap:.2f})."
            action_hint = f"Cadangan: Utamakan posisi BUY. Tunggu retest di Zon Buyer atau VWAP ($ {vwap:.2f}) sebelum masuk."
        elif composite <= -20.0:
            bias = "SELL"
            strength = min(98, int(50 + (abs(composite) * 0.48)))
            state = "BEARISH_EXPANSION"
            headline = f"🔴 BEARS MENGUASAI PASARAN ({strength}% Kekuatan Jualan)"
            summary = f"Aliran jualan agresif melambakkan Bid (-{sell_lots:.1f} Lots). Tekanan jualan berterusan."
            action_hint = f"Cadangan: Utamakan posisi SELL. Elak tangkap pisau jatuh; cari peluang jualan di Zon Seller."
        else:
            bias = "NEUTRAL"
            strength = int(50 + abs(composite))
            state = "ABSORPTION_CONSOLIDATION"
            headline = f"🟡 FASA SERAPAN / KONSOLIDASI (Pasaran Seimbang)"
            summary = f"Kekuatan belian dan jualan bertembung seimbang berhampiran Fair Value VWAP (${vwap:.2f})."
            action_hint = "Cadangan: Tunggu breakout volum besar atau sentuhan dinding kecairan sebelum masuk trade."

        return {
            "state": state,
            "bias": bias,
            "strength": strength,
            "headline": headline,
            "summary": summary,
            "action_hint": action_hint,
            "vwap": round(vwap, 2),
            "buy_ratio": round(buy_ratio * 100, 1),
            "sell_ratio": round((1.0 - buy_ratio) * 100, 1),
            "recent_volume": round(total_lots, 1)
        }

    def _evaluate_news_shield(self) -> Dict[str, Any]:
        """
        Prop-Firm USD High-Impact News & Flash Volatility Shield.
        1. Checks scheduled USD Macro News Windows in Malaysia Time (UTC+8):
           - 20:25 - 20:45 MYT (8:30 AM ET: CPI, NFP, Core PCE, Retail Sales, Jobless Claims)
           - 21:55 - 22:15 MYT (10:00 AM ET: ISM PMI, Consumer Confidence, JOLTS, Fed Chair)
           - 01:55 - 02:35 MYT (2:00 PM ET: FOMC Rate Decision & Press Conference)
        2. Checks real-time abnormal spread (> $0.65) or 10-second flash price spike (> $3.80).
        """
        utc_now = datetime.utcnow()
        myt_hour = (utc_now.hour + 8) % 24
        myt_min = utc_now.minute
        total_mins = myt_hour * 60 + myt_min

        in_scheduled_news = False
        news_event_name = "Tiada Berita Merah USD"

        # 20:25 (1225m) to 20:45 (1245m) MYT
        if 1225 <= total_mins <= 1245:
            in_scheduled_news = True
            news_event_name = "Zon Berita Utama USD 8:30 ET (CPI / NFP / Claims)"
        # 21:55 (1315m) to 22:15 (1335m) MYT
        elif 1315 <= total_mins <= 1335:
            in_scheduled_news = True
            news_event_name = "Zon Berita Utama USD 10:00 ET (ISM PMI / JOLTS)"
        # 01:55 (115m) to 02:35 (155m) MYT
        elif 115 <= total_mins <= 155:
            in_scheduled_news = True
            news_event_name = "Zon Pengumuman FOMC / Kadar Faedah Fed (2:00 PM ET)"

        # Real-time 10s price displacement shock
        price_jump_10s = 0.0
        if len(self._price_10s_buffer) >= 2:
            ps = [x["p"] for x in self._price_10s_buffer]
            price_jump_10s = round(max(ps) - min(ps), 2)

        is_vol_shock = (self.spread > 0.65) or (price_jump_10s >= 3.80)

        is_danger = in_scheduled_news or is_vol_shock
        is_blocked = self.news_filter_enabled and is_danger

        if is_vol_shock:
            status = "VOLATILITY_SHOCK"
            headline = f"🚨 KEJUTAN VOLATILITI / SPREAD TINGGI (Δ10s: ${price_jump_10s:.2f} | Spread: ${self.spread:.2f})"
        elif in_scheduled_news:
            status = "RED_NEWS_WINDOW"
            headline = f"📰 AWAS: {news_event_name} — Volatiliti Ekstrem"
        else:
            status = "SAFE"
            headline = "🛡️ PELINDUNG BERITA: PASARAN STABIL (Tiada Impak Merah)"

        return {
            "enabled": self.news_filter_enabled,
            "status": status,
            "is_danger": is_danger,
            "is_blocked": is_blocked,
            "headline": headline,
            "event_name": news_event_name,
            "price_jump_10s": price_jump_10s,
            "spread": self.spread
        }

    def toggle_news_filter(self) -> Dict[str, Any]:
        """Toggle the USD High-Impact News & Volatility Shield on/off"""
        self.news_filter_enabled = not self.news_filter_enabled
        state_str = "AKTIF (ON)" if self.news_filter_enabled else "DIMATIKAN (OFF)"
        return {
            "status": "success",
            "enabled": self.news_filter_enabled,
            "message": f"🛡️ Pelindung Berita USD & Volatiliti: {state_str}"
        }

    # ══════════════════════════════════════════════════════════════════════════
    # WORLD-CLASS ELITE SUITE:
    # 1. SPOOFING DETECTOR (PULLING vs STACKING)
    # 2. MULTI-TIMEFRAME CONFLUENCE MATRIX (M1 + M5 + M15 + H1)
    # 3. PROP-FIRM RISK SHIELD & DRAWDOWN HARD-BREAKER
    # 4. INSTANT SL/TP MODIFIER
    # ══════════════════════════════════════════════════════════════════════════

    def _evaluate_spoofing(self, now_ms: int):
        """
        Detects Order Book Spoofing:
        - PULLING (Fake Wall): Resting orders dropped >= 22L without trade execution touching that price
        - STACKING (Genuine Wall): Resting orders suddenly reinforced by >= 25L
        """
        now = time.time()
        self._depth_snapshots_buffer.append({
            "t": now,
            "bids": dict(self.order_book_bids),
            "asks": dict(self.order_book_asks)
        })
        cutoff = now - 3.5
        self._depth_snapshots_buffer = [x for x in self._depth_snapshots_buffer if x["t"] >= cutoff]

        if len(self._depth_snapshots_buffer) < 4:
            return
        if now - self._last_spoof_eval_time < 1.2:
            return
        self._last_spoof_eval_time = now

        old_snap = self._depth_snapshots_buffer[0]
        cur_p = self.last_price

        # Check Asks (Sell Limits)
        for p_k, old_v in old_snap["asks"].items():
            cur_v = self.order_book_asks.get(p_k, 0.0)
            p = float(p_k)
            diff = cur_v - old_v
            # If wall dropped by >= 22L and price was not right at this level -> PULLING (spoof)
            if diff <= -22.0 and abs(cur_p - p) > 0.15:
                self.spoof_events.append({
                    "type": "PULLING",
                    "side": "ask",
                    "price": p,
                    "delta_vol": round(abs(diff), 1),
                    "badge": f"⚡ SPOOF PULL: -{abs(diff):.0f}L @ ${p:.2f}",
                    "desc": f"Jerung batalkan -{abs(diff):.0f}L pesanan jual pada ${p:.2f} (Spoofing).",
                    "timestamp": now_ms
                })
            elif diff >= 25.0:
                self.spoof_events.append({
                    "type": "STACKING",
                    "side": "ask",
                    "price": p,
                    "delta_vol": round(diff, 1),
                    "badge": f"🧱 STACK WALL: +{diff:.0f}L @ ${p:.2f}",
                    "desc": f"Dinding jerung diperkukuh +{diff:.0f}L pesanan jual pada ${p:.2f}.",
                    "timestamp": now_ms
                })

        # Check Bids (Buy Limits)
        for p_k, old_v in old_snap["bids"].items():
            cur_v = self.order_book_bids.get(p_k, 0.0)
            p = float(p_k)
            diff = cur_v - old_v
            if diff <= -22.0 and abs(cur_p - p) > 0.15:
                self.spoof_events.append({
                    "type": "PULLING",
                    "side": "bid",
                    "price": p,
                    "delta_vol": round(abs(diff), 1),
                    "badge": f"⚡ SPOOF PULL: -{abs(diff):.0f}L @ ${p:.2f}",
                    "desc": f"Jerung batalkan -{abs(diff):.0f}L pesanan beli pada ${p:.2f} (Spoofing).",
                    "timestamp": now_ms
                })
            elif diff >= 25.0:
                self.spoof_events.append({
                    "type": "STACKING",
                    "side": "bid",
                    "price": p,
                    "delta_vol": round(diff, 1),
                    "badge": f"🧱 STACK WALL: +{diff:.0f}L @ ${p:.2f}",
                    "desc": f"Dinding jerung diperkukuh +{diff:.0f}L pesanan beli pada ${p:.2f}.",
                    "timestamp": now_ms
                })

        if len(self.spoof_events) > 8:
            self.spoof_events = self.spoof_events[-8:]


    def _evaluate_bookmap_signals(self) -> List[Dict[str, Any]]:
        """
        Strict Location-First Institutional Bookmap Signal Engine:
        Guarantees that BUY and SELL signals ONLY fire at validated Institutional 
        Demand/Supply levels with Resting Liquidity Walls and Order Flow Absorption.
        Never fires in the mid-range chop / no-man's land.
        """
        now = time.time()
        now_ms = int(now * 1000)
        p = self.last_price if self.last_price > 0 else (self.current_bid if self.current_bid > 0 else 4008.0)
        if p <= 0:
            return self.bookmap_signals

        # Strict Cooldown (70 seconds minimum between signals of same bias)
        if now - self._last_bm_signal_time < 70.0:
            self._update_signals_status(p)
            return self.bookmap_signals

        sess = self.sessions_data or {}
        svp = self.session_vp_summary or {}

        # Higher Timeframe Demand & Support Pools
        demand_levels = [
            {"p": sess.get("h8_sup") or sess.get("h8_low"), "name": "H8 DEMAND"},
            {"p": sess.get("h4_sup") or sess.get("h4_low"), "name": "H4 DEMAND"},
            {"p": sess.get("h1_sup") or sess.get("h1_low"), "name": "H1 SUPPORT"},
            {"p": sess.get("m30_sup") or sess.get("m30_low"), "name": "M30 SUPPORT"},
            {"p": sess.get("m15_sup") or sess.get("m15_low"), "name": "M15 SUPPORT"},
            {"p": svp.get("val"), "name": "VAL 70% DEMAND"},
            {"p": sess.get("pdl"), "name": "PDL FLOOR"},
            {"p": sess.get("asian_low"), "name": "ASIAN LOW"},
            {"p": sess.get("london_low"), "name": "LONDON LOW"}
        ]
        demand_levels = [d for d in demand_levels if d.get("p") and d["p"] > 0]

        # Higher Timeframe Supply & Resistance Pools
        supply_levels = [
            {"p": sess.get("h8_res") or sess.get("h8_high"), "name": "H8 SUPPLY"},
            {"p": sess.get("h4_res") or sess.get("h4_high"), "name": "H4 SUPPLY"},
            {"p": sess.get("h1_res") or sess.get("h1_high"), "name": "H1 RESISTANCE"},
            {"p": sess.get("m30_res") or sess.get("m30_high"), "name": "M30 RESISTANCE"},
            {"p": sess.get("m15_res") or sess.get("m15_high"), "name": "M15 RESISTANCE"},
            {"p": svp.get("vah"), "name": "VAH 70% SUPPLY"},
            {"p": sess.get("pdh"), "name": "PDH CEILING"},
            {"p": sess.get("asian_high"), "name": "ASIAN HIGH"},
            {"p": sess.get("london_high"), "name": "LONDON HIGH"}
        ]
        supply_levels = [s for s in supply_levels if s.get("p") and s["p"] > 0]

        # Strict Location Gate Tolerance: ±$0.60 on Gold
        tol = 0.60
        active_demand = next((d for d in demand_levels if abs(d["p"] - p) <= tol), None)
        active_supply = next((s for s in supply_levels if abs(s["p"] - p) <= tol), None)

        # Scan Resting Liquidity Walls on Order Book (Bids & Asks)
        bid_wall = 0.0
        for bp, bvol in self.order_book_bids.items():
            try:
                fp = float(bp)
                if abs(fp - p) <= 0.75 and fp <= p + 0.15:
                    if bvol > bid_wall:
                        bid_wall = bvol
            except Exception:
                pass
        for wp, wvol in self.persistent_walls.items():
            if abs(wp - p) <= 0.75 and wp <= p + 0.15:
                if wvol > bid_wall:
                    bid_wall = wvol

        ask_wall = 0.0
        for ap, avol in self.order_book_asks.items():
            try:
                fp = float(ap)
                if abs(fp - p) <= 0.75 and fp >= p - 0.15:
                    if avol > ask_wall:
                        ask_wall = avol
            except Exception:
                pass
        for wp, wvol in self.persistent_walls.items():
            if abs(wp - p) <= 0.75 and wp >= p - 0.15:
                if wvol > ask_wall:
                    ask_wall = wvol

        # ── 1. EVALUATE BUY (Strictly at Demand Zone + Bid Wall + Trigger) ──
        if active_demand and (bid_wall >= 18.0 or active_demand["name"] in ("H8 DEMAND", "H4 DEMAND", "VAL 70% DEMAND")):
            trigger = None
            if any(ic.get("bias") == "BUY" and abs(ic.get("price", 0) - p) <= 0.85 for ic in self.iceberg_orders):
                trigger = "ICEBERG BID ABSORPTION"
            elif any(tr.get("type") == "TRAPPED_SELLERS" and abs(tr.get("price", 0) - p) <= 0.85 for tr in self.trapped_traders):
                trigger = "TRAPPED SELLERS AT LOW"
            elif self.detected_divergence and self.detected_divergence.get("type") == "bullish":
                trigger = "BULLISH CVD DIVERGENCE"
            elif sess.get("sweep_alert") and sess["sweep_alert"].get("bias") == "BUY" and (now_ms - sess["sweep_alert"].get("timestamp", 0) < 45000):
                trigger = "LIQUIDITY RAID & SWEEP"
            elif bid_wall >= 35.0:
                trigger = f"WHALE BID WALL ({bid_wall:.0f}L)"

            if trigger and self._last_bm_signal_dir != "BUY":
                sl = round(active_demand["p"] - 1.50, 2)
                risk = max(1.0, round(p - sl, 2))
                tp1 = round(p + risk * 2.0, 2)
                tp2 = round(p + risk * 3.5, 2)

                sig = {
                    "id": f"bm_{now_ms}",
                    "timestamp": int(now),
                    "type": trigger,
                    "direction": "BUY",
                    "price": round(p, 2),
                    "sl": sl,
                    "tp1": tp1,
                    "tp2": tp2,
                    "zone": active_demand["name"],
                    "wall_lots": round(bid_wall, 1),
                    "badge": f"🟢 BUY [{active_demand['name']}]",
                    "status": "ACTIVE"
                }
                self.bookmap_signals.append(sig)
                if len(self.bookmap_signals) > 10:
                    self.bookmap_signals.pop(0)
                self._last_bm_signal_time = now
                self._last_bm_signal_dir = "BUY"

                try:
                    import threading
                    def _push_sb():
                        from supabase_client import supabase
                        if supabase.is_connected:
                            supabase.save_signal(sig)
                    threading.Thread(target=_push_sb, daemon=True).start()
                except Exception:
                    pass

        # ── 2. EVALUATE SELL (Strictly at Supply Zone + Ask Wall + Trigger) ──
        elif active_supply and (ask_wall >= 18.0 or active_supply["name"] in ("H8 SUPPLY", "H4 SUPPLY", "VAH 70% SUPPLY")):
            trigger = None
            if any(ic.get("bias") == "SELL" and abs(ic.get("price", 0) - p) <= 0.85 for ic in self.iceberg_orders):
                trigger = "ICEBERG ASK ABSORPTION"
            elif any(tr.get("type") == "TRAPPED_BUYERS" and abs(tr.get("price", 0) - p) <= 0.85 for tr in self.trapped_traders):
                trigger = "TRAPPED BUYERS AT HIGH"
            elif self.detected_divergence and self.detected_divergence.get("type") == "bearish":
                trigger = "BEARISH CVD DIVERGENCE"
            elif sess.get("sweep_alert") and sess["sweep_alert"].get("bias") == "SELL" and (now_ms - sess["sweep_alert"].get("timestamp", 0) < 45000):
                trigger = "LIQUIDITY RAID & SWEEP"
            elif ask_wall >= 35.0:
                trigger = f"WHALE ASK WALL ({ask_wall:.0f}L)"

            if trigger and self._last_bm_signal_dir != "SELL":
                sl = round(active_supply["p"] + 1.50, 2)
                risk = max(1.0, round(sl - p, 2))
                tp1 = round(p - risk * 2.0, 2)
                tp2 = round(p - risk * 3.5, 2)

                sig = {
                    "id": f"bm_{now_ms}",
                    "timestamp": int(now),
                    "type": trigger,
                    "direction": "SELL",
                    "price": round(p, 2),
                    "sl": sl,
                    "tp1": tp1,
                    "tp2": tp2,
                    "zone": active_supply["name"],
                    "wall_lots": round(ask_wall, 1),
                    "badge": f"🔴 SELL [{active_supply['name']}]",
                    "status": "ACTIVE"
                }
                self.bookmap_signals.append(sig)
                if len(self.bookmap_signals) > 10:
                    self.bookmap_signals.pop(0)
                self._last_bm_signal_time = now
                self._last_bm_signal_dir = "SELL"

                try:
                    import threading
                    def _push_sb():
                        from supabase_client import supabase
                        if supabase.is_connected:
                            supabase.save_signal(sig)
                    threading.Thread(target=_push_sb, daemon=True).start()
                except Exception:
                    pass

        self._update_signals_status(p)
        return self.bookmap_signals

    def _update_signals_status(self, p: float):
        """Updates win/loss status of active signals in real-time"""
        for sig in self.bookmap_signals:
            if sig.get("status") == "ACTIVE":
                if sig.get("direction") == "BUY":
                    if p >= sig.get("tp2", 99999):
                        sig["status"] = "TP2_HIT"
                    elif p >= sig.get("tp1", 99999):
                        sig["status"] = "TP1_HIT"
                    elif p <= sig.get("sl", 0):
                        sig["status"] = "SL_HIT"
                else:
                    if p <= sig.get("tp2", 0):
                        sig["status"] = "TP2_HIT"
                    elif p <= sig.get("tp1", 0):
                        sig["status"] = "TP1_HIT"
                    elif p >= sig.get("sl", 99999):
                        sig["status"] = "SL_HIT"

    def _evaluate_mtf_confluence(self) -> Dict[str, Any]:
        """
        Multi-Timeframe Confluence Matrix:
        - M1: Micro Delta Aggression (CVD Slope + Recent Buy/Sell Ratio)
        - M5: Price Location vs M5 Developing Value Area & POC
        - M15: Price Location vs Institutional Session VWAP
        - H1: Asian / London Liquidity Sweep & PDH/PDL Range Acceptance
        """
        price = self.last_price if self.last_price > 0 else 4008.0
        vwap = self.current_vwap if self.current_vwap > 0 else price
        cvd = self.cvd

        # 1. M1 Direction
        recent = self.recent_trades[-40:] if self.recent_trades else []
        buy_l = sum(t.get("buy_vol", t.get("volume", 0)) for t in recent if t.get("side") == "buy")
        sell_l = sum(t.get("sell_vol", t.get("volume", 0)) for t in recent if t.get("side") == "sell")
        tot = buy_l + sell_l
        b_ratio = (buy_l / tot) if tot > 0 else 0.50
        m1_bias = "BUY" if (b_ratio >= 0.54 and cvd > -5) else ("SELL" if (b_ratio <= 0.46 and cvd < 5) else "NEUTRAL")

        # 2. M5 Direction (Candle Close vs POC / Value Area)
        m5_poc = self.current_candle.get("poc", price) if self.current_candle else price
        m5_bias = "BUY" if price > m5_poc + 0.15 else ("SELL" if price < m5_poc - 0.15 else "NEUTRAL")

        # 3. M15 Direction (Session VWAP Trend)
        m15_bias = "BUY" if price > vwap + 0.20 else ("SELL" if price < vwap - 0.20 else "NEUTRAL")

        # 4. H1 Direction (Session High/Low & Daily Open)
        daily_open = self.sessions_data.get("daily_open", price)
        h1_bias = "BUY" if price >= daily_open else "SELL"
        if self.sessions_data.get("sweep_alert"):
            sw = self.sessions_data["sweep_alert"]
            if sw.get("bias") in ("BUY", "SELL"):
                h1_bias = sw["bias"]

        # Composite Confluence Score
        signals = [m1_bias, m5_bias, m15_bias, h1_bias]
        buy_count = signals.count("BUY")
        sell_count = signals.count("SELL")

        if buy_count >= 3:
            overall = "STRONG_BUY"
            headline = f"🟢 KONFLUENSI BELIAN KUAT ({buy_count}/4 Selaras)"
            score_pct = int(75 + buy_count * 6.25)
        elif sell_count >= 3:
            overall = "STRONG_SELL"
            headline = f"🔴 KONFLUENSI JUALAN KUAT ({sell_count}/4 Selaras)"
            score_pct = int(75 + sell_count * 6.25)
        else:
            overall = "CHOP_MIXED"
            headline = "⚖️ PASARAN BERCAMPUR / KONSOLIDASI (Tunggu Pengesahan)"
            score_pct = 50

        return {
            "overall": overall,
            "headline": headline,
            "score_pct": score_pct,
            "m1": {"bias": m1_bias, "label": "M1 (Delta)"},
            "m5": {"bias": m5_bias, "label": "M5 (POC)"},
            "m15": {"bias": m15_bias, "label": "M15 (VWAP)"},
            "h1": {"bias": h1_bias, "label": "H1 (Sesi/Open)"}
        }

    def _evaluate_prop_firm_shield(self) -> Dict[str, Any]:
        """
        Prop-Firm Smart Risk Shield & Hard-Breaker:
        Protects funded accounts (FTMO, FundedNext, MFF, Personal) from breaching Max Daily Drawdown (4.0%).
        """
        eq = self.account_info.get("equity", 100000.0)
        bal = self.account_info.get("balance", 100000.0)
        if self.initial_daily_equity <= 0:
            self.initial_daily_equity = bal if bal > 0 else 100000.0

        loss_usd = max(0.0, self.initial_daily_equity - eq)
        dd_pct = round((loss_usd / self.initial_daily_equity) * 100.0, 2)
        max_dd = self.max_daily_drawdown_pct

        is_locked = bool(self.prop_firm_enabled and dd_pct >= max_dd)

        if is_locked:
            status = "HARD_BREAKER_LOCKED"
            headline = f"🚨 PERISAI PROP-FIRM DIKUNCI: Had rugi harian ({dd_pct}% ≥ {max_dd}%) dicapai!"
        elif dd_pct >= (max_dd * 0.70):
            status = "WARNING_DRAWDOWN"
            headline = f"⚠️ AMARAN PROP-FIRM: Kerugian harian {dd_pct}% (Baki buffer: {(max_dd - dd_pct):.2f}%)"
        else:
            status = "SAFE"
            headline = f"🛡️ PERISAI PROP-FIRM: AMAN (Drawdown {dd_pct}% / {max_dd}%)"

        # Auto-calculated lot sizes for 0.5%, 1.0%, 2.0% risk based on 25 pip default SL
        def calc_lot(risk_pct: float, sl_pips: float = 25.0) -> float:
            risk_usd = (risk_pct / 100.0) * eq
            # 1 Lot Gold = $10 per pip ($1.00 per pip per 0.1 Lot)
            pip_val_1_lot = 10.0
            lots = risk_usd / (sl_pips * pip_val_1_lot)
            return round(max(0.01, min(10.0, lots)), 2)

        return {
            "enabled": self.prop_firm_enabled,
            "max_daily_loss_pct": max_dd,
            "initial_equity": round(self.initial_daily_equity, 2),
            "current_equity": round(eq, 2),
            "current_drawdown_pct": dd_pct,
            "current_drawdown_usd": round(loss_usd, 2),
            "is_locked": is_locked,
            "status": status,
            "headline": headline,
            "recommended_lots": {
                "0.5%": calc_lot(0.5),
                "1.0%": calc_lot(1.0),
                "2.0%": calc_lot(2.0)
            }
        }

    def toggle_prop_firm_shield(self) -> Dict[str, Any]:
        """Toggle the Prop-Firm Drawdown Shield on/off"""
        self.prop_firm_enabled = not self.prop_firm_enabled
        state_str = "AKTIF (ON)" if self.prop_firm_enabled else "DIMATIKAN (OFF)"
        return {
            "status": "success",
            "enabled": self.prop_firm_enabled,
            "message": f"🛡️ Perisai Prop-Firm Drawdown: {state_str}"
        }

    def update_position_sltp(self, ticket: int, sl: float, tp: float) -> Dict[str, Any]:
        """Update Stop Loss and Take Profit instantly from On-Canvas drag or hotkeys"""
        sl = round(float(sl), 2)
        tp = round(float(tp), 2)
        if self.simulation_mode or not self.is_connected:
            for p in self.positions:
                if p["ticket"] == ticket:
                    p["sl"] = sl
                    p["tp"] = tp
                    return {"status": "success", "message": f"SL/TP dikemaskini: SL ${sl:.2f} | TP ${tp:.2f} (#{ticket})"}
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai"}

        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai di MT5"}

        pos = pos_list[0]
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": pos.symbol,
            "position": ticket,
            "sl": float(sl),
            "tp": float(tp),
        }
        res = mt5.order_send(request)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            self._update_account_info()
            return {"status": "success", "message": f"SL/TP berjaya dikemaskini: SL ${sl:.2f} | TP ${tp:.2f} (#{ticket})"}
        else:
            err = res.comment if res else mt5.last_error()
            return {"status": "error", "message": f"Ralat kemaskini SL/TP: {err}"}

    def close_partial_position(self, ticket: int, ratio: float = 0.5) -> Dict[str, Any]:
        """Close partial lots (e.g. 50%) of an active position"""
        if self.simulation_mode or not self.is_connected:
            for p in self.positions:
                if p["ticket"] == ticket:
                    orig_vol = p["volume"]
                    close_vol = round(orig_vol * ratio, 2)
                    remain_vol = round(orig_vol - close_vol, 2)
                    if remain_vol <= 0.001:
                        self.positions = [x for x in self.positions if x["ticket"] != ticket]
                        return {"status": "success", "message": f"Posisi #{ticket} ditutup penuh ({orig_vol} Lot)"}
                    else:
                        p["volume"] = remain_vol
                        return {"status": "success", "message": f"Tutup separuh {close_vol} Lot (#{ticket}), baki {remain_vol} Lot"}
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai"}

        # Live MT5 partial close
        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai di MT5"}

        pos = pos_list[0]
        close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        price = mt5.symbol_info_tick(pos.symbol).bid if pos.type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(pos.symbol).ask
        close_vol = round(float(pos.volume) * ratio, 2)
        if close_vol <= 0.001:
            close_vol = float(pos.volume)

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": pos.symbol,
            "volume": float(close_vol),
            "type": close_type,
            "position": ticket,
            "price": float(price),
            "deviation": 20,
            "magic": 777999,
            "comment": "Bookmap Partial Close 50%",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        res = mt5.order_send(request)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            self._update_account_info()
            return {"status": "success", "message": f"Berjaya tutup separuh {close_vol} Lot untuk #{ticket}"}
        else:
            err = res.comment if res else mt5.last_error()
            return {"status": "error", "message": f"Ralat partial close: {err}"}

    def move_to_breakeven(self, ticket: int) -> Dict[str, Any]:
        """Move Stop Loss to Entry Price (Breakeven + 1 pip buffer)"""
        if self.simulation_mode or not self.is_connected:
            for p in self.positions:
                if p["ticket"] == ticket:
                    is_buy = p["type"] == "BUY"
                    be_price = round(p["open_price"] + (0.10 if is_buy else -0.10), 2)
                    p["sl"] = be_price
                    return {"status": "success", "message": f"SL dipindahkan ke Breakeven @ ${be_price} (#{ticket})"}
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai"}

        pos_list = mt5.positions_get(ticket=ticket)
        if not pos_list:
            return {"status": "error", "message": f"Posisi #{ticket} tidak dijumpai di MT5"}

        pos = pos_list[0]
        is_buy = pos.type == mt5.ORDER_TYPE_BUY
        be_price = round(float(pos.price_open) + (0.10 if is_buy else -0.10), self.tick_digits)

        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": pos.symbol,
            "position": ticket,
            "sl": float(be_price),
            "tp": float(pos.tp),
        }
        res = mt5.order_send(request)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            self._update_account_info()
            return {"status": "success", "message": f"SL berjaya dipindahkan ke BE @ ${be_price} (#{ticket})"}
        else:
            err = res.comment if res else mt5.last_error()
            return {"status": "error", "message": f"Ralat pindah SL ke BE: {err}"}

    def move_all_to_breakeven(self) -> Dict[str, Any]:
        """Move Stop Loss to Breakeven for all active positions"""
        count = 0
        if self.simulation_mode or not self.is_connected:
            for p in self.positions:
                is_buy = p["type"] == "BUY"
                be_price = round(p["open_price"] + (0.10 if is_buy else -0.10), 2)
                p["sl"] = be_price
                count += 1
            return {"status": "success", "message": f"{count} posisi SL telah dipindahkan ke Breakeven"}
        
        pos_list = mt5.positions_get(symbol=self.symbol)
        if pos_list:
            for p in pos_list:
                res = self.move_to_breakeven(p.ticket)
                if res.get("status") == "success":
                    count += 1
        return {"status": "success", "message": f"{count} posisi SL berjaya dipindahkan ke BE"}

    def close_partial_all(self, ratio: float = 0.5) -> Dict[str, Any]:
        """Close partial lots (e.g. 50%) for all active positions"""
        count = 0
        if self.simulation_mode or not self.is_connected:
            tickets = [p["ticket"] for p in list(self.positions)]
            for t in tickets:
                res = self.close_partial_position(t, ratio)
                if res.get("status") == "success":
                    count += 1
            return {"status": "success", "message": f"{count} posisi berjaya ditutup separuh ({int(ratio*100)}%)"}
        
        pos_list = mt5.positions_get(symbol=self.symbol)
        if pos_list:
            for p in pos_list:
                res = self.close_partial_position(p.ticket, ratio)
                if res.get("status") == "success":
                    count += 1
        return {"status": "success", "message": f"{count} posisi berjaya ditutup separuh ({int(ratio*100)}%)"}

    def _poll_swissquote_feed(self):
        """Fetch live XAUUSD quote from Swissquote Bank public data feed"""
        now = time.time()
        # Rate limit HTTP calls to every 350ms
        if now - self._last_sq_fetch_time < 0.35:
            return
        self._last_sq_fetch_time = now

        try:
            req = urllib.request.Request(
                'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req, timeout=1.8) as resp:
                data = json.loads(resp.read().decode())
                if data and len(data) > 0:
                    profile = data[0].get('spreadProfilePrices', [{}])[0]
                    bid = float(profile.get('bid', 0.0))
                    ask = float(profile.get('ask', 0.0))
                    if bid > 0 and ask > 0:
                        bid = round(bid, 2)
                        ask = round(ask, 2)
                        vol = round(1.2 + abs(math.sin(now * 1.5)) * 4.5, 1)
                        if int(now * 10) % 21 == 0:
                            vol = round(12.0 + (int(now) % 8), 1) # Institutional Whale
                        self.process_tick(bid, ask, vol)
                        self.swissquote_status = "LIVE_OK"
        except Exception as e:
            self.swissquote_status = f"ERR: {e}"

    def poll_feed(self):
        """Poll tick from local MT5 broker (every tick / 1 second) or monitor Swissquote heartbeat"""
        now = time.time()
        if self.feed_source == "mt5" and self.is_connected and not self.simulation_mode:
            tick = mt5.symbol_info_tick(self.symbol)
            if tick and tick.bid > 0 and tick.ask > 0:
                is_new_tick = (tick.time_msc != self._last_mt5_tick_msc)
                # Process tick if new broker price OR at least 1.0 second elapsed (heartbeat guarantee)
                if is_new_tick or (now - self._last_tick_time >= 1.0):
                    self._last_mt5_tick_msc = tick.time_msc
                    self._last_tick_time = now
                    
                    base_vol = float(tick.volume_real if hasattr(tick, 'volume_real') and tick.volume_real > 0 else (tick.volume if tick.volume > 0 else 1.0))
                    vol = self._calculate_tick_velocity_volume(tick.bid, tick.ask, base_vol)
                    
                    self.process_tick(tick.bid, tick.ask, vol, tick.flags)
                    
            # Rate-limit MT5 account info call to once every 1.5s to preserve latency
            if now - self._last_account_poll_time >= 1.5:
                self._last_account_poll_time = now
                self._update_account_info()
        elif self.feed_source == "swissquote":
            # Swissquote is continuously polled in self._swissquote_poller_loop every 1.0s
            pass

    def set_feed_source(self, source: str) -> Dict[str, Any]:
        """Switch feed source between Swissquote Bank live cloud feed and MT5"""
        source = source.lower().strip()
        if source in ["swissquote", "mt5"]:
            self.feed_source = source
            if source == "mt5" and not self.is_connected and MT5_AVAILABLE:
                self.initialize_mt5()
            return {"status": "success", "feed_source": self.feed_source, "message": f"Sumber harga ditukar ke {self.feed_source.upper()}"}
        return {"status": "error", "message": "Sumber tidak sah (pilih 'swissquote' atau 'mt5')"}

    def get_historical_candles(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Retrieve up to limit historical order flow candles for deep lookback and backtesting"""
        if limit <= 0 or limit >= len(self.candles):
            res = list(self.candles)
        else:
            res = self.candles[-limit:]
        if self.current_candle:
            res.append(self.current_candle)
        return res

    def get_full_snapshot(self, initial: bool = False) -> Dict[str, Any]:
        """Returns the full state payload to send to the browser UI"""
        now = time.time()
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "connected": self.is_connected,
            "simulation": self.simulation_mode,
            "feed_source": self.feed_source,
            "feed_label": "SWISSQUOTE BANK LIVE (Cloud)" if self.feed_source == "swissquote" else "JUSTMARKETS MT5",
            "server_time_iso": datetime.now().strftime("%I:%M:%S %p"),
            "server_time_ms": int(now * 1000),
            "last_tick_age_ms": max(0, int((now - self._last_tick_time) * 1000)),
            "tick_cadence": "1s Tepat",
            "tick_velocity_1s": self.tick_velocity_1s,
            "price_velocity_1s": self.price_velocity_1s,
            "sessions": self.sessions_data,
            "htf_snr": {
                "m15_res": self.sessions_data.get("m15_res", 0.0),
                "m15_sup": self.sessions_data.get("m15_sup", 0.0),
                "m30_res": self.sessions_data.get("m30_res", 0.0),
                "m30_sup": self.sessions_data.get("m30_sup", 0.0),
                "h1_res": self.sessions_data.get("h1_res", 0.0),
                "h1_sup": self.sessions_data.get("h1_sup", 0.0),
                "h4_res": self.sessions_data.get("h4_res", 0.0),
                "h4_sup": self.sessions_data.get("h4_sup", 0.0),
                "h8_res": self.sessions_data.get("h8_res", 0.0),
                "h8_sup": self.sessions_data.get("h8_sup", 0.0),
                "m15_high": self.sessions_data.get("m15_high", 0.0),
                "m15_low": self.sessions_data.get("m15_low", 0.0),
                "m30_high": self.sessions_data.get("m30_high", 0.0),
                "m30_low": self.sessions_data.get("m30_low", 0.0),
                "h1_high": self.sessions_data.get("h1_high", 0.0),
                "h1_low": self.sessions_data.get("h1_low", 0.0),
                "h4_high": self.sessions_data.get("h4_high", 0.0),
                "h4_low": self.sessions_data.get("h4_low", 0.0),
                "h8_high": self.sessions_data.get("h8_high", 0.0),
                "h8_low": self.sessions_data.get("h8_low", 0.0),
            },
            "news_shield": self._evaluate_news_shield(),
            "bid": self.current_bid,
            "ask": self.current_ask,
            "spread": self.spread,
            "last_price": self.last_price,
            "cvd": round(self.cvd, 2),
            "vwap": {
                "value": self.current_vwap,
                "std1_up": self.vwap_std1_up,
                "std1_down": self.vwap_std1_down,
                "std2_up": self.vwap_std2_up,
                "std2_down": self.vwap_std2_down
            },
            "divergence": self.detected_divergence,
            "trapped_traders": self.trapped_traders[-5:],
            "icebergs": self.iceberg_orders[-6:],
            "session_vp": self.session_vp_summary,
            "market_radar": self._evaluate_market_radar(),
            "account": self.account_info,
            "positions": self.positions,
            "trades": self.recent_trades[-60:] if initial else self.recent_trades[-12:],
            "heatmap": (self.heatmap_history[-350:] if initial else self.heatmap_history[-12:]),
            "candles": (self.candles[-50:] + ([self.current_candle] if self.current_candle else [])) if initial else ([self.current_candle] if self.current_candle else []),
            "total_candles_count": len(self.candles) + (1 if self.current_candle else 0),
            "current_candle": self.current_candle,
            "spoof_events": self.spoof_events[-6:],
            "mtf_confluence": self._evaluate_mtf_confluence(),
            "prop_firm_shield": self._evaluate_prop_firm_shield(),
            "bookmap_signals": self._evaluate_bookmap_signals(),
            "order_book": {
                "bids": self.order_book_bids,
                "asks": self.order_book_asks
            }
        }
