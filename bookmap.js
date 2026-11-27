/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  BOOKMAP™ PROFESSIONAL CANVAS ENGINE v6.0 — INSTITUTIONAL PRO REPLICA    ║
 * ║  Pixel-Perfect Order Flow, Heatmap, VWAP, Position Lines & Sound Engine  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

class BookmapRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx    = this.canvas.getContext('2d');

    // Dynamic price scale
    this.minPrice = 4120.0;
    this.maxPrice = 4130.0;
    this._targetMin = this.minPrice;
    this._targetMax = this.maxPrice;

    // 60-second rolling window default (M1)
    this.timeframe = 'M1';
    this.timeWindowMs = 180000;

    // Viewport dimensions
    this.width  = 0;
    this.height = 0;

    // Mouse & Tooltip state
    this.mouseX = -1;
    this.mouseY = -1;
    this.hoverTrade = null;

    // Controls & Toggles
    this.bubbleZoom = 1.0;
    this.showVolumeZones = false; // Bookmap X-Ray Clean Canvas: Zero BUY/SELL ZONE boxes over heatmap
    this.showVWAP = true;
    this.showPositions = true;
    this.showSessionLevels = true;
    this.showAutoTrendline = true;
    this.showSVP = true;
    this.showIcebergs = true;
    this.bmShowSignals = true; // Institutional Order Flow Buy/Sell Signals (Location-First)
    this._bmSignalsHistory = []; // Cached confirmed signals on Bookmap canvas
    this._bmLastSignalTime = 0;
    this._bmLastSignalDir = null;
    this.isAudioMuted = false;
    this.isVoiceDisabled = true;

    // Bookmap Pro v7.5 Interactive Settings (Clean Default Mode)
    this.bmPaletteMode = 'thermo'; // 'thermo' | 'cyber' | 'gold'
    this.bmWallFilterOnly = false; // false = all depth, true = >=30L walls only
    this.bmShowBidAskChannel = true;  // Bookmap X-Ray Default ON: Dual Green Best Bid & Red Best Ask stepped lines
    this.bmShowWhaleLabels = true;    // Default ON so Whale & Jerung lot callouts are clearly visible
    this.bmShowSharkWalls = false;    // Bookmap X-Ray Clean Projection: Sizes are shown in Dual COB columns, zero floating text over heatmap
    this.bmShowCvdCurve = true;
    this.bmHalfSpan = 4.5; // Vertical price span (±$4.50 default)
    this.priceOffset = 0.0; // Vertical pan offset ($ above/below live price)
    this.timeOffsetMs = 0;  // Horizontal pan offset (ms back in time when > 0)
    this._isDragging = false;
    this._dragMode = null; // 'pan' | 'scale'
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartOffset = 0;
    this._dragStartTimeOffset = 0;
    this._dragStartSpan = 4.5;
    this.bmHudHitboxes = [];
    this._positionHitboxes = []; // Hitboxes for interactive drag-and-drop SL & TP lines
    this._draggingSLTP = null;   // Active SL/TP drag state
    this._depthHistoryBuffer = []; // Rolling 4s buffer for Pulling/Stacking delta calculation

    // Bookmap World-Class Enhancements:
    this.bmZenMode = false;      // Zen Pro Mode: Pristine view without floating banners or small trade noise
    let savedTier = 'noise';
    try {
      if (typeof localStorage !== 'undefined') savedTier = localStorage.getItem('gringgo_whale_category') || 'noise';
      const selEl = typeof document !== 'undefined' ? document.getElementById('selWhaleCategory') : null;
      if (selEl && selEl.value) savedTier = selEl.value;
    } catch(e) {}
    this.bmBubbleCategory = savedTier; // 'noise' (Semua) | 'normal' (≥12L) | 'major' (≥35L) | 'mega' (≥80L) | 'off'
    this.bmBubbleFilter = 'all';     // 'all' | 'whale' | 'off'
    this.bmBubbleMinVol = 12.0;  // Threshold for bold lot size numbers on trade bubbles
    this._occupiedBadgeSlots = []; // Frame-by-frame anti-collision vertical slot registry
    this.bmContrastMode = 'MED'; // 'AUTO' | 'LOW' | 'MED' | 'HIGH'
    this.bmShowSweeps = false;   // Bookmap X-Ray Clean Canvas: Zero SWEEP & VOID text boxes over heatmap
    this._bmSweepEvents = [];    // Cached sweep events [{ id, price, time, vol, bias, badge }]
    this._prevDepthSnapshot = null;
    this._autoMinCut = 12.0;     // Dynamic threshold for AUTO contrast
    this._icebergReloads = {};   // priceKey -> { count, absorbed, lastSeen }
    this.bmRulerActive = false;  // Interactive Order Flow Ruler Tool
    this.bmRulerPointA = null;   // { x, y, price, time }
    this.bmRulerPointB = null;   // { x, y, price, time }

    // Audio & Sound FX state
    this._audioCtx = null;
    this._lastWhaleSoundId = null;
    this._lastZoneSoundTime = 0;
    this._lastSpeakTime = 0;

    // Whale Inflow Radar & Sudden Placement Alert System
    this.whaleRadarEnabled = true;
    this._activeWhaleAlert = null;
    this._whaleRadarPings = [];
    this._notifiedWhaleAlertIds = new Set();
    this._lastWhaleAlertSoundTime = 0;

    this._setupResize();
    this._setupInteractions();
  }

  /* ─── 2D Lane-Aware Anti-Collision Vertical Badge Slotting ────── */
  _resolveNonOverlappingY(targetY, badgeH = 16, minGap = 19, lane = 'LEFT') {
    if (!this._occupiedBadgeLanes) {
      this._occupiedBadgeLanes = { LEFT: [], CENTER: [], RIGHT: [], PROJ: [] };
    }
    const slots = this._occupiedBadgeLanes[lane] || this._occupiedBadgeLanes.LEFT;
    const minTop = (this.CHART_TOP || 0) + (lane === 'LEFT' ? 30 : 16);
    const maxBot = (this.CHART_BOTTOM || 500) - badgeH - 6;

    // Stable Anti-Collision Slotting (Zero vertical jumping when live price ticks by 1 cent)
    const isColliding = (candY) => {
      if (candY < minTop || candY > maxBot) return true;
      return slots.some(slotY => Math.abs(slotY - candY) < minGap);
    };

    let resolvedY = Math.max(minTop, Math.min(maxBot, targetY));
    if (isColliding(resolvedY)) {
      for (let step = 1; step <= 10; step++) {
        const downY = targetY + step * minGap;
        if (!isColliding(downY)) {
          resolvedY = downY;
          break;
        }
        const upY = targetY - step * minGap;
        if (!isColliding(upY)) {
          resolvedY = upY;
          break;
        }
      }
    }
    slots.push(resolvedY);
    return resolvedY;
  }

  /* ─── Web Audio API Sound Synthesizer ──────────────────────────── */
  _getAudioContext() {
    if (!this._audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this._audioCtx = new AudioCtx();
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume();
    }
    return this._audioCtx;
  }

  playWhaleSound() {
    if (this.isAudioMuted) return;
    try {
      const actx = this._getAudioContext();
      if (!actx) return;
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, actx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(293.66, actx.currentTime + 0.35); // D4
      gain.gain.setValueAtTime(0.20, actx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + 0.45);
    } catch (e) {}
  }

  playZoneSound() {
    if (this.isAudioMuted) return;
    const now = Date.now();
    if (now - this._lastZoneSoundTime < 4500) return;
    this._lastZoneSoundTime = now;
    try {
      const actx = this._getAudioContext();
      if (!actx) return;
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880.0, actx.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(1108.73, actx.currentTime + 0.22); // C#6
      gain.gain.setValueAtTime(0.14, actx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start();
      osc.stop(actx.currentTime + 0.35);
    } catch (e) {}
  }

  toggleAudio() {
    this.isAudioMuted = !this.isAudioMuted;
    return !this.isAudioMuted;
  }

  toggleVoice() {
    this.isVoiceDisabled = !this.isVoiceDisabled;
    if (!this.isVoiceDisabled) {
      this.speakAlert("Sistem suara kecerdasan buatan diaktifkan.");
    }
    return !this.isVoiceDisabled;
  }

  speakAlert(text) {
    if (this.isVoiceDisabled) return;
    if (!('speechSynthesis' in window)) return;
    const now = Date.now();
    if (now - this._lastSpeakTime < 7000) return;
    this._lastSpeakTime = now;

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const matched = voices.find(v => v.lang.startsWith('ms') || v.lang.startsWith('id') || v.name.includes('Google') || v.lang.startsWith('en'));
      if (matched) utterance.voice = matched;
      window.speechSynthesis.speak(utterance);
    } catch (e) {}
  }

  takeScreenshot() {
    try {
      const link = document.createElement('a');
      link.download = `Bookmap_XAUUSD_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      link.href = this.canvas.toDataURL('image/png');
      link.click();
      return true;
    } catch (e) {
      console.error('[Screenshot Error]', e);
      return false;
    }
  }

  setBubbleZoom(zoom) {
    this.bubbleZoom = Math.max(0.3, Math.min(3.0, parseFloat(zoom) || 1.0));
  }

  setBubbleCategory(tierId) {
    if (!['noise', 'normal', 'major', 'mega', 'off'].includes(tierId)) tierId = 'noise';
    this.bmBubbleCategory = tierId;
    this.bmBubbleFilter = (tierId === 'noise') ? 'all' : (tierId === 'off' ? 'off' : 'whale');
    this.bmBubbleMinVol = tierId === 'normal' ? 12.0 : (tierId === 'major' ? 35.0 : (tierId === 'mega' ? 80.0 : 0.0));
    
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('gringgo_whale_category', tierId);
      const sel = typeof document !== 'undefined' ? document.getElementById('selWhaleCategory') : null;
      if (sel && sel.value !== tierId) {
        sel.value = tierId;
      }
    } catch (e) {}

    this.needsRedraw = true;
    if (this._latestSnapshot) {
      this.render(this._latestSnapshot);
    }
  }

  toggleVolumeZones() {
    this.showVolumeZones = !this.showVolumeZones;
    return this.showVolumeZones;
  }

  toggleVWAP() {
    this.showVWAP = !this.showVWAP;
    return this.showVWAP;
  }

  togglePositions() {
    this.showPositions = !this.showPositions;
    return this.showPositions;
  }

  toggleSessionLevels() {
    this.showSessionLevels = !this.showSessionLevels;
    return this.showSessionLevels;
  }

  toggleAutoTrendline() {
    this.showAutoTrendline = !this.showAutoTrendline;
    return this.showAutoTrendline;
  }

  toggleSVP() {
    this.showSVP = !this.showSVP;
    return this.showSVP;
  }

  toggleIcebergs() {
    this.showIcebergs = !this.showIcebergs;
    return this.showIcebergs;
  }

  zoomIn() {
    this.bubbleZoom = Math.min(2.8, this.bubbleZoom + 0.20);
    this.bmHalfSpan = Math.max(1.5, (this.bmHalfSpan || 4.5) - 0.6);
  }

  zoomOut() {
    this.bubbleZoom = Math.max(0.4, this.bubbleZoom - 0.20);
    this.bmHalfSpan = Math.min(14.0, (this.bmHalfSpan || 4.5) + 0.6);
  }

  resetZoom() {
    this.bubbleZoom = 1.0;
    this.bmHalfSpan = 4.5;
    this.priceOffset = 0.0;
    this.timeOffsetMs = 0;
  }

  panVertical(dir) {
    // dir > 0: pan UP (see higher prices), dir < 0: pan DOWN (see lower prices)
    const step = Math.max(0.40, (this.bmHalfSpan || 4.5) * 0.22);
    this.priceOffset = Number(((this.priceOffset || 0) + dir * step).toFixed(2));
  }

  panHorizontal(dir) {
    // dir < 0: pan LEFT (see older history), dir > 0: pan RIGHT (back toward live NOW)
    const stepMs = Math.round((this.timeWindowMs || 60000) * 0.20);
    const nextOffset = (this.timeOffsetMs || 0) - dir * stepMs;
    this.timeOffsetMs = Math.max(-Math.round((this.timeWindowMs || 60000) * 0.35), Math.min((this.timeWindowMs || 60000) * 5, nextOffset));
  }

  centerVertical() {
    this.priceOffset = 0.0;
    this.timeOffsetMs = 0;
  }

  centerToPrice() {
    this.centerVertical();
  }

  setTimeframe(tf) {
    const tfMap = {
      'M1':  180000,
      'M5':  420000,
      'M15': 1200000,
      'M30': 2400000,
      'H1':  4800000,
      'H4':  18000000
    };
    tf = (tf || 'M1').toUpperCase();
    if (tfMap[tf]) {
      this.timeframe = tf;
      this.timeWindowMs = tfMap[tf];
    }
  }

  setHistoricalCandles(candles) {
    if (Array.isArray(candles) && candles.length > 0) {
      this._deepHistoricalCandles = candles;
    }
  }

  /* ─── HiDPI Responsive Canvas Resize ───────────────────────────── */
  _setupResize() {
    const handleResize = () => {
      if (!this.canvas || !this.canvas.parentElement) return;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      const measuredW = rect.width || window.innerWidth || 360;
      const measuredH = rect.height || 360;
      this.width  = Math.max(Math.floor(measuredW), 260);
      this.height = Math.max(Math.floor(measuredH), 200);

      this.canvas.width  = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.canvas.style.width  = this.width + 'px';
      this.canvas.style.height = this.height + 'px';

      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', () => setTimeout(handleResize, 120));
    setTimeout(handleResize, 50);
    setTimeout(handleResize, 350);
  }

  /* ─── Mouse Hover, Click-Drag Vertical Pan, Axis Scale & Wheel Zoom ─ */
  _setupInteractions() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // Ignore drag start if clicking top HUD bar
      if (cy <= this.TOP_PADDING) return;
      if (this.mobileHitboxes && this.mobileHitboxes.length > 0) {
        for (const hb of this.mobileHitboxes) {
          if (cx >= hb.x && cx <= hb.x + hb.w && cy >= hb.y && cy <= hb.y + hb.h) {
            hb.action();
            return;
          }
        }
      }

      // 1. Check if clicking on an active Stop Loss (SL) or Take Profit (TP) badge to drag
      if (this._positionHitboxes && this._positionHitboxes.length > 0) {
        for (const hb of this._positionHitboxes) {
          if (cx >= hb.x && cx <= hb.x + hb.w && cy >= hb.y && cy <= hb.y + hb.h) {
            this._draggingSLTP = {
              ticket: hb.ticket,
              type: hb.type, // 'sl' or 'tp'
              pos: hb.pos,
              curPrice: hb.type === 'sl' ? hb.pos.sl : hb.pos.tp,
              tempPrice: hb.type === 'sl' ? hb.pos.sl : hb.pos.tp
            };
            this.canvas.style.cursor = 'ns-resize';
            return;
          }
        }
      }

      this._isDragging = true;
      this._dragStartX = cx;
      this._dragStartY = cy;
      this._dragStartOffset = this.priceOffset || 0;
      this._dragStartTimeOffset = this.timeOffsetMs || 0;
      this._dragStartSpan = this.bmHalfSpan || 4.5;

      // Dragging Left Price Axis or Right COB Axis scales vertical price span
      if (cx < this.CHART_LEFT || cx > this.CHART_RIGHT) {
        this._dragMode = 'scale';
        this.canvas.style.cursor = 'ns-resize';
      } else {
        this._dragMode = 'pan';
        this.canvas.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mouseup', () => {
      if (this._draggingSLTP) {
        const d = this._draggingSLTP;
        const newP = d.tempPrice !== undefined ? d.tempPrice : d.curPrice;
        this._draggingSLTP = null;
        this.canvas.style.cursor = 'crosshair';
        const finalSL = d.type === 'sl' ? newP : (d.pos.sl || 0);
        const finalTP = d.type === 'tp' ? newP : (d.pos.tp || 0);
        fetch('/api/update_sltp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: d.ticket, sl: finalSL, tp: finalTP })
        }).then(r => r.json()).then(res => {
          if (window.orderFlowApp && window.orderFlowApp.showToast) {
            window.orderFlowApp.showToast(res.message);
          }
        }).catch(err => {
          console.error('[SLTP Error]', err);
        });
        return;
      }

      if (this._draggingSLTP) {
        const rawP = this.yToPrice(this.mouseY);
        this._draggingSLTP.tempPrice = Number(rawP.toFixed(2));
        this.canvas.style.cursor = 'ns-resize';
        return;
      }

      if (this._isDragging) {
        this._isDragging = false;
        this._dragMode = null;
        this.canvas.style.cursor = 'crosshair';
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const cy = e.clientY - rect.top;
      if (cy > this.TOP_PADDING) {
        this.priceOffset = 0.0;
        this.timeOffsetMs = 0;
        this.bmHalfSpan = 4.5;
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;

      if (this._draggingSLTP) {
        const rawP = this.yToPrice(this.mouseY);
        this._draggingSLTP.tempPrice = Number(rawP.toFixed(2));
        this.canvas.style.cursor = 'ns-resize';
        return;
      }

      if (this._isDragging) {
        const dx = this.mouseX - this._dragStartX;
        const dy = this.mouseY - this._dragStartY;
        if (this._dragMode === 'scale') {
          this.bmHalfSpan = Math.max(1.5, Math.min(15.0, this._dragStartSpan + dy * 0.025));
          this.canvas.style.cursor = 'ns-resize';
        } else {
          // 1. Vertical Pan: dragging mouse DOWN (+dy) moves viewport UP to higher prices (+priceOffset)
          const priceSpan = (this.bmHalfSpan || 4.5) * 2;
          const chartH = Math.max(150, this.CHART_HEIGHT);
          const dPrice = (dy / chartH) * priceSpan;
          this.priceOffset = Number((this._dragStartOffset + dPrice).toFixed(2));

          // 2. Horizontal Pan: dragging mouse RIGHT (+dx) pulls older history into view (+timeOffsetMs)
          const histW = Math.max(200, this.HIST_TIME_W);
          const dTime = (dx / histW) * (this.timeWindowMs || 60000);
          const maxBack = (this.timeWindowMs || 60000) * 5;
          const minForward = -Math.round((this.timeWindowMs || 60000) * 0.35);
          this.timeOffsetMs = Math.max(minForward, Math.min(maxBack, Math.round(this._dragStartTimeOffset + dTime)));

          this.canvas.style.cursor = 'grabbing';
        }
        return;
      }

      if (this.bmHudHitboxes && this.bmHudHitboxes.length > 0) {
        const hit = this.bmHudHitboxes.some(
          b => this.mouseX >= b.x && this.mouseX <= b.x + b.w &&
               this.mouseY >= b.y && this.mouseY <= b.y + b.h
        );
        if (hit) {
          this.canvas.style.cursor = 'pointer';
          return;
        }
      }

      if (this.mouseY > this.TOP_PADDING && (this.mouseX < this.CHART_LEFT || this.mouseX > this.CHART_RIGHT)) {
        this.canvas.style.cursor = 'ns-resize';
      } else {
        this.canvas.style.cursor = 'grab';
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (window.app && window.app.drawingMode) {
        if (window.app._handleCanvasClickForDrawing(cx, cy, this.canvas)) return;
      }
      if (this.bmHudHitboxes) {
        for (const b of this.bmHudHitboxes) {
          if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
            if (b.onClick) b.onClick();
            return;
          }
        }
      }

      // Order Flow Ruler clicks
      if (this.bmRulerActive && cy > this.TOP_PADDING && cx < this.CHART_RIGHT && cx > this.CHART_LEFT) {
        const curPrice = this.yToPrice(cy);
        const curTime = this.xToTime ? this.xToTime(cx, Date.now()) : Date.now();
        if (!this.bmRulerPointA || (this.bmRulerPointA && this.bmRulerPointB)) {
          this.bmRulerPointA = { x: cx, y: cy, price: curPrice, time: curTime };
          this.bmRulerPointB = null;
        } else {
          this.bmRulerPointB = { x: cx, y: cy, price: curPrice, time: curTime };
        }
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.bmRulerActive) {
        e.preventDefault();
        this.bmRulerPointA = null;
        this.bmRulerPointB = null;
        this.bmRulerActive = false;
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouseX = -1;
      this.mouseY = -1;
      this.hoverTrade = null;
      const tt = document.getElementById('chartTooltip');
      if (tt) tt.style.display = 'none';
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || this.mouseX < this.CHART_LEFT || this.mouseX > this.CHART_RIGHT) {
        this.bmHalfSpan = Math.max(1.5, Math.min(15.0, (this.bmHalfSpan || 4.5) + (e.deltaY > 0 ? 0.45 : -0.45)));
      } else {
        this.bubbleZoom = Math.max(0.35, Math.min(2.8, this.bubbleZoom - e.deltaY * 0.0012));
      }
    }, { passive: false });
  }

  /* ─── Layout Constants (Mobile Responsive) ─────────────────────── */
  get isMobileScreen() {
    return Boolean(this.width && this.width < 560);
  }
  get LEFT_AXIS_W() { return this.isMobileScreen ? 38 : 54; }
  get COB_WIDTH()   { return this.isMobileScreen ? 78 : 128; }
  get HIST_HEIGHT() { return (this.height && this.height < 450) ? 42 : 56; }
  get TOP_PADDING() { return 0; }
  get CHART_TOP()   { return this.TOP_PADDING; }
  get CHART_BOTTOM(){ return this.height - this.HIST_HEIGHT; }
  get CHART_LEFT()  { return this.LEFT_AXIS_W; }
  get CHART_RIGHT() { return this.width - this.COB_WIDTH; }
  get CHART_WIDTH() { return this.CHART_RIGHT - this.CHART_LEFT; }
  get CHART_HEIGHT(){ return this.CHART_BOTTOM - this.CHART_TOP; }
  get NOW_X()       { 
    const ratio = this.isMobileScreen ? 0.78 : 0.84;
    return this.CHART_LEFT + Math.floor(this.CHART_WIDTH * ratio); 
  }
  get HIST_TIME_W() { return this.NOW_X - this.CHART_LEFT; }

  /* ─── Coordinate Conversion ────────────────────────────────────── */
  priceToY(price) {
    const range = this.maxPrice - this.minPrice;
    if (range <= 0) return this.CHART_BOTTOM / 2;
    return this.CHART_BOTTOM - ((price - this.minPrice) / range) * this.CHART_HEIGHT;
  }

  yToPrice(y) {
    const range = this.maxPrice - this.minPrice;
    if (this.CHART_HEIGHT <= 0) return this.minPrice;
    return this.minPrice + ((this.CHART_BOTTOM - y) / this.CHART_HEIGHT) * range;
  }

  timeToX(timestamp, now) {
    const tMs = (timestamp && timestamp < 1e11) ? timestamp * 1000 : (timestamp || now);
    const effectiveNow = now - (this.timeOffsetMs || 0);
    const windowStart = effectiveNow - this.timeWindowMs;
    return this.CHART_LEFT + ((tMs - windowStart) / this.timeWindowMs) * this.HIST_TIME_W;
  }

  xToTime(x, now) {
    const effectiveNow = now - (this.timeOffsetMs || 0);
    const windowStart = effectiveNow - this.timeWindowMs;
    const progress = (x - this.CHART_LEFT) / Math.max(1, this.HIST_TIME_W);
    return windowStart + progress * this.timeWindowMs;
  }

  /* ─── Bookmap Multi-Palette High-Definition Thermal Color Engine ── */
  getThermalColor(vol) {
    // Institutional Clean Heatmap: Filter ambient market-maker noise (< 22L) to preserve deep dark obsidian void
    let minCut = 22.0;
    if (this.bmWallFilterOnly) {
      minCut = 38.0;
    } else if (this.bmContrastMode === 'HIGH') {
      minCut = 42.0; // Ultra Clean: Only major institutional walls
    } else if (this.bmContrastMode === 'MED') {
      minCut = 22.0; // Balanced Institutional: Clear shelves & walls, zero barcode stripes
    } else if (this.bmContrastMode === 'LOW') {
      minCut = 15.0;
    } else if (this.bmContrastMode === 'AUTO') {
      minCut = Math.max(20.0, this._autoMinCut || 22.0);
    }

    if (vol < minCut) return null;

    let stops;
    if (this.bmPaletteMode === 'cyber') {
      stops = [
        [22.0,  22,  18,  72, 0.34],  // Muted Deep Indigo
        [34.0,  48,  82, 210, 0.56],  // Cyber Blue Shelf
        [52.0,  56, 189, 248, 0.74],  // Neon Aqua Shelf
        [72.0,   0, 245, 212, 0.86],  // Hyper Mint Major Wall
        [92.0, 247,  37, 133, 0.93],  // Laser Magenta Shark Wall
        [115.0, 255, 240, 250, 0.97]  // Bright Core
      ];
    } else if (this.bmPaletteMode === 'gold') {
      stops = [
        [22.0,  48,  32,  10, 0.34],  // Muted Copper
        [34.0, 145,  90,  14, 0.56],  // Warm Amber Shelf
        [52.0, 217, 155,  18, 0.74],  // Rich Gold Shelf
        [72.0, 250, 204,  21, 0.86],  // Pure Gold Major Wall
        [92.0, 249, 115,  22, 0.93],  // Solar Orange Shark Wall
        [115.0, 225,  29,  72, 0.97]  // Ruby Red Institutional Wall
      ];
    } else {
      // Authentic Bookmap X-Ray Thermal Spectrum (Deep Slate Blue -> Cyan Blue -> Vivid Orange -> Bright Yellow -> Pure White Wall Core)
      stops = [
        [18.0,  16,  46,  82, 0.36],  // Deep X-Ray Slate Blue
        [32.0,  28,  96, 152, 0.60],  // Medium X-Ray Steel Blue
        [50.0, 235,  88,  14, 0.88],  // Bookmap X-Ray Vivid Orange Wall
        [72.0, 250, 204,  21, 0.94],  // Bookmap X-Ray Bright Yellow Wall
        [96.0, 255, 252, 225, 0.98]   // Bookmap X-Ray Pure White-Hot Institutional Wall
      ];
    }

    if (vol <= stops[0][0]) {
      const [ , r, g, b, a] = stops[0];
      return `rgba(${r},${g},${b},${a})`;
    }

    const last = stops[stops.length - 1];
    if (vol >= last[0]) {
      return `rgba(${last[1]},${last[2]},${last[3]},${last[4]})`;
    }

    for (let i = 0; i < stops.length - 1; i++) {
      const s0 = stops[i];
      const s1 = stops[i + 1];
      if (vol >= s0[0] && vol <= s1[0]) {
        const factor = (vol - s0[0]) / (s1[0] - s0[0]);
        const r = Math.round(s0[1] + factor * (s1[1] - s0[1]));
        const g = Math.round(s0[2] + factor * (s1[2] - s0[2]));
        const b = Math.round(s0[3] + factor * (s1[3] - s0[3]));
        const a = (s0[4] + factor * (s1[4] - s0[4])).toFixed(2);
        return `rgba(${r},${g},${b},${a})`;
      }
    }
    return `rgba(${last[1]},${last[2]},${last[3]},${last[4]})`;
  }

  /* ══════════════════════════════════════════════════════════════════
     MAIN RENDER LOOP
     ══════════════════════════════════════════════════════════════════ */
  /* ─── 24/7 Background Data Ingestion (Runs continuously even when viewing Cluster/Footprint) ─── */
  ingestSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._latestSnapshot = snapshot;
    if (snapshot.server_time_ms && typeof snapshot.server_time_ms === 'number') {
      const skew = snapshot.server_time_ms - Date.now();
      this._serverTimeOffset = (this._serverTimeOffset == null) ? skew : (this._serverTimeOffset * 0.95 + skew * 0.05);
    }
    const now = Date.now() + (this._serverTimeOffset || 0);
    if (snapshot.last_price && Number.isFinite(snapshot.last_price)) {
      this.lastKnownPrice = snapshot.last_price;
      this._currentPrice = snapshot.last_price;
    }
    // 1. Ingest Heatmap Slices continuously in background (Always merge by timestamp, never wipe older history!)
    if (!this._heatmapHistoryBuffer) this._heatmapHistoryBuffer = [];
    if (snapshot.heatmap && snapshot.heatmap.length) {
      const hmMap = new Map();
      for (const h of this._heatmapHistoryBuffer) hmMap.set(h.timestamp, h);
      for (const h of snapshot.heatmap) hmMap.set(h.timestamp, h);
      this._heatmapHistoryBuffer = Array.from(hmMap.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-1800);
    }
    // 2. Ingest Trades continuously in background (Always merge by ID/timestamp, never wipe older history!)
    if (!this._tradesHistoryBuffer) this._tradesHistoryBuffer = [];
    if (snapshot.trades && snapshot.trades.length) {
      const trMap = new Map();
      for (const t of this._tradesHistoryBuffer) trMap.set(t.id != null ? t.id : `${t.timestamp}_${t.price}`, t);
      for (const t of snapshot.trades) trMap.set(t.id != null ? t.id : `${t.timestamp}_${t.price}`, t);
      this._tradesHistoryBuffer = Array.from(trMap.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-3500);
    }
  }

  render(snapshot) {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;

    // Robust Fail-Safe Snapshot Guard (never allow undefined/null to break render)
    if (snapshot && typeof snapshot === 'object' && (snapshot.last_price || snapshot.bid || snapshot.order_book)) {
      this._latestSnapshot = snapshot;
    } else {
      snapshot = this._latestSnapshot || snapshot || {};
    }

    // Adaptive Server Clock Skew Synchronization
    if (snapshot && snapshot.server_time_ms && typeof snapshot.server_time_ms === 'number') {
      const skew = snapshot.server_time_ms - Date.now();
      if (this._serverTimeOffset == null) {
        this._serverTimeOffset = skew;
      } else {
        this._serverTimeOffset = this._serverTimeOffset * 0.95 + skew * 0.05;
      }
    }
    const now = Date.now() + (this._serverTimeOffset || 0);

    // Track latest verified price across all frames
    if (snapshot.last_price && Number.isFinite(snapshot.last_price)) {
      this.lastKnownPrice = snapshot.last_price;
    } else if (snapshot.bid && Number.isFinite(snapshot.bid)) {
      this.lastKnownPrice = snapshot.bid;
    }

    // Maintain persistent merged order_book and 4-second rolling buffer
    if (snapshot.order_book) {
      if (!this._persistentOrderBook) this._persistentOrderBook = { bids: {}, asks: {} };
      if (snapshot.order_book.bids) Object.assign(this._persistentOrderBook.bids, snapshot.order_book.bids);
      if (snapshot.order_book.asks) Object.assign(this._persistentOrderBook.asks, snapshot.order_book.asks);
      this._depthHistoryBuffer.push({
        t: now,
        bids: { ...(snapshot.order_book.bids || {}) },
        asks: { ...(snapshot.order_book.asks || {}) }
      });
      while (this._depthHistoryBuffer.length > 1 && now - this._depthHistoryBuffer[0].t > 4000) {
        this._depthHistoryBuffer.shift();
      }
    }

    // Dynamic AUTO Contrast Sensitivity calculation
    if (this.bmContrastMode === 'AUTO' && snapshot.order_book) {
      const vols = [];
      for (const v of Object.values(snapshot.order_book.bids || {})) if (v > 1) vols.push(v);
      for (const v of Object.values(snapshot.order_book.asks || {})) if (v > 1) vols.push(v);
      if (vols.length > 5) {
        vols.sort((a, b) => a - b);
        const medIdx = Math.floor(vols.length * 0.65);
        this._autoMinCut = Math.max(18.0, Math.min(30.0, vols[medIdx] || 22.0));
      }
    }

    // World-Class Liquidity Sweeps & Voids Tracker
    if (this.bmShowSweeps !== false && snapshot.order_book) {
      this._detectLiquiditySweeps(snapshot, now);
    }

    /* ── Professional Bookmap Pro Stable Deadzone Tracking (Zero Jitter / Zero Kembang-Kecut) ── */
    const currentPrice = this.lastKnownPrice || snapshot.last_price || snapshot.bid || ((Number.isFinite(this.minPrice) && Number.isFinite(this.maxPrice)) ? (this.minPrice + this.maxPrice) / 2 : 3880.0);
    this.lastKnownPrice = currentPrice;
    this._currentPrice = currentPrice;
    const halfSpan = Math.max(2.5, this.bmHalfSpan || 4.5);

    // Ensure minPrice and maxPrice are valid finite numbers at all times
    if (!Number.isFinite(this.minPrice) || !Number.isFinite(this.maxPrice) || this.minPrice <= 0 || this.maxPrice <= this.minPrice) {
      this.minPrice = currentPrice - halfSpan;
      this.maxPrice = currentPrice + halfSpan;
    }

    if (this._isDragging) {
      const centerP = currentPrice + (this.priceOffset || 0);
      this.minPrice = centerP - halfSpan;
      this.maxPrice = centerP + halfSpan;
    } else {
      // 1. Maintain perfectly rock-solid vertical scale (eliminates jumpy kembang-kecut)
      const curCenter = (this.minPrice + this.maxPrice) / 2.0;
      const targetCenter = currentPrice + (this.priceOffset || 0);

      // 2. Deadzone buffer (40% of span): If price moves within central band, keep chart stationary like real Bookmap
      const deadzone = halfSpan * 0.40;
      const distFromCenter = targetCenter - curCenter;

      if (isNaN(this.minPrice) || isNaN(this.maxPrice) || this.minPrice <= 0 || Math.abs(distFromCenter) > (halfSpan * 2.5)) {
        // Direct snap if uninitialized or drifted too far
        this.minPrice = targetCenter - halfSpan;
        this.maxPrice = targetCenter + halfSpan;
      } else if (Math.abs(distFromCenter) > deadzone) {
        // Smooth, calm drift only when price reaches the outer edges of deadzone
        const driftAmount = (distFromCenter > 0) ? (distFromCenter - deadzone) : (distFromCenter + deadzone);
        const smoothRate = 0.08;
        const newCenter = curCenter + driftAmount * smoothRate;
        this.minPrice = newCenter - halfSpan;
        this.maxPrice = newCenter + halfSpan;
      } else {
        // Keep fixed span centered calmly
        this.minPrice = curCenter - halfSpan;
        this.maxPrice = curCenter + halfSpan;
      }
    }

    this._occupiedBadgeSlots = []; // Legacy fallback
    this._occupiedBadgeLanes = { LEFT: [], CENTER: [], RIGHT: [], PROJ: [] }; // 2D Lane anti-collision registry
    /* ── 1. Clear Canvas with Bookmap Obsidian Navy Background ── */
    ctx.fillStyle = '#050a14';
    ctx.fillRect(0, 0, this.width, this.height);

    /* ── 2. Ocean Sonar Depth Glow ── */
    const depthGlow = ctx.createLinearGradient(0, this.CHART_TOP, 0, this.CHART_BOTTOM);
    depthGlow.addColorStop(0, 'rgba(8, 26, 54, 0.35)');
    depthGlow.addColorStop(0.5, 'rgba(12, 36, 74, 0.45)');
    depthGlow.addColorStop(1, 'rgba(8, 26, 54, 0.35)');
    ctx.fillStyle = depthGlow;
    ctx.fillRect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);

    /* ── 3. Continuous Horizontal Liquidity Heatmap + Future Projection Zone ── */
    // Persistent rolling heatmap buffer across WebSocket updates
    if (!this._heatmapHistoryBuffer) this._heatmapHistoryBuffer = [];
    if (snapshot.heatmap && snapshot.heatmap.length) {
      const hmMap = new Map();
      for (const h of this._heatmapHistoryBuffer) hmMap.set(h.timestamp, h);
      for (const h of snapshot.heatmap) hmMap.set(h.timestamp, h);
      this._heatmapHistoryBuffer = Array.from(hmMap.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-1800);
    }
    // Deep 24/7 Historical Candle-to-Bookmap Reconstructor (Fills 100% of M1, M5, M15, M30, H1, H4 from CHART_LEFT to NOW_X even after hours offline!)
    const windowStartMs = now - (this.timeOffsetMs || 0) - (this.timeWindowMs || 180000);
    const srcCandles = (this._deepHistoricalCandles && this._deepHistoricalCandles.length > 20)
      ? this._deepHistoricalCandles
      : (snapshot.candles || []);

    let effectiveHeatmap = (this._heatmapHistoryBuffer && this._heatmapHistoryBuffer.length >= 2) 
      ? this._heatmapHistoryBuffer 
      : (snapshot.heatmap || []);

    const oldestHmTs = effectiveHeatmap.length > 0 ? effectiveHeatmap[0].timestamp : now;
    if (srcCandles.length > 2 && oldestHmTs > windowStartMs + 5000) {
      const synthHm = [];
      const barSpanSec = srcCandles.length >= 2 ? Math.max(60, srcCandles[1].time - srcCandles[0].time) : 60;
      for (const c of srcCandles) {
        const cStartMs = c.time * 1000;
        const cEndMs = cStartMs + barSpanSec * 1000;
        if (cEndMs < windowStartMs - 60000 || cStartMs >= oldestHmTs - 1500) continue;
        const steps = 3;
        for (let s = 0; s < steps; s++) {
          const sliceTs = Math.round(cStartMs + (s / steps) * barSpanSec * 1000);
          if (sliceTs >= oldestHmTs - 1000) break;
          const prog = s / steps;
          const midP = +(c.open + (c.close - c.open) * prog).toFixed(2);
          const bids = {};
          const asks = {};
          const baseLow = Math.floor((c.low - 1.5) * 2) / 2;
          const baseHigh = Math.ceil((c.high + 1.5) * 2) / 2;
          for (let lp = baseLow - 2.0; lp <= baseHigh + 2.0; lp += 0.50) {
            const pKey = lp.toFixed(2);
            const isRound = (Math.round(lp * 100) % 100 === 0);
            const wallV = isRound ? 54.0 : 28.0;
            if (lp <= midP - 0.10) bids[pKey] = wallV;
            else if (lp >= midP + 0.10) asks[pKey] = wallV;
          }
          if (c.poc) {
            const pocKey = (Math.round(c.poc * 10) / 10).toFixed(2);
            if (c.close >= c.open) bids[pocKey] = 72.0;
            else asks[pocKey] = 72.0;
          }
          synthHm.push({ timestamp: sliceTs, mid_price: midP, bids, asks });
        }
      }
      if (synthHm.length > 0) {
        effectiveHeatmap = [...synthHm, ...effectiveHeatmap];
      }
    }

    this._drawHeatmap(ctx, effectiveHeatmap, snapshot.order_book, now, snapshot.spoof_events || []);

    /* ── 3B. Persistent Rolling Trades Buffer across WebSocket Updates (Never wipe older trades!) ── */
    if (!this._tradesHistoryBuffer) this._tradesHistoryBuffer = [];
    if (snapshot.trades && snapshot.trades.length) {
      const trMap = new Map();
      for (const t of this._tradesHistoryBuffer) trMap.set(t.id != null ? t.id : `${t.timestamp}_${t.price}`, t);
      for (const t of snapshot.trades) trMap.set(t.id != null ? t.id : `${t.timestamp}_${t.price}`, t);
      const visibleHorizonMs = Math.max(1200000, (this.timeWindowMs || 180000) * 3.5);
      const pruneCutoff = now - visibleHorizonMs;
      this._tradesHistoryBuffer = Array.from(trMap.values())
        .filter(t => {
          const tMs = (t.timestamp && t.timestamp < 1e11) ? t.timestamp * 1000 : (t.timestamp || 0);
          return tMs >= pruneCutoff;
        })
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-3500);
    }

    // Reconstruct deep historical trade bubbles & price path from 24/7 server candles whenever windowStartMs is older than oldest live trade!
    const oldestTradeTs = this._tradesHistoryBuffer.length > 0 ? this._tradesHistoryBuffer[0].timestamp : now;
    if (srcCandles.length > 2 && oldestTradeTs > windowStartMs + 4000) {
      const candleTrades = [];
      const barSpanSec = srcCandles.length >= 2 ? Math.max(60, srcCandles[1].time - srcCandles[0].time) : 60;
      for (const c of srcCandles) {
        const cStartMs = c.time * 1000;
        const cEndMs = cStartMs + barSpanSec * 1000;
        if (cEndMs < windowStartMs - 60000 || cStartMs >= oldestTradeTs - 1200) continue;
        const isBull = c.close >= c.open;
        const pts = [
          { dt: 0.12, p: c.open, w: 0.22 },
          { dt: 0.38, p: isBull ? c.low : c.high, w: 0.26 },
          { dt: 0.66, p: c.poc || ((c.high + c.low) * 0.5), w: 0.32 },
          { dt: 0.90, p: c.close, w: 0.20 }
        ];
        const rawBarVol = Math.max(14.0, Math.min(180.0, (c.volume || 60.0) * 0.35));
        const bRatio = isBull ? 0.64 : 0.36;
        pts.forEach((pt, idx) => {
          const tMs = Math.round(cStartMs + pt.dt * barSpanSec * 1000);
          if (tMs >= oldestTradeTs - 800) return;
          const v = +(rawBarVol * pt.w).toFixed(1);
          const bv = +(v * (idx === 1 ? (isBull ? 0.75 : 0.25) : bRatio)).toFixed(1);
          const sv = +(v - bv).toFixed(1);
          candleTrades.push({
            id: `c_tr_${tMs}`,
            timestamp: tMs,
            price: +pt.p.toFixed(2),
            volume: v,
            buy_vol: bv,
            sell_vol: sv,
            side: bv >= sv ? 'buy' : 'sell',
            is_large: v >= 14.0
          });
        });
      }
      if (candleTrades.length > 0) {
        this._tradesHistoryBuffer = [...candleTrades, ...this._tradesHistoryBuffer];
      }
    }
    const effectiveTrades = (this._tradesHistoryBuffer && this._tradesHistoryBuffer.length > 0)
      ? this._tradesHistoryBuffer
      : (snapshot.trades || []);

    /* ── 4. Chart Gridlines & "NOW" Time Line Separator ── */
    try { this._drawGrid(ctx, now); } catch (e) { console.warn('[BM Grid]', e); }

    /* ── 5. Bottom Stacked Volume Histogram + Live CVD Curve Overlay ── */
    try { this._drawHistogram(ctx, effectiveTrades, now); } catch (e) { console.warn('[BM Histogram]', e); }

    /* ── 6. Best Bid & Best Ask Spread Channel + Stepped Price Line ── */
    try { this._drawSteppedPriceLine(ctx, effectiveTrades, now, currentPrice, snapshot.spread); } catch (e) { console.warn('[BM Price Line]', e); }

    /* ── 7. Bookmap Split 3D Spherical Bubbles + Whale Callout Labels ── */
    try { this._drawSplitBubbles(ctx, effectiveTrades, now); } catch (e) { console.warn('[BM Bubbles]', e); }

    /* ── 8. Buyer & Seller Volume Zones ── */
    if (this.showVolumeZones) {
      try { this._drawVolumeZones(ctx, effectiveTrades, currentPrice); } catch (e) { console.warn('[BM Volume Zones]', e); }
    }

    /* ── 8B. Session VWAP & StdDev Bands ── */
    if (this.showVWAP && snapshot.vwap && snapshot.vwap.value > 0) {
      try { this._drawVWAP(ctx, snapshot.vwap); } catch (e) { console.warn('[BM VWAP]', e); }
    }

    /* ── 8C. Active Positions & Visual SL / TP on Chart ── */
    if (this.showPositions && snapshot.positions && snapshot.positions.length > 0) {
      try { this._drawPositionsOnChart(ctx, snapshot.positions, currentPrice); } catch (e) { console.warn('[BM Positions]', e); }
    }

    /* ── 8D. CVD Divergence Alert Banner ── */
    if (snapshot.divergence) {
      try { this._drawDivergenceAlert(ctx, snapshot.divergence); } catch (e) { console.warn('[BM Divergence]', e); }
    }

    /* ── 8E. Trapped Traders (Buyers / Sellers) Badges ── */
    if (snapshot.trapped_traders && snapshot.trapped_traders.length > 0) {
      try { this._drawTrappedTraders(ctx, snapshot.trapped_traders); } catch (e) { console.warn('[BM Trapped]', e); }
    }

    /* ── 8F. Prop-Firm Asian / London / NY Session High-Low, PDH/PDL & Sweep Markers ── */
    if (this.showSessionLevels && snapshot.sessions) {
      try { this._drawSessionLevels(ctx, snapshot.sessions); } catch (e) { console.warn('[BM Sessions]', e); }
    }

    /* ── 8G. Composite Session Volume Profile (SVP: dPOC, VAH/VAL 70%, LVN) ── */
    if (this.showSVP && snapshot.session_vp) {
      try { this._drawSessionVolumeProfile(ctx, snapshot.session_vp); } catch (e) { console.warn('[BM SVP]', e); }
    }

    /* ── 8H. Real-Time Institutional Iceberg & Absorption Detector ── */
    if (this.showIcebergs && snapshot.icebergs && snapshot.icebergs.length > 0) {
      try { this._drawIcebergOrders(ctx, snapshot.icebergs); } catch (e) { console.warn('[BM Icebergs]', e); }
    }

    /* ── 8H2. DDBTC 4 Sifat SNR Valid Auto-Marking Zones ── */
    if (snapshot.snr_valid_zones && snapshot.snr_valid_zones.length > 0) {
      try { this._drawSnrValidZones(ctx, snapshot.snr_valid_zones); } catch (e) { console.warn('[BM SNR Valid Zones]', e); }
    }

    /* ── 8I. Real-Time Institutional Order Flow Buy/Sell Signals (Strict Location-First) ── */
    if (this.bmShowSignals !== false) {
      try { this._drawOrderFlowSignals(ctx, snapshot, now, currentPrice); } catch (e) { console.warn('[BM Signals]', e); }
    }

    /* ── 8J. Real-Time Sudden Whale Placement Radar & Sonar Alert System ── */
    if (this.whaleRadarEnabled !== false) {
      try {
        this._detectSuddenWhalePlacements(snapshot, now);
        this._drawWhaleRadarPings(ctx, now);
        this._drawWhaleRadarBanner(ctx, now);
      } catch (e) { console.warn('[BM Whale Radar]', e); }
    }

    /* ── 9. Current Price Crosshair & Interactive Cursor Depth Inspector ── */
    try { this._drawCurrentPriceLine(ctx, currentPrice, snapshot.order_book, now); } catch (e) { console.warn('[BM Crosshair]', e); }

    /* ── 10. Left Price Scale & Ticks (GUARANTEED FAIL-SAFE ISOLATION) ── */
    try {
      this._drawPriceAxis(ctx);
    } catch (e) {
      console.error('[Bookmap Left Axis Fatal Error]', e);
    }

    /* ── 11. Right High-Resolution COB (Current Order Book + Pulling/Stacking) (GUARANTEED FAIL-SAFE ISOLATION) ── */
    try {
      this._drawCOB(ctx, this._persistentOrderBook || snapshot.order_book, currentPrice, snapshot.bid, snapshot.ask);
    } catch (e) {
      console.error('[Bookmap Right COB Fatal Error]', e);
    }

    /* ── 12. Interactive Manual Drawing Tools Overlay (Ray & Trend) ── */
    try { this._drawManualDrawings(ctx); } catch (e) {}

    /* ── 12B. World-Class Order Flow Measurement Ruler Tool ── */
    try { this._drawOrderFlowRuler(ctx); } catch (e) {}

    /* ── 13. Interactive Top Bookmap Pro HUD Header ── */
    try { this._drawTopHUD(ctx, snapshot); } catch (e) {}

    /* ── 13B. Floating Quick Zoom & Center Capsule (🎯 PUSAT | ➕ | ➖) ── */
    try { this._drawMobileToolbar(ctx); } catch (e) {}

    /* ── 14. Interactive Tooltip ── */
    try { this._renderTooltip(); } catch (e) {}
  }

  _drawMobileToolbar(ctx) {
    if (!this.width) return;
    ctx.save();
    this.mobileHitboxes = [];

    const barW = 186;
    const barH = 28;
    const bx = Math.floor((this.CHART_LEFT + this.NOW_X - barW) / 2);
    const by = this.CHART_BOTTOM - barH - 8;

    ctx.fillStyle = 'rgba(10, 16, 30, 0.90)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, barW, barH, 14) : ctx.rect(bx, by, barW, barH);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    const btn1W = 74;
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎯 PUSAT', bx + btn1W / 2 + 4, by + barH / 2);

    this.mobileHitboxes.push({
      x: bx, y: by, w: btn1W + 5, h: barH,
      action: () => {
        this.resetZoom();
        if (window.orderFlowApp && window.orderFlowApp.showToast) {
          window.orderFlowApp.showToast('🎯 Bookmap Dipusatkan Semula');
        }
      }
    });

    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(bx + btn1W + 8, by + 4);
    ctx.lineTo(bx + btn1W + 8, by + barH - 4);
    ctx.stroke();

    const btn2X = bx + btn1W + 10;
    const btn2W = 46;
    ctx.fillStyle = '#00e676';
    ctx.fillText('➕', btn2X + btn2W / 2, by + barH / 2);

    this.mobileHitboxes.push({
      x: btn2X, y: by, w: btn2W, h: barH,
      action: () => { this.zoomIn(); }
    });

    ctx.beginPath();
    ctx.moveTo(btn2X + btn2W, by + 4);
    ctx.lineTo(btn2X + btn2W, by + barH - 4);
    ctx.stroke();

    const btn3X = btn2X + btn2W + 2;
    const btn3W = 46;
    ctx.fillStyle = '#ff6b8b';
    ctx.fillText('➖', btn3X + btn3W / 2, by + barH / 2);

    this.mobileHitboxes.push({
      x: btn3X, y: by, w: btn3W, h: barH,
      action: () => { this.zoomOut(); }
    });

    ctx.restore();
  }

  /* ─── Grid Lines, Time Markers & "NOW" Line Divider ────────────── */
  _drawGrid(ctx, now) {
    ctx.save();
    const step = 0.50;
    const startP = Math.floor(this.minPrice / step) * step;

    for (let p = startP; p <= this.maxPrice + step; p += step) {
      const y = this.priceToY(p);
      if (y < this.CHART_TOP || y > this.CHART_BOTTOM) continue;

      const isWholeDollar = Math.abs(Math.round(p) - p) < 0.01;
      ctx.strokeStyle = isWholeDollar ? 'rgba(45, 78, 120, 0.42)' : 'rgba(22, 40, 68, 0.26)';
      ctx.lineWidth   = isWholeDollar ? 1.0 : 0.6;

      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, y);
      ctx.lineTo(this.CHART_RIGHT, y);
      ctx.stroke();
    }

    const cols = 5;
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;

    for (let i = 1; i <= cols; i++) {
      const x = this.CHART_LEFT + (i / cols) * this.HIST_TIME_W;
      ctx.beginPath();
      ctx.moveTo(x, this.CHART_TOP);
      ctx.lineTo(x, this.CHART_BOTTOM);
      ctx.stroke();

      ctx.setLineDash([]);
      const effectiveNow = now - (this.timeOffsetMs || 0);
      const timeAtCol = new Date(effectiveNow - this.timeWindowMs + (i / cols) * this.timeWindowMs);
      const isLiveNow = i === cols && Math.abs(this.timeOffsetMs || 0) < 1000;
      const timeColStr = timeAtCol.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      ctx.fillStyle  = isLiveNow ? '#00f0ff' : '#4a6b94';
      ctx.font       = isLiveNow ? 'bold 9px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(isLiveNow ? '⚡ NOW' : timeColStr, x, this.CHART_BOTTOM - 4);
      ctx.setLineDash([3, 6]);
    }

    // Draw Authentic Bookmap X-Ray Crisp White Vertical Timeline (Separating Historical Depth vs Current Order Book Projection)
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(this.NOW_X, this.CHART_TOP);
    ctx.lineTo(this.NOW_X, this.CHART_BOTTOM);
    ctx.stroke();

    // Top label inside Live Resting Projection Zone
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('⚡ NOW • LIVE DEPTH →', (this.NOW_X + this.CHART_RIGHT) / 2, this.CHART_TOP + 11);

    ctx.strokeStyle = '#1b2d48';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(this.CHART_LEFT, this.CHART_BOTTOM);
    ctx.lineTo(this.CHART_RIGHT, this.CHART_BOTTOM);
    ctx.stroke();
    ctx.restore();
  }

  /* ─── Continuous Horizontal Liquidity Heatmap + Live Book Projection ─ */
  _drawHeatmap(ctx, history, currentOrderBook, now, spoofEvents = []) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    const PRICE_STEP = 0.10;
    const pxPerStep  = Math.max(2.4, Math.abs(this.priceToY(0) - this.priceToY(PRICE_STEP)));
    const drawH = Math.max(2.4, pxPerStep * 0.96);

    // 1. Historical Heatmap (CHART_LEFT -> NOW_X) with Authentic MBO Consumption Caps
    if (history && history.length >= 2) {
      for (let i = 0; i < history.length; i++) {
        const snap     = history[i];
        const nextSnap = history[i + 1];

        const x1 = this.timeToX(snap.timestamp, now);
        const x2 = nextSnap ? this.timeToX(nextSnap.timestamp, now) : this.NOW_X;

        if (x2 < this.CHART_LEFT || x1 > this.NOW_X) continue;

        const drawX = Math.max(this.CHART_LEFT, x1);
        const drawW = Math.max(2.2, Math.min(this.NOW_X, x2) - drawX + 0.9);
        const nextBids = (nextSnap && nextSnap.bids) || null;
        const nextAsks = (nextSnap && nextSnap.asks) || null;

        const bids = snap.bids || {};
        for (const priceKey of Object.keys(bids)) {
          const vol = bids[priceKey];
          const color = this.getThermalColor(vol);
          if (!color) continue;
          const price = +priceKey;
          const y     = this.priceToY(price);
          if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
          ctx.fillStyle = color;
          ctx.fillRect(drawX, y - drawH * 0.5, drawW, drawH);

          // Bookmap MBO Bright Cap when resting wall gets consumed/eaten by price
          if (vol >= 38.0 && nextBids) {
            const nextV = nextBids[priceKey] || 0;
            if (nextV < vol * 0.52) {
              const capW = Math.min(3.0, Math.max(1.2, drawW * 0.4));
              ctx.fillStyle = 'rgba(255, 255, 255, 0.50)';
              ctx.fillRect(drawX + drawW - capW, y - drawH * 0.5, capW, drawH);
            }
          }
        }

        const asks = snap.asks || {};
        for (const priceKey of Object.keys(asks)) {
          const vol = asks[priceKey];
          const color = this.getThermalColor(vol);
          if (!color) continue;
          const price = +priceKey;
          const y     = this.priceToY(price);
          if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
          ctx.fillStyle = color;
          ctx.fillRect(drawX, y - drawH * 0.5, drawW, drawH);

          // Bookmap MBO Bright Cap when resting wall gets consumed/eaten by price
          if (vol >= 38.0 && nextAsks) {
            const nextV = nextAsks[priceKey] || 0;
            if (nextV < vol * 0.52) {
              const capW = Math.min(3.0, Math.max(1.2, drawW * 0.4));
              ctx.fillStyle = 'rgba(255, 255, 255, 0.50)';
              ctx.fillRect(drawX + drawW - capW, y - drawH * 0.5, capW, drawH);
            }
          }
        }
      }
    }

    // 2. Live Resting Order Book Projection Zone (NOW_X -> CHART_RIGHT)
    if (currentOrderBook) {
      const projX = this.NOW_X;
      const projW = this.CHART_RIGHT - this.NOW_X;
      const bids = currentOrderBook.bids || {};
      const asks = currentOrderBook.asks || {};

      let topAskWall = { p: 0, v: 0 };
      let topBidWall = { p: 0, v: 0 };

      for (const [pKey, vol] of Object.entries(bids)) {
        const price = +pKey;
        const y = this.priceToY(price);
        if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
        if (vol > topBidWall.v) topBidWall = { p: price, v: vol };
        const color = this.getThermalColor(vol);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(projX, y - drawH * 0.5, projW, drawH);
      }

      for (const [pKey, vol] of Object.entries(asks)) {
        const price = +pKey;
        const y = this.priceToY(price);
        if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
        if (vol > topAskWall.v) topAskWall = { p: price, v: vol };
        const color = this.getThermalColor(vol);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(projX, y - drawH * 0.5, projW, drawH);
      }

      // Highlight Top Institutional Shark/Jerung Limit Walls cleanly in the Live Projection Zone
      if (this.bmShowSharkWalls !== false) {
        const pickTopWalls = (bookDict, minVol, maxCount) => {
          const candidates = [];
          for (const [pKey, v] of Object.entries(bookDict)) {
            const p = +pKey;
            const wy = this.priceToY(p);
            if (wy < this.CHART_TOP + 18 || wy > this.CHART_BOTTOM - 18) continue;
            if (v >= minVol) candidates.push({ p, v, wy });
          }
          candidates.sort((a, b) => b.v - a.v);
          const selected = [];
          for (const cand of candidates) {
            if (selected.every(s => Math.abs(s.wy - cand.wy) >= 22)) {
              selected.push(cand);
              if (selected.length >= maxCount) break;
            }
          }
          return selected;
        };

        // Section A: Track Liquidity Age, Size Delta, Touched vs Traded, and Disappeared/Pulled Walls
        if (!this._liqStateMap) this._liqStateMap = {};
        if (!this._pulledGhostWalls) this._pulledGhostWalls = [];
        const curLiveP = this._currentPrice || 0;

        const updateLiqMeta = (p, v, isAsk) => {
          const key = p.toFixed(2);
          let st = this._liqStateMap[key];
          if (!st) {
            st = { firstSeen: now, startVol: v, prevVol: v, maxVol: v, touched: false, tradedVol: 0, lastSeen: now, isAsk };
            this._liqStateMap[key] = st;
          } else {
            st.lastSeen = now;
            if (v > st.maxVol) st.maxVol = v;
          }
          if (curLiveP > 0 && Math.abs(curLiveP - p) <= 0.15) {
            st.touched = true;
          }
          const deltaV = Math.round(v - st.startVol);
          st.prevVol = v;
          const ageSec = Math.max(1, Math.round((now - st.firstSeen) / 1000));
          const ageStr = ageSec >= 60 ? `${Math.floor(ageSec / 60)}m` : `${ageSec}s`;
          const deltaStr = deltaV > 0 ? `+${deltaV}L` : (deltaV < 0 ? `${deltaV}L` : '0L');
          const touchState = st.touched ? 'DIUJI' : 'AKTIF';
          return { ageStr, deltaStr, touchState, deltaV };
        };

        // Check for walls that suddenly disappeared/pulled before price reached them
        for (const [k, st] of Object.entries(this._liqStateMap)) {
          const p = +k;
          const curBookV = (asks[k] || bids[k] || 0);
          if (st.maxVol >= 62 && curBookV < 20 && (now - st.lastSeen < 4000)) {
            const wasTouched = curLiveP > 0 && Math.abs(curLiveP - p) <= 0.25;
            if (!wasTouched && !this._pulledGhostWalls.some(g => Math.abs(g.p - p) < 0.30)) {
              this._pulledGhostWalls.push({ p, dropped: Math.round(st.maxVol - curBookV), time: now, isAsk: st.isAsk });
            }
            delete this._liqStateMap[k];
          } else if (now - st.lastSeen > 60000) {
            delete this._liqStateMap[k];
          }
        }
        this._pulledGhostWalls = this._pulledGhostWalls.filter(g => now - g.time < 9000).slice(-1);

        if (!this._lastWallPickTs || (now - this._lastWallPickTs >= 1800) || !this._cachedTopAskWalls || !this._cachedTopBidWalls) {
          this._cachedTopAskWalls = pickTopWalls(asks, 60, 2);
          this._cachedTopBidWalls = pickTopWalls(bids, 60, 2);
          this._lastWallPickTs = now;
        } else {
          for (const w of this._cachedTopAskWalls) w.wy = this.priceToY(w.p);
          for (const w of this._cachedTopBidWalls) w.wy = this.priceToY(w.p);
        }
        const topAskWalls = this._cachedTopAskWalls;
        const topBidWalls = this._cachedTopBidWalls;

        const drawSharkWallOverlay = (wall, isAsk, rankIdx) => {
          const wy = wall.wy;
          const meta = updateLiqMeta(wall.p, wall.v, isAsk);
          const isMega = wall.v >= 90;
          const col = isAsk ? (isMega ? '#ff2a55' : '#fb923c') : (isMega ? '#00f59b' : '#facc15');
          const glowBg = isAsk ? 'rgba(255, 42, 85, 0.14)' : 'rgba(0, 245, 155, 0.14)';

          // 1. Confine Active Liquidity Guide Line cleanly to Projection Zone + short lead-in (Zero historical clutter)
          const leadInX = Math.max(this.CHART_LEFT, projX - 36);
          ctx.fillStyle = glowBg;
          ctx.fillRect(projX, wy - drawH * 0.55, projW, drawH * 1.1);

          ctx.save();
          ctx.setLineDash(meta.touchState === 'DIUJI' ? [] : [4, 3]);
          ctx.strokeStyle = col;
          ctx.lineWidth = isMega ? 1.4 : 1.0;
          ctx.beginPath();
          ctx.moveTo(leadInX, wy);
          ctx.lineTo(this.CHART_RIGHT, wy);
          ctx.stroke();
          ctx.restore();

          // 2. Large Activity Wall Tag inside Projection Zone with Anti-Collision Slotting
          if (rankIdx < 2) {
            const fullTxt = `📊 ${Math.round(wall.v)}L (${meta.deltaStr}•${meta.ageStr}•${meta.touchState})`;
            const shortTxt = `📊 ${Math.round(wall.v)}L ${meta.ageStr}`;
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const fullW = ctx.measureText(fullTxt).width + 8;
            const useFull = (projW >= fullW + 4);
            const pTxt = useFull ? fullTxt : shortTxt;
            const ptw = Math.min(projW - 4, ctx.measureText(pTxt).width + 8);
            const tagY = this._resolveNonOverlappingY(wy, 14, 16, 'PROJ');

            ctx.fillStyle = isAsk ? 'rgba(28, 6, 14, 0.92)' : 'rgba(4, 24, 16, 0.92)';
            ctx.fillRect(projX + 3, tagY - 7, ptw, 14);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.strokeRect(projX + 3, tagY - 7, ptw, 14);
            ctx.fillStyle = col;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(pTxt, projX + 6, tagY);
          }
        };

        topAskWalls.forEach((w, idx) => drawSharkWallOverlay(w, true, idx));
        topBidWalls.forEach((w, idx) => drawSharkWallOverlay(w, false, idx));

        // 2B. Render Ghost Indicator for Disappeared/Pulled Liquidity inside PROJ lane (Right of NOW_X, zero bubble overlap)
        for (const gw of this._pulledGhostWalls) {
          const gy = this.priceToY(gw.p);
          if (gy >= this.CHART_TOP + 18 && gy <= this.CHART_BOTTOM - 18) {
            ctx.save();
            ctx.setLineDash([3, 5]);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(Math.max(this.CHART_LEFT, this.NOW_X - 90), gy);
            ctx.lineTo(this.CHART_RIGHT, gy);
            ctx.stroke();

            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const gTxt = `👻 HILANG -${gw.dropped}L`;
            const maxProjW = Math.max(40, this.CHART_RIGHT - this.NOW_X - 6);
            const gtw = Math.min(maxProjW, ctx.measureText(gTxt).width + 8);
            const resolvedGy = this._resolveNonOverlappingY(gy, 14, 16, 'PROJ');
            const gx = this.NOW_X + 3;
            const gby = resolvedGy - 7;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
            ctx.fillRect(gx, gby, gtw, 14);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.70)';
            ctx.lineWidth = 0.9;
            ctx.strokeRect(gx, gby, gtw, 14);
            ctx.fillStyle = '#cbd5e1';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(gTxt, gx + 4, resolvedGy);
            ctx.restore();
          }
        }
      }

      // 3. Spoofing Pulling & Stacking Detection Badges on Heatmap (Max 1 Active to Prevent Clutter)
      if (spoofEvents && spoofEvents.length > 0) {
        const freshSpoofs = spoofEvents.filter(sp => now - sp.timestamp <= 12000).slice(-1);
        for (const sp of freshSpoofs) {
          const sy = this.priceToY(sp.price);
          if (sy < this.CHART_TOP + 18 || sy > this.CHART_BOTTOM - 18) continue;

          const isPull = sp.type === 'PULLING';
          const col = isPull ? '#f43f5e' : '#00f0ff';
          const bgCol = isPull ? 'rgba(38, 8, 16, 0.94)' : 'rgba(4, 28, 38, 0.94)';

          // Subtle localized laser dashed line
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = isPull ? 'rgba(244, 63, 94, 0.55)' : 'rgba(0, 240, 255, 0.55)';
          ctx.lineWidth = 1.0;
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, sy);
          ctx.lineTo(this.NOW_X, sy);
          ctx.stroke();
          ctx.restore();

          // Badge pill registered in LEFT lane
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(sp.badge).width + 12;
          const bx = this.CHART_LEFT + 8;
          const resolvedSy = this._resolveNonOverlappingY(sy, 15, 19, 'LEFT');
          const by = resolvedSy - 7.5;

          ctx.fillStyle = bgCol;
          ctx.fillRect(bx, by, tw, 15);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.0;
          ctx.strokeRect(bx, by, tw, 15);
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(sp.badge, bx + 6, resolvedSy);
        }
      }

      // 4. World-Class Liquidity Sweeps & Voids Visualizer (Max 1 Most Significant Sweep Active)
      if (this.bmShowSweeps !== false && this._bmSweepEvents && this._bmSweepEvents.length > 0) {
        const activeSweeps = this._bmSweepEvents.filter(sw => now - sw.time <= 35000).slice(-1);
        for (const sw of activeSweeps) {
          const wy = this.priceToY(sw.price);
          if (wy < this.CHART_TOP + 18 || wy > this.CHART_BOTTOM - 18) continue;

          const isBuySweep = sw.bias === 'BUY_SWEEP';
          const col = isBuySweep ? '#00f0ff' : '#ff0055';
          const bgCol = isBuySweep ? 'rgba(0, 32, 45, 0.94)' : 'rgba(45, 0, 16, 0.94)';

          // Sleek sweep ray
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = isBuySweep ? 'rgba(0, 240, 255, 0.60)' : 'rgba(255, 0, 85, 0.60)';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, wy);
          ctx.lineTo(this.NOW_X, wy);
          ctx.stroke();
          ctx.restore();

          // High-Impact Pill Badge with LEFT Lane Anti-Collision Slotting
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const badgeTxt = sw.badge;
          const tw = ctx.measureText(badgeTxt).width + 12;
          const bx = this.CHART_LEFT + 8;
          const resolvedSweepY = this._resolveNonOverlappingY(wy, 15, 19, 'LEFT');
          const by = resolvedSweepY - 7.5;

          ctx.fillStyle = bgCol;
          ctx.fillRect(bx, by, tw, 15);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.1;
          ctx.strokeRect(bx, by, tw, 15);
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeTxt, bx + 6, resolvedSweepY);
        }
      }
    }

    ctx.restore();
  }

  /* ─── Institutional Liquidity Sweeps & Voids Detector ───────────── */
  _detectLiquiditySweeps(snapshot, now) {
    if (!this._bmSweepEvents) this._bmSweepEvents = [];
    if (!this._prevDepthSnapshot) {
      this._prevDepthSnapshot = {
        t: now,
        bids: { ...(snapshot.order_book.bids || {}) },
        asks: { ...(snapshot.order_book.asks || {}) }
      };
      return;
    }

    // Every ~1.5 seconds, compare resting walls from previous snapshot
    if (now - this._prevDepthSnapshot.t >= 1500) {
      const oldBids = this._prevDepthSnapshot.bids;
      const oldAsks = this._prevDepthSnapshot.asks;
      const curBids = snapshot.order_book.bids || {};
      const curAsks = snapshot.order_book.asks || {};
      const curP = snapshot.last_price || snapshot.bid || 0;

      // Check Asks swept (Aggressive buyers broke through resistance wall)
      for (const [pStr, oldV] of Object.entries(oldAsks)) {
        if (oldV >= 26.0) {
          const p = +pStr;
          const curV = curAsks[pStr] || 0;
          if (curV <= oldV * 0.22 && curP >= p - 0.15) {
            const existingSweep = this._bmSweepEvents.find(sw => Math.abs(sw.price - p) <= 0.80 && now - sw.time < 35000);
            if (existingSweep) {
              existingSweep.time = now;
              if (oldV >= existingSweep.vol) {
                existingSweep.price = p;
                existingSweep.vol = oldV;
                existingSweep.badge = `⚡ SWEEP & VOID $${p.toFixed(2)} (${oldV.toFixed(0)}L)`;
              }
            } else {
              this._bmSweepEvents.push({
                id: 'sw_' + now + '_' + p,
                price: p,
                time: now,
                vol: oldV,
                bias: 'BUY_SWEEP',
                badge: `⚡ SWEEP & VOID $${p.toFixed(2)} (${oldV.toFixed(0)}L)`
              });
            }
          }
        }
      }

      // Check Bids swept (Aggressive sellers broke through support wall)
      for (const [pStr, oldV] of Object.entries(oldBids)) {
        if (oldV >= 26.0) {
          const p = +pStr;
          const curV = curBids[pStr] || 0;
          if (curV <= oldV * 0.22 && curP <= p + 0.15) {
            const existingSweep = this._bmSweepEvents.find(sw => Math.abs(sw.price - p) <= 0.80 && now - sw.time < 35000);
            if (existingSweep) {
              existingSweep.time = now;
              if (oldV >= existingSweep.vol) {
                existingSweep.price = p;
                existingSweep.vol = oldV;
                existingSweep.badge = `⚡ SWEEP & VOID $${p.toFixed(2)} (${oldV.toFixed(0)}L)`;
              }
            } else {
              this._bmSweepEvents.push({
                id: 'sw_' + now + '_' + p,
                price: p,
                time: now,
                vol: oldV,
                bias: 'SELL_SWEEP',
                badge: `⚡ SWEEP & VOID $${p.toFixed(2)} (${oldV.toFixed(0)}L)`
              });
            }
          }
        }
      }

      this._bmSweepEvents = this._bmSweepEvents.filter(sw => now - sw.time < 45000).slice(-2);
      this._prevDepthSnapshot = {
        t: now,
        bids: { ...(snapshot.order_book.bids || {}) },
        asks: { ...(snapshot.order_book.asks || {}) }
      };
    }
  }

  /* ─── Bottom Stacked Volume Histogram + Live CVD Curve ─────────── */
  _drawHistogram(ctx, trades, now) {
    if (!trades || !trades.length) return;
    ctx.save();
    const histTop = this.CHART_BOTTOM + 2;
    const histMaxH = this.HIST_HEIGHT - 6;
    const colW    = 7;
    const buckets = {};

    for (const t of trades) {
      const bx = Math.floor(this.timeToX(t.timestamp, now) / colW) * colW;
      if (bx < this.CHART_LEFT || bx > this.NOW_X) continue;

      if (!buckets[bx]) buckets[bx] = { buy: 0, sell: 0, delta: 0 };
      const buyV  = t.buy_vol  !== undefined ? t.buy_vol  : (t.side === 'buy' ? t.volume : 0);
      const sellV = t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0);

      buckets[bx].buy  += buyV;
      buckets[bx].sell += sellV;
      buckets[bx].delta += (buyV - sellV);
    }

    let maxTotal = 1;
    for (const b of Object.values(buckets)) maxTotal = Math.max(maxTotal, b.buy + b.sell);
    maxTotal = Math.max(maxTotal, 16);

    const sortedX = Object.keys(buckets).map(Number).sort((a, b) => a - b);

    for (const x of sortedX) {
      const b     = buckets[x];
      const total = b.buy + b.sell;
      const barH  = Math.max(2, (total / maxTotal) * (histMaxH - 6));

      const buyRatio = total > 0 ? b.buy / total : 0.5;
      const buyH     = Math.round(barH * buyRatio);
      const sellH    = barH - buyH;

      if (sellH > 0) {
        ctx.fillStyle = 'rgba(235, 50, 75, 0.82)';
        ctx.fillRect(x, histTop + (histMaxH - barH), colW - 1, sellH);
      }
      if (buyH > 0) {
        ctx.fillStyle = 'rgba(0, 230, 118, 0.82)';
        ctx.fillRect(x, histTop + (histMaxH - barH) + sellH, colW - 1, buyH);
      }
    }

    // Overlay Live Cumulative Volume Delta (CVD) Sparkline Curve inside Histogram Strip
    if (this.bmShowCvdCurve && sortedX.length > 2) {
      let runningCvd = 0;
      let minC = 0, maxC = 0;
      const cvdPts = [];
      for (const x of sortedX) {
        runningCvd += buckets[x].delta;
        if (runningCvd < minC) minC = runningCvd;
        if (runningCvd > maxC) maxC = runningCvd;
        cvdPts.push({ x: x + colW / 2, v: runningCvd });
      }
      const rangeC = Math.max(1, maxC - minC);
      const lastDelta = cvdPts[cvdPts.length - 1].v;
      ctx.strokeStyle = lastDelta >= 0 ? '#00f0ff' : '#ff4d6d';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < cvdPts.length; i++) {
        const py = (histTop + histMaxH - 3) - ((cvdPts[i].v - minC) / rangeC) * (histMaxH - 8);
        if (i === 0) ctx.moveTo(cvdPts[i].x, py);
        else ctx.lineTo(cvdPts[i].x, py);
      }
      ctx.stroke();

      // Label in bottom projection zone
      ctx.fillStyle = lastDelta >= 0 ? '#00f0ff' : '#ff4d6d';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`CVD Win: ${lastDelta >= 0 ? '+' : ''}${lastDelta.toFixed(1)}L`, this.NOW_X + 6, histTop + 18);
    }

    ctx.restore();
  }

  /* ─── Best Bid & Best Ask Channel + Orthogonal Stepped Price Line ─ */
  _drawSteppedPriceLine(ctx, trades, now, currentPrice, currentSpread) {
    if (!trades || trades.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    const halfSpread = Math.max(0.12, (currentSpread || 0.30) * 0.5);

    // 1. Authentic Bookmap X-Ray Dual Best Ask (Red) & Best Bid (Green) Stepped Lines
    if (this.bmShowBidAskChannel) {
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'square';
      for (let i = 0; i < trades.length - 1; i++) {
        const t1 = trades[i];
        const t2 = trades[i + 1];
        const x1 = this.timeToX(t1.timestamp, now);
        const x2 = Math.min(this.NOW_X, this.timeToX(t2.timestamp, now));
        if (x2 < this.CHART_LEFT - 10 || x1 > this.NOW_X + 2) continue;

        const askY1 = this.priceToY(t1.price + halfSpread);
        const askY2 = this.priceToY(t2.price + halfSpread);
        const bidY1 = this.priceToY(t1.price - halfSpread);
        const bidY2 = this.priceToY(t2.price - halfSpread);

        // Best Ask Stepped Line (Crisp Bookmap Red)
        ctx.strokeStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(x1, askY1);
        ctx.lineTo(x2, askY1);
        ctx.lineTo(x2, askY2);
        ctx.stroke();

        // Best Bid Stepped Line (Crisp Bookmap Green)
        ctx.strokeStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(x1, bidY1);
        ctx.lineTo(x2, bidY1);
        ctx.lineTo(x2, bidY2);
        ctx.stroke();
      }

      // Connect last trade to NOW_X and project Dashed Current Best Bid & Ask across Projection Zone to CHART_RIGHT!
      if (trades.length > 0 && currentPrice) {
        const lastT = trades[trades.length - 1];
        const lx = Math.min(this.NOW_X, this.timeToX(lastT.timestamp, now));
        const curAskY = this.priceToY(currentPrice + halfSpread);
        const curBidY = this.priceToY(currentPrice - halfSpread);
        const lastAskY = this.priceToY(lastT.price + halfSpread);
        const lastBidY = this.priceToY(lastT.price - halfSpread);

        ctx.strokeStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(lx, lastAskY);
        ctx.lineTo(this.NOW_X, lastAskY);
        ctx.lineTo(this.NOW_X, curAskY);
        ctx.stroke();

        ctx.strokeStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(lx, lastBidY);
        ctx.lineTo(this.NOW_X, lastBidY);
        ctx.lineTo(this.NOW_X, curBidY);
        ctx.stroke();

        // Dashed Current Best Ask (Red) & Best Bid (Green) in Projection Zone (NOW_X -> CHART_RIGHT)
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1.5;

        ctx.strokeStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(this.NOW_X, curAskY);
        ctx.lineTo(this.CHART_RIGHT, curAskY);
        ctx.stroke();

        ctx.strokeStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(this.NOW_X, curBidY);
        ctx.lineTo(this.CHART_RIGHT, curBidY);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // Fallback Single Center Stepped Price Line
      ctx.lineWidth = 1.8;
      for (let i = 0; i < trades.length - 1; i++) {
        const t1 = trades[i];
        const t2 = trades[i + 1];
        const x1 = this.timeToX(t1.timestamp, now);
        const x2 = this.timeToX(t2.timestamp, now);
        if (x2 < this.CHART_LEFT - 10 || x1 > this.NOW_X + 10) continue;
        const y1 = this.priceToY(t1.price);
        const y2 = this.priceToY(t2.price);
        ctx.strokeStyle = t2.price >= t1.price ? '#22c55e' : '#ef4444';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ─── Split 3D Spherical Bubbles with Whale Sound & Smart Filter ─ */
  _drawSplitBubbles(ctx, trades, now) {
    if (!trades || !trades.length) return;
    
    // 1. Direct tier category check
    const cat = this.bmBubbleCategory || 'noise';
    if (cat === 'off') return; // User turned off bubbles

    let minVol = 0.0;
    if (cat === 'mega') minVol = 80.0;
    else if (cat === 'major') minVol = 35.0;
    else if (cat === 'normal') minVol = 12.0;
    else minVol = 0.0; // noise: show all trades

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    this.hoverTrade = null;
    const drawnWhaleBadges = [];

    // 2. Bookmap True Institutional Node Aggregator (with Anti-Inflation & 2D Spatial De-Crowding):
    // Merges executions along the stepped price line without inflating normal retail ticks into fake Mega Sharks
    const timeSorted = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const aggregated = [];
    let cur = null;
    const isHtfView = (this.timeWindowMs || 180000) >= 1200000; // M15, M30, H1, H4
    const minPixelGap = isHtfView ? 38 : 28;
    const maxPriceCluster = isHtfView ? 0.55 : 0.22;

    for (const t of timeSorted) {
      const tMs = (t.timestamp && t.timestamp < 1e11) ? t.timestamp * 1000 : (t.timestamp || 0);
      const buyV  = t.buy_vol  !== undefined ? t.buy_vol  : (t.side === 'buy' ? t.volume : 0);
      const sellV = t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0);
      const tVol  = Math.max(0.1, buyV + sellV);
      const curX = this.timeToX(tMs, now);

      if (cur) {
        const prevX = this.timeToX(cur.timestamp, now);
        const pDiff = Math.abs(cur.price - t.price);
        const xDiff = Math.abs(curX - prevX);

        if (pDiff < maxPriceCluster && xDiff < minPixelGap) {
          const rawBuySum = cur.buy_vol + buyV;
          const rawSellSum = cur.sell_vol + sellV;
          const rawTotal = Math.max(0.1, rawBuySum + rawSellSum);
          // Preserve dominant institutional block size + dampened cluster tail (prevents retail sum inflation)
          const dampenedVol = Math.min(118.0, Math.max(cur.maxSingle, tVol) + Math.min(cur.volume, tVol) * 0.22);
          cur.volume = Math.round(dampenedVol * 10) / 10;
          cur.buy_vol = cur.volume * (rawBuySum / rawTotal);
          cur.sell_vol = cur.volume * (rawSellSum / rawTotal);
          cur.maxSingle = Math.max(cur.maxSingle, tVol);
          cur.is_large = cur.is_large || t.is_large || cur.volume >= 12.0;
          if (tVol >= cur.maxSingle) cur.price = t.price;
          cur.timestamp = Math.max(cur.timestamp, tMs);
          continue;
        }
      }

      if (cur) aggregated.push(cur);
      cur = {
        id: t.id || `${tMs}_${t.price}`,
        timestamp: tMs,
        price: t.price,
        volume: tVol,
        maxSingle: tVol,
        buy_vol: buyV,
        sell_vol: sellV,
        side: buyV >= sellV ? 'buy' : 'sell',
        is_large: t.is_large || tVol >= 12.0
      };
    }
    if (cur) aggregated.push(cur);

    // 3. Strict Lot Filtering & 2D Spatial De-Crowding (Largest Institutional Spheres Take Priority)
    const filteredTrades = (minVol > 0) 
      ? aggregated.filter(t => t.volume >= minVol)
      : aggregated;

    const bySizeDesc = [...filteredTrades].sort((a, b) => b.volume - a.volume);
    const placedNodes = [];
    for (const cand of bySizeDesc) {
      const cx = this.timeToX(cand.timestamp, now);
      const cy = this.priceToY(cand.price);
      if (cx < this.CHART_LEFT - 40 || cx > this.NOW_X + 16) continue;
      if (cy < this.CHART_TOP - 20  || cy > this.CHART_BOTTOM + 20) continue;
      // Authentic Bookmap X-Ray Proportional 3D Bubble Radius (Tiny dots for ambient flow, large 3D spheres for institutional bursts)
      const normV = Math.max(0.2, cand.volume);
      const baseR = (normV < 12.0 ? (2.2 + Math.sqrt(normV) * 0.95) : (4.0 + Math.pow(normV - 10.0, 0.54) * 1.45)) * (this.bubbleZoom || 1.0);
      const r = Math.min(20.5, Math.max(2.4, baseR));

      // Skip smaller bubble if it physically overlaps an already-placed larger institutional bubble
      const clearancePad = isHtfView ? 2.5 : -2.5;
      const overlaps = placedNodes.some(p => Math.hypot(p.cx - cx, p.cy - cy) < (p.r + r + clearancePad));
      if (!overlaps) {
        placedNodes.push({ ...cand, cx, cy, r });
      }
    }
    const qualifyingTrades = placedNodes.sort((a, b) => a.timestamp - b.timestamp);

    for (const t of qualifyingTrades) {
      const { cx, cy, r } = t;

      const buyV  = t.buy_vol  !== undefined ? t.buy_vol  : (t.side === 'buy' ? t.volume : 0);
      const sellV = t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0);
      const totalV = Math.max(0.1, buyV + sellV);
      const buyRatio = buyV / totalV;

      // Whale Audio Alert trigger
      if (t.is_large && now - t.timestamp < 1200 && t.id !== this._lastWhaleSoundId) {
        this._lastWhaleSoundId = t.id;
        this.playWhaleSound();
      }

      const dist = Math.hypot(this.mouseX - cx, this.mouseY - cy);
      if (dist <= r + 5) {
        this.hoverTrade = { ...t, cx, cy, r, buyV, sellV };
      }

      // Authentic Bookmap X-Ray Matte 3D Sphere Shading (Seafoam Mint Green for Aggressive Buyers, Coral Brick Red for Aggressive Sellers)
      const hx = cx - r * 0.30;
      const hy = cy - r * 0.30;

      // Soft drop shadow beneath 3D sphere
      if (r >= 5.0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx + 1.2, cy + 1.5, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fill();
        ctx.restore();
      }

      const makeBuyGrad = () => {
        const g = ctx.createRadialGradient(hx, hy, r * 0.08, cx, cy, r);
        g.addColorStop(0.00, '#86efac');
        g.addColorStop(0.35, '#34d399');
        g.addColorStop(0.75, '#059669');
        g.addColorStop(1.00, '#064e3b');
        return g;
      };
      const makeSellGrad = () => {
        const g = ctx.createRadialGradient(hx, hy, r * 0.08, cx, cy, r);
        g.addColorStop(0.00, '#fca5a5');
        g.addColorStop(0.35, '#e15b5b');
        g.addColorStop(0.75, '#991b1b');
        g.addColorStop(1.00, '#450a0a');
        return g;
      };

      if (buyRatio >= 0.90) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = makeBuyGrad();
        ctx.fill();
      } else if (buyRatio <= 0.10) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = makeSellGrad();
        ctx.fill();
      } else {
        // Authentic Bookmap X-Ray Angled 3D Split Sphere (Green Aggressive Buyers vs Red Aggressive Sellers)
        const startAngle = -Math.PI * 0.75;
        const buySweepAngle = Math.PI * 2 * buyRatio;

        // 1. Base Sell Sphere
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = makeSellGrad();
        ctx.fill();

        // 2. Clipped Buy Sector
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r + 0.5, startAngle, startAngle + buySweepAngle);
        ctx.closePath();
        ctx.clip();

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = makeBuyGrad();
        ctx.fill();
        ctx.restore();
      }

      // Subtle dark rim contour so overlapping 3D spheres stay distinct without garish yellow rings
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(5, 10, 20, 0.55)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ─── Buyer & Seller High Volume Aggression Zones ─────────────── */
  _drawVolumeZones(ctx, trades, currentPrice) {
    if (!trades || trades.length < 5) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    const step = 0.50;
    const buckets = {};
    const now = Date.now();
    const windowStart = now - this.timeWindowMs;

    for (const t of trades) {
      if (t.timestamp < windowStart - 10000) continue;
      const bp = Math.floor(t.price / step) * step;
      const pKey = bp.toFixed(2);
      if (!buckets[pKey]) {
        buckets[pKey] = { price: bp, buy: 0, sell: 0, total: 0 };
      }
      const bV = t.buy_vol !== undefined ? t.buy_vol : (t.side === 'buy' ? t.volume : 0);
      const sV = t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0);
      buckets[pKey].buy += bV;
      buckets[pKey].sell += sV;
      buckets[pKey].total += (bV + sV);
    }

    const bucketList = Object.values(buckets);
    if (bucketList.length === 0) { ctx.restore(); return; }

    let topBuy = bucketList[0];
    let topSell = bucketList[0];
    let topPoc = bucketList[0];
    let maxTotal = 1;

    for (const b of bucketList) {
      if (b.buy > topBuy.buy) topBuy = b;
      if (b.sell > topSell.sell) topSell = b;
      if (b.total > topPoc.total) topPoc = b;
      if (b.total > maxTotal) maxTotal = b.total;
    }

    // Note: Left-side Volume Profile histogram & Session dPOC are rendered by _drawSessionVolumeProfile
    // to prevent duplicate overlapping histograms and duplicate POC lines.
    const bandThickness = Math.max(8, Math.min(16, Math.abs(this.priceToY(0) - this.priceToY(step)) * 0.75));

    // ZON RAMAI BUYER with 8-Second Anti-Flicker Latch (Prevents rapid blinking when price ticks near zone)
    const rawBuyZoneOk = topBuy && topBuy.buy >= 80.0 &&
                         (topBuy.buy > topBuy.sell * 1.20) &&
                         (!currentPrice || currentPrice >= topBuy.price - 0.35);
    if (rawBuyZoneOk) {
      this._latchedBuyZone = { bucket: topBuy, ts: now };
    }
    const activeBuyZone = rawBuyZoneOk ? topBuy : ((this._latchedBuyZone && (now - this._latchedBuyZone.ts < 8000)) ? this._latchedBuyZone.bucket : null);
    if (activeBuyZone) {
      topBuy = activeBuyZone;
      const buyY = this.priceToY(topBuy.price);
      if (buyY >= this.CHART_TOP + 14 && buyY <= this.CHART_BOTTOM - 14) {
        if (currentPrice && Math.abs(currentPrice - topBuy.price) < 0.20) {
          this.playZoneSound();
        }

        ctx.fillStyle = 'rgba(0, 230, 118, 0.06)';
        ctx.fillRect(this.CHART_LEFT, buyY - bandThickness / 2, this.NOW_X - this.CHART_LEFT, bandThickness);

        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(0, 230, 118, 0.70)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, buyY);
        ctx.lineTo(this.NOW_X, buyY);
        ctx.stroke();

        ctx.setLineDash([]);
        if (!this.bmZenMode) {
          const label = `▲ BUY ZONE [SAH] +${topBuy.buy.toFixed(0)}L`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const txtW = ctx.measureText(label).width + 8;
          const badgeX = Math.min(this.CHART_RIGHT - txtW - 4, this.NOW_X + 6);
          const resolvedBuyY = this._resolveNonOverlappingY(buyY, 14, 18, 'PROJ');
          const badgeY = resolvedBuyY - 7;

          ctx.fillStyle = 'rgba(5, 22, 14, 0.90)';
          ctx.fillRect(badgeX, badgeY, txtW, 14);
          ctx.strokeStyle = 'rgba(0, 230, 118, 0.85)';
          ctx.lineWidth = 0.9;
          ctx.strokeRect(badgeX, badgeY, txtW, 14);

          ctx.fillStyle = '#00e676';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, badgeX + 4, resolvedBuyY);
        }
      }
    }

    // ZON RAMAI SELLER with 8-Second Anti-Flicker Latch & >= $2.50 Separation from BUY ZONE (Never stack BUY & SELL zones side-by-side!)
    const rawSellZoneOk = topSell && topSell.sell >= 80.0 &&
                          (topSell.sell > topSell.buy * 1.20) &&
                          (!currentPrice || currentPrice <= topSell.price + 0.35) &&
                          (!activeBuyZone || Math.abs(topSell.price - activeBuyZone.price) >= 2.50);
    if (rawSellZoneOk) {
      this._latchedSellZone = { bucket: topSell, ts: now };
    }
    const activeSellZone = rawSellZoneOk ? topSell : ((this._latchedSellZone && (now - this._latchedSellZone.ts < 8000)) ? this._latchedSellZone.bucket : null);
    if (activeSellZone) {
      topSell = activeSellZone;
      const sellY = this.priceToY(topSell.price);
      if (sellY >= this.CHART_TOP + 14 && sellY <= this.CHART_BOTTOM - 14) {
        if (currentPrice && Math.abs(currentPrice - topSell.price) < 0.20) {
          this.playZoneSound();
        }

        ctx.fillStyle = 'rgba(255, 51, 102, 0.06)';
        ctx.fillRect(this.CHART_LEFT, sellY - bandThickness / 2, this.NOW_X - this.CHART_LEFT, bandThickness);

        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(255, 51, 102, 0.70)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, sellY);
        ctx.lineTo(this.NOW_X, sellY);
        ctx.stroke();

        ctx.setLineDash([]);
        if (!this.bmZenMode) {
          const label = `▼ SELL ZONE [SAH] -${topSell.sell.toFixed(0)}L`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const txtW = ctx.measureText(label).width + 8;
          // Place inside projection zone on right of NOW_X so bubbles are completely unobstructed
          const badgeX = Math.min(this.CHART_RIGHT - txtW - 4, this.NOW_X + 6);
          const resolvedSellY = this._resolveNonOverlappingY(sellY, 14, 18, 'PROJ');
          const badgeY = resolvedSellY - 7;

          ctx.fillStyle = 'rgba(30, 8, 15, 0.90)';
          ctx.fillRect(badgeX, badgeY, txtW, 14);
          ctx.strokeStyle = 'rgba(255, 51, 102, 0.85)';
          ctx.lineWidth = 0.9;
          ctx.strokeRect(badgeX, badgeY, txtW, 14);

          ctx.fillStyle = '#ff3366';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, badgeX + 4, resolvedSellY);
        }
      }
    }
    ctx.restore();
  }

  /* ─── Session VWAP & Standard Deviation Bands (±1σ, ±2σ) ──────── */
  _drawVWAP(ctx, vwap) {
    if (!vwap || !vwap.value) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    // 1. Central VWAP Line (Neon Cyan)
    const yVwap = this.priceToY(vwap.value);
    if (yVwap >= this.CHART_TOP && yVwap <= this.CHART_BOTTOM) {
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, yVwap);
      ctx.lineTo(this.CHART_RIGHT, yVwap);
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 240, 255, 0.16)';
      ctx.fillRect(this.CHART_RIGHT - 80, yVwap - 8, 78, 16);
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.CHART_RIGHT - 80, yVwap - 8, 78, 16);
      ctx.fillStyle = '#00f0ff';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`VWAP ${vwap.value.toFixed(2)}`, this.CHART_RIGHT - 41, yVwap + 4);
    }

    // 2. ±1σ Bands (Gold Dashed)
    if (vwap.std1_up) {
      const y1Up = this.priceToY(vwap.std1_up);
      const y1Dn = this.priceToY(vwap.std1_down);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 183, 3, 0.70)';
      ctx.lineWidth = 1.0;

      if (y1Up >= this.CHART_TOP && y1Up <= this.CHART_BOTTOM) {
        ctx.beginPath(); ctx.moveTo(this.CHART_LEFT, y1Up); ctx.lineTo(this.CHART_RIGHT, y1Up); ctx.stroke();
      }
      if (y1Dn >= this.CHART_TOP && y1Dn <= this.CHART_BOTTOM) {
        ctx.beginPath(); ctx.moveTo(this.CHART_LEFT, y1Dn); ctx.lineTo(this.CHART_RIGHT, y1Dn); ctx.stroke();
      }
    }

    // 3. ±2σ Bands (Purple Dashed)
    if (vwap.std2_up) {
      const y2Up = this.priceToY(vwap.std2_up);
      const y2Dn = this.priceToY(vwap.std2_down);
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.70)';
      ctx.lineWidth = 1.0;

      if (y2Up >= this.CHART_TOP && y2Up <= this.CHART_BOTTOM) {
        ctx.beginPath(); ctx.moveTo(this.CHART_LEFT, y2Up); ctx.lineTo(this.CHART_RIGHT, y2Up); ctx.stroke();
      }
      if (y2Dn >= this.CHART_TOP && y2Dn <= this.CHART_BOTTOM) {
        ctx.beginPath(); ctx.moveTo(this.CHART_LEFT, y2Dn); ctx.lineTo(this.CHART_RIGHT, y2Dn); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ─── Active Positions, SL & TP Visual Lines on Chart ─────────── */
  _drawPositionsOnChart(ctx, positions, currentPrice) {
    this._positionHitboxes = [];
    if (!positions || !positions.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    for (const p of positions) {
      const isBuy = p.type === 'BUY';
      const openY = this.priceToY(p.open_price);

      // Entry Line
      if (openY >= this.CHART_TOP && openY <= this.CHART_BOTTOM) {
        ctx.strokeStyle = isBuy ? '#00e676' : '#ff3366';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, openY);
        ctx.lineTo(this.CHART_RIGHT, openY);
        ctx.stroke();

        ctx.setLineDash([]);
        const pnl = p.profit || 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const badgeTxt = `${p.type} ${p.volume}L @ $${p.open_price.toFixed(2)} (${pnlSign}$${pnl.toFixed(2)})`;
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        const tw = ctx.measureText(badgeTxt).width;
        const bx = this.CHART_LEFT + 75;
        const by = openY - 9;

        ctx.fillStyle = isBuy ? 'rgba(0, 230, 118, 0.20)' : 'rgba(255, 51, 102, 0.20)';
        ctx.fillRect(bx, by, tw + 12, 17);
        ctx.strokeStyle = isBuy ? '#00e676' : '#ff3366';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, tw + 12, 17);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(badgeTxt, bx + 6, by + 12);
      }

      // Stop Loss (SL) Line
      if (p.sl && p.sl > 0) {
        const slY = this.priceToY(p.sl);
        if (slY >= this.CHART_TOP && slY <= this.CHART_BOTTOM) {
          const isBeingDragged = this._draggingSLTP && this._draggingSLTP.ticket === p.ticket && this._draggingSLTP.type === 'sl';
          const activeSlPrice = isBeingDragged ? this._draggingSLTP.tempPrice : p.sl;
          const drawSlY = this.priceToY(activeSlPrice);

          ctx.strokeStyle = '#ff3366';
          ctx.lineWidth = isBeingDragged ? 2.2 : 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, drawSlY);
          ctx.lineTo(this.CHART_RIGHT, drawSlY);
          ctx.stroke();

          ctx.setLineDash([]);
          const slDist = Math.abs(p.open_price - activeSlPrice);
          const slUsd = (slDist * 100.0 * (p.volume || 0.01)).toFixed(2);
          const slTxt = isBeingDragged ? `✊ TARIK SL: $${activeSlPrice.toFixed(2)} (-$${slUsd})` : `SL: $${p.sl.toFixed(2)} (-$${slUsd})`;
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          const tw = ctx.measureText(slTxt).width;
          const bx = this.CHART_RIGHT - tw - 24;
          const by = drawSlY - 8;

          ctx.fillStyle = isBeingDragged ? '#ff0055' : 'rgba(255, 51, 102, 0.88)';
          ctx.fillRect(bx, by, tw + 10, 16);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'left';
          ctx.fillText(slTxt, bx + 5, by + 11);

          this._positionHitboxes.push({
            ticket: p.ticket,
            type: 'sl',
            pos: p,
            x: bx, y: by, w: tw + 10, h: 16
          });
        }
      }

      // Take Profit (TP) Line
      if (p.tp && p.tp > 0) {
        const tpY = this.priceToY(p.tp);
        if (tpY >= this.CHART_TOP && tpY <= this.CHART_BOTTOM) {
          const isBeingDragged = this._draggingSLTP && this._draggingSLTP.ticket === p.ticket && this._draggingSLTP.type === 'tp';
          const activeTpPrice = isBeingDragged ? this._draggingSLTP.tempPrice : p.tp;
          const drawTpY = this.priceToY(activeTpPrice);

          ctx.strokeStyle = '#00e676';
          ctx.lineWidth = isBeingDragged ? 2.2 : 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, drawTpY);
          ctx.lineTo(this.CHART_RIGHT, drawTpY);
          ctx.stroke();

          ctx.setLineDash([]);
          const tpDist = Math.abs(activeTpPrice - p.open_price);
          const tpUsd = (tpDist * 100.0 * (p.volume || 0.01)).toFixed(2);
          const tpTxt = isBeingDragged ? `✊ TARIK TP: $${activeTpPrice.toFixed(2)} (+$${tpUsd})` : `TP: $${p.tp.toFixed(2)} (+$${tpUsd})`;
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          const tw = ctx.measureText(tpTxt).width;
          const bx = this.CHART_RIGHT - tw - 24;
          const by = drawTpY - 8;

          ctx.fillStyle = isBeingDragged ? '#00f59b' : 'rgba(0, 230, 118, 0.88)';
          ctx.fillRect(bx, by, tw + 10, 16);
          ctx.fillStyle = isBeingDragged ? '#04101e' : '#000000';
          ctx.textAlign = 'left';
          ctx.fillText(tpTxt, bx + 5, by + 11);

          this._positionHitboxes.push({
            ticket: p.ticket,
            type: 'tp',
            pos: p,
            x: bx, y: by, w: tw + 10, h: 16
          });
        }
      }
    }
    ctx.restore();
  }

  /* ─── CVD Divergence Alert Banner on Chart (Anti-Collision Docked) ─ */
  _drawDivergenceAlert(ctx, div) {
    if (!div) return;
    if (this.bmZenMode) return; // Zen Pro Mode: Suppress floating warning banner
    const now = Date.now();
    if (now - div.timestamp > 15000) return;

    ctx.save();
    const isBull = div.type === 'bullish';
    const bannerW = 340;
    const bannerH = 20;
    // Docked at Top-Right so it NEVER collides with Top-Left Radar Bookmap signals
    const bannerX = this.CHART_RIGHT - bannerW - 14;
    const bannerY = (this.width && this.width < 1100) ? (this.CHART_TOP + 28) : (this.CHART_TOP + 6);

    ctx.fillStyle = isBull ? 'rgba(5, 30, 18, 0.94)' : 'rgba(38, 8, 16, 0.94)';
    ctx.fillRect(bannerX, bannerY, bannerW, bannerH);
    ctx.strokeStyle = isBull ? '#00e676' : '#ff3366';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(bannerX, bannerY, bannerW, bannerH);

    ctx.fillStyle = isBull ? '#00e676' : '#ff3366';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icon = isBull ? '⚡' : '⚠️';
    ctx.fillText(`${icon} ${div.title}: ${div.desc}`, bannerX + bannerW / 2, bannerY + bannerH / 2);
    ctx.restore();
  }

  /* ─── Trapped Traders (Buyers / Sellers) Visual Badges (Anti-Collision) ─── */
  _drawTrappedTraders(ctx, trappedList) {
    if (!trappedList || trappedList.length === 0) return;
    const now = Date.now();

    ctx.save();
    for (const tr of trappedList.slice(-1)) {
      if (now - tr.timestamp > 30000) continue; // Persist for 30 seconds

      const rawY = this.priceToY(tr.price);
      if (rawY < this.CHART_TOP || rawY > this.CHART_BOTTOM) continue;

      const isBuyerTrapped = tr.type === 'TRAPPED_BUYERS';
      const col = isBuyerTrapped ? '#ff3366' : '#00e676';
      const bgCol = isBuyerTrapped ? 'rgba(40, 10, 20, 0.92)' : 'rgba(10, 35, 20, 0.92)';

      // Dashed horizontal line indicating the trapped level
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, rawY);
      ctx.lineTo(this.NOW_X, rawY);
      ctx.stroke();
      ctx.setLineDash([]);

      // In Zen mode, skip the bulky badge pill to keep candles completely clear
      if (this.bmZenMode) continue;

      // Compact Trapped Traders Pill with RIGHT Lane Anti-Collision Slotting
      const shortTrTxt = `🪤 ${isBuyerTrapped ? 'TRAPPED BUYERS' : 'TRAPPED SELLERS'} $${tr.price.toFixed(2)}`;
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      const badgeW = ctx.measureText(shortTrTxt).width + 12;
      const badgeH = 15;
      const resolvedY = this._resolveNonOverlappingY(rawY, badgeH, 20, 'RIGHT');
      const bx = this.NOW_X - badgeW - 10;
      const by = resolvedY - (badgeH / 2);

      ctx.fillStyle = bgCol;
      ctx.fillRect(bx, by, badgeW, badgeH);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.0;
      ctx.strokeRect(bx, by, badgeW, badgeH);

      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(shortTrTxt, bx + 6, resolvedY);

      // Trigger Voice Alert if freshly detected (< 1.5s)
      if (now - tr.timestamp < 1500) {
        const voiceTxt = isBuyerTrapped 
          ? `Perangkap pembeli dikesan pada harga ${tr.price.toFixed(0)}. Peluang jualan.` 
          : `Perangkap penjual dikesan pada harga ${tr.price.toFixed(0)}. Peluang belian.`;
        this.speakAlert(voiceTxt);
      }
    }
    ctx.restore();
  }

  /* ─── Prop-Firm Session High/Low & Liquidity Sweep Markers ────── */
  _drawSessionLevels(ctx, sessions) {
    if (!sessions) return;
    ctx.save();

    // Section C: Initialize Global Timeframe Filter & Touch Tracker
    if (!window.snrTfFilter) {
      window.snrTfFilter = { M15: true, M30: false, H1: true, H4: false, D1: true, W1: false, SESSION: true };
    }
    if (!window.toggleSnrTf) {
      window.toggleSnrTf = function(tf, btnEl) {
        window.snrTfFilter[tf] = !window.snrTfFilter[tf];
        if (btnEl) {
          btnEl.classList.toggle('active', window.snrTfFilter[tf]);
          btnEl.style.opacity = window.snrTfFilter[tf] ? '1' : '0.45';
        }
      };
    }
    if (!this._snrTouchTracker) this._snrTouchTracker = {};

    const tfCfg = window.snrTfFilter;
    // Strictly 6 Institutional SNR Timeframes ONLY: M15, M30, H1, H4, H8, D1 (Zero Session/Asian/London/Weekly clutter!)
    const rawLevels = [
      { price: sessions.pdh,                        label: 'D1 SNR RES',  tf: 'D1',  strength: '95%', col: '#fde047', bg: 'rgba(253, 224, 71, 0.28)', isHtf: true },
      { price: sessions.pdl,                        label: 'D1 SNR SUP',  tf: 'D1',  strength: '95%', col: '#fde047', bg: 'rgba(253, 224, 71, 0.28)', isHtf: true },
      { price: sessions.h8_res || sessions.h8_high, label: 'H8 SNR RES',  tf: 'H8',  strength: '90%', col: '#e11d48', bg: 'rgba(225, 29, 72, 0.25)', isHtf: true },
      { price: sessions.h8_sup || sessions.h8_low,  label: 'H8 SNR SUP',  tf: 'H8',  strength: '90%', col: '#059669', bg: 'rgba(5, 150, 105, 0.25)', isHtf: true },
      { price: sessions.h4_res || sessions.h4_high, label: 'H4 SNR RES',  tf: 'H4',  strength: '85%', col: '#ec4899', bg: 'rgba(236, 72, 153, 0.24)', isHtf: true },
      { price: sessions.h4_sup || sessions.h4_low,  label: 'H4 SNR SUP',  tf: 'H4',  strength: '85%', col: '#10b981', bg: 'rgba(16, 185, 129, 0.24)', isHtf: true },
      { price: sessions.h1_res || sessions.h1_high, label: 'H1 SNR RES',  tf: 'H1',  strength: '78%', col: '#f97316', bg: 'rgba(249, 115, 22, 0.22)', isHtf: true },
      { price: sessions.h1_sup || sessions.h1_low,  label: 'H1 SNR SUP',  tf: 'H1',  strength: '78%', col: '#06b6d4', bg: 'rgba(6, 182, 212, 0.22)', isHtf: true },
      { price: sessions.m30_res || sessions.m30_high, label: 'M30 SNR RES', tf: 'M30', strength: '70%', col: '#a855f7', bg: 'rgba(168, 85, 247, 0.20)', isHtf: true },
      { price: sessions.m30_sup || sessions.m30_low,  label: 'M30 SNR SUP', tf: 'M30', strength: '70%', col: '#3b82f6', bg: 'rgba(59, 130, 246, 0.20)', isHtf: true },
      { price: sessions.m15_res || sessions.m15_high, label: 'M15 SNR RES', tf: 'M15', strength: '65%', col: '#fbbf24', bg: 'rgba(251, 191, 36, 0.20)', isHtf: true },
      { price: sessions.m15_sup || sessions.m15_low,  label: 'M15 SNR SUP', tf: 'M15', strength: '65%', col: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.20)', isHtf: true }
    ].filter(r => r.price && r.price > 0);

    const currentPrice = this._currentPrice || (this._latestSnapshot && (this._latestSnapshot.last_price || this._latestSnapshot.bid)) || 0;
    const nowTs = Date.now();

    // Update Fresh vs Tested touch count
    for (const r of rawLevels) {
      const k = r.price.toFixed(2);
      if (!this._snrTouchTracker[k]) this._snrTouchTracker[k] = { count: 0, lastTouch: 0 };
      if (currentPrice > 0 && Math.abs(currentPrice - r.price) <= 0.18 && (nowTs - this._snrTouchTracker[k].lastTouch > 35000)) {
        this._snrTouchTracker[k].count += 1;
        this._snrTouchTracker[k].lastTouch = nowTs;
      }
    }

    // Select active levels while preventing clutter (max 2 above + max 2 below + 1D Open)
    const coreLevels = rawLevels.filter(r => r.label === '1D OPEN');
    const resLevels = rawLevels.filter(r => r.price > currentPrice && r.label !== '1D OPEN').sort((a, b) => a.price - b.price);
    const supLevels = rawLevels.filter(r => r.price < currentPrice && r.label !== '1D OPEN').sort((a, b) => b.price - a.price);
    coreLevels.push(...resLevels.slice(0, 2));
    coreLevels.push(...supLevels.slice(0, 2));

    const levels = [];
    for (const raw of coreLevels) {
      if (!raw.price || raw.price <= 0) continue;
      const tInfo = this._snrTouchTracker[raw.price.toFixed(2)] || { count: 0 };
      const freshTag = tInfo.count === 0 ? 'FRESH' : `TESTED ${tInfo.count}x`;
      const matched = levels.find(l => Math.abs(l.price - raw.price) < 0.35);
      if (matched) {
        if (!matched.labels.includes(raw.label)) matched.labels.push(raw.label);
      } else {
        levels.push({
          price: raw.price,
          labels: [raw.label],
          metaTag: `${freshTag}•${raw.strength}`,
          col: raw.col,
          bg: raw.bg,
          isHtf: raw.isHtf
        });
      }
    }

    let offScreenAboveCount = 0;
    let offScreenBelowCount = 0;

    for (const lv of levels) {
      const y = this.priceToY(lv.price);
      const inView = (y >= this.CHART_TOP - 4 && y <= this.CHART_BOTTOM + 4);

      if (inView) {
        // 1. Sleek Luminous SNR Ray with Subtle Dark Contrast Underlay
        ctx.save();
        ctx.strokeStyle = 'rgba(5, 10, 20, 0.78)';
        ctx.lineWidth = lv.isHtf ? 2.4 : 1.8;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, y);
        ctx.lineTo(this.CHART_RIGHT, y);
        ctx.stroke();

        ctx.setLineDash(lv.isHtf ? [8, 4] : [5, 4]);
        ctx.strokeStyle = lv.col;
        ctx.lineWidth = lv.isHtf ? 1.4 : 1.1;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, y);
        ctx.lineTo(this.CHART_RIGHT, y);
        ctx.stroke();
        ctx.restore();

        // 2. Unified LEFT Lane Anti-Collision Slotting (Zero overlap with Spoof/Sweep/SMR badges)
        const text = `${lv.labels.join('•')} $${lv.price.toFixed(2)} [${lv.metaTag || 'FRESH'}]`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const tw = ctx.measureText(text).width + 8;

        const bx = this.CHART_LEFT + 6;
        const resolvedLvY = this._resolveNonOverlappingY(y, 14, 18, 'LEFT');
        const by = resolvedLvY - 7;

        ctx.fillStyle = 'rgba(8, 13, 24, 0.92)';
        ctx.fillRect(bx, by, tw, 14);
        ctx.fillStyle = lv.bg;
        ctx.fillRect(bx, by, tw, 14);
        ctx.strokeStyle = lv.col;
        ctx.lineWidth = 0.9;
        ctx.strokeRect(bx, by, tw, 14);

        ctx.fillStyle = lv.col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 4, resolvedLvY);
      }
    }

    // Section B: Sweep/Breakout Alert is already displayed in the top header bar (#sweepLevelBanner).
    // Skipping duplicate middle-of-chart banner so candlesticks remain 100% unobstructed.

    ctx.restore();
  }

  /* ─── World-Class Composite Session Volume Profile (SVP) ──────── */
  _drawSessionVolumeProfile(ctx, svp) {
    if (!svp || !svp.buckets || svp.buckets.length === 0) return;
    ctx.save();

    const maxVol = Math.max(10, svp.max_bucket_vol || 50);
    const maxBarW = 82; // Clean compact left-side horizontal profile width
    const dpoc = svp.dpoc || 0;
    const vah = svp.vah || 0;
    const val = svp.val || 0;

    // 1. Draw Horizontal Volume Profile Bars along the left side of chart
    for (const b of svp.buckets) {
      const y = this.priceToY(b.price);
      if (y < this.CHART_TOP + 8 || y > this.CHART_BOTTOM - 8) continue;

      const totalW = Math.min(maxBarW, (b.total / maxVol) * maxBarW);
      const buyRatio = b.total > 0 ? (b.buy / b.total) : 0.5;
      const buyW = totalW * buyRatio;
      const sellW = totalW - buyW;
      const isPOC = Math.abs(b.price - dpoc) < 0.08;
      const inVA = b.price >= val - 0.05 && b.price <= vah + 0.05;
      const barH = isPOC ? 8 : 6;

      // Sell portion
      ctx.fillStyle = isPOC ? 'rgba(255, 183, 3, 0.68)' : (inVA ? 'rgba(255, 51, 102, 0.30)' : 'rgba(100, 116, 139, 0.18)');
      ctx.fillRect(this.CHART_LEFT, y - barH / 2, sellW, barH);

      // Buy portion
      ctx.fillStyle = isPOC ? 'rgba(255, 214, 10, 0.85)' : (inVA ? 'rgba(0, 230, 118, 0.32)' : 'rgba(148, 163, 184, 0.20)');
      ctx.fillRect(this.CHART_LEFT + sellW, y - barH / 2, buyW, barH);

      if (isPOC) {
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 1.0;
        ctx.strokeRect(this.CHART_LEFT, y - barH / 2, totalW, barH);
      }
    }

    // 2. Developing Session POC (dPOC) Line & Compact Tag
    if (dpoc > 0) {
      const py = this.priceToY(dpoc);
      if (py >= this.CHART_TOP + 12 && py <= this.CHART_BOTTOM - 12) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255, 214, 10, 0.80)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, py);
        ctx.lineTo(this.CHART_RIGHT, py);
        ctx.stroke();
        ctx.setLineDash([]);

        const txt = `⭐ dPOC $${dpoc.toFixed(2)}`;
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        const tw = ctx.measureText(txt).width + 8;
        const bx = this.CHART_LEFT + maxBarW + 4;
        const resolvedPocY = this._resolveNonOverlappingY(py, 14, 18, 'LEFT');
        ctx.fillStyle = 'rgba(20, 16, 4, 0.90)';
        ctx.fillRect(bx, resolvedPocY - 7, tw, 14);
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(bx, resolvedPocY - 7, tw, 14);
        ctx.fillStyle = '#ffd60a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, bx + 4, resolvedPocY);
      }
    }

    // 3. Subtle Session VAH & VAL (70% Value Area) Dashed Boundaries (only if >= $0.50 away from dPOC)
    const vaLines = [vah, val];
    for (const vp of vaLines) {
      if (!vp || vp <= 0 || Math.abs(vp - dpoc) < 0.50) continue;
      const vy = this.priceToY(vp);
      if (vy < this.CHART_TOP + 14 || vy > this.CHART_BOTTOM - 14) continue;

      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.40)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, vy);
      ctx.lineTo(this.CHART_LEFT + maxBarW + 20, vy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  /* ─── World-Class Real-Time Iceberg & Absorption Detector (Reload Tracker) ─ */
  _drawIcebergOrders(ctx, icebergs) {
    if (!icebergs || icebergs.length === 0) return;
    ctx.save();
    const now = Date.now();
    const drawnIcebergYs = [];

    if (!this._icebergReloads) this._icebergReloads = {};

    // Track multi-fill reload counts
    for (const ic of icebergs) {
      const key = `${ic.bias}_${ic.price.toFixed(2)}`;
      if (!this._icebergReloads[key]) {
        this._icebergReloads[key] = { count: 1, absorbed: ic.absorbed_vol || 0, lastSeen: now };
      } else {
        const item = this._icebergReloads[key];
        if (now - item.lastSeen < 65000) {
          if ((ic.absorbed_vol || 0) > item.absorbed + 1.8) {
            item.count += 1;
            item.absorbed = ic.absorbed_vol;
            item.lastSeen = now;
          }
        } else {
          item.count = 1;
          item.absorbed = ic.absorbed_vol || 0;
          item.lastSeen = now;
        }
      }
    }

    for (const ic of icebergs.slice(-2).reverse()) {
      if (now - ic.timestamp > 60000) continue; // Show active icebergs for 60s
      if (drawnIcebergYs.length >= 1) break;    // Max 1 active iceberg badge on chart for zero clutter
      const y = this.priceToY(ic.price);
      if (y < this.CHART_TOP + 16 || y > this.CHART_BOTTOM - 16) continue;
      if (drawnIcebergYs.some(py => Math.abs(py - y) < 22)) continue;
      drawnIcebergYs.push(y);

      const isBuyIceberg = ic.bias === 'BUY';
      const col = isBuyIceberg ? '#00f0ff' : '#f43f5e';
      const bg = isBuyIceberg ? 'rgba(0, 240, 255, 0.08)' : 'rgba(244, 63, 94, 0.08)';

      const key = `${ic.bias}_${ic.price.toFixed(2)}`;
      const reloadInfo = this._icebergReloads[key];
      const reloadCount = reloadInfo ? reloadInfo.count : 1;

      // Subtle Shaded Absorption Band
      ctx.fillStyle = bg;
      ctx.fillRect(this.CHART_LEFT, y - 4, this.NOW_X - this.CHART_LEFT, 8);

      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, y);
      ctx.lineTo(this.NOW_X, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // In Zen mode, skip bulky badge pill to preserve clean heatmap and candles
      if (this.bmZenMode) continue;

      // Compact Potential Iceberg Pill with RIGHT Lane Anti-Collision Slotting
      const badgeH = 15;
      const resolvedY = this._resolveNonOverlappingY(y, badgeH, 20, 'RIGHT');
      const confPct = ic.confidence || 78;
      const txt = `🧊 POT. ICE ${ic.bias} $${ic.price.toFixed(2)} (${Math.round(ic.absorbed_vol || 25)}L•${confPct}%)`;
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      const tw = ctx.measureText(txt).width + 12;
      const bx = this.NOW_X - tw - 10;
      const by = resolvedY - 7.5;

      ctx.fillStyle = 'rgba(6, 12, 24, 0.94)';
      ctx.fillRect(bx, by, tw, badgeH);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      ctx.strokeRect(bx, by, tw, badgeH);

      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 6, resolvedY);
    }

    ctx.restore();
  }

  /* ─── Real-Time Institutional Order Flow Buy/Sell Signals (Strict Location-First) ─── */
  _drawOrderFlowSignals(ctx, snapshot, now, currentPrice) {
    if (!snapshot) return;
    const p = currentPrice || snapshot.last_price || snapshot.bid;
    if (!p || p <= 0) return;

    if (!this._bmSignalsHistory) this._bmSignalsHistory = [];

    // 1. Seamlessly Sync Confirmed Backend Signals from MT5 Engine & Supabase
    if (snapshot.bookmap_signals && Array.isArray(snapshot.bookmap_signals)) {
      for (const bs of snapshot.bookmap_signals) {
        if (!this._bmSignalsHistory.some(s => s.id === bs.id)) {
          this._bmSignalsHistory.push({
            id: bs.id,
            time: (bs.timestamp * 1000) || now,
            price: bs.price,
            dir: bs.direction,
            zoneName: bs.zone,
            sl: bs.sl,
            tp1: bs.tp1,
            tp2: bs.tp2,
            trigger: bs.type,
            wallLots: bs.wall_lots || 25.0,
            status: bs.status || 'ACTIVE'
          });
          if (this._bmSignalsHistory.length > 12) this._bmSignalsHistory.shift();

          // Trigger sound and toast
          this.playZoneSound();
          if (this.speakAlert) {
            this.speakAlert(`Isyarat Bookmap: ${bs.direction === 'BUY' ? 'Belian' : 'Jualan'} dikesan di zon ${bs.zone}.`);
          }
          if (window.orderFlowApp && window.orderFlowApp.showToast) {
            window.orderFlowApp.showToast(`🎯 [BOOKMAP ISYARAT] ${bs.direction} [${bs.zone}] @ $${bs.price.toFixed(2)} | TP1: $${bs.tp1.toFixed(2)}`);
          }
          if (window.orderFlowApp && typeof window.orderFlowApp.addSignal === 'function') {
            window.orderFlowApp.addSignal({
              id: bs.id,
              type: `🎯 [BOOKMAP] ${bs.zone}`,
              direction: bs.direction,
              entryPrice: bs.price,
              slPrice: bs.sl,
              tpPrice: bs.tp1,
              tp1: bs.tp1,
              tp2: bs.tp2,
              tp3: bs.tp3,
              tp4: bs.tp4,
              tp5: bs.tp5,
              slPips: 50,
              tpPips: 50
            });
          }
        }
      }
    }


    // Backend mt5_engine.py is the single authoritative source of truth for Bookmap signals.
    // Client-side duplicate signal loop has been disabled to prevent duplicate signals.

    // 4. Render ONLY the Single Latest Active Unified Confluence Signal on Bookmap Canvas (Zero Clutter)
    ctx.save();
    const latestActiveList = this._bmSignalsHistory.filter(s => s.status === 'ACTIVE' || (now - s.time < 45000)).slice(-1);
    for (const sig of latestActiveList) {
      const isBuy = sig.dir === 'BUY';

      // Update win/loss status in real-time with Auto-BE (Break-Even) protection & 1000p Ladder (TP1-TP20)
      const sigStatusStr = typeof sig.status === 'string' ? sig.status : 'ACTIVE';
      if (sigStatusStr === 'ACTIVE' || sigStatusStr.startsWith('TP')) {
        const entryP = sig.price;
        const gainPips = isBuy ? (p - entryP) * 10 : (entryP - p) * 10;

        // 1. Trigger Break-Even once gain >= 50 pips (TP1)
        if (gainPips >= 50.0 && !sig.isBEActive) {
          sig.isBEActive = true;
          sig.sl = entryP;
        }

        // 2. Multi-Stage TP ladder from TP1 (50p) up to TP20 (1000p)
        const currentTier = Math.min(20, Math.max(0, Math.floor(gainPips / 50)));
        const highestTier = sig.highestTPTier || 0;
        if (currentTier > highestTier) {
          sig.highestTPTier = currentTier;
          sig.status = `TP${currentTier}_HIT`;
        }

        // 3. Exit reversals
        if (sig.isBEActive && gainPips <= 0.0 && (!sigStatusStr || !sigStatusStr.startsWith('TP'))) {
          sig.status = 'BE_HIT';
        } else if (!sig.isBEActive && gainPips <= -50.0 && (!sigStatusStr || !sigStatusStr.startsWith('TP'))) {
          sig.status = 'SL_HIT';
        }
      }

      const sigX = this.timeToX(sig.time, now);
      const sigY = this.priceToY(sig.price);
      const slY  = this.priceToY(sig.sl);
      const tp1Y = this.priceToY(sig.tp1);
      const tp2Y = this.priceToY(sig.tp2);

      const col = isBuy ? '#00e676' : '#ff3366';
      const bgCol = isBuy ? 'rgba(5, 38, 22, 0.94)' : 'rgba(45, 10, 20, 0.94)';

      // Only keep forward projection trajectory rays for ACTIVE signals or fresh (< 60s)
      const isSignalActive = (sig.status === 'ACTIVE');
      const isSignalFresh = (now - sig.time < 60000);

      if (isSignalActive || isSignalFresh) {
        const startLineX = Math.max(this.CHART_LEFT, sigX);
        const endLineX = this.NOW_X;

        if (startLineX < endLineX) {
          // Entry Level Ray
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(startLineX, sigY);
          ctx.lineTo(endLineX, sigY);
          ctx.stroke();

          // TP1 Level Ray (Cyan)
          if (tp1Y >= this.CHART_TOP && tp1Y <= this.CHART_BOTTOM) {
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(startLineX, tp1Y);
            ctx.lineTo(endLineX, tp1Y);
            ctx.stroke();

            const tpText = `🎯 TP1 $${sig.tp1.toFixed(2)}`;
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const tpW = ctx.measureText(tpText).width + 8;
            ctx.fillStyle = 'rgba(0, 30, 40, 0.88)';
            ctx.fillRect(endLineX - tpW - 4, tp1Y - 6.5, tpW, 13);
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(endLineX - tpW - 4, tp1Y - 6.5, tpW, 13);
            ctx.fillStyle = '#00f0ff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(tpText, endLineX - tpW, tp1Y);
          }

          // TP2 Level Ray (Gold)
          if (tp2Y && tp2Y >= this.CHART_TOP && tp2Y <= this.CHART_BOTTOM) {
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(startLineX, tp2Y);
            ctx.lineTo(endLineX, tp2Y);
            ctx.stroke();

            const tp2Text = `🚀 TP2 $${sig.tp2.toFixed(2)}`;
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const tp2W = ctx.measureText(tp2Text).width + 8;
            ctx.fillStyle = 'rgba(38, 25, 5, 0.88)';
            ctx.fillRect(endLineX - tp2W - 4, tp2Y - 6.5, tp2W, 13);
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(endLineX - tp2W - 4, tp2Y - 6.5, tp2W, 13);
            ctx.fillStyle = '#fbbf24';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(tp2Text, endLineX - tp2W, tp2Y);
          }

          // SL Level Ray (Red/Pink or Golden Break-Even Shield)
          if (slY >= this.CHART_TOP && slY <= this.CHART_BOTTOM) {
            const isBE = !!sig.isBEActive;
            const slStroke = isBE ? '#facc15' : '#f43f5e';
            const slBg = isBE ? 'rgba(45, 35, 5, 0.88)' : 'rgba(40, 8, 16, 0.88)';
            const slText = isBE ? `🛡️ BE $${sig.sl.toFixed(2)}` : `🛑 SL $${sig.sl.toFixed(2)}`;
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = slStroke;
            ctx.lineWidth = isBE ? 1.3 : 1.0;
            ctx.beginPath();
            ctx.moveTo(startLineX, slY);
            ctx.lineTo(endLineX, slY);
            ctx.stroke();

            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const slW = ctx.measureText(slText).width + 8;
            ctx.fillStyle = slBg;
            ctx.fillRect(endLineX - slW - 4, slY - 6.5, slW, 13);
            ctx.strokeStyle = slStroke;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(endLineX - slW - 4, slY - 6.5, slW, 13);
            ctx.fillStyle = slStroke;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(slText, endLineX - slW, slY);
          }
          ctx.setLineDash([]);
        }
      }

      // Draw Marker & Badge at (sigX, sigY)
      if (sigX >= this.CHART_LEFT - 30 && sigX <= this.NOW_X + 30 && sigY >= this.CHART_TOP - 12 && sigY <= this.CHART_BOTTOM + 12) {
        if (isSignalActive || isSignalFresh) {
          // Glowing Neon Pulse Arrow
          ctx.fillStyle = col;
          ctx.shadowColor = col;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          const arrowH = 10;
          const arrowW = 7;
          if (isBuy) {
            ctx.moveTo(sigX, sigY + 5);
            ctx.lineTo(sigX - arrowW, sigY + 5 + arrowH);
            ctx.lineTo(sigX + arrowW, sigY + 5 + arrowH);
          } else {
            ctx.moveTo(sigX, sigY - 5);
            ctx.lineTo(sigX - arrowW, sigY - 5 - arrowH);
            ctx.lineTo(sigX + arrowW, sigY - 5 - arrowH);
          }
          ctx.closePath();
          ctx.fill();
          ctx.shadowBlur = 0;

          // Bulky Badge ONLY for active signals or signals in the last 60s
          let statusBadge = '';
          if (sig.status && sig.status.startsWith('TP')) {
            const tierNum = sigStatusStr.replace('TP', '').replace('_HIT', '');
            const pipsNum = parseInt(tierNum, 10) * 50;
            statusBadge = ` 🎯 TP${tierNum} HIT (+${pipsNum}p)`;
          } else if (sig.status === 'BE_HIT') {
            statusBadge = ' 🛡️ BE HIT (0p)';
          } else if (sig.status === 'SL_HIT') {
            statusBadge = ' ❌ SL HIT (-50p)';
          }

          const mainText = `🎯 [BM] ${sig.dir} [${sig.zoneName}]${statusBadge}`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const bw = ctx.measureText(mainText).width + 12;
          const bh = 16;
          const bx = Math.max(this.CHART_LEFT + 4, Math.min(this.NOW_X - bw - 10, sigX - bw / 2));
          const rawCenterY = isBuy ? (sigY + 22) : (sigY - 22);
          const resolvedCenterY = this._resolveNonOverlappingY(rawCenterY, bh, 22, 'RIGHT');
          const by = resolvedCenterY - bh / 2;

          ctx.fillStyle = bgCol;
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.strokeRect(bx, by, bw, bh);

          ctx.fillStyle = col;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(mainText, bx + bw / 2, by + bh / 2);
        } else {
          // Subtle micro-marker for completed historical trade (chart stays clean & spacious)
          ctx.fillStyle = isBuy ? 'rgba(0, 230, 118, 0.40)' : 'rgba(255, 51, 102, 0.40)';
          ctx.beginPath();
          if (isBuy) {
            ctx.moveTo(sigX, sigY + 3);
            ctx.lineTo(sigX - 4, sigY + 9);
            ctx.lineTo(sigX + 4, sigY + 9);
          } else {
            ctx.moveTo(sigX, sigY - 3);
            ctx.lineTo(sigX - 4, sigY - 9);
            ctx.lineTo(sigX + 4, sigY - 9);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Top-left 420px duplicate radar banner removed so top-left chart area remains 100% clean.
    ctx.restore();
  }

  /* ─── Current Price Ray & Interactive Cursor Depth Inspector ───── */
  _drawCurrentPriceLine(ctx, currentPrice, orderBook, now) {
    if (currentPrice) {
      const y = this.priceToY(currentPrice);
      if (y >= this.CHART_TOP && y <= this.CHART_BOTTOM) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#ffb703';
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, y);
        ctx.lineTo(this.CHART_RIGHT, y);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Precision Crosshair & Live Resting Liquidity Inspector at Mouse Cursor
    if (
      this.mouseX >= this.CHART_LEFT && this.mouseX <= this.CHART_RIGHT &&
      this.mouseY >= this.CHART_TOP && this.mouseY <= this.CHART_BOTTOM
    ) {
      ctx.save();
      const cursorPrice = this.yToPrice(this.mouseY);
      const snappedP = (Math.round(cursorPrice * 10) / 10).toFixed(2);

      // Crosshair lines
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.42)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, this.mouseY);
      ctx.lineTo(this.CHART_RIGHT, this.mouseY);
      ctx.moveTo(this.mouseX, this.CHART_TOP);
      ctx.lineTo(this.mouseX, this.CHART_BOTTOM);
      ctx.stroke();
      ctx.setLineDash([]);

      // Left Axis Price Pill for Cursor
      ctx.fillStyle = '#0ea5e9';
      ctx.fillRect(1, this.mouseY - 8, this.CHART_LEFT - 3, 16);
      ctx.fillStyle = '#04101e';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(cursorPrice.toFixed(2), this.CHART_LEFT - 4, this.mouseY + 3);

      // Right Axis Price Pill for Cursor (Matches Footprint & Cluster)
      ctx.fillStyle = '#0ea5e9';
      ctx.fillRect(this.CHART_RIGHT + 1, this.mouseY - 8, this.COB_WIDTH - 2, 16);
      ctx.fillStyle = '#04101e';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`⌖ $${cursorPrice.toFixed(2)}`, this.CHART_RIGHT + this.COB_WIDTH / 2, this.mouseY + 3.5);

      // Cursor price is already shown on the Left & Right price axes (⌖ $XXXX.XX); middle-of-chart floating pill removed.
      ctx.restore();
    }
  }

  /* ─── Left Price Scale Axis (Rock-Solid Fail-Safe) ───────────────────────────────────── */
  _drawPriceAxis(ctx) {
    ctx.save();
    const step = 0.50;
    const minP = Number.isFinite(this.minPrice) ? this.minPrice : (this.lastKnownPrice || 3880) - 4.5;
    const maxP = Number.isFinite(this.maxPrice) ? this.maxPrice : (this.lastKnownPrice || 3880) + 4.5;
    const startP = Math.floor(minP / step) * step;

    ctx.font      = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let p = startP; p <= maxP + step; p = Math.round((p + step) * 100) / 100) {
      const y = this.priceToY(p);
      if (y < this.CHART_TOP + 4 || y > this.CHART_BOTTOM - 4) continue;

      const isWholeDollar = Math.abs(Math.round(p) - p) < 0.01;
      ctx.fillStyle = isWholeDollar ? '#85a4cc' : '#3d5677';
      ctx.fillText(p.toFixed(2), this.CHART_LEFT - 4, y + 3);
    }
    ctx.restore();
  }

  /* ─── Authentic Bookmap X-Ray Dual COB Columns: Price | COB (Order Book) | COB (Cumulated Order Book) ─── */
  _drawCOB(ctx, orderBook, currentPrice, bid, ask) {
    ctx.save();
    const sx = this.CHART_RIGHT;
    const sw = this.COB_WIDTH;
    const isMob = this.isMobileScreen;

    // Bookmap X-Ray dark slate panel background
    ctx.fillStyle = '#18222f';
    ctx.fillRect(sx, 0, sw, this.height);

    // Sub-column layout: Price Axis | COB 1 (Limit Order Book) | COB 2 (Cumulated Order Book)
    const priceW = isMob ? 38 : 46;
    const cob1W  = isMob ? 40 : 41;
    const cob2W  = isMob ? 0  : (sw - priceW - cob1W);
    const col1X  = sx + priceW;
    const col2X  = col1X + cob1W;

    // Vertical column dividers
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height);
    ctx.moveTo(col1X, 0); ctx.lineTo(col1X, this.height);
    if (cob2W > 0) {
      ctx.moveTo(col2X, 0); ctx.lineTo(col2X, this.height);
    }
    ctx.stroke();

    // Header Strip: PRICE | COB | COB
    const hdrH = 20;
    ctx.fillStyle = '#0f1722';
    ctx.fillRect(sx, 0, sw, hdrH);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(sx, 0, sw, hdrH);

    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.fillText('COB', col1X + cob1W / 2, 13.5);
    if (cob2W > 0) {
      ctx.fillText('COB', col2X + cob2W / 2, 13.5);
    }

    const bids = (orderBook && orderBook.bids) || {};
    const asks = (orderBook && orderBook.asks) || {};
    const effectivePrice = currentPrice || this.lastKnownPrice || 3560.0;
    const cyLive = this.priceToY(effectivePrice);

    const minP = Number.isFinite(this.minPrice) ? this.minPrice : effectivePrice - 4.5;
    const maxP = Number.isFinite(this.maxPrice) ? this.maxPrice : effectivePrice + 4.5;

    // Dynamic price step based on visible chart zoom
    const pxPer10 = Math.abs(this.priceToY(minP) - this.priceToY(minP + 0.10));
    let ladderStep = 0.25;
    if (pxPer10 >= 12) ladderStep = 0.10;
    else if (pxPer10 * 2.5 >= 13) ladderStep = 0.25;
    else if (pxPer10 * 5 >= 13) ladderStep = 0.50;
    else ladderStep = 1.00;

    const startP = Math.floor(minP / ladderStep) * ladderStep;
    const rows = [];
    let maxSingleVol = 40;

    for (let p = startP; p <= maxP + ladderStep; p = Math.round((p + ladderStep) * 100) / 100) {
      const y = this.priceToY(p);
      if (y < this.CHART_TOP + hdrH + 4 || y > this.CHART_BOTTOM - 4) continue;

      let bVol = 0;
      let aVol = 0;
      const half = ladderStep * 0.52;
      for (const [bp, bv] of Object.entries(bids)) {
        if (Math.abs(parseFloat(bp) - p) <= half) bVol = Math.max(bVol, parseFloat(bv) || 0);
      }
      for (const [ap, av] of Object.entries(asks)) {
        if (Math.abs(parseFloat(ap) - p) <= half) aVol = Math.max(aVol, parseFloat(av) || 0);
      }

      const isAsk = p > effectivePrice + 0.02;
      const isBid = p < effectivePrice - 0.02;
      const vol = Math.round(isAsk ? (aVol || bVol || 12) : (bVol || aVol || 12));
      if (vol > maxSingleVol) maxSingleVol = vol;
      rows.push({ p, y, vol, isAsk, isBid });
    }

    // Compute Cumulated Order Book (COB Column 2) outward from current price!
    const askRows = rows.filter(r => r.isAsk).sort((a, b) => a.p - b.p);
    let cumAsk = 0;
    for (const r of askRows) {
      cumAsk += r.vol;
      r.cumVol = cumAsk;
    }

    const bidRows = rows.filter(r => !r.isAsk).sort((a, b) => b.p - a.p);
    let cumBid = 0;
    for (const r of bidRows) {
      cumBid += r.vol;
      r.cumVol = cumBid;
    }

    const maxCumVol = Math.max(100, cumAsk, cumBid);
    const rowH = Math.max(11, Math.min(18, Math.abs(this.priceToY(minP) - this.priceToY(minP + ladderStep)) - 1));

    for (const r of rows) {
      const { p, y, vol, cumVol, isAsk } = r;
      const isNearLive = Math.abs(y - cyLive) <= rowH * 0.65;
      const barCol = isAsk ? '#ef2310' : '#1fd619';

      // Highlight live best bid/ask row
      if (isNearLive) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
        ctx.fillRect(sx, y - rowH / 2, sw, rowH);
      }

      // 1. Price Label in Sub-Column 0
      ctx.font = isNearLive ? 'bold 8.5px "JetBrains Mono", monospace' : '8.5px "JetBrains Mono", monospace';
      ctx.fillStyle = isNearLive ? '#ffffff' : '#94a3b8';
      ctx.textAlign = 'right';
      ctx.fillText(p.toFixed(2), col1X - 3, y + 3);
      if (isNearLive) {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 1, y - rowH / 2, priceW - 2, rowH);
      }

      // 2. COB 1: Current Order Book Bar (Left-Aligned Red Ask / Green Bid Bar + Number)
      const w1 = Math.max(2, Math.min(cob1W - 2, (vol / maxSingleVol) * (cob1W - 2)));
      ctx.fillStyle = barCol;
      ctx.fillRect(col1X + 1, y - rowH / 2 + 0.5, w1, rowH - 1);

      ctx.font = '8.5px "JetBrains Mono", monospace';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(String(vol), col1X + 3, y + 3);

      // 3. COB 2: Cumulated Order Book Staircase Bar + Cumulated Number
      if (cob2W > 0) {
        const w2 = Math.max(2, Math.min(cob2W - 2, ((cumVol || vol) / maxCumVol) * (cob2W - 2)));
        ctx.fillStyle = barCol;
        ctx.fillRect(col2X + 1, y - rowH / 2 + 0.5, w2, rowH - 1);

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(String(cumVol || vol), col2X + 3, y + 3);
      }
    }

    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════════════════
     WHALE INFLOW RADAR: DISCREET, STREAMLINED INSTITUTIONAL ALERT
     ══════════════════════════════════════════════════════════════════ */
  playWhaleInflowSound(vol, isBid) {
    if (this.isAudioMuted) return;
    try {
      const actx = this._getAudioContext();
      if (!actx) return;
      const isMega = vol >= 80.0;
      const now = actx.currentTime;

      const osc1 = actx.createOscillator();
      const osc2 = actx.createOscillator();
      const gain = actx.createGain();

      osc1.type = isMega ? 'sawtooth' : 'triangle';
      osc2.type = 'sine';

      const baseFreq = isBid ? (isMega ? 349.23 : 440.00) : (isMega ? 698.46 : 587.33);
      osc1.frequency.setValueAtTime(baseFreq, now);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 1.45, now + 0.15);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 1.95, now + 0.35);

      osc2.frequency.setValueAtTime(baseFreq * 0.5, now);
      osc2.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.35);

      const maxGain = isMega ? 0.28 : 0.18;
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(maxGain, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (isMega ? 0.65 : 0.40));

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(actx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + (isMega ? 0.65 : 0.40));
      osc2.stop(now + (isMega ? 0.65 : 0.40));
    } catch (e) {}
  }

  _detectSuddenWhalePlacements(snapshot, now) {
    if (!snapshot) return;

    // Strict Startup Grace Period: Silence alerts during first 8 seconds of load/refresh
    if (!this._appStartTime) this._appStartTime = now;
    if (now - this._appStartTime < 8000) return;

    // Strict Rate Limiting: Max 1 Whale Alert per 50 seconds to prevent any chart spam
    if (now - (this._lastWhaleAlertTime || 0) < 50000) return;

    // 1. Detect ONLY genuine real-time Stacking events (Wall reinforced by >= 100L in the last 2.5s)
    if (snapshot.spoof_events && snapshot.spoof_events.length > 0) {
      for (const sp of snapshot.spoof_events) {
        const delta = Math.abs(sp.delta_vol || sp.vol || 0);
        if (sp.type === 'STACKING' && delta >= 100.0 && (now - sp.timestamp < 3000)) {
          const alertId = `sp_${sp.price}_${sp.timestamp}`;
          if (!this._notifiedWhaleAlertIds.has(alertId)) {
            this._triggerWhaleAlert({
              id: alertId,
              type: 'STACKING',
              side: sp.side || (sp.side === 'ask' ? 'ask' : 'bid'),
              price: sp.price,
              vol: delta
            }, now);
            return;
          }
        }
      }
    }

    // 2. Detect single massive aggressive execution (>= 100L executed in the last 2.0s)
    if (snapshot.trades && snapshot.trades.length > 0) {
      for (const t of snapshot.trades) {
        if (t.volume >= 100.0) {
          const tMs = (t.timestamp < 1e11) ? t.timestamp * 1000 : t.timestamp;
          if (now - tMs < 2000) {
            const alertId = `tr_${t.id || tMs}_${t.price}`;
            if (!this._notifiedWhaleAlertIds.has(alertId)) {
              this._triggerWhaleAlert({
                id: alertId,
                type: 'WHALE_TRADE',
                side: t.side === 'sell' ? 'ask' : 'bid',
                price: t.price,
                vol: t.volume
              }, now);
              return;
            }
          }
        }
      }
    }
  }

  _triggerWhaleAlert(alertData, now) {
    const { id, side, price, vol } = alertData;
    if (!this._notifiedWhaleAlertIds) this._notifiedWhaleAlertIds = new Set();
    if (this._notifiedWhaleAlertIds.has(id)) return;
    this._notifiedWhaleAlertIds.add(id);
    this._lastWhaleAlertTime = now;

    if (this._notifiedWhaleAlertIds.size > 100) {
      this._notifiedWhaleAlertIds.clear();
      this._notifiedWhaleAlertIds.add(id);
    }

    // Set active alert state (auto-expires in 6 seconds)
    this._activeWhaleAlert = {
      ...alertData,
      time: now,
      expiresAt: now + 6000
    };

    // Only 1 localized ripple ping at NOW line (NO full-width laser line across screen!)
    this._whaleRadarPings = [{
      price,
      vol,
      side,
      time: now
    }];

    // Audio Alert
    if (now - (this._lastWhaleAlertSoundTime || 0) >= 4000) {
      this._lastWhaleAlertSoundTime = now;
      this.playWhaleInflowSound(vol, side === 'bid');
    }

    // Single Toast Notification (Strictly for >= 100L Mega Shark alerts)
    if (window.orderFlowApp && window.orderFlowApp.showToast) {
      const dirTxt = side === 'bid' ? '🟢 BELIAN' : '🔴 JUALAN';
      window.orderFlowApp.showToast(`📊 [LARGE ACTIVITY ≥100L | Keyakinan 85%] +${vol.toFixed(0)}L ${dirTxt} @ $${price.toFixed(2)} [Potensi Win: 90%+]`);
    }
  }

  _drawWhaleRadarBanner(ctx, now) {
    // Large center floating banner disabled to keep the Bookmap chart completely unobstructed!
    return;
  }

  _drawWhaleRadarPings(ctx, now) {
    if (!this._whaleRadarPings || this._whaleRadarPings.length === 0) return;
    ctx.save();
    this._whaleRadarPings = this._whaleRadarPings.filter(p => now - p.time < 5000);

    for (const p of this._whaleRadarPings) {
      const elapsed = now - p.time;
      const progress = elapsed / 5000;
      const py = this.priceToY(p.price);
      if (py < this.CHART_TOP || py > this.CHART_BOTTOM) continue;

      const px = this.NOW_X - 10;
      const isMega = p.vol >= 80.0;
      const rgb = isMega ? '244, 63, 94' : (p.side === 'bid' ? '0, 230, 118' : '255, 51, 102');

      // Localized subtle pulse ripples at NOW line (confined to 24px - does NOT cross the chart)
      ctx.setLineDash([]);
      for (let i = 0; i < 2; i++) {
        const ringProgress = (progress + i * 0.35) % 1.0;
        const radius = 6 + ringProgress * 22;
        const alpha = Math.max(0, (1 - ringProgress) * 0.6);

        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Compact Radar Beacon Tag at the right edge
      ctx.fillStyle = isMega ? '#ffd60a' : (p.side === 'bid' ? '#00e676' : '#ff3366');
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ─── Manual Analysis Drawing Tools (Horizontal Ray & Trendline) ─ */
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
        const y = this.priceToY(d.price);
        if (y < this.CHART_TOP || y > this.CHART_BOTTOM) continue;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = d.color || '#f59e0b';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, y);
        ctx.lineTo(this.CHART_RIGHT, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Right-edge tag
        ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
        ctx.fillRect(this.CHART_RIGHT - 74, y - 7, 70, 14);
        ctx.strokeStyle = d.color || '#f59e0b';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(this.CHART_RIGHT - 74, y - 7, 70, 14);
        ctx.fillStyle = d.color || '#f59e0b';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`RAY $${d.price.toFixed(2)}`, this.CHART_RIGHT - 39, y + 3.5);
      } else if (d.type === 'trend' && d.p1 && d.p2) {
        const y1 = this.priceToY(d.p1.price);
        const y2 = this.priceToY(d.p2.price);
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

  /* ─── World-Class Order Flow Measurement Ruler Tool ───────────── */
  _drawOrderFlowRuler(ctx) {
    if (!this.bmRulerActive) return;
    if (!this.bmRulerPointA) return;

    ctx.save();
    const pA = this.bmRulerPointA;
    const curX = this.bmRulerPointB ? this.bmRulerPointB.x : this.mouseX;
    const curY = this.bmRulerPointB ? this.bmRulerPointB.y : this.mouseY;

    if (curX < 0 || curY < 0) { ctx.restore(); return; }

    const curP = this.yToPrice(curY);
    const dPrice = curP - pA.price;
    const dPips = (dPrice * 10).toFixed(1); // 1 pip = $0.10 on Gold
    const isUp = dPrice >= 0;
    const boxCol = isUp ? '#00e676' : '#ff3366';
    const bgCol = isUp ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 51, 102, 0.12)';

    const rx = Math.min(pA.x, curX);
    const ry = Math.min(pA.y, curY);
    const rw = Math.max(1, Math.abs(curX - pA.x));
    const rh = Math.max(1, Math.abs(curY - pA.y));

    // Measurement Box
    ctx.fillStyle = bgCol;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = boxCol;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Anchor points
    ctx.beginPath();
    ctx.arc(pA.x, pA.y, 4, 0, Math.PI * 2);
    ctx.arc(curX, curY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Measurement Floating Badge
    const badgeTxt = `📏 ${isUp ? '+' : ''}$${dPrice.toFixed(2)} (${dPips} pips) | $${pA.price.toFixed(2)} → $${curP.toFixed(2)}`;
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    const tw = ctx.measureText(badgeTxt).width + 16;
    const bh = 18;
    const bx = Math.max(this.CHART_LEFT + 8, Math.min(this.CHART_RIGHT - tw - 8, rx + rw / 2 - tw / 2));
    const by = Math.max(this.CHART_TOP + 8, ry - bh - 4);

    ctx.fillStyle = 'rgba(6, 11, 22, 0.94)';
    ctx.fillRect(bx, by, tw, bh);
    ctx.strokeStyle = boxCol;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(bx, by, tw, bh);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeTxt, bx + tw / 2, by + bh / 2);

    ctx.restore();
  }

  /* ─── Interactive Top Bookmap Pro HUD Header & Imbalance Gauges ─ */
  _drawTopHUD(ctx, snapshot) {
    this.bmHudHitboxes = [];
    // Top-left "Pusatkan Semula" duplicate button removed because the permanent
    // bottom-center "🎯 PUSAT | + | -" dock handles centering cleanly without covering top-left chart area.
  }

  /* ─── Interactive Tooltip on Hover ────────────────────────────── */
  _renderTooltip() {
    const tt = document.getElementById('chartTooltip');
    if (!tt) return;

    if (!this.hoverTrade) {
      tt.style.display = 'none';
      return;
    }

    const t = this.hoverTrade;
    const buyV = t.buyV || (t.side === 'buy' ? t.volume : 0);
    const sellV = t.sellV || (t.side === 'sell' ? t.volume : 0);
    const isMajorBuy = buyV >= sellV;

    tt.style.display = 'block';
    tt.style.left = `${t.cx + t.r + 14}px`;
    tt.style.top  = `${t.cy - 38}px`;

    tt.innerHTML = `
      <div style="font-weight:700; color:${isMajorBuy ? '#00e676' : '#ff3366'}; border-bottom:1px solid #1e293b; padding-bottom:4px; margin-bottom:6px; font-size:12px;">
        ${isMajorBuy ? '▲ AGGRESSIVE BUY' : '▼ AGGRESSIVE SELL'}
        ${t.is_large ? ' &nbsp;🐋 WHALE' : ''}
      </div>
      <div style="display:grid; grid-template-columns:auto auto; gap:4px 18px; font-size:11px; font-family:'JetBrains Mono',monospace;">
        <span style="color:#64748b">Harga:</span><b style="color:#fff">$${t.price.toFixed(2)}</b>
        <span style="color:#64748b">Jumlah Saiz:</span><b style="color:#ffb703">${t.volume.toFixed(1)} Lots</b>
        <span style="color:#00e676">Beli (Ask Lift):</span><b>${buyV.toFixed(1)} Lots</b>
        <span style="color:#ff3366">Jual (Bid Hit):</span><b>${sellV.toFixed(1)} Lots</b>
        <span style="color:#64748b">Masa:</span><span style="color:#94a3b8">${new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</span>
      </div>`;
  }

  _drawAutoTrendlines(ctx, rawCandles) {
    if (this.showAutoTrendline === false || !rawCandles || rawCandles.length < 8) return;
    const candles = rawCandles.slice(-40);
    const n = candles.length;
    const radius = 2;
    const highs = [];
    const lows = [];

    for (let i = radius; i < n - radius; i++) {
      const c = candles[i];
      let isH = true, isL = true;
      for (let j = 1; j <= radius; j++) {
        if (candles[i - j].high >= c.high || candles[i + j].high > c.high) isH = false;
        if (candles[i - j].low <= c.low || candles[i + j].low < c.low) isL = false;
      }
      if (isH) highs.push({ t: c.time, price: c.high, idx: i });
      if (isL) lows.push({ t: c.time, price: c.low, idx: i });
    }

    ctx.save();

    // 1. Resistance Line
    if (highs.length >= 2) {
      const p2 = highs[highs.length - 1];
      let p1 = null;
      for (let k = highs.length - 2; k >= 0; k--) {
        if (highs[k].price >= p2.price) { p1 = highs[k]; break; }
      }
      if (!p1 && highs.length >= 2) p1 = highs[highs.length - 2];

      if (p1 && p2 && p2.idx > p1.idx) {
        const x1 = this.timeToX(p1.t * 1000);
        const y1 = this.priceToY(p1.price);
        const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
        const lastC = candles[n - 1];
        const projPriceNow = p1.price + slope * (n - 1 - p1.idx);
        const projPriceRight = p1.price + slope * (n + 5 - p1.idx);

        const xRight = this.CHART_RIGHT;
        const yRight = this.priceToY(projPriceRight);

        if (x1 >= this.CHART_LEFT - 100 && xRight <= this.CHART_RIGHT + 50) {
          let touches = 0;
          for (let i = p1.idx; i < n; i++) {
            const lp = p1.price + slope * (i - p1.idx);
            if (Math.abs(candles[i].high - lp) <= 0.45) touches++;
          }

          const isBreakout = lastC && lastC.close > projPriceNow + 0.20;

          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = isBreakout ? '#00e676' : 'rgba(244, 63, 94, 0.75)';
          ctx.lineWidth = isBreakout ? 1.8 : 1.3;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(xRight, yRight);
          ctx.stroke();

          const badgeTxt = isBreakout ? `⚡ RES BREAKOUT $${lastC.close.toFixed(2)}` : `📐 TL RESIS (${touches}x) $${projPriceNow.toFixed(2)}`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(badgeTxt).width + 8;
          const bx = Math.max(this.CHART_LEFT + 10, xRight - tw - 6);
          const by = Math.max(this.CHART_TOP + 15, Math.min(this.CHART_BOTTOM - 15, yRight));

          ctx.fillStyle = isBreakout ? 'rgba(0, 230, 118, 0.22)' : 'rgba(244, 63, 94, 0.22)';
          ctx.fillRect(bx, by - 7, tw, 14);
          ctx.strokeStyle = isBreakout ? '#00e676' : '#f43f5e';
          ctx.lineWidth = 0.8;
          ctx.strokeRect(bx, by - 7, tw, 14);
          ctx.fillStyle = isBreakout ? '#00e676' : '#fca5a5';
          ctx.textAlign = 'left';
          ctx.fillText(badgeTxt, bx + 4, by + 3.5);
        }
      }
    }

    // 2. Support Line
    if (lows.length >= 2) {
      const p2 = lows[lows.length - 1];
      let p1 = null;
      for (let k = lows.length - 2; k >= 0; k--) {
        if (lows[k].price <= p2.price) { p1 = lows[k]; break; }
      }
      if (!p1 && lows.length >= 2) p1 = lows[lows.length - 2];

      if (p1 && p2 && p2.idx > p1.idx) {
        const x1 = this.timeToX(p1.t * 1000);
        const y1 = this.priceToY(p1.price);
        const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
        const lastC = candles[n - 1];
        const projPriceNow = p1.price + slope * (n - 1 - p1.idx);
        const projPriceRight = p1.price + slope * (n + 5 - p1.idx);

        const xRight = this.CHART_RIGHT;
        const yRight = this.priceToY(projPriceRight);

        if (x1 >= this.CHART_LEFT - 100 && xRight <= this.CHART_RIGHT + 50) {
          let touches = 0;
          for (let i = p1.idx; i < n; i++) {
            const lp = p1.price + slope * (i - p1.idx);
            if (Math.abs(candles[i].low - lp) <= 0.45) touches++;
          }

          const isBreakdown = lastC && lastC.close < projPriceNow - 0.20;

          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = isBreakdown ? '#ff3366' : 'rgba(0, 240, 255, 0.75)';
          ctx.lineWidth = isBreakdown ? 1.8 : 1.3;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(xRight, yRight);
          ctx.stroke();

          const badgeTxt = isBreakdown ? `⚡ SUPP BREAKDOWN $${lastC.close.toFixed(2)}` : `📐 TL SUPP (${touches}x) $${projPriceNow.toFixed(2)}`;
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(badgeTxt).width + 8;
          const bx = Math.max(this.CHART_LEFT + 10, xRight - tw - 6);
          const by = Math.max(this.CHART_TOP + 15, Math.min(this.CHART_BOTTOM - 15, yRight));

          ctx.fillStyle = isBreakdown ? 'rgba(255, 51, 102, 0.22)' : 'rgba(0, 240, 255, 0.22)';
          ctx.fillRect(bx, by - 7, tw, 14);
          ctx.strokeStyle = isBreakdown ? '#ff3366' : '#00f0ff';
          ctx.lineWidth = 0.8;
          ctx.strokeRect(bx, by - 7, tw, 14);
          ctx.fillStyle = isBreakdown ? '#ff3366' : '#7dd3fc';
          ctx.textAlign = 'left';
          ctx.fillText(badgeTxt, bx + 4, by + 3.5);
        }
      }
    }

    ctx.restore();
  }


  _drawSnrValidZones(ctx, snrZones) {
    if (!snrZones || snrZones.length === 0) return;
    const curP = this._currentPrice || 0;

    // Filter to only the single closest RES and SUP zone to avoid clutter
    const resZones = snrZones.filter(z => z.type === 'RESISTANCE' && z.zone_low >= curP - 0.5);
    resZones.sort((a, b) => a.zone_low - b.zone_low);
    const supZones = snrZones.filter(z => z.type !== 'RESISTANCE' && z.zone_high <= curP + 0.5);
    supZones.sort((a, b) => b.zone_high - a.zone_high);

    const activeZones = [];
    if (resZones.length > 0) activeZones.push(resZones[0]);
    if (supZones.length > 0) activeZones.push(supZones[0]);

    for (const z of activeZones) {
      const yTop = this.priceToY(z.zone_high);
      const yBot = this.priceToY(z.zone_low);
      if (yBot < this.CHART_TOP || yTop > this.CHART_BOTTOM) continue;

      const isRes = z.type === 'RESISTANCE';
      const col = isRes ? '#f43f5e' : '#00e676';
      const bgCol = isRes ? 'rgba(244, 63, 94, 0.06)' : 'rgba(0, 230, 118, 0.06)';
      const h = Math.max(6, Math.abs(yBot - yTop));
      const y = Math.min(yTop, yBot);

      // Subtle Shaded Zone Box
      ctx.fillStyle = bgCol;
      ctx.fillRect(this.CHART_LEFT, y, this.CHART_WIDTH, h);

      // Delicate Dotted Outline
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.0;
      ctx.strokeRect(this.CHART_LEFT, y, this.CHART_WIDTH, h);
      ctx.restore();

      // Clean, Sleek Left Badge with Unified LEFT Lane Anti-Collision Slotting
      const badgeTxt = isRes ? `SMR RES $${z.zone_high.toFixed(2)}` : `SMR SUP $${z.zone_low.toFixed(2)}`;
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      const bw = ctx.measureText(badgeTxt).width + 10;
      const bx = this.CHART_LEFT + 8;
      const resolvedSmrY = this._resolveNonOverlappingY(y + h / 2, 14, 18, 'LEFT');
      const by = resolvedSmrY - 7;

      ctx.fillStyle = 'rgba(6, 12, 22, 0.90)';
      ctx.fillRect(bx, by, bw, 14);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw, 14);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeTxt, bx + 5, resolvedSmrY);
    }
  }

}
