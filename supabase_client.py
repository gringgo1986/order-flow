import os
import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vsqahqpivfyanfxvnagd.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_secret_n8ae3Bm_mbUaTh8csnc_tA_LwBxj3Yt")

# 5 Days Retention Window: 5 days * 24 hours * 3600 seconds = 432,000 seconds
RETENTION_DAYS = 5
RETENTION_SECONDS = RETENTION_DAYS * 86400

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
        self._last_prune_time = 0.0
        self._check_connection()

    def _check_connection(self):
        try:
            req = urllib.request.Request(f"{self.url}/rest/v1/", headers=self.headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    self.is_connected = True
        except Exception:
            self.is_connected = False

    def post(self, table: str, data: Any, upsert: bool = False, on_conflict: Optional[str] = None) -> bool:
        """Insert or upsert records to Supabase table"""
        url = f"{self.url}/rest/v1/{table}"
        if upsert and on_conflict:
            url += f"?on_conflict={on_conflict}"
        headers = dict(self.headers)
        if upsert:
            headers["Prefer"] = "resolution=merge-duplicates,return=minimal"

        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 201, 204)
        except urllib.error.HTTPError:
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

    def delete(self, table: str, params: str) -> bool:
        """Delete records matching filter (used for rolling 5-day retention pruning)"""
        if not params:
            return False
        url = f"{self.url}/rest/v1/{table}?{params}"
        req = urllib.request.Request(url, headers=self.headers, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status in (200, 204)
        except Exception:
            return False

    def prune_older_than_days(self, days: int = RETENTION_DAYS) -> Dict[str, bool]:
        """Auto-prune records older than 5 days across all order-flow modules"""
        now = time.time()
        # Rate limit pruning to at most once every 30 minutes
        if now - self._last_prune_time < 1800.0:
            return {}
        self._last_prune_time = now

        cutoff_sec = int(now - (days * 86400))
        cutoff_ms = int(cutoff_sec * 1000)

        results = {
            "bookmap_heatmap": self.delete("bookmap_heatmap", f"timestamp=lt.{cutoff_ms}"),
            "candles_history": self.delete("candles_history", f"time=lt.{cutoff_sec}"),
            "signals_history": self.delete("signals_history", f"timestamp=lt.{cutoff_sec}")
        }
        return results

    # ─── High-Level Module Sync Methods (5-Day Rolling Retention) ──

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
        success = self.post("bookmap_heatmap", records)
        # Trigger background rolling 5-day retention cleanup
        self.prune_older_than_days(RETENTION_DAYS)
        return success

    def load_latest_heatmap(self, limit: int = 500) -> List[Dict[str, Any]]:
        """Load latest historical heatmap slices on user connect/refresh"""
        rows = self.get("bookmap_heatmap", f"select=timestamp,mid_price,bids,asks&order=timestamp.desc&limit={limit}")
        if rows:
            rows.reverse() # chronological order
        return rows

    def save_candles_batch(self, candles: List[Dict[str, Any]], timeframe: str = "M1") -> bool:
        """Save/upsert OHLCV + Footprint/ClusterDelta volume ladder candles (5 days)"""
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

    def load_latest_candles(self, timeframe: str = "M1", limit: int = 7200) -> List[Dict[str, Any]]:
        """Load historical candles for Candle, Footprint & ClusterDelta (up to 5 full trading days)"""
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

    def load_latest_signals(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Load confirmed signals for chart overlays (up to 5 days)"""
        return self.get("signals_history", f"order=timestamp.desc&limit={limit}")

    # ─── User Management Sync Methods (Admin Panel to Cloud DB) ───

    def save_user(self, u: Dict[str, Any]) -> bool:
        """Save or upsert user in Supabase cloud database"""
        if not u or not u.get("username"):
            return False
        record = {
            "username": u["username"],
            "password_hash": u["password_hash"],
            "full_name": u.get("full_name", u["username"]),
            "role": u.get("role", "member"),
            "plan": u.get("plan", "Bulanan 30 Hari"),
            "created_at": str(u.get("created_at", "")),
            "expires_at": str(u.get("expires_at", "never")),
            "is_active": bool(u.get("is_active", 1)),
            "last_login": str(u.get("last_login") or ""),
            "notes": str(u.get("notes") or "")
        }
        return self.post("app_users", record, upsert=True, on_conflict="username")

    def load_all_users(self) -> List[Dict[str, Any]]:
        """Fetch all registered users from Supabase cloud database"""
        return self.get("app_users", "order=id.asc")

    def delete_user(self, username: str) -> bool:
        """Delete user by username from Supabase cloud database"""
        if not username:
            return False
        return self.delete("app_users", f"username=eq.{username}")

supabase = SupabaseClient()
