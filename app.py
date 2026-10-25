"""
FastAPI Server & WebSocket Hub for XAUUSD Bookmap & Order Flow
"""
import asyncio
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
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
for fname in ["index.html"]:
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
def index():
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
