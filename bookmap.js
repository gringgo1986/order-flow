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
    this.timeWindowMs = 60000;

    // Viewport dimensions
    this.width  = 0;
    this.height = 0;

    // Mouse & Tooltip state
    this.mouseX = -1;
    this.mouseY = -1;
    this.hoverTrade = null;

    // Controls & Toggles
    this.bubbleZoom = 1.0;
    this.showVolumeZones = true;
    this.showVWAP = true;
    this.showPositions = true;
    this.showSessionLevels = true;
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
    this.bmShowBidAskChannel = false; // Default OFF so 1 crisp stepped price line is shown
    this.bmShowWhaleLabels = true;    // Default ON so Whale & Jerung lot callouts are clearly visible
    this.bmShowSharkWalls = true;     // Highlight top resting Shark/Jerung limit walls directly on Heatmap
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
    this.bmContrastMode = 'MED'; // 'AUTO' | 'LOW' | 'MED' | 'HIGH'
    this.bmShowSweeps = true;    // Liquidity Sweeps & Voids Visualizer
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

    this._setupResize();
    this._setupInteractions();
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

  setTimeframe(tf) {
    const tfMap = {
      'M1':  60000,
      'M5':  300000,
      'M15': 900000,
      'M30': 1800000,
      'H1':  3600000,
      'H4':  14400000
    };
    tf = (tf || 'M1').toUpperCase();
    if (tfMap[tf]) {
      this.timeframe = tf;
      this.timeWindowMs = tfMap[tf];
    }
  }

  /* ─── HiDPI Responsive Canvas Resize ───────────────────────────── */
  _setupResize() {
    const handleResize = () => {
      if (!this.canvas || !this.canvas.parentElement) return;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      this.width  = Math.max(rect.width, 600);
      this.height = Math.max(rect.height, 400);

      this.canvas.width  = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.canvas.style.width  = this.width + 'px';
      this.canvas.style.height = this.height + 'px';

      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    window.addEventListener('resize', handleResize);
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

  /* ─── Layout Constants ─────────────────────────────────────────── */
  get LEFT_AXIS_W() { return 54; }
  get COB_WIDTH()   { return 108; }
  get HIST_HEIGHT() { return 56; }
  get TOP_PADDING() { return 28; }
  get CHART_TOP()   { return this.TOP_PADDING; }
  get CHART_BOTTOM(){ return this.height - this.HIST_HEIGHT; }
  get CHART_LEFT()  { return this.LEFT_AXIS_W; }
  get CHART_RIGHT() { return this.width - this.COB_WIDTH; }
  get CHART_WIDTH() { return this.CHART_RIGHT - this.CHART_LEFT; }
  get CHART_HEIGHT(){ return this.CHART_BOTTOM - this.CHART_TOP; }
  get NOW_X()       { return this.CHART_LEFT + Math.floor(this.CHART_WIDTH * 0.84); }
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
    const effectiveNow = now - (this.timeOffsetMs || 0);
    const windowStart = effectiveNow - this.timeWindowMs;
    return this.CHART_LEFT + ((timestamp - windowStart) / this.timeWindowMs) * this.HIST_TIME_W;
  }

  xToTime(x, now) {
    const effectiveNow = now - (this.timeOffsetMs || 0);
    const windowStart = effectiveNow - this.timeWindowMs;
    const progress = (x - this.CHART_LEFT) / Math.max(1, this.HIST_TIME_W);
    return windowStart + progress * this.timeWindowMs;
  }

  /* ─── Bookmap Multi-Palette High-Definition Thermal Color Engine ── */
  getThermalColor(vol) {
    let minCut = 3.0;
    if (this.bmWallFilterOnly) {
      minCut = 28.0;
    } else if (this.bmContrastMode === 'HIGH') {
      minCut = 32.0; // High contrast: only institutional walls
    } else if (this.bmContrastMode === 'MED') {
      minCut = 12.0; // Medium contrast: filters retail noise, crisp view
    } else if (this.bmContrastMode === 'LOW') {
      minCut = 3.0;  // Low contrast: all subtle resting depth
    } else if (this.bmContrastMode === 'AUTO') {
      minCut = this._autoMinCut || 12.0;
    }

    if (vol < minCut) return null;

    let stops;
    if (this.bmPaletteMode === 'cyber') {
      stops = [
        [3.0,   10,  10,  28, 0.22],  // Subtle Deep Indigo (Ambient)
        [18.0,  28,  20,  82, 0.44],  // Muted Violet
        [30.0,  52,  82, 210, 0.68],  // Cyber Blue ($0.50 shelf)
        [45.0,  56, 189, 248, 0.82],  // Neon Aqua
        [60.0,   0, 245, 212, 0.90],  // Hyper Mint ($1.00 wall)
        [80.0, 247,  37, 133, 0.95],  // Laser Magenta Major Wall
        [105.0, 255, 240, 250, 0.98]  // Bright Core
      ];
    } else if (this.bmPaletteMode === 'gold') {
      stops = [
        [3.0,   14,  11,   6, 0.22],  // Subtle Dark Bronze (Ambient)
        [18.0,  58,  38,  10, 0.44],  // Muted Copper
        [30.0, 145,  90,  14, 0.68],  // Warm Amber ($0.50 shelf)
        [45.0, 217, 155,  18, 0.82],  // Rich Gold
        [60.0, 250, 204,  21, 0.90],  // Pure Gold ($1.00 wall)
        [80.0, 249, 115,  22, 0.95],  // Solar Orange Major Wall
        [105.0, 225,  29,  72, 0.98]  // Ruby Red Institutional Wall
      ];
    } else {
      // Classic Bookmap Global+ 7.5 High-Contrast Thermal Spectrum (Zebra-Free Smooth Calibration)
      stops = [
        [3.0,    6,  18,  38, 0.22],  // Calm Obsidian Navy (Ambient 10-16L)
        [17.0,   9,  42,  82, 0.40],  // Deep Ocean Blue
        [26.0,   0, 119, 182, 0.62],  // Steel Blue Shoulder
        [36.0,   0, 195, 235, 0.76],  // Cyan Shelf ($0.50 barrier)
        [52.0, 255, 205,  15, 0.88],  // Radiant Gold ($1.00 barrier)
        [72.0, 255, 115,   0, 0.94],  // Fiery Orange Major Wall
        [92.0, 229,   9,  36, 0.97],  // Vivid Crimson Institutional Wall
        [115.0, 255, 245, 215, 0.98]  // Warm Gold-White Super Wall
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
  render(snapshot) {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    const now = Date.now();
    this._latestSnapshot = snapshot;

    // Maintain 4-second rolling buffer of order_book for Pulling & Stacking (+/- Lots)
    if (snapshot.order_book) {
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
        const medIdx = Math.floor(vols.length * 0.50);
        this._autoMinCut = Math.max(6.0, Math.min(26.0, vols[medIdx] || 12.0));
      }
    }

    // World-Class Liquidity Sweeps & Voids Tracker
    if (this.bmShowSweeps !== false && snapshot.order_book) {
      this._detectLiquiditySweeps(snapshot, now);
    }

    /* ── Smooth Price Center Tracking + Auto-Adaptive Volatility Span ── */
    const currentPrice = snapshot.last_price || snapshot.bid || (this.minPrice + this.maxPrice) / 2;
    const priceVel = snapshot.price_velocity_1s !== undefined ? snapshot.price_velocity_1s : 0.0;
    const isHighVolat = priceVel >= 0.40 || (snapshot.news_shield && snapshot.news_shield.is_danger);
    const targetHalfSpan = isHighVolat ? Math.max(7.5, (this.bmHalfSpan || 4.5) * 1.45) : (this.bmHalfSpan || 4.5);
    const halfSpan = this._isDragging ? (this.bmHalfSpan || 4.5) : targetHalfSpan;
    const centerP = currentPrice + (this.priceOffset || 0);
    this._targetMin = centerP - halfSpan;
    this._targetMax = centerP + halfSpan;

    if (this._isDragging) {
      this.minPrice = this._targetMin;
      this.maxPrice = this._targetMax;
    } else {
      this.minPrice += (this._targetMin - this.minPrice) * 0.18;
      this.maxPrice += (this._targetMax - this.maxPrice) * 0.18;
    }

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
    this._drawHeatmap(ctx, snapshot.heatmap || [], snapshot.order_book, now, snapshot.spoof_events || []);

    /* ── 4. Chart Gridlines & "NOW" Time Line Separator ── */
    this._drawGrid(ctx, now);

    /* ── 5. Bottom Stacked Volume Histogram + Live CVD Curve Overlay ── */
    this._drawHistogram(ctx, snapshot.trades || [], now);

    /* ── 6. Best Bid & Best Ask Spread Channel + Stepped Price Line ── */
    this._drawSteppedPriceLine(ctx, snapshot.trades || [], now, currentPrice, snapshot.spread);

    /* ── 7. Bookmap Split 3D Spherical Bubbles + Whale Callout Labels ── */
    this._drawSplitBubbles(ctx, snapshot.trades || [], now);

    /* ── 8. Buyer & Seller Volume Zones ── */
    if (this.showVolumeZones) {
      this._drawVolumeZones(ctx, snapshot.trades || [], currentPrice);
    }

    /* ── 8B. Session VWAP & StdDev Bands ── */
    if (this.showVWAP && snapshot.vwap && snapshot.vwap.value > 0) {
      this._drawVWAP(ctx, snapshot.vwap);
    }

    /* ── 8C. Active Positions & Visual SL / TP on Chart ── */
    if (this.showPositions && snapshot.positions && snapshot.positions.length > 0) {
      this._drawPositionsOnChart(ctx, snapshot.positions, currentPrice);
    }

    /* ── 8D. CVD Divergence Alert Banner ── */
    if (snapshot.divergence) {
      this._drawDivergenceAlert(ctx, snapshot.divergence);
    }

    /* ── 8E. Trapped Traders (Buyers / Sellers) Badges ── */
    if (snapshot.trapped_traders && snapshot.trapped_traders.length > 0) {
      this._drawTrappedTraders(ctx, snapshot.trapped_traders);
    }

    /* ── 8F. Prop-Firm Asian / London / NY Session High-Low, PDH/PDL & Sweep Markers ── */
    if (this.showSessionLevels && snapshot.sessions) {
      this._drawSessionLevels(ctx, snapshot.sessions);
    }

    /* ── 8G. Composite Session Volume Profile (SVP: dPOC, VAH/VAL 70%, LVN) ── */
    if (this.showSVP && snapshot.session_vp) {
      this._drawSessionVolumeProfile(ctx, snapshot.session_vp);
    }

    /* ── 8H. Real-Time Institutional Iceberg & Absorption Detector ── */
    if (this.showIcebergs && snapshot.icebergs && snapshot.icebergs.length > 0) {
      this._drawIcebergOrders(ctx, snapshot.icebergs);
    }

    /* ── 8I. Real-Time Institutional Order Flow Buy/Sell Signals (Strict Location-First) ── */
    if (this.bmShowSignals !== false) {
      this._drawOrderFlowSignals(ctx, snapshot, now, currentPrice);
    }

    /* ── 9. Current Price Crosshair & Interactive Cursor Depth Inspector ── */
    this._drawCurrentPriceLine(ctx, currentPrice, snapshot.order_book, now);

    /* ── 10. Left Price Scale & Ticks ── */
    this._drawPriceAxis(ctx);

    /* ── 11. Right High-Resolution COB (Current Order Book + Pulling/Stacking) ── */
    this._drawCOB(ctx, snapshot.order_book, currentPrice, snapshot.bid, snapshot.ask);

    /* ── 12. Interactive Manual Drawing Tools Overlay (Ray & Trend) ── */
    this._drawManualDrawings(ctx);

    /* ── 12B. World-Class Order Flow Measurement Ruler Tool ── */
    this._drawOrderFlowRuler(ctx);

    /* ── 13. Interactive Top Bookmap Pro HUD Header ── */
    this._drawTopHUD(ctx, snapshot);

    /* ── 13. Interactive Tooltip ── */
    this._renderTooltip();
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

    // Draw Iconic Bookmap "NOW" Vertical Laser Time Line (Separating History Tape vs Live Resting Book Projection)
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.4;
    ctx.shadowColor = '#fbbf24';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(this.NOW_X, this.CHART_TOP);
    ctx.lineTo(this.NOW_X, this.CHART_BOTTOM);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);

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
    const pxPerStep  = Math.max(2.6, Math.abs(this.priceToY(0) - this.priceToY(PRICE_STEP)));
    const drawH = pxPerStep + 0.85;

    // 1. Historical Heatmap (CHART_LEFT -> NOW_X)
    if (history && history.length >= 2) {
      for (let i = 0; i < history.length; i++) {
        const snap     = history[i];
        const nextSnap = history[i + 1];

        const x1 = this.timeToX(snap.timestamp, now);
        const x2 = nextSnap ? this.timeToX(nextSnap.timestamp, now) : this.NOW_X;

        if (x2 < this.CHART_LEFT || x1 > this.NOW_X) continue;

        const drawX = Math.max(this.CHART_LEFT, x1);
        const drawW = Math.max(2.4, Math.min(this.NOW_X, x2) - drawX + 1.2);

        const bids = snap.bids || {};
        for (const priceKey of Object.keys(bids)) {
          const price = +priceKey;
          const y     = this.priceToY(price);
          if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
          const color = this.getThermalColor(bids[priceKey]);
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(drawX, y - drawH * 0.5, drawW, drawH);
        }

        const asks = snap.asks || {};
        for (const priceKey of Object.keys(asks)) {
          const price = +priceKey;
          const y     = this.priceToY(price);
          if (y < this.CHART_TOP - 4 || y > this.CHART_BOTTOM + 4) continue;
          const color = this.getThermalColor(asks[priceKey]);
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(drawX, y - drawH * 0.5, drawW, drawH);
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

      // Highlight Top Institutional Shark/Jerung Limit Walls directly on the Heatmap & Projection Zone
      if (this.bmShowSharkWalls !== false) {
        const pickTopWalls = (bookDict, minVol, maxCount) => {
          const candidates = [];
          for (const [pKey, v] of Object.entries(bookDict)) {
            const p = +pKey;
            const wy = this.priceToY(p);
            if (wy < this.CHART_TOP + 16 || wy > this.CHART_BOTTOM - 16) continue;
            if (v >= minVol) candidates.push({ p, v, wy });
          }
          candidates.sort((a, b) => b.v - a.v);
          const selected = [];
          for (const cand of candidates) {
            if (selected.every(s => Math.abs(s.wy - cand.wy) >= 20)) {
              selected.push(cand);
              if (selected.length >= maxCount) break;
            }
          }
          return selected;
        };

        const topAskWalls = pickTopWalls(asks, 50, 3);
        const topBidWalls = pickTopWalls(bids, 50, 3);

        const drawSharkWallOverlay = (wall, isAsk, rankIdx) => {
          const wy = wall.wy;
          const isMega = wall.v >= 90;
          const col = isAsk ? (isMega ? '#ff2a55' : '#fb923c') : (isMega ? '#00f59b' : '#facc15');
          const glowBg = isAsk ? 'rgba(255, 42, 85, 0.16)' : 'rgba(0, 245, 155, 0.16)';

          // 1. Subtle glowing laser guide across the heatmap ribbon
          ctx.fillStyle = glowBg;
          ctx.fillRect(this.CHART_LEFT, wy - drawH * 0.55, this.CHART_WIDTH, drawH * 1.1);

          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = isMega ? 1.5 : 1.0;
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, wy);
          ctx.lineTo(this.CHART_RIGHT, wy);
          ctx.stroke();
          ctx.restore();

          // 2. Sleek Compact Shark Wall Tag (Only draw full pill for #1 Wall, compact tag for others)
          if (rankIdx === 0) {
            const sideLbl = isAsk ? 'SELL LIMIT' : 'BUY LIMIT';
            const badgeTxt = `🦈 ${Math.round(wall.v)}L ${sideLbl} @ $${wall.p.toFixed(2)}`;
            ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
            const tw = ctx.measureText(badgeTxt).width + 10;
            const bh = 14;
            const bx = Math.max(this.CHART_LEFT + 12, this.NOW_X - tw - 8);
            const by = wy - bh / 2;

            ctx.fillStyle = isAsk ? 'rgba(28, 6, 14, 0.88)' : 'rgba(4, 24, 16, 0.88)';
            ctx.fillRect(bx, by, tw, bh);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.0;
            ctx.strokeRect(bx, by, tw, bh);

            ctx.fillStyle = col;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(badgeTxt, bx + 5, wy);
          }

          // 3. Compact tag inside Projection Zone (NOW_X -> CHART_RIGHT)
          if (rankIdx < 2) {
            const pTxt = `🦈 ${Math.round(wall.v)}L`;
            ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
            const ptw = Math.min(projW - 6, ctx.measureText(pTxt).width + 8);
            ctx.fillStyle = 'rgba(6, 10, 18, 0.90)';
            ctx.fillRect(projX + 4, wy - 7, ptw, 14);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.strokeRect(projX + 4, wy - 7, ptw, 14);
            ctx.fillStyle = col;
            ctx.fillText(pTxt, projX + 8, wy + 1);
          }
        };

        topAskWalls.forEach((w, idx) => drawSharkWallOverlay(w, true, idx));
        topBidWalls.forEach((w, idx) => drawSharkWallOverlay(w, false, idx));
      }

      // 3. Spoofing Pulling & Stacking Detection Badges on Heatmap
      if (spoofEvents && spoofEvents.length > 0) {
        for (const sp of spoofEvents) {
          if (now - sp.timestamp > 14000) continue; // Show for 14 seconds
          const sy = this.priceToY(sp.price);
          if (sy < this.CHART_TOP + 14 || sy > this.CHART_BOTTOM - 14) continue;

          const isPull = sp.type === 'PULLING';
          const col = isPull ? '#f43f5e' : '#00f0ff';
          const bgCol = isPull ? 'rgba(38, 8, 16, 0.94)' : 'rgba(4, 28, 38, 0.94)';

          // Flashing laser dashed line
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, sy);
          ctx.lineTo(this.CHART_RIGHT, sy);
          ctx.stroke();
          ctx.restore();

          // Badge pill
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const tw = ctx.measureText(sp.badge).width + 12;
          const bx = this.CHART_LEFT + 14;
          const by = sy - 8;

          ctx.fillStyle = bgCol;
          ctx.fillRect(bx, by, tw, 16);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.1;
          ctx.strokeRect(bx, by, tw, 16);
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(sp.badge, bx + 6, by + 8);
        }
      }

      // 4. World-Class Liquidity Sweeps & Voids Visualizer
      if (this.bmShowSweeps !== false && this._bmSweepEvents && this._bmSweepEvents.length > 0) {
        for (const sw of this._bmSweepEvents) {
          if (now - sw.time > 45000) continue; // Show for 45s
          const wy = this.priceToY(sw.price);
          if (wy < this.CHART_TOP + 14 || wy > this.CHART_BOTTOM - 14) continue;

          const isBuySweep = sw.bias === 'BUY_SWEEP';
          const col = isBuySweep ? '#00f0ff' : '#ff0055';
          const bgCol = isBuySweep ? 'rgba(0, 32, 45, 0.94)' : 'rgba(45, 0, 16, 0.94)';

          // Flashing animated neon laser sweep line across full chart
          ctx.save();
          ctx.setLineDash([8, 4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.4;
          ctx.shadowColor = col;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.moveTo(this.CHART_LEFT, wy);
          ctx.lineTo(this.CHART_RIGHT, wy);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.restore();

          // High-Impact Pill Badge
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          const badgeTxt = sw.badge;
          const tw = ctx.measureText(badgeTxt).width + 14;
          const bx = this.CHART_LEFT + 16;
          const by = wy - 8;

          ctx.fillStyle = bgCol;
          ctx.fillRect(bx, by, tw, 16);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.2;
          ctx.strokeRect(bx, by, tw, 16);
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeTxt, bx + 7, by + 8);
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
            if (!this._bmSweepEvents.some(sw => Math.abs(sw.price - p) < 0.25 && now - sw.time < 35000)) {
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
            if (!this._bmSweepEvents.some(sw => Math.abs(sw.price - p) < 0.25 && now - sw.time < 35000)) {
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

      this._bmSweepEvents = this._bmSweepEvents.filter(sw => now - sw.time < 60000).slice(-6);
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

    const halfSpread = Math.max(0.08, (currentSpread || 0.24) * 0.5);

    // 1. Optional Bookmap Best Bid (Green) & Best Ask (Red) Spread Channel
    if (this.bmShowBidAskChannel) {
      ctx.lineWidth = 1.2;
      for (let i = 0; i < trades.length - 1; i++) {
        const t1 = trades[i];
        const t2 = trades[i + 1];
        const x1 = this.timeToX(t1.timestamp, now);
        const x2 = this.timeToX(t2.timestamp, now);
        if (x2 < this.CHART_LEFT - 10 || x1 > this.NOW_X + 5) continue;

        const askY1 = this.priceToY(t1.price + halfSpread);
        const askY2 = this.priceToY(t2.price + halfSpread);
        const bidY1 = this.priceToY(t1.price - halfSpread);
        const bidY2 = this.priceToY(t2.price - halfSpread);

        // Subtle spread ribbon fill
        ctx.fillStyle = 'rgba(0, 240, 255, 0.04)';
        ctx.fillRect(x1, askY1, Math.max(1, x2 - x1), Math.max(1, bidY1 - askY1));

        // Best Ask step (Red)
        ctx.strokeStyle = 'rgba(255, 51, 102, 0.68)';
        ctx.beginPath();
        ctx.moveTo(x1, askY1);
        ctx.lineTo(x2, askY1);
        ctx.lineTo(x2, askY2);
        ctx.stroke();

        // Best Bid step (Green)
        ctx.strokeStyle = 'rgba(0, 230, 118, 0.68)';
        ctx.beginPath();
        ctx.moveTo(x1, bidY1);
        ctx.lineTo(x2, bidY1);
        ctx.lineTo(x2, bidY2);
        ctx.stroke();
      }
    }

    // 2. Center Stepped Last Trade Price Line
    ctx.lineWidth = 2.0;
    ctx.lineCap   = 'square';

    for (let i = 0; i < trades.length - 1; i++) {
      const t1 = trades[i];
      const t2 = trades[i + 1];

      const x1 = this.timeToX(t1.timestamp, now);
      const x2 = this.timeToX(t2.timestamp, now);
      if (x2 < this.CHART_LEFT - 10 || x1 > this.NOW_X + 10) continue;

      const y1 = this.priceToY(t1.price);
      const y2 = this.priceToY(t2.price);
      const isUp = t2.price >= t1.price;

      ctx.strokeStyle = isUp ? '#00e676' : '#ff3366';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y1);
      ctx.stroke();

      if (Math.abs(y2 - y1) > 0.4) {
        ctx.beginPath();
        ctx.moveTo(x2, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // Micro-Absorption Beacon (🛡️) on Stepped Price Line
      const isAbsorptionBuy = (t2.buy_vol >= 10.0 && t2.price <= t1.price);
      const isAbsorptionSell = (t2.sell_vol >= 10.0 && t2.price >= t1.price);
      if (isAbsorptionBuy || isAbsorptionSell) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x2, y2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = isAbsorptionBuy ? '#00f0ff' : '#ff0077';
        ctx.shadowColor = isAbsorptionBuy ? '#00f0ff' : '#ff0077';
        ctx.shadowBlur = 5;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.0;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.restore();
      }
    }

    if (trades.length > 0 && currentPrice) {
      const lastT = trades[trades.length - 1];
      const lx = Math.min(this.NOW_X, this.timeToX(lastT.timestamp, now));
      const ly = this.priceToY(lastT.price);
      const cy = this.priceToY(currentPrice);
      const isUp = currentPrice >= lastT.price;

      ctx.strokeStyle = isUp ? '#00e676' : '#ff3366';
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(this.NOW_X, ly);
      if (Math.abs(cy - ly) > 0.4) {
        ctx.lineTo(this.NOW_X, cy);
      }
      ctx.stroke();

      // Live Pulsing Beacon Dot at NOW_X
      ctx.beginPath();
      ctx.arc(this.NOW_X, cy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isUp ? '#00e676' : '#ff3366';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ─── Split 3D Spherical Bubbles with Whale Sound ─────────────── */
  _drawSplitBubbles(ctx, trades, now) {
    if (!trades || !trades.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.CHART_LEFT, this.CHART_TOP, this.CHART_WIDTH, this.CHART_HEIGHT);
    ctx.clip();

    this.hoverTrade = null;
    const drawnWhaleBadges = [];
    const sortedTrades = [...trades].sort((a, b) => a.volume - b.volume);

    for (const t of sortedTrades) {
      const cx = this.timeToX(t.timestamp, now);
      const cy = this.priceToY(t.price);

      if (cx < this.CHART_LEFT - 60 || cx > this.CHART_RIGHT + 60) continue;
      if (cy < this.CHART_TOP - 20  || cy > this.CHART_BOTTOM + 20) continue;

      const baseR = Math.sqrt(t.volume) * 5.2 * this.bubbleZoom;
      const r = Math.min(46, Math.max(7.5, baseR));

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

      // Outer Glow for Whale Trades
      if (r >= 16) {
        const glowR = r * 1.8;
        const glow = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, glowR);
        const glowColor = buyRatio >= 0.5 ? 'rgba(0, 230, 118, 0.22)' : 'rgba(255, 51, 102, 0.22)';
        glow.addColorStop(0, glowColor);
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      }

      const hx = cx - r * 0.32;
      const hy = cy - r * 0.32;

      if (buyRatio >= 0.92) {
        const gBuy = ctx.createRadialGradient(hx, hy, r * 0.05, cx, cy, r);
        gBuy.addColorStop(0.00, '#e8fdf0');
        gBuy.addColorStop(0.18, '#4ade80');
        gBuy.addColorStop(0.52, '#16a34a');
        gBuy.addColorStop(0.82, '#14532d');
        gBuy.addColorStop(1.00, '#042a15');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = gBuy;
        ctx.fill();
      } else if (buyRatio <= 0.08) {
        const gSell = ctx.createRadialGradient(hx, hy, r * 0.05, cx, cy, r);
        gSell.addColorStop(0.00, '#fee2e2');
        gSell.addColorStop(0.18, '#f87171');
        gSell.addColorStop(0.52, '#dc2626');
        gSell.addColorStop(0.82, '#7f1d1d');
        gSell.addColorStop(1.00, '#3b0707');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = gSell;
        ctx.fill();
      } else {
        const splitY = cy - r + (2 * r * (1 - buyRatio));

        // Upper Buy Hemisphere
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.rect(cx - r - 2, cy - r - 2, 2 * r + 4, splitY - (cy - r) + 2);
        ctx.clip('evenodd');
        const gBuy = ctx.createRadialGradient(hx, hy, r * 0.05, cx, cy, r);
        gBuy.addColorStop(0.00, '#dcfce7');
        gBuy.addColorStop(0.25, '#22c55e');
        gBuy.addColorStop(0.60, '#15803d');
        gBuy.addColorStop(1.00, '#052e16');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = gBuy;
        ctx.fill();
        ctx.restore();

        // Lower Sell Hemisphere
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.rect(cx - r - 2, splitY, 2 * r + 4, (cy + r) - splitY + 2);
        ctx.clip('evenodd');
        const gSell = ctx.createRadialGradient(hx, hy, r * 0.05, cx, cy, r);
        gSell.addColorStop(0.00, '#fee2e2');
        gSell.addColorStop(0.25, '#ef4444');
        gSell.addColorStop(0.60, '#b91c1c');
        gSell.addColorStop(1.00, '#450a0a');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = gSell;
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.9, splitY);
        ctx.lineTo(cx + r * 0.9, splitY);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.70)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Specular highlight gloss
      ctx.save();
      const glW = r * 0.44;
      const glH = r * 0.22;
      const glX = cx - r * 0.28;
      const glY = cy - r * 0.32;
      ctx.beginPath();
      ctx.ellipse(glX, glY, glW, glH, -0.42, 0, Math.PI * 2);
      const gloss = ctx.createRadialGradient(glX, glY, 0, glX, glY, glW);
      gloss.addColorStop(0.0, 'rgba(255, 255, 255, 0.85)');
      gloss.addColorStop(0.7, 'rgba(255, 255, 255, 0.25)');
      gloss.addColorStop(1.0, 'rgba(255, 255, 255, 0.00)');
      ctx.fillStyle = gloss;
      ctx.fill();
      ctx.restore();

      if (r >= 10.5) {
        const fontSize = r >= 22 ? 11 : (r >= 15 ? 9 : 8);
        ctx.font         = `bold ${fontSize}px "JetBrains Mono", monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = '#ffffff';
        ctx.shadowColor  = '#000000';
        ctx.shadowBlur   = 5;
        ctx.fillText(t.volume.toFixed(1), cx, cy + 1);
        ctx.shadowBlur   = 0;
      }

      if (t.is_large && r >= 16) {
        // Subtle Golden Institutional Ring around Whale Sphere (Zero text clutter by default)
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 214, 10, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        if (this.bmShowWhaleLabels && t.volume >= 18.0) {
          const isWhaleBuy = buyRatio >= 0.5;
          const tagCol = isWhaleBuy ? '#00e676' : '#ff3366';
          const tagTxt = `🐋 ${t.volume.toFixed(1)}L`;
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          const tw = ctx.measureText(tagTxt).width + 8;
          let tx = Math.max(this.CHART_LEFT + 4, Math.min(this.NOW_X - tw - 4, cx - tw / 2));
          let ty = isWhaleBuy ? Math.max(this.CHART_TOP + 6, cy - r - 15) : Math.min(this.CHART_BOTTOM - 15, cy + r + 3);

          // Anti-Collision Staggering against nearby whale badges
          for (const prev of drawnWhaleBadges) {
            if (Math.abs(prev.x - tx) < tw + 4 && Math.abs(prev.y - ty) < 14) {
              ty = isWhaleBuy ? prev.y - 14 : prev.y + 14;
            }
          }
          drawnWhaleBadges.push({ x: tx, y: ty, w: tw, h: 12 });

          ctx.fillStyle = 'rgba(6, 11, 22, 0.92)';
          ctx.fillRect(tx, ty, tw, 13);
          ctx.strokeStyle = tagCol;
          ctx.lineWidth = 1.0;
          ctx.strokeRect(tx, ty, tw, 13);
          ctx.fillStyle = tagCol;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tagTxt, tx + tw / 2, ty + 6.5);
        }
      }
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

    // ZON RAMAI BUYER (Compact right-aligned pill before NOW_X)
    if (topBuy && topBuy.buy >= 8.0) {
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
        const label = `▲ BUY ZONE +${topBuy.buy.toFixed(1)}L @ $${topBuy.price.toFixed(2)}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const txtW = ctx.measureText(label).width;
        const badgeX = this.NOW_X - txtW - 16;
        const badgeY = buyY - 7;

        ctx.fillStyle = 'rgba(5, 22, 14, 0.90)';
        ctx.fillRect(badgeX, badgeY, txtW + 10, 15);
        ctx.strokeStyle = 'rgba(0, 230, 118, 0.85)';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(badgeX, badgeY, txtW + 10, 15);

        ctx.fillStyle = '#00e676';
        ctx.textAlign = 'left';
        ctx.fillText(label, badgeX + 5, badgeY + 10.5);
      }
    }

    // ZON RAMAI SELLER (Compact right-aligned pill before NOW_X, only if separated from Buy Zone)
    if (topSell && topSell.sell >= 8.0 && (!topBuy || Math.abs(topSell.price - topBuy.price) >= 0.50)) {
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
        const label = `▼ SELL ZONE -${topSell.sell.toFixed(1)}L @ $${topSell.price.toFixed(2)}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const txtW = ctx.measureText(label).width;
        const badgeX = this.NOW_X - txtW - 16;
        const badgeY = sellY - 7;

        ctx.fillStyle = 'rgba(30, 8, 15, 0.90)';
        ctx.fillRect(badgeX, badgeY, txtW + 10, 15);
        ctx.strokeStyle = 'rgba(255, 51, 102, 0.85)';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(badgeX, badgeY, txtW + 10, 15);

        ctx.fillStyle = '#ff3366';
        ctx.textAlign = 'left';
        ctx.fillText(label, badgeX + 5, badgeY + 10.5);
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

  /* ─── CVD Divergence Alert Banner on Chart ─────────────────────── */
  _drawDivergenceAlert(ctx, div) {
    if (!div) return;
    const now = Date.now();
    if (now - div.timestamp > 15000) return;

    ctx.save();
    const isBull = div.type === 'bullish';
    const bannerW = 390;
    const bannerH = 26;
    const bannerX = this.CHART_LEFT + (this.CHART_WIDTH - bannerW) / 2;
    const bannerY = this.CHART_TOP + 12;

    ctx.fillStyle = isBull ? 'rgba(5, 30, 18, 0.94)' : 'rgba(38, 8, 16, 0.94)';
    ctx.fillRect(bannerX, bannerY, bannerW, bannerH);
    ctx.strokeStyle = isBull ? '#00e676' : '#ff3366';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bannerX, bannerY, bannerW, bannerH);

    ctx.fillStyle = isBull ? '#00e676' : '#ff3366';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icon = isBull ? '⚡' : '⚠️';
    ctx.fillText(`${icon} ${div.title}: ${div.desc}`, bannerX + bannerW / 2, bannerY + bannerH / 2);
    ctx.restore();
  }

  /* ─── Trapped Traders (Buyers / Sellers) Visual Badges ───────────── */
  _drawTrappedTraders(ctx, trappedList) {
    if (!trappedList || trappedList.length === 0) return;
    const now = Date.now();

    ctx.save();
    for (const tr of trappedList) {
      if (now - tr.timestamp > 35000) continue; // Persist for 35 seconds

      const y = this.priceToY(tr.price);
      if (y < this.CHART_TOP || y > this.CHART_BOTTOM) continue;

      const isBuyerTrapped = tr.type === 'TRAPPED_BUYERS';
      const col = isBuyerTrapped ? '#ff3366' : '#00e676';
      const bgCol = isBuyerTrapped ? 'rgba(40, 10, 20, 0.92)' : 'rgba(10, 35, 20, 0.92)';

      // Dashed horizontal line indicating the trapped level
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, y);
      ctx.lineTo(this.CHART_RIGHT - 120, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Glowing Badge Pill
      const badgeW = 215;
      const badgeH = 20;
      const bx = this.CHART_RIGHT - badgeW - 130;
      const by = y - (badgeH / 2);

      ctx.fillStyle = bgCol;
      ctx.fillRect(bx, by, badgeW, badgeH);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(bx, by, badgeW, badgeH);

      ctx.fillStyle = col;
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${tr.badge}: @ $${tr.price.toFixed(2)} [${tr.action}]`, bx + 6, by + badgeH / 2);

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

    const levels = [
      // 1D (Daily) Levels - Major Institutional S/R
      { price: sessions.pdh,         label: '🏛️ 1D HIGH (PDH)', col: '#fde047', bg: 'rgba(253, 224, 71, 0.28)', isHtf: true },
      { price: sessions.pdl,         label: '🏛️ 1D LOW (PDL)',  col: '#fde047', bg: 'rgba(253, 224, 71, 0.28)', isHtf: true },
      { price: sessions.daily_open,  label: '⚡ 1D OPEN',       col: '#38bdf8', bg: 'rgba(56, 189, 248, 0.26)', isHtf: true },

      // H8 & H4 Swing Levels
      { price: sessions.h8_res || sessions.h8_high, label: '🏛️ H8 RES', col: '#e11d48', bg: 'rgba(225, 29, 72, 0.26)', isHtf: true },
      { price: sessions.h8_sup || sessions.h8_low,  label: '🏛️ H8 SUP', col: '#059669', bg: 'rgba(5, 150, 105, 0.26)', isHtf: true },
      { price: sessions.h4_res || sessions.h4_high, label: '🏰 H4 RES', col: '#ec4899', bg: 'rgba(236, 72, 153, 0.24)', isHtf: true },
      { price: sessions.h4_sup || sessions.h4_low,  label: '🏰 H4 SUP', col: '#10b981', bg: 'rgba(16, 185, 129, 0.24)', isHtf: true },

      // H1 Swing Levels
      { price: sessions.h1_res || sessions.h1_high, label: '⏱️ H1 RES', col: '#f97316', bg: 'rgba(249, 115, 22, 0.22)', isHtf: true },
      { price: sessions.h1_sup || sessions.h1_low,  label: '⏱️ H1 SUP', col: '#06b6d4', bg: 'rgba(6, 182, 212, 0.22)', isHtf: true },

      // M30 Swing Levels
      { price: sessions.m30_res || sessions.m30_high, label: '⏳ M30 RES', col: '#a855f7', bg: 'rgba(168, 85, 247, 0.20)', isHtf: true },
      { price: sessions.m30_sup || sessions.m30_low,  label: '⏳ M30 SUP', col: '#3b82f6', bg: 'rgba(59, 130, 246, 0.20)', isHtf: true },

      // M15 Swing Levels
      { price: sessions.m15_res || sessions.m15_high, label: '⚡ M15 RES', col: '#fbbf24', bg: 'rgba(251, 191, 36, 0.20)', isHtf: true },
      { price: sessions.m15_sup || sessions.m15_low,  label: '⚡ M15 SUP', col: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.20)', isHtf: true },

      // Session Extremes
      { price: sessions.asian_high,  label: '🌏 ASIAN HIGH',    col: '#f59e0b', bg: 'rgba(245, 158, 11, 0.18)', isHtf: false },
      { price: sessions.asian_low,   label: '🌏 ASIAN LOW',     col: '#f59e0b', bg: 'rgba(245, 158, 11, 0.18)', isHtf: false },
      { price: sessions.london_high, label: '🇬🇧 LONDON HIGH',   col: '#06b6d4', bg: 'rgba(6, 182, 212, 0.18)', isHtf: false },
      { price: sessions.london_low,  label: '🇬🇧 LONDON LOW',    col: '#06b6d4', bg: 'rgba(6, 182, 212, 0.18)', isHtf: false },
      { price: sessions.ny_high,     label: '🗽 NY HIGH',       col: '#c084fc', bg: 'rgba(192, 132, 252, 0.18)', isHtf: false },
      { price: sessions.ny_low,      label: '🗽 NY LOW',        col: '#c084fc', bg: 'rgba(192, 132, 252, 0.18)', isHtf: false }
    ];

    const drawnBadges = [];
    let offScreenAboveCount = 0;
    let offScreenBelowCount = 0;

    for (const lv of levels) {
      if (!lv.price || lv.price <= 0) continue;
      const y = this.priceToY(lv.price);

      // Check if level is on-screen
      const inView = (y >= this.CHART_TOP - 4 && y <= this.CHART_BOTTOM + 4);

      if (inView) {
        // 1. ALWAYS draw full horizontal dashed SNR ray
        ctx.setLineDash(lv.isHtf ? [8, 4] : [5, 4]);
        ctx.strokeStyle = lv.col;
        ctx.lineWidth = lv.isHtf ? 1.2 : 0.9;
        ctx.beginPath();
        ctx.moveTo(this.CHART_LEFT, y);
        ctx.lineTo(this.CHART_RIGHT, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // 2. Anti-collision badge slotting (offset horizontally if vertically tight)
        const text = `${lv.label} $${lv.price.toFixed(2)}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const tw = ctx.measureText(text).width + 8;

        let bx = this.CHART_LEFT + 6;
        let colShift = 0;
        while (drawnBadges.some(b => Math.abs(b.y - y) < 16 && Math.abs(b.x - bx) < (tw + 10)) && colShift < 4) {
          bx += tw + 8;
          colShift++;
        }
        drawnBadges.push({ x: bx, y: y });

        const by = y - 7;
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
        ctx.fillText(text, bx + 4, y);
      } else if (lv.isHtf) {
        // Track major off-screen HTF levels (1D, H4, H1)
        if (y < this.CHART_TOP && offScreenAboveCount < 2) {
          const offTxt = `▲ ${lv.label.replace(/[^A-Za-z0-9 ]/g, '').trim()} $${lv.price.toFixed(2)}`;
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          const otw = ctx.measureText(offTxt).width + 10;
          const ox = this.CHART_LEFT + 10 + (offScreenAboveCount * 130);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
          ctx.fillRect(ox, this.CHART_TOP + 2, otw, 13);
          ctx.strokeStyle = lv.col;
          ctx.lineWidth = 0.8;
          ctx.strokeRect(ox, this.CHART_TOP + 2, otw, 13);
          ctx.fillStyle = lv.col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(offTxt, ox + 4, this.CHART_TOP + 8.5);
          offScreenAboveCount++;
        } else if (y > this.CHART_BOTTOM && offScreenBelowCount < 2) {
          const offTxt = `▼ ${lv.label.replace(/[^A-Za-z0-9 ]/g, '').trim()} $${lv.price.toFixed(2)}`;
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          const otw = ctx.measureText(offTxt).width + 10;
          const ox = this.CHART_LEFT + 10 + (offScreenBelowCount * 130);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
          ctx.fillRect(ox, this.CHART_BOTTOM - 15, otw, 13);
          ctx.strokeStyle = lv.col;
          ctx.lineWidth = 0.8;
          ctx.strokeRect(ox, this.CHART_BOTTOM - 15, otw, 13);
          ctx.fillStyle = lv.col;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(offTxt, ox + 4, this.CHART_BOTTOM - 8.5);
          offScreenBelowCount++;
        }
      }
    }

    // Draw Session Liquidity Sweep Alert Banner if active (< 60s old)
    const sw = sessions.sweep_alert;
    if (sw && (Date.now() - sw.timestamp < 60000)) {
      const sy = this.priceToY(sw.level_price);
      if (sy >= this.CHART_TOP + 10 && sy <= this.CHART_BOTTOM - 10) {
        const isBull = sw.bias === 'BUY';
        const col = isBull ? '#00e676' : '#ff3366';
        const txt = `${sw.badge} → REVERSAL ${sw.bias}`;
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        const w = ctx.measureText(txt).width + 14;
        const x = this.CHART_LEFT + 165;
        ctx.fillStyle = 'rgba(10, 14, 26, 0.94)';
        ctx.fillRect(x, sy - 10, w, 19);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, sy - 10, w, 19);
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, x + 7, sy);
      }
    }

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
        ctx.fillStyle = 'rgba(20, 16, 4, 0.90)';
        ctx.fillRect(bx, py - 7, tw, 14);
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(bx, py - 7, tw, 14);
        ctx.fillStyle = '#ffd60a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, bx + 4, py);
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

    for (const ic of icebergs.slice(-3).reverse()) {
      if (now - ic.timestamp > 75000) continue; // Show active icebergs for 75s
      if (drawnIcebergYs.length >= 2) break;    // Max 2 active iceberg badges on chart
      const y = this.priceToY(ic.price);
      if (y < this.CHART_TOP + 16 || y > this.CHART_BOTTOM - 16) continue;
      if (drawnIcebergYs.some(py => Math.abs(py - y) < 22)) continue;
      drawnIcebergYs.push(y);

      const isBuyIceberg = ic.bias === 'BUY';
      const col = isBuyIceberg ? '#00f0ff' : '#f43f5e';
      const bg = isBuyIceberg ? 'rgba(0, 240, 255, 0.10)' : 'rgba(244, 63, 94, 0.10)';

      const key = `${ic.bias}_${ic.price.toFixed(2)}`;
      const reloadInfo = this._icebergReloads[key];
      const reloadCount = reloadInfo ? reloadInfo.count : 1;
      const reloadTxt = reloadCount > 1 ? ` • RELOAD ${reloadCount}x` : '';

      // Subtle Shaded Absorption Band
      ctx.fillStyle = bg;
      ctx.fillRect(this.CHART_LEFT, y - 5, this.NOW_X - this.CHART_LEFT, 10);

      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(this.CHART_LEFT, y);
      ctx.lineTo(this.NOW_X, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Compact Iceberg Pill with Multi-Fill Reload Tag
      const txt = `🧊 ICE ${ic.bias} $${ic.price.toFixed(2)} (${ic.absorbed_vol}L${reloadTxt})`;
      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      const tw = ctx.measureText(txt).width + 12;
      const bx = this.NOW_X - tw - 16;
      const by = y - 7.5;

      ctx.fillStyle = 'rgba(6, 12, 24, 0.94)';
      ctx.fillRect(bx, by, tw, 15);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      ctx.strokeRect(bx, by, tw, 15);

      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 6, y);
    }

    ctx.restore();
  }

  /* ─── Real-Time Institutional Order Flow Buy/Sell Signals (Strict Location-First) ─── */
  _drawOrderFlowSignals(ctx, snapshot, now, currentPrice) {
    if (!snapshot) return;
    const p = currentPrice || snapshot.last_price || snapshot.bid;
    if (!p || p <= 0) return;

    if (!this._bmSignalsHistory) this._bmSignalsHistory = [];

    const sess = snapshot.sessions || {};
    const svp = snapshot.session_vp || {};

    // 1. Higher Timeframe SNR Pools (M15, M30, H1, H4, H8 + Session Levels)
    const demandLevels = [
      { p: sess.h8_sup || sess.h8_low, name: 'H8 DEMAND' },
      { p: sess.h4_sup || sess.h4_low, name: 'H4 DEMAND' },
      { p: sess.h1_sup || sess.h1_low, name: 'H1 SUPPORT' },
      { p: sess.m30_sup || sess.m30_low, name: 'M30 SUPPORT' },
      { p: sess.m15_sup || sess.m15_low, name: 'M15 SUPPORT' },
      { p: svp.val, name: 'VAL 70% DEMAND' },
      { p: sess.pdl, name: 'PDL FLOOR' },
      { p: sess.asian_low, name: 'ASIAN LOW' },
      { p: sess.london_low, name: 'LONDON LOW' }
    ].filter(l => l.p && l.p > 0);

    const supplyLevels = [
      { p: sess.h8_res || sess.h8_high, name: 'H8 SUPPLY' },
      { p: sess.h4_res || sess.h4_high, name: 'H4 SUPPLY' },
      { p: sess.h1_res || sess.h1_high, name: 'H1 RESISTANCE' },
      { p: sess.m30_res || sess.m30_high, name: 'M30 RESISTANCE' },
      { p: sess.m15_res || sess.m15_high, name: 'M15 RESISTANCE' },
      { p: svp.vah, name: 'VAH 70% SUPPLY' },
      { p: sess.pdh, name: 'PDH CEILING' },
      { p: sess.asian_high, name: 'ASIAN HIGH' },
      { p: sess.london_high, name: 'LONDON HIGH' }
    ].filter(l => l.p && l.p > 0);

    // Strict Location Gate Tolerance: ±$0.70 on Gold
    const tol = 0.70;
    const activeDemand = demandLevels.find(l => Math.abs(l.p - p) <= tol);
    const activeSupply = supplyLevels.find(l => Math.abs(l.p - p) <= tol);

    // 2. Evaluate Signals (75s cooldown to strictly eliminate zigzag noise)
    const cooldownMs = 75000;
    const canFire = !this._bmLastSignalTime || (now - this._bmLastSignalTime >= cooldownMs);

    if (canFire) {
      // ── EVALUATE BUY (Strictly at Demand / Support ONLY) ──
      if (activeDemand) {
        let triggerFound = null;
        if (snapshot.icebergs && snapshot.icebergs.some(ic => ic.bias === 'BUY' && Math.abs(ic.price - p) <= 0.85)) {
          triggerFound = 'ICEBERG BID ABSORPTION';
        } else if (snapshot.trapped_traders && snapshot.trapped_traders.some(tr => tr.type === 'TRAPPED_SELLERS' && Math.abs(tr.price - p) <= 0.85)) {
          triggerFound = 'TRAPPED SELLERS';
        } else if (snapshot.divergence && snapshot.divergence.type === 'bullish') {
          triggerFound = 'BULLISH CVD DIVERGENCE';
        } else if (sess.sweep_alert && sess.sweep_alert.bias === 'BUY' && (now - sess.sweep_alert.timestamp < 30000)) {
          triggerFound = 'LIQUIDITY SWEEP & REVERSAL';
        } else if (window.orderFlowApp && window.orderFlowApp.footprint && window.orderFlowApp.footprint._cdConfirmedSignalsCache) {
          const cache = window.orderFlowApp.footprint._cdConfirmedSignalsCache;
          for (const item of cache.values()) {
            if (item && item.signal && item.signal.direction === 'BUY' && (now - item.signal.time * 1000 < 90000)) {
              triggerFound = 'CLUSTERDELTA CONFLUENCE';
              break;
            }
          }
        }

        if (triggerFound && this._bmLastSignalDir !== 'BUY') {
          const sl = +(activeDemand.p - 1.50).toFixed(2);
          const risk = Math.max(1.0, +(p - sl).toFixed(2));
          const tp1 = +(p + risk * 2.0).toFixed(2);
          const tp2 = +(p + risk * 3.5).toFixed(2);

          const newSig = {
            id: 'bm_' + now,
            time: now,
            price: p,
            dir: 'BUY',
            zoneName: activeDemand.name,
            sl: sl,
            tp1: tp1,
            tp2: tp2,
            trigger: triggerFound,
            status: 'ACTIVE'
          };

          this._bmSignalsHistory.push(newSig);
          if (this._bmSignalsHistory.length > 12) this._bmSignalsHistory.shift();
          this._bmLastSignalTime = now;
          this._bmLastSignalDir = 'BUY';

          this.playZoneSound();
          if (this.speakAlert) {
            this.speakAlert(`Isyarat Bookmap: Belian dikesan di zon ${activeDemand.name}.`);
          }
          if (window.orderFlowApp && window.orderFlowApp.showToast) {
            window.orderFlowApp.showToast(`🎯 [BOOKMAP] BUY [${activeDemand.name}] @ $${p.toFixed(2)} | TP1: $${tp1.toFixed(2)}`);
          }
        }
      }

      // ── EVALUATE SELL (Strictly at Supply / Resistance ONLY) ──
      else if (activeSupply) {
        let triggerFound = null;
        if (snapshot.icebergs && snapshot.icebergs.some(ic => ic.bias === 'SELL' && Math.abs(ic.price - p) <= 0.85)) {
          triggerFound = 'ICEBERG ASK ABSORPTION';
        } else if (snapshot.trapped_traders && snapshot.trapped_traders.some(tr => tr.type === 'TRAPPED_BUYERS' && Math.abs(tr.price - p) <= 0.85)) {
          triggerFound = 'TRAPPED BUYERS';
        } else if (snapshot.divergence && snapshot.divergence.type === 'bearish') {
          triggerFound = 'BEARISH CVD DIVERGENCE';
        } else if (sess.sweep_alert && sess.sweep_alert.bias === 'SELL' && (now - sess.sweep_alert.timestamp < 30000)) {
          triggerFound = 'LIQUIDITY SWEEP & REVERSAL';
        } else if (window.orderFlowApp && window.orderFlowApp.footprint && window.orderFlowApp.footprint._cdConfirmedSignalsCache) {
          const cache = window.orderFlowApp.footprint._cdConfirmedSignalsCache;
          for (const item of cache.values()) {
            if (item && item.signal && item.signal.direction === 'SELL' && (now - item.signal.time * 1000 < 90000)) {
              triggerFound = 'CLUSTERDELTA CONFLUENCE';
              break;
            }
          }
        }

        if (triggerFound && this._bmLastSignalDir !== 'SELL') {
          const sl = +(activeSupply.p + 1.50).toFixed(2);
          const risk = Math.max(1.0, +(sl - p).toFixed(2));
          const tp1 = +(p - risk * 2.0).toFixed(2);
          const tp2 = +(p - risk * 3.5).toFixed(2);

          const newSig = {
            id: 'bm_' + now,
            time: now,
            price: p,
            dir: 'SELL',
            zoneName: activeSupply.name,
            sl: sl,
            tp1: tp1,
            tp2: tp2,
            trigger: triggerFound,
            status: 'ACTIVE'
          };

          this._bmSignalsHistory.push(newSig);
          if (this._bmSignalsHistory.length > 12) this._bmSignalsHistory.shift();
          this._bmLastSignalTime = now;
          this._bmLastSignalDir = 'SELL';

          this.playZoneSound();
          if (this.speakAlert) {
            this.speakAlert(`Isyarat Bookmap: Jualan dikesan di zon ${activeSupply.name}.`);
          }
          if (window.orderFlowApp && window.orderFlowApp.showToast) {
            window.orderFlowApp.showToast(`🎯 [BOOKMAP] SELL [${activeSupply.name}] @ $${p.toFixed(2)} | TP1: $${tp1.toFixed(2)}`);
          }
        }
      }
    }

    // 3. Render Confirmed Signals & Trajectory on Bookmap Canvas
    ctx.save();
    for (const sig of this._bmSignalsHistory) {
      const isBuy = sig.dir === 'BUY';

      // Update win/loss status in real-time
      if (sig.status === 'ACTIVE') {
        if (isBuy) {
          if (p >= sig.tp1) sig.status = 'TP1_HIT';
          else if (p <= sig.sl) sig.status = 'SL_HIT';
        } else {
          if (p <= sig.tp1) sig.status = 'TP1_HIT';
          else if (p >= sig.sl) sig.status = 'SL_HIT';
        }
      }

      const sigX = this.timeToX(sig.time, now);
      const sigY = this.priceToY(sig.price);
      const slY  = this.priceToY(sig.sl);
      const tp1Y = this.priceToY(sig.tp1);

      const col = isBuy ? '#00e676' : '#ff3366';
      const bgCol = isBuy ? 'rgba(5, 38, 22, 0.94)' : 'rgba(45, 10, 20, 0.94)';

      // Draw forward projection trajectory rays if active or recent (< 180s)
      if (sig.status === 'ACTIVE' || (now - sig.time < 180000)) {
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

            // Right-side TP1 Tag
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

          // SL Level Ray (Red/Pink)
          if (slY >= this.CHART_TOP && slY <= this.CHART_BOTTOM) {
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo(startLineX, slY);
            ctx.lineTo(endLineX, slY);
            ctx.stroke();

            // Right-side SL Tag
            const slText = `🛑 SL $${sig.sl.toFixed(2)}`;
            ctx.font = 'bold 8px "JetBrains Mono", monospace';
            const slW = ctx.measureText(slText).width + 8;
            ctx.fillStyle = 'rgba(40, 8, 16, 0.88)';
            ctx.fillRect(endLineX - slW - 4, slY - 6.5, slW, 13);
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(endLineX - slW - 4, slY - 6.5, slW, 13);
            ctx.fillStyle = '#f43f5e';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(slText, endLineX - slW, slY);
          }
          ctx.setLineDash([]);
        }
      }

      // Draw Marker & Badge at (sigX, sigY)
      if (sigX >= this.CHART_LEFT - 30 && sigX <= this.NOW_X + 30 && sigY >= this.CHART_TOP - 12 && sigY <= this.CHART_BOTTOM + 12) {
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

        // Badge
        let statusBadge = '';
        if (sig.status === 'TP1_HIT') statusBadge = ' ✅ TP1';
        else if (sig.status === 'SL_HIT') statusBadge = ' ❌ SL';

        const mainText = `🎯 [BM] ${sig.dir} [${sig.zoneName}]${statusBadge}`;
        ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
        const bw = ctx.measureText(mainText).width + 12;
        const bh = 16;
        const bx = Math.max(this.CHART_LEFT + 4, Math.min(this.NOW_X - bw - 4, sigX - bw / 2));
        const by = isBuy ? (sigY + 18) : (sigY - bh - 18);

        ctx.fillStyle = bgCol;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(bx, by, bw, bh);

        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(mainText, bx + bw / 2, by + bh / 2);
      }
    }

    // 4. Live Order Flow Radar Status Strip (Top-Left under HUD)
    const activeSig = this._bmSignalsHistory.slice(-1)[0];
    let radarText = `🎯 RADAR BOOKMAP: MENELITI ZON SNR (M15-H8)...`;
    let radarCol = '#94a3b8';
    let radarBg = 'rgba(8, 15, 26, 0.88)';

    if (activeSig && (now - activeSig.time < 90000)) {
      const isBuy = activeSig.dir === 'BUY';
      radarCol = isBuy ? '#00e676' : '#ff3366';
      radarBg = isBuy ? 'rgba(5, 30, 16, 0.94)' : 'rgba(38, 8, 16, 0.94)';
      radarText = `🎯 [BOOKMAP] ${activeSig.dir} [${activeSig.zoneName}] @ $${activeSig.price.toFixed(2)} | SL: $${activeSig.sl.toFixed(2)} | TP: $${activeSig.tp1.toFixed(2)}`;
    } else if (activeDemand) {
      radarText = `⚡ LOKASI DEMAND: ${activeDemand.name} ($${activeDemand.p.toFixed(2)}) — MENANTI ABSORPTION BUY...`;
      radarCol = '#00e676';
      radarBg = 'rgba(5, 30, 16, 0.88)';
    } else if (activeSupply) {
      radarText = `⚡ LOKASI SUPPLY: ${activeSupply.name} ($${activeSupply.p.toFixed(2)}) — MENANTI ABSORPTION SELL...`;
      radarCol = '#ff3366';
      radarBg = 'rgba(38, 8, 16, 0.88)';
    }

    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    const rw = ctx.measureText(radarText).width + 14;
    const rx = this.CHART_LEFT + 8;
    const ry = this.CHART_TOP + 8;

    ctx.fillStyle = radarBg;
    ctx.fillRect(rx, ry, rw, 17);
    ctx.strokeStyle = radarCol;
    ctx.lineWidth = 0.9;
    ctx.strokeRect(rx, ry, rw, 17);

    ctx.fillStyle = radarCol;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(radarText, rx + 7, ry + 8.5);

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

      // Inspect Resting Order Book Depth at Cursor Price
      if (!this.hoverTrade && orderBook) {
        const bVol = (orderBook.bids && orderBook.bids[snappedP]) || 0;
        const aVol = (orderBook.asks && orderBook.asks[snappedP]) || 0;
        const restVol = Math.max(bVol, aVol);
        if (restVol > 0) {
          const isBid = bVol >= aVol;
          const col = isBid ? '#00e676' : '#ff4d6d';
          const pillTxt = `${isBid ? 'BID' : 'ASK'} @$${snappedP}: ${restVol.toFixed(1)}L`;
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          const pw = ctx.measureText(pillTxt).width + 12;
          const px = Math.min(this.CHART_RIGHT - pw - 6, this.mouseX + 12);
          const py = Math.max(this.CHART_TOP + 6, this.mouseY - 22);

          ctx.fillStyle = 'rgba(6, 12, 24, 0.92)';
          ctx.fillRect(px, py, pw, 16);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.strokeRect(px, py, pw, 16);
          ctx.fillStyle = col;
          ctx.textAlign = 'left';
          ctx.fillText(pillTxt, px + 6, py + 11.5);
        }
      }
      ctx.restore();
    }
  }

  /* ─── Left Price Scale Axis ───────────────────────────────────── */
  _drawPriceAxis(ctx) {
    ctx.save();
    const step = 0.50;
    const startP = Math.floor(this.minPrice / step) * step;

    ctx.font      = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    for (let p = startP; p <= this.maxPrice + step; p += step) {
      const y = this.priceToY(p);
      if (y < this.CHART_TOP + 4 || y > this.CHART_BOTTOM - 4) continue;

      const isWholeDollar = Math.abs(Math.round(p) - p) < 0.01;
      ctx.fillStyle = isWholeDollar ? '#85a4cc' : '#3d5677';
      ctx.fillText(p.toFixed(2), this.CHART_LEFT - 4, y + 3);
    }
    ctx.restore();
  }

  /* ─── High-Resolution Right COB + Pulling/Stacking Delta ──────── */
  _drawCOB(ctx, orderBook, currentPrice, bid, ask) {
    ctx.save();
    const sx = this.CHART_RIGHT;
    const sw = this.COB_WIDTH;

    ctx.fillStyle = '#060a12';
    ctx.fillRect(sx, 0, sw, this.height);

    // High-tech Neon Vertical Separator (Separating Projection from COB)
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, this.height);
    ctx.stroke();
    ctx.shadowBlur  = 0;

    ctx.fillStyle = '#101d30';
    ctx.fillRect(sx, 0, sw, this.TOP_PADDING);
    ctx.fillStyle  = '#00d4ff';
    ctx.font       = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign  = 'center';
    ctx.fillText('COB • DEPTH ±Δ', sx + sw / 2, 18);

    const bids = (orderBook && orderBook.bids) || {};
    const asks = (orderBook && orderBook.asks) || {};
    const oldestSnap = this._depthHistoryBuffer.length > 0 ? this._depthHistoryBuffer[0] : null;

    let maxDepth = 1;
    for (const v of Object.values(bids)) maxDepth = Math.max(maxDepth, v);
    for (const v of Object.values(asks)) maxDepth = Math.max(maxDepth, v);
    maxDepth = Math.max(maxDepth, 45);

    // 1. Render smooth $0.10 liquidity depth silhouette bars (No text overlap)
    const barStep = 0.10;
    const startBarP = Math.floor(this.minPrice / barStep) * barStep;
    const barH = Math.max(2.5, Math.abs(this.priceToY(0) - this.priceToY(barStep)) - 0.8);
    const cyLive = currentPrice ? this.priceToY(currentPrice) : -999;

    for (let p = startBarP; p <= this.maxPrice + barStep; p = Math.round((p + barStep) * 100) / 100) {
      const y = this.priceToY(p);
      if (y < this.CHART_TOP + 6 || y > this.CHART_BOTTOM - 6) continue;

      const pStr  = p.toFixed(2);
      const bVol  = bids[pStr] || bids[p.toFixed(1)] || bids[p] || 0;
      const aVol  = asks[pStr] || asks[p.toFixed(1)] || asks[p] || 0;
      const vol   = Math.max(bVol, aVol);
      if (vol <= 0) continue;

      const isBid = bVol >= aVol;
      const isWall = vol >= 54;
      const barW = Math.min(sw - 4, (vol / maxDepth) * (sw - 4));

      ctx.fillStyle = isBid
        ? (isWall ? 'rgba(0, 230, 118, 0.45)' : 'rgba(0, 230, 118, 0.18)')
        : (isWall ? 'rgba(255, 51, 102, 0.45)' : 'rgba(255, 51, 102, 0.18)');
      ctx.fillRect(sx + 2, y - barH / 2, barW, barH);

      if (isWall) {
        ctx.strokeStyle = isBid ? '#00e676' : '#ff3366';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(sx + 2, y - barH / 2, barW, barH);
      }

      // Print Price & Lot Numbers cleanly every $0.50 step (or major wall >=68L) if at least 14px away from live price badge
      const cents = Math.round(p * 100) % 100;
      const isHalfDollar = (cents === 0 || cents === 50);
      if ((isHalfDollar || vol >= 68) && Math.abs(y - cyLive) > 13) {
        let deltaDepth = 0;
        if (oldestSnap) {
          const oldVol = isBid ? (oldestSnap.bids[pStr] || 0) : (oldestSnap.asks[pStr] || 0);
          if (oldVol > 0) deltaDepth = Math.round(vol - oldVol);
        }

        ctx.font      = isWall ? 'bold 8.5px "JetBrains Mono", monospace' : '8px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = isWall ? '#ffffff' : (p <= (currentPrice || 0) ? '#86efac' : '#fda4af');
        ctx.fillText(pStr, sx + 4, y + 3);

        const deltaStr = Math.abs(deltaDepth) >= 3 ? `(${deltaDepth > 0 ? '+' : ''}${deltaDepth})` : '';
        ctx.font      = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = isWall ? '#ffd60a' : (isBid ? '#00e676' : '#ff5a80');
        ctx.fillText(`${Math.round(vol)}${deltaStr}`, sx + sw - 4, y + 3);
      }
    }

    if (currentPrice) {
      const cy = this.priceToY(currentPrice);
      if (cy > this.CHART_TOP && cy < this.CHART_BOTTOM) {
        ctx.fillStyle = '#ffb703';
        ctx.fillRect(sx + 1, cy - 9, sw - 2, 18);

        ctx.fillStyle    = '#000000';
        ctx.font         = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`⚡ ${currentPrice.toFixed(2)}`, sx + sw / 2, cy);
        ctx.textBaseline = 'alphabetic';
      }
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
    ctx.save();
    const topH = this.TOP_PADDING;
    this.bmHudHitboxes = [];

    ctx.fillStyle = '#080f1a';
    ctx.fillRect(0, 0, this.CHART_RIGHT, topH);

    ctx.strokeStyle = '#1b2d48';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topH);
    ctx.lineTo(this.CHART_RIGHT, topH);
    ctx.stroke();

    // 1. Thermal Spectrum Bar (Click to cycle Theme: THERMO -> CYBER -> GOLD)
    const palX = 8;
    const palY = 6;
    const palW = 86;
    const palH = 15;

    const palGrad = ctx.createLinearGradient(palX, 0, palX + palW, 0);
    if (this.bmPaletteMode === 'cyber') {
      palGrad.addColorStop(0.0, '#1e1b4b');
      palGrad.addColorStop(0.4, '#3b82f6');
      palGrad.addColorStop(0.7, '#00f5d4');
      palGrad.addColorStop(1.0, '#f72585');
    } else if (this.bmPaletteMode === 'gold') {
      palGrad.addColorStop(0.0, '#1c1917');
      palGrad.addColorStop(0.4, '#d97706');
      palGrad.addColorStop(0.75, '#facc15');
      palGrad.addColorStop(1.0, '#e11d48');
    } else {
      palGrad.addColorStop(0.00, '#081a36');
      palGrad.addColorStop(0.25, '#0077b6');
      palGrad.addColorStop(0.50, '#00d4ff');
      palGrad.addColorStop(0.72, '#ffd60a');
      palGrad.addColorStop(0.90, '#ff7700');
      palGrad.addColorStop(1.00, '#d90429');
    }

    ctx.fillStyle = palGrad;
    ctx.fillRect(palX, palY, palW, palH);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.strokeRect(palX, palY, palW, palH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`🎨 ${this.bmPaletteMode.toUpperCase()}`, palX + palW / 2, palY + 10.5);
    this.bmHudHitboxes.push({
      x: palX, y: palY, w: palW, h: palH,
      onClick: () => {
        const modes = ['thermo', 'cyber', 'gold'];
        this.bmPaletteMode = modes[(modes.indexOf(this.bmPaletteMode) + 1) % modes.length];
      }
    });

    // 2. Interactive Bookmap Pro Control Pills
    let pillX = palX + palW + 5;
    const drawHudPill = (label, isActive, activeCol, onClick) => {
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      const w = Math.ceil(ctx.measureText(label).width) + 8;
      const y = 6;
      const h = 15;
      if (pillX + w > this.CHART_RIGHT - 245) return; // Keep room for right imbalance gauges
      ctx.fillStyle = isActive ? activeCol : '#111c2d';
      ctx.fillRect(pillX, y, w, h);
      ctx.strokeStyle = isActive ? '#ffffff' : '#273e60';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(pillX, y, w, h);
      ctx.fillStyle = isActive ? '#04101e' : '#94a3b8';
      ctx.textAlign = 'center';
      ctx.fillText(label, pillX + w / 2, y + 10.5);
      this.bmHudHitboxes.push({ x: pillX, y, w, h, onClick });
      pillX += w + 3;
    };

    // Dynamic Contrast Dial (AUTO / LOW / MED / HIGH)
    const contrastCol = this.bmContrastMode === 'HIGH' ? '#f43f5e' : (this.bmContrastMode === 'MED' ? '#38bdf8' : (this.bmContrastMode === 'LOW' ? '#a78bfa' : '#fbbf24'));
    drawHudPill(`🎚️ ${this.bmContrastMode}`, true, contrastCol, () => {
      const modes = ['AUTO', 'LOW', 'MED', 'HIGH'];
      this.bmContrastMode = modes[(modes.indexOf(this.bmContrastMode) + 1) % modes.length];
    });

    // World-Class Liquidity Sweeps Visualizer Toggle
    drawHudPill(
      `⚡ SWEEP: ${this.bmShowSweeps !== false ? 'ON' : 'OFF'}`,
      this.bmShowSweeps !== false,
      '#00f0ff',
      () => { this.bmShowSweeps = this.bmShowSweeps === false; }
    );

    // World-Class Order Flow Measurement Ruler Tool
    drawHudPill(
      `📏 RULER: ${this.bmRulerActive ? 'ON' : 'OFF'}`,
      this.bmRulerActive,
      '#facc15',
      () => {
        this.bmRulerActive = !this.bmRulerActive;
        if (!this.bmRulerActive) {
          this.bmRulerPointA = null;
          this.bmRulerPointB = null;
        }
      }
    );

    // Feature 4: On-Canvas Quick Action Trade HUD
    drawHudPill('⚡ BUY', true, '#059669', () => {
      if (window.orderFlowApp && window.orderFlowApp.sendTrade) {
        window.orderFlowApp.sendTrade('BUY');
      }
    });
    drawHudPill('⚡ SELL', true, '#dc2626', () => {
      if (window.orderFlowApp && window.orderFlowApp.sendTrade) {
        window.orderFlowApp.sendTrade('SELL');
      }
    });
    drawHudPill('🎯 BE', false, '#38bdf8', () => {
      fetch('/api/breakeven_all', { method: 'POST' }).then(r => r.json()).then(res => {
        if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
      });
    });
    drawHudPill('❌ CLOSE', false, '#f43f5e', () => {
      fetch('/api/close_all', { method: 'POST' }).then(r => r.json()).then(res => {
        if (window.orderFlowApp && window.orderFlowApp.showToast) window.orderFlowApp.showToast(res.message);
      });
    });

    drawHudPill(
      this.bmWallFilterOnly ? '🔥 Wall ≥28L' : '🔥 Semua',
      this.bmWallFilterOnly,
      '#fbbf24',
      () => { this.bmWallFilterOnly = !this.bmWallFilterOnly; }
    );
    drawHudPill(
      `🟢 Bid/Ask: ${this.bmShowBidAskChannel ? 'ON' : 'OFF'}`,
      this.bmShowBidAskChannel,
      '#4ade80',
      () => { this.bmShowBidAskChannel = !this.bmShowBidAskChannel; }
    );
    drawHudPill(
      `🦈 Jerung: ${this.bmShowSharkWalls !== false ? 'ON' : 'OFF'}`,
      this.bmShowSharkWalls !== false,
      '#fbbf24',
      () => { this.bmShowSharkWalls = this.bmShowSharkWalls === false; }
    );
    drawHudPill(
      `🐋 Paus: ${this.bmShowWhaleLabels ? 'ON' : 'OFF'}`,
      this.bmShowWhaleLabels,
      '#38bdf8',
      () => { this.bmShowWhaleLabels = !this.bmShowWhaleLabels; }
    );
    drawHudPill(
      `📈 CVD: ${this.bmShowCvdCurve ? 'ON' : 'OFF'}`,
      this.bmShowCvdCurve,
      '#c084fc',
      () => { this.bmShowCvdCurve = !this.bmShowCvdCurve; }
    );
    drawHudPill(
      `🎯 SGNL: ${this.bmShowSignals !== false ? 'ON' : 'OFF'}`,
      this.bmShowSignals !== false,
      '#38bdf8',
      () => { this.bmShowSignals = this.bmShowSignals === false; }
    );
    drawHudPill('◀', false, '#38bdf8', () => { this.panHorizontal(-1); });
    drawHudPill('▶', false, '#38bdf8', () => { this.panHorizontal(1); });
    drawHudPill('▲', false, '#38bdf8', () => { this.panVertical(1); });
    drawHudPill('▼', false, '#38bdf8', () => { this.panVertical(-1); });
    if (Math.abs(this.priceOffset || 0) > 0.05 || Math.abs(this.timeOffsetMs || 0) >= 1000) {
      drawHudPill(
        `🎯 Tengah`,
        true,
        '#fbbf24',
        () => { this.centerVertical(); }
      );
    }

    // Floating Clickable Alert Banner if User Panned Live Price Outside the Screen
    const liveP = snapshot.last_price || snapshot.bid || 0;
    if (liveP > 0 && (liveP < this.minPrice + 0.3 || liveP > this.maxPrice - 0.3)) {
      const dirArrow = liveP > this.maxPrice ? '⬆️ DI ATAS SKRIN' : '⬇️ DI BAWAH SKRIN';
      const alertTxt = `🎯 HARGA SEMASA ($${liveP.toFixed(2)}) ${dirArrow} — KLIK SINI UNTUK KEMBALI KE TENGAH`;
      ctx.font = 'bold 10.5px "JetBrains Mono", monospace';
      const bw = ctx.measureText(alertTxt).width + 24;
      const bh = 24;
      const bx = this.CHART_LEFT + (this.CHART_WIDTH - bw) / 2;
      const by = this.CHART_TOP + 12;

      ctx.fillStyle = 'rgba(251, 191, 36, 0.95)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#04101e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(alertTxt, bx + bw / 2, by + bh / 2);

      this.bmHudHitboxes.push({
        x: bx, y: by, w: bw, h: bh,
        onClick: () => { this.centerVertical(); }
      });
    }

    // 3. Book & Volume Imbalance Gauges on the Right
    let totalBidDepth = 0;
    let totalAskDepth = 0;
    const ob = snapshot.order_book || {};
    for (const v of Object.values(ob.bids || {})) totalBidDepth += v;
    for (const v of Object.values(ob.asks || {})) totalAskDepth += v;
    const totalBook = Math.max(1, totalBidDepth + totalAskDepth);
    const bookImbalancePct = Math.round(((totalBidDepth - totalAskDepth) / totalBook) * 100);

    let buyVolTotal = 0;
    let sellVolTotal = 0;
    for (const t of (snapshot.trades || []).slice(-40)) {
      buyVolTotal  += t.buy_vol  !== undefined ? t.buy_vol  : (t.side === 'buy' ? t.volume : 0);
      sellVolTotal += t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0);
    }
    const totalVol = Math.max(1, buyVolTotal + sellVolTotal);
    const volImbalancePct = Math.round(((buyVolTotal - sellVolTotal) / totalVol) * 100);

    const gaugeW = 68;
    const gaugeH = 9;

    const bookX = this.CHART_RIGHT - 245;
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    const bookSign = bookImbalancePct >= 0 ? '+' : '';
    ctx.fillText(`Book: ${bookSign}${bookImbalancePct}%`, bookX - 5, 16);

    const bidBarW = Math.round((totalBidDepth / totalBook) * gaugeW);
    ctx.fillStyle = '#00e676';
    ctx.fillRect(bookX, 9, bidBarW, gaugeH);
    ctx.fillStyle = '#ff3366';
    ctx.fillRect(bookX + bidBarW, 9, gaugeW - bidBarW, gaugeH);
    ctx.strokeStyle = '#1b2d48';
    ctx.strokeRect(bookX, 9, gaugeW, gaugeH);

    const volX = this.CHART_RIGHT - 82;
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    const volSign = volImbalancePct >= 0 ? '+' : '';
    ctx.fillText(`Vol: ${volSign}${volImbalancePct}%`, volX - 5, 16);

    const buyBarW = Math.round((buyVolTotal / totalVol) * gaugeW);
    ctx.fillStyle = '#00e676';
    ctx.fillRect(volX, 9, buyBarW, gaugeH);
    ctx.fillStyle = '#ff3366';
    ctx.fillRect(volX + buyBarW, 9, gaugeW - buyBarW, gaugeH);
    ctx.strokeStyle = '#1b2d48';
    ctx.strokeRect(volX, 9, gaugeW, gaugeH);

    ctx.restore();
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
}

window.BookmapRenderer = BookmapRenderer;
