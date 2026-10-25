"""
FastAPI Server & WebSocket Hub for XAUUSD Bookmap & Order Flow
"""
import asyncio
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel
import auth_db

from mt5_engine import OrderFlowEngine

app = FastAPI(title="XAUUSD Order Flow & Bookmap Pro")

# Prevent static file & HTML aggressive browser caching during trading
@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Instantiate Order Flow Engine
engine = OrderFlowEngine(symbol="XAUUSD.m")

# Connected WebSocket clients
connected_clients = set()

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

async def background_tick_stream():
    """Background loop polling MT5 or simulator and broadcasting snapshots"""
    while True:
        try:
            engine.poll_feed()
            if connected_clients:
                snapshot = engine.get_full_snapshot()
                # Broadcast to all active browser connections
                dead_clients = set()
                for client in connected_clients:
                    try:
                        await client.send_json(snapshot)
                    except Exception:
                        dead_clients.add(client)
                for dead in dead_clients:
                    connected_clients.remove(dead)
        except Exception as e:
            print(f"[Loop Error] {e}")
            
        await asyncio.sleep(0.12) # ~8-10 updates per second for ultra smooth Bookmap visual

# --- Authentication & Membership SaaS Endpoints ---

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
def api_login(req: LoginRequest):
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
    res.set_cookie(
        key="session_id",
        value=session_id,
        max_age=86400 * 14,
        httponly=True,
        samesite="lax",
        path="/"
    )
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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Authenticate WebSocket connection
    session_id = websocket.cookies.get("session_id")
    user = auth_db.validate_session(session_id) if session_id else None
    if not user:
        token = websocket.query_params.get("token")
        if token:
            user = auth_db.validate_session(token)
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    connected_clients.add(websocket)
    try:
        # Send initial full state immediately
        await websocket.send_json(engine.get_full_snapshot())
        while True:
            # Keep alive & listen for client messages
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(websocket)
    except Exception:
        connected_clients.discard(websocket)

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
    result = engine.set_timeframe(req.timeframe)
    return result

@app.post("/api/reset_candles")
def reset_candles():
    engine.candles = []
    engine._seed_initial_data()
    return {"status": "success", "message": "Candles reset to fresh high-definition state"}

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
base_dir = Path(__file__).parent
static_dir = base_dir / "static"
static_dir.mkdir(parents=True, exist_ok=True)
(static_dir / "js").mkdir(parents=True, exist_ok=True)
(static_dir / "css").mkdir(parents=True, exist_ok=True)

# Auto-copy flat root files into static structure
for fname in ["index.html", "login.html"]:
    src = base_dir / fname
    dst = static_dir / fname
    if src.exists() and not dst.exists():
        try: shutil.copy2(src, dst)
        except Exception: pass

for fname in ["style.css"]:
    src = base_dir / fname
    dst = static_dir / "css" / fname
    if src.exists() and not dst.exists():
        try: shutil.copy2(src, dst)
        except Exception: pass

for fname in ["bookmap.js", "footprint.js", "dom.js", "app.js"]:
    src = base_dir / fname
    dst = static_dir / "js" / fname
    if src.exists() and not dst.exists():
        try: shutil.copy2(src, dst)
        except Exception: pass

app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
def index(request: Request):
    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login")
    candidates = [
        static_dir / "index.html",
        base_dir / "index.html",
        Path("/app/static/index.html"),
        Path("/app/index.html"),
    ]
    for c in candidates:
        if c.exists():
            return FileResponse(str(c))
    return {"status": "error", "message": "index.html not found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
