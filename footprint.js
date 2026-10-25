/**
 * Professional Institutional Order Flow Footprint Canvas Renderer
 * Features:
 *  - 0% Overlap Tile-based Price Buckets
 *  - Multi-View Footprint: Bid x Ask | Delta Profile | Volume Profile
 *  - Value Area (VAH 70% & VAL 70%) Shading & Dotted Levels
 *  - Institutional Stacked Imbalances Detector (3+ Consecutive Diagonal Sweeps)
 *  - Point of Control (POC) Golden High-Volume Focus
 *  - Unfinished Auction / Auction Failure Indicators
 *  - Sierra Chart / ATAS Style 4-Row Statistics Footer (Vol, Delta, Delta %, Min/Max Delta)
 *  - Interactive Tooltip & Dynamic Vertical / Horizontal Zoom
 */

class FootprintRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    
    // Geometry & Display Settings
    this.candleWidth = 145; 
    this.candleSpacing = 24;
    this.clusterStep = 1.00; // Default $1.00 step on Gold
    this.verticalZoom = 1.0;
    
    // View Modes: 'bid_ask' | 'delta' | 'volume' | 'clusterdelta' | 'candlestick'
    this.viewMode = 'bid_ask';
    this.timeframe = 'M1';
    
    // ClusterDelta Pro Sub-Settings (Adjustable 20-50 Jalur / Columns & Price Rows)
    this.cdCellMode = 'volume'; // 'volume' | 'delta' | 'bid_ask' | 'imbalance'
    this.cdShowPocLine = true;
    this.cdShowPocMigration = true; // Stepped POC Migration Flow Line (Value Acceptance)
    this.cdShowStackedImb = true;   // Stacked 3x Diagonal Imbalances Highlighter
    this.cdShowClimax = true;       // Delta Climax & Exhaustion Absorption Callouts
    this.cdShowZoneRays = true;
    this.cdShowBenchmarks = true;
    this.cdShowSignals = true;
    this.cdShowSNR = true; // H1, H4 & H8 Support and Resistance Levels
    this.cdVisibleCols = 30; // Adjustable between 20 and 50 jalur
    this.cdMaxRows = 30;     // Adjustable between 20 and 50 baris
    this.cdToolbarHitboxes = [];
    this._cdConfirmedSignalsCache = new Map(); // Permanent cache: c.time -> signal data (Prevents flickering & repainting)

    // Pro Candlestick Chart Sub-Settings
    this.csVisibleBars = 34;
    this.csShowEMA = true;
    this.csShowVWAP = true;
    this.csShowLevels = true;
    this.csShowSignals = true;
    this.csVerticalScale = 1.0;

    // Deep Historical Buffer (1,000+ bars across timeframes)
    this.allCandles = [];

    // Market Replay / Backtesting Engine State
    this.isReplayMode = false;
    this.replayIndex = 0;       // Current bar index displayed in replay
    this.replayPlaying = false;
    this.replaySpeed = 5;       // 1x, 2x, 5x, 10x
    this.replayTimer = null;
    this.replayTrades = [];     // Simulated trades placed during backtest
    this.replayBalance = 10000.0;
    this.onReplayUpdate = null; // UI callback
    this._confirmedSignalsCache = new Map(); // Permanent cache: c.time -> signal data (Prevents flickering & repainting)
    
    // 7 Independent Pro Trading Techniques (Can be toggled ON/OFF independently)
    this.csTechniques = {
      smc: true,       // 1. SMC Liquidity Sweep (Asian/London/PDH/PDL Turtle Soup)
      of_absorb: true, // 2. Order Flow Delta Absorption & Wick Divergence
      vwap_band: true, // 3. VWAP ±2σ Extreme Band Bounce (Mean Reversion)
      ema_trend: true, // 4. EMA Ribbon Momentum Pullback (Trend Following)
      vp_retest: true, // 5. Volume Profile dPOC & Value Area Retest
      snr: true,       // 6. Classic & Role-Reversal Support & Resistance (RBS/SBR)
      snd: true        // 7. Supply & Demand Fresh Zones (DBR/RBD/RBR/DBD FTB)
    };

    // Universal 2D Pan (Vertical + Horizontal) & Scale State across Footprint, ClusterDelta & Candlestick
    this.priceOffset = 0.0;
    this.barOffset = 0; // Number of candles scrolled back in history (0 = live latest candle)
    this._isDragging = false;
    this._dragMode = null; // 'pan' | 'scale'
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartOffset = 0;
    this._dragStartBarOffset = 0;
    this._dragStartZoom = 1.0;
    
    // Feature Toggles
    this.showValueArea = true;
    this.showStackedImbalances = true;
    this.showSessionLevels = true;
    this.showSVP = true;
    this.showIcebergs = true;
    this.showWickAbsorption = true;   // NEW: Extreme Wick Absorption Detector (Trapped Traders)
    this.showCandleDeltaDiv = true;   // NEW: Candle Delta Divergence (Δ DIV)
    this.showFpsignals = true;        // NEW: Strict Location-First Footprint Signals at SNR
    this.imbThreshold = 3.0;          // NEW: 3.0 (300% Standard) | 4.0 (400% Whale)
    this.fpToolbarHitboxes = [];      // NEW: Top HUD Interactive Hitboxes
    this._fpConfirmedSignals = [];    // NEW: Confirmed signals history
    this._fpLastSignalBarTime = 0;
    this._fpLastSignalDir = null;
    
    this.minPrice = 4120.0;
    this.maxPrice = 4130.0;
    
    // Hover state
    this.hoverCell = null;
    this.mousePos = { x: -1, y: -1 };

    this._setupResize();
    this._setupInteractiveControls();
  }

  _setupResize() {
    const resize = () => {
      if (!this.canvas || !this.canvas.parentElement) return;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.width = Math.max(rect.width, 600);
      this.height = Math.max(rect.height, 300);
      this.canvas.width = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
    setTimeout(resize, 350);
  }

  _setupInteractiveControls() {
    // Click & Drag Vertical Pan (Chart Area) + Vertical Scale Stretch (Right Price Axis)
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // Ignore drag if clicking on top interactive header strip
      if ((this.viewMode === 'clusterdelta' && cy <= 26) || (this.viewMode === 'candlestick' && cy <= 30)) {
        return;
      }

      this._isDragging = true;
      this._dragStartX = cx;
      this._dragStartY = cy;
      this._dragStartOffset = this.priceOffset || 0;
      this._dragStartBarOffset = this.barOffset || 0;
      this._dragStartZoom = this.viewMode === 'candlestick' ? (this.csVerticalScale || 1.0) : (this.verticalZoom || 1.0);

      const rightScaleBoundary = this.viewMode === 'clusterdelta' ? (this.width - 70) : (this.width - 75);
      if (cx >= rightScaleBoundary) {
        this._dragMode = 'scale';
        this.canvas.style.cursor = 'ns-resize';
      } else {
        this._dragMode = 'pan';
        this.canvas.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mouseup', () => {
      if (this._isDragging) {
        this._isDragging = false;
        this._dragMode = null;
        this.canvas.style.cursor = 'grab';
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const cy = e.clientY - rect.top;
      if (cy > 30) {
        this.centerVertical();
      }
    });

    // Mouse wheel zoom (or vertical pan when holding Shift / Alt)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        this.panVertical(e.deltaY < 0 ? 1 : -1);
      } else if (e.deltaY < 0) {
        this.zoomIn();
      } else {
        this.zoomOut();
      }
    }, { passive: false });

    // Mouse move & hover tooltip + live drag panning
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };

      if (this._isDragging) {
        const dx = this.mousePos.x - this._dragStartX;
        const dy = this.mousePos.y - this._dragStartY;
        if (this._dragMode === 'scale') {
          if (this.viewMode === 'candlestick') {
            this.csVerticalScale = Math.max(0.4, Math.min(3.5, this._dragStartZoom - dy * 0.006));
          } else {
            this.verticalZoom = Math.max(0.5, Math.min(4.0, this._dragStartZoom - dy * 0.006));
          }
          this.canvas.style.cursor = 'ns-resize';
        } else {
          // 1. Vertical Pan: dragging mouse DOWN (+dy) moves viewport UP to higher prices (+priceOffset)
          const approxRange = Math.max(3.0, (this.maxPrice - this.minPrice) || 8.0);
          const dPrice = (dy / Math.max(180, this.height - 100)) * approxRange;
          this.priceOffset = Number((this._dragStartOffset + dPrice).toFixed(2));

          // 2. Horizontal Pan: dragging mouse RIGHT (+dx) scrolls LEFT into older historical candles (+barOffset)
          let barPx = 50;
          if (this.viewMode === 'clusterdelta') {
            barPx = Math.max(16, (this.width - 204) / Math.max(20, this.cdVisibleCols || 30));
          } else if (this.viewMode === 'candlestick') {
            barPx = Math.max(12, (this.width - 68) / Math.max(14, this.csVisibleBars || 34));
          } else {
            barPx = Math.max(45, (this.width - 170) / 10);
          }
          const dBars = Math.round(dx / barPx);
          this.barOffset = Math.max(0, this._dragStartBarOffset + dBars);

          this.canvas.style.cursor = 'grabbing';
        }
        return;
      }

      // Pointer cursor when hovering over interactive header pills
      if ((this.viewMode === 'clusterdelta' || this.viewMode === 'candlestick') && this.cdToolbarHitboxes && this.cdToolbarHitboxes.length > 0) {
        const hit = this.cdToolbarHitboxes.some(
          b => this.mousePos.x >= b.x && this.mousePos.x <= b.x + b.w &&
               this.mousePos.y >= b.y && this.mousePos.y <= b.y + b.h
        );
        if (hit) {
          this.canvas.style.cursor = 'pointer';
          return;
        }
      } else if (this.fpToolbarHitboxes && this.fpToolbarHitboxes.length > 0) {
        const hit = this.fpToolbarHitboxes.some(
          b => this.mousePos.x >= b.x && this.mousePos.x <= b.x + b.w &&
               this.mousePos.y >= b.y && this.mousePos.y <= b.y + b.h
        );
        if (hit) {
          this.canvas.style.cursor = 'pointer';
          return;
        }
      }

      const rightScaleBoundary = this.viewMode === 'clusterdelta' ? (this.width - 70) : (this.width - 75);
      if (this.mousePos.y > 30 && this.mousePos.x >= rightScaleBoundary) {
        this.canvas.style.cursor = 'ns-resize';
      } else {
        this.canvas.style.cursor = 'grab';
      }
    });

    // Click handler for interactive header controls & Drawing Tools
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (window.app && window.app.drawingMode) {
        if (window.app._handleCanvasClickForDrawing(cx, cy, this.canvas)) return;
      }
      if (this.viewMode === 'clusterdelta' || this.viewMode === 'candlestick') {
        if (!this.cdToolbarHitboxes) return;
        for (const b of this.cdToolbarHitboxes) {
          if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
            if (b.onClick) b.onClick();
            break;
          }
        }
      } else if (this.fpToolbarHitboxes && this.fpToolbarHitboxes.length > 0) {
        for (const b of this.fpToolbarHitboxes) {
          if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
            if (b.onClick) b.onClick();
            break;
          }
        }
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mousePos = { x: -1, y: -1 };
      this.hoverCell = null;
      const tooltip = document.getElementById('chartTooltip');
      if (tooltip) tooltip.style.display = 'none';
    });
  }

  setViewMode(mode) {
    if (['bid_ask', 'delta', 'volume', 'clusterdelta', 'candlestick'].includes(mode)) {
      this.viewMode = mode;
    }
  }

  toggleValueArea() {
    this.showValueArea = !this.showValueArea;
    return this.showValueArea;
  }

  toggleStackedImbalances() {
    this.showStackedImbalances = !this.showStackedImbalances;
    return this.showStackedImbalances;
  }

  toggleSVP() {
    this.showSVP = !this.showSVP;
    return this.showSVP;
  }

  toggleIcebergs() {
    this.showIcebergs = !this.showIcebergs;
    return this.showIcebergs;
  }

  toggleSessionLevels() {
    this.showSessionLevels = !this.showSessionLevels;
    return this.showSessionLevels;
  }

  setClusterStep(step) {
    this.clusterStep = parseFloat(step) || 1.00;
  }

  setJalurCount(val) {
    const clamped = Math.max(20, Math.min(50, Math.round(parseFloat(val) || 30)));
    this.cdVisibleCols = clamped;
    this.cdMaxRows = clamped;
    const sl = document.getElementById('sliderClusterJalur');
    const lb = document.getElementById('lblClusterJalur');
    if (sl && parseInt(sl.value, 10) !== clamped) sl.value = String(clamped);
    if (lb) lb.textContent = String(clamped);
    return clamped;
  }

  setTimeframe(tf) {
    this.timeframe = (tf || 'M1').toUpperCase();
    if (this._confirmedSignalsCache) this._confirmedSignalsCache.clear();
  }

  setTechniqueMode(mode) {
    this.currentTechniqueMode = mode || 'all';
    if (!this.csTechniques) {
      this.csTechniques = { smc: true, of_absorb: true, vwap_band: true, ema_trend: true, vp_retest: true, snr: true, snd: true };
    }
    if (mode === 'all') {
      this.csTechniques = { smc: true, of_absorb: true, vwap_band: true, ema_trend: true, vp_retest: true, snr: true, snd: true };
      this.csShowSignals = true;
    } else if (mode === 'none') {
      this.csTechniques = { smc: false, of_absorb: false, vwap_band: false, ema_trend: false, vp_retest: false, snr: false, snd: false };
      this.csShowSignals = false;
    } else {
      this.csTechniques = {
        smc: mode === 'smc',
        of_absorb: mode === 'of_absorb',
        vwap_band: mode === 'vwap_band',
        ema_trend: mode === 'ema_trend',
        vp_retest: mode === 'vp_retest',
        snr: mode === 'snr',
        snd: mode === 'snd'
      };
      this.csShowSignals = true;
    }
    if (this._confirmedSignalsCache) {
      this._confirmedSignalsCache.clear();
    }
    const sel = document.getElementById('selectCsTechnique');
    if (sel && sel.value !== mode) {
      sel.value = mode;
    }
  }

  priceToY(price) {
    const fullRange = Math.max(0.5, this.maxPrice - this.minPrice);
    const zoomedRange = fullRange / Math.max(0.4, this.verticalZoom || 1.0);
    const centerP = (this.minPrice + this.maxPrice) / 2.0 + (this.priceOffset || 0);
    const viewMin = centerP - zoomedRange / 2.0;
    const ratio = (price - viewMin) / zoomedRange;
    return (this.height - 75) - (ratio * (this.height - 140));
  }

  yToPrice(y) {
    const fullRange = Math.max(0.5, this.maxPrice - this.minPrice);
    const zoomedRange = fullRange / Math.max(0.4, this.verticalZoom || 1.0);
    const centerP = (this.minPrice + this.maxPrice) / 2.0 + (this.priceOffset || 0);
    const viewMin = centerP - zoomedRange / 2.0;
    const usableH = Math.max(10, this.height - 140);
    const ratio = ((this.height - 75) - y) / usableH;
    return viewMin + ratio * zoomedRange;
  }

  addDrawing(d) {
    if (!this.manualDrawings) this.manualDrawings = [];
    this.manualDrawings.push(d);
  }

  clearDrawings() {
    this.manualDrawings = [];
  }

  _drawManualDrawings(ctx) {
    if (!this.manualDrawings || this.manualDrawings.length === 0) return;
    ctx.save();
    for (const d of this.manualDrawings) {
      if (d.type === 'ray') {
        let y = this.priceToY(d.price);
        // If in Candlestick mode, candlestick has its own pToY calculation
        if (this.viewMode === 'candlestick' && this._lastCandlePToY) {
          y = this._lastCandlePToY(d.price);
        }
        if (y < 25 || y > this.height - 30) continue;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = d.color || '#f59e0b';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.width - 70, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tag
        ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
        ctx.fillRect(this.width - 146, y - 7, 72, 14);
        ctx.strokeStyle = d.color || '#f59e0b';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(this.width - 146, y - 7, 72, 14);
        ctx.fillStyle = d.color || '#f59e0b';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`RAY $${d.price.toFixed(2)}`, this.width - 110, y + 3.5);
      } else if (d.type === 'trend' && d.p1 && d.p2) {
        let y1 = this.priceToY(d.p1.price);
        let y2 = this.priceToY(d.p2.price);
        if (this.viewMode === 'candlestick' && this._lastCandlePToY) {
          y1 = this._lastCandlePToY(d.p1.price);
          y2 = this._lastCandlePToY(d.p2.price);
        }
        ctx.strokeStyle = d.color || '#38bdf8';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(d.p1.x, y1);
        ctx.lineTo(d.p2.x, y2);
        ctx.stroke();

        ctx.fillStyle = d.color || '#38bdf8';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`TREND`, d.p2.x + 4, y2 + 3);
      }
    }
    ctx.restore();
  }

  panVertical(dir) {
    // dir > 0: pan UP to see higher prices, dir < 0: pan DOWN to see lower prices
    const step = Math.max(0.50, (this.clusterStep || 0.50) * 1.5);
    this.priceOffset = Number(((this.priceOffset || 0) + dir * step).toFixed(2));
  }

  panHorizontal(dir) {
    // dir < 0: pan LEFT (see older candles), dir > 0: pan RIGHT (back toward latest live candle)
    const stepBars = this.viewMode === 'clusterdelta' || this.viewMode === 'candlestick' ? 3 : 2;
    this.barOffset = Math.max(0, Math.round((this.barOffset || 0) - dir * stepBars));
  }

  centerVertical() {
    this.priceOffset = 0.0;
    this.barOffset = 0;
    this.csVerticalScale = 1.0;
  }

  _sliceCandlesWithOffset(rawCandles, count) {
    const total = rawCandles.length;
    if (total <= count) {
      this.barOffset = 0;
      return rawCandles.slice();
    }
    const maxOffset = Math.max(0, total - count);
    const offset = Math.max(0, Math.min(maxOffset, Math.round(this.barOffset || 0)));
    this.barOffset = offset;
    const endIdx = total - offset;
    const startIdx = Math.max(0, endIdx - count);
    return rawCandles.slice(startIdx, endIdx);
  }

  setHistoricalCandles(candles) {
    if (Array.isArray(candles) && candles.length > 0) {
      this.allCandles = candles;
      if (this.isReplayMode && this.replayIndex > this.allCandles.length) {
        this.replayIndex = this.allCandles.length;
      }
    }
  }

  mergeLiveCandles(snapshotCandles) {
    if (!Array.isArray(snapshotCandles) || snapshotCandles.length === 0) return;
    if (!this.allCandles || this.allCandles.length === 0) {
      this.allCandles = snapshotCandles.slice();
      return;
    }
    for (const sc of snapshotCandles) {
      const idx = this.allCandles.findIndex(c => c.time === sc.time);
      if (idx !== -1) {
        this.allCandles[idx] = sc;
      } else if (this.allCandles.length > 0 && sc.time > this.allCandles[this.allCandles.length - 1].time) {
        this.allCandles.push(sc);
        if (this.allCandles.length > 1500) {
          this.allCandles.shift();
        }
      }
    }
  }

  enterReplayMode(targetIndex) {
    if (!this.allCandles || this.allCandles.length === 0) return;
    this.isReplayMode = true;
    this.replayPlaying = false;
    if (this.replayTimer) { clearInterval(this.replayTimer); this.replayTimer = null; }
    this.replayTrades = [];
    if (targetIndex !== undefined) {
      this.replayIndex = Math.max(10, Math.min(this.allCandles.length, targetIndex));
    } else {
      this.replayIndex = Math.max(10, this.allCandles.length - 120);
    }
    this.barOffset = 0;
    this._notifyReplayUpdate();
  }

  exitReplayMode() {
    this.isReplayMode = false;
    this.replayPlaying = false;
    if (this.replayTimer) { clearInterval(this.replayTimer); this.replayTimer = null; }
    this.barOffset = 0;
    this._notifyReplayUpdate();
  }

  toggleReplayPlay() {
    if (this.replayPlaying) {
      this.replayPause();
    } else {
      this.replayPlay();
    }
  }

  replayPlay() {
    if (!this.isReplayMode) return;
    this.replayPlaying = true;
    if (this.replayTimer) clearInterval(this.replayTimer);
    const speed = this.replaySpeed || 5;
    const intervalMs = Math.max(80, Math.round(1000 / speed));
    this.replayTimer = setInterval(() => {
      if (this.replayIndex >= this.allCandles.length) {
        this.replayPause();
        return;
      }
      this.replayStepForward(1);
    }, intervalMs);
    this._notifyReplayUpdate();
  }

  replayPause() {
    this.replayPlaying = false;
    if (this.replayTimer) { clearInterval(this.replayTimer); this.replayTimer = null; }
    this._notifyReplayUpdate();
  }

  replayStepForward(n = 1) {
    if (!this.isReplayMode || !this.allCandles || this.allCandles.length === 0) return;
    this.replayIndex = Math.min(this.allCandles.length, this.replayIndex + n);
    this._checkReplayTrades();
    this._notifyReplayUpdate();
  }

  replayStepBack(n = 1) {
    if (!this.isReplayMode || !this.allCandles || this.allCandles.length === 0) return;
    this.replayIndex = Math.max(10, this.replayIndex - n);
    this._notifyReplayUpdate();
  }

  replayJumpTo(idx) {
    if (!this.isReplayMode || !this.allCandles || this.allCandles.length === 0) return;
    this.replayIndex = Math.max(10, Math.min(this.allCandles.length, idx));
    this._notifyReplayUpdate();
  }

  executeReplayTrade(action, volume = 0.01) {
    if (!this.isReplayMode || !this.allCandles || this.replayIndex < 1) return null;
    const bar = this.allCandles[this.replayIndex - 1];
    if (!bar) return null;
    const entryPrice = bar.close;
    const isBuy = action.toUpperCase() === 'BUY';
    const sl = Math.round((isBuy ? entryPrice - 3.0 : entryPrice + 3.0) * 100) / 100;
    const tp = Math.round((isBuy ? entryPrice + 6.0 : entryPrice - 6.0) * 100) / 100;
    const trade = {
      id: Date.now() + Math.random(),
      type: isBuy ? 'BUY' : 'SELL',
      entryPrice,
      entryBarIndex: this.replayIndex - 1,
      time: bar.time,
      sl,
      tp,
      volume,
      pnl: 0.0,
      status: 'OPEN'
    };
    this.replayTrades.push(trade);
    this._notifyReplayUpdate();
    return trade;
  }

  _checkReplayTrades() {
    if (!this.allCandles || this.replayIndex < 1) return;
    const bar = this.allCandles[this.replayIndex - 1];
    if (!bar) return;
    for (const t of this.replayTrades) {
      if (t.status !== 'OPEN') continue;
      const isBuy = t.type === 'BUY';
      const diff = isBuy ? (bar.close - t.entryPrice) : (t.entryPrice - bar.close);
      t.pnl = Math.round(diff * 100 * t.volume * 100) / 100;

      if (isBuy) {
        if (bar.low <= t.sl) {
          t.status = 'CLOSED';
          t.pnl = Math.round((t.sl - t.entryPrice) * 100 * t.volume * 100) / 100;
          t.exitPrice = t.sl;
          t.exitReason = 'SL';
        } else if (bar.high >= t.tp) {
          t.status = 'CLOSED';
          t.pnl = Math.round((t.tp - t.entryPrice) * 100 * t.volume * 100) / 100;
          t.exitPrice = t.tp;
          t.exitReason = 'TP';
        }
      } else {
        if (bar.high >= t.sl) {
          t.status = 'CLOSED';
          t.pnl = Math.round((t.entryPrice - t.sl) * 100 * t.volume * 100) / 100;
          t.exitPrice = t.sl;
          t.exitReason = 'SL';
        } else if (bar.low <= t.tp) {
          t.status = 'CLOSED';
          t.pnl = Math.round((t.entryPrice - t.tp) * 100 * t.volume * 100) / 100;
          t.exitPrice = t.tp;
          t.exitReason = 'TP';
        }
      }
    }
  }

  _notifyReplayUpdate() {
    if (typeof this.onReplayUpdate === 'function') {
      const currentBar = (this.allCandles && this.replayIndex > 0) ? this.allCandles[this.replayIndex - 1] : null;
      let totalPnl = 0;
      let winCount = 0;
      let lossCount = 0;
      for (const t of this.replayTrades) {
        totalPnl += t.pnl;
        if (t.status === 'CLOSED') {
          if (t.pnl > 0) winCount++;
          else lossCount++;
        }
      }
      this.onReplayUpdate({
        isReplayMode: this.isReplayMode,
        replayIndex: this.replayIndex,
        totalBars: (this.allCandles ? this.allCandles.length : 0),
        replayPlaying: this.replayPlaying,
        replaySpeed: this.replaySpeed,
        bar: currentBar,
        trades: this.replayTrades,
        totalPnl: Math.round(totalPnl * 100) / 100,
        winCount,
        lossCount
      });
    }
  }

  render(snapshot) {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;

    // Merge incoming snapshot candles into full history buffer
    if (snapshot && snapshot.candles) {
      this.mergeLiveCandles(snapshot.candles);
    }

    // Determine active candles array (Replay slice vs full deep history buffer)
    let rawCandles;
    if (this.isReplayMode) {
      const endIdx = Math.max(1, Math.min(this.allCandles.length, this.replayIndex));
      rawCandles = this.allCandles.slice(0, endIdx);
    } else {
      rawCandles = (this.allCandles && this.allCandles.length > 0) ? this.allCandles : (snapshot ? snapshot.candles || [] : []);
    }
    if (rawCandles.length === 0) return;

    const effectiveSnapshot = { ...snapshot, candles: rawCandles };

    // If Pro Candlestick Chart mode is active, render TradingView-style OHLC + Orderflow Candlestick workspace
    if (this.viewMode === 'candlestick') {
      this._renderCandlestickChart(ctx, effectiveSnapshot);
      this._drawManualDrawings(ctx);
      this._handleHoverTooltip();
      return;
    }

    // If ClusterDelta Orderflow mode is active, render authentic ClusterDelta workspace
    if (this.viewMode === 'clusterdelta') {
      this._renderClusterDelta(ctx, effectiveSnapshot);
      this._drawManualDrawings(ctx);
      this._handleHoverTooltip();
      return;
    }

    // Filter to 10 candles with horizontal pan support (barOffset)
    const candles = this._sliceCandlesWithOffset(rawCandles, 10);

    // Calculate auto vertical bounds
    let lowest = Infinity;
    let highest = -Infinity;
    for (const c of candles) {
      lowest = Math.min(lowest, c.low);
      highest = Math.max(highest, c.high);
    }
    
    // Align bounds to step
    const step = this.clusterStep;
    lowest = Math.floor((lowest - step) / step) * step;
    highest = Math.ceil((highest + step) / step) * step;

    // Ensure at least 4 step range
    if (highest - lowest < step * 4) {
      highest = lowest + step * 4;
    }

    // Auto-expand vertical scale so each box has AT LEAST 28px height
    const totalSteps = (highest - lowest) / step;
    const availableHeight = this.height - 140;
    const rawBoxHeight = availableHeight / totalSteps;
    if (rawBoxHeight < 28 && this.verticalZoom <= 1.0) {
      this.verticalZoom = 28 / rawBoxHeight;
    }

    // Smooth lerp bounds
    this.minPrice += (lowest - this.minPrice) * 0.15;
    this.maxPrice += (highest - this.maxPrice) * 0.15;

    // Clear background with deep rich obsidian theme
    ctx.fillStyle = '#070a10';
    ctx.fillRect(0, 0, this.width, this.height);

    // 1. Grid Lines & Right Price Scale
    this._drawGrid(ctx);

    // 1B. Prop-Firm Session High/Low, PDH/PDL & Sweep Markers
    if (this.showSessionLevels && snapshot.sessions) {
      this._drawSessionLevels(ctx, snapshot.sessions);
    }

    // 1C. Composite Session Volume Profile (SVP) & Iceberg Overlays
    this._drawSVPAndIcebergs(ctx, snapshot);

    // 2. Render Footprint Candles
    const rightMargin = 80;
    const startX = this.width - rightMargin - (this.candleWidth + this.candleSpacing);
    this.hoverCell = null;

    for (let i = 0; i < candles.length; i++) {
      const candleIndexFromRight = (candles.length - 1) - i;
      const x = startX - (candleIndexFromRight * (this.candleWidth + this.candleSpacing));
      if (x < -this.candleWidth - 20 || x > this.width) continue;

      this._drawSingleFootprint(ctx, candles[i], x);
    }

    // 2.3. Draw Strict Location-First Footprint Signals at SNR
    if (this.showFpsignals !== false) {
      this._drawFootprintSignals(ctx, snapshot, candles, startX);
    }

    // 2.5. Manual Analysis Drawing Tools Overlay (Ray & Trend)
    this._drawManualDrawings(ctx);

    // 2.8. Top Footprint Control Strip HUD
    this._drawFootprintTopHUD(ctx, snapshot);

    // 3. Hover Tooltip
    this._handleHoverTooltip();
  }

  _drawGrid(ctx) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    const step = this.clusterStep;
    const startPrice = Math.floor(this.minPrice / step) * step;

    for (let p = startPrice; p <= this.maxPrice + step; p += step) {
      const y = this.priceToY(p);
      if (y < 20 || y > this.height - 70) continue;

      ctx.strokeStyle = '#121826';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width - 70, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.fillText(p.toFixed(2), this.width - 8, y + 4);
    }
    ctx.restore();
  }

  _drawSessionLevels(ctx, sessions) {
    if (!sessions) return;
    ctx.save();
    const levels = [
      // Higher Timeframe SNR M15, M30, H1, H4, H8
      { price: sessions.h8_res || sessions.h8_high, label: '🏛️ H8 RES', col: '#e11d48' },
      { price: sessions.h8_sup || sessions.h8_low,  label: '🏛️ H8 SUP', col: '#059669' },
      { price: sessions.h4_res || sessions.h4_high, label: '🏰 H4 RES', col: '#ec4899' },
      { price: sessions.h4_sup || sessions.h4_low,  label: '🏰 H4 SUP', col: '#10b981' },
      { price: sessions.h1_res || sessions.h1_high, label: '⏱️ H1 RES', col: '#f97316' },
      { price: sessions.h1_sup || sessions.h1_low,  label: '⏱️ H1 SUP', col: '#06b6d4' },
      { price: sessions.m30_res || sessions.m30_high, label: '⏳ M30 RES', col: '#a855f7' },
      { price: sessions.m30_sup || sessions.m30_low,  label: '⏳ M30 SUP', col: '#3b82f6' },
      { price: sessions.m15_res || sessions.m15_high, label: '⚡ M15 RES', col: '#fbbf24' },
      { price: sessions.m15_sup || sessions.m15_low,  label: '⚡ M15 SUP', col: '#2dd4bf' },

      { price: sessions.pdh,         label: '🏛️ PDH (Semalam)', col: '#fde047' },
      { price: sessions.pdl,         label: '🏛️ PDL (Semalam)', col: '#fde047' },
      { price: sessions.daily_open,  label: '⚡ DAILY OPEN',    col: '#38bdf8' },
      { price: sessions.asian_high,  label: '🌏 ASIAN HIGH',    col: '#f59e0b' },
      { price: sessions.asian_low,   label: '🌏 ASIAN LOW',     col: '#f59e0b' },
      { price: sessions.london_high, label: '🇬🇧 LONDON HIGH',   col: '#06b6d4' },
      { price: sessions.london_low,  label: '🇬🇧 LONDON LOW',    col: '#06b6d4' },
      { price: sessions.ny_high,     label: '🗽 NY HIGH',       col: '#c084fc' },
      { price: sessions.ny_low,      label: '🗽 NY LOW',        col: '#c084fc' }
    ];

    for (const lv of levels) {
      if (!lv.price || lv.price <= 0) continue;
      const y = this.priceToY(lv.price);
      if (y < 20 || y > this.height - 70) continue;

      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = lv.col;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width - 70, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const text = `${lv.label} $${lv.price.toFixed(2)}`;
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(8, 13, 24, 0.90)';
      ctx.fillRect(8, y - 8, tw, 15);
      ctx.strokeStyle = lv.col;
      ctx.lineWidth = 0.9;
      ctx.strokeRect(8, y - 8, tw, 15);

      ctx.fillStyle = lv.col;
      ctx.textAlign = 'left';
      ctx.fillText(text, 13, y + 3);
    }
    ctx.restore();
  }

  _drawSVPAndIcebergs(ctx, snapshot) {
    ctx.save();
    // 1. Composite Session Volume Profile (SVP) on Left Edge
    const svp = snapshot.session_vp;
    if (this.showSVP && svp && svp.buckets && svp.buckets.length > 0) {
      const maxVol = Math.max(10, svp.max_bucket_vol || 50);
      const maxBarW = 85;
      const dpoc = svp.dpoc || 0;
      for (const b of svp.buckets) {
        const y = this.priceToY(b.price);
        if (y < 20 || y > this.height - 70) continue;
        const w = Math.min(maxBarW, (b.total / maxVol) * maxBarW);
        const isPOC = Math.abs(b.price - dpoc) < 0.08;
        ctx.fillStyle = isPOC ? 'rgba(255, 214, 10, 0.65)' : 'rgba(56, 189, 248, 0.22)';
        ctx.fillRect(0, y - 4, w, 8);
      }
      if (dpoc > 0) {
        const py = this.priceToY(dpoc);
        if (py >= 20 && py <= this.height - 70) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(255, 214, 10, 0.85)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(this.width - 70, py);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#ffd60a';
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`⭐ dPOC Sesi $${dpoc.toFixed(2)}`, 6, py - 4);
        }
      }
    }

    // 2. Iceberg Absorption Badges on Footprint
    const icebergs = snapshot.icebergs || [];
    if (this.showIcebergs && icebergs.length > 0) {
      const now = Date.now();
      for (const ic of icebergs.slice(-3)) {
        if (now - ic.timestamp > 90000) continue;
        const y = this.priceToY(ic.price);
        if (y < 20 || y > this.height - 70) continue;
        const isBuy = ic.bias === 'BUY';
        const col = isBuy ? '#00f0ff' : '#f43f5e';
        ctx.fillStyle = isBuy ? 'rgba(0, 240, 255, 0.14)' : 'rgba(244, 63, 94, 0.14)';
        ctx.fillRect(0, y - 5, this.width - 70, 10);
        ctx.fillStyle = col;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(ic.badge, 10, y + 3);
      }
    }
    ctx.restore();
  }

  _drawSingleFootprint(ctx, rawCandle, x) {
    ctx.save();
    const step = this.clusterStep;
    const isBull = rawCandle.close >= rawCandle.open;
    const yHigh = this.priceToY(rawCandle.high);
    const yLow = this.priceToY(rawCandle.low);
    const yOpen = this.priceToY(rawCandle.open);
    const yClose = this.priceToY(rawCandle.close);
    const centerX = x + this.candleWidth / 2;
    const halfW = this.candleWidth / 2;

    // 1. Candlestick Center Wick
    ctx.strokeStyle = isBull ? 'rgba(0, 230, 118, 0.45)' : 'rgba(255, 51, 102, 0.45)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(centerX, yHigh);
    ctx.lineTo(centerX, yLow);
    ctx.stroke();

    // 2. Re-aggregate raw candle clusters into chosen step buckets (Zero Overlap Guaranteed)
    const grouped = {};
    for (const [pStr, cl] of Object.entries(rawCandle.clusters || {})) {
      const p = parseFloat(pStr);
      const bucket = Math.floor(p / step) * step;
      const bKey = bucket.toFixed(2);
      if (!grouped[bKey]) {
        grouped[bKey] = { price: bucket, bid: 0.0, ask: 0.0, total: 0.0, delta: 0.0, isBuyImbalance: false, isSellImbalance: false };
      }
      grouped[bKey].bid += (cl.bid || 0.0);
      grouped[bKey].ask += (cl.ask || 0.0);
      grouped[bKey].total += (cl.total || 0.0);
      grouped[bKey].delta += (cl.delta || 0.0);
    }

    const sortedKeys = Object.keys(grouped).sort((a, b) => parseFloat(a) - parseFloat(b));

    // Calculate Diagonal Imbalances (Ask at bucket i+1 vs Bid at bucket i)
    const imbRatio = this.imbThreshold || 3.0; // 3.0 (300% Standard) | 4.0 (400% Whale)
    for (let i = 0; i < sortedKeys.length - 1; i++) {
      const lowKey = sortedKeys[i];
      const upKey = sortedKeys[i + 1];
      const bidLow = grouped[lowKey].bid;
      const askUp = grouped[upKey].ask;

      if (bidLow > 0 && (askUp / bidLow) >= imbRatio && askUp >= 2.0) {
        grouped[upKey].isBuyImbalance = true;
      }
      if (askUp > 0 && (bidLow / askUp) >= imbRatio && bidLow >= 2.0) {
        grouped[lowKey].isSellImbalance = true;
      }
    }

    // Detect Extreme Wick Absorption (Trapped Sellers at Low, Trapped Buyers at High)
    let hasWickAbsorptionLow = false;
    let hasWickAbsorptionHigh = false;
    if (sortedKeys.length >= 2) {
      const btmKey = sortedKeys[0];
      const btmNextKey = sortedKeys[1];
      const topKey = sortedKeys[sortedKeys.length - 1];
      const topPrevKey = sortedKeys[sortedKeys.length - 2];

      const btmSellVol = (grouped[btmKey]?.bid || 0) + (grouped[btmNextKey]?.bid || 0);
      const topBuyVol = (grouped[topKey]?.ask || 0) + (grouped[topPrevKey]?.ask || 0);

      const candleRange = Math.max(0.1, rawCandle.high - rawCandle.low);
      const lowRejection = (rawCandle.close - rawCandle.low) / candleRange;
      const highRejection = (rawCandle.high - rawCandle.close) / candleRange;

      if (btmSellVol >= 6.0 && lowRejection >= 0.35) {
        hasWickAbsorptionLow = true;
        rawCandle._absorptionLow = true;
      }
      if (topBuyVol >= 6.0 && highRejection >= 0.35) {
        hasWickAbsorptionHigh = true;
        rawCandle._absorptionHigh = true;
      }
    }

    // Detect Candle Delta Divergence (Δ DIV)
    let isDeltaDivBullish = false;
    let isDeltaDivBearish = false;
    if (rawCandle.close > rawCandle.open && (rawCandle.delta || 0) <= -0.5) {
      isDeltaDivBullish = true;
    } else if (rawCandle.close < rawCandle.open && (rawCandle.delta || 0) >= 0.5) {
      isDeltaDivBearish = true;
    }

    // Find Point of Control (POC) and total volume
    let maxTotal = -1;
    let pocPrice = null;
    let candleTotalVol = 0;
    let maxDeltaAbs = 1;

    for (const key of sortedKeys) {
      const cl = grouped[key];
      candleTotalVol += cl.total;
      maxDeltaAbs = Math.max(maxDeltaAbs, Math.abs(cl.delta));
      if (cl.total > maxTotal) {
        maxTotal = cl.total;
        pocPrice = cl.price;
      }
    }

    // Calculate Value Area (VAH 70% & VAL 70%)
    let vahPrice = pocPrice;
    let valPrice = pocPrice;
    if (sortedKeys.length > 0 && pocPrice !== null) {
      let pocIdx = sortedKeys.findIndex(k => Math.abs(grouped[k].price - pocPrice) < 0.001);
      if (pocIdx === -1) pocIdx = 0;
      let lowIdx = pocIdx;
      let highIdx = pocIdx;
      let curVaVol = grouped[sortedKeys[pocIdx]].total;
      const targetVaVol = candleTotalVol * 0.70;

      while (curVaVol < targetVaVol && (lowIdx > 0 || highIdx < sortedKeys.length - 1)) {
        const upVol = (highIdx < sortedKeys.length - 1) ? grouped[sortedKeys[highIdx + 1]].total : -1;
        const downVol = (lowIdx > 0) ? grouped[sortedKeys[lowIdx - 1]].total : -1;

        if (upVol >= downVol && highIdx < sortedKeys.length - 1) {
          highIdx++;
          curVaVol += upVol;
        } else if (lowIdx > 0) {
          lowIdx--;
          curVaVol += downVol;
        } else if (highIdx < sortedKeys.length - 1) {
          highIdx++;
          curVaVol += upVol;
        } else {
          break;
        }
      }
      vahPrice = grouped[sortedKeys[highIdx]].price + step;
      valPrice = grouped[sortedKeys[lowIdx]].price;

      for (let i = lowIdx; i <= highIdx; i++) {
        grouped[sortedKeys[i]].inValueArea = true;
      }
    }

    // Detect Stacked Imbalances (3+ consecutive levels)
    const stackedBuyLevels = [];
    const stackedSellLevels = [];
    let curB = [];
    let curS = [];
    for (const key of sortedKeys) {
      const cl = grouped[key];
      if (cl.isBuyImbalance) {
        curB.push(cl.price);
      } else {
        if (curB.length >= 3) stackedBuyLevels.push([...curB]);
        curB = [];
      }
      if (cl.isSellImbalance) {
        curS.push(cl.price);
      } else {
        if (curS.length >= 3) stackedSellLevels.push([...curS]);
        curS = [];
      }
    }
    if (curB.length >= 3) stackedBuyLevels.push([...curB]);
    if (curS.length >= 3) stackedSellLevels.push([...curS]);

    // 3. Render Value Area (70%) Shading & Dotted VAH/VAL Levels
    if (this.showValueArea && vahPrice !== null && valPrice !== null) {
      const yVah = this.priceToY(vahPrice);
      const yVal = this.priceToY(valPrice);
      const topY = Math.min(yVah, yVal);
      const vaHeight = Math.abs(yVal - yVah);

      // Subtle Value Area background glow
      ctx.fillStyle = 'rgba(56, 189, 248, 0.05)';
      ctx.fillRect(x - 3, topY, this.candleWidth + 6, vaHeight);

      // VAH Dotted Line & Tag
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 4, yVah);
      ctx.lineTo(x + this.candleWidth + 4, yVah);
      ctx.stroke();

      // VAL Dotted Line
      ctx.strokeStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(x - 4, yVal);
      ctx.lineTo(x + this.candleWidth + 4, yVal);
      ctx.stroke();
      ctx.restore();

      // Micro VAH/VAL tags
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      ctx.fillStyle = '#38bdf8';
      ctx.textAlign = 'right';
      ctx.fillText('VAH', x + this.candleWidth - 2, yVah - 2);
      ctx.fillText('VAL', x + this.candleWidth - 2, yVal + 9);
    }

    // 4. Render Non-Overlapping Bucket Tiles
    for (const cl of Object.values(grouped)) {
      const p = cl.price;
      const yTop = this.priceToY(p + step);
      const yBottom = this.priceToY(p);
      const boxHeight = Math.max(16, yBottom - yTop);
      const boxY = yTop;

      if (boxY < 10 || boxY > this.height - 75) continue;

      const isPOC = pocPrice !== null && Math.abs(pocPrice - p) < 0.01;
      const isBuyImbalance = cl.isBuyImbalance;
      const isSellImbalance = cl.isSellImbalance;

      // Mouse Hover check
      if (
        this.mousePos.x >= x && this.mousePos.x <= x + this.candleWidth &&
        this.mousePos.y >= boxY && this.mousePos.y <= boxY + boxHeight
      ) {
        this.hoverCell = {
          price: p,
          priceRange: `$${p.toFixed(2)} - $${(p + step).toFixed(2)}`,
          bid: cl.bid,
          ask: cl.ask,
          delta: cl.delta,
          total: cl.total,
          isPOC: isPOC,
          inValueArea: !!cl.inValueArea,
          isBuyImbalance: isBuyImbalance,
          isSellImbalance: isSellImbalance,
          screenX: this.mousePos.x,
          screenY: this.mousePos.y
        };
      }

      // -------------------------------------------------------------
      // RENDERING BY SELECTED VIEW MODE
      // -------------------------------------------------------------
      if (this.viewMode === 'bid_ask') {
        // --- MODE 1: BID x ASK (Dual Columns) ---
        const bidIntensity = Math.min(1.0, cl.bid / 16.0);
        ctx.fillStyle = isSellImbalance 
          ? '#990022' // Vivid Sell Imbalance Red
          : `rgba(180, 25, 55, ${0.28 + bidIntensity * 0.52})`;
        ctx.fillRect(x, boxY, halfW, boxHeight);

        const askIntensity = Math.min(1.0, cl.ask / 16.0);
        ctx.fillStyle = isBuyImbalance 
          ? '#008833' // Vivid Buy Imbalance Green
          : `rgba(0, 160, 70, ${0.28 + askIntensity * 0.52})`;
        ctx.fillRect(x + halfW, boxY, halfW, boxHeight);

        // Center Divider line
        ctx.strokeStyle = '#0b101c';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + halfW, boxY);
        ctx.lineTo(x + halfW, boxY + boxHeight);
        ctx.stroke();

        // High-Contrast Text Rendering
        if (boxHeight >= 15) {
          ctx.font = 'bold 11px "JetBrains Mono", monospace';
          const textY = boxY + boxHeight / 2 + 4;

          // Bid Text (Left) - Mini Directional Sweep Indicator
          ctx.textAlign = 'center';
          ctx.fillStyle = isSellImbalance ? '#ffffff' : (cl.bid > 0 ? '#ffb3c1' : '#64748b');
          const bidStr = (isSellImbalance ? '↘ ' : '') + cl.bid.toFixed(1);
          ctx.fillText(bidStr, x + halfW / 2, textY);

          // Ask Text (Right) - Mini Directional Sweep Indicator
          ctx.fillStyle = isBuyImbalance ? '#ffffff' : (cl.ask > 0 ? '#bbf7d0' : '#64748b');
          const askStr = cl.ask.toFixed(1) + (isBuyImbalance ? ' ↗' : '');
          ctx.fillText(askStr, x + halfW + halfW / 2, textY);
        }

      } else if (this.viewMode === 'delta') {
        // --- MODE 2: DELTA FOOTPRINT PROFILE ---
        // Base dark tile background
        ctx.fillStyle = cl.inValueArea ? 'rgba(56, 189, 248, 0.08)' : 'rgba(15, 23, 42, 0.5)';
        ctx.fillRect(x, boxY, this.candleWidth, boxHeight);

        // Horizontal Delta Bar from Center
        const deltaRatio = Math.min(1.0, Math.abs(cl.delta) / maxDeltaAbs);
        const barW = Math.max(2, deltaRatio * (halfW - 8));

        if (cl.delta > 0) {
          ctx.fillStyle = 'rgba(0, 230, 118, 0.45)';
          ctx.fillRect(x + halfW, boxY + 2, barW, boxHeight - 4);
        } else if (cl.delta < 0) {
          ctx.fillStyle = 'rgba(255, 51, 102, 0.45)';
          ctx.fillRect(x + halfW - barW, boxY + 2, barW, boxHeight - 4);
        }

        // Center Axis marker
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + halfW, boxY);
        ctx.lineTo(x + halfW, boxY + boxHeight);
        ctx.stroke();

        // Delta Value Text
        if (boxHeight >= 15) {
          ctx.font = 'bold 11.5px "JetBrains Mono", monospace';
          const textY = boxY + boxHeight / 2 + 4;
          ctx.textAlign = 'center';
          const dSign = cl.delta > 0 ? '+' : '';
          ctx.fillStyle = cl.delta > 0 ? '#00e676' : (cl.delta < 0 ? '#ff3366' : '#94a3b8');
          ctx.fillText(`Δ ${dSign}${cl.delta.toFixed(1)}`, centerX, textY);
        }

      } else if (this.viewMode === 'volume') {
        // --- MODE 3: VOLUME PROFILE FOOTPRINT ---
        ctx.fillStyle = cl.inValueArea ? 'rgba(56, 189, 248, 0.08)' : 'rgba(15, 23, 42, 0.5)';
        ctx.fillRect(x, boxY, this.candleWidth, boxHeight);

        // Volume Bar spanning across width
        const volRatio = maxTotal > 0 ? (cl.total / maxTotal) : 0;
        const barW = Math.max(3, volRatio * (this.candleWidth - 10));
        ctx.fillStyle = isPOC ? 'rgba(255, 183, 3, 0.4)' : 'rgba(56, 189, 248, 0.3)';
        ctx.fillRect(x + 2, boxY + 2, barW, boxHeight - 4);

        if (boxHeight >= 15) {
          ctx.font = 'bold 11px "JetBrains Mono", monospace';
          const textY = boxY + boxHeight / 2 + 4;
          ctx.textAlign = 'center';
          ctx.fillStyle = isPOC ? '#ffb703' : '#f1f5f9';
          ctx.fillText(`${cl.total.toFixed(1)} Lot`, centerX, textY);
        }
      }

      // Outer Tile Grid borders (Micro-refined)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x, boxY, this.candleWidth, boxHeight);

      // Imbalance Highlights & Directional Mini Sweep Arrows (Anti-Clutter Filter: boxHeight >= 22)
      if (this.viewMode === 'bid_ask') {
        if (isSellImbalance) {
          ctx.strokeStyle = '#ff3366';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, boxY, halfW, boxHeight);
          if (boxHeight >= 22) {
            ctx.fillStyle = '#ff3366';
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            ctx.fillText('↘', x + 3, boxY + 10);
          }
        }
        if (isBuyImbalance) {
          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + halfW, boxY, halfW, boxHeight);
          if (boxHeight >= 22) {
            ctx.fillStyle = '#00e676';
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.fillText('↗', x + this.candleWidth - 3, boxY + 10);
          }
        }
      }

      // Point of Control (POC) Golden Outer Frame
      if (isPOC) {
        ctx.strokeStyle = '#ffb703';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x - 1, boxY, this.candleWidth + 2, boxHeight);

        // Small POC indicator badge on left
        ctx.fillStyle = '#ffb703';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('★POC', x + 3, boxY + 10);
      }
    }

    // 5. Render Stacked Imbalances Highlights (Institutional Walls - Flush Design)
    if (this.showStackedImbalances) {
      // Stacked Buy Imbalances (Cyan/Green Right Bracket)
      for (const stack of stackedBuyLevels) {
        const topP = Math.max(...stack) + step;
        const btmP = Math.min(...stack);
        const yTop = this.priceToY(topP);
        const yBtm = this.priceToY(btmP);
        const stackH = Math.max(16, yBtm - yTop);

        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + this.candleWidth - 3, yTop, 4, stackH);

        // Institutional Badge (Flush & Compact)
        ctx.fillStyle = '#00e676';
        ctx.fillRect(x + this.candleWidth + 2, yTop + stackH / 2 - 8, 44, 15);
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`⚡BUY ${stack.length}x`, x + this.candleWidth + 24, yTop + stackH / 2 + 3.5);
      }

      // Stacked Sell Imbalances (Crimson/Red Left Bracket)
      for (const stack of stackedSellLevels) {
        const topP = Math.max(...stack) + step;
        const btmP = Math.min(...stack);
        const yTop = this.priceToY(topP);
        const yBtm = this.priceToY(btmP);
        const stackH = Math.max(16, yBtm - yTop);

        ctx.strokeStyle = '#ff3366';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x - 1, yTop, 4, stackH);

        // Institutional Badge (Flush & Compact)
        ctx.fillStyle = '#ff3366';
        ctx.fillRect(x - 46, yTop + stackH / 2 - 8, 44, 15);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`⚡SELL ${stack.length}x`, x - 24, yTop + stackH / 2 + 3.5);
      }
    }

    // 6. Extreme Wick Absorption Markers (Trapped Sellers / Trapped Buyers)
    if (this.showWickAbsorption !== false) {
      if (hasWickAbsorptionLow) {
        ctx.fillStyle = 'rgba(5, 38, 22, 0.94)';
        const txt = '🛡️ ABSORPTION LOW';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 8;
        ctx.fillRect(centerX - tw / 2, yLow + 8, tw, 15);
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(centerX - tw / 2, yLow + 8, tw, 15);
        ctx.fillStyle = '#00e676';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, centerX, yLow + 15.5);
      }
      if (hasWickAbsorptionHigh) {
        ctx.fillStyle = 'rgba(45, 10, 20, 0.94)';
        const txt = '🛡️ ABSORPTION HIGH';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 8;
        ctx.fillRect(centerX - tw / 2, yHigh - 23, tw, 15);
        ctx.strokeStyle = '#ff3366';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(centerX - tw / 2, yHigh - 23, tw, 15);
        ctx.fillStyle = '#ff3366';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, centerX, yHigh - 15.5);
      }
    }

    // 6.5. Candle Delta Divergence Badge (Δ DIV)
    if (this.showCandleDeltaDiv !== false) {
      const footerYRef = this.height - 62;
      if (isDeltaDivBullish) {
        ctx.fillStyle = 'rgba(6, 40, 24, 0.92)';
        const txt = `⚡ Δ DIV [-${Math.abs(rawCandle.delta || 0).toFixed(1)}]`;
        ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 8;
        ctx.fillRect(centerX - tw / 2, footerYRef - 16, tw, 13);
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(centerX - tw / 2, footerYRef - 16, tw, 13);
        ctx.fillStyle = '#00e676';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, centerX, footerYRef - 9.5);
      } else if (isDeltaDivBearish) {
        ctx.fillStyle = 'rgba(45, 10, 20, 0.92)';
        const txt = `⚡ Δ DIV [+${(rawCandle.delta || 0).toFixed(1)}]`;
        ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 8;
        ctx.fillRect(centerX - tw / 2, footerYRef - 16, tw, 13);
        ctx.strokeStyle = '#ff3366';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(centerX - tw / 2, footerYRef - 16, tw, 13);
        ctx.fillStyle = '#ff3366';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, centerX, footerYRef - 9.5);
      }
    }

    // 6.8. Unfinished Auction Flags
    if (rawCandle.unfinished_high) {
      ctx.fillStyle = '#eab308';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ Unf. High', centerX, yHigh - 5);
    }
    if (rawCandle.unfinished_low) {
      ctx.fillStyle = '#eab308';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ Unf. Low', centerX, yLow + 12);
    }

    // 7. Candlestick Open/Close Perimeter Frame
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(4, Math.abs(yClose - yOpen));
    ctx.strokeStyle = isBull ? '#00e676' : '#ff3366';
    ctx.lineWidth = 1.8;
    ctx.strokeRect(x - 2, bodyTop, this.candleWidth + 4, bodyHeight);

    // 8. Sierra Chart / ATAS Style 4-Row Statistics Summary Table
    const footerY = this.height - 62;
    const footerH = 54;
    const deltaColor = rawCandle.delta >= 0 ? '#00e676' : '#ff3366';
    const deltaSign = rawCandle.delta > 0 ? '+' : '';
    const deltaPct = rawCandle.volume > 0 ? Math.round((rawCandle.delta / rawCandle.volume) * 100) : 0;
    const minD = rawCandle.min_delta !== undefined ? rawCandle.min_delta : (rawCandle.delta < 0 ? rawCandle.delta : 0);
    const maxD = rawCandle.max_delta !== undefined ? rawCandle.max_delta : (rawCandle.delta > 0 ? rawCandle.delta : 0);

    // Footer Card Background
    ctx.fillStyle = '#0c111c';
    ctx.fillRect(x, footerY, this.candleWidth, footerH);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, footerY, this.candleWidth, footerH);

    // Row 1: Volume
    ctx.textAlign = 'center';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`Vol: ${rawCandle.volume.toFixed(1)}`, centerX, footerY + 12);

    // Row 2: Delta (with color)
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.fillStyle = deltaColor;
    ctx.fillText(`Δ ${deltaSign}${rawCandle.delta.toFixed(1)} (${deltaPct > 0 ? '+' : ''}${deltaPct}%)`, centerX, footerY + 25);

    // Row 3: Min / Max Delta (Exhaustion indicator)
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = '#64748b';
    ctx.fillText(`Min: ${minD.toFixed(0)}  Max: ${maxD.toFixed(0)}`, centerX, footerY + 37);

    // Row 4: Mode Label
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#475569';
    const modeLabel = this.viewMode === 'bid_ask' ? 'BID x ASK' : (this.viewMode === 'delta' ? 'DELTA PROFILE' : 'VOL PROFILE');
    ctx.fillText(modeLabel, centerX, footerY + 48);

    ctx.restore();
  }

  _handleHoverTooltip() {
    const tooltip = document.getElementById('chartTooltip');
    if (!tooltip) return;

    if (this.hoverCell) {
      const c = this.hoverCell;
      tooltip.style.display = 'block';
      const maxLeft = Math.max(20, (this.width || 800) - 295);
      tooltip.style.left = `${Math.min(maxLeft, c.screenX + 16)}px`;
      tooltip.style.top = `${Math.max(12, c.screenY - 38)}px`;

      if (c.isCandleTooltip) {
        const isBull = c.close >= c.open;
        const chg = c.close - c.open;
        const dCol = c.delta >= 0 ? '#00e676' : '#ff3366';

        let signalHtml = '';
        if (c.aPlusSignal) {
          const sig = c.aPlusSignal;
          const isBuy = sig.direction === 'BUY';
          signalHtml = `
            <div style="margin-top:6px; padding:6px 8px; background:rgba(15,23,42,0.95); border:1px solid #ffd60a; border-radius:4px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                <span style="color:#ffd60a; font-weight:800; font-size:11px;">${sig.badge}</span>
                <span style="background:${isBuy ? 'rgba(0,230,118,0.2)' : 'rgba(255,51,102,0.2)'}; color:${isBuy ? '#00e676' : '#ff3366'}; padding:1px 5px; border-radius:3px; font-weight:800; font-size:9.5px;">R:R 1:${sig.rr}</span>
              </div>
              <div style="font-size:10px; color:#94a3b8; margin-bottom:4px; line-height:1.3;">${sig.reason}</div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:2px 8px; font-size:10.5px; font-family:'JetBrains Mono',monospace;">
                <span>Entry: <b style="color:#fff">$${sig.entry.toFixed(2)}</b></span>
                <span>Sasaran/Zon: <b style="color:#38bdf8">${sig.level || 'Zon Institusi'}</b></span>
                <span>Stop Loss: <b style="color:#ff3366">$${sig.sl.toFixed(2)}</b></span>
                <span>Take Profit: <b style="color:#00e676">$${sig.tp.toFixed(2)}</b></span>
              </div>
            </div>
          `;
        } else if (c.signalBadge) {
          signalHtml = `<div style="margin-top:5px; padding-top:4px; border-top:1px solid #1e293b; color:${c.signalCol}; font-weight:700; font-size:11px;">${c.signalBadge}</div>`;
        }

        tooltip.innerHTML = `
          <div style="font-weight:700; color:${isBull ? '#00e676' : '#ff3366'}; border-bottom:1px solid #232b42; padding-bottom:4px; margin-bottom:4px;">
            🕯️ Lilin [${this.timeframe || 'M1'}] • ${c.timeStr} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)})
          </div>
          <div style="display:grid; grid-template-columns:auto auto; gap:3px 16px; font-size:11px; font-family:'JetBrains Mono',monospace;">
            <span style="color:#94a3b8">Open / Close:</span><b style="color:#fff">$${c.open.toFixed(2)} → $${c.close.toFixed(2)}</b>
            <span style="color:#94a3b8">High / Low:</span><b style="color:#cbd5e1">$${c.high.toFixed(2)} / $${c.low.toFixed(2)}</b>
            <span style="color:#94a3b8">POC Lilin:</span><b style="color:#ffd60a">⭐ $${(c.poc || c.close).toFixed(2)}</b>
            <span style="color:#94a3b8">Volum / Delta:</span><b style="color:${dCol}">${c.volume.toFixed(1)}L (Δ ${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)}L)</b>
          </div>
          ${signalHtml}
        `;
        return;
      }

      const pocBadge = c.isPOC ? '<span style="color:#ffb703; font-weight:800;"> ★ POC</span>' : '';
      const absorbBadge = c.isAbsorptionNode ? '<span style="color:#c084fc; font-weight:800;"> 🧱 ABSORPSI</span>' : '';
      const vaBadge = c.inValueArea ? '<span style="color:#38bdf8; font-weight:700;"> [VA 70%]</span>' : '';
      const buyImbBadge = c.isBuyImbalance ? '<span style="color:#00e676; font-weight:700;"> ⚡ Buy Imb 300%+</span>' : '';
      const sellImbBadge = c.isSellImbalance ? '<span style="color:#ff3366; font-weight:700;"> ⚡ Sell Imb 300%+</span>' : '';
      const pctStr = c.candleSharePct !== undefined ? ` (${c.candleSharePct}% Vol Lilin)` : '';

      tooltip.innerHTML = `
        <div style="font-weight:700; color:#fff; border-bottom:1px solid #232b42; padding-bottom:4px; margin-bottom:4px;">
          Paras Harga: ${c.priceRange} ${pocBadge} ${absorbBadge} ${vaBadge}
        </div>
        <div style="display:flex; justify-content:space-between; gap:18px; font-size:11.5px;">
          <span>Bid (Sell): <b style="color:#ff3366">${(c.bid * 10).toFixed(0)} (${c.bid.toFixed(1)}L)</b></span>
          <span>Ask (Buy): <b style="color:#00e676">${(c.ask * 10).toFixed(0)} (${c.ask.toFixed(1)}L)</b></span>
        </div>
        <div style="display:flex; justify-content:space-between; gap:18px; font-size:11.5px; margin-top:3px;">
          <span>Delta: <b style="color:${c.delta >= 0 ? '#00e676' : '#ff3366'}">${c.delta >= 0 ? '+' : ''}${(c.delta * 10).toFixed(0)} (${c.delta.toFixed(1)}L)</b></span>
          <span>Volum: <b style="color:#ffb703">${(c.total * 10).toFixed(0)}${pctStr}</b></span>
        </div>
        ${buyImbBadge || sellImbBadge ? `<div style="margin-top:4px; font-size:11px;">Status Imbalance: ${buyImbBadge} ${sellImbBadge}</div>` : ''}
        ${c.cdSignal ? `
          <div style="margin-top:6px; padding:5px 8px; background:rgba(15,23,42,0.95); border:1px solid #ffd60a; border-radius:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
              <span style="color:#ffd60a; font-weight:800; font-size:10.5px;">${c.cdSignal.badge}</span>
              <span style="background:${c.cdSignal.direction === 'BUY' ? 'rgba(0,230,118,0.2)' : 'rgba(255,51,102,0.2)'}; color:${c.cdSignal.direction === 'BUY' ? '#00e676' : '#ff3366'}; padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">R:R 1:2.5</span>
            </div>
            <div style="font-size:9.5px; color:#94a3b8; margin-bottom:3px; line-height:1.3;">${c.cdSignal.reason}</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:2px 8px; font-size:10px; font-family:'JetBrains Mono',monospace;">
              <span>Entry: <b style="color:#fff">$${c.cdSignal.entry.toFixed(2)}</b></span>
              <span>Teknik: <b style="color:#38bdf8">${c.cdSignal.technique}</b></span>
              <span>Stop Loss: <b style="color:#ff3366">$${c.cdSignal.sl.toFixed(2)}</b></span>
              <span>Take Profit: <b style="color:#00e676">$${c.cdSignal.tp.toFixed(2)}</b></span>
            </div>
          </div>
        ` : ''}
      `;
    } else {
      tooltip.style.display = 'none';
    }
  }

  /* ─── Strict Location-First Footprint Signals at Institutional SNR ─────────────── */
  _drawFootprintSignals(ctx, snapshot, candles, startX) {
    if (!candles || candles.length < 2) return;
    const sess = snapshot.sessions || {};
    const svp = snapshot.session_vp || {};

    const demandLevels = [
      { p: sess.h8_sup || sess.h8_low, name: 'H8 DEMAND' },
      { p: sess.h4_sup || sess.h4_low, name: 'H4 DEMAND' },
      { p: sess.h1_sup || sess.h1_low, name: 'H1 SUPPORT' },
      { p: sess.m30_sup || sess.m30_low, name: 'M30 SUPPORT' },
      { p: sess.m15_sup || sess.m15_low, name: 'M15 SUPPORT' },
      { p: svp.val, name: 'VAL 70% DEMAND' },
      { p: sess.pdl, name: 'PDL FLOOR' },
      { p: sess.asian_low, name: 'ASIAN LOW' }
    ].filter(l => l.p && l.p > 0);

    const supplyLevels = [
      { p: sess.h8_res || sess.h8_high, name: 'H8 SUPPLY' },
      { p: sess.h4_res || sess.h4_high, name: 'H4 SUPPLY' },
      { p: sess.h1_res || sess.h1_high, name: 'H1 RESISTANCE' },
      { p: sess.m30_res || sess.m30_high, name: 'M30 RESISTANCE' },
      { p: sess.m15_res || sess.m15_high, name: 'M15 RESISTANCE' },
      { p: svp.vah, name: 'VAH 70% SUPPLY' },
      { p: sess.pdh, name: 'PDH CEILING' },
      { p: sess.asian_high, name: 'ASIAN HIGH' }
    ].filter(l => l.p && l.p > 0);

    const tol = 0.75;
    ctx.save();

    for (let i = 0; i < candles.length - 1; i++) {
      const c = candles[i];
      const candleIndexFromRight = (candles.length - 1) - i;
      const x = startX - (candleIndexFromRight * (this.candleWidth + this.candleSpacing));
      const centerX = x + this.candleWidth / 2;
      const yLow = this.priceToY(c.low);
      const yHigh = this.priceToY(c.high);

      // Check Demand Gate for BUY
      const activeDemand = demandLevels.find(l => Math.abs(l.p - c.low) <= tol || (c.low <= l.p && c.close >= l.p));
      // Check Supply Gate for SELL
      const activeSupply = supplyLevels.find(l => Math.abs(l.p - c.high) <= tol || (c.high >= l.p && c.close <= l.p));

      // ── BUY SIGNAL (Strictly at Demand/Support ONLY) ──
      if (activeDemand && (c._absorptionLow || (c.delta > 0 && c.close >= c.open))) {
        if (!this._fpLastSignalBarTime || Math.abs(c.time - this._fpLastSignalBarTime) >= (snapshot.candle_interval || 60) * 4) {
          this._fpLastSignalBarTime = c.time;
          this._fpLastSignalDir = 'BUY';
        }

        if (this._fpLastSignalBarTime === c.time && this._fpLastSignalDir === 'BUY') {
          // Neon Glowing Pulse Arrow
          ctx.fillStyle = '#00e676';
          ctx.shadowColor = '#00e676';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.moveTo(centerX, yLow + 28);
          ctx.lineTo(centerX - 6, yLow + 38);
          ctx.lineTo(centerX + 6, yLow + 38);
          ctx.closePath();
          ctx.fill();
          ctx.shadowBlur = 0;

          // Futuristic Badge
          const badgeText = `🎯 [FP] BUY [${activeDemand.name}]`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const bw = ctx.measureText(badgeText).width + 12;
          const bx = Math.max(10, centerX - bw / 2);
          const by = yLow + 42;

          ctx.fillStyle = 'rgba(5, 38, 22, 0.94)';
          ctx.fillRect(bx, by, bw, 16);
          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = 1.1;
          ctx.strokeRect(bx, by, bw, 16);

          ctx.fillStyle = '#00e676';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, bx + bw / 2, by + 8);
        }
      }

      // ── SELL SIGNAL (Strictly at Supply/Resistance ONLY) ──
      else if (activeSupply && (c._absorptionHigh || (c.delta < 0 && c.close <= c.open))) {
        if (!this._fpLastSignalBarTime || Math.abs(c.time - this._fpLastSignalBarTime) >= (snapshot.candle_interval || 60) * 4) {
          this._fpLastSignalBarTime = c.time;
          this._fpLastSignalDir = 'SELL';
        }

        if (this._fpLastSignalBarTime === c.time && this._fpLastSignalDir === 'SELL') {
          // Neon Glowing Pulse Arrow
          ctx.fillStyle = '#ff3366';
          ctx.shadowColor = '#ff3366';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.moveTo(centerX, yHigh - 28);
          ctx.lineTo(centerX - 6, yHigh - 38);
          ctx.lineTo(centerX + 6, yHigh - 38);
          ctx.closePath();
          ctx.fill();
          ctx.shadowBlur = 0;

          // Futuristic Badge
          const badgeText = `🎯 [FP] SELL [${activeSupply.name}]`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const bw = ctx.measureText(badgeText).width + 12;
          const bx = Math.max(10, centerX - bw / 2);
          const by = yHigh - 56;

          ctx.fillStyle = 'rgba(45, 10, 20, 0.94)';
          ctx.fillRect(bx, by, bw, 16);
          ctx.strokeStyle = '#ff3366';
          ctx.lineWidth = 1.1;
          ctx.strokeRect(bx, by, bw, 16);

          ctx.fillStyle = '#ff3366';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, bx + bw / 2, by + 8);
        }
      }
    }
    ctx.restore();
  }

  /* ─── Top Footprint Control Strip HUD (Pills & Hitboxes) ─────────────────────── */
  _drawFootprintTopHUD(ctx, snapshot) {
    ctx.save();
    this.fpToolbarHitboxes = [];
    const topH = 26;

    // Header Background Strip
    ctx.fillStyle = 'rgba(8, 14, 24, 0.92)';
    ctx.fillRect(0, 0, this.width - 75, topH);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topH);
    ctx.lineTo(this.width - 75, topH);
    ctx.stroke();

    let pillX = 10;
    const y = 4;
    const h = 17;

    const drawPill = (label, isActive, activeCol, onClick) => {
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      const w = Math.ceil(ctx.measureText(label).width) + 12;
      ctx.fillStyle = isActive ? activeCol : 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(pillX, y, w, h);
      ctx.strokeStyle = isActive ? '#ffffff' : '#334155';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(pillX, y, w, h);
      ctx.fillStyle = isActive ? '#020617' : '#94a3b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pillX + w / 2, y + h / 2 + 0.5);
      this.fpToolbarHitboxes.push({ x: pillX, y, w, h, onClick });
      pillX += w + 6;
    };

    drawPill(
      `📐 SNR: ${this.showSessionLevels ? 'ON' : 'OFF'}`,
      this.showSessionLevels,
      '#38bdf8',
      () => { this.showSessionLevels = !this.showSessionLevels; }
    );

    drawPill(
      `⚡ IMB: ${this.imbThreshold === 4.0 ? '400% (Whale)' : '300% (Standard)'}`,
      this.imbThreshold === 4.0,
      '#fbbf24',
      () => { this.imbThreshold = this.imbThreshold === 4.0 ? 3.0 : 4.0; }
    );

    drawPill(
      `📊 VA 70%: ${this.showValueArea ? 'ON' : 'OFF'}`,
      this.showValueArea,
      '#a855f7',
      () => { this.showValueArea = !this.showValueArea; }
    );

    drawPill(
      `🛡️ ABSORPTION: ${this.showWickAbsorption !== false ? 'ON' : 'OFF'}`,
      this.showWickAbsorption !== false,
      '#34d399',
      () => { this.showWickAbsorption = this.showWickAbsorption === false; }
    );

    drawPill(
      `⚡ Δ DIV: ${this.showCandleDeltaDiv !== false ? 'ON' : 'OFF'}`,
      this.showCandleDeltaDiv !== false,
      '#f43f5e',
      () => { this.showCandleDeltaDiv = this.showCandleDeltaDiv === false; }
    );

    drawPill(
      `🎯 SGNL: ${this.showFpsignals !== false ? 'ON' : 'OFF'}`,
      this.showFpsignals !== false,
      '#00e676',
      () => { this.showFpsignals = this.showFpsignals === false; }
    );

    drawPill(
      `🔍 RESET ZOOM`,
      false,
      '#64748b',
      () => {
        this.verticalZoom = 1.0;
        this.candleWidth = 145;
        this.priceOffset = 0.0;
        this.barOffset = 0;
      }
    );

    ctx.restore();
  }

  /**
   * World-Class ClusterDelta Pro Orderflow Workspace Renderer
   * Features:
   *  1. Interactive On-Canvas Control Strip (Click directly on header pills):
   *     - Brick Mode: [VOL] [DELTA] [BIDxASK] [IMB PRO]
   *     - Overlays: [📈 Garis POC] [🎯 Ray Zon 3x] [🏛️ VWAP & Sesi]
   *     - Column Density: [➖] [➕]
   *  2. Top 4-Row Institutional Header Table above every candle:
   *     - Row 1: Total Volume + mini volume progress bar + green heat intensity
   *     - Row 2: Net Delta + Cyan/Pink heat intensity
   *     - Row 3: Delta % (Δ%) + Automatic Delta Divergence flag (⚠️ DIV)
   *     - Row 4: Candle Time (HH:MM) + Live Countdown Timer on active candle
   *  3. Tight Brick Cluster Matrix with Left-Edge Open/Close Body Bar & Wick:
   *     - 5-Tier ClusterDelta Heatmap (Cream -> Gold -> Amber -> Deep Orange -> Royal Indigo/Purple)
   *     - 2px Solid Black POC Frame ([ 203 ]) + Golden POC Migration Trajectory Line
   *     - Extended Horizontal Support/Resistance Rays from Stacked Imbalances & Purple Nodes
   *     - Automatic Trapped POC / Absorption Badges (🪤 TRAP / 🧱 ABSORB)
   *  4. Right-Side 3-Column Institutional Profile Panel:
   *     - Column 1 (VOL + VA 70%): Session Volume Histogram with Value Area 70% (VAH/VAL) & POC
   *     - Column 2 (DELTA): Bidirectional Session Delta Histogram + Signed Values
   *     - Column 3 (HARGA): Exact Price Scale + Live Price Pill + Crosshair Price Tag
   *  5. Bottom 26px Cumulative Volume Delta (CVD) Area & Sparkline Strip
   */
  _renderClusterDelta(ctx, snapshot) {
    ctx.save();
    const rawCandles = snapshot.candles || [];
    const maxCols = Math.max(20, Math.min(50, this.cdVisibleCols || 30));
    const candles = this._sliceCandlesWithOffset(rawCandles, maxCols);
    if (candles.length === 0) {
      ctx.restore();
      return;
    }

    const topControlH = 24; // Interactive ClusterDelta Pro control bar at very top
    const topTableH = 68;   // 4-row institutional telemetry header (Vol, Delta, Δ%/Div, Time)
    const topHeaderH = topControlH + topTableH; // 92px total header
    const bottomStripH = 26;
    const rightPanelW = 204; // 84px Vol+VA70% + 54px Delta + 66px Price Scale
    const chartW = Math.max(220, this.width - rightPanelW);
    const chartH = Math.max(160, this.height - topHeaderH - bottomStripH);

    const step = this.clusterStep || 0.50;

    // 1. Compute price bounds across visible candles
    let lowest = Infinity;
    let highest = -Infinity;
    for (const c of candles) {
      if (c.low < lowest) lowest = c.low;
      if (c.high > highest) highest = c.high;
    }
    const lastPrice = snapshot.last_price || snapshot.bid || candles[candles.length - 1].close;
    lowest = Math.floor((Math.min(lowest, lastPrice) - step * 2) / step) * step;
    highest = Math.ceil((Math.max(highest, lastPrice) + step * 2) / step) * step;

    const targetMaxRows = Math.max(20, Math.min(50, this.cdMaxRows || 30));
    const offsetSteps = Math.round((this.priceOffset || 0) / step) * step;
    lowest += offsetSteps;
    highest += offsetSteps;

    let numRows = Math.round((highest - lowest) / step);
    if (numRows < 14) {
      const pad = Math.ceil((14 - numRows) / 2) * step;
      lowest -= pad;
      highest += pad;
      numRows = Math.round((highest - lowest) / step);
    } else if (numRows > targetMaxRows) {
      const half = Math.floor(targetMaxRows / 2);
      const mid = Math.round((lastPrice + offsetSteps) / step) * step;
      lowest = mid - half * step;
      highest = mid + half * step;
      numRows = targetMaxRows;
    }

    const rowH = chartH / numRows;
    const priceToRowY = (p) => {
      const idxFromTop = (highest - p) / step;
      return topHeaderH + idxFromTop * rowH;
    };

    // 2. Background Fill (ClusterDelta Dark Charcoal #202328)
    ctx.fillStyle = '#202328';
    ctx.fillRect(0, 0, this.width, this.height);

    // 3. Render Interactive ClusterDelta Pro Control Strip (y: 0..24)
    this.cdToolbarHitboxes = [];
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, this.width, topControlH);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topControlH - 0.5);
    ctx.lineTo(this.width, topControlH - 0.5);
    ctx.stroke();

    let pillX = 8;
    const drawPill = (label, isActive, activeColor, onClick) => {
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      const w = Math.ceil(ctx.measureText(label).width) + 12;
      const y = 3;
      const h = 18;
      ctx.fillStyle = isActive ? activeColor : '#1e293b';
      ctx.fillRect(pillX, y, w, h);
      ctx.strokeStyle = isActive ? '#ffffff' : '#475569';
      ctx.lineWidth = 0.9;
      ctx.strokeRect(pillX, y, w, h);
      ctx.fillStyle = isActive ? '#0f172a' : '#cbd5e1';
      ctx.textAlign = 'center';
      ctx.fillText(label, pillX + w / 2, y + 12.5);
      this.cdToolbarHitboxes.push({ x: pillX, y, w, h, onClick });
      pillX += w + 5;
    };

    // Title tag
    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('⚡ CLUSTERDELTA PRO:', pillX, 15.5);
    pillX += 122;

    // Feature: On-Canvas Quick Action Trade HUD
    drawPill('⚡ BUY', true, '#059669', () => {
      if (window.orderFlowApp && window.orderFlowApp.sendTrade) window.orderFlowApp.sendTrade('BUY');
    });
    drawPill('⚡ SELL', true, '#dc2626', () => {
      if (window.orderFlowApp && window.orderFlowApp.sendTrade) window.orderFlowApp.sendTrade('SELL');
    });
    drawPill('🎯 BE', false, '#38bdf8', () => {
      fetch('/api/breakeven_all', { method: 'POST' }).then(r => r.json()).then(res => {
        if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
      });
    });
    drawPill('❌ CLOSE', false, '#f43f5e', () => {
      fetch('/api/close_all', { method: 'POST' }).then(r => r.json()).then(res => {
        if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
      });
    });

    // 4 Brick Mode Pills
    drawPill('Bata: VOL', this.cdCellMode === 'volume', '#fde047', () => { this.cdCellMode = 'volume'; });
    drawPill('Bata: DELTA', this.cdCellMode === 'delta', '#38bdf8', () => { this.cdCellMode = 'delta'; });
    drawPill('Bata: BIDxASK', this.cdCellMode === 'bid_ask', '#4ade80', () => { this.cdCellMode = 'bid_ask'; });
    drawPill('Bata: IMB PRO', this.cdCellMode === 'imbalance', '#c084fc', () => { this.cdCellMode = 'imbalance'; });

    pillX += 4;
    drawPill(`📈 Aliran POC: ${this.cdShowPocMigration !== false ? 'ON' : 'OFF'}`, this.cdShowPocMigration !== false, '#facc15', () => {
      this.cdShowPocMigration = this.cdShowPocMigration === false;
    });
    drawPill(`⚡ 3x Imb: ${this.cdShowStackedImb !== false ? 'ON' : 'OFF'}`, this.cdShowStackedImb !== false, '#00f0ff', () => {
      this.cdShowStackedImb = this.cdShowStackedImb === false;
    });
    drawPill(`🛡️ Klimaks: ${this.cdShowClimax !== false ? 'ON' : 'OFF'}`, this.cdShowClimax !== false, '#c084fc', () => {
      this.cdShowClimax = this.cdShowClimax === false;
    });
    drawPill(`🎯 Ray Zon 3x: ${this.cdShowZoneRays ? 'ON' : 'OFF'}`, this.cdShowZoneRays, '#34d399', () => {
      this.cdShowZoneRays = !this.cdShowZoneRays;
    });
    drawPill(`🏛️ Sesi: ${this.cdShowBenchmarks ? 'ON' : 'OFF'}`, this.cdShowBenchmarks, '#38bdf8', () => {
      this.cdShowBenchmarks = !this.cdShowBenchmarks;
    });
    drawPill(`📐 SNR: ${this.cdShowSNR ? 'ON' : 'OFF'}`, this.cdShowSNR, '#ec4899', () => {
      this.cdShowSNR = !this.cdShowSNR;
    });
    drawPill(this.cdShowSignals ? '🎯 SGNL: ON' : '🎯 SGNL: OFF', this.cdShowSignals, '#00e676', () => {
      this.cdShowSignals = !this.cdShowSignals;
    });

    // Adjustable 20-50 Jalur Controls (Synced with Toolbar Slider)
    pillX += 4;
    drawPill('➖', false, '#94a3b8', () => {
      this.setJalurCount((this.cdVisibleCols || 30) - 2);
    });
    drawPill(`🔥 Jalur: ${maxCols}`, true, '#fbbf24', () => {
      const next = maxCols < 30 ? 30 : (maxCols < 40 ? 40 : (maxCols < 50 ? 50 : 20));
      this.setJalurCount(next);
    });
    drawPill('➕', false, '#94a3b8', () => {
      this.setJalurCount((this.cdVisibleCols || 30) + 2);
    });
    for (const preset of [20, 30, 40, 50]) {
      drawPill(`${preset}`, maxCols === preset, '#38bdf8', () => {
        this.setJalurCount(preset);
      });
    }
    drawPill('◀', false, '#38bdf8', () => { this.panHorizontal(-1); });
    drawPill('▶', false, '#38bdf8', () => { this.panHorizontal(1); });
    drawPill('▲', false, '#38bdf8', () => { this.panVertical(1); });
    drawPill('▼', false, '#38bdf8', () => { this.panVertical(-1); });
    if (Math.abs(this.priceOffset || 0) > 0.05 || (this.barOffset || 0) > 0) {
      drawPill('🎯 Tengah', true, '#fbbf24', () => { this.centerVertical(); });
    }

    // 3.5 Institutional ClusterDelta Orderflow Signal Engine & Permanent Frozen Cache
    // VERSION 3: STRICT LOCATION-FIRST (BUY ONLY AT DEMAND/SUPPORT, SELL ONLY AT SUPPLY/RESISTANCE)
    if (!this._cdSignalEngineVersion || this._cdSignalEngineVersion !== 3 || !this._cdConfirmedSignalsCache) {
      this._cdConfirmedSignalsCache = new Map(); // Completely flush previous cache
      this._cdSignalEngineVersion = 3;
    }

    const candleInterval = snapshot.candle_interval || 60;
    const minCooldownSec = candleInterval * 7; // Strict 7-bar cooldown (prevents early counter-trend traps)

    let lastCdSignalTime = 0;
    let lastCdSignalDir = null;

    for (let i = 0; i < rawCandles.length - 1; i++) {
      const past = this._cdConfirmedSignalsCache.get(rawCandles[i].time);
      if (past && past.signal) {
        lastCdSignalTime = rawCandles[i].time;
        lastCdSignalDir = past.signal.direction;
      }
    }

    // Compile Active Institutional Support & Demand Zones
    const sess = snapshot.sessions || snapshot.htf_snr || {};
    const supDemandLevels = [];
    if (sess.h8_sup > 0) supDemandLevels.push({ price: sess.h8_sup, name: 'H8 DEMAND' });
    if (sess.h4_sup > 0) supDemandLevels.push({ price: sess.h4_sup, name: 'H4 DEMAND' });
    if (sess.h1_sup > 0) supDemandLevels.push({ price: sess.h1_sup, name: 'H1 SUPPORT' });
    if (sess.m30_sup > 0) supDemandLevels.push({ price: sess.m30_sup, name: 'M30 SUPPORT' });
    if (sess.pdl > 0) supDemandLevels.push({ price: sess.pdl, name: 'PDL FLOOR' });
    if (sess.asian_low > 0) supDemandLevels.push({ price: sess.asian_low, name: 'ASIAN LOW' });
    if (snapshot.session_vp && snapshot.session_vp.val > 0) {
      supDemandLevels.push({ price: snapshot.session_vp.val, name: 'VAL DEMAND' });
    }

    // Compile Active Institutional Resistance & Supply Zones
    const resSupplyLevels = [];
    if (sess.h8_res > 0) resSupplyLevels.push({ price: sess.h8_res, name: 'H8 SUPPLY' });
    if (sess.h4_res > 0) resSupplyLevels.push({ price: sess.h4_res, name: 'H4 SUPPLY' });
    if (sess.h1_res > 0) resSupplyLevels.push({ price: sess.h1_res, name: 'H1 RESISTANCE' });
    if (sess.m30_res > 0) resSupplyLevels.push({ price: sess.m30_res, name: 'M30 RESISTANCE' });
    if (sess.pdh > 0) resSupplyLevels.push({ price: sess.pdh, name: 'PDH CEILING' });
    if (sess.asian_high > 0) resSupplyLevels.push({ price: sess.asian_high, name: 'ASIAN HIGH' });
    if (snapshot.session_vp && snapshot.session_vp.vah > 0) {
      resSupplyLevels.push({ price: snapshot.session_vp.vah, name: 'VAH SUPPLY' });
    }

    const vwapVal = snapshot.vwap && (snapshot.vwap.value || snapshot.vwap.vwap);

    for (let i = 2; i < rawCandles.length - 1; i++) {
      const rc = rawCandles[i];
      if (this._cdConfirmedSignalsCache.has(rc.time)) continue;

      const isBull = rc.close >= rc.open;
      const totalRange = Math.max(0.20, rc.high - rc.low);
      const lowerWick = Math.min(rc.open, rc.close) - rc.low;
      const upperWick = rc.high - Math.max(rc.open, rc.close);

      // Rolling Volume Baseline
      let sumVol = 0, volCnt = 0;
      for (let k = Math.max(0, i - 12); k < i; k++) {
        sumVol += (rawCandles[k].volume || 0);
        volCnt++;
      }
      const avgVol = volCnt > 0 ? (sumVol / volCnt) : 10;
      const hasInstVolume = (rc.volume || 0) >= avgVol * 0.90;

      const getPocPrice = (c) => {
        let maxV = -1, pocP = null;
        for (const [pStr, cl] of Object.entries(c.clusters || {})) {
          if ((cl.total || 0) > maxV) {
            maxV = cl.total;
            pocP = parseFloat(pStr);
          }
        }
        return pocP !== null ? Number((Math.floor(pocP / step) * step).toFixed(2)) : null;
      };

      const curPoc = getPocPrice(rc);

      // Check Swing Low (Local Demand Base) & Swing High (Local Supply Base)
      let localDemand = null;
      let localSupply = null;
      for (let k = i - 2; k >= Math.max(0, i - 20); k--) {
        const pastC = rawCandles[k];
        const pPrev = rawCandles[k - 1];
        const pNext = rawCandles[k + 1];
        if (pPrev && pNext) {
          if (pastC.low < pPrev.low && pastC.low < pNext.low && !localDemand) {
            localDemand = { price: pastC.low, name: 'SWING DEMAND' };
          }
          if (pastC.high > pPrev.high && pastC.high > pNext.high && !localSupply) {
            localSupply = { price: pastC.high, name: 'SWING SUPPLY' };
          }
        }
      }

      const allDemands = [...supDemandLevels];
      if (localDemand) allDemands.push(localDemand);

      const allSupplies = [...resSupplyLevels];
      if (localSupply) allSupplies.push(localSupply);

      // MANDATORY LOCATION CHECK:
      // A BUY is ONLY allowed if testing a verified Demand / Support zone
      let activeDemand = null;
      for (const d of allDemands) {
        if ((rc.low <= d.price + 0.35 && rc.low >= d.price - 0.55) || (rc.low <= d.price && rc.close >= d.price)) {
          activeDemand = d;
          break;
        }
      }

      // A SELL is ONLY allowed if testing a verified Supply / Resistance zone
      let activeSupply = null;
      for (const s of allSupplies) {
        if ((rc.high >= s.price - 0.35 && rc.high <= s.price + 0.55) || (rc.high >= s.price && rc.close <= s.price)) {
          activeSupply = s;
          break;
        }
      }

      let signal = null;
      const timeDiff = rc.time - lastCdSignalTime;
      const isCooldownOver = (timeDiff >= minCooldownSec);

      if (isCooldownOver && hasInstVolume) {
        // --- 1. BUY SIGNAL: MANDATORY LOCATION AT DEMAND / SUPPORT ONLY ---
        if (activeDemand) {
          const hasDemandRejection = (lowerWick / totalRange >= 0.40) || (isBull && lowerWick / totalRange >= 0.28);
          const hasBuyerCommitment = (rc.delta || 0) > 0.8 || (!isBull && (rc.delta || 0) > 2.5);
          const isNotCrashingDowntrend = !vwapVal || (rc.close >= vwapVal) || (lowerWick / totalRange >= 0.50);

          if (hasDemandRejection && hasBuyerCommitment && isNotCrashingDowntrend) {
            const entry = rc.close;
            const sl = Math.min(rc.low, activeDemand.price) - 0.45;
            const risk = Math.max(0.80, entry - sl);
            const tp = entry + (risk * 2.5);
            signal = {
              direction: 'BUY',
              technique: 'Demand Reversal',
              badge: `🎯 [CD] BUY [${activeDemand.name}]`,
              col: '#00e676',
              entry, sl, tp, risk, reward: tp - entry, rr: 2.5,
              reason: `Lantunan kuat pada Zon ${activeDemand.name} ($${activeDemand.price.toFixed(2)}) + Ekor Rejection (${((lowerWick / totalRange) * 100).toFixed(0)}%)`
            };
          }
        }

        // --- 2. SELL SIGNAL: MANDATORY LOCATION AT SUPPLY / RESISTANCE ONLY ---
        if (!signal && activeSupply) {
          const hasSupplyRejection = (upperWick / totalRange >= 0.40) || (!isBull && upperWick / totalRange >= 0.28);
          const hasSellerCommitment = (rc.delta || 0) < -0.8 || (isBull && (rc.delta || 0) < -2.5);
          const isNotSkyrocketingUptrend = !vwapVal || (rc.close <= vwapVal) || (upperWick / totalRange >= 0.50);

          if (hasSupplyRejection && hasSellerCommitment && isNotSkyrocketingUptrend) {
            const entry = rc.close;
            const sl = Math.max(rc.high, activeSupply.price) + 0.45;
            const risk = Math.max(0.80, sl - entry);
            const tp = entry - (risk * 2.5);
            signal = {
              direction: 'SELL',
              technique: 'Supply Reversal',
              badge: `🎯 [CD] SELL [${activeSupply.name}]`,
              col: '#ff3366',
              entry, sl, tp, risk, reward: entry - tp, rr: 2.5,
              reason: `Tolakan padu pada Zon ${activeSupply.name} ($${activeSupply.price.toFixed(2)}) + Ekor Rejection (${((upperWick / totalRange) * 100).toFixed(0)}%)`
            };
          }
        }
      }

      if (signal) {
        lastCdSignalTime = rc.time;
        lastCdSignalDir = signal.direction;
      }
      this._cdConfirmedSignalsCache.set(rc.time, { signal });
    }

    if (this._cdConfirmedSignalsCache.size > 300) {
      const keys = Array.from(this._cdConfirmedSignalsCache.keys());
      for (let k = 0; k < keys.length - 200; k++) {
        this._cdConfirmedSignalsCache.delete(keys[k]);
      }
    }

    // 4. Pre-aggregate per-candle clusters & right-side composite session profile
    const compositeByPrice = {};
    let globalMaxCellVol = 1;
    let globalMaxCellDelta = 1;
    let maxCandleVol = 1;
    let maxCandleDeltaAbs = 1;

    const processedCandles = candles.map((c, idx) => {
      const isLiveCd = idx === candles.length - 1;
      const cachedCd = (!isLiveCd && this._cdConfirmedSignalsCache) ? this._cdConfirmedSignalsCache.get(c.time) : null;
      const cdSignal = cachedCd ? cachedCd.signal : null;

      const grouped = {};
      for (const [pStr, cl] of Object.entries(c.clusters || {})) {
        const p = parseFloat(pStr);
        const bucket = Number((Math.floor(p / step) * step).toFixed(2));
        const bKey = bucket.toFixed(2);
        if (!grouped[bKey]) {
          grouped[bKey] = {
            price: bucket,
            bid: 0,
            ask: 0,
            total: 0,
            delta: 0,
            isBuyImb: false,
            isSellImb: false
          };
        }
        grouped[bKey].bid += (cl.bid || 0);
        grouped[bKey].ask += (cl.ask || 0);
        grouped[bKey].total += (cl.total || 0);
        grouped[bKey].delta += (cl.delta || 0);

        if (!compositeByPrice[bKey]) {
          compositeByPrice[bKey] = { price: bucket, total: 0, delta: 0 };
        }
        compositeByPrice[bKey].total += (cl.total || 0);
        compositeByPrice[bKey].delta += (cl.delta || 0);
      }

      // Compute diagonal imbalances (Ask at price i+1 vs Bid at price i)
      const sortedKeys = Object.keys(grouped).sort((a, b) => parseFloat(a) - parseFloat(b));
      for (let k = 0; k < sortedKeys.length - 1; k++) {
        const lowCl = grouped[sortedKeys[k]];
        const highCl = grouped[sortedKeys[k + 1]];
        if (lowCl.bid > 0 && highCl.ask / lowCl.bid >= 2.8 && highCl.ask >= 1.5) {
          highCl.isBuyImb = true;
        }
        if (highCl.ask > 0 && lowCl.bid / highCl.ask >= 2.8 && lowCl.bid >= 1.5) {
          lowCl.isSellImb = true;
        }
      }

      // Feature: Detect 3+ Stacked Diagonal Imbalances (Institutional Order Flow Zones)
      let curStackedBuy = [];
      let curStackedSell = [];
      let stackedBuyZone = null;
      let stackedSellZone = null;
      for (let k = 0; k < sortedKeys.length; k++) {
        const cl = grouped[sortedKeys[k]];
        if (cl.isBuyImb) {
          curStackedBuy.push(cl.price);
        } else {
          if (curStackedBuy.length >= 3) {
            stackedBuyZone = { minP: curStackedBuy[0], maxP: curStackedBuy[curStackedBuy.length - 1] + step, count: curStackedBuy.length };
          }
          curStackedBuy = [];
        }

        if (cl.isSellImb) {
          curStackedSell.push(cl.price);
        } else {
          if (curStackedSell.length >= 3) {
            stackedSellZone = { minP: curStackedSell[0], maxP: curStackedSell[curStackedSell.length - 1] + step, count: curStackedSell.length };
          }
          curStackedSell = [];
        }
      }
      if (curStackedBuy.length >= 3) {
        stackedBuyZone = { minP: curStackedBuy[0], maxP: curStackedBuy[curStackedBuy.length - 1] + step, count: curStackedBuy.length };
      }
      if (curStackedSell.length >= 3) {
        stackedSellZone = { minP: curStackedSell[0], maxP: curStackedSell[curStackedSell.length - 1] + step, count: curStackedSell.length };
      }

      let pocPrice = null;
      let maxVol = -1;
      for (const cl of Object.values(grouped)) {
        if (cl.total > maxVol) {
          maxVol = cl.total;
          pocPrice = cl.price;
        }
        if (cl.total > globalMaxCellVol) globalMaxCellVol = cl.total;
        if (Math.abs(cl.delta) > globalMaxCellDelta) globalMaxCellDelta = Math.abs(cl.delta);
      }

      if ((c.volume || 0) > maxCandleVol) maxCandleVol = c.volume;
      if (Math.abs(c.delta || 0) > maxCandleDeltaAbs) maxCandleDeltaAbs = Math.abs(c.delta);

      // Detect Trapped POC / Absorption (POC in upper wick of bearish candle or lower wick of bullish candle)
      const isBull = c.close >= c.open;
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      let trapSignal = null;
      if (pocPrice !== null) {
        if (!isBull && pocPrice >= bodyHigh && (c.high - bodyHigh) >= step * 0.8) {
          trapSignal = '🪤 TRAP BUY';
        } else if (isBull && pocPrice <= bodyLow && (bodyLow - c.low) >= step * 0.8) {
          trapSignal = '🪤 TRAP SELL';
        }
      }

      // Feature: Delta Climax & Exhaustion Absorption Callouts
      let climaxSignal = null;
      const cDelta = c.delta || 0;
      const cVol = Math.max(1, c.volume || 1);
      const wickTop = c.high - Math.max(c.open, c.close);
      const wickBot = Math.min(c.open, c.close) - c.low;
      const cRange = Math.max(0.1, c.high - c.low);

      if (cDelta > 8.0 && (cDelta / cVol >= 0.38) && (wickTop / cRange >= 0.38)) {
        climaxSignal = { type: 'BUY_CLIMAX', label: '⚡ BUY CLIMAX', col: '#00f0ff' };
      } else if (cDelta < -8.0 && (Math.abs(cDelta) / cVol >= 0.38) && (wickBot / cRange >= 0.38)) {
        climaxSignal = { type: 'SELL_CLIMAX', label: '⚡ SELL CLIMAX', col: '#f43f5e' };
      }

      return {
        raw: c,
        grouped,
        pocPrice,
        maxVol,
        trapSignal,
        stackedBuyZone,
        stackedSellZone,
        climaxSignal,
        cdSignal,
        isLatest: idx === candles.length - 1
      };
    });

    let latestCdSignalIdx = -1;
    for (let i = processedCandles.length - 2; i >= 0; i--) {
      if (processedCandles[i].cdSignal) {
        latestCdSignalIdx = i;
        break;
      }
    }

    // Merge snapshot.session_vp into compositeByPrice so right profile shows full session depth
    if (snapshot.session_vp && snapshot.session_vp.buckets) {
      for (const b of snapshot.session_vp.buckets) {
        const bucket = Number((Math.floor(b.price / step) * step).toFixed(2));
        const bKey = bucket.toFixed(2);
        if (!compositeByPrice[bKey]) {
          compositeByPrice[bKey] = { price: bucket, total: 0, delta: 0 };
        }
        if (b.total > compositeByPrice[bKey].total) {
          compositeByPrice[bKey].total = b.total;
          compositeByPrice[bKey].delta = b.delta || compositeByPrice[bKey].delta;
        }
      }
    }

    // 5. Draw Subtle Alternating Row Bands & Horizontal Grid Lines
    for (let r = 0; r < numRows; r++) {
      const y = topHeaderH + r * rowH;
      if (r % 2 === 1) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
        ctx.fillRect(0, y, chartW, rowH);
      }
      ctx.strokeStyle = '#2c3038';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();
    }

    // 6. Calculate Column Width (Supports up to 50 Tightly Packed ClusterDelta Columns)
    const maxColW = Math.floor((chartW - 10) / Math.max(6, candles.length));
    const colW = Math.max(15, Math.min(82, maxColW));
    const totalColsW = colW * candles.length;
    const startX = Math.max(4, chartW - totalColsW - 4);
    const hdrFontPx = colW >= 42 ? 10 : (colW >= 26 ? 8.2 : 7.0);
    const cellFontPx = Math.min(10.5, Math.max(6.8, Math.min(Math.floor(rowH - 1.2), Math.floor(colW * 0.42))));

    this.hoverCell = null;

    // 7. Draw Institutional Support/Resistance Zone Rays (from 3x Imbalances & Extreme Purple Clusters)
    if (this.cdShowZoneRays) {
      for (let i = 0; i < processedCandles.length - 1; i++) {
        const pc = processedCandles[i];
        const colX = startX + (i + 1) * colW;
        for (const cl of Object.values(pc.grouped)) {
          if (cl.price < lowest || cl.price >= highest) continue;
          const isExtreme = cl.total >= globalMaxCellVol * 0.78;
          if (! isExtreme && !(cl.isBuyImb && cl.total >= globalMaxCellVol * 0.45) && !(cl.isSellImb && cl.total >= globalMaxCellVol * 0.45)) {
            continue;
          }
          const rayY = priceToRowY(cl.price + step);
          const isDemand = cl.delta >= 0;
          ctx.fillStyle = isDemand ? 'rgba(16, 185, 129, 0.09)' : 'rgba(244, 63, 94, 0.09)';
          ctx.fillRect(colX, rayY, chartW - colX, rowH);
        }
      }
    }

    // 8. Draw Top 4-Row Institutional Table Background (y: topControlH .. topHeaderH) - OLED Dark Slate
    ctx.fillStyle = '#0b1322';
    ctx.fillRect(0, topControlH, this.width, topTableH);

    // 9. Render Each Candle Column + Top 4-Row Telemetry Table + Brick Matrix
    const pocPoints = [];

    for (let i = 0; i < processedCandles.length; i++) {
      const pc = processedCandles[i];
      const c = pc.raw;
      const x = startX + i * colW;
      const isBull = c.close >= c.open;

      // --- TOP ROW 1 (y: topControlH + 0..17): Total Candle Volume (Dark Emerald Glow) ---
      const r1Y = topControlH;
      const volRatio = Math.min(1, (c.volume || 0) / maxCandleVol);
      ctx.fillStyle = pc.isLatest
        ? 'rgba(74, 222, 128, 0.28)'
        : `rgba(16, 185, 129, ${0.08 + volRatio * 0.35})`;
      ctx.fillRect(x, r1Y, colW, 17);

      // Bottom progress line inside Volume cell
      ctx.fillStyle = pc.isLatest ? '#4ade80' : 'rgba(74, 222, 128, 0.45)';
      ctx.fillRect(x + 1, r1Y + 14.5, (colW - 2) * volRatio, 2.0);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x, r1Y, colW, 17);

      ctx.fillStyle = pc.isLatest ? '#4ade80' : '#86efac';
      ctx.font = `bold ${hdrFontPx}px "JetBrains Mono", monospace`;
      ctx.textAlign = colW >= 26 ? 'right' : 'center';
      const volDisp = Math.round((c.volume || 0) * 10);
      const volDispStr = (colW < 26 && volDisp >= 1000) ? ((volDisp / 1000).toFixed(1) + 'k') : volDisp.toString();
      ctx.fillText(volDispStr, colW >= 26 ? (x + colW - 3) : (x + colW / 2), r1Y + 12);

      // --- TOP ROW 2 (y: topControlH + 17..34): Net Candle Delta (Neon Cyan / Pink Cell) ---
      const r2Y = topControlH + 17;
      const dVal = Math.round((c.delta || 0) * 10);
      const dRatio = Math.min(1, Math.abs(c.delta || 0) / maxCandleDeltaAbs);
      if (dVal >= 0) {
        ctx.fillStyle = `rgba(14, 165, 233, ${0.10 + dRatio * 0.38})`;
      } else {
        ctx.fillStyle = `rgba(244, 63, 94, ${0.10 + dRatio * 0.38})`;
      }
      ctx.fillRect(x, r2Y, colW, 17);
      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(x, r2Y, colW, 17);

      ctx.fillStyle = dVal >= 0 ? '#38bdf8' : '#fb7185';
      ctx.font = `bold ${hdrFontPx}px "JetBrains Mono", monospace`;
      ctx.textAlign = colW >= 26 ? 'right' : 'center';
      let dStr = (dVal > 0 ? '+' : '') + dVal.toString();
      if (colW < 26 && Math.abs(dVal) >= 1000) dStr = (dVal / 1000).toFixed(1) + 'k';
      ctx.fillText(dStr, colW >= 26 ? (x + colW - 3) : (x + colW / 2), r2Y + 12);

      // --- TOP ROW 3 (y: topControlH + 34..50): Delta % & Divergence Detector ---
      const r3Y = topControlH + 34;
      const deltaPct = (c.volume || 0) > 0 ? Math.round(((c.delta || 0) / c.volume) * 100) : 0;
      const isDivergent = (isBull && c.delta < -1.5) || (!isBull && c.delta > 1.5);
      ctx.fillStyle = isDivergent ? 'rgba(251, 191, 36, 0.22)' : '#101a2c';
      ctx.fillRect(x, r3Y, colW, 16);
      ctx.strokeStyle = isDivergent ? '#facc15' : '#1e293b';
      ctx.strokeRect(x, r3Y, colW, 16);

      ctx.fillStyle = isDivergent ? '#fde047' : (deltaPct >= 0 ? '#4ade80' : '#f87171');
      ctx.font = `bold ${Math.max(6.8, hdrFontPx - 0.5)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      const pctText = colW >= 34
        ? (isDivergent ? `⚠️${deltaPct > 0 ? '+' : ''}${deltaPct}%` : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`)
        : `${deltaPct}%`;
      ctx.fillText(pctText, x + colW / 2, r3Y + 11.5);

      // --- TOP ROW 4 (y: topControlH + 50..68): Candle Time Label (HH:MM) ---
      const r4Y = topControlH + 50;
      ctx.fillStyle = pc.isLatest ? 'rgba(56, 189, 248, 0.20)' : '#0d1527';
      ctx.fillRect(x, r4Y, colW, 18);
      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(x, r4Y, colW, 18);

      const dObj = new Date((c.time || 0) * 1000);
      const rawH = dObj.getHours();
      const h12 = rawH % 12 || 12;
      const ampm = rawH >= 12 ? 'pm' : 'am';
      const hh = String(h12).padStart(2, '0');
      const mm = String(dObj.getMinutes()).padStart(2, '0');
      ctx.fillStyle = pc.isLatest ? '#38bdf8' : '#94a3b8';
      ctx.font = `bold ${hdrFontPx}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      if (colW >= 42) {
        ctx.fillText(pc.isLatest ? `⚡${hh}:${mm}${ampm}` : `${hh}:${mm}${ampm}`, x + colW / 2, r4Y + 13);
      } else if (colW >= 30) {
        ctx.fillText(pc.isLatest ? `⚡${hh}:${mm}` : `${hh}:${mm}`, x + colW / 2, r4Y + 13);
      } else if (pc.isLatest || i % 2 === 0) {
        ctx.fillText(pc.isLatest ? `⚡${mm}` : `:${mm}`, x + colW / 2, r4Y + 13);
      }

      // --- BRICK CLUSTER CELLS ---
      for (const cl of Object.values(pc.grouped)) {
        const p = cl.price;
        if (p < lowest || p >= highest) continue;

        const boxY = priceToRowY(p + step);
        const boxH = Math.max(7.5, rowH);
        const isPOC = pc.pocPrice !== null && Math.abs(pc.pocPrice - p) < 0.005;
        const isCurrentPriceRow = pc.isLatest && Math.abs(lastPrice - p) < step;
        const vNorm = cl.total / globalMaxCellVol;
        const dNorm = Math.min(1, Math.abs(cl.delta) / globalMaxCellDelta);

        // Feature 2: High-Volume Neutral Delta Absorption Node Detection
        const isAbsorbNode = !isPOC && (
          (cl.total >= 25.0 && Math.abs(cl.delta) <= 3.2) ||
          (vNorm >= 0.50 && Math.abs(cl.delta) / Math.max(1, cl.total) <= 0.12)
        );

        if (isPOC) {
          pocPoints.push({ x: x + colW / 2, y: boxY + boxH / 2, price: p });
        }

        // Hover detection
        if (
          this.mousePos.x >= x && this.mousePos.x <= x + colW &&
          this.mousePos.y >= boxY && this.mousePos.y <= boxY + boxH
        ) {
          this.hoverCell = {
            price: p,
            priceRange: `$${p.toFixed(2)} - $${(p + step).toFixed(2)}`,
            bid: cl.bid,
            ask: cl.ask,
            delta: cl.delta,
            total: cl.total,
            candleSharePct: c.volume > 0 ? Math.round((cl.total / c.volume) * 100) : 0,
            isPOC,
            isAbsorptionNode: isAbsorbNode,
            inValueArea: false,
            isBuyImbalance: cl.isBuyImb,
            isSellImbalance: cl.isSellImb,
            cdSignal: pc.cdSignal || null,
            screenX: this.mousePos.x,
            screenY: this.mousePos.y
          };
        }

        // Render brick based on selected ClusterDelta Sub-Mode (this.cdCellMode)
        if (this.cdCellMode === 'bid_ask') {
          // Split Dual-Column Brick (Bid on Left, Ask on Right)
          const halfW = colW / 2;
          ctx.fillStyle = cl.isSellImb ? '#e11d48' : `rgba(244, 63, 94, ${0.22 + vNorm * 0.6})`;
          ctx.fillRect(x, boxY, halfW, boxH);
          ctx.fillStyle = cl.isBuyImb ? '#059669' : `rgba(16, 185, 129, ${0.22 + vNorm * 0.6})`;
          ctx.fillRect(x + halfW, boxY, halfW, boxH);

          ctx.strokeStyle = '#1f2937';
          ctx.lineWidth = 0.8;
          ctx.strokeRect(x, boxY, colW, boxH);

          if (boxH >= 8.5 && colW >= 26) {
            ctx.font = `bold ${Math.max(6.8, cellFontPx - 1)}px "JetBrains Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffe4e6';
            ctx.fillText(Math.round(cl.bid * 10).toString(), x + halfW / 2, boxY + boxH / 2 + 2.8);
            ctx.fillStyle = '#d1fae5';
            ctx.fillText(Math.round(cl.ask * 10).toString(), x + halfW + halfW / 2, boxY + boxH / 2 + 2.8);
          }
        } else if (this.cdCellMode === 'delta') {
          // Signed Delta Heatmap Brick
          const bgCol = isCurrentPriceRow
            ? '#475569'
            : (cl.delta >= 0
                ? `rgb(${Math.round(220 - dNorm * 165)}, ${Math.round(252 - dNorm * 45)}, ${Math.round(231 - dNorm * 130)})`
                : `rgb(254, ${Math.round(226 - dNorm * 145)}, ${Math.round(226 - dNorm * 145)})`);
          ctx.fillStyle = bgCol;
          ctx.fillRect(x, boxY, colW, boxH);
          ctx.strokeStyle = '#374151';
          ctx.lineWidth = 0.7;
          ctx.strokeRect(x, boxY, colW, boxH);

          if (boxH >= 7.8) {
            const dispD = Math.round(cl.delta * 10);
            ctx.fillStyle = isCurrentPriceRow ? '#ffffff' : (dispD >= 0 ? '#064e3b' : '#7f1d1d');
            ctx.font = `${isPOC || dNorm >= 0.5 ? 'bold ' : ''}${cellFontPx}px "JetBrains Mono", monospace`;
            ctx.textAlign = colW >= 26 ? 'right' : 'center';
            const dCellStr = colW >= 24 ? ((dispD > 0 ? '+' : '') + dispD.toString()) : dispD.toString();
            ctx.fillText(dCellStr, colW >= 26 ? (x + colW - 3) : (x + colW / 2), boxY + boxH / 2 + 3);
          }
        } else {
          // 'volume' (Classic ClusterDelta) or 'imbalance' (ClusterDelta Imbalance Pro)
          let bgCol = '#fef3c7'; // Tier 1: Cream Yellow
          let txtCol = '#111827';
          const hasStrongImb = (cl.isBuyImb || cl.isSellImb) && cl.total >= globalMaxCellVol * 0.38;

          if (isCurrentPriceRow) {
            bgCol = '#475569';
            txtCol = '#ffffff';
          } else if (this.cdCellMode === 'imbalance' && cl.isBuyImb) {
            bgCol = '#06b6d4'; // Neon Cyan Buy Imbalance
            txtCol = '#0f172a';
          } else if (this.cdCellMode === 'imbalance' && cl.isSellImb) {
            bgCol = '#f43f5e'; // Vivid Crimson Sell Imbalance
            txtCol = '#ffffff';
          } else if (vNorm >= 0.78 || hasStrongImb) {
            bgCol = '#6366f1'; // Tier 5: ClusterDelta Royal Indigo/Purple
            txtCol = '#ffffff';
          } else if (vNorm >= 0.56) {
            bgCol = '#f97316'; // Tier 4: Deep Orange
            txtCol = '#111827';
          } else if (vNorm >= 0.35) {
            bgCol = '#fbbf24'; // Tier 3: Warm Amber
            txtCol = '#111827';
          } else if (vNorm >= 0.18) {
            bgCol = '#fde68a'; // Tier 2: Soft Gold
            txtCol = '#1f2937';
          }

          ctx.fillStyle = bgCol;
          ctx.fillRect(x, boxY, colW, boxH);

          ctx.strokeStyle = '#374151';
          ctx.lineWidth = 0.7;
          ctx.strokeRect(x, boxY, colW, boxH);

          if (boxH >= 7.8) {
            const dispVol = Math.max(1, Math.round(cl.total * 10));
            ctx.fillStyle = txtCol;
            ctx.font = `${isPOC || vNorm >= 0.55 ? 'bold ' : ''}${cellFontPx}px "JetBrains Mono", monospace`;
            ctx.textAlign = colW >= 26 ? 'right' : 'center';
            ctx.fillText(dispVol.toString(), colW >= 26 ? (x + colW - 3) : (x + colW / 2), boxY + boxH / 2 + 3);
          }
        }

        // ClusterDelta Iconic 2px Solid Black Rectangular POC Frame ([ 203 ])
        if (isPOC) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.6;
          ctx.strokeRect(x + 1.5, boxY + 1, colW - 3, boxH - 2);
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.8;
          ctx.strokeRect(x + 2, boxY + 1.5, colW - 4, boxH - 3);
        } else if (isAbsorbNode) {
          // Feature 2: High-Volume Neutral Delta Absorption Node Frame (Neon Violet with 🧱 icon)
          ctx.save();
          ctx.strokeStyle = '#c084fc'; // Neon Violet
          ctx.lineWidth = 1.8;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(x + 1, boxY + 1, colW - 2, boxH - 2);
          ctx.setLineDash([]);
          if (boxH >= 11 && colW >= 24) {
            ctx.fillStyle = '#c084fc';
            ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            ctx.fillText('🧱', x + 2, boxY + 8);
          }
          ctx.restore();
        }
      }

      // --- LEFT-EDGE CANDLE DIRECTION BAR (Open/Close Body + High/Low Wick) ---
      const yHigh = priceToRowY(Math.min(highest, c.high + step * 0.5));
      const yLow = priceToRowY(Math.max(lowest, c.low));
      const yOpen = priceToRowY(c.open + step * 0.5);
      const yClose = priceToRowY(c.close + step * 0.5);

      ctx.strokeStyle = isBull ? '#16a34a' : '#dc2626';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x + 2.5, yHigh);
      ctx.lineTo(x + 2.5, yLow);
      ctx.stroke();

      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(5, Math.abs(yClose - yOpen));
      ctx.fillStyle = isBull ? '#16a34a' : '#dc2626';
      ctx.fillRect(x + 0.5, bodyTop, 4.5, bodyH);

      const cx = x + colW / 2;

      // Feature: Stacked Diagonal Imbalance Zone (3+ consecutive levels)
      if (this.cdShowStackedImb !== false) {
        if (pc.stackedBuyZone) {
          const zTop = priceToRowY(pc.stackedBuyZone.maxP);
          const zBot = priceToRowY(pc.stackedBuyZone.minP);
          const zH = Math.max(8, zBot - zTop);
          ctx.save();
          ctx.fillStyle = 'rgba(6, 182, 212, 0.16)';
          ctx.fillRect(x, zTop, colW, zH);
          ctx.strokeStyle = '#00f0ff';
          ctx.lineWidth = 1.6;
          ctx.strokeRect(x, zTop, colW, zH);

          if (i >= processedCandles.length - 6) {
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(x + colW, zTop + zH / 2);
            ctx.lineTo(chartW - 4, zTop + zH / 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.restore();
        }

        if (pc.stackedSellZone) {
          const zTop = priceToRowY(pc.stackedSellZone.maxP);
          const zBot = priceToRowY(pc.stackedSellZone.minP);
          const zH = Math.max(8, zBot - zTop);
          ctx.save();
          ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
          ctx.fillRect(x, zTop, colW, zH);
          ctx.strokeStyle = '#ff0055';
          ctx.lineWidth = 1.6;
          ctx.strokeRect(x, zTop, colW, zH);

          if (i >= processedCandles.length - 6) {
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#ff0055';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(x + colW, zTop + zH / 2);
            ctx.lineTo(chartW - 4, zTop + zH / 2);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.restore();
        }
      }

      // Feature: Delta Climax & Exhaustion Absorption Callout Badge
      if (this.cdShowClimax !== false && pc.climaxSignal) {
        ctx.save();
        const sig = pc.climaxSignal;
        const isBuyClimax = sig.type === 'BUY_CLIMAX';
        const tagY = isBuyClimax ? (yHigh - 16) : (yLow + 6);
        ctx.fillStyle = isBuyClimax ? 'rgba(8, 47, 73, 0.95)' : 'rgba(76, 5, 25, 0.95)';
        ctx.strokeStyle = sig.col;
        ctx.lineWidth = 1.1;
        const tagW = Math.max(colW - 2, 42);
        const tagX = cx - tagW / 2;
        ctx.fillRect(tagX, tagY, tagW, 13);
        ctx.strokeRect(tagX, tagY, tagW, 13);
        ctx.fillStyle = sig.col;
        ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(colW >= 32 ? sig.label : (isBuyClimax ? '⚡CLIMAX' : '⚡EXHAUST'), cx, tagY + 9.5);
        ctx.restore();
      }

      // --- INSTITUTIONAL CLUSTERDELTA SIGNALS (BUY / SELL BADGES & ARROWS) ---
      if (this.cdShowSignals && pc.cdSignal) {
        const sig = pc.cdSignal;
        const isBuy = sig.direction === 'BUY';

        ctx.save();
        if (isBuy) {
          // BUY Signal below candle low
          const arrowTipY = Math.min(topHeaderH + chartH - 22, yLow + 4);
          const arrowBaseY = arrowTipY + 8;
          const badgeBoxY = arrowBaseY + 2;
          const badgeH = 14;
          const badgeW = Math.max(colW - 2, 46);

          // Draw Chevron Up Triangle (▲)
          ctx.fillStyle = '#00e676';
          ctx.beginPath();
          ctx.moveTo(cx, arrowTipY);
          ctx.lineTo(cx - 5.5, arrowBaseY);
          ctx.lineTo(cx + 5.5, arrowBaseY);
          ctx.closePath();
          ctx.fill();

          // Draw Glowing Badge Pill
          ctx.fillStyle = 'rgba(6, 78, 59, 0.95)';
          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(cx - badgeW / 2, badgeBoxY, badgeW, badgeH, 3);
          } else {
            ctx.rect(cx - badgeW / 2, badgeBoxY, badgeW, badgeH);
          }
          ctx.fill();
          ctx.stroke();

          // Badge Text
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          const label = sig.technique === 'POC Expansion' ? '▲POC BUY' : '▲BUY ABS';
          ctx.fillText(colW >= 36 ? label : '▲BUY', cx, badgeBoxY + 10.5);

        } else {
          // SELL Signal above candle high
          const arrowTipY = Math.max(topHeaderH + 22, yHigh - 4);
          const arrowBaseY = arrowTipY - 8;
          const badgeBoxY = arrowBaseY - 16;
          const badgeH = 14;
          const badgeW = Math.max(colW - 2, 46);

          // Draw Chevron Down Triangle (▼)
          ctx.fillStyle = '#ff3366';
          ctx.beginPath();
          ctx.moveTo(cx, arrowTipY);
          ctx.lineTo(cx - 5.5, arrowBaseY);
          ctx.lineTo(cx + 5.5, arrowBaseY);
          ctx.closePath();
          ctx.fill();

          // Draw Glowing Badge Pill
          ctx.fillStyle = 'rgba(127, 29, 29, 0.95)';
          ctx.strokeStyle = '#ff3366';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(cx - badgeW / 2, badgeBoxY, badgeW, badgeH, 3);
          } else {
            ctx.rect(cx - badgeW / 2, badgeBoxY, badgeW, badgeH);
          }
          ctx.fill();
          ctx.stroke();

          // Badge Text
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          const label = sig.technique === 'POC Expansion' ? '▼POC SELL' : '▼SELL ABS';
          ctx.fillText(colW >= 36 ? label : '▼SELL', cx, badgeBoxY + 10.5);
        }

        // Project SL & TP ray pegs if this is the latest confirmed signal or if mouse is hovering this column
        const isHoveredCol = this.mousePos.x >= x && this.mousePos.x <= x + colW;
        if (i === latestCdSignalIdx || isHoveredCol) {
          const entryY = priceToRowY(sig.entry);
          const slY = priceToRowY(sig.sl);
          const tpY = priceToRowY(sig.tp);
          const rayEndX = Math.min(chartW - 4, cx + colW * 3.8);

          // Entry Ray (Gold Dashed)
          if (entryY >= topHeaderH && entryY <= topHeaderH + chartH) {
            ctx.setLineDash([3, 2]);
            ctx.strokeStyle = '#ffd60a';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(cx, entryY);
            ctx.lineTo(rayEndX, entryY);
            ctx.stroke();

            ctx.fillStyle = 'rgba(254, 240, 138, 0.2)';
            ctx.fillRect(rayEndX - 34, entryY - 7, 34, 14);
            ctx.fillStyle = '#fef08a';
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`EP $${sig.entry.toFixed(1)}`, rayEndX - 2, entryY + 3.5);
          }

          // TP Ray (Green Dashed)
          if (tpY >= topHeaderH && tpY <= topHeaderH + chartH) {
            ctx.setLineDash([4, 2]);
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(cx, tpY);
            ctx.lineTo(rayEndX, tpY);
            ctx.stroke();

            ctx.fillStyle = '#064e3b';
            ctx.fillRect(rayEndX - 34, tpY - 7, 34, 14);
            ctx.strokeStyle = '#10b981';
            ctx.strokeRect(rayEndX - 34, tpY - 7, 34, 14);
            ctx.fillStyle = '#6ee7b7';
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`TP $${sig.tp.toFixed(1)}`, rayEndX - 2, tpY + 3.5);
          }

          // SL Ray (Red Dashed)
          if (slY >= topHeaderH && slY <= topHeaderH + chartH) {
            ctx.setLineDash([4, 2]);
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(cx, slY);
            ctx.lineTo(rayEndX, slY);
            ctx.stroke();

            ctx.fillStyle = '#881337';
            ctx.fillRect(rayEndX - 34, slY - 7, 34, 14);
            ctx.strokeStyle = '#f43f5e';
            ctx.strokeRect(rayEndX - 34, slY - 7, 34, 14);
            ctx.fillStyle = '#fda4af';
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`SL $${sig.sl.toFixed(1)}`, rayEndX - 2, slY + 3.5);
          }
          ctx.setLineDash([]);
        }
        ctx.restore();

      } else if (pc.trapSignal) {
        const isTrapBuy = pc.trapSignal.includes('BUY');
        const badgeY = isTrapBuy ? Math.max(topHeaderH + 12, yHigh - 6) : Math.min(topHeaderH + chartH - 6, yLow + 12);
        ctx.fillStyle = isTrapBuy ? '#dc2626' : '#16a34a';
        ctx.fillRect(x + 4, badgeY - 9, colW - 8, 12);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(isTrapBuy ? '🪤TRAP' : '🧱ABSORB', x + colW / 2, badgeY);
      }
    }

    // 10. Draw Stepped Orthogonal POC Migration Staircase (Value Acceptance & Flow Tracking)
    if ((this.cdShowPocLine || this.cdShowPocMigration !== false) && pocPoints.length > 1) {
      ctx.save();
      // Outer shadow contrast stroke
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.90)';
      ctx.lineWidth = 3.8;
      ctx.beginPath();
      for (let k = 0; k < pocPoints.length; k++) {
        const pt = pocPoints[k];
        if (k === 0) {
          ctx.moveTo(pt.x, pt.y);
        } else {
          const prev = pocPoints[k - 1];
          ctx.lineTo(pt.x, prev.y);
          ctx.lineTo(pt.x, pt.y);
        }
      }
      ctx.stroke();

      // Glowing Neon Gold Stepped Staircase
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.0;
      ctx.shadowColor = '#facc15';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      for (let k = 0; k < pocPoints.length; k++) {
        const pt = pocPoints[k];
        if (k === 0) {
          ctx.moveTo(pt.x, pt.y);
        } else {
          const prev = pocPoints[k - 1];
          ctx.lineTo(pt.x, prev.y);
          ctx.lineTo(pt.x, pt.y);
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Glowing nodes on each POC
      for (const pt of pocPoints) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.0, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();
    }

    // 11. Draw Institutional Higher Timeframe SNR (M15, M30, H1, H4, H8) & Benchmarks (VWAP, dPOC, PDH/PDL)
    const cdLevels = [];
    if (this.cdShowSNR) {
      const sess = snapshot.sessions || snapshot.htf_snr || {};
      const h8Res = sess.h8_res || sess.h8_high;
      const h8Sup = sess.h8_sup || sess.h8_low;
      const h4Res = sess.h4_res || sess.h4_high;
      const h4Sup = sess.h4_sup || sess.h4_low;
      const h1Res = sess.h1_res || sess.h1_high;
      const h1Sup = sess.h1_sup || sess.h1_low;
      const m30Res = sess.m30_res || sess.m30_high;
      const m30Sup = sess.m30_sup || sess.m30_low;
      const m15Res = sess.m15_res || sess.m15_high;
      const m15Sup = sess.m15_sup || sess.m15_low;

      if (h8Res > 0) cdLevels.push({ price: h8Res, code: 'H8 RES', label: '🏛️ H8 RES', col: '#e11d48', bg: '#881337', dash: [8, 4], width: 1.8, isMajor: true });
      if (h8Sup > 0) cdLevels.push({ price: h8Sup, code: 'H8 SUP', label: '🏛️ H8 SUP', col: '#059669', bg: '#064e3b', dash: [8, 4], width: 1.8, isMajor: true });
      if (h4Res > 0) cdLevels.push({ price: h4Res, code: 'H4 RES', label: '🏰 H4 RES', col: '#ec4899', bg: '#831843', dash: [6, 3], width: 1.5, isMajor: true });
      if (h4Sup > 0) cdLevels.push({ price: h4Sup, code: 'H4 SUP', label: '🏰 H4 SUP', col: '#10b981', bg: '#064e3b', dash: [6, 3], width: 1.5, isMajor: true });
      if (h1Res > 0) cdLevels.push({ price: h1Res, code: 'H1 RES', label: '⏱️ H1 RES', col: '#f97316', bg: '#7c2d12', dash: [5, 3], width: 1.3, isMajor: false });
      if (h1Sup > 0) cdLevels.push({ price: h1Sup, code: 'H1 SUP', label: '⏱️ H1 SUP', col: '#06b6d4', bg: '#164e63', dash: [5, 3], width: 1.3, isMajor: false });
      if (m30Res > 0) cdLevels.push({ price: m30Res, code: 'M30 RES', label: '⏳ M30 RES', col: '#a855f7', bg: '#581c87', dash: [4, 3], width: 1.2, isMajor: false });
      if (m30Sup > 0) cdLevels.push({ price: m30Sup, code: 'M30 SUP', label: '⏳ M30 SUP', col: '#3b82f6', bg: '#1e3a8a', dash: [4, 3], width: 1.2, isMajor: false });
      if (m15Res > 0) cdLevels.push({ price: m15Res, code: 'M15 RES', label: '⚡ M15 RES', col: '#fbbf24', bg: '#78350f', dash: [3, 3], width: 1.1, isMajor: false });
      if (m15Sup > 0) cdLevels.push({ price: m15Sup, code: 'M15 SUP', label: '⚡ M15 SUP', col: '#2dd4bf', bg: '#134e4a', dash: [3, 3], width: 1.1, isMajor: false });
    }

    if (this.cdShowBenchmarks) {
      const vwapVal = snapshot.vwap && (snapshot.vwap.value || snapshot.vwap.vwap);
      if (vwapVal > 0) cdLevels.push({ price: vwapVal, code: 'VWAP', label: '🌐 VWAP', col: '#00f0ff', bg: '#083344', dash: [], width: 1.4 });
      if (snapshot.session_vp && snapshot.session_vp.dpoc > 0) {
        cdLevels.push({ price: snapshot.session_vp.dpoc, code: 'dPOC', label: '⭐ dPOC', col: '#ffd60a', bg: '#78350f', dash: [4, 3], width: 1.2 });
      }
      if (snapshot.sessions) {
        const s = snapshot.sessions;
        if (s.pdh > 0) cdLevels.push({ price: s.pdh, code: 'PDH', label: '🏛️ PDH', col: '#fde047', bg: '#713f12', dash: [6, 3], width: 1.2 });
        if (s.pdl > 0) cdLevels.push({ price: s.pdl, code: 'PDL', label: '🏛️ PDL', col: '#fde047', bg: '#713f12', dash: [6, 3], width: 1.2 });
      }
    }

    // Draw the horizontal lines & tags
    const drawnCdTagYs = [];
    for (const lv of cdLevels) {
      if (lv.price < lowest || lv.price > highest) continue;
      const ly = priceToRowY(lv.price);
      if (ly < topHeaderH + 10 || ly > topHeaderH + chartH - 10) continue;

      ctx.save();
      ctx.setLineDash(lv.dash || [5, 3]);
      ctx.strokeStyle = lv.col;
      ctx.lineWidth = lv.width || 1.2;
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(chartW, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      // Non-overlapping badge tag on right side of chart (before the panel)
      let tagY = ly;
      while (drawnCdTagYs.some(dy => Math.abs(dy - tagY) < 15)) {
        tagY += 15;
      }
      if (tagY <= topHeaderH + chartH - 10) {
        drawnCdTagYs.push(tagY);
        const tagText = `${lv.label} $${lv.price.toFixed(2)}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const tagW = ctx.measureText(tagText).width + 10;
        const tagX = chartW - tagW - 6;

        ctx.fillStyle = 'rgba(10, 15, 26, 0.92)';
        ctx.fillRect(tagX, tagY - 7, tagW, 14);
        ctx.fillStyle = lv.bg;
        ctx.fillRect(tagX, tagY - 7, tagW, 14);
        ctx.strokeStyle = lv.col;
        ctx.lineWidth = 1;
        ctx.strokeRect(tagX, tagY - 7, tagW, 14);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(tagText, tagX + tagW / 2, tagY + 3.5);
      }
      ctx.restore();
    }

    // 12. Render Right-Side 3-Column ClusterDelta Profile Panel (VOL + VA 70% | DELTA | HARGA)
    const panelX = chartW;
    const volColW = 84;
    const deltaColW = 54;
    const priceColW = 66;

    // Top-right corner status box (y: topControlH .. topHeaderH) - OLED Charcoal Slate
    ctx.fillStyle = '#0b1322';
    ctx.fillRect(panelX, topControlH, rightPanelW, topTableH);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX, topControlH, rightPanelW, topTableH);

    // Green checkmark circle + Live Session Totals
    ctx.beginPath();
    ctx.arc(panelX + 22, topControlH + 24, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#064e3b';
    ctx.fill();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✓', panelX + 22, topControlH + 28);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`SESI CVD: ${(snapshot.cvd || 0) >= 0 ? '+' : ''}${(snapshot.cvd || 0).toFixed(0)}L`, panelX + 38, topControlH + 20);
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText(`BLOK: $${step.toFixed(2)}`, panelX + 38, topControlH + 34);

    // Sub-column headers at y: topControlH + 50 .. topHeaderH
    const hdrSubY = topControlH + 50;
    ctx.fillStyle = '#111827';
    ctx.fillRect(panelX, hdrSubY, rightPanelW, 18);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(panelX, hdrSubY, volColW, 18);
    ctx.strokeRect(panelX + volColW, hdrSubY, deltaColW, 18);
    ctx.strokeRect(panelX + volColW + deltaColW, hdrSubY, priceColW, 18);

    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#facc15';
    ctx.fillText('VOL + VA70%', panelX + volColW / 2, hdrSubY + 12.5);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('DELTA', panelX + volColW + deltaColW / 2, hdrSubY + 12.5);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('HARGA', panelX + volColW + deltaColW + priceColW / 2, hdrSubY + 12.5);

    // Compute Composite Session POC and 70% Value Area (VAH / VAL) across visible rows
    let maxCompVol = 1;
    let maxCompDeltaAbs = 1;
    let compPocRowIdx = 0;
    let totalVisibleCompVol = 0;
    const rowProfiles = [];

    for (let r = 0; r < numRows; r++) {
      const p = Number((highest - (r + 1) * step).toFixed(2));
      const bKey = p.toFixed(2);
      const comp = compositeByPrice[bKey] || { total: 0, delta: 0 };
      rowProfiles.push({ r, p, bKey, total: comp.total, delta: comp.delta, inVA: false });
      totalVisibleCompVol += comp.total;
      if (comp.total > maxCompVol) {
        maxCompVol = comp.total;
        compPocRowIdx = r;
      }
      if (Math.abs(comp.delta) > maxCompDeltaAbs) {
        maxCompDeltaAbs = Math.abs(comp.delta);
      }
    }

    // Expand 70% Value Area around compPocRowIdx
    if (rowProfiles.length > 0 && totalVisibleCompVol > 0) {
      let vaAccum = rowProfiles[compPocRowIdx].total;
      rowProfiles[compPocRowIdx].inVA = true;
      let upIdx = compPocRowIdx;
      let dnIdx = compPocRowIdx;
      const targetVA = totalVisibleCompVol * 0.70;
      while (vaAccum < targetVA && (upIdx > 0 || dnIdx < rowProfiles.length - 1)) {
        const upV = upIdx > 0 ? rowProfiles[upIdx - 1].total : -1;
        const dnV = dnIdx < rowProfiles.length - 1 ? rowProfiles[dnIdx + 1].total : -1;
        if (upV >= dnV && upIdx > 0) {
          upIdx--;
          rowProfiles[upIdx].inVA = true;
          vaAccum += Math.max(0, upV);
        } else if (dnIdx < rowProfiles.length - 1) {
          dnIdx++;
          rowProfiles[dnIdx].inVA = true;
          vaAccum += Math.max(0, dnV);
        } else {
          break;
        }
      }
    }

    // Draw rows for Volume Histogram, Session Delta, and Price Scale (OLED Dark Style)
    for (let r = 0; r < numRows; r++) {
      const rp = rowProfiles[r];
      const p = rp.p;
      const rowY = topHeaderH + r * rowH;
      const isCompPOC = r === compPocRowIdx && rp.total > 0;
      const isLivePriceRow = Math.abs(lastPrice - p) < step * 0.55;

      // Column 1: Dark Slate background + Orange/Gold horizontal histogram (Bright on VA 70%, Vivid on POC)
      ctx.fillStyle = rp.inVA ? 'rgba(245, 158, 11, 0.12)' : 'rgba(15, 23, 42, 0.65)';
      ctx.fillRect(panelX, rowY, volColW, rowH);

      if (rp.total > 0) {
        const barW = Math.min(volColW - 2, (rp.total / maxCompVol) * (volColW - 4));
        ctx.fillStyle = isCompPOC ? '#ea580c' : (rp.inVA ? '#f59e0b' : '#334155');
        ctx.fillRect(panelX + 1, rowY + 1, barW, Math.max(2, rowH - 2));
      }

      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(panelX, rowY, volColW, rowH);

      if (rowH >= 7.8 && rp.total > 0) {
        ctx.fillStyle = isCompPOC ? '#ffffff' : (rp.inVA ? '#fef08a' : '#94a3b8');
        ctx.font = `${isCompPOC ? 'bold ' : ''}${Math.min(10, Math.max(7.2, Math.floor(rowH - 1.2)))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(rp.total * 10).toString(), panelX + volColW - 4, rowY + rowH / 2 + 3);
      }

      // Column 2: Dark Blue-Slate Session Delta Column with Bidirectional Green/Red Bars
      const dispDelta = Math.round(rp.delta * 10);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(panelX + volColW, rowY, deltaColW, rowH);

      if (Math.abs(rp.delta) > 0) {
        const dBarW = Math.min(deltaColW - 4, (Math.abs(rp.delta) / maxCompDeltaAbs) * (deltaColW - 6));
        ctx.fillStyle = dispDelta >= 0 ? '#10b981' : '#f43f5e';
        ctx.fillRect(panelX + volColW + deltaColW - dBarW - 1, rowY + 1, dBarW, Math.max(2, rowH - 2));
      }

      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(panelX + volColW, rowY, deltaColW, rowH);

      if (rowH >= 7.8 && rp.total > 0) {
        ctx.fillStyle = dispDelta < 0 ? '#fb7185' : '#4ade80';
        ctx.font = `${Math.abs(dispDelta) > 50 ? 'bold ' : ''}${Math.min(10, Math.max(7.2, Math.floor(rowH - 1.2)))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'right';
        ctx.fillText((dispDelta > 0 ? '+' : '') + dispDelta.toString(), panelX + volColW + deltaColW - 4, rowY + rowH / 2 + 3);
      }

      // Column 3: Price Axis Column with Live Price Pill, SNR Highlight & POC Highlight
      let matchedSnr = null;
      if (this.cdShowSNR && cdLevels && cdLevels.length > 0) {
        matchedSnr = cdLevels.find(lv => Math.abs(lv.price - p) < step * 0.55);
      }

      ctx.fillStyle = isLivePriceRow ? '#065f46' : (matchedSnr ? matchedSnr.bg : (isCompPOC ? '#78350f' : '#0f172a'));
      ctx.fillRect(panelX + volColW + deltaColW, rowY, priceColW, rowH);
      ctx.strokeStyle = isLivePriceRow ? '#4ade80' : (matchedSnr ? matchedSnr.col : '#1e293b');
      ctx.strokeRect(panelX + volColW + deltaColW, rowY, priceColW, rowH);

      if (rowH >= 7.8) {
        ctx.fillStyle = isLivePriceRow ? '#ffffff' : (matchedSnr ? '#ffffff' : (isCompPOC ? '#fef08a' : '#cbd5e1'));
        ctx.font = `bold ${Math.min(10, Math.max(7.2, Math.floor(rowH - 1.2)))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'right';
        const dispPrice = matchedSnr ? `${matchedSnr.code}` : p.toFixed(2);
        ctx.fillText(dispPrice, panelX + rightPanelW - 4, rowY + rowH / 2 + 3);
      }
    }

    // 13. Precision Crosshair Guide Line & Price Tag on Hover
    if (this.mousePos.x > 0 && this.mousePos.x < chartW && this.mousePos.y > topHeaderH && this.mousePos.y < topHeaderH + chartH) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, this.mousePos.y);
      ctx.lineTo(chartW, this.mousePos.y);
      ctx.moveTo(this.mousePos.x, topHeaderH);
      ctx.lineTo(this.mousePos.x, topHeaderH + chartH);
      ctx.stroke();
      ctx.restore();
    }

    // 14. Bottom 26px Cumulative Delta Sparkline & Area Strip
    const stripY = this.height - bottomStripH;
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, stripY, this.width, bottomStripH);
    ctx.strokeStyle = '#374151';
    ctx.strokeRect(0, stripY, this.width, bottomStripH);

    const midStripY = stripY + bottomStripH / 2;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#15803d';
    ctx.beginPath();
    ctx.moveTo(8, midStripY);
    ctx.lineTo(chartW - 8, midStripY);
    ctx.stroke();
    ctx.restore();

    if (processedCandles.length > 1) {
      let runningCvd = 0;
      const pts = [];
      let minC = 0, maxC = 0;
      for (let i = 0; i < processedCandles.length; i++) {
        runningCvd += (processedCandles[i].raw.delta || 0);
        if (runningCvd < minC) minC = runningCvd;
        if (runningCvd > maxC) maxC = runningCvd;
        pts.push({
          x: startX + i * colW + colW / 2,
          v: runningCvd
        });
      }
      const rangeC = Math.max(1, maxC - minC);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const py = (stripY + bottomStripH - 4) - ((pts[i].v - minC) / rangeC) * (bottomStripH - 8);
        if (i === 0) ctx.moveTo(pts[i].x, py);
        else ctx.lineTo(pts[i].x, py);
      }
      ctx.stroke();

      // Draw mini nodes on CVD curve
      for (let i = 0; i < pts.length; i++) {
        const py = (stripY + bottomStripH - 4) - ((pts[i].v - minC) / rangeC) * (bottomStripH - 8);
        ctx.fillStyle = pts[i].v >= 0 ? '#4ade80' : '#f43f5e';
        ctx.beginPath();
        ctx.arc(pts[i].x, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Right-bottom ClusterDelta Pro status badge - OLED Dark Neon
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(chartW, stripY, rightPanelW, bottomStripH);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(chartW, stripY, rightPanelW, bottomStripH);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`⚡ CLUSTERDELTA PRO • ${this.cdCellMode.toUpperCase()}`, chartW + rightPanelW / 2, stripY + 16.5);

    ctx.restore();
  }

  /**
   * Institutional TradingView-Style OHLC Candlestick Chart + Order Flow Fusion
   * Features:
   *  - Crisp Bullish/Bearish Candlesticks with High/Low Wicks & Internal POC Golden Dot
   *  - EMA 9 (Fast Gold), EMA 21 (Medium Cyan), EMA 50 (Institutional Purple) Ribbon
   *  - Live Session VWAP, dPOC Sesi, Asian/London High-Low & PDH/PDL Benchmarks
   *  - Smart Price Action + Orderflow Signal Detector (Pinbar / Engulfing + Delta Confirmation)
   *  - Bottom Volume + Delta Sub-Pane with Cumulative Delta (CVD) Trend Line
   *  - Live Price Ray + Real-Time Candle Countdown Timer on Right Price Axis
   */
  _renderCandlestickChart(ctx, snapshot) {
    ctx.save();
    this.hoverCell = null;
    this.cdToolbarHitboxes = [];

    const rawCandles = snapshot.candles || [];
    if (rawCandles.length === 0) {
      ctx.restore();
      return;
    }

    const numBars = Math.max(14, Math.min(50, this.csVisibleBars || 34));
    const candles = this._sliceCandlesWithOffset(rawCandles, numBars);
    const sliceEndIdx = Math.max(candles.length, rawCandles.length - Math.round(this.barOffset || 0));
    const rawUpToView = rawCandles.slice(0, sliceEndIdx);
    const lastPrice = snapshot.last_price || snapshot.bid || candles[candles.length - 1].close;

    // Layout geometry (World-Class TradingView Obsidian Layout)
    const topBarH = 32;
    const rightAxisW = 72;
    const bottomTimeH = 22;
    const volPaneH = Math.max(54, Math.floor((this.height - topBarH - bottomTimeH) * 0.19));
    const mainChartTop = topBarH;
    const mainChartBottom = this.height - bottomTimeH - volPaneH;
    const mainChartH = mainChartBottom - mainChartTop;
    const chartW = this.width - rightAxisW;

    // Helper: Modern Smooth Rounded Rect
    const drawRoundedRect = (rx, ry, rw, rh, rad, fillStyle, strokeStyle, lineWidth) => {
      const r = Math.min(rad, rw / 2, rh / 2);
      ctx.beginPath();
      if (r > 0.5) {
        ctx.moveTo(rx + r, ry);
        ctx.lineTo(rx + rw - r, ry);
        ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
        ctx.lineTo(rx + rw, ry + rh - r);
        ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
        ctx.lineTo(rx + r, ry + rh);
        ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
        ctx.lineTo(rx, ry + r);
        ctx.quadraticCurveTo(rx, ry, rx + r, ry);
      } else {
        ctx.rect(rx, ry, rw, rh);
      }
      ctx.closePath();
      if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
      }
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth || 1;
        ctx.stroke();
      }
    };

    // 1. Background Fill (Deep TradingView Pro Obsidian)
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, this.width, this.height);

    // Subtle radial ambient depth
    const bgGrad = ctx.createLinearGradient(0, mainChartTop, 0, mainChartBottom);
    bgGrad.addColorStop(0, 'rgba(15, 27, 49, 0.40)');
    bgGrad.addColorStop(1, 'rgba(5, 9, 18, 0.40)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, mainChartTop, chartW, mainChartH);

    // 2. Compute EMA 9, EMA 21, EMA 50 across visible raw candles
    const calcEMA = (arr, period) => {
      const k = 2 / (period + 1);
      const out = [];
      let ema = arr[0] ? arr[0].close : 0;
      for (let i = 0; i < arr.length; i++) {
        ema = i === 0 ? arr[i].close : (arr[i].close * k + ema * (1 - k));
        out.push(ema);
      }
      return out.slice(-candles.length);
    };
    const ema9 = calcEMA(rawUpToView, 9);
    const ema21 = calcEMA(rawUpToView, 21);
    const ema50 = calcEMA(rawUpToView, 50);

    // 3. Determine Price Min/Max across visible candles (+ EMAs)
    let minP = Infinity;
    let maxP = -Infinity;
    let maxVol = 1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
      if (this.csShowEMA) {
        minP = Math.min(minP, ema9[i] || minP, ema21[i] || minP);
        maxP = Math.max(maxP, ema9[i] || maxP, ema21[i] || maxP);
      }
    }
    const padP = Math.max(0.60, (maxP - minP) * 0.12);
    minP -= padP;
    maxP += padP;
    const rawRange = Math.max(1.0, maxP - minP);
    const scaledRange = rawRange / Math.max(0.35, this.csVerticalScale || 1.0);
    const midP = (minP + maxP) / 2.0 + (this.priceOffset || 0);
    minP = midP - scaledRange / 2.0;
    maxP = midP + scaledRange / 2.0;
    const priceRange = Math.max(0.8, maxP - minP);

    const pToY = (p) => mainChartBottom - ((p - minP) / priceRange) * mainChartH;
    const yToP = (y) => minP + ((mainChartBottom - y) / mainChartH) * priceRange;
    this._lastCandlePToY = pToY;

    // 4. Horizontal Price Grid & Right Price Axis Labels
    const rawStep = priceRange / 8;
    const gridStep = rawStep <= 0.3 ? 0.25 : (rawStep <= 0.7 ? 0.50 : (rawStep <= 1.5 ? 1.00 : 2.00));
    const firstGridP = Math.ceil(minP / gridStep) * gridStep;

    ctx.fillStyle = '#090f1c';
    ctx.fillRect(chartW, 0, rightAxisW, this.height);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartW, 0);
    ctx.lineTo(chartW, this.height);
    ctx.stroke();

    for (let gp = firstGridP; gp <= maxP; gp += gridStep) {
      const gy = pToY(gp);
      if (gy < mainChartTop + 8 || gy > mainChartBottom - 8) continue;
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(chartW, gy);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(gp.toFixed(2), this.width - 6, gy + 3.5);
    }

    // 5. Right-Edge Subtle Session Volume Profile Silhouette
    if (snapshot.session_vp && snapshot.session_vp.buckets) {
      const svp = snapshot.session_vp;
      const maxSvpV = Math.max(10, svp.max_bucket_vol || 50);
      const maxBarW = 64;
      for (const b of svp.buckets) {
        const by = pToY(b.price);
        if (by < mainChartTop + 6 || by > mainChartBottom - 6) continue;
        const bw = Math.min(maxBarW, (b.total / maxSvpV) * maxBarW);
        const isDpoc = Math.abs(b.price - (svp.dpoc || 0)) < 0.08;
        ctx.fillStyle = isDpoc ? 'rgba(255, 214, 10, 0.38)' : 'rgba(56, 189, 248, 0.15)';
        ctx.fillRect(chartW - bw, by - 3, bw, 6);
      }
    }

    // 6. Key Institutional Levels with Anti-Collision Vertical Slotting
    const candidateLevels = [];
    if (this.csShowVWAP && snapshot.vwap && snapshot.vwap.value > 0) {
      candidateLevels.push({ price: snapshot.vwap.value, label: '🌐 VWAP', color: '#00f0ff', dash: [], prio: 10 });
    }
    if (this.csShowLevels) {
      if (snapshot.session_vp && snapshot.session_vp.dpoc > 0) {
        candidateLevels.push({ price: snapshot.session_vp.dpoc, label: '⭐ dPOC', color: '#ffd60a', dash: [3, 3], prio: 9 });
      }
      if (snapshot.sessions) {
        const s = snapshot.sessions;
        if (s.h8_res > 0) candidateLevels.push({ price: s.h8_res, label: '🏛️ H8 RES', color: '#e11d48', dash: [8, 4], prio: 8 });
        if (s.h8_sup > 0) candidateLevels.push({ price: s.h8_sup, label: '🏛️ H8 SUP', color: '#059669', dash: [8, 4], prio: 8 });
        if (s.h4_res > 0) candidateLevels.push({ price: s.h4_res, label: '🏰 H4 RES', color: '#ec4899', dash: [6, 3], prio: 7 });
        if (s.h4_sup > 0) candidateLevels.push({ price: s.h4_sup, label: '🏰 H4 SUP', color: '#10b981', dash: [6, 3], prio: 7 });
        if (s.h1_res > 0) candidateLevels.push({ price: s.h1_res, label: '⏱️ H1 RES', color: '#f97316', dash: [5, 3], prio: 6 });
        if (s.h1_sup > 0) candidateLevels.push({ price: s.h1_sup, label: '⏱️ H1 SUP', color: '#06b6d4', dash: [5, 3], prio: 6 });
        if (s.m30_res > 0) candidateLevels.push({ price: s.m30_res, label: '⏳ M30 RES', color: '#a855f7', dash: [4, 3], prio: 5 });
        if (s.m30_sup > 0) candidateLevels.push({ price: s.m30_sup, label: '⏳ M30 SUP', color: '#3b82f6', dash: [4, 3], prio: 5 });
        if (s.m15_res > 0) candidateLevels.push({ price: s.m15_res, label: '⚡ M15 RES', color: '#fbbf24', dash: [3, 3], prio: 5 });
        if (s.m15_sup > 0) candidateLevels.push({ price: s.m15_sup, label: '⚡ M15 SUP', color: '#2dd4bf', dash: [3, 3], prio: 5 });
        if (s.asian_high > 0) candidateLevels.push({ price: s.asian_high, label: '🌏 ASIAN H', color: '#f59e0b', dash: [5, 4], prio: 4 });
        if (s.asian_low > 0)  candidateLevels.push({ price: s.asian_low,  label: '🌏 ASIAN L', color: '#f59e0b', dash: [5, 4], prio: 4 });
        if (s.pdh > 0) candidateLevels.push({ price: s.pdh, label: '🏛️ PDH', color: '#fde047', dash: [6, 3], prio: 4 });
        if (s.pdl > 0) candidateLevels.push({ price: s.pdl, label: '🏛️ PDL', color: '#fde047', dash: [6, 3], prio: 4 });
      }
    }

    // Anti-collision slotting: Sort candidate levels by priority and filter overlapping tags
    candidateLevels.sort((a, b) => b.prio - a.prio);
    const placedTagYs = [];

    for (const lvl of candidateLevels) {
      if (!lvl.price || lvl.price <= 0) continue;
      const y = pToY(lvl.price);
      if (y < mainChartTop + 12 || y > mainChartBottom - 12) continue;

      // Draw Ray Line across the full chart width
      ctx.save();
      ctx.setLineDash(lvl.dash);
      ctx.strokeStyle = lvl.color;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Check vertical clearance for Right-Edge Pill Tag (must have >= 15px distance)
      const canDrawPill = !placedTagYs.some(py => Math.abs(py - y) < 15);
      if (canDrawPill) {
        placedTagYs.push(y);
        const txt = `${lvl.label} $${lvl.price.toFixed(2)}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 10;
        const tagX = chartW - tw - 4;
        ctx.fillStyle = 'rgba(7, 11, 20, 0.94)';
        ctx.fillRect(tagX, y - 7, tw, 14);
        ctx.strokeStyle = lvl.color;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(tagX, y - 7, tw, 14);
        ctx.fillStyle = lvl.color;
        ctx.textAlign = 'center';
        ctx.fillText(txt, tagX + tw / 2, y + 3.5);
      }
      ctx.restore();
    }

    // 7. Candle X Geometry & Vertical Time Grid
    const leftPad = 14;
    const rightPad = 26;
    const usableW = Math.max(200, chartW - leftPad - rightPad);
    const slotW = usableW / candles.length;
    const bodyW = Math.max(4, Math.min(22, Math.floor(slotW * 0.70)));

    const getBarX = (idx) => leftPad + idx * slotW + slotW / 2;

    // Bottom Time Axis Strip
    const timeStripY = this.height - bottomTimeH;
    ctx.fillStyle = '#090f1c';
    ctx.fillRect(0, timeStripY, chartW, bottomTimeH);
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, timeStripY);
    ctx.lineTo(chartW, timeStripY);
    ctx.stroke();

    const timeStride = Math.max(3, Math.floor(candles.length / 6));
    for (let i = 0; i < candles.length; i++) {
      if (i % timeStride === 0 || i === candles.length - 1) {
        const cx = getBarX(i);
        ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
        ctx.beginPath();
        ctx.moveTo(cx, mainChartTop);
        ctx.lineTo(cx, timeStripY);
        ctx.stroke();

        const d = new Date(candles[i].time * 1000);
        const tStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        ctx.fillStyle = i === candles.length - 1 ? '#00f0ff' : '#64748b';
        ctx.font = i === candles.length - 1 ? 'bold 9px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(tStr, cx, timeStripY + 14);
      }
    }

    // 7.5. Feature 1 & 3: Institutional Fair Value Gaps (FVG) & Order Blocks (OB)
    const showFvgOb = this.csShowFvgOb !== false;
    if (showFvgOb && candles.length >= 4) {
      ctx.save();

      // --- A. Bullish & Bearish Fair Value Gaps (FVG) ---
      for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];

        // Bullish FVG: C1 High < C3 Low
        if (c3.low > c1.high + 0.12) {
          const topP = c3.low;
          let botP = c1.high;
          const startX = getBarX(i - 1) - bodyW / 2;
          let endX = chartW - 4;
          let isMitigated = false;

          // Check mitigation by subsequent candles
          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].low <= botP) {
              endX = getBarX(j);
              isMitigated = true;
              break;
            } else if (candles[j].low < topP) {
              // Partial mitigation
              botP = Math.max(botP, candles[j].low);
            }
          }

          const yTop = pToY(topP);
          const yBot = pToY(botP);
          const boxH = Math.max(3, yBot - yTop);
          const boxW = Math.max(12, endX - startX);

          if (yTop >= mainChartTop - 10 && yBot <= mainChartBottom + 10) {
            ctx.fillStyle = isMitigated ? 'rgba(16, 185, 129, 0.06)' : 'rgba(16, 185, 129, 0.14)';
            ctx.fillRect(startX, yTop, boxW, boxH);
            ctx.strokeStyle = isMitigated ? 'rgba(16, 185, 129, 0.25)' : 'rgba(52, 211, 153, 0.65)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 0.8;
            ctx.strokeRect(startX, yTop, boxW, boxH);
            ctx.setLineDash([]);

            if (!isMitigated && boxW > 35) {
              ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
              ctx.fillStyle = '#34d399';
              ctx.textAlign = 'right';
              ctx.fillText('FVG [+]', startX + boxW - 3, yTop + 8);
            }
          }
        }

        // Bearish FVG: C1 Low > C3 High
        if (c1.low > c3.high + 0.12) {
          const topP = c1.low;
          let botP = c3.high;
          const startX = getBarX(i - 1) - bodyW / 2;
          let endX = chartW - 4;
          let isMitigated = false;

          // Check mitigation by subsequent candles
          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].high >= topP) {
              endX = getBarX(j);
              isMitigated = true;
              break;
            } else if (candles[j].high > botP) {
              // Partial mitigation
              topP = Math.min(topP, candles[j].high);
            }
          }

          const yTop = pToY(topP);
          const yBot = pToY(botP);
          const boxH = Math.max(3, yBot - yTop);
          const boxW = Math.max(12, endX - startX);

          if (yTop >= mainChartTop - 10 && yBot <= mainChartBottom + 10) {
            ctx.fillStyle = isMitigated ? 'rgba(244, 63, 94, 0.06)' : 'rgba(244, 63, 94, 0.14)';
            ctx.fillRect(startX, yTop, boxW, boxH);
            ctx.strokeStyle = isMitigated ? 'rgba(244, 63, 94, 0.25)' : 'rgba(251, 113, 133, 0.65)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 0.8;
            ctx.strokeRect(startX, yTop, boxW, boxH);
            ctx.setLineDash([]);

            if (!isMitigated && boxW > 35) {
              ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
              ctx.fillStyle = '#fb7185';
              ctx.textAlign = 'right';
              ctx.fillText('FVG [-]', startX + boxW - 3, yTop + 8);
            }
          }
        }
      }

      // --- B. Institutional Unmitigated Order Blocks (OB Boxes) ---
      for (let i = 2; i < candles.length - 1; i++) {
        const base = candles[i - 1];
        const impulse = candles[i];
        const impulseRange = impulse.high - impulse.low;
        const impulseBody = Math.abs(impulse.close - impulse.open);

        // Bullish Order Block (Base Red Candle before violent upward move)
        if (impulse.close > impulse.open && impulseBody >= 0.45 && base.close <= base.open) {
          const obTop = Math.max(base.open, base.close);
          const obBot = base.low;
          const startX = getBarX(i - 1) - bodyW / 2;
          let endX = chartW - 4;
          let broken = false;

          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].close < obBot) {
              endX = getBarX(j);
              broken = true;
              break;
            }
          }

          if (!broken) {
            const yTop = pToY(obTop);
            const yBot = pToY(obBot);
            const boxH = Math.max(3, yBot - yTop);
            const boxW = Math.max(14, endX - startX);
            if (yTop >= mainChartTop && yBot <= mainChartBottom) {
              ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
              ctx.fillRect(startX, yTop, boxW, boxH);
              ctx.strokeStyle = '#10b981';
              ctx.lineWidth = 0.9;
              ctx.strokeRect(startX, yTop, boxW, boxH);

              ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
              ctx.fillStyle = '#10b981';
              ctx.textAlign = 'left';
              ctx.fillText('OB [BULL]', startX + 3, yTop + 8);
            }
          }
        }

        // Bearish Order Block (Base Green Candle before violent downward move)
        if (impulse.close < impulse.open && impulseBody >= 0.45 && base.close >= base.open) {
          const obTop = base.high;
          const obBot = Math.min(base.open, base.close);
          const startX = getBarX(i - 1) - bodyW / 2;
          let endX = chartW - 4;
          let broken = false;

          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].close > obTop) {
              endX = getBarX(j);
              broken = true;
              break;
            }
          }

          if (!broken) {
            const yTop = pToY(obTop);
            const yBot = pToY(obBot);
            const boxH = Math.max(3, yBot - yTop);
            const boxW = Math.max(14, endX - startX);
            if (yTop >= mainChartTop && yBot <= mainChartBottom) {
              ctx.fillStyle = 'rgba(244, 63, 94, 0.12)';
              ctx.fillRect(startX, yTop, boxW, boxH);
              ctx.strokeStyle = '#f43f5e';
              ctx.lineWidth = 0.9;
              ctx.strokeRect(startX, yTop, boxW, boxH);

              ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
              ctx.fillStyle = '#f43f5e';
              ctx.textAlign = 'left';
              ctx.fillText('OB [BEAR]', startX + 3, yTop + 8);
            }
          }
        }
      }

      ctx.restore();
    }

    // 7.8. Feature 2: Smart Market Structure Breaks (BOS / CHoCH)
    const showStructure = this.csShowStructure !== false;
    if (showStructure && candles.length >= 8) {
      ctx.save();
      const swings = [];
      for (let i = 2; i < candles.length - 2; i++) {
        const c = candles[i];
        const isSwingHigh = c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
                            c.high > candles[i + 1].high && c.high > candles[i + 2].high;
        const isSwingLow = c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
                           c.low < candles[i + 1].low && c.low < candles[i + 2].low;
        if (isSwingHigh) swings.push({ idx: i, type: 'HIGH', price: c.high });
        if (isSwingLow)  swings.push({ idx: i, type: 'LOW',  price: c.low });
      }

      // Check breakout of recent swing points
      for (let sIdx = 0; sIdx < swings.length; sIdx++) {
        const sw = swings[sIdx];
        const startX = getBarX(sw.idx);
        const y = pToY(sw.price);
        if (y < mainChartTop + 10 || y > mainChartBottom - 10) continue;

        let breakBarIdx = -1;
        for (let j = sw.idx + 1; j < candles.length; j++) {
          if (sw.type === 'HIGH' && candles[j].close > sw.price) {
            breakBarIdx = j;
            break;
          } else if (sw.type === 'LOW' && candles[j].close < sw.price) {
            breakBarIdx = j;
            break;
          }
        }

        if (breakBarIdx !== -1) {
          const endX = getBarX(breakBarIdx);
          const isBullBreak = sw.type === 'HIGH';
          const prevSame = swings.slice(0, sIdx).filter(x => x.type === sw.type).pop();
          const isBOS = prevSame ? (isBullBreak ? sw.price >= prevSame.price : sw.price <= prevSame.price) : true;
          const badgeText = isBOS ? (isBullBreak ? 'BOS ↗' : 'BOS ↘') : (isBullBreak ? 'CHoCH ↗' : 'CHoCH ↘');
          const badgeCol = isBOS ? (isBullBreak ? '#00e676' : '#ff3366') : (isBullBreak ? '#00f0ff' : '#f59e0b');

          ctx.setLineDash([3, 2]);
          ctx.strokeStyle = badgeCol;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(startX, y);
          ctx.lineTo(endX, y);
          ctx.stroke();
          ctx.setLineDash([]);

          // Break badge label
          ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(badgeText).width + 6;
          const bx = endX - tw / 2;
          ctx.fillStyle = 'rgba(7, 11, 20, 0.92)';
          ctx.fillRect(bx, y - 6, tw, 12);
          ctx.strokeStyle = badgeCol;
          ctx.lineWidth = 0.8;
          ctx.strokeRect(bx, y - 6, tw, 12);
          ctx.fillStyle = badgeCol;
          ctx.textAlign = 'center';
          ctx.fillText(badgeText, bx + tw / 2, y + 3);
        }
      }
      ctx.restore();
    }

    // 8. Draw EMA 9 / EMA 21 / EMA 50 Curves
    if (this.csShowEMA && candles.length > 1) {
      const drawCurve = (arr, col, width) => {
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const x = getBarX(i);
          const y = pToY(arr[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      };
      drawCurve(ema50, 'rgba(192, 132, 252, 0.78)', 1.4); // EMA 50 Purple
      drawCurve(ema21, 'rgba(0, 240, 255, 0.85)', 1.5);   // EMA 21 Cyan
      drawCurve(ema9,  'rgba(255, 214, 10, 0.92)', 1.6);  // EMA 9 Gold
    }

    // 8.5 Institutional 7-Strategy Signal Engine & Permanent Frozen Cache
    if (!this._confirmedSignalsCache) {
      this._confirmedSignalsCache = new Map();
    }

    const techs = this.csTechniques || { smc: true, of_absorb: true, vwap_band: true, ema_trend: true, vp_retest: true, snr: true, snd: true };

    const calcFullEMA = (arr, period) => {
      const k = 2 / (period + 1);
      const out = [];
      let ema = arr[0] ? arr[0].close : 0;
      for (let i = 0; i < arr.length; i++) {
        ema = i === 0 ? arr[i].close : (arr[i].close * k + ema * (1 - k));
        out.push(ema);
      }
      return out;
    };
    const rawEma9 = calcFullEMA(rawCandles, 9);
    const rawEma21 = calcFullEMA(rawCandles, 21);
    const rawEma50 = calcFullEMA(rawCandles, 50);

    let lastCachedSignalTime = 0;
    let lastCachedSignalDir = null;

    for (let i = 0; i < rawCandles.length - 1; i++) {
      const past = this._confirmedSignalsCache.get(rawCandles[i].time);
      if (past && past.aPlusSignal) {
        lastCachedSignalTime = rawCandles[i].time;
        lastCachedSignalDir = past.aPlusSignal.direction;
      }
    }

    const candleInterval = snapshot.candle_interval || 60;
    for (let i = 0; i < rawCandles.length - 1; i++) {
      const rc = rawCandles[i];
      if (this._confirmedSignalsCache.has(rc.time)) {
        continue;
      }

      const totalRange = Math.max(0.05, rc.high - rc.low);
      const upperWick = rc.high - Math.max(rc.open, rc.close);
      const lowerWick = Math.min(rc.open, rc.close) - rc.low;
      const isBull = rc.close >= rc.open;
      const hasBearDivergence = isBull && (rc.delta || 0) < -1.8;
      const hasBullDivergence = !isBull && (rc.delta || 0) > 1.8;

      let aPlusSignal = null;
      let signalBadge = null;
      let signalCol = '#00e676';

      const timeDiff = rc.time - lastCachedSignalTime;
      const canEmitBuy = (timeDiff >= candleInterval * 3) || (lastCachedSignalDir === 'SELL');
      const canEmitSell = (timeDiff >= candleInterval * 3) || (lastCachedSignalDir === 'BUY');

      // TEKNIK 1: SMC Liquidity Sweep
      if (!aPlusSignal && techs.smc && totalRange >= 0.35) {
        let smcSupport = null;
        let smcResistance = null;
        if (snapshot.sessions) {
          const s = snapshot.sessions;
          const supLevels = [{ name: 'ASIAN LOW', price: s.asian_low }, { name: 'LONDON LOW', price: s.london_low }, { name: 'PDL', price: s.pdl }].filter(l => l.price > 0);
          const resLevels = [{ name: 'ASIAN HIGH', price: s.asian_high }, { name: 'LONDON HIGH', price: s.london_high }, { name: 'PDH', price: s.pdh }].filter(l => l.price > 0);
          for (const l of supLevels) {
            if (rc.low <= l.price + 0.15 && rc.low >= l.price - 0.90 && rc.close >= l.price) { smcSupport = l; break; }
          }
          for (const l of resLevels) {
            if (rc.high >= l.price - 0.15 && rc.high <= l.price + 0.90 && rc.close <= l.price) { smcResistance = l; break; }
          }
        }
        const buyAbsorb = (lowerWick / totalRange >= 0.38 && (rc.delta || 0) > 0) || (hasBullDivergence && lowerWick / totalRange >= 0.22);
        const sellAbsorb = (upperWick / totalRange >= 0.38 && (rc.delta || 0) < 0) || (hasBearDivergence && upperWick / totalRange >= 0.22);

        if (smcSupport && buyAbsorb && canEmitBuy) {
          const entry = rc.close;
          const sl = Math.min(rc.low, smcSupport.price) - 0.35;
          const risk = Math.max(0.80, entry - sl);
          const tp = entry + (risk * 2.5);
          aPlusSignal = { direction: 'BUY', technique: 'SMC Sweep', techKey: 'smc', badge: `⭐ [SMC] BUY [${smcSupport.name}]`, level: smcSupport.name, levelPrice: smcSupport.price, entry, sl: entry - risk, tp, risk, reward: tp - entry, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (smcResistance && sellAbsorb && canEmitSell) {
          const entry = rc.close;
          const sl = Math.max(rc.high, smcResistance.price) + 0.35;
          const risk = Math.max(0.80, sl - entry);
          const tp = entry - (risk * 2.5);
          aPlusSignal = { direction: 'SELL', technique: 'SMC Sweep', techKey: 'smc', badge: `⭐ [SMC] SELL [${smcResistance.name}]`, level: smcResistance.name, levelPrice: smcResistance.price, entry, sl: entry + risk, tp, risk, reward: entry - tp, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      // TEKNIK 2: Order Flow Delta Absorption
      if (!aPlusSignal && techs.of_absorb && totalRange >= 0.35) {
        const strongBullAbsorb = (hasBullDivergence && lowerWick / totalRange >= 0.30) || (lowerWick / totalRange >= 0.48 && (rc.delta || 0) > 4);
        const strongBearAbsorb = (hasBearDivergence && upperWick / totalRange >= 0.30) || (upperWick / totalRange >= 0.48 && (rc.delta || 0) < -4);
        if (strongBullAbsorb && canEmitBuy) {
          const entry = rc.close;
          const risk = Math.max(0.80, entry - rc.low + 0.35);
          const sl = entry - risk;
          const tp = entry + (risk * 2.0);
          aPlusSignal = { direction: 'BUY', technique: 'OF Absorption', techKey: 'of_absorb', badge: `⚡ [OF] BUY [ABSORPSI]`, level: 'Delta Floor', entry, sl, tp, risk, reward: tp - entry, rr: 2.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (strongBearAbsorb && canEmitSell) {
          const entry = rc.close;
          const risk = Math.max(0.80, rc.high + 0.35 - entry);
          const sl = entry + risk;
          const tp = entry - (risk * 2.0);
          aPlusSignal = { direction: 'SELL', technique: 'OF Absorption', techKey: 'of_absorb', badge: `⚡ [OF] SELL [ABSORPSI]`, level: 'Delta Ceiling', entry, sl, tp, risk, reward: entry - tp, rr: 2.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      // TEKNIK 3: VWAP ±2σ Bounce
      if (!aPlusSignal && techs.vwap_band && snapshot.vwap && totalRange >= 0.35) {
        const v = snapshot.vwap;
        if (v.std2_down > 0 && rc.low <= v.std2_down + 0.25 && rc.close >= v.std2_down - 0.10 && ((rc.delta || 0) > 0 || hasBullDivergence) && canEmitBuy) {
          const entry = rc.close;
          const risk = Math.max(0.80, entry - v.std2_down + 0.40);
          const sl = entry - risk;
          const tp = v.value > entry ? v.value : entry + (risk * 2.0);
          aPlusSignal = { direction: 'BUY', technique: 'VWAP ±2σ Bounce', techKey: 'vwap_band', badge: `🌐 [VWAP] BUY [-2σ]`, level: 'VWAP -2σ', entry, sl, tp, risk, reward: tp - entry, rr: 2.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (v.std2_up > 0 && rc.high >= v.std2_up - 0.25 && rc.close <= v.std2_up + 0.10 && ((rc.delta || 0) < 0 || hasBearDivergence) && canEmitSell) {
          const entry = rc.close;
          const risk = Math.max(0.80, v.std2_up + 0.40 - entry);
          const sl = entry + risk;
          const tp = v.value < entry ? v.value : entry - (risk * 2.0);
          aPlusSignal = { direction: 'SELL', technique: 'VWAP ±2σ Bounce', techKey: 'vwap_band', badge: `🌐 [VWAP] SELL [+2σ]`, level: 'VWAP +2σ', entry, sl, tp, risk, reward: entry - tp, rr: 2.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      // TEKNIK 4: EMA Ribbon Trend Pullback
      if (!aPlusSignal && techs.ema_trend && i >= 5 && rawEma50 && rawEma50[i] && totalRange >= 0.35) {
        const isUptrend = rawEma9[i] > rawEma21[i] && rawEma21[i] > rawEma50[i];
        const isDowntrend = rawEma9[i] < rawEma21[i] && rawEma21[i] < rawEma50[i];
        if (isUptrend && rc.low <= rawEma21[i] + 0.25 && rc.close >= rawEma21[i] - 0.15 && isBull && (rc.delta || 0) > 0 && canEmitBuy) {
          const entry = rc.close;
          const risk = Math.max(0.80, entry - rawEma50[i] + 0.35);
          const sl = entry - risk;
          const tp = entry + (risk * 3.0);
          aPlusSignal = { direction: 'BUY', technique: 'EMA Pullback', techKey: 'ema_trend', badge: `🚀 [TREND] BUY [EMA]`, level: 'EMA 21/50', entry, sl, tp, risk, reward: tp - entry, rr: 3.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (isDowntrend && rc.high >= rawEma21[i] - 0.25 && rc.close <= rawEma21[i] + 0.15 && !isBull && (rc.delta || 0) < 0 && canEmitSell) {
          const entry = rc.close;
          const risk = Math.max(0.80, rawEma50[i] + 0.35 - entry);
          const sl = entry + risk;
          const tp = entry - (risk * 3.0);
          aPlusSignal = { direction: 'SELL', technique: 'EMA Pullback', techKey: 'ema_trend', badge: `🚀 [TREND] SELL [EMA]`, level: 'EMA 21/50', entry, sl, tp, risk, reward: entry - tp, rr: 3.0 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      // TEKNIK 5: Volume Profile dPOC & Value Area Retest
      if (!aPlusSignal && techs.vp_retest && snapshot.session_vp && totalRange >= 0.35) {
        const svp = snapshot.session_vp;
        const vpLevels = [{ name: 'dPOC', price: svp.dpoc }, { name: 'VAH', price: svp.vah }, { name: 'VAL', price: svp.val }].filter(l => l.price > 0);
        for (const l of vpLevels) {
          if (rc.low <= l.price + 0.18 && rc.close >= l.price && (rc.delta || 0) > 0 && canEmitBuy) {
            const entry = rc.close;
            const risk = Math.max(0.80, entry - l.price + 0.35);
            const sl = entry - risk;
            const tp = entry + (risk * 2.5);
            aPlusSignal = { direction: 'BUY', technique: 'VP Retest', techKey: 'vp_retest', badge: `🏛️ [VP] BUY [${l.name}]`, level: l.name, entry, sl, tp, risk, reward: tp - entry, rr: 2.5 };
            signalBadge = aPlusSignal.badge;
            signalCol = '#00e676';
            break;
          } else if (rc.high >= l.price - 0.18 && rc.close <= l.price && (rc.delta || 0) < 0 && canEmitSell) {
            const entry = rc.close;
            const risk = Math.max(0.80, l.price + 0.35 - entry);
            const sl = entry + risk;
            const tp = entry - (risk * 2.5);
            aPlusSignal = { direction: 'SELL', technique: 'VP Retest', techKey: 'vp_retest', badge: `🏛️ [VP] SELL [${l.name}]`, level: l.name, entry, sl, tp, risk, reward: entry - tp, rr: 2.5 };
            signalBadge = aPlusSignal.badge;
            signalCol = '#ff3366';
            break;
          }
        }
      }

      // TEKNIK 6: SNR Classic
      if (!aPlusSignal && techs.snr && i >= 6 && totalRange >= 0.35) {
        let bestSup = null, bestRes = null;
        const lookback = Math.min(i - 2, 35);
        for (let k = i - 2; k >= i - lookback; k--) {
          const pastC = rawCandles[k];
          const pastPrev = rawCandles[k - 1];
          const pastNext = rawCandles[k + 1];
          if (!pastPrev || !pastNext) continue;
          if (pastC.low < pastPrev.low && pastC.low < pastNext.low) {
            if (rc.low <= pastC.low + 0.22 && rc.low >= pastC.low - 0.45 && rc.close >= pastC.low) {
              bestSup = { price: pastC.low, name: rc.close > pastC.high ? 'RBS' : 'SUPPORT' };
              break;
            }
          }
          if (pastC.high > pastPrev.high && pastC.high > pastNext.high) {
            if (rc.high >= pastC.high - 0.22 && rc.high <= pastC.high + 0.45 && rc.close <= pastC.high) {
              bestRes = { price: pastC.high, name: rc.close < pastC.low ? 'SBR' : 'RESISTANCE' };
              break;
            }
          }
        }
        const buyAbsorb = (lowerWick / totalRange >= 0.35 && (rc.delta || 0) > 0) || (hasBullDivergence && lowerWick / totalRange >= 0.20);
        const sellAbsorb = (upperWick / totalRange >= 0.35 && (rc.delta || 0) < 0) || (hasBearDivergence && upperWick / totalRange >= 0.20);
        if (bestSup && buyAbsorb && canEmitBuy) {
          const entry = rc.close;
          const sl = Math.min(rc.low, bestSup.price) - 0.35;
          const risk = Math.max(0.80, entry - sl);
          const tp = entry + (risk * 2.5);
          aPlusSignal = { direction: 'BUY', technique: 'SNR Classic', techKey: 'snr', badge: `🎯 [SNR] BUY [${bestSup.name}]`, level: bestSup.name, entry, sl: entry - risk, tp, risk, reward: tp - entry, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (bestRes && sellAbsorb && canEmitSell) {
          const entry = rc.close;
          const sl = Math.max(rc.high, bestRes.price) + 0.35;
          const risk = Math.max(0.80, sl - entry);
          const tp = entry - (risk * 2.5);
          aPlusSignal = { direction: 'SELL', technique: 'SNR Classic', techKey: 'snr', badge: `🎯 [SNR] SELL [${bestRes.name}]`, level: bestRes.name, entry, sl: entry + risk, tp, risk, reward: entry - tp, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      // TEKNIK 7: SND Base
      if (!aPlusSignal && techs.snd && i >= 6 && totalRange >= 0.35) {
        let demandZone = null, supplyZone = null;
        const lookback = Math.min(i - 2, 28);
        for (let k = i - 2; k >= i - lookback; k--) {
          const base = rawCandles[k];
          const impulse = rawCandles[k + 1];
          if (!base || !impulse) continue;
          const impulseBody = Math.abs(impulse.close - impulse.open);
          if (impulse.close > impulse.open && impulseBody >= 0.55 && (impulse.delta || 0) > 3) {
            const dHigh = Math.max(base.open, base.close);
            const dLow = base.low;
            if (rc.low <= dHigh + 0.18 && rc.low >= dLow - 0.40 && rc.close >= dHigh - 0.15) {
              demandZone = { high: dHigh, low: dLow, name: 'DEMAND' };
              break;
            }
          }
          if (impulse.close < impulse.open && impulseBody >= 0.55 && (impulse.delta || 0) < -3) {
            const sLow = Math.min(base.open, base.close);
            const sHigh = base.high;
            if (rc.high >= sLow - 0.18 && rc.high <= sHigh + 0.40 && rc.close <= sLow + 0.15) {
              supplyZone = { high: sHigh, low: sLow, name: 'SUPPLY' };
              break;
            }
          }
        }
        if (demandZone && lowerWick / totalRange >= 0.30 && ((rc.delta || 0) > 0 || hasBullDivergence) && canEmitBuy) {
          const entry = rc.close;
          const sl = demandZone.low - 0.35;
          const risk = Math.max(0.80, entry - sl);
          const tp = entry + (risk * 2.5);
          aPlusSignal = { direction: 'BUY', technique: 'SND Zone', techKey: 'snd', badge: `📦 [SND] BUY [DEMAND]`, level: 'Demand Base', entry, sl: entry - risk, tp, risk, reward: tp - entry, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#00e676';
        } else if (supplyZone && upperWick / totalRange >= 0.30 && ((rc.delta || 0) < 0 || hasBearDivergence) && canEmitSell) {
          const entry = rc.close;
          const sl = supplyZone.high + 0.35;
          const risk = Math.max(0.80, sl - entry);
          const tp = entry - (risk * 2.5);
          aPlusSignal = { direction: 'SELL', technique: 'SND Zone', techKey: 'snd', badge: `📦 [SND] SELL [SUPPLY]`, level: 'Supply Base', entry, sl: entry + risk, tp, risk, reward: entry - tp, rr: 2.5 };
          signalBadge = aPlusSignal.badge;
          signalCol = '#ff3366';
        }
      }

      if (aPlusSignal) {
        lastCachedSignalTime = rc.time;
        lastCachedSignalDir = aPlusSignal.direction;
      } else {
        if (hasBearDivergence) {
          signalBadge = '⚠️ TAPE DIV (-Δ)';
          signalCol = '#f59e0b';
        } else if (hasBullDivergence) {
          signalBadge = '⚠️ TAPE DIV (+Δ)';
          signalCol = '#38bdf8';
        }
      }

      this._confirmedSignalsCache.set(rc.time, { aPlusSignal, signalBadge, signalCol });
    }

    if (this._confirmedSignalsCache.size > 300) {
      const keys = Array.from(this._confirmedSignalsCache.keys());
      for (let k = 0; k < keys.length - 200; k++) {
        this._confirmedSignalsCache.delete(keys[k]);
      }
    }

    // 8.6 Pre-pass: Identify Hovered Candle & Latest Active Confirmed Signal
    let hoveredCandle = null;
    let hoveredCandleIdx = -1;
    let latestSignalCandleIdx = -1;

    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      const cx = getBarX(i);
      if (hoveredCandleIdx === -1 &&
          this.mousePos.x >= cx - slotW / 2 && this.mousePos.x <= cx + slotW / 2 &&
          this.mousePos.y >= mainChartTop && this.mousePos.y <= this.height - bottomTimeH) {
        hoveredCandleIdx = i;
      }
      if (latestSignalCandleIdx === -1 && i < candles.length - 1 && this._confirmedSignalsCache) {
        const past = this._confirmedSignalsCache.get(c.time);
        if (past && past.aPlusSignal) {
          latestSignalCandleIdx = i;
        }
      }
    }

    // 9. Modern Rounded Vector Candlesticks & Internal POC Dots
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const cx = getBarX(i);
      const isBull = c.close >= c.open;
      const isLive = i === candles.length - 1;

      const yHigh = pToY(c.high);
      const yLow  = pToY(c.low);
      const yOpen = pToY(c.open);
      const yClose = pToY(c.close);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(2.5, Math.abs(yClose - yOpen));

      // Clean Anti-Aliased High-Low Wick
      ctx.save();
      ctx.strokeStyle = isBull ? '#00e676' : '#ff3366';
      ctx.lineWidth = isLive ? 1.6 : 1.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, yHigh);
      ctx.lineTo(cx, yLow);
      ctx.stroke();
      ctx.restore();

      // Candle Body: Modern Rounded Vector Candlestick with Delta-Dominant Tinting
      const hasBearDivergence = isBull && (c.delta || 0) < -1.8;
      const hasBullDivergence = !isBull && (c.delta || 0) > 1.8;

      const bodyX = cx - bodyW / 2;
      const radius = Math.min(2.0, bodyW / 3);

      if (hasBearDivergence) {
        // Hidden Bearish Absorption
        drawRoundedRect(bodyX, bodyTop, bodyW, bodyH, radius, '#15803d', '#f59e0b', 1.2);
        drawRoundedRect(bodyX + 1, bodyTop + 1, Math.max(1, bodyW - 2), Math.max(1, bodyH - 2), radius, 'rgba(239, 68, 68, 0.65)', null, 0);
      } else if (hasBullDivergence) {
        // Hidden Bullish Absorption
        drawRoundedRect(bodyX, bodyTop, bodyW, bodyH, radius, '#b91c1c', '#38bdf8', 1.2);
        drawRoundedRect(bodyX + 1, bodyTop + 1, Math.max(1, bodyW - 2), Math.max(1, bodyH - 2), radius, 'rgba(16, 185, 129, 0.65)', null, 0);
      } else {
        // Normal TradingView Vector Candle with subtle vertical micro-gradient
        const candleGrad = ctx.createLinearGradient(0, bodyTop, 0, bodyTop + bodyH);
        if (isBull) {
          candleGrad.addColorStop(0, '#00e676');
          candleGrad.addColorStop(1, '#00b050');
          drawRoundedRect(bodyX, bodyTop, bodyW, bodyH, radius, candleGrad, '#69f0ae', 0.8);
        } else {
          candleGrad.addColorStop(0, '#ff3366');
          candleGrad.addColorStop(1, '#d50000');
          drawRoundedRect(bodyX, bodyTop, bodyW, bodyH, radius, candleGrad, '#ff8a80', 0.8);
        }
      }

      // Internal Order Flow POC Golden Dot
      if (this.csShowLevels && c.poc && bodyW >= 6) {
        const yPoc = pToY(c.poc);
        if (yPoc >= yHigh - 2 && yPoc <= yLow + 2) {
          ctx.fillStyle = '#ffd60a';
          ctx.beginPath();
          ctx.arc(cx, yPoc, Math.min(3.0, Math.max(1.8, bodyW * 0.22)), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }
      }

      // Permanent Frozen Signal Rendering
      const cachedSig = (!isLive && this._confirmedSignalsCache) ? this._confirmedSignalsCache.get(c.time) : null;
      const aPlusSignal = cachedSig ? cachedSig.aPlusSignal : null;
      const signalBadge = cachedSig ? cachedSig.signalBadge : null;
      const signalCol   = cachedSig ? cachedSig.signalCol : '#00e676';

      if (this.csShowSignals && (aPlusSignal || signalBadge)) {
        if (aPlusSignal) {
          const isBuy = aPlusSignal.direction === 'BUY';
          const isFocus = (i === latestSignalCandleIdx) || (i === hoveredCandleIdx);

          ctx.save();
          ctx.fillStyle = signalCol;
          ctx.beginPath();
          if (isBuy) {
            const tipY = Math.min(mainChartBottom - 4, yLow + 4);
            ctx.moveTo(cx, tipY);
            ctx.lineTo(cx - 3.5, tipY + 5);
            ctx.lineTo(cx + 3.5, tipY + 5);
          } else {
            const tipY = Math.max(mainChartTop + 4, yHigh - 4);
            ctx.moveTo(cx, tipY);
            ctx.lineTo(cx - 3.5, tipY - 5);
            ctx.lineTo(cx + 3.5, tipY - 5);
          }
          ctx.closePath();
          ctx.fill();

          const badgeY = isBuy ? Math.min(mainChartBottom - 11, yLow + 17) : Math.max(mainChartTop + 14, yHigh - 17);
          const badgeText = isFocus ? aPlusSignal.badge : (isBuy ? `▲ ${aPlusSignal.technique || 'BUY'}` : `▼ ${aPlusSignal.technique || 'SELL'}`);

          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const btw = ctx.measureText(badgeText).width + 10;
          const bth = 15;
          const btx = cx - btw / 2;
          const bty = badgeY - bth / 2;

          ctx.fillStyle = isBuy ? 'rgba(6, 78, 59, 0.94)' : 'rgba(136, 19, 55, 0.94)';
          ctx.fillRect(btx, bty, btw, bth);
          ctx.strokeStyle = isFocus ? '#ffd60a' : (isBuy ? '#10b981' : '#f43f5e');
          ctx.lineWidth = isFocus ? 1.2 : 0.8;
          ctx.strokeRect(btx, bty, btw, bth);

          ctx.fillStyle = isFocus ? '#ffd60a' : '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, cx, badgeY);

          if (isFocus) {
            const pegW = Math.min(slotW * 3.2, 85);
            const ySl = pToY(aPlusSignal.sl);
            const yTp = pToY(aPlusSignal.tp);

            if (ySl >= mainChartTop && ySl <= mainChartBottom) {
              ctx.strokeStyle = '#ff3366';
              ctx.setLineDash([4, 3]);
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.moveTo(cx, ySl);
              ctx.lineTo(cx + pegW, ySl);
              ctx.stroke();

              const slTxt = `SL $${aPlusSignal.sl.toFixed(2)}`;
              ctx.font = 'bold 8px "JetBrains Mono", monospace';
              const slTw = ctx.measureText(slTxt).width + 8;
              ctx.fillStyle = 'rgba(159, 18, 57, 0.94)';
              ctx.fillRect(cx + pegW, ySl - 6.5, slTw, 13);
              ctx.strokeStyle = '#ff3366';
              ctx.lineWidth = 0.8;
              ctx.strokeRect(cx + pegW, ySl - 6.5, slTw, 13);
              ctx.fillStyle = '#ff8a80';
              ctx.textAlign = 'center';
              ctx.fillText(slTxt, cx + pegW + slTw / 2, ySl + 3);
            }

            if (yTp >= mainChartTop && yTp <= mainChartBottom) {
              ctx.strokeStyle = '#00e676';
              ctx.setLineDash([4, 3]);
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.moveTo(cx, yTp);
              ctx.lineTo(cx + pegW, yTp);
              ctx.stroke();

              const tpTxt = `TP $${aPlusSignal.tp.toFixed(2)} [1:${aPlusSignal.rr || 2.5}]`;
              ctx.font = 'bold 8px "JetBrains Mono", monospace';
              const tpTw = ctx.measureText(tpTxt).width + 8;
              ctx.fillStyle = 'rgba(6, 78, 59, 0.94)';
              ctx.fillRect(cx + pegW, yTp - 6.5, tpTw, 13);
              ctx.strokeStyle = '#00e676';
              ctx.lineWidth = 0.8;
              ctx.strokeRect(cx + pegW, yTp - 6.5, tpTw, 13);
              ctx.fillStyle = '#bbf7d0';
              ctx.textAlign = 'center';
              ctx.fillText(tpTxt, cx + pegW + tpTw / 2, yTp + 3);
            }
          }
          ctx.restore();
        } else if (signalBadge) {
          const sy = hasBullDivergence ? Math.min(mainChartBottom - 8, yLow + 14) : Math.max(mainChartTop + 14, yHigh - 10);
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          ctx.fillStyle = signalCol;
          ctx.textAlign = 'center';
          ctx.fillText(signalBadge, cx, sy);
        }
      }

      if (i === hoveredCandleIdx) {
        const d = new Date(c.time * 1000);
        hoveredCandle = {
          ...c,
          cx,
          timeStr: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }),
          signalBadge,
          signalCol,
          aPlusSignal
        };
        this.hoverCell = {
          isCandleTooltip: true,
          screenX: cx,
          screenY: this.mousePos.y,
          ...hoveredCandle
        };
      }
    }

    const dispC = hoveredCandle || candles[candles.length - 1];

    // 10. Bottom Volume + Order Flow Delta Sub-Pane + CVD Curve
    const volTop = mainChartBottom;
    ctx.fillStyle = '#060a12';
    ctx.fillRect(0, volTop, chartW, volPaneH);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, volTop);
    ctx.lineTo(chartW, volTop);
    ctx.stroke();

    let runCvd = 0;
    let minCvd = 0, maxCvd = 0;
    const cvdPoints = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const cx = getBarX(i);
      const barH = Math.max(3, (c.volume / maxVol) * (volPaneH - 22));
      const by = volTop + volPaneH - barH - 2;
      const isPosDelta = (c.delta || 0) >= 0;

      ctx.fillStyle = isPosDelta ? 'rgba(0, 230, 118, 0.45)' : 'rgba(255, 51, 102, 0.45)';
      ctx.fillRect(cx - bodyW / 2, by, bodyW, barH);
      ctx.strokeStyle = isPosDelta ? '#00e676' : '#ff3366';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(cx - bodyW / 2, by, bodyW, barH);

      runCvd += (c.delta || 0);
      if (runCvd < minCvd) minCvd = runCvd;
      if (runCvd > maxCvd) maxCvd = runCvd;
      cvdPoints.push({ x: cx, v: runCvd });
    }

    const cvdMidY = volTop + volPaneH / 2;
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, cvdMidY);
    ctx.lineTo(chartW, cvdMidY);
    ctx.stroke();
    ctx.restore();

    if (cvdPoints.length > 1) {
      const cvdSpan = Math.max(1, maxCvd - minCvd);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < cvdPoints.length; i++) {
        const py = (volTop + volPaneH - 6) - ((cvdPoints[i].v - minCvd) / cvdSpan) * (volPaneH - 20);
        if (i === 0) ctx.moveTo(cvdPoints[i].x, py);
        else ctx.lineTo(cvdPoints[i].x, py);
      }
      ctx.stroke();

      const lastPt = cvdPoints[cvdPoints.length - 1];
      const lastPy = (volTop + volPaneH - 6) - ((lastPt.v - minCvd) / cvdSpan) * (volPaneH - 20);
      ctx.fillStyle = '#00f0ff';
      ctx.beginPath();
      ctx.arc(lastPt.x, lastPy, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sub-pane Header Tag & Collision-Free Responsive Telemetry
    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.fillRect(6, volTop + 3, 142, 14);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(6, volTop + 3, 142, 14);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 8px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('📊 VOLUM & DELTA FLOW', 10, volTop + 13);

    // Responsive telemetry: Adjust detail based on chart width
    if (chartW > 360) {
      const subTeleTxt = chartW > 520
        ? `Vol:${(dispC.volume || 0).toFixed(0)}L  Δ:${(dispC.delta || 0) >= 0 ? '+' : ''}${(dispC.delta || 0).toFixed(1)}L  CVD:${runCvd >= 0 ? '+' : ''}${runCvd.toFixed(1)}L`
        : `Δ:${(dispC.delta || 0) >= 0 ? '+' : ''}${(dispC.delta || 0).toFixed(1)}L CVD:${runCvd >= 0 ? '+' : ''}${runCvd.toFixed(1)}L`;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(subTeleTxt, chartW - 8, volTop + 13);
    }

    // 10.5. Visual S/R Rays from Previous 3 Candle POCs
    if (this.csShowLevels && candles.length >= 3) {
      const recentCandles = candles.slice(-4, -1);
      const pocColors = ['#f59e0b', '#38bdf8', '#c084fc'];

      recentCandles.forEach((rc, rIdx) => {
        if (!rc.poc || rc.poc <= 0) return;
        const pocY = pToY(rc.poc);
        if (pocY < mainChartTop + 8 || pocY > mainChartBottom - 8) return;

        const cOrigIdx = candles.length - 4 + rIdx;
        const startX = getBarX(Math.max(0, cOrigIdx));
        const col = pocColors[rIdx % pocColors.length];
        const offsetNum = recentCandles.length - rIdx;

        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(startX, pocY);
        ctx.lineTo(chartW, pocY);
        ctx.stroke();
        ctx.setLineDash([]);

        const tagText = `POC-${offsetNum} $${rc.poc.toFixed(2)}`;
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        const tw = ctx.measureText(tagText).width + 8;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
        ctx.fillRect(chartW - tw - 4, pocY - 7, tw, 14);
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(chartW - tw - 4, pocY - 7, tw, 14);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.fillText(tagText, chartW - 4 - tw / 2, pocY + 3.5);
        ctx.restore();
      });
    }

    // 11. Live Price Dashed Ray + Countdown Timer
    const liveY = pToY(lastPrice);
    if (liveY >= mainChartTop && liveY <= mainChartBottom) {
      const liveCandle = candles[candles.length - 1];
      const isUp = lastPrice >= liveCandle.open;
      const badgeCol = isUp ? '#00e676' : '#ff3366';

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = badgeCol;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, liveY);
      ctx.lineTo(chartW, liveY);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = badgeCol;
      ctx.fillRect(chartW + 1, liveY - 9, rightAxisW - 2, 18);
      ctx.fillStyle = '#04101e';
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lastPrice.toFixed(2), chartW + rightAxisW / 2, liveY + 3.5);

      const tfSecMap = { 'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800, 'H1': 3600, 'H4': 14400 };
      const intervalSec = tfSecMap[this.timeframe || 'M1'] || 60;
      const nowSec = Math.floor(Date.now() / 1000);
      const remSec = Math.max(0, intervalSec - (nowSec % intervalSec));
      const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
      const ss = String(remSec % 60).padStart(2, '0');

      const timerY = Math.min(mainChartBottom - 10, liveY + 9);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(chartW + 1, timerY, rightAxisW - 2, 14);
      ctx.fillStyle = '#ffd60a';
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      ctx.fillText(`⏱ ${mm}:${ss}`, chartW + rightAxisW / 2, timerY + 10);
    }

    // 11b. Render Backtest Replay Simulated Trades and Banner
    if (this.isReplayMode) {
      // Top Replay Banner
      const bW = 280;
      const bH = 20;
      const bX = Math.round((chartW - bW) / 2);
      const bY = topBarH + 6;
      ctx.fillStyle = 'rgba(79, 70, 229, 0.90)';
      ctx.fillRect(bX, bY, bW, bH);
      ctx.strokeStyle = '#c7d2fe';
      ctx.lineWidth = 1;
      ctx.strokeRect(bX, bY, bW, bH);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⏪ MOD REPLAY AKTIF • Bar ${this.replayIndex}/${this.allCandles.length}`, bX + bW / 2, bY + bH / 2);

      // Render Open Replay Trades
      if (this.replayTrades && this.replayTrades.length > 0) {
        for (const t of this.replayTrades) {
          if (t.status !== 'OPEN') continue;
          const yEntry = pToY(t.entryPrice);
          const ySl = pToY(t.sl);
          const yTp = pToY(t.tp);
          const isBuy = t.type === 'BUY';
          const col = isBuy ? '#10b981' : '#ef4444';

          ctx.save();
          // Entry line
          ctx.strokeStyle = col;
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(0, yEntry);
          ctx.lineTo(chartW, yEntry);
          ctx.stroke();

          // Entry tag
          const pnlStr = (t.pnl >= 0 ? '+' : '') + `$${t.pnl.toFixed(2)}`;
          const txt = `⚡ SIM ${t.type} @ $${t.entryPrice.toFixed(2)} (${pnlStr})`;
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          const tw = ctx.measureText(txt).width + 12;
          ctx.fillStyle = isBuy ? 'rgba(6, 78, 59, 0.95)' : 'rgba(136, 19, 55, 0.95)';
          ctx.fillRect(8, yEntry - 8, tw, 16);
          ctx.strokeStyle = col;
          ctx.strokeRect(8, yEntry - 8, tw, 16);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, 14, yEntry);

          // SL line
          ctx.strokeStyle = '#ef4444';
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, ySl); ctx.lineTo(chartW, ySl); ctx.stroke();
          ctx.fillStyle = '#ef4444';
          ctx.fillText(`SL $${t.sl.toFixed(2)}`, 14, ySl - 4);

          // TP line
          ctx.strokeStyle = '#10b981';
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, yTp); ctx.lineTo(chartW, yTp); ctx.stroke();
          ctx.fillStyle = '#10b981';
          ctx.fillText(`TP $${t.tp.toFixed(2)}`, 14, yTp - 4);
          ctx.restore();
        }
      }
    }

    // 12. Crosshair on Hover
    if (this.mousePos.x > 0 && this.mousePos.x < chartW && this.mousePos.y > mainChartTop && this.mousePos.y < mainChartBottom) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.40)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, this.mousePos.y);
      ctx.lineTo(chartW, this.mousePos.y);
      ctx.moveTo(this.mousePos.x, mainChartTop);
      ctx.lineTo(this.mousePos.x, this.height - bottomTimeH);
      ctx.stroke();
      ctx.restore();

      const cursorP = yToP(this.mousePos.y);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(chartW + 1, this.mousePos.y - 8, rightAxisW - 2, 16);
      ctx.fillStyle = '#04101e';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(cursorP.toFixed(2), chartW + rightAxisW / 2, this.mousePos.y + 3.5);
    }

    // 13. Top Interactive Candlestick Telemetry Strip & Quick Action Trade HUD
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, this.width, topBarH);
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, topBarH);
    ctx.lineTo(this.width, topBarH);
    ctx.stroke();

    // Define interactive pills: Feature Toggles + Navigation + Quick Action Trade HUD
    const pills = [
      // Replay / Backtesting Mode Quick Toggle
      { label: this.isReplayMode ? '⏪ REPLAY: ON' : '⏪ REPLAY', active: this.isReplayMode, col: '#818cf8', fn: () => {
        if (window.app && window.app.toggleReplayMode) window.app.toggleReplayMode();
        else if (window.orderFlowApp && window.orderFlowApp.toggleReplayMode) window.orderFlowApp.toggleReplayMode();
      }},
      // Quick Action Trade HUD
      { label: '⚡ BUY', active: true, col: '#059669', isTrade: true, fn: () => {
        if (window.orderFlowApp && window.orderFlowApp.sendTrade) window.orderFlowApp.sendTrade('BUY');
      }},
      { label: '⚡ SELL', active: true, col: '#dc2626', isTrade: true, fn: () => {
        if (window.orderFlowApp && window.orderFlowApp.sendTrade) window.orderFlowApp.sendTrade('SELL');
      }},
      { label: '🎯 BE', active: false, col: '#0284c7', isTrade: true, fn: () => {
        fetch('/api/breakeven_all', { method: 'POST' }).then(r => r.json()).then(res => {
          if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
        });
      }},
      { label: '❌ CLOSE', active: false, col: '#e11d48', isTrade: true, fn: () => {
        fetch('/api/close_all', { method: 'POST' }).then(r => r.json()).then(res => {
          if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
        });
      }},
      // Indicator & Analysis Toggles
      { label: '📈 EMA', active: this.csShowEMA, col: '#ffd60a', fn: () => { this.csShowEMA = !this.csShowEMA; } },
      { label: '🌐 VWAP', active: this.csShowVWAP, col: '#00f0ff', fn: () => { this.csShowVWAP = !this.csShowVWAP; } },
      { label: '⭐ Sesi', active: this.csShowLevels, col: '#fbbf24', fn: () => { this.csShowLevels = !this.csShowLevels; } },
      { label: this.csShowFvgOb !== false ? '📦 FVG/OB' : '📦 FVG: OFF', active: this.csShowFvgOb !== false, col: '#34d399', fn: () => { this.csShowFvgOb = !(this.csShowFvgOb !== false); } },
      { label: this.csShowStructure !== false ? '🏛️ BOS' : '🏛️ BOS: OFF', active: this.csShowStructure !== false, col: '#c084fc', fn: () => { this.csShowStructure = !(this.csShowStructure !== false); } },
      { label: this.csShowSignals ? '🎯 Signal' : '🎯 Signal: OFF', active: this.csShowSignals, col: '#00e676', fn: () => { this.csShowSignals = !this.csShowSignals; } },
      { label: '◀', active: false, col: '#38bdf8', fn: () => { this.panHorizontal(-1); } },
      { label: '▶', active: false, col: '#38bdf8', fn: () => { this.panHorizontal(1); } },
      { label: '▲', active: false, col: '#38bdf8', fn: () => { this.panVertical(1); } },
      { label: '▼', active: false, col: '#38bdf8', fn: () => { this.panVertical(-1); } }
    ];
    if (Math.abs(this.priceOffset || 0) > 0.05 || (this.barOffset || 0) > 0) {
      pills.push({ label: '🎯 Cent', active: true, col: '#fbbf24', fn: () => { this.centerVertical(); } });
    }
    pills.push({ label: '➖', active: false, col: '#38bdf8', fn: () => { this.csVisibleBars = Math.min(50, (this.csVisibleBars || 34) + 4); } });
    pills.push({ label: '➕', active: false, col: '#38bdf8', fn: () => { this.csVisibleBars = Math.max(14, (this.csVisibleBars || 34) - 4); } });

    // Measure pill widths
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    let totalPillsW = 0;
    const pillMetrics = pills.map(p => {
      const w = Math.ceil(ctx.measureText(p.label).width) + 10;
      totalPillsW += (w + 4);
      return { ...p, w };
    });

    // Anchor pills from right edge
    const pillStartX = Math.max(240, this.width - totalPillsW - 6);
    let curPx = pillStartX;

    // Render Pills
    for (const p of pillMetrics) {
      const y = 6;
      const h = 20;
      if (curPx + p.w > this.width - 4) break;
      ctx.fillStyle = p.active ? p.col : '#162238';
      ctx.fillRect(curPx, y, p.w, h);
      ctx.strokeStyle = p.active ? (p.isTrade ? '#ffffff' : p.col) : '#334155';
      ctx.lineWidth = p.isTrade ? 1.0 : 0.8;
      ctx.strokeRect(curPx, y, p.w, h);
      ctx.fillStyle = p.active ? '#ffffff' : '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText(p.label, curPx + p.w / 2, y + 13.5);
      this.cdToolbarHitboxes.push({ x: curPx, y, w: p.w, h, onClick: p.fn });
      curPx += p.w + 4;
    }

    // Left Telemetry in safe space between 0 and pillStartX - 10
    const chg = dispC.close - dispC.open;
    const isUpC = chg >= 0;
    const availTeleW = pillStartX - 16;

    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(`🕯️ XAUUSD [${this.timeframe || 'M1'}]`, 8, 20);

    if (availTeleW > 160) {
      let ohlcTxt = '';
      if (availTeleW > 450) {
        ohlcTxt = `O:${dispC.open.toFixed(2)}  H:${dispC.high.toFixed(2)}  L:${dispC.low.toFixed(2)}  C:${dispC.close.toFixed(2)} (${isUpC ? '+' : ''}${chg.toFixed(2)})  Vol:${dispC.volume.toFixed(0)}L  Δ:${dispC.delta >= 0 ? '+' : ''}${dispC.delta.toFixed(1)}L`;
      } else if (availTeleW > 300) {
        ohlcTxt = `O:${dispC.open.toFixed(2)} H:${dispC.high.toFixed(2)} L:${dispC.low.toFixed(2)} C:${dispC.close.toFixed(2)} (${isUpC ? '+' : ''}${chg.toFixed(2)})`;
      } else {
        ohlcTxt = `C:${dispC.close.toFixed(2)} (${isUpC ? '+' : ''}${chg.toFixed(2)})`;
      }
      ctx.fillStyle = isUpC ? '#4ade80' : '#fb7185';
      ctx.fillText(ohlcTxt, 114, 20);
    }

    ctx.restore();
  }

  zoomIn() {
    this.candleWidth = Math.min(240, this.candleWidth + 20);
    this.verticalZoom = Math.min(4.0, this.verticalZoom + 0.25);
    this.setJalurCount((this.cdVisibleCols || 30) - 2);
    this.csVisibleBars = Math.max(14, (this.csVisibleBars || 34) - 4);
  }

  zoomOut() {
    this.candleWidth = Math.max(90, this.candleWidth - 20);
    this.verticalZoom = Math.max(0.6, this.verticalZoom - 0.25);
    this.setJalurCount((this.cdVisibleCols || 30) + 2);
    this.csVisibleBars = Math.min(50, (this.csVisibleBars || 34) + 4);
  }

  resetZoom() {
    this.candleWidth = 145;
    this.verticalZoom = 1.0;
    this.priceOffset = 0.0;
    this.barOffset = 0;
    this.csVerticalScale = 1.0;
    this.setJalurCount(30);
    this.csVisibleBars = 34;
  }
}

window.FootprintRenderer = FootprintRenderer;
