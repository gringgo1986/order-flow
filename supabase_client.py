import os
import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vsqahqpivfyanfxvnagd.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_secret_n8ae3Bm_mbUaTh8csnc_tA_LwBxj3Yt")

class SupabaseClient:
    def __init__(self, url: str = SUPABASE_URL, key: str = SUPABASE_KEY):
        self.url = url.rstrip("/")
        self.key = key
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
        }
        self.is_connected = False
        self._check_connection()

    def _check_connection(self):
        try:
            req = urllib.request.Request(f"{self.url}/rest/v1/", headers=self.headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    self.is_connected = True
        except Exception:
            self.is_connected = False

    def post(self, table: str, data: Any, upsert: bool = False) -> bool:
        """Insert or upsert records to Supabase table"""
        url = f"{self.url}/rest/v1/{table}"
        headers = dict(self.headers)
        if upsert:
            headers["Prefer"] = "resolution=merge-duplicates,return=minimal"

        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 201, 204)
        except urllib.error.HTTPError as e:
            # Table might not exist yet if status is 404
            return False
        except Exception:
            return False

    def get(self, table: str, params: str = "") -> List[Dict[str, Any]]:
        """Query records from Supabase table"""
        url = f"{self.url}/rest/v1/{table}"
        if params:
            url += f"?{params}"
        req = urllib.request.Request(url, headers=self.headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return []

    # ─── High-Level Module Sync Methods ────────────────────────────

    def save_heatmap_batch(self, slices: List[Dict[str, Any]]) -> bool:
        """Save a batch of Bookmap heatmap depth slices"""
        if not slices:
            return True
        records = []
        for s in slices:
            records.append({
                "timestamp": s.get("timestamp", int(time.time() * 1000)),
                "mid_price": s.get("mid_price", 0.0),
                "bids": s.get("bids", {}),
                "asks": s.get("asks", {})
            })
        return self.post("bookmap_heatmap", records)

    def load_latest_heatmap(self, limit: int = 350) -> List[Dict[str, Any]]:
        """Load latest 350 historical heatmap slices on user connect/refresh"""
        rows = self.get("bookmap_heatmap", f"select=timestamp,mid_price,bids,asks&order=timestamp.desc&limit={limit}")
        if rows:
            rows.reverse() # chronological order
        return rows

    def save_candles_batch(self, candles: List[Dict[str, Any]], timeframe: str = "M1") -> bool:
        """Save/upsert OHLCV + Footprint/ClusterDelta volume ladder candles"""
        if not candles:
            return True
        records = []
        for c in candles:
            records.append({
                "timeframe": timeframe,
                "time": int(c.get("time", 0)),
                "open": float(c.get("open", 0.0)),
                "high": float(c.get("high", 0.0)),
                "low": float(c.get("low", 0.0)),
                "close": float(c.get("close", 0.0)),
                "volume": float(c.get("volume", 0.0)),
                "delta": float(c.get("delta", 0.0)),
                "clusters": c.get("clusters", {})
            })
        return self.post("candles_history", records, upsert=True)

    def load_latest_candles(self, timeframe: str = "M1", limit: int = 60) -> List[Dict[str, Any]]:
        """Load latest historical candles for Candle, Footprint & ClusterDelta"""
        rows = self.get("candles_history", f"timeframe=eq.{timeframe}&order=time.desc&limit={limit}")
        if rows:
            rows.reverse()
        return rows

    def save_signal(self, sig: Dict[str, Any]) -> bool:
        """Record confirmed institutional A+ order flow signal"""
        if not sig:
            return True
        record = {
            "timestamp": int(sig.get("time", time.time())),
            "type": sig.get("type", "SIGNAL"),
            "direction": sig.get("direction", "BUY"),
            "price": float(sig.get("price", 0.0)),
            "sl": float(sig.get("sl", 0.0)),
            "tp1": float(sig.get("tp1", 0.0)),
            "badge": sig.get("badge", "")
        }
        return self.post("signals_history", record)

    def load_latest_signals(self, limit: int = 15) -> List[Dict[str, Any]]:
        """Load confirmed signals for chart overlays"""
        return self.get("signals_history", f"order=timestamp.desc&limit={limit}")

supabase = SupabaseClient()
