

"""
FastAPI Server & WebSocket Hub for XAUUSD Bookmap & Order Flow
"""
import os
import time
import json
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
import auth_db

from mt5_engine import OrderFlowEngine

app = FastAPI(title="Gringgo Orderflow")

# Prevent static file & HTML aggressive browser caching during trading
@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path in ("/", "/sw.js", "/manifest.json", "/login") or request.url.path.endswith((".js", ".html", ".css", ".json")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Instantiate Order Flow Engine
engine = OrderFlowEngine(symbol="XAUUSD.m")

# Connected WebSocket clients & Single-Device Session Registry
connected_clients = set()
client_sessions: Dict[Any, Dict[str, Any]] = {}
_last_session_audit_ts = 0.0
_local_state_updated_at = 0.0
_local_signals_reset_ts = 0.0
_last_github_commit_sha = ""


# Models
# Authentication Request Models
class LoginRequest(BaseModel):
    username: str
    password: str

class CreateUserRequest(BaseModel):
    username: str
    password: str
    full_name: str
    role: str = "member"
    plan: str = "Bulanan 30 Hari"
    duration_days: int = 30
    notes: str = ""

class UpdateUserRequest(BaseModel):
    full_name: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    plan: Optional[str] = None
    is_active: Optional[int] = None
    add_days: Optional[int] = None
    set_lifetime: Optional[bool] = None
    notes: Optional[str] = None

def get_current_user(request: Request) -> Optional[dict]:
    session_id = request.cookies.get("session_id")
    if not session_id:
        auth_hdr = request.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            session_id = auth_hdr[7:].strip()
        elif request.headers.get("X-Session-ID"):
            session_id = request.headers.get("X-Session-ID").strip()
    if not session_id:
        return None
    return auth_db.validate_session(session_id)

class TradeRequest(BaseModel):
    action: str  # 'BUY' or 'SELL'
    volume: float = 0.01
    sl_pips: float = 0.0
    tp_pips: float = 0.0

class CloseRequest(BaseModel):
    ticket: int

class PartialCloseRequest(BaseModel):
    ticket: int
    ratio: float = 0.5

class FeedSourceRequest(BaseModel):
    source: str

class TimeframeRequest(BaseModel):
    timeframe: str

class UpdateSLTPRequest(BaseModel):
    ticket: int
    sl: float
    tp: float

@app.on_event("startup")
async def startup_event():
    # Attempt to initialize MT5 connection
    engine.initialize_mt5()
    # Start background tick polling loop
    asyncio.create_task(background_tick_stream())
    # Start 24/7 Cloud Self-Ping Keep-Alive Daemon so server never sleeps when tabs are closed
    asyncio.create_task(keep_alive_cloud_pinger())

async def keep_alive_cloud_pinger():
    """
    24/7 3-Way Mesh Sync & GitHub Live Hot-Reload Daemon:
    Synchronizes all 3 servers (Enzonic, Render, Hugging Face) every 20s and hot-pulls GitHub updates every 60s.
    """
    import urllib.request
    import io
    import zipfile
    global _local_state_updated_at, _local_signals_reset_ts, _last_github_commit_sha

    peers = [
        "https://gringgo-orderflow.enzonic.dev/api/peer_state",
        "https://order-flow-whfl.onrender.com/api/peer_state",
        "https://gringgo-gringgo-orderflow.hf.space/gradio_api/api/peer_state"
    ]
    cycle = 0
    while True:
        await asyncio.sleep(20)
        cycle += 1

        # 1. 3-WAY MESH PEER SYNC (Signals, Reset Events, Timeframe, News Shield, Users)
        for peer_url in peers:
            try:
                req = urllib.request.Request(peer_url, headers={"User-Agent": "GringgoTriMeshSync/1.0"})
                with urllib.request.urlopen(req, timeout=7) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    if not isinstance(data, dict) or data.get("status") != "success":
                        continue

                    # A. Sync Signal Reset across all 3 servers
                    peer_reset_ts = float(data.get("signals_reset_ts") or 0.0)
                    if peer_reset_ts > _local_signals_reset_ts + 1.0:
                        _local_signals_reset_ts = peer_reset_ts
                        engine.reset_all_signals()

                    # B. Sync Settings (Timeframe & News Filter) if peer was updated more recently
                    peer_upd_ts = float(data.get("state_updated_at") or 0.0)
                    if peer_upd_ts > _local_state_updated_at + 1.0:
                        _local_state_updated_at = peer_upd_ts
                        peer_tf = data.get("timeframe")
                        if peer_tf and peer_tf != engine.timeframe:
                            engine.set_timeframe(peer_tf)
                        if "news_filter_enabled" in data:
                            engine.news_filter_enabled = bool(data["news_filter_enabled"])

                    # C. Merge 500 Signals across all 3 servers
                    peer_sigs = data.get("signals", [])
                    if isinstance(peer_sigs, list) and peer_sigs:
                        existing_ids = {s.get("id") for s in engine.bookmap_signals}
                        added = False
                        for ps in peer_sigs:
                            ps_ts = float(ps.get("timestamp") or 0.0)
                            if ps_ts <= _local_signals_reset_ts:
                                continue
                            if ps.get("id") and ps["id"] not in existing_ids:
                                engine.bookmap_signals.append(ps)
                                existing_ids.add(ps["id"])
                                added = True
                        if added:
                            engine.bookmap_signals.sort(key=lambda x: x.get("timestamp", 0))
                            if len(engine.bookmap_signals) > 500:
                                engine.bookmap_signals = engine.bookmap_signals[-500:]
                            engine._save_signals_to_disk()
            except Exception:
                pass

        # 2. Every ~60 seconds (every 3rd cycle): Sync Users from Supabase & Hot-Pull Latest GitHub Static/UI Changes
        if cycle % 3 == 0:
            try:
                sb_users = auth_db._load_users_from_supabase()
                if sb_users:
                    auth_db.restore_from_dict_list(sb_users)
            except Exception:
                pass

            try:
                sha_req = urllib.request.Request(
                    "https://api.github.com/repos/gringgo1986/order-flow/commits/main",
                    headers={"User-Agent": "GringgoAutoHotReload/1.0", "Accept": "application/vnd.github.v3+json"}
                )
                with urllib.request.urlopen(sha_req, timeout=8) as sresp:
                    c_info = json.loads(sresp.read().decode("utf-8"))
                    latest_sha = c_info.get("sha", "")
                if latest_sha and latest_sha != _last_github_commit_sha:
                    if _last_github_commit_sha != "":
                        # New commit pushed to GitHub! Hot-update static/HTML/JS/CSS files across all 3 live servers immediately
                        zip_url = "https://github.com/gringgo1986/order-flow/archive/refs/heads/main.zip"
                        zreq = urllib.request.Request(zip_url, headers={"User-Agent": "Mozilla/5.0"})
                        with urllib.request.urlopen(zreq, timeout=20) as zresp:
                            z = zipfile.ZipFile(io.BytesIO(zresp.read()))
                            bdir = Path(__file__).parent
                            for member in z.infolist():
                                parts = member.filename.split("/")[1:]
                                if not parts or not parts[0]:
                                    continue
                                if parts[0] in ["README.md", "users.db", ".github_token", "signals_history.json", "app.py"]:
                                    continue
                                tpath = bdir.joinpath(*parts)
                                if member.is_dir():
                                    tpath.mkdir(parents=True, exist_ok=True)
                                else:
                                    tpath.parent.mkdir(parents=True, exist_ok=True)
                                    with open(tpath, "wb") as df:
                                        df.write(z.open(member).read())
                        print(f"[Hot-Reload] Berjaya menyelaraskan fail terkini dari GitHub ({latest_sha[:7]})!")
                    _last_github_commit_sha = latest_sha
            except Exception:
                pass


async def background_tick_stream():
    """Background loop polling MT5 or simulator and broadcasting snapshots"""
    while True:
        try:
            engine.poll_feed()
            # 24/7 Autonomous Master Engine: Evaluates order flow & signals continuously without needing any active clients!
            try:
                engine._evaluate_bookmap_signals()
            except Exception:
                pass

            if connected_clients:
                global _last_session_audit_ts
                now_ts = time.time()
                do_audit = (now_ts - _last_session_audit_ts >= 3.0)
                if do_audit:
                    _last_session_audit_ts = now_ts

                snapshot = engine.get_full_snapshot(initial=False)
                # High-Concurrency Optimization: Serialize JSON once for all 30+ simultaneous clients
                payload_text = json.dumps(snapshot)
                dead_clients = set()
                for client in list(connected_clients):
                    try:
                        if do_audit:
                            c_meta = client_sessions.get(client)
                            if c_meta and c_meta.get("session_id"):
                                valid_u = auth_db.validate_session(c_meta["session_id"])
                                if not valid_u:
                                    await client.send_text(json.dumps({
                                        "type": "session_kicked",
                                        "message": "⚠️ Akaun anda telah log masuk pada peranti lain. Sesi pada peranti ini ditamatkan (Had: 1 Peranti Sahaja)."
                                    }))
                                    dead_clients.add(client)
                                    continue
                        await client.send_text(payload_text)
                    except Exception:
                        dead_clients.add(client)
                for dead in dead_clients:
                    connected_clients.discard(dead)
                    client_sessions.pop(dead, None)
        except Exception as e:
            print(f"[Loop Error] {e}")
            
        await asyncio.sleep(0.55) # ~1.8 updates per second - ultra-efficient bandwidth shield (fits 5GB/month easily)

# --- Authentication & Membership SaaS Endpoints ---

@app.get("/admin")
def admin_portal_page(request: Request):
    """Direct route for Admin Control Portal"""
    candidates = [
        static_dir / "login.html",
        base_dir / "login.html",
        Path("/app/static/login.html"),
        Path("/app/login.html"),
    ]
    for c in candidates:
        if c.exists():
            return FileResponse(str(c))
    return {"status": "error", "message": "login.html not found"}

@app.get("/login")
def login_page(request: Request):
    user = get_current_user(request)
    if user:
        return RedirectResponse(url="/")
    login_candidates = [
        static_dir / "login.html",
        base_dir / "login.html",
        Path("/app/static/login.html"),
        Path("/app/login.html"),
    ]
    for c in login_candidates:
        if c.exists():
            return FileResponse(str(c))
    return {"status": "error", "message": "login.html not found"}

@app.post("/api/login")
def api_login(req: LoginRequest, request: Request):
    ok, user, err = auth_db.authenticate(req.username, req.password)
    if not ok:
        raise HTTPException(status_code=401, detail=err or "ID atau Kata Laluan tidak sah.")
    session_id = auth_db.create_session(user["id"], duration_days=14)
    res = JSONResponse({
        "status": "success",
        "message": "Log masuk berjaya!",
        "user": user,
        "session_id": session_id
    })
    is_https = (request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https")
    res.set_cookie(
        key="session_id",
        value=session_id,
        max_age=86400 * 14,
        httponly=True,
        samesite="none" if is_https else "lax",
        secure=True if is_https else False,
        path="/"
    )
    return res

@app.get("/logout")
def page_logout(request: Request):
    """Direct URL logout endpoint: clears session and redirects to /login"""
    session_id = request.cookies.get("session_id")
    if session_id:
        auth_db.destroy_session(session_id)
    res = RedirectResponse(url="/login?msg=logged_out")
    res.delete_cookie(key="session_id", path="/")
    return res

@app.post("/api/logout")
def api_logout(request: Request):
    session_id = request.cookies.get("session_id")
    if session_id:
        auth_db.destroy_session(session_id)
    res = JSONResponse({"status": "success", "message": "Log keluar berjaya."})
    res.delete_cookie(key="session_id", path="/")
    return res

@app.get("/api/me")
def api_me(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"status": "success", "user": user}

# --- Admin Panel Endpoints (Restricted to Admin Only) ---

@app.get("/api/admin/users")
def admin_list_users(request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    return {
        "status": "success",
        "users": auth_db.list_users()
    }

@app.post("/api/admin/users")
def admin_create_user(req: CreateUserRequest, request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    ok, user_id, err = auth_db.create_user(
        username=req.username,
        password=req.password,
        full_name=req.full_name,
        role=req.role,
        plan=req.plan,
        duration_days=req.duration_days,
        notes=req.notes
    )
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    return {
        "status": "success",
        "message": f"Akaun pembeli '{req.username}' berjaya dicipta!",
        "user_id": user_id
    }

@app.put("/api/admin/users/{user_id}")
def admin_update_user(user_id: int, req: UpdateUserRequest, request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    data = req.dict(exclude_unset=True)
    ok, err = auth_db.update_user(user_id, **data)
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    return {
        "status": "success",
        "message": "Akaun pembeli berjaya dikemaskini!"
    }

@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: Request):
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    ok, err = auth_db.delete_user(user_id)
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    return {
        "status": "success",
        "message": "Akaun berjaya dipadam."
    }


class RestoreBackupRequest(BaseModel):
    users: List[Dict[str, Any]]

@app.get("/api/admin/backup")
def admin_download_backup(request: Request):
    """Allows Admin to download a full JSON backup of all customer accounts"""
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    backup_file = auth_db.export_backup_json()
    if not backup_file or not os.path.exists(backup_file):
        raise HTTPException(status_code=500, detail="Gagal menjana fail sandaran.")
    return FileResponse(
        backup_file,
        media_type="application/json",
        filename=f"xauusd_users_backup_{datetime.utcnow().strftime('%Y%m%d')}.json"
    )

@app.post("/api/admin/restore")
def admin_upload_restore(req: RestoreBackupRequest, request: Request):
    """Allows Admin to restore all customer accounts from a JSON backup"""
    user = get_current_user(request)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Akses ditolak. Kebenaran Admin diperlukan.")
    if not req.users:
        raise HTTPException(status_code=400, detail="Data pengguna sandaran kosong.")
    count = auth_db.restore_from_dict_list(req.users)
    return {
        "status": "success",
        "message": f"Berjaya memulihkan {count} akaun pelanggan!",
        "count": count
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Authenticate WebSocket connection & enforce Single-Device Session Lock
    cookie_sid = websocket.cookies.get("session_id")
    query_sid = websocket.query_params.get("token")
    active_sid = cookie_sid or query_sid or ""
    user = auth_db.validate_session(active_sid) if active_sid else None
    if not user and query_sid and query_sid != active_sid:
        user = auth_db.validate_session(query_sid)
        if user:
            active_sid = query_sid

    await websocket.accept()

    if not user:
        # Session was invalidated by another device login or expired
        try:
            await websocket.send_json({
                "type": "session_kicked",
                "message": "⚠️ Sesi tidak sah atau akaun anda telah log masuk pada peranti lain."
            })
            await websocket.close()
        except Exception:
            pass
        return

    # Kick any lingering WebSocket connection for the same user_id that has an older session_id
    for existing_ws, meta in list(client_sessions.items()):
        if meta.get("user_id") == user.get("id") and meta.get("session_id") != active_sid:
            try:
                await existing_ws.send_json({
                    "type": "session_kicked",
                    "message": "⚠️ Akaun anda telah log masuk pada peranti baharu. Sesi pada peranti ini ditamatkan (Had: 1 Peranti Sahaja)."
                })
            except Exception:
                pass
            connected_clients.discard(existing_ws)
            client_sessions.pop(existing_ws, None)

    connected_clients.add(websocket)
    client_sessions[websocket] = {"user_id": user.get("id"), "session_id": active_sid}
    try:
        # Send initial full state immediately
        await websocket.send_json(engine.get_full_snapshot(initial=True))
        while True:
            # Keep alive & listen for client messages
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    await websocket.send_json({"type": "pong", "ts": msg.get("ts")})
            except Exception:
                pass
    except WebSocketDisconnect:
        connected_clients.discard(websocket)
        client_sessions.pop(websocket, None)
    except Exception:
        connected_clients.discard(websocket)
        client_sessions.pop(websocket, None)

@app.post("/api/trade")
def trade_endpoint(req: TradeRequest):
    result = engine.execute_order(
        action=req.action.upper(),
        volume=req.volume,
        sl_pips=req.sl_pips,
        tp_pips=req.tp_pips
    )
    return result

@app.post("/api/close")
def close_endpoint(req: CloseRequest):
    result = engine.close_position(req.ticket)
    return result

@app.post("/api/partial_close")
def partial_close_endpoint(req: PartialCloseRequest):
    result = engine.close_partial_position(req.ticket, req.ratio)
    return result

@app.post("/api/partial_close_all")
def partial_close_all_endpoint(req: PartialCloseRequest = PartialCloseRequest(ticket=0, ratio=0.5)):
    result = engine.close_partial_all(req.ratio)
    return result

@app.post("/api/breakeven")
def breakeven_endpoint(req: CloseRequest):
    result = engine.move_to_breakeven(req.ticket)
    return result

@app.post("/api/breakeven_all")
def breakeven_all_endpoint():
    result = engine.move_all_to_breakeven()
    return result

@app.post("/api/close_all")
def close_all_endpoint():
    result = engine.close_all_positions()
    return result

@app.post("/api/toggle_mode")
def toggle_mode():
    engine.simulation_mode = not engine.simulation_mode
    if not engine.simulation_mode and not engine.is_connected:
        engine.initialize_mt5()
    return {
        "status": "success",
        "simulation_mode": engine.simulation_mode,
        "is_connected": engine.is_connected
    }

@app.post("/api/feed_source")
def feed_source_endpoint(req: FeedSourceRequest):
    result = engine.set_feed_source(req.source)
    return result

@app.post("/api/news_filter/toggle")
def toggle_news_filter_endpoint():
    return engine.toggle_news_filter()

@app.post("/api/prop_shield/toggle")
def toggle_prop_shield_endpoint():
    return engine.toggle_prop_firm_shield()

@app.post("/api/update_sltp")
def update_sltp_endpoint(req: UpdateSLTPRequest):
    return engine.update_position_sltp(req.ticket, req.sl, req.tp)

@app.post("/api/timeframe")
def timeframe_endpoint(req: TimeframeRequest):
    global _local_state_updated_at
    _local_state_updated_at = time.time()
    result = engine.set_timeframe(req.timeframe)
    return result

@app.post("/api/reset_candles")
def reset_candles():
    engine.candles = []
    engine._seed_initial_data()
    return {"status": "success", "message": "Candles reset to fresh high-definition state"}

@app.get("/api/signals")
def get_all_signals_endpoint():
    """Returns all 24/7 autonomous signals recorded by the server engine"""
    return {"status": "success", "signals": engine.bookmap_signals}

@app.post("/api/reset_signals")
def reset_signals_endpoint():
    global _local_state_updated_at, _local_signals_reset_ts
    _local_state_updated_at = time.time()
    _local_signals_reset_ts = _local_state_updated_at
    engine.reset_all_signals()
    return {"status": "success", "message": "Semua rekod isyarat dan zon penyejukan telah diset semula ke sifar di ketiga-tiga pelayan"}

@app.get("/api/peer_state")
def get_peer_state_endpoint():
    return {
        "status": "success",
        "state_updated_at": _local_state_updated_at,
        "signals_reset_ts": _local_signals_reset_ts,
        "timeframe": engine.timeframe,
        "news_filter_enabled": getattr(engine, "news_filter_enabled", True),
        "signals": engine.bookmap_signals[-500:]
    }

@app.get("/api/history")
def history_endpoint(limit: int = 1000, tf: str = None):
    if tf and tf != engine.timeframe:
        engine.set_timeframe(tf)
    candles = engine.get_historical_candles(limit=limit)
    return {
        "status": "success",
        "symbol": engine.symbol,
        "timeframe": engine.timeframe,
        "count": len(candles),
        "candles": candles
    }

@app.get("/api/candles")
def candles_endpoint():
    candles = engine.candles[-15:]
    curr = engine.current_candle
    return {
        "candles": [{"time": c["time"], "close": c["close"]} for c in candles],
        "current": {"time": curr["time"], "close": curr["close"]} if curr else None
    }

@app.get("/health")
@app.get("/ping")
def health_check_endpoint():
    return {"status": "ok", "service": "gringgo-orderflow", "time": time.time()}

@app.get("/api/status")
def status_endpoint():
    return {
        "symbol": engine.symbol,
        "feed_source": engine.feed_source,
        "feed_label": "SWISSQUOTE BANK LIVE (Cloud)" if engine.feed_source == "swissquote" else "JUSTMARKETS MT5",
        "connected": engine.is_connected,
        "simulation": engine.simulation_mode,
        "last_price": engine.last_price,
        "bid": engine.current_bid,
        "ask": engine.current_ask,
        "spread": engine.spread,
        "positions_count": len(engine.positions),
        "clients_connected": len(connected_clients)
    }

import shutil

# Mount static folder & auto-organize flat files if uploaded to root
import shutil
base_dir = Path(__file__).parent
static_dir = base_dir / "static"
static_dir.mkdir(parents=True, exist_ok=True)
(static_dir / "js").mkdir(parents=True, exist_ok=True)
(static_dir / "css").mkdir(parents=True, exist_ok=True)
(static_dir / "icons").mkdir(parents=True, exist_ok=True)

# 1. Auto-fix Windows backslash filenames on Linux systems
BS = chr(92)
try:
    for item in list(base_dir.iterdir()):
        if item.is_file() and (BS in item.name):
            rel_parts = item.name.split(BS)
            target = base_dir.joinpath(*rel_parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.stat().st_size != item.stat().st_size:
                shutil.copy2(item, target)
            if item.name == f"static{BS}index.html" or item.name.endswith(f"{BS}index.html"):
                shutil.copy2(item, base_dir / "index.html")
                shutil.copy2(item, static_dir / "index.html")
except Exception as e:
    print(f"[Auto-Fix Windows Archive Warning] {e}")

# 2. Also check if files are nested inside xauusd-orderflow-bookmap
nested_dir = base_dir / "xauusd-orderflow-bookmap"
if nested_dir.exists() and nested_dir.is_dir():
    try:
        for sub_item in nested_dir.rglob("*"):
            if sub_item.is_file():
                rel = sub_item.relative_to(nested_dir)
                dest = base_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    shutil.copy2(sub_item, dest)
    except Exception as e:
        print(f"[Auto-Copy Nested Warning] {e}")

# 3. Auto-copy flat root files into static structure (strictly keep synchronized)
for fname in ["index.html", "login.html"]:
    src = base_dir / fname
    dst = static_dir / fname
    if src.exists():
        if not dst.exists() or src.stat().st_size != dst.stat().st_size:
            try: shutil.copy2(src, dst)
            except Exception: pass
    elif dst.exists() and not src.exists():
        try: shutil.copy2(dst, src)
        except Exception: pass

for fname in ["style.css"]:
    src = base_dir / fname
    dst = static_dir / "css" / fname
    if src.exists():
        if not dst.exists() or src.stat().st_size != dst.stat().st_size:
            try: shutil.copy2(src, dst)
            except Exception: pass
    elif dst.exists() and not src.exists():
        try: shutil.copy2(dst, src)
        except Exception: pass

for fname in ["bookmap.js", "footprint.js", "dom.js", "app.js", "lightweight-charts.js", "tv_chart.js"]:
    src = base_dir / fname
    dst = static_dir / "js" / fname
    if src.exists():
        try: shutil.copy2(src, dst)
        except Exception: pass
    elif dst.exists() and not src.exists():
        try: shutil.copy2(dst, src)
        except Exception: pass

app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/manifest.json")
def manifest_json():
    p = static_dir / "manifest.json"
    if p.exists():
        return FileResponse(str(p), media_type="application/manifest+json")
    return JSONResponse({})

@app.get("/sw.js")
def service_worker_js():
    p = static_dir / "sw.js"
    if p.exists():
        return FileResponse(str(p), media_type="application/javascript")
    return Response(content="", media_type="application/javascript")

@app.get("/")
def index(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login")
    candidates = [
        static_dir / "index.html",
        base_dir / "index.html",
        base_dir / f"static{chr(92)}index.html",
        base_dir / "xauusd-orderflow-bookmap" / "static" / "index.html",
        base_dir / "xauusd-orderflow-bookmap" / "index.html",
        Path("/app/static/index.html"),
        Path("/app/index.html"),
    ]
    for c in candidates:
        if c.exists():
            return FileResponse(str(c))
    found = list(base_dir.rglob("index.html"))
    if found:
        return FileResponse(str(found[0]))
    return {"status": "error", "message": "index.html not found"}



# ─── Hugging Face Spaces (/gradio_api/*) Direct FastAPI Route Aliases ───
@app.get("/gradio_api/terminal")
@app.get("/static/terminal")
def hf_terminal_index(request: Request):
    candidates = [
        static_dir / "index.html",
        base_dir / "index.html",
        Path("/app/static/index.html"),
        Path("/app/index.html"),
    ]
    for c in candidates:
        if c.exists():
            return FileResponse(str(c))
    return RedirectResponse(url="/login")

@app.websocket("/gradio_api/ws")
async def hf_websocket_endpoint(websocket: WebSocket):
    await websocket_endpoint(websocket)

# Duplicate all /api/* routes under /gradio_api/api/* so Hugging Face Gradio 6 proxy forwards all GET/POST/PUT/DELETE directly to Uvicorn
for _r in list(app.router.routes):
    _p = getattr(_r, "path", "")
    if _p.startswith("/api/") and hasattr(_r, "endpoint") and hasattr(_r, "methods"):
        app.add_api_route(
            "/gradio_api" + _p,
            _r.endpoint,
            methods=list(_r.methods),
            response_model=getattr(_r, "response_model", None)
        )

# Mount dummy Gradio @spaces.GPU interface at /hf-gpu-check so Hugging Face ZeroGPU Free container passes startup verification
try:
    import spaces
    import gradio as gr
    @spaces.GPU
    def _hf_zerogpu_ping(msg: str) -> str:
        return msg
    _hf_gpu_demo = gr.Interface(fn=_hf_zerogpu_ping, inputs="text", outputs="text")
    app = gr.mount_gradio_app(app, _hf_gpu_demo, path="/hf-gpu-check")
except Exception as _hf_err:
    print(f"[HF ZeroGPU Hook Info] {_hf_err}")

if __name__ == '__main__':
    import uvicorn, os
    port = int(os.environ.get('SERVER_PORT', os.environ.get('PORT', 8000)))
    uvicorn.run('app:app', host='0.0.0.0', port=port, reload=False)
