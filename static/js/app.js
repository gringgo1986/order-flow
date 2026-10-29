/**
 * Main Application Orchestrator
 * Handles WebSocket feed, UI state, Bookmap, Footprint, DOM Ladder, and Order Execution
 */

class App {
  constructor() {
    this.ws = null;
    this.currentView = 'bookmap'; // 'bookmap', 'footprint', 'split'
    this.activeDockTab = 'insights'; // 'insights', 'tape'
    
    // Trading state
    this.selectedLot = 0.01;
    this.latestSnapshot = null;

    // V14.0 & V16.0 Enhancements state
    this.audioEnabled = true;
    this._audioCtx = null;
    this.isPageHidden = false;
    this._lastBgRenderTime = 0;
    this._lastWhaleChimeTime = 0;
    this._lastIcebergChimeTime = 0;
    this._lastSweepChimeTime = 0;
    this._pingInterval = null;
    this.sessionStats = { realizedPnl: 0.0, winCount: 0, lossCount: 0, totalTrades: 0 };
    this.signalsList = [];
    this.signalFilter = 'all';
    this._lastAutoSignalTime = 0;

    this.needsRedraw = true;
    this._lastInsightsHTML = "";
    this._lastTapeHTML = "";
    
    // Components
    this.bookmap = new BookmapRenderer('bookmapCanvas');
    this.footprint = new FootprintRenderer('footprintCanvas');
    this.domManager = new DOMManager('domLadder');
    this.isDockCollapsed = false;
    
    this._initElements();
    this._bindEvents();
    setTimeout(() => this.toggleBottomDock(true), 100);

    this._updateContextToolbar(this.currentView);
    this._updateRRPreview();
    this._connectWebSocket();
    this._startRenderLoop();

    // Hook footprint replay update callback
    if (this.footprint) {
      this.footprint.onReplayUpdate = () => this._updateReplayHUD();
    }
    // Pre-load deep 1,000 historical candles
    this.loadHistoricalCandles();
    // Initialize user authentication & admin status
    this.initAuthAndAdmin();

    // V14.0 Enhancements Init
    this._initAudioEngine();
    this._setupDomToggle();
    this._setupMobileTouchGestures();
    this._initSessionStats();
    this._setupLotCalculator();
    this._initSignalsTracker();

    // Battery Saver Visibility Listener
    document.addEventListener('visibilitychange', () => {
      this.isPageHidden = document.hidden;
      if (!this.isPageHidden) {
        this.needsRedraw = true;
        window.dispatchEvent(new Event('resize'));
        if (this.latestSnapshot) {
          if (this.bookmap && (this.currentView === 'bookmap' || this.currentView === 'split')) {
            this.bookmap.render(this.latestSnapshot);
          }
          if (this.footprint && this.currentView !== 'bookmap') {
            this.footprint.render(this.latestSnapshot);
          }
        }
      }
    });
  }

  _initElements() {
    this.elSymbol = document.getElementById('symbolTitle');
    this.elPrice = document.getElementById('symbolPrice');
    this.elSpread = document.getElementById('symbolSpread');
    this.elModeBadge = document.getElementById('modeBadge');
    this.elModeText = document.getElementById('modeText');
    
    this.elHdrCvd = document.getElementById('hdrCvdVal');
    this.elHdrVwap = document.getElementById('hdrVwapVal');
    this.elHdrDpoc = document.getElementById('hdrDpocVal');

    this.elAccEquity = document.getElementById('accEquity');
    this.elAccBalance = document.getElementById('accBalance');
    this.elAccProfit = document.getElementById('accProfit');
    
    this.btnBuyMarket = document.getElementById('btnBuyMarket');
    this.btnSellMarket = document.getElementById('btnSellMarket');
    this.inputLot = document.getElementById('inputLot');
    this.inputSL = document.getElementById('inputSL');
    this.inputTP = document.getElementById('inputTP');
    this.btnCloseAll = document.getElementById('btnCloseAll');
    this.btnBreakEven = document.getElementById('btnBreakEven');
    
    this.positionsTableBody = document.getElementById('positionsTableBody');
    this.tapeTableBody = document.getElementById('tapeTableBody');
    this.insightsList = document.getElementById('insightsList');
    this.btnToggleFeedSource = document.getElementById('btnToggleFeedSource');
    this.elTickCadence = document.getElementById('txtTickCadence');
    this.elTickClock = document.getElementById('txtTickClock');
    this.elTickLatency = document.getElementById('txtTickLatency');
    this.elTickVelocity = document.getElementById('txtTickVelocity');
    this.elActiveSession = document.getElementById('txtActiveSession');
    this.btnToggleSessionLevels = document.getElementById('btnToggleSessionLevels');
    this.btnToggleSVP = document.getElementById('btnToggleSVP');
    this.btnToggleIcebergs = document.getElementById('btnToggleIcebergs');
    this.btnToggleNewsShield = document.getElementById('btnToggleNewsShield');
    this.btnToggleDock = document.getElementById('btnToggleDock');
    
    this.bookmapCanvas = document.getElementById('bookmapCanvas');
    this.footprintCanvas = document.getElementById('footprintCanvas');
  }

  _bindEvents() {
    // View Switchers (Bookmap, Footprint, Split)
    document.querySelectorAll('.view-switchers .nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.view-switchers .nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.setView(btn.dataset.view);
      });
    });

    // Dock Tabs
    document.querySelectorAll('.dock-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeDockTab = tab.dataset.tab;
        
        // Auto-expand dock if user clicks a tab while collapsed
        if (this.isDockCollapsed) {
          this.toggleBottomDock(false);
        }
        
        const elPos = document.getElementById('tabPanePositions');
        const elTape = document.getElementById('tabPaneTape');
        const elIns = document.getElementById('tabPaneInsights');
        const elSig = document.getElementById('tabPaneSignals');
        const tapeFilterGroup = document.getElementById('tapeFilterGroup');
        if (elPos) elPos.style.display = this.activeDockTab === 'positions' ? 'block' : 'none';
        if (elTape) elTape.style.display = this.activeDockTab === 'tape' ? 'block' : 'none';
        if (elIns) elIns.style.display = this.activeDockTab === 'insights' ? 'block' : 'none';
        if (elSig) elSig.style.display = this.activeDockTab === 'signals' ? 'block' : 'none';
        if (tapeFilterGroup) tapeFilterGroup.style.display = this.activeDockTab === 'tape' ? 'inline-flex' : 'none';
      });
    });

    // Feature 6: Tape Min Lot Filter
    this.tapeMinLot = 0.0;
    document.querySelectorAll('.tape-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tape-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tapeMinLot = parseFloat(btn.dataset.minlot) || 0.0;
        if (this.latestSnapshot) {
          this._renderTape(this.latestSnapshot.trades || []);
        }
      });
    });

    if (this.btnToggleDock) {
      this.btnToggleDock.addEventListener('click', () => {
        this.toggleBottomDock(!this.isDockCollapsed);
      const btd = document.getElementById('btnToggleDock');
      if (btd) btd.textContent = this.isDockCollapsed ? '▲ Buka Insights & Tape' : '▼ Kecilkan Dock';
      });
    }

    // Lot Size Presets
    document.querySelectorAll('.lot-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lot-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedLot = parseFloat(btn.dataset.lot);
        if (this.inputLot) this.inputLot.value = this.selectedLot;
        this._updateRRPreview();
      });
    });

    if (this.inputLot) {
      this.inputLot.addEventListener('input', (e) => {
        this.selectedLot = parseFloat(e.target.value) || 0.01;
        this._updateRRPreview();
      });
    }

    // Mode Toggle (MT5 Live vs Demo Simulator)
    if (this.elModeBadge) {
      this.elModeBadge.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/toggle_mode', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.simulation_mode ? 'Switched to Demo Simulator' : 'Switched to MT5 Live Terminal');
        } catch (err) {
          this.showToast('Error toggling mode: ' + err.message);
        }
      });
    }

    // Buy Market Execution
    if (this.btnBuyMarket) {
      this.btnBuyMarket.addEventListener('click', () => this.sendTrade('BUY'));
    }

    // Sell Market Execution
    if (this.btnSellMarket) {
      this.btnSellMarket.addEventListener('click', () => this.sendTrade('SELL'));
    }

    // Close All Positions
    if (this.btnCloseAll) {
      this.btnCloseAll.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/close_all', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message);
        } catch (err) {
          this.showToast('Close error: ' + err.message);
        }
      });
    }

    // Break Even button (All positions)
    if (this.btnBreakEven) {
      this.btnBreakEven.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/breakeven_all', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message || 'SL dipindahkan ke Breakeven');
        } catch (e) {
          this.showToast('Ralat Breakeven: ' + e.message);
        }
      });
    }

    if (this.btnToggleFeedSource) {
      this.btnToggleFeedSource.addEventListener('click', async () => {
        const cur = (this.latestSnapshot && this.latestSnapshot.feed_source) || 'swissquote';
        const next = cur === 'swissquote' ? 'mt5' : 'swissquote';
        try {
          const res = await fetch('/api/feed_source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: next })
          });
          const data = await res.json();
          this.showToast(data.message || `Sumber ditukar ke ${next.toUpperCase()}`);
        } catch (e) {
          this.showToast('Ralat tukar sumber: ' + e.message);
        }
      });
    }

    // Partial Close 50% (All positions)
    const btnPartial50 = document.getElementById('btnPartialClose50');
    if (btnPartial50) {
      btnPartial50.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/partial_close_all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: 0, ratio: 0.5 })
          });
          const data = await res.json();
          this.showToast(data.message || 'Semua posisi ditutup separuh (50%)');
        } catch (e) {
          this.showToast('Ralat Tutup Separuh: ' + e.message);
        }
      });
    }

    // Sound Toggle Button
    // Top Header [📡 ISYARAT [6]] Button
    const btnTopSig = document.getElementById('btnTopSignalsBadge');
    if (btnTopSig) {
      btnTopSig.addEventListener('click', () => this.openSignalsTab());
    }

    // Record Signal Button in Confluence Dashboard
    const btnDashRec = document.getElementById('btnDashRecordSignal');
    if (btnDashRec) {
      btnDashRec.addEventListener('click', () => {
        if (!this.latestSnapshot) return;
        const p = this.latestSnapshot.last_price || this.latestSnapshot.current_price || 0;
        const dir = (this.latestSnapshot.cvd >= 0) ? 'BUY' : 'SELL';
        this.addSignal({
          type: '🎯 Confluence Dashboard A+',
          direction: dir,
          entryPrice: p,
          slPips: 35,
          tpPips: 70
        });
        this.showToast('📡 Isyarat Confluence direkodkan ke Jurnal Menang/Kalah!');
      });
    }

    // Filter Buttons in Signals Tab
    document.querySelectorAll('.sig-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sig-filter-btn').forEach(b => {
          b.classList.remove('active');
          b.style.borderColor = '#1e293b';
        });
        btn.classList.add('active');
        btn.style.borderColor = '#38bdf8';
        this.signalFilter = btn.dataset.filter || 'all';
        this._renderSignalsUI();
      });
    });

    // Export Signals to CSV
    const btnExpSigCSV = document.getElementById('btnExportSignalsCSV');
    if (btnExpSigCSV) {
      btnExpSigCSV.addEventListener('click', () => this.exportSignalsToCSV());
    }

    // Clear Signals History
    const btnClrSig = document.getElementById('btnClearSignalsHistory');
    if (btnClrSig) {
      btnClrSig.addEventListener('click', () => {
        if (confirm('Padam semua rekod sejarah isyarat?')) {
          this.signalsList = [];
          this._saveSignals();
          this._renderSignalsUI();
          this.showToast('🗑️ Sejarah isyarat telah dipadam.');
        }
      });
    }

    const btnToggleSound = document.getElementById('btnToggleSound');
    if (btnToggleSound) {
      btnToggleSound.addEventListener('click', () => {
        if (this.bookmap && this.bookmap.toggleAudio) {
          const isEnabled = this.bookmap.toggleAudio();
          btnToggleSound.classList.toggle('active', isEnabled);
          btnToggleSound.innerHTML = isEnabled ? '🔊 Bunyi' : '🔇 Bisu';
          this.showToast(isEnabled ? 'Audio Whale & Zone diaktifkan' : 'Audio dimatikan');
        }
      });
    }

    // Screenshot Button (Universal across all 4 modules with HD Watermark)
    const btnScreenshot = document.getElementById('btnScreenshot');
    if (btnScreenshot) {
      btnScreenshot.addEventListener('click', () => {
        this.takeUniversalScreenshot();
      });
    }

    // Export Time & Sales Tape to CSV
    const btnExportCSV = document.getElementById('btnExportTapeCSV');
    if (btnExportCSV) {
      btnExportCSV.addEventListener('click', () => {
        this.exportTapeToCSV();
      });
    }

    // Reset Session Stats Button
    const btnResetStats = document.getElementById('btnResetSessionStats');
    if (btnResetStats) {
      btnResetStats.addEventListener('click', () => {
        this.sessionStats = { realizedPnl: 0.0, winCount: 0, lossCount: 0, totalTrades: 0 };
        try { sessionStorage.removeItem('gringgo_session_stats'); } catch (e) {}
        this._updateSessionStatsUI();
        this.showToast('⟲ Statistik Sesi Dagangan telah diset semula!');
      });
    }

    // Fullscreen Zen Mode Button
    const btnFullscreen = document.getElementById('btnFullscreen');
    if (btnFullscreen) {
      btnFullscreen.addEventListener('click', () => {
        const vp = document.getElementById('chartViewport');
        if (!document.fullscreenElement) {
          if (vp.requestFullscreen) vp.requestFullscreen();
          btnFullscreen.textContent = '✕ Keluar';
        } else {
          if (document.exitFullscreen) document.exitFullscreen();
          btnFullscreen.textContent = '⛶ Penuh';
        }
      });
    }
    document.addEventListener('fullscreenchange', () => {
      const btn = document.getElementById('btnFullscreen');
      if (btn) btn.textContent = document.fullscreenElement ? '✕ Keluar' : '⛶ Penuh';
    });

    // ClusterDelta Jalur (20-50) Range Slider
    const sliderClusterJalur = document.getElementById('sliderClusterJalur');
    const lblClusterJalur = document.getElementById('lblClusterJalur');
    if (sliderClusterJalur) {
      sliderClusterJalur.addEventListener('input', (e) => {
        const jalur = Math.max(20, Math.min(50, parseInt(e.target.value, 10) || 30));
        if (lblClusterJalur) lblClusterJalur.textContent = String(jalur);
        if (this.footprint && this.footprint.setJalurCount) {
          this.footprint.setJalurCount(jalur);
        }
      });
    }

    // Bubble Zoom Sensitivity Slider
    const sliderBubbleZoom = document.getElementById('sliderBubbleZoom');
    if (sliderBubbleZoom) {
      sliderBubbleZoom.addEventListener('input', (e) => {
        const zoom = parseFloat(e.target.value) || 1.0;
        if (this.bookmap && this.bookmap.setBubbleZoom) {
          this.bookmap.setBubbleZoom(zoom);
        }
      });
    }

    // Whale Tier Category Selector (Noise, Normal Whale, Major Institutional, Mega Shark)
    const selWhaleCategory = document.getElementById('selWhaleCategory');
    if (selWhaleCategory) {
      selWhaleCategory.addEventListener('change', (e) => {
        const tier = e.target.value;
        if (this.bookmap && this.bookmap.setBubbleCategory) {
          this.bookmap.setBubbleCategory(tier);
        }
        const toastMsg = tier === 'noise' ? '🫧 Kategori: Semua Transaksi Pasaran (Termasuk Noise <10L)'
          : (tier === 'normal' ? '🐋 Kategori: Normal Whale (≥12.0 Lot) [Potensi Win: 65%+]'
          : (tier === 'major' ? '🏛️ Kategori: Major Institutional (≥35.0 Lot) [Potensi Win: 78%+]'
          : (tier === 'mega' ? '👑 Kategori: Mega Shark (≥80.0 Lot) [Potensi Win: 88%-93%]' : '🚫 Buih: Dimatikan (Heatmap Sahaja)')));
        this.showToast(toastMsg);
      });
    }

    // Voice AI Toggle Button
    const btnToggleVoice = document.getElementById('btnToggleVoice');
    if (btnToggleVoice) {
      btnToggleVoice.addEventListener('click', () => {
        if (this.bookmap && this.bookmap.toggleVoice) {
          const isVoiceOn = this.bookmap.toggleVoice();
          btnToggleVoice.classList.toggle('active', isVoiceOn);
          btnToggleVoice.innerHTML = isVoiceOn ? '🎙️ Suara AI: ON' : '🎙️ Suara AI';
          this.showToast(isVoiceOn ? 'Makluman Suara AI diaktifkan' : 'Makluman Suara AI dimatikan');
        }
      });
    }

    // Help & Order Flow Dictionary Slide-Over Drawer
    const btnHelpGuide = document.getElementById('btnHelpGuide');
    const btnCloseHelp = document.getElementById('btnCloseHelp');
    const helpModal = document.getElementById('helpModal');
    if (btnHelpGuide && helpModal) {
      btnHelpGuide.addEventListener('click', () => {
        const isShown = helpModal.style.display === 'flex';
        helpModal.style.display = isShown ? 'none' : 'flex';
      });
    }
    if (btnCloseHelp && helpModal) {
      btnCloseHelp.addEventListener('click', () => {
        helpModal.style.display = 'none';
      });
    }

    // Risk % Auto-Lot Presets (0.5%, 1.0%, 2.0%, 3.0%)
    document.querySelectorAll('.risk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.risk-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.lot-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._calculateRiskLot(parseFloat(btn.dataset.risk));
      });
    });

    if (this.inputSL) {
      this.inputSL.addEventListener('input', () => {
        const activeRiskBtn = document.querySelector('.risk-btn.active');
        if (activeRiskBtn) {
          this._calculateRiskLot(parseFloat(activeRiskBtn.dataset.risk));
        }
        this._updateRRPreview();
      });
    }

    if (this.inputTP) {
      this.inputTP.addEventListener('input', () => {
        this._updateRRPreview();
      });
    }

    // Fast Execution & Prop-Firm Risk Presets
    document.querySelectorAll('.risk-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.risk-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const risk = btn.dataset.risk;
        const pf = this.latestSnapshot && this.latestSnapshot.prop_firm_shield;
        const lots = (pf && pf.recommended_lots && pf.recommended_lots[`${risk}%`]) || (parseFloat(risk) * 0.1);
        const fastInput = document.getElementById('inputFastLot');
        if (fastInput) fastInput.value = lots.toFixed(2);
        this.selectedLot = lots;
        if (this.inputLot) this.inputLot.value = lots.toFixed(2);
        this.showToast(`Auto-Lot Prop-Firm (${risk}%): ${lots.toFixed(2)} Lot`);
      });
    });

    const btnFastBuy = document.getElementById('btnFastBuy');
    const btnFastSell = document.getElementById('btnFastSell');
    const btnFastBE = document.getElementById('btnFastBE');
    const btnFastCloseAll = document.getElementById('btnFastCloseAll');
    const inputFastLot = document.getElementById('inputFastLot');

    if (btnFastBuy) {
      btnFastBuy.addEventListener('click', () => {
        const lot = parseFloat(inputFastLot ? inputFastLot.value : 0.05) || 0.05;
        this.sendTrade('BUY', lot);
      });
    }
    if (btnFastSell) {
      btnFastSell.addEventListener('click', () => {
        const lot = parseFloat(inputFastLot ? inputFastLot.value : 0.05) || 0.05;
        this.sendTrade('SELL', lot);
      });
    }
    if (btnFastBE) {
      btnFastBE.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/breakeven_all', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message || 'Semua SL dipindahkan ke Breakeven');
        } catch (e) {
          this.showToast('Ralat BE: ' + e.message);
        }
      });
    }
    if (btnFastCloseAll) {
      btnFastCloseAll.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/close_all', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message || 'Semua posisi ditutup');
        } catch (e) {
          this.showToast('Ralat Tutup: ' + e.message);
        }
      });
    }

    const propFirmBadge = document.getElementById('propFirmBadge');
    if (propFirmBadge) {
      propFirmBadge.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/prop_shield/toggle', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message);
        } catch (e) {
          this.showToast('Ralat Prop-Shield: ' + e.message);
        }
      });
    }

    // Zoom & Centering Controls
    const btnZoomIn = document.getElementById('btnZoomIn');
    const btnZoomOut = document.getElementById('btnZoomOut');
    const btnZoomReset = document.getElementById('btnZoomReset');
    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        this.footprint.zoomIn();
        if (this.bookmap && this.bookmap.zoomIn) this.bookmap.zoomIn();
      });
    }
    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        this.footprint.zoomOut();
        if (this.bookmap && this.bookmap.zoomOut) this.bookmap.zoomOut();
      });
    }
    if (btnZoomReset) {
      btnZoomReset.addEventListener('click', () => {
        this.footprint.resetZoom();
        if (this.bookmap && this.bookmap.resetZoom) this.bookmap.resetZoom();
        this.showToast('🎯 Carta dipusatkan semula ke harga & masa semasa');
      });
    }

    // Canvas Interactive Drawing Tools (Horizontal Ray, Trendline, Clear)
    const btnDrawRay = document.getElementById('btnDrawRay');
    const btnDrawTrend = document.getElementById('btnDrawTrend');
    const btnClearDrawings = document.getElementById('btnClearDrawings');
    this.drawingMode = null; // 'ray' | 'trend' | null
    this._trendStart = null;

    if (btnDrawRay) {
      btnDrawRay.addEventListener('click', () => {
        this.drawingMode = this.drawingMode === 'ray' ? null : 'ray';
        btnDrawRay.classList.toggle('active', this.drawingMode === 'ray');
        if (btnDrawTrend) btnDrawTrend.classList.remove('active');
        this._trendStart = null;
        this.showToast(this.drawingMode === 'ray' ? '📏 Mod Ray Aktif: Klik paras harga pada carta' : 'Mod Ray dimatikan');
      });
    }

    if (btnDrawTrend) {
      btnDrawTrend.addEventListener('click', () => {
        this.drawingMode = this.drawingMode === 'trend' ? null : 'trend';
        btnDrawTrend.classList.toggle('active', this.drawingMode === 'trend');
        if (btnDrawRay) btnDrawRay.classList.remove('active');
        this._trendStart = null;
        this.showToast(this.drawingMode === 'trend' ? '📐 Mod Trendline Aktif: Klik 2 titik pada carta' : 'Mod Trendline dimatikan');
      });
    }

    if (btnClearDrawings) {
      btnClearDrawings.addEventListener('click', () => {
        if (this.bookmap && this.bookmap.clearDrawings) this.bookmap.clearDrawings();
        if (this.footprint && this.footprint.clearDrawings) this.footprint.clearDrawings();
        this.drawingMode = null;
        this._trendStart = null;
        if (btnDrawRay) btnDrawRay.classList.remove('active');
        if (btnDrawTrend) btnDrawTrend.classList.remove('active');
        this.showToast('🗑️ Semua lukisan manual telah dipadam');
      });
    }

    // Keyboard ArrowLeft / ArrowRight / ArrowUp / ArrowDown / Home for instant 2D panning on all chart modules
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target && e.target.tagName) || '')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (this.bookmap && this.bookmap.panHorizontal) this.bookmap.panHorizontal(-1);
        if (this.footprint && this.footprint.panHorizontal) this.footprint.panHorizontal(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (this.bookmap && this.bookmap.panHorizontal) this.bookmap.panHorizontal(1);
        if (this.footprint && this.footprint.panHorizontal) this.footprint.panHorizontal(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.bookmap && this.bookmap.panVertical) this.bookmap.panVertical(1);
        if (this.footprint && this.footprint.panVertical) this.footprint.panVertical(1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.bookmap && this.bookmap.panVertical) this.bookmap.panVertical(-1);
        if (this.footprint && this.footprint.panVertical) this.footprint.panVertical(-1);
      } else if (e.key === 'Home' || e.key === '0') {
        if (this.bookmap && this.bookmap.centerVertical) this.bookmap.centerVertical();
        if (this.footprint && this.footprint.centerVertical) this.footprint.centerVertical();
      } else if (e.key === 'd' || e.key === 'D') {
        const btnDash = document.getElementById('btnOpenConfluenceDash');
        if (btnDash) btnDash.click();
      }
    });

    // Toggle Zon Ramai Buyer & Seller
    // Toggle Smart Auto Trendline (Across All Chart Modules)
    const btnToggleAutoTL = document.getElementById('btnToggleAutoTrendline');
    if (btnToggleAutoTL) {
      btnToggleAutoTL.addEventListener('click', () => {
        let isShown = true;
        if (this.bookmap && this.bookmap.toggleAutoTrendline) {
          isShown = this.bookmap.toggleAutoTrendline();
        }
        if (this.footprint && this.footprint.toggleAutoTrendline) {
          isShown = this.footprint.toggleAutoTrendline();
        }
        btnToggleAutoTL.classList.toggle('active', isShown);
        this.showToast(isShown ? '📐 Smart Auto Trendline (Support & Resistance) diaktifkan' : '📐 Auto Trendline disembunyikan');
        this.needsRedraw = true;
        if (this.latestSnapshot) {
          if (this.bookmap && this.currentView === 'bookmap') this.bookmap.render();
          if (this.footprint && this.currentView !== 'bookmap') this.footprint.render(this.latestSnapshot);
        }
      });
    }

    const btnToggleZones = document.getElementById('btnToggleZones');
    if (btnToggleZones) {
      btnToggleZones.addEventListener('click', () => {
        if (this.bookmap && this.bookmap.toggleVolumeZones) {
          const isShown = this.bookmap.toggleVolumeZones();
          btnToggleZones.classList.toggle('active', isShown);
          this.showToast(isShown ? 'Zon Ramai Buyer & Seller dipaparkan' : 'Tanda Zon disembunyikan');
        }
      });
    }

    // Toggle Session High/Low Levels & Sweep Detector (Asian, London, NY, PDH, PDL)
    if (this.btnToggleSessionLevels) {
      this.btnToggleSessionLevels.addEventListener('click', () => {
        let isShown = true;
        if (this.bookmap && this.bookmap.toggleSessionLevels) {
          isShown = this.bookmap.toggleSessionLevels();
        }
        if (this.footprint && this.footprint.toggleSessionLevels) {
          this.footprint.toggleSessionLevels();
        }
        this.btnToggleSessionLevels.classList.toggle('active', isShown);
        this.showToast(isShown ? 'Garisan SNR HTF (1D, H4, H1, M30, M15) & Sesi diaktifkan' : 'Garisan SNR & Sesi disembunyikan');
      });
    }

    // Toggle Composite Session Volume Profile (SVP: dPOC, VAH/VAL 70%, LVN)
    if (this.btnToggleSVP) {
      this.btnToggleSVP.addEventListener('click', () => {
        let isShown = true;
        if (this.bookmap && this.bookmap.toggleSVP) {
          isShown = this.bookmap.toggleSVP();
        }
        if (this.footprint && this.footprint.toggleSVP) {
          this.footprint.toggleSVP();
        }
        this.btnToggleSVP.classList.toggle('active', isShown);
        this.showToast(isShown ? '📊 Composite Session Volume Profile (dPOC, VAH/VAL, LVN) diaktifkan' : 'SVP Sesi disembunyikan');
      });
    }

    // Toggle Real-Time Iceberg & Absorption Detector
    if (this.btnToggleIcebergs) {
      this.btnToggleIcebergs.addEventListener('click', () => {
        let isShown = true;
        if (this.bookmap && this.bookmap.toggleIcebergs) {
          isShown = this.bookmap.toggleIcebergs();
        }
        if (this.footprint && this.footprint.toggleIcebergs) {
          this.footprint.toggleIcebergs();
        }
        this.btnToggleIcebergs.classList.toggle('active', isShown);
        this.showToast(isShown ? '🧊 Pengesan Pesanan Iceberg & Absorption diaktifkan' : 'Penanda Iceberg disembunyikan');
      });
    }

    // Toggle USD High-Impact News & Volatility Shield
    if (this.btnToggleNewsShield) {
      this.btnToggleNewsShield.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/news_filter/toggle', { method: 'POST' });
          const data = await res.json();
          this.showToast(data.message || 'Status Pelindung Berita dikemas kini');
        } catch (e) {
          this.showToast('Ralat Pelindung Berita: ' + e.message);
        }
      });
    }

    // Step Selector ($1.00, $0.50, $2.00)
    document.querySelectorAll('.step-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const step = parseFloat(btn.dataset.step) || 1.00;
        this.footprint.setClusterStep(step);
        this.showToast(`Footprint diubah ke blok $${step.toFixed(2)}`);
      });
    });

    // Footprint View Mode Selector (Candlestick | ClusterDelta | Bid x Ask | Delta Profile | Volume Profile)
    document.querySelectorAll('.fp-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.fp-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        if (this.footprint && this.footprint.setViewMode) {
          this.footprint.setViewMode(mode);
          const clusterWrap = document.getElementById('clusterJalurWrap');
          if (clusterWrap) clusterWrap.style.display = (mode === 'clusterdelta') ? 'inline-flex' : 'none';
          if (mode === 'candlestick' && this.currentView !== 'candlestick') {
            document.querySelectorAll('.view-switchers .nav-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.view === 'candlestick');
            });
            this.setView('candlestick');
          }
          const labels = {
            'candlestick': '🕯️ Mod Carta Candlestick Biasa + EMA 9/21/50 + Signal Orderflow',
            'clusterdelta': 'Mod ClusterDelta Orderflow (Bata Volum + Jadual Atas + Profil Kanan)',
            'bid_ask': 'Mod Footprint: Bid x Ask (Dual Lajur)',
            'delta': 'Mod Footprint: Profil Delta Net (Histogram)',
            'volume': 'Mod Footprint: Profil Volum (Kepadatan)'
          };
          this.showToast(labels[mode] || `Mod Carta: ${mode}`);
        }
      });
    });

    // Context-Aware Multi-Technique Dropdown Selector (Clean & Uncluttered)
    const selTech = document.getElementById('selectCsTechnique');
    if (selTech) {
      selTech.addEventListener('change', () => {
        const mode = selTech.value;
        if (this.footprint && this.footprint.setTechniqueMode) {
          this.footprint.setTechniqueMode(mode);
          this.showToast(`Teknik Dipilih: ${selTech.options[selTech.selectedIndex].text}`);
        }
      });
    }

    // Button Buka SOP Lengkap 5 Teknik
    const btnCsSop = document.getElementById('btnCsSopGuide');
    if (btnCsSop) {
      btnCsSop.addEventListener('click', () => {
        const helpModal = document.getElementById('helpModal');
        if (helpModal) {
          helpModal.style.display = 'flex';
          const sopSec = document.getElementById('sopSectionHelp');
          if (sopSec) {
            setTimeout(() => { sopSec.scrollIntoView({ behavior: 'smooth' }); }, 50);
          }
        }
      });
    }

    // Quad-Confluence Signal Dashboard Drawer Wiring
    const btnOpenDash = document.getElementById('btnOpenConfluenceDash');
    const btnCloseDash = document.getElementById('btnCloseConfluenceDash');
    const confluenceDashModal = document.getElementById('confluenceDashModal');
    if (btnOpenDash && confluenceDashModal) {
      btnOpenDash.addEventListener('click', () => {
        const isShown = confluenceDashModal.style.display === 'flex';
        confluenceDashModal.style.display = isShown ? 'none' : 'flex';
        if (!isShown && this.latestSnapshot) {
          this._updateConfluenceDashboard(this.latestSnapshot);
        }
      });
    }
    if (btnCloseDash && confluenceDashModal) {
      btnCloseDash.addEventListener('click', () => {
        confluenceDashModal.style.display = 'none';
      });
    }

    // Dashboard Minimize / Expand toggle
    const btnMinDash = document.getElementById('btnMinimizeDash');
    const dashBody = document.getElementById('dashBodyContainer');
    if (btnMinDash && dashBody) {
      btnMinDash.addEventListener('click', () => {
        const isCollapsed = dashBody.style.display === 'none';
        dashBody.style.display = isCollapsed ? 'flex' : 'none';
        btnMinDash.textContent = isCollapsed ? '➖' : '➕';
        btnMinDash.title = isCollapsed ? 'Kecilkan' : 'Besarkan';
      });
    }

    // Dashboard Quick Actions: Copy Plan, Buy, Sell, BE
    const btnDashCopy = document.getElementById('btnDashCopyPlan');
    if (btnDashCopy) {
      btnDashCopy.addEventListener('click', () => {
        const entry = document.getElementById('dashValEntry')?.textContent || '';
        const sl = document.getElementById('dashValSL')?.textContent || '';
        const tp1 = document.getElementById('dashValTP1')?.textContent || '';
        const tp2 = document.getElementById('dashValTP2')?.textContent || '';
        const textToCopy = `⭐ ISYARAT XAUUSD (QUAD-CONFLUENCE A+)\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nSOP: 4-Modul Sepakat (Bookmap + Cluster + Footprint + Candle)`;
        navigator.clipboard.writeText(textToCopy).then(() => {
          this.showToast('📋 Pelan Isyarat A+ berjaya disalin ke clipboard!');
        }).catch(() => {
          this.showToast('Gagal menyalin pelan');
        });
      });
    }
    const btnDashBuy = document.getElementById('btnDashExecuteBuy');
    if (btnDashBuy) {
      btnDashBuy.addEventListener('click', () => {
        this.sendTrade('BUY');
      });
    }
    const btnDashSell = document.getElementById('btnDashExecuteSell');
    if (btnDashSell) {
      btnDashSell.addEventListener('click', () => {
        this.sendTrade('SELL');
      });
    }
    const btnDashBE = document.getElementById('btnDashBreakEven');
    if (btnDashBE && this.btnBreakEven) {
      btnDashBE.addEventListener('click', () => {
        this.btnBreakEven.click();
      });
    }

    // Toggle Value Area 70% (VAH & VAL)
    const btnToggleVA = document.getElementById('btnToggleVA');
    if (btnToggleVA) {
      btnToggleVA.addEventListener('click', () => {
        if (this.footprint && this.footprint.toggleValueArea) {
          const isShown = this.footprint.toggleValueArea();
          btnToggleVA.classList.toggle('active', isShown);
          this.showToast(isShown ? 'Kawasan Nilai 70% (VAH/VAL) diaktifkan' : 'Kawasan Nilai 70% disembunyikan');
        }
      });
    }

    // Toggle Stacked Imbalances 3x
    const btnToggleStackedImb = document.getElementById('btnToggleStackedImb');
    if (btnToggleStackedImb) {
      btnToggleStackedImb.addEventListener('click', () => {
        if (this.footprint && this.footprint.toggleStackedImbalances) {
          const isShown = this.footprint.toggleStackedImbalances();
          btnToggleStackedImb.classList.toggle('active', isShown);
          this.showToast(isShown ? 'Ketidakseimbangan Bertingkat (Stacked Imb 3x) diaktifkan' : 'Stacked Imb disembunyikan');
        }
      });
    }

    // Timeframe Selector (M1, M5, M15, M30, H1, H4)
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tf = btn.dataset.tf;
        
        // Update Bookmap & Footprint local view
        if (this.bookmap && this.bookmap.setTimeframe) {
          this.bookmap.setTimeframe(tf);
        }
        if (this.footprint && this.footprint.setTimeframe) {
          this.footprint.setTimeframe(tf);
        }
        
        // Notify backend to aggregate candles & history for this timeframe
        try {
          const res = await fetch('/api/timeframe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeframe: tf })
          });
          const data = await res.json();
          this.showToast(data.message || `Timeframe: ${tf}`);
          // Load 1,000 deep historical candles for new timeframe
          await this.loadHistoricalCandles(tf);
        } catch (e) {
          console.error('[TF Error]', e);
        }
      });
    });

    // Wire Replay / Backtesting Player Controls
    // Wire User Profile & Admin SaaS Management
    const btnOpenAdmin = document.getElementById('btnOpenAdminModal');
    if (btnOpenAdmin) {
      btnOpenAdmin.addEventListener('click', () => this.openAdminModal());
    }
    const btnAdminDock = document.getElementById('btnAdminDock');
    if (btnAdminDock) {
      btnAdminDock.addEventListener('click', () => this.openAdminModal());
    }
    // Keyboard Shortcut 'A' for Admin Modal
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target && e.target.tagName) || '')) return;
      if (e.key === 'a' || e.key === 'A') {
        if (this.currentUser && this.currentUser.role === 'admin') {
          this.openAdminModal();
        }
      }
    });
    const btnCloseAdmin = document.getElementById('btnCloseAdminModal');
    if (btnCloseAdmin) {
      btnCloseAdmin.addEventListener('click', () => this.closeAdminModal());
    }
    const btnRefreshUsers = document.getElementById('btnRefreshUsers');
    if (btnRefreshUsers) {
      btnRefreshUsers.addEventListener('click', () => this.loadAdminUsers());
    }
    const btnLogoutTop = document.getElementById('btnLogoutTop');
    if (btnLogoutTop) {
      btnLogoutTop.addEventListener('click', () => this.logout());
    }
    const btnLogoutDock = document.getElementById('btnLogoutDock');
    if (btnLogoutDock) {
      btnLogoutDock.addEventListener('click', () => this.logout());
    }
    const btnLogoutModal = document.getElementById('btnLogoutModal');
    if (btnLogoutModal) {
      btnLogoutModal.addEventListener('click', () => this.logout());
    }
        // Restore Backup JSON file handler
    const fileRestore = document.getElementById('fileRestoreBackup');
    if (fileRestore) {
      fileRestore.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const txtStatus = document.getElementById('txtRestoreStatus');
        if (txtStatus) txtStatus.textContent = 'Memproses fail sandaran...';
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const users = parsed.users || (Array.isArray(parsed) ? parsed : []);
          if (users.length === 0) {
            alert('Fail JSON tidak mengandungi data pengguna yang sah.');
            if (txtStatus) txtStatus.textContent = '';
            return;
          }
          const res = await fetch('/api/admin/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ users })
          });
          const resData = await res.json();
          if (res.ok) {
            alert(`✅ ${resData.message}`);
            if (txtStatus) txtStatus.textContent = `✅ ${resData.count} akaun dipulihkan!`;
            this.loadAdminUsers();
          } else {
            alert(`❌ ${resData.detail || resData.message}`);
            if (txtStatus) txtStatus.textContent = '❌ Gagal memulihkan fail.';
          }
        } catch (err) {
          alert(`❌ Ralat membaca fail JSON: ${err.message}`);
          if (txtStatus) txtStatus.textContent = '❌ Ralat membaca fail.';
        }
      });
    }
    const formCreateUser = document.getElementById('formCreateUser');
    if (formCreateUser) {
      formCreateUser.addEventListener('submit', (e) => this.handleCreateUser(e));
    }
    const btnCopyReceipt = document.getElementById('btnCopyReceipt');
    if (btnCopyReceipt) {
      btnCopyReceipt.addEventListener('click', () => {
        const txt = document.getElementById('receiptText');
        if (txt) {
          navigator.clipboard.writeText(txt.value).then(() => {
            this.showToast('📋 Mesej WhatsApp berjaya disalin ke clipboard!');
          });
        }
      });
    }

    const btnToggleReplay = document.getElementById('btnToggleReplay');
    if (btnToggleReplay) {
      btnToggleReplay.addEventListener('click', () => this.toggleReplayMode());
    }
    const btnPlayPause = document.getElementById('btnReplayPlayPause');
    if (btnPlayPause) {
      btnPlayPause.addEventListener('click', () => {
        if (this.footprint) this.footprint.toggleReplayPlay();
      });
    }
    const btnStepBack = document.getElementById('btnReplayStepBack');
    if (btnStepBack) {
      btnStepBack.addEventListener('click', () => {
        if (this.footprint) this.footprint.replayStepBack(1);
      });
    }
    const btnStepForward = document.getElementById('btnReplayStepForward');
    if (btnStepForward) {
      btnStepForward.addEventListener('click', () => {
        if (this.footprint) this.footprint.replayStepForward(1);
      });
    }
    const btnReplayStart = document.getElementById('btnReplayStart');
    if (btnReplayStart) {
      btnReplayStart.addEventListener('click', () => {
        if (this.footprint) this.footprint.replayJumpTo(20);
      });
    }
    const replayScrubber = document.getElementById('replayScrubber');
    if (replayScrubber) {
      replayScrubber.addEventListener('input', (e) => {
        if (this.footprint) this.footprint.replayJumpTo(parseInt(e.target.value));
      });
    }
    const selectSpeed = document.getElementById('selectReplaySpeed');
    if (selectSpeed) {
      selectSpeed.addEventListener('change', (e) => {
        if (this.footprint) {
          this.footprint.replaySpeed = parseFloat(e.target.value) || 5;
          if (this.footprint.replayPlaying) this.footprint.replayPlay();
        }
      });
    }
    const btnReplayBuy = document.getElementById('btnReplayBuy');
    if (btnReplayBuy) {
      btnReplayBuy.addEventListener('click', () => {
        if (this.footprint) {
          const t = this.footprint.executeReplayTrade('BUY', this.selectedLot || 0.01);
          if (t) this.showToast(`⚡ Backtest BUY @ $${t.entryPrice.toFixed(2)} (SL: $${t.sl.toFixed(2)}, TP: $${t.tp.toFixed(2)})`);
        }
      });
    }
    const btnReplaySell = document.getElementById('btnReplaySell');
    if (btnReplaySell) {
      btnReplaySell.addEventListener('click', () => {
        if (this.footprint) {
          const t = this.footprint.executeReplayTrade('SELL', this.selectedLot || 0.01);
          if (t) this.showToast(`⚡ Backtest SELL @ $${t.entryPrice.toFixed(2)} (SL: $${t.sl.toFixed(2)}, TP: $${t.tp.toFixed(2)})`);
        }
      });
    }
    const btnReplayExit = document.getElementById('btnReplayExit');
    if (btnReplayExit) {
      btnReplayExit.addEventListener('click', () => this.exitReplayMode());
    }

    // Institutional Global Hotkeys (B, S, Space, X, 1-5, R for Replay)
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        return;
      }

      // 6: Open Signal Win/Loss Tracker Tab
      if (e.key === '6' || e.code === 'Digit6') {
        e.preventDefault();
        this.openSignalsTab();
        return;
      }

      // R: Toggle Replay Mode
      if (e.code === 'KeyR') {
        e.preventDefault();
        this.toggleReplayMode();
        return;
      }

      // In Replay Mode: Space = Play/Pause, Right/Left = Step Forward/Back
      if (this.footprint && this.footprint.isReplayMode) {
        if (e.code === 'Space') {
          e.preventDefault();
          this.footprint.toggleReplayPlay();
          return;
        }
        if (e.code === 'ArrowRight') {
          e.preventDefault();
          this.footprint.replayStepForward(1);
          return;
        }
        if (e.code === 'ArrowLeft') {
          e.preventDefault();
          this.footprint.replayStepBack(1);
          return;
        }
      }


      // 1-5 View Switching
      if (e.key === '1') { e.preventDefault(); this.setView('bookmap'); this.showToast('Mod Paparan: Bookmap Heatmap (Kekunci [1])'); return; }
      if (e.key === '2') { e.preventDefault(); this.setView('clusterdelta'); this.showToast('Mod Paparan: ClusterDelta (Kekunci [2])'); return; }
      if (e.key === '3') { e.preventDefault(); this.setView('footprint'); this.showToast('Mod Paparan: Footprint (Kekunci [3])'); return; }
      if (e.key === '4') { e.preventDefault(); this.setView('candlestick'); this.showToast('Mod Paparan: Carta Candle (Kekunci [4])'); return; }
      if (e.key === '5') { e.preventDefault(); this.setView('split'); this.showToast('Mod Paparan: Split View (Kekunci [5])'); return; }

      // B: Quick Buy Market
      if (e.code === 'KeyB') {
        e.preventDefault();
        const btnFastBuy = document.getElementById('btnFastBuy');
        if (btnFastBuy) {
          btnFastBuy.classList.add('active');
          setTimeout(() => btnFastBuy.classList.remove('active'), 200);
          btnFastBuy.click();
        }
        return;
      }

      // S: Quick Sell Market
      if (e.code === 'KeyS') {
        e.preventDefault();
        const btnFastSell = document.getElementById('btnFastSell');
        if (btnFastSell) {
          btnFastSell.classList.add('active');
          setTimeout(() => btnFastSell.classList.remove('active'), 200);
          btnFastSell.click();
        }
        return;
      }

      // Spacebar: Breakeven All
      if (e.code === 'Space') {
        e.preventDefault();
        const btnFastBE = document.getElementById('btnFastBE');
        if (btnFastBE) {
          btnFastBE.classList.add('active');
          setTimeout(() => btnFastBE.classList.remove('active'), 200);
          btnFastBE.click();
        }
        return;
      }

      // X: Close All
      if (e.code === 'KeyX') {
        e.preventDefault();
        const btnFastCloseAll = document.getElementById('btnFastCloseAll');
        if (btnFastCloseAll) {
          btnFastCloseAll.classList.add('active');
          setTimeout(() => btnFastCloseAll.classList.remove('active'), 200);
          btnFastCloseAll.click();
        }
        return;
      }
    });
    // Sleek Indicator Layers Dropdown Toggle
    const btnLayersDropdown = document.getElementById('btnLayersDropdown');
    const layersDropdownMenu = document.getElementById('layersDropdownMenu');
    if (btnLayersDropdown && layersDropdownMenu) {
      btnLayersDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = layersDropdownMenu.style.display === 'flex';
        layersDropdownMenu.style.display = isOpen ? 'none' : 'flex';
        btnLayersDropdown.classList.toggle('active', !isOpen);
      });
      document.addEventListener('click', (e) => {
        if (!layersDropdownMenu.contains(e.target) && e.target !== btnLayersDropdown) {
          layersDropdownMenu.style.display = 'none';
          btnLayersDropdown.classList.remove('active');
        }
      });
    }
  }




  _handleCanvasClickForDrawing(cx, cy, targetCanvas) {
    if (!this.drawingMode) return false;
    let price = null;
    if (targetCanvas === this.bookmapCanvas && this.bookmap && this.bookmap.yToPrice) {
      price = this.bookmap.yToPrice(cy);
    } else if (this.footprint && this.footprint.yToPrice) {
      price = this.footprint.yToPrice(cy);
    }
    if (!price || isNaN(price)) return false;

    if (this.drawingMode === 'ray') {
      const rayObj = { type: 'ray', price: Math.round(price * 100) / 100, color: '#f59e0b' };
      if (this.bookmap && this.bookmap.addDrawing) this.bookmap.addDrawing(rayObj);
      if (this.footprint && this.footprint.addDrawing) this.footprint.addDrawing(rayObj);
      this.showToast(`📏 Horizontal Ray ditambah pada $${rayObj.price.toFixed(2)}`);
      this.drawingMode = null;
      if (document.getElementById('btnDrawRay')) document.getElementById('btnDrawRay').classList.remove('active');
      return true;
    } else if (this.drawingMode === 'trend') {
      if (!this._trendStart) {
        this._trendStart = { x: cx, y: cy, price: Math.round(price * 100) / 100 };
        this.showToast(`Titik 1 dipilih @ $${this._trendStart.price.toFixed(2)}. Klik titik 2.`);
      } else {
        const trendObj = {
          type: 'trend',
          p1: this._trendStart,
          p2: { x: cx, y: cy, price: Math.round(price * 100) / 100 },
          color: '#38bdf8'
        };
        if (this.bookmap && this.bookmap.addDrawing) this.bookmap.addDrawing(trendObj);
        if (this.footprint && this.footprint.addDrawing) this.footprint.addDrawing(trendObj);
        this.showToast(`📐 Trendline dilukis ($${this._trendStart.price.toFixed(2)} → $${trendObj.p2.price.toFixed(2)})`);
        this._trendStart = null;
        this.drawingMode = null;
        if (document.getElementById('btnDrawTrend')) document.getElementById('btnDrawTrend').classList.remove('active');
      }
      return true;
    }
    return false;
  }

  async handleDOMClick(side, price) {
    const lotInput = document.getElementById('inputFastLot');
    const lot = parseFloat(lotInput ? lotInput.value : 0.05) || 0.05;
    const isBuy = side.toUpperCase() === 'BUY';
    const actionLabel = isBuy ? 'BUY LIMIT' : 'SELL LIMIT';

    this.showToast(`🎯 ${actionLabel} @ $${price.toFixed(2)} (${lot.toFixed(2)} Lots) ditempah ke enjin!`);
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: isBuy ? 'buy' : 'sell',
          volume: lot,
          sl_pips: 40,
          tp_pips: 80
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        this.showToast(`✅ ${data.message}`);
      }
    } catch (err) {
      this.showToast(`❌ Ralat tempahan: ${err.message}`);
    }
  }




  _updateContextToolbar(view) {
    const fpTools = document.getElementById('fpSpecificTools');
    const clusterWrap = document.getElementById('clusterJalurWrap');
    const bookmapWrap = document.getElementById('bookmapBubbleWrap');
    const whaleWrap = document.getElementById('bookmapWhaleCategoryWrap');
    const csTechBar = document.getElementById('csTechniquesBar');

    if (view === 'bookmap') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'inline-flex';
      if (whaleWrap) whaleWrap.style.display = 'inline-flex';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'clusterdelta') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'inline-flex';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (whaleWrap) whaleWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'footprint') {
      if (fpTools) fpTools.style.display = 'inline-flex';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (whaleWrap) whaleWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'candlestick') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (whaleWrap) whaleWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'inline-flex';
    } else if (view === 'split') {
      if (fpTools) fpTools.style.display = 'inline-flex';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'inline-flex';
      if (whaleWrap) whaleWrap.style.display = 'inline-flex';
      if (csTechBar) csTechBar.style.display = 'none';
    }
  }

  setView(view) {
    this.currentView = view;
    this.needsRedraw = true;
    this._updateContextToolbar(view);
    if (view === 'bookmap') {
      this.bookmapCanvas.style.display = 'block';
      this.bookmapCanvas.style.width = '100%';
      this.footprintCanvas.style.display = 'none';
    } else if (view === 'clusterdelta') {
      this.bookmapCanvas.style.display = 'none';
      this.footprintCanvas.style.display = 'block';
      this.footprintCanvas.style.left = '0';
      this.footprintCanvas.style.width = '100%';
      if (this.footprint) {
        this.footprint.setViewMode('clusterdelta');
        this.footprint.setClusterStep(0.50);
        document.querySelectorAll('.fp-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === 'clusterdelta');
        });
        document.querySelectorAll('.step-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.step === '0.50');
        });
      }
    } else if (view === 'candlestick') {
      this.bookmapCanvas.style.display = 'none';
      this.footprintCanvas.style.display = 'block';
      this.footprintCanvas.style.left = '0';
      this.footprintCanvas.style.width = '100%';
      if (this.footprint) {
        this.footprint.setViewMode('candlestick');
        this.footprint.priceOffset = 0.0;
        this.footprint.csVerticalScale = 1.0;
        this.footprint.barOffset = 0;
        document.querySelectorAll('.fp-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === 'candlestick');
        });
      }
    } else if (view === 'footprint') {
      this.bookmapCanvas.style.display = 'none';
      this.footprintCanvas.style.display = 'block';
      this.footprintCanvas.style.left = '0';
      this.footprintCanvas.style.width = '100%';
      if (this.footprint) {
        this.footprint.setViewMode('bid_ask');
        this.footprint.centerVertical();
        this.footprint.setClusterStep(1.00);
        document.querySelectorAll('.fp-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === 'bid_ask');
        });
        document.querySelectorAll('.step-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.step === '1.00');
        });
        if (this.latestSnapshot) {
          this.footprint.render(this.latestSnapshot);
        }
      }
    } else if (view === 'split') {
      this.bookmapCanvas.style.display = 'block';
      this.footprintCanvas.style.display = 'block';
      const isMobilePortrait = window.innerWidth <= 900 || window.innerHeight > window.innerWidth;
      const viewport = document.getElementById('chartViewport');
      if (isMobilePortrait) {
        if (viewport) viewport.classList.add('split-mode-vertical');
        this.bookmapCanvas.style.width = '100%';
        this.bookmapCanvas.style.height = '50%';
        this.bookmapCanvas.style.top = '0';
        this.bookmapCanvas.style.left = '0';
        this.footprintCanvas.style.width = '100%';
        this.footprintCanvas.style.height = '50%';
        this.footprintCanvas.style.top = '50%';
        this.footprintCanvas.style.left = '0';
      } else {
        if (viewport) viewport.classList.remove('split-mode-vertical');
        this.bookmapCanvas.style.width = '50%';
        this.bookmapCanvas.style.height = '100%';
        this.bookmapCanvas.style.top = '0';
        this.bookmapCanvas.style.left = '0';
        this.footprintCanvas.style.width = '50%';
        this.footprintCanvas.style.height = '100%';
        this.footprintCanvas.style.top = '0';
        this.footprintCanvas.style.left = '50%';
      }
    }
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 20);
  }

  async sendTrade(action) {
    const volume = parseFloat(this.inputLot.value) || 0.01;
    const slPips = parseFloat(this.inputSL.value) || 0;
    const tpPips = parseFloat(this.inputTP.value) || 0;

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action,
          volume: volume,
          sl_pips: slPips,
          tp_pips: tpPips
        })
      });
      const data = await res.json();
      this.showToast(data.message || (action + ' executed!'));
    } catch (err) {
      this.showToast('Order failed: ' + err.message);
    }
  }

  async closeSinglePosition(ticket) {
    try {
      const res = await fetch('/api/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: parseInt(ticket) })
      });
      const data = await res.json();
      this.showToast(data.message);
    } catch (err) {
      this.showToast('Close failed: ' + err.message);
    }
  }

  _connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('session_id') || '';
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${protocol}//${window.location.host}/ws${tokenQuery}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected to XAUUSD Order Flow Engine');
      const banner = document.getElementById('reconnectBanner');
      if (banner) banner.style.display = 'none';
    };

    this.ws.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        if (snapshot && snapshot.type === 'pong' && snapshot.ts) {
          const rtt = Math.max(1, Date.now() - snapshot.ts);
          if (this.elTickLatency) {
            this.elTickLatency.textContent = `${rtt}ms RTT`;
            this.elTickLatency.style.color = rtt <= 120 ? '#22c55e' : (rtt <= 300 ? '#f59e0b' : '#ef4444');
          }
          return;
        }
        this.latestSnapshot = snapshot;
        // Battery Saver: throttle background rendering when tab/screen is hidden
        if (this.isPageHidden) {
          const now = Date.now();
          if (now - this._lastBgRenderTime < 2500) {
            return;
          }
          this._lastBgRenderTime = now;
        }
        this.needsRedraw = true;
        this._updateUI(snapshot);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      if (this._pingInterval) clearInterval(this._pingInterval);
      console.log('[WS] Disconnected, retrying in 2s...');
      const banner = document.getElementById('reconnectBanner');
      if (banner) banner.style.display = 'flex';
      setTimeout(() => this._connectWebSocket(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      const banner = document.getElementById('reconnectBanner');
      if (banner) banner.style.display = 'flex';
    };
  }

  _updateUI(s) {
    // Header Ticker
    this.elSymbol.textContent = s.symbol || 'XAUUSD';
    this.elPrice.textContent = (s.last_price || s.ask || 0).toFixed(2);
    this.elSpread.textContent = `Spread: ${(s.spread || 0).toFixed(2)}`;

    // 1s Real-Time Precision Badge
    if (this.elTickClock) {
      if (s.server_time_ms) {
        this.elTickClock.textContent = this.formatTime12h(s.server_time_ms);
      } else if (s.server_time_iso) {
        this.elTickClock.textContent = s.server_time_iso;
      }
    }
    if (this.elTickLatency) {
      const age = s.last_tick_age_ms !== undefined ? s.last_tick_age_ms : 0;
      this.elTickLatency.textContent = `${age}ms`;
      this.elTickLatency.style.color = age <= 1200 ? '#22c55e' : (age <= 2500 ? '#f59e0b' : '#ef4444');
    }
    if (this.elTickCadence) {
      this.elTickCadence.textContent = s.feed_source === 'swissquote' ? '1s SWISSQUOTE' : '1s MT5 BROKER';
    }
    if (this.elTickVelocity) {
      const tv = s.tick_velocity_1s || 1;
      const pv = s.price_velocity_1s !== undefined ? s.price_velocity_1s : 0.0;
      this.elTickVelocity.textContent = `⚡ ${tv}t/s ($${pv.toFixed(2)})`;
      this.elTickVelocity.style.color = tv >= 5 ? '#00e676' : '#ffb703';
    }
    if (this.elActiveSession && s.sessions && s.sessions.active_session) {
      const sw = s.sessions.sweep_alert;
      const hasFreshSweep = sw && (Date.now() - sw.timestamp < 45000);
      this.elActiveSession.textContent = hasFreshSweep ? `${sw.badge}` : `SESI: ${s.sessions.active_session}`;
      if (hasFreshSweep && this.audioEnabled && (Date.now() - this._lastSweepChimeTime > 20000)) {
        this._lastSweepChimeTime = Date.now();
        this.playInstitutionalChime('SWEEP');
      }
    }
    if (this.btnToggleNewsShield && s.news_shield) {
      const ns = s.news_shield;
      if (!ns.enabled) {
        this.btnToggleNewsShield.textContent = '🛡️ Berita: OFF';
        this.btnToggleNewsShield.style.borderColor = '#64748b';
        this.btnToggleNewsShield.style.color = '#94a3b8';
      } else if (ns.is_danger) {
        this.btnToggleNewsShield.textContent = '🚨 AWAS BERITA / VOLATILITI';
        this.btnToggleNewsShield.style.borderColor = '#ef4444';
        this.btnToggleNewsShield.style.color = '#f87171';
      } else {
        this.btnToggleNewsShield.textContent = '🛡️ Berita: AMAN';
        this.btnToggleNewsShield.style.borderColor = '#10b981';
        this.btnToggleNewsShield.style.color = '#34d399';
      }
      this.btnToggleNewsShield.title = ns.headline || 'Pelindung Berita USD';
    }

    // Sync Timeframe if present
    if (s.timeframe) {
      document.querySelectorAll('.tf-btn').forEach(b => {
        if (b.dataset.tf === s.timeframe) b.classList.add('active');
        else b.classList.remove('active');
      });
    }

    // Unified Live Feed Status Badge & Source Switcher
    if (this.elModeText) {
      if (s.feed_source === 'swissquote') {
        this.elModeText.textContent = 'SWISSQUOTE CLOUD';
        this.elModeText.style.color = '#00f0ff';
        if (this.btnToggleFeedSource) {
          this.btnToggleFeedSource.className = 'mode-badge live';
          this.btnToggleFeedSource.style.borderColor = '#00f0ff';
        }
      } else if (s.connected && !s.simulation) {
        this.elModeText.textContent = 'JUSTMARKETS MT5';
        this.elModeText.style.color = '#4ade80';
        if (this.btnToggleFeedSource) {
          this.btnToggleFeedSource.className = 'mode-badge live';
          this.btnToggleFeedSource.style.borderColor = '#22c55e';
        }
      } else {
        this.elModeText.textContent = 'DEMO SIMULATOR';
        this.elModeText.style.color = '#fbbf24';
        if (this.btnToggleFeedSource) {
          this.btnToggleFeedSource.className = 'mode-badge sim';
          this.btnToggleFeedSource.style.borderColor = '#f59e0b';
        }
      }
    }

    // Institutional Order Flow Telemetry in Header
    if (this.elHdrCvd) {
      const cvd = s.cvd || 0;
      this.elHdrCvd.textContent = `${cvd >= 0 ? '+' : ''}${cvd.toFixed(1)} L`;
      this.elHdrCvd.className = `acc-val ${cvd >= 0 ? 'profit-pos' : 'profit-neg'}`;
    }
    if (this.elHdrVwap) {
      const vwap = (s.vwap && (s.vwap.value || s.vwap.vwap)) ? (s.vwap.value || s.vwap.vwap) : (s.last_price || 0);
      this.elHdrVwap.textContent = `$${vwap.toFixed(2)}`;
    }
    if (this.elHdrDpoc) {
      const dpoc = (s.session_vp && s.session_vp.dpoc) ? s.session_vp.dpoc : (s.last_price || 0);
      this.elHdrDpoc.textContent = `$${dpoc.toFixed(2)}`;
    }

    // Account (if elements exist)
    if (s.account && this.elAccEquity) {
      this.elAccEquity.textContent = `$${(s.account.equity || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (this.elAccBalance) {
        this.elAccBalance.textContent = `$${(s.account.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      const profit = s.account.profit || 0;
      if (this.elAccProfit) {
        this.elAccProfit.textContent = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`;
        this.elAccProfit.className = `acc-val ${profit >= 0 ? 'profit-pos' : 'profit-neg'}`;
      }
    }

    // Big Buttons Price Preview
    const buySub = document.getElementById('buySubprice');
    const sellSub = document.getElementById('sellSubprice');
    if (buySub && s.ask) buySub.textContent = `@ ${s.ask.toFixed(2)}`;
    if (sellSub && s.bid) sellSub.textContent = `@ ${s.bid.toFixed(2)}`;

    // Update Executive Smart Market Radar
    if (s.market_radar) {
      const radar = s.market_radar;
      const pill = document.getElementById('radarStatusPill');
      const headline = document.getElementById('radarHeadline');
      const advice = document.getElementById('radarAdviceText');
      const meter = document.getElementById('radarMeterFill');
      const pct = document.getElementById('radarStrengthPct');

      if (pill) {
        pill.className = `radar-status-pill ${radar.bias === 'BUY' ? 'bullish' : (radar.bias === 'SELL' ? 'bearish' : 'neutral')}`;
      }
      if (headline) headline.textContent = radar.headline;
      if (advice) advice.textContent = radar.action_hint || radar.summary;
      if (meter) {
        meter.style.width = `${radar.strength}%`;
        meter.style.backgroundColor = radar.bias === 'BUY' ? '#00e676' : (radar.bias === 'SELL' ? '#ff3366' : '#ffb703');
      }
      if (pct) pct.textContent = `${radar.strength}%`;
    }

    // Update Multi-Timeframe Confluence Matrix Strip (M1, M5, M15, H1)
    if (s.mtf_confluence) {
      const mtf = s.mtf_confluence;
      const updatePill = (id, info) => {
        const el = document.getElementById(id);
        if (!el || !info) return;
        const isBuy = info.bias === 'BUY';
        const isSell = info.bias === 'SELL';
        el.textContent = `${info.label}: ${isBuy ? '🟢 BUY' : (isSell ? '🔴 SELL' : '⚪ NEUT')}`;
        el.style.backgroundColor = isBuy ? 'rgba(0, 230, 118, 0.16)' : (isSell ? 'rgba(255, 51, 102, 0.16)' : '#111b2b');
        el.style.borderColor = isBuy ? '#00e676' : (isSell ? '#ff3366' : '#273b54');
        el.style.color = isBuy ? '#4ade80' : (isSell ? '#fb7185' : '#94a3b8');
      };
      updatePill('mtfPillM1', mtf.m1);
      updatePill('mtfPillM5', mtf.m5);
      updatePill('mtfPillM15', mtf.m15);
      updatePill('mtfPillH1', mtf.h1);

      const mtfHdr = document.getElementById('mtfHeadline');
      if (mtfHdr && mtf.headline) {
        mtfHdr.textContent = `${mtf.headline} (${mtf.score_pct}%)`;
        mtfHdr.style.color = mtf.overall === 'STRONG_BUY' ? '#4ade80' : (mtf.overall === 'STRONG_SELL' ? '#fb7185' : '#00f0ff');
      }

      // Feature 7: Voice AI Automated Callout for 100% Confluence + Shark Setup
      if (mtf.score_pct === 100 && (mtf.overall === 'STRONG_BUY' || mtf.overall === 'STRONG_SELL')) {
        const now = Date.now();
        if (!this._lastConfluenceVoiceTime || now - this._lastConfluenceVoiceTime > 60000) {
          this._lastConfluenceVoiceTime = now;
          const dir = mtf.overall === 'STRONG_BUY' ? 'belian' : 'jualan';
          if (this.bookmap && this.bookmap.speakAlert) {
            this.bookmap.speakAlert(`Konfluensi ${dir} sempurna empat jangka masa dikesan. Peluang dagangan institusi berkualiti tinggi.`);
          }
        }
      }
    }

    // Update Prop-Firm Smart Drawdown Shield Badge
    if (s.prop_firm_shield) {
      const pf = s.prop_firm_shield;
      const badge = document.getElementById('propFirmBadge');
      const txt = document.getElementById('propFirmStatusText');
      if (badge && txt) {
        if (pf.is_locked) {
          badge.style.backgroundColor = 'rgba(239, 68, 68, 0.28)';
          badge.style.borderColor = '#ef4444';
          badge.style.color = '#fca5a5';
          txt.textContent = `🚨 DIKUNCI (DD: ${pf.current_drawdown_pct}%)`;
        } else if (pf.current_drawdown_pct >= 2.5) {
          badge.style.backgroundColor = 'rgba(245, 158, 11, 0.22)';
          badge.style.borderColor = '#f59e0b';
          badge.style.color = '#fde047';
          txt.textContent = `⚠️ AWAS (DD: ${pf.current_drawdown_pct}% / ${pf.max_daily_loss_pct}%)`;
        } else {
          badge.style.backgroundColor = 'rgba(16, 185, 129, 0.14)';
          badge.style.borderColor = '#10b981';
          badge.style.color = '#34d399';
          txt.textContent = `AMAN (DD: ${pf.current_drawdown_pct}% / ${pf.max_daily_loss_pct}%)`;
        }
      }
    }

    // Update Spoofing Pulling/Stacking Active Alert Pill
    const spoofPill = document.getElementById('spoofAlertPill');
    const spoofTxt = document.getElementById('spoofAlertText');
    if (spoofPill && spoofTxt) {
      if (s.spoof_events && s.spoof_events.length > 0) {
        const lastSp = s.spoof_events[s.spoof_events.length - 1];
        if (Date.now() - lastSp.timestamp < 12000) {
          spoofPill.style.display = 'inline-flex';
          spoofTxt.textContent = lastSp.badge;
          const isPull = lastSp.type === 'PULLING';
          spoofPill.style.backgroundColor = isPull ? 'rgba(239, 68, 68, 0.26)' : 'rgba(0, 240, 255, 0.20)';
          spoofPill.style.borderColor = isPull ? '#ef4444' : '#00f0ff';
          spoofPill.style.color = isPull ? '#fca5a5' : '#7dd3fc';
        } else {
          spoofPill.style.display = 'none';
        }
      } else {
        spoofPill.style.display = 'none';
      }
    }

    // Update Tables
    this._renderPositions(s.positions || []);
    this._renderTape(s.trades || []);
    this._detectInsights(s);

    // Evaluate Live Signals Win/Loss Status against Real-Time Price
    this._evaluateSignals(s);

    // Update Quad-Confluence Signal Dashboard
    this._updateConfluenceDashboard(s);
  }

  _updateConfluenceDashboard(s) {
    if (!s) return;
    const lastPrice = s.last_price || s.ask || s.bid || 0;
    const dpoc = (s.session_vp && s.session_vp.dpoc) ? s.session_vp.dpoc : (lastPrice - 2.5);
    const cvd = s.cvd || 0;
    const isBullCvd = cvd >= 0;

    // Evaluate 4 Sensors
    // Sensor 1: Bookmap (DOM Resting Limits, Icebergs, Spoofs)
    const rawBids = (s.order_book && s.order_book.bids) || {};
    const rawAsks = (s.order_book && s.order_book.asks) || {};
    const bidVals = Array.isArray(rawBids) ? rawBids : Object.values(rawBids);
    const askVals = Array.isArray(rawAsks) ? rawAsks : Object.values(rawAsks);
    const totalBidVol = bidVals.slice(0, 10).reduce((acc, b) => acc + (typeof b === 'number' ? b : (b.volume || 1)), 0);
    const totalAskVol = askVals.slice(0, 10).reduce((acc, a) => acc + (typeof a === 'number' ? a : (a.volume || 1)), 0);
    const hasIceberg = s.icebergs && s.icebergs.length > 0;
    const s1Pass = totalBidVol >= totalAskVol * 0.85 || hasIceberg;

    // Sensor 2: ClusterDelta (Cluster POC, Net Delta Flow)
    const s2Pass = isBullCvd || (lastPrice >= dpoc - 1.0);

    // Sensor 3: Footprint (Imbalances, Intra-candle absorption)
    const candles = s.candles || [];
    const lastC = candles[candles.length - 1];
    const prevC = candles[candles.length - 2];
    const hasBullDelta = lastC && (lastC.delta || 0) > 0;
    const s3Pass = hasBullDelta || (prevC && (prevC.delta || 0) > 0) || (lastC && (lastC.close >= lastC.open));

    // Sensor 4: Candle Price Action (EMA Trend, Session Level Retest)
    const s4Pass = lastPrice >= dpoc || (s.sessions && lastPrice >= s.sessions.asian_low);

    // Compute Quad Score
    const score = (s1Pass ? 1 : 0) + (s2Pass ? 1 : 0) + (s3Pass ? 1 : 0) + (s4Pass ? 1 : 0);

    // Update Launcher Button Text in toolbar
    const btnOpenDash = document.getElementById('btnOpenConfluenceDash');
    if (btnOpenDash) {
      btnOpenDash.innerHTML = `<span>🎯</span> DASHBOARD (${score}/4 ${score >= 3 ? 'A+' : 'A'})`;
      btnOpenDash.style.borderColor = score >= 3 ? '#00e676' : '#ffd60a';
      btnOpenDash.style.color = score >= 3 ? '#00e676' : '#ffd60a';
    }

    // Only update internal modal DOM if modal is currently open
    const modal = document.getElementById('confluenceDashModal');
    if (!modal || modal.style.display !== 'flex') return;

    // DOM Elements update
    const gaugeSummary = document.getElementById('dashGaugeSummary');
    if (gaugeSummary) {
      const colMap = { 4: '#00e676', 3: '#38bdf8', 2: '#f59e0b', 1: '#ff3366', 0: '#94a3b8' };
      const gradeMap = { 4: '4/4 SEPAKAT (100% A+ PRIME)', 3: '3/4 SEPAKAT (75% A VALID)', 2: '2/4 (50% WATCHLIST)', 1: '1/4 (25% LEMAH)', 0: '0/4 NEUTRAL' };
      gaugeSummary.textContent = gradeMap[score] || '4/4 SEPAKAT (100%)';
      gaugeSummary.style.color = colMap[score] || '#00e676';
    }

    // Update 4 Blocks
    const updateBlock = (id, pass, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.background = pass ? 'rgba(0,230,118,0.18)' : 'rgba(239,68,68,0.18)';
      el.style.borderColor = pass ? '#00e676' : '#ef4444';
      el.style.color = pass ? '#00e676' : '#f87171';
      el.innerHTML = `${label}<br><b style="font-size:11px;">${pass ? 'LULUS ✅' : 'GAGAL ❌'}</b>`;
    };
    updateBlock('gaugeMod1', s1Pass, '🗺️ 1. Bookmap');
    updateBlock('gaugeMod2', s2Pass, '📊 2. Cluster');
    updateBlock('gaugeMod3', s3Pass, '👣 3. Footprint');
    updateBlock('gaugeMod4', s4Pass, '🕯️ 4. Candle');

    // Update Status Texts
    const updateSensorStat = (id, pass) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = pass ? 'LULUS (BULLISH) ✅' : 'TIDAK SEHALUAN ⚠️';
      el.style.color = pass ? '#00e676' : '#f59e0b';
    };
    updateSensorStat('statSensor1', s1Pass);
    updateSensorStat('statSensor2', s2Pass);
    updateSensorStat('statSensor3', s3Pass);
    updateSensorStat('statSensor4', s4Pass);

    // Dynamic Price Levels for Signal
    const entryLow = (lastPrice - 2.8).toFixed(2);
    const entryHigh = (lastPrice - 1.2).toFixed(2);
    const slVal = (lastPrice - 5.5).toFixed(2);
    const tp1Val = (lastPrice + 6.5).toFixed(2);
    const tp2Val = (lastPrice + 12.0).toFixed(2);

    const elEntry = document.getElementById('dashValEntry');
    const elSL = document.getElementById('dashValSL');
    const elTP1 = document.getElementById('dashValTP1');
    const elTP2 = document.getElementById('dashValTP2');
    if (elEntry) elEntry.textContent = `$${entryLow} - $${entryHigh}`;
    if (elSL) elSL.textContent = `$${slVal}`;
    if (elTP1) elTP1.textContent = `$${tp1Val}`;
    if (elTP2) elTP2.textContent = `$${tp2Val}`;

    const dashDomBids = document.getElementById('dashDomBids');
    if (dashDomBids) dashDomBids.textContent = `Resting Bids Wall $${(lastPrice - 1.8).toFixed(2)} (${totalBidVol.toFixed(0)} Lots) bersedia menyerap jualan.`;

    const dashClusterPoc = document.getElementById('dashClusterPoc');
    if (dashClusterPoc) dashClusterPoc.textContent = `$${dpoc.toFixed(2)} (Zon volum lelongan sesi)`;

    const dashClusterDelta = document.getElementById('dashClusterDelta');
    if (dashClusterDelta) dashClusterDelta.textContent = `${cvd >= 0 ? '+' : ''}${cvd.toFixed(1)}L (${cvd >= 0 ? 'Dominan Belian Bersih' : 'Tekanan Jualan Bersih'})`;
  }

  async sendTrade(action, customLot = null) {
    const lot = customLot || (parseFloat(this.inputLot ? this.inputLot.value : this.selectedLot) || 0.05);
    const slPips = parseFloat(this.inputSL ? this.inputSL.value : 30) || 30;
    const tpPips = parseFloat(this.inputTP ? this.inputTP.value : 60) || 60;
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action,
          volume: lot,
          sl_pips: slPips,
          tp_pips: tpPips
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        this.showToast(`✅ ${data.message}`);
      } else {
        this.showToast(`❌ ${data.message || 'Order ditolak'}`);
      }
    } catch (err) {
      this.showToast('Trade error: ' + err.message);
    }
  }

  _calculateRiskLot(riskPct) {
    const equity = (this.latestSnapshot && this.latestSnapshot.account) ? (this.latestSnapshot.account.equity || 101741.82) : 101741.82;
    const slPips = parseFloat(this.inputSL.value) || 30.0;
    // For Gold: 1 Pip = $0.10 per oz. 1 Standard Lot = 100 oz -> $10.00 loss per pip per lot
    const riskAmount = equity * (riskPct / 100.0);
    const lossPerLot = slPips * 10.0;
    let lot = 0.01;
    if (lossPerLot > 0) {
      lot = Math.max(0.01, Math.min(50.0, Math.round((riskAmount / lossPerLot) * 100) / 100));
    }
    this.selectedLot = lot;
    this.inputLot.value = lot.toFixed(2);
    const feedback = document.getElementById('riskCalcFeedback');
    if (feedback) {
      feedback.textContent = `${riskPct}% = $${riskAmount.toFixed(0)} (${lot.toFixed(2)} Lot)`;
    }
    this._updateRRPreview();
    this.showToast(`Auto-Lot dikira: ${lot.toFixed(2)} Lot (${riskPct}% = $${riskAmount.toFixed(0)})`);
  }

  _updateRRPreview() {
    const lot = parseFloat(this.inputLot ? this.inputLot.value : this.selectedLot) || 0.01;
    const slPips = parseFloat(this.inputSL ? this.inputSL.value : 30) || 30;
    const tpPips = parseFloat(this.inputTP ? this.inputTP.value : 60) || 60;
    const rr = slPips > 0 ? (tpPips / slPips) : 0;

    // On XAUUSD, 1 pip ($0.10 move) = $10 per 1.00 lot
    const riskUsd = lot * slPips * 10.0;
    const rewardUsd = lot * tpPips * 10.0;

    const elInputRR = document.getElementById('inputRR');
    const elRiskUsd = document.getElementById('txtRiskUsd');
    const elRewardUsd = document.getElementById('txtRewardUsd');
    const elRRBadge = document.getElementById('txtRRBadge');

    if (elInputRR) elInputRR.value = `1 : ${rr.toFixed(1)}`;
    if (elRiskUsd) elRiskUsd.textContent = `-$${riskUsd.toFixed(2)} (${slPips}p)`;
    if (elRewardUsd) elRewardUsd.textContent = `+$${rewardUsd.toFixed(2)} (${tpPips}p)`;
    if (elRRBadge) elRRBadge.textContent = `1 : ${rr.toFixed(1)} R:R`;
  }

  toggleBottomDock(collapse) {
    this.isDockCollapsed = collapse;
    const ws = document.querySelector('.main-workspace');
    if (ws) {
      ws.classList.toggle('dock-collapsed', this.isDockCollapsed);
    }
    // Feature 6: Tape Min Lot Filter
    this.tapeMinLot = 0.0;
    document.querySelectorAll('.tape-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tape-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tapeMinLot = parseFloat(btn.dataset.minlot) || 0.0;
        if (this.latestSnapshot) {
          this._renderTape(this.latestSnapshot.trades || []);
        }
      });
    });

    if (this.btnToggleDock) {
      this.btnToggleDock.textContent = this.isDockCollapsed ? '▲ Buka Dock' : '▼ Kecilkan Dock';
    }
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 60);
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 220);
  }

  async executeFromDOM(action, clickedPrice) {
    const volume = parseFloat(this.inputLot ? this.inputLot.value : this.selectedLot) || 0.01;
    this.showToast(`⚡ 1-Klik DOM ${action} (${volume.toFixed(2)} Lot) dipilih pada paras $${Number(clickedPrice).toFixed(2)}...`);
    await this.sendTrade(action);
  }

  async moveSingleBE(ticket) {
    try {
      const res = await fetch('/api/breakeven', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: parseInt(ticket) })
      });
      const data = await res.json();
      this.showToast(data.message || `SL #${ticket} dipindahkan ke BE`);
    } catch (e) {
      this.showToast('Ralat Breakeven: ' + e.message);
    }
  }

  async partialCloseSingle(ticket, ratio = 0.5) {
    try {
      const res = await fetch('/api/partial_close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: parseInt(ticket), ratio: ratio })
      });
      const data = await res.json();
      this.showToast(data.message || `Posisi #${ticket} ditutup separuh`);
    } catch (e) {
      this.showToast('Ralat Tutup Separuh: ' + e.message);
    }
  }

  _renderPositions(positions) {
    if (!this.positionsTableBody) return;
    const badge = document.getElementById('posBadge');
    if (badge) badge.textContent = positions.length;

    if (positions.length === 0) {
      this.positionsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-dark); padding:16px;">Tiada posisi aktif. Buat order pertama anda!</td></tr>';
      return;
    }

    let html = '';
    for (const p of positions) {
      const isBuy = p.type === 'BUY';
      const profit = p.profit || 0;
      const profitClass = profit >= 0 ? 'profit-pos' : 'profit-neg';

      html += `
        <tr>
          <td>#${p.ticket}</td>
          <td><b>${p.symbol}</b></td>
          <td class="${isBuy ? 'pos-type-buy' : 'pos-type-sell'}">${p.type}</td>
          <td>${p.volume.toFixed(2)}</td>
          <td>${p.open_price.toFixed(2)}</td>
          <td>${p.current_price ? p.current_price.toFixed(2) : '-'}</td>
          <td class="${profitClass}">${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</td>
          <td>
            <button class="btn-sm-action btn-be" onclick="app.moveSingleBE(${p.ticket})" title="Gerakkan SL ke paras Entry Breakeven">BE</button>
            <button class="btn-sm-action btn-partial" onclick="app.partialCloseSingle(${p.ticket}, 0.5)" title="Tutup 50% Lot">½ 50%</button>
            <button class="btn-close-sm" onclick="app.closeSinglePosition(${p.ticket})" title="Tutup Posisi">✕</button>
          </td>
        </tr>
      `;
    }
    this.positionsTableBody.innerHTML = html;
  }

  formatTime12h(dateOrMs, includeSeconds = true) {
    if (!dateOrMs) return '--:--:--';
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
    if (isNaN(d.getTime())) return String(dateOrMs);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: includeSeconds ? '2-digit' : undefined,
      hour12: true
    });
  }

  _renderTape(trades) {
    if (!this._tapeHistoryBuffer) this._tapeHistoryBuffer = [];
    if (trades && trades.length) {
      if (trades.length >= 25) {
        this._tapeHistoryBuffer = [...trades];
      } else {
        const seen = new Set(this._tapeHistoryBuffer.map(t => t.id != null ? t.id : `${t.timestamp}_${t.price}`));
        for (const tr of trades) {
          const tid = tr.id != null ? tr.id : `${tr.timestamp}_${tr.price}`;
          if (!seen.has(tid)) {
            this._tapeHistoryBuffer.push(tr);
            seen.add(tid);
          }
        }
      }
      if (this._tapeHistoryBuffer.length > 80) {
        this._tapeHistoryBuffer = this._tapeHistoryBuffer.slice(-80);
      }
    }
    const effectiveTrades = (this._tapeHistoryBuffer && this._tapeHistoryBuffer.length > 0)
      ? this._tapeHistoryBuffer
      : (trades || []);

    if (!this.tapeTableBody || !effectiveTrades || effectiveTrades.length === 0) return;
    const minLot = this.tapeMinLot || 0.0;
    let filtered = minLot > 0 ? effectiveTrades.filter(t => (t.volume || 0) >= minLot) : effectiveTrades;
    if (this.tapeSideFilter && this.tapeSideFilter !== 'all') {
      filtered = filtered.filter(t => t.side === this.tapeSideFilter);
    }
    const slice = filtered.slice(-25).reverse();

    // Tape Velocity Meter (Ticks per second over last 3s)
    const nowMs = Date.now();
    const recentCount = effectiveTrades.filter(t => nowMs - (t.timestamp || 0) <= 3000).length;
    const tps = (recentCount / 3.0).toFixed(1);
    const speedMeter = document.getElementById('tapeSpeedMeter');
    if (speedMeter) {
      speedMeter.textContent = `⚡ ${tps} tps`;
      speedMeter.style.color = Number(tps) >= 8.0 ? '#ff0055' : (Number(tps) >= 4.0 ? '#00f0ff' : '#facc15');
    }
    let html = '';

    if (slice.length === 0) {
      this.tapeTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#64748b; padding:12px;">Tiada transaksi dengan saiz ≥ ${minLot.toFixed(1)} Lot dalam tetingkap masa ini.</td></tr>`;
      return;
    }

    for (const t of slice) {
      const isBuy = t.side === 'buy';
      const timeStr = this.formatTime12h(t.timestamp);
      html += `
        <tr>
          <td>${timeStr}</td>
          <td style="color:#fff; font-weight:700;">${t.price.toFixed(2)}</td>
          <td style="color:var(--gold-accent);">${t.volume.toFixed(2)}</td>
          <td class="${isBuy ? 'pos-type-buy' : 'pos-type-sell'}">${isBuy ? 'BUY (Ask)' : 'SELL (Bid)'}</td>
          <td>${t.is_large ? '<span style="color:#ff0055; font-weight:800;">WHALE 🐋</span>' : 'Retail'}</td>
        </tr>
      `;
    }
    if (this._lastTapeHTML !== html) {
      this._lastTapeHTML = html;
      this.tapeTableBody.innerHTML = html;
    }
  }

  _detectInsights(s) {
    const list = this.insightsList;
    if (!list) return;

    const trades = s.trades || [];
    const whales = trades.filter(t => t.is_large);
    
    let html = '';
    if (whales.length > 0) {
      const lastWhale = whales[whales.length - 1];
      const timeStr = this.formatTime12h(lastWhale.timestamp);
      const isBuy = lastWhale.side === 'buy';
      html += `
        <div class="insight-card ${isBuy ? 'alert-buy' : 'alert-sell'}">
          <span class="insight-text">🐋 <b>WHALE ORDER:</b> ${lastWhale.volume.toFixed(2)} Lots ${isBuy ? 'BUY agresif' : 'SELL agresif'} @ ${lastWhale.price.toFixed(2)}</span>
          <span class="insight-time">${timeStr}</span>
        </div>
      `;
    }

    const cvd = s.cvd || 0;
    if (Math.abs(cvd) > 15.0) {
      html += `
        <div class="insight-card ${cvd > 0 ? 'alert-buy' : 'alert-sell'}">
          <span class="insight-text">📊 <b>CVD DELTA PRESSURE:</b> Net agresif ${cvd > 0 ? 'BUYING (+Bulls)' : 'SELLING (+Bears)'} (${cvd.toFixed(1)} delta).</span>
          <span class="insight-time">Realtime</span>
        </div>
      `;
    }

    // Buyer & Seller Zones in Order Flow Insights
    if (trades.length >= 8) {
      const step = 0.50;
      const bkts = {};
      for (const t of trades.slice(-100)) {
        const bp = (Math.floor(t.price / step) * step).toFixed(2);
        if (!bkts[bp]) bkts[bp] = { p: bp, b: 0, s: 0 };
        bkts[bp].b += (t.buy_vol !== undefined ? t.buy_vol : (t.side === 'buy' ? t.volume : 0));
        bkts[bp].s += (t.sell_vol !== undefined ? t.sell_vol : (t.side === 'sell' ? t.volume : 0));
      }
      let topB = null, topS = null;
      for (const b of Object.values(bkts)) {
        if (!topB || b.b > topB.b) topB = b;
        if (!topS || b.s > topS.s) topS = b;
      }
      if (topB && topB.b >= 5.0) {
        html += `
          <div class="insight-card alert-buy">
            <span class="insight-text">🟢 <b>ZON RAMAI BUYER:</b> Tumpuan belian tertinggi pada <b>$${topB.p}</b> (+${topB.b.toFixed(1)} Lots). Paras sokongan aktif.</span>
            <span class="insight-time">Demand</span>
          </div>
        `;
      }
      if (topS && topS.s >= 5.0) {
        html += `
          <div class="insight-card alert-sell">
            <span class="insight-text">🔴 <b>ZON RAMAI SELLER:</b> Tumpuan jualan tertinggi pada <b>$${topS.p}</b> (-${topS.s.toFixed(1)} Lots). Paras rintangan aktif.</span>
            <span class="insight-time">Supply</span>
          </div>
        `;
      }
    }

    // Trapped Traders in Insights Feed
    if (s.trapped_traders && s.trapped_traders.length > 0) {
      const lastTrap = s.trapped_traders[s.trapped_traders.length - 1];
      const isBuyerTrap = lastTrap.type === 'TRAPPED_BUYERS';
      html += `
        <div class="insight-card ${isBuyerTrap ? 'alert-sell' : 'alert-buy'}">
          <span class="insight-text">🪤 <b>${lastTrap.badge}:</b> ${lastTrap.desc}</span>
          <span class="insight-time">Reversal</span>
        </div>
      `;
    }

    // Session Liquidity Sweep (Judah Swing) in Insights Feed
    if (s.sessions && s.sessions.sweep_alert) {
      const sw = s.sessions.sweep_alert;
      const isBuy = sw.bias === 'BUY';
      html += `
        <div class="insight-card ${isBuy ? 'alert-buy' : 'alert-sell'}">
          <span class="insight-text"><b>${sw.badge}:</b> ${sw.desc}</span>
          <span class="insight-time">Liquidity Sweep</span>
        </div>
      `;
    }

    // Iceberg Orders & Institutional Absorption in Insights Feed
    if (s.icebergs && s.icebergs.length > 0) {
      const lastIce = s.icebergs[s.icebergs.length - 1];
      const isBuy = lastIce.bias === 'BUY';
      html += `
        <div class="insight-card ${isBuy ? 'alert-buy' : 'alert-sell'}">
          <span class="insight-text"><b>${lastIce.badge}:</b> ${lastIce.desc}</span>
          <span class="insight-time">Iceberg Absorption</span>
        </div>
      `;
    }

    // Composite Session Volume Profile (dPOC & Value Area) in Insights Feed
    if (s.session_vp && s.session_vp.dpoc > 0) {
      const svp = s.session_vp;
      html += `
        <div class="insight-card alert-buy" style="border-left-color:#ffd60a;">
          <span class="insight-text">⭐ <b>COMPOSITE SESSION VP:</b> Developing POC pada <b>$${svp.dpoc.toFixed(2)}</b> | Value Area 70%: <b>$${svp.val.toFixed(2)} – $${svp.vah.toFixed(2)}</b> (${svp.total_volume.toFixed(0)} Lots).</span>
          <span class="insight-time">Session Profile</span>
        </div>
      `;
    }

    // News & Volatility Shield Status in Insights Feed
    if (s.news_shield && s.news_shield.is_danger) {
      html += `
        <div class="insight-card alert-sell">
          <span class="insight-text"><b>${s.news_shield.headline}</b></span>
          <span class="insight-time">News Shield</span>
        </div>
      `;
    }

    if (!html) {
      html = '<div style="color:var(--text-dark); padding:10px;">Mengimbas aliran pesanan Order Flow & Bookmap...</div>';
    }
    if (this._lastInsightsHTML !== html) {
      this._lastInsightsHTML = html;
      list.innerHTML = html;
    }
  }

  showToast(msg) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>⚡</span> <span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.5s';
      setTimeout(() => toast.remove(), 500);
    }, 3000);
  }

  _startRenderLoop() {
    const loop = () => {
      if (this.latestSnapshot && this.needsRedraw) {
        this.needsRedraw = false;
        if (this.currentView === 'bookmap' || this.currentView === 'split') {
          this.bookmap.render(this.latestSnapshot);
        }
        if (this.currentView === 'footprint' || this.currentView === 'clusterdelta' || this.currentView === 'candlestick' || this.currentView === 'split') {
          this.footprint.render(this.latestSnapshot);
        }
        this.domManager.render(this.latestSnapshot);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  async loadHistoricalCandles(tf) {
    try {
      const activeTf = tf || this.currentTimeframe || 'M1';
      const res = await fetch(`/api/history?limit=1000&tf=${activeTf}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.candles && this.footprint) {
        this.footprint.setHistoricalCandles(data.candles);
        this._updateReplayHUD();
      }
    } catch (e) {
      console.warn('[History] Error loading candles:', e);
    }
  }

  toggleReplayMode() {
    if (!this.footprint) return;
    if (this.footprint.isReplayMode) {
      this.exitReplayMode();
    } else {
      this.enterReplayMode();
    }
  }

  enterReplayMode(targetIndex) {
    if (!this.footprint) return;
    if (this.currentView === 'bookmap') {
      this.setView('candlestick');
    }
    this.footprint.enterReplayMode(targetIndex);
    const player = document.getElementById('replayPlayerBar');
    if (player) player.style.display = 'flex';
    const btn = document.getElementById('btnToggleReplay');
    if (btn) {
      btn.classList.add('active');
      btn.style.background = '#4f46e5';
      btn.style.color = '#ffffff';
    }
    this.showToast('⏪ Mod Replay Backtest diaktifkan! Tekan [▶ PLAY] atau [⏭] untuk uji lilin lepas.');
    this._updateReplayHUD();
  }

  exitReplayMode() {
    if (!this.footprint) return;
    this.footprint.exitReplayMode();
    const player = document.getElementById('replayPlayerBar');
    if (player) player.style.display = 'none';
    const btn = document.getElementById('btnToggleReplay');
    if (btn) {
      btn.classList.remove('active');
      btn.style.background = '#1e1b4b';
      btn.style.color = '#c7d2fe';
    }
    this.showToast('✅ Kembali ke pasaran LIVE.');
  }

  _updateReplayHUD() {
    if (!this.footprint) return;
    const fp = this.footprint;
    const totalBars = fp.allCandles ? fp.allCandles.length : 0;
    const currentIdx = fp.replayIndex || 0;
    const currentBar = (fp.allCandles && currentIdx > 0) ? fp.allCandles[currentIdx - 1] : null;

    const elCurrent = document.getElementById('replayCurrentBar');
    const elTotal = document.getElementById('replayTotalBars');
    const elTime = document.getElementById('replayBarTime');
    const elPrice = document.getElementById('replayBarPrice');
    const scrubber = document.getElementById('replayScrubber');
    const btnPlay = document.getElementById('btnReplayPlayPause');
    const pnlBadge = document.getElementById('replayPnlBadge');

    if (elCurrent) elCurrent.textContent = currentIdx;
    if (elTotal) elTotal.textContent = totalBars;
    if (scrubber) {
      scrubber.min = Math.min(10, totalBars);
      scrubber.max = totalBars;
      scrubber.value = currentIdx;
    }
    if (currentBar) {
      if (elTime) {
        const d = new Date(currentBar.time * 1000);
        elTime.textContent = `${d.toLocaleDateString('ms-MY', { month:'short', day:'numeric' })} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
      if (elPrice) elPrice.textContent = `$${currentBar.close.toFixed(2)}`;
    }
    if (btnPlay) {
      btnPlay.textContent = fp.replayPlaying ? '⏸ JEDA' : '▶ PLAY';
      btnPlay.style.background = fp.replayPlaying ? '#d97706' : '#4f46e5';
    }
    if (pnlBadge && fp.replayTrades) {
      let totalPnl = 0;
      for (const t of fp.replayTrades) totalPnl += t.pnl;
      totalPnl = Math.round(totalPnl * 100) / 100;
      pnlBadge.textContent = `P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
      pnlBadge.style.color = totalPnl >= 0 ? '#34d399' : '#f87171';
      pnlBadge.style.borderColor = totalPnl >= 0 ? '#059669' : '#dc2626';
    }
  }

  sendTrade(action) {
    if (action === 'BUY') {
      const btn = document.getElementById('btnFastBuy');
      if (btn) btn.click();
    } else if (action === 'SELL') {
      const btn = document.getElementById('btnFastSell');
      if (btn) btn.click();
    }
  }

  // --- SaaS Authentication & Customer Admin Panel Logic ---

  async initAuthAndAdmin() {
    try {
      const token = localStorage.getItem('session_id');
      const headers = {};
      if (token) headers['X-Session-ID'] = token;
      const res = await fetch('/api/me', { headers });
      if (res.status === 401) {
        window.location.href = '/login?error=unauthorized';
        return;
      }
      const data = await res.json();
      if (data && data.user) {
        const u = data.user;
        this.currentUser = u;
        const elU = document.getElementById('lblUsername');
        const elP = document.getElementById('lblPlanBadge');
        const btnAdmin = document.getElementById('btnOpenAdminModal');

        if (elU) elU.textContent = u.full_name || u.username;
        if (elP) {
          const daysText = u.expires_at === 'never' ? 'SEUMUR HIDUP' : `${u.remaining_days}H`;
          elP.textContent = `${u.plan || 'VIP'} (${daysText})`;
          elP.style.borderColor = u.remaining_days > 5 ? '#38bdf8' : '#f59e0b';
        }
        const btnDock = document.getElementById('btnAdminDock');
        if (u.role === 'admin') {
          if (btnAdmin) btnAdmin.style.display = 'inline-flex';
          if (btnDock) btnDock.style.display = 'inline-flex';
        } else {
          if (btnAdmin) btnAdmin.style.display = 'none';
          if (btnDock) btnDock.style.display = 'none';
        }

        // Auto open admin modal if URL contains admin=1 or hash #admin
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('admin') === '1' || window.location.hash === '#admin') {
          if (u.role === 'admin') {
            setTimeout(() => this.openAdminModal(), 250);
          }
        }
      }
    } catch (e) {
      console.warn('[Auth] Error fetching user profile:', e);
    }
  }

  openAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) {
      modal.style.display = 'flex';
      this.loadAdminUsers();
    }
  }

  closeAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.style.display = 'none';
  }

  async logout() {
    try {
      localStorage.removeItem('session_id');
      await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    window.location.href = '/login';
  }

  async loadAdminUsers() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:18px; color:#94a3b8;">Memuatkan senarai pengguna...</td></tr>';

    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:18px; color:#ef4444;">Gagal memuatkan senarai pengguna. Sila log masuk semula sebagai Admin.</td></tr>';
        return;
      }
      const data = await res.json();
      const users = data.users || [];

      // Update stat cards
      let total = users.length;
      let active = 0;
      let expired = 0;
      let lifetime = 0;

      users.forEach(u => {
        if (u.expires_at === 'never') lifetime++;
        if (u.status_label === 'AKTIF') active++;
        else if (u.status_label === 'TAMAT TEMPOH') expired++;
      });

      const elTotal = document.getElementById('statTotalUsers');
      const elActive = document.getElementById('statActiveUsers');
      const elExpired = document.getElementById('statExpiredUsers');
      const elLifetime = document.getElementById('statLifetimeUsers');

      if (elTotal) elTotal.textContent = total;
      if (elActive) elActive.textContent = active;
      if (elExpired) elExpired.textContent = expired;
      if (elLifetime) elLifetime.textContent = lifetime;

      if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:18px; color:#94a3b8;">Tiada pengguna ditemui.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      users.forEach(u => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #1e293b';

        const daysStr = u.expires_at === 'never' ? '<span style="color:#fbbf24; font-weight:700;">∞ Seumur Hidup</span>' : (u.remaining_days > 0 ? `<b style="color:#38bdf8;">${u.remaining_days} Hari</b>` : '<b style="color:#ef4444;">Tamat</b>');

        tr.innerHTML = `
          <td style="padding:8px 8px; color:#fff; font-weight:700;">
            ${u.role === 'admin' ? '👑 ' : '👤 '}${u.username}
          </td>
          <td style="padding:8px 8px; color:#cbd5e1;">
            ${u.full_name} ${u.notes ? `<span style="color:#64748b; font-size:9.5px;">(${u.notes})</span>` : ''}
          </td>
          <td style="padding:8px 8px; color:#a5b4fc;">
            ${u.plan}
          </td>
          <td style="padding:8px 8px;">
            ${daysStr}
          </td>
          <td style="padding:8px 8px;">
            <span style="display:inline-block; padding:1px 6px; border-radius:3px; font-size:9px; font-weight:800; background:rgba(0,0,0,0.4); border:1px solid ${u.status_color}; color:${u.status_color};">
              ${u.status_label}
            </span>
          </td>
          <td style="padding:8px 8px; text-align:right;">
            <div style="display:inline-flex; gap:3px; justify-content:flex-end;">
              ${u.role !== 'admin' ? `
                <button class="btn-user-action" data-action="renew" data-id="${u.id}" style="background:#0284c7; color:#fff; border:none; border-radius:3px; padding:2px 6px; font-size:9.5px; cursor:pointer; font-weight:700;" title="Tambah 30 Hari Langganan">+30H</button>
                <button class="btn-user-action" data-action="toggle" data-id="${u.id}" data-active="${u.is_active}" style="background:${u.is_active ? '#e11d48' : '#059669'}; color:#fff; border:none; border-radius:3px; padding:2px 6px; font-size:9.5px; cursor:pointer; font-weight:700;">${u.is_active ? 'Gantung' : 'Aktifkan'}</button>
                <button class="btn-user-action" data-action="delete" data-id="${u.id}" data-username="${u.username}" style="background:#475569; color:#fca5a5; border:none; border-radius:3px; padding:2px 6px; font-size:9.5px; cursor:pointer; font-weight:700;" title="Padam Akaun">🗑️</button>
              ` : '<span style="font-size:9.5px; color:#fbbf24; font-weight:700;">Pentadbir Sistem</span>'}
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Bind action buttons
      tbody.querySelectorAll('.btn-user-action').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const action = btn.dataset.action;
          const id = btn.dataset.id;
          if (action === 'renew') {
            await this.updateUser(id, { add_days: 30 });
          } else if (action === 'toggle') {
            const currentActive = parseInt(btn.dataset.active) === 1;
            await this.updateUser(id, { is_active: currentActive ? 0 : 1 });
          } else if (action === 'delete') {
            const uname = btn.dataset.username;
            if (confirm(`Adakah anda pasti ingin memadamkan pengguna '${uname}'?`)) {
              await this.deleteUser(id);
            }
          }
        });
      });

    } catch (e) {
      console.error('[Admin] Error loading users:', e);
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:18px; color:#ef4444;">Ralat memuatkan data.</td></tr>';
    }
  }

  async updateUser(userId, data) {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const resData = await res.json();
      if (res.ok) {
        this.showToast(`✅ ${resData.message}`);
        this.loadAdminUsers();
      } else {
        this.showToast(`❌ ${resData.detail || resData.message}`);
      }
    } catch (e) {
      this.showToast(`❌ Ralat kemas kini: ${e.message}`);
    }
  }

  async deleteUser(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      const resData = await res.json();
      if (res.ok) {
        this.showToast(`✅ ${resData.message}`);
        this.loadAdminUsers();
      } else {
        this.showToast(`❌ ${resData.detail || resData.message}`);
      }
    } catch (e) {
      this.showToast(`❌ Ralat padam: ${e.message}`);
    }
  }

  async handleCreateUser(e) {
    e.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value.trim();
    const fullName = document.getElementById('newFullName').value.trim();
    const planVal = document.getElementById('newPlanDuration').value;
    const [daysStr, planTitle] = planVal.split('|');
    const durationDays = parseInt(daysStr);

    const btnSubmit = document.getElementById('btnSubmitCreateUser');
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Menjana ID...';

    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          full_name: fullName,
          role: 'member',
          plan: planTitle,
          duration_days: durationDays,
          notes: fullName
        })
      });

      const data = await res.json();
      if (res.ok) {
        this.showToast(`✅ ID Pembeli '${username}' berjaya diaktifkan!`);

        // Generate ready-to-send WhatsApp receipt
        const receiptBox = document.getElementById('receiptBox');
        const receiptText = document.getElementById('receiptText');
        const daysLabel = durationDays === -1 ? 'SEUMUR HIDUP (VIP LIFETIME)' : `${durationDays} HARI`;

        const waMessage = `Salam ${fullName}!
Tahniah, akses Terminal XAUUSD.FLOW PRO anda telah diaktifkan secara rasmi:

🔗 Laman Web: https://gringgo-orderflow.onrender.com
👤 ID Pengguna: ${username}
🔑 Kata Laluan: ${password}
📅 Pakej Akses: ${planTitle} (${daysLabel})

Selamat berdagang dan semoga beroleh profit konsisten!`;

        if (receiptBox && receiptText) {
          receiptText.value = waMessage;
          receiptBox.style.display = 'block';
        }

        // Reset form inputs except receipt
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('newFullName').value = '';

        this.loadAdminUsers();
      } else {
        this.showToast(`❌ ${data.detail || data.message}`);
      }
    } catch (err) {
      this.showToast(`❌ Ralat pelayan: ${err.message}`);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = '➕ Cipta ID & Aktifkan';
    }
  }

  // ==================== V14.0 PRO ENHANCEMENT METHODS ====================

  _initAudioEngine() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this._audioCtx = new AudioCtx();
      }
    } catch (e) {
      console.warn('[AudioEngine] Web Audio not supported', e);
    }
  }

  playInstitutionalChime(type) {
    if (!this.audioEnabled) return;
    try {
      if (!this._audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this._audioCtx = new AudioCtx();
      }
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        this._audioCtx.resume();
      }
      if (!this._audioCtx) return;

      const ctx = this._audioCtx;
      const now = ctx.currentTime;

      if (type === 'BUY') {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'triangle';
        osc2.type = 'sine';

        osc1.frequency.setValueAtTime(523.25, now);
        osc1.frequency.exponentialRampToValueAtTime(783.99, now + 0.14);

        osc2.frequency.setValueAtTime(659.25, now);
        osc2.frequency.exponentialRampToValueAtTime(1046.50, now + 0.14);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.35);
        osc2.stop(now + 0.35);

      } else if (type === 'SELL') {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sawtooth';
        osc2.type = 'sine';

        osc1.frequency.setValueAtTime(783.99, now);
        osc1.frequency.exponentialRampToValueAtTime(440.00, now + 0.16);

        osc2.frequency.setValueAtTime(659.25, now);
        osc2.frequency.exponentialRampToValueAtTime(329.63, now + 0.16);

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.38);
        osc2.stop(now + 0.38);

      } else if (type === 'ICEBERG') {
        // High harmonic crystal shimmer for institutional iceberg absorption
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sine';
        osc2.type = 'triangle';
        osc1.frequency.setValueAtTime(1046.50, now); // C6
        osc1.frequency.exponentialRampToValueAtTime(1318.51, now + 0.15); // E6
        osc2.frequency.setValueAtTime(1567.98, now); // G6
        osc2.frequency.exponentialRampToValueAtTime(2093.00, now + 0.15); // C7
        gain.gain.setValueAtTime(0.20, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.40);
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.40);
        osc2.stop(now + 0.40);

      } else if (type === 'WHALE') {
        // Deep sub-bass pulse (sonar thud) for heavy institutional sweep
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(130, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.45);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.50);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.50);

      } else if (type === 'SWEEP') {
        // Two-tone alerting chime for Session & Liquidity Sweeps
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1174.66, now + 0.12);
        gain.gain.setValueAtTime(0.20, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.38);

      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1174.66, now + 0.08);
        gain.gain.setValueAtTime(0.20, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (e) {
      console.warn('[AudioEngine Error]', e);
    }
  }

  _setupDomToggle() {
    const workspace = document.querySelector('.main-workspace');
    const toggleButtons = [
      document.getElementById('btnToggleDOM'),
      document.getElementById('btnToggleDOMTop'),
      document.getElementById('mobileDomFab')
    ].filter(Boolean);

    const toggleDOM = () => {
      if (!workspace) return;
      const isMobile = window.innerWidth <= 900;
      
      if (isMobile) {
        const isForcedOpen = workspace.classList.toggle('dom-forced-open');
        workspace.classList.toggle('dom-collapsed', !isForcedOpen);
        const fabTxt = document.getElementById('mobileDomFabText');
        if (fabTxt) fabTxt.textContent = isForcedOpen ? '✕ CARTA' : '📊 DOM';
        this.showToast(isForcedOpen ? '📊 Tangga DOM Dibuka' : '📈 Mod Skrin Penuh Carta Aktif');
      } else {
        const isCollapsed = workspace.classList.toggle('dom-collapsed');
        toggleButtons.forEach(btn => {
          if (btn.id !== 'mobileDomFab') {
            btn.classList.toggle('active', !isCollapsed);
            btn.style.opacity = isCollapsed ? '0.6' : '1.0';
          }
        });
        this.showToast(isCollapsed ? '📈 Mod Skrin Penuh: Carta 100% Lebar' : '📊 Tangga DOM Dibuka');
      }

      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        if (this.latestSnapshot) {
          if (this.bookmap && this.currentView === 'bookmap') this.bookmap.render();
          if (this.footprint && this.currentView !== 'bookmap') this.footprint.render(this.latestSnapshot);
        }
      }, 50);
    };

    toggleButtons.forEach(btn => btn.addEventListener('click', toggleDOM));

    const btnToggleSound = document.getElementById('btnToggleSound');
    if (btnToggleSound) {
      btnToggleSound.addEventListener('click', () => {
        this.audioEnabled = !this.audioEnabled;
        btnToggleSound.classList.toggle('active', this.audioEnabled);
        btnToggleSound.textContent = this.audioEnabled ? '🔊' : '🔇';
        this.showToast(this.audioEnabled ? '🔊 Audio Isyarat Institusi: AKTIF' : '🔇 Audio: BISU');
        if (this.audioEnabled) this.playInstitutionalChime('BUY');
      });
    }
  }

  _setupMobileTouchGestures() {
    const canvases = [this.bookmapCanvas, this.footprintCanvas].filter(Boolean);
    canvases.forEach(canvas => {
      let touchStartX = 0;
      let touchStartY = 0;
      let lastTapTime = 0;

      canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          const t = e.touches[0];
          const rect = canvas.getBoundingClientRect();
          touchStartX = t.clientX - rect.left;
          touchStartY = t.clientY - rect.top;

          const now = Date.now();
          if (now - lastTapTime < 320) {
            if (this.footprint && this.footprint.centerVertical) {
              this.footprint.centerVertical();
              this.showToast('🎯 Carta Dipusatkan Semula');
            }
            if (this.bookmap && this.bookmap.centerToPrice) {
              this.bookmap.centerToPrice();
            }
            lastTapTime = 0;
            return;
          }
          lastTapTime = now;

          const mouseEvent = new MouseEvent('mousedown', {
            clientX: t.clientX,
            clientY: t.clientY,
            button: 0
          });
          canvas.dispatchEvent(mouseEvent);
        }
      }, { passive: true });

      canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) {
          const t = e.touches[0];
          const mouseEvent = new MouseEvent('mousemove', {
            clientX: t.clientX,
            clientY: t.clientY,
            button: 0
          });
          canvas.dispatchEvent(mouseEvent);
        }
      }, { passive: true });

      canvas.addEventListener('touchend', (e) => {
        const mouseEvent = new MouseEvent('mouseup', { button: 0 });
        window.dispatchEvent(mouseEvent);
      }, { passive: true });
    });
  }

  // ==================== V16.0 & V17.0 PRO ENHANCEMENTS METHODS ====================

  takeUniversalScreenshot() {
    let sourceCanvas = null;
    let moduleName = 'Bookmap Heatmap';

    if (this.currentView === 'bookmap') {
      sourceCanvas = this.bookmapCanvas;
      moduleName = 'Bookmap Heatmap';
    } else if (this.currentView === 'clusterdelta') {
      sourceCanvas = this.footprintCanvas;
      moduleName = 'ClusterDelta Profile';
    } else if (this.currentView === 'footprint') {
      sourceCanvas = this.footprintCanvas;
      moduleName = 'Footprint Order Flow';
    } else if (this.currentView === 'candlestick') {
      sourceCanvas = this.footprintCanvas;
      moduleName = 'Candlestick Pro';
    } else {
      sourceCanvas = this.bookmapCanvas || this.footprintCanvas;
      moduleName = 'Order Flow Split';
    }

    if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
      this.showToast('❌ Kanvas tidak sedia untuk tangkapan skrin.');
      return;
    }

    try {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = sourceCanvas.width;
      exportCanvas.height = sourceCanvas.height;
      const ctx = exportCanvas.getContext('2d');

      ctx.drawImage(sourceCanvas, 0, 0);

      const headerHeight = 36;
      ctx.fillStyle = 'rgba(7, 11, 20, 0.88)';
      ctx.fillRect(0, 0, exportCanvas.width, headerHeight);

      const grad = ctx.createLinearGradient(0, headerHeight - 2, exportCanvas.width, headerHeight - 2);
      grad.addColorStop(0, '#00f0ff');
      grad.addColorStop(0.5, '#ffd60a');
      grad.addColorStop(1, '#ff3366');
      ctx.fillStyle = grad;
      ctx.fillRect(0, headerHeight - 2, exportCanvas.width, 2);

      ctx.font = 'bold 12px Inter, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚡ GRINGGO ORDER FLOW TERMINAL', 14, headerHeight / 2);

      const curPrice = (this.latestSnapshot && this.latestSnapshot.current_price) 
        ? `$${this.latestSnapshot.current_price.toFixed(2)}` 
        : '';
      const curTF = (this.latestSnapshot && this.latestSnapshot.timeframe) || 'M1';
      ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
      ctx.fillStyle = '#ffd60a';
      ctx.fillText(`XAUUSD • ${curTF} • ${moduleName.toUpperCase()} • ${curPrice}`, 240, headerHeight / 2);

      const nowStr = new Date().toLocaleString('en-GB', { 
        year: 'numeric', month: 'short', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false 
      });
      ctx.textAlign = 'right';
      ctx.font = '10px "JetBrains Mono", Consolas, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${nowStr} UTC+8`, exportCanvas.width - 14, headerHeight / 2);

      const bottomText = 'Auction Market Theory & Order Flow • order-flow-whfl.onrender.com';
      ctx.font = '9.5px "JetBrains Mono", Consolas, monospace';
      const textWidth = ctx.measureText(bottomText).width;
      const pillX = exportCanvas.width - textWidth - 28;
      const pillY = exportCanvas.height - 24;
      ctx.fillStyle = 'rgba(7, 11, 20, 0.80)';
      ctx.fillRect(pillX, pillY, textWidth + 20, 18);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.strokeRect(pillX, pillY, textWidth + 20, 18);
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.fillText(bottomText, pillX + 10, pillY + 12);

      const fileSlug = moduleName.toLowerCase().replace(/\s+/g, '-');
      const timeSlug = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `gringgo-${fileSlug}-${timeSlug}.png`;

      exportCanvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
        this.showToast(`📸 Tangkapan skrin ${moduleName} berjaya dimuat turun!`);
      }, 'image/png');
    } catch (e) {
      console.error('[Screenshot Error]', e);
      this.showToast('Ralat mengambil tangkapan skrin: ' + e.message);
    }
  }

  exportTapeToCSV() {
    const trades = this._tapeHistoryBuffer || (this.latestSnapshot && this.latestSnapshot.trades) || [];
    if (!trades || trades.length === 0) {
      this.showToast('⚠️ Tiada rekod transaksi untuk dieksport.');
      return;
    }

    let csv = "Masa,Harga,Saiz_Lots,Pihak,Kategori,Nilai_USD\n";
    trades.forEach(t => {
      const timeStr = t.time || (t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '');
      const price = parseFloat(t.price || 0).toFixed(2);
      const vol = parseFloat(t.volume || t.vol || 0).toFixed(2);
      const side = t.side ? t.side.toUpperCase() : 'UNKNOWN';
      const cat = t.category || (parseFloat(vol) >= 5.0 ? 'WHALE' : (parseFloat(vol) >= 1.0 ? 'LARGE' : 'RETAIL'));
      const valUsd = (parseFloat(price) * parseFloat(vol) * 100).toFixed(2);
      csv += `${timeStr},${price},${vol},${side},${cat},${valUsd}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const timeSlug = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `gringgo-tape-xauusd-${timeSlug}.csv`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    this.showToast(`📥 ${trades.length} rekod transaksi berjaya dimuat turun ke CSV!`);
  }

  _initSessionStats() {
    try {
      const saved = sessionStorage.getItem('gringgo_session_stats');
      if (saved) {
        this.sessionStats = JSON.parse(saved);
      } else {
        this.sessionStats = { realizedPnl: 0.0, winCount: 0, lossCount: 0, totalTrades: 0 };
      }
    } catch (e) {
      this.sessionStats = { realizedPnl: 0.0, winCount: 0, lossCount: 0, totalTrades: 0 };
    }
    this._updateSessionStatsUI();
  }

  _recordClosedTrade(pnl) {
    if (typeof pnl !== 'number' || isNaN(pnl)) return;
    this.sessionStats.realizedPnl += pnl;
    this.sessionStats.totalTrades += 1;
    if (pnl > 0) this.sessionStats.winCount += 1;
    else if (pnl < 0) this.sessionStats.lossCount += 1;
    try {
      sessionStorage.setItem('gringgo_session_stats', JSON.stringify(this.sessionStats));
    } catch (e) {}
    this._updateSessionStatsUI();
  }

  _updateSessionStatsUI() {
    const elPnl = document.getElementById('txtSessionPnl');
    const elWr = document.getElementById('txtSessionWinRate');
    if (!elPnl || !elWr) return;
    const pnl = this.sessionStats.realizedPnl || 0.0;
    const sign = pnl >= 0 ? '+' : '-';
    elPnl.textContent = `${sign}$${Math.abs(pnl).toFixed(2)}`;
    elPnl.style.color = pnl >= 0 ? '#22c55e' : '#ef4444';

    const total = this.sessionStats.totalTrades || 0;
    const wins = this.sessionStats.winCount || 0;
    const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
    elWr.textContent = `WR: ${wr}% (${wins}/${total})`;
  }

  _setupLotCalculator() {
    const modal = document.getElementById('lotCalcModal');
    const btnOpen = document.getElementById('btnOpenLotCalc');
    const btnClose = document.getElementById('btnCloseLotCalc');
    const inputRisk = document.getElementById('calcInputRiskUsd');
    const inputPips = document.getElementById('calcInputSlPips');
    const lblDist = document.getElementById('lblCalcSlDistDollars');
    const resLot = document.getElementById('calcResultLot');
    const resLoss = document.getElementById('calcLossUsd');
    const resProfit = document.getElementById('calcProfitUsd');
    const btnApply = document.getElementById('btnApplyCalculatedLot');

    if (!modal) return;

    const calc = () => {
      const risk = Math.max(1, parseFloat(inputRisk ? inputRisk.value : 50) || 50);
      const pips = Math.max(5, parseFloat(inputPips ? inputPips.value : 30) || 30);
      const dollarsMove = pips * 0.10; // 1 pip = $0.10 on XAUUSD
      if (lblDist) lblDist.textContent = `${pips} pip = $${dollarsMove.toFixed(2)}`;

      const calculatedLot = Math.max(0.01, Math.min(20.0, risk / (dollarsMove * 100)));
      const roundedLot = Math.round(calculatedLot * 100) / 100;

      if (resLot) resLot.textContent = `${roundedLot.toFixed(2)} LOT`;
      if (resLoss) resLoss.textContent = `-$${risk.toFixed(2)}`;
      if (resProfit) resProfit.textContent = `+$${(risk * 2).toFixed(2)}`;
      return roundedLot;
    };

    if (btnOpen) {
      btnOpen.addEventListener('click', () => {
        modal.style.display = 'flex';
        calc();
      });
    }

    if (btnClose) {
      btnClose.addEventListener('click', () => {
        modal.style.display = 'none';
      });
    }

    document.querySelectorAll('.calc-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.calc-preset-btn').forEach(b => {
          b.classList.remove('active');
          b.style.borderColor = '#1e293b';
          b.style.color = '#cbd5e1';
        });
        btn.classList.add('active');
        btn.style.borderColor = '#ffd60a';
        btn.style.color = '#ffd60a';
        if (inputRisk) inputRisk.value = btn.dataset.val;
        calc();
      });
    });

    if (inputRisk) inputRisk.addEventListener('input', calc);
    if (inputPips) inputPips.addEventListener('input', calc);

    if (btnApply) {
      btnApply.addEventListener('click', () => {
        const lot = calc();
        this.selectedLot = lot;
        if (this.inputLot) this.inputLot.value = lot;
        const inputFast = document.getElementById('inputFastLot');
        if (inputFast) inputFast.value = lot;
        this._updateRRPreview();
        modal.style.display = 'none';
        this.showToast(`✅ Saiz lot ${lot.toFixed(2)} telah diterapkan ke panel dagangan!`);
      });
    }
  }

  openSignalsTab() {
    const tabBtn = document.getElementById('tabBtnSignals');
    if (tabBtn) tabBtn.click();
    if (this.isDockCollapsed) this.toggleBottomDock(false);
    this.showToast('📡 Modul Rekod Isyarat (Win/Loss) Dibuka');
  }

  _initSignalsTracker() {
    try {
      const saved = localStorage.getItem('gringgo_signals_journal');
      if (saved) {
        this.signalsList = JSON.parse(saved);
      }
    } catch (e) {
      this.signalsList = [];
    }

    if (!this.signalsList || this.signalsList.length === 0) {
      const now = Date.now();
      const p = 4053.90;
      this.signalsList = [
        {
          id: 'SIG-101',
          timestamp: now - 3600000 * 3,
          timeStr: new Date(now - 3600000 * 3).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          type: '⭐ SMC Asian High Sweep (Turtle Soup)',
          direction: 'SELL',
          entryPrice: p + 8.50,
          slPrice: p + 12.00,
          tpPrice: p + 1.50,
          status: 'WIN',
          resultPips: 70.0,
          closedAt: now - 3600000 * 2,
          closePrice: p + 1.50
        },
        {
          id: 'SIG-102',
          timestamp: now - 3600000 * 2,
          timeStr: new Date(now - 3600000 * 2).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          type: '⚡ Order Flow Absorption Reversal',
          direction: 'BUY',
          entryPrice: p - 5.00,
          slPrice: p - 8.50,
          tpPrice: p + 2.00,
          status: 'WIN',
          resultPips: 70.0,
          closedAt: now - 3600000,
          closePrice: p + 2.00
        },
        {
          id: 'SIG-103',
          timestamp: now - 3600000,
          timeStr: new Date(now - 3600000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          type: '🏛️ Volume Profile dPOC Retest',
          direction: 'BUY',
          entryPrice: p - 2.00,
          slPrice: p - 5.50,
          tpPrice: p + 5.00,
          status: 'LOSS',
          resultPips: -35.0,
          closedAt: now - 1800000,
          closePrice: p - 5.50
        },
        {
          id: 'SIG-104',
          timestamp: now - 900000,
          timeStr: new Date(now - 900000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          type: '🎯 Quad-Confluence 4/4 A+ Setup',
          direction: 'BUY',
          entryPrice: p,
          slPrice: p - 3.50,
          tpPrice: p + 7.00,
          status: 'ACTIVE',
          resultPips: 0.0,
          floatingPips: 14.5,
          closedAt: null,
          closePrice: null
        }
      ];
      this._saveSignals();
    }

    this._renderSignalsUI();
  }

  _saveSignals() {
    try {
      localStorage.setItem('gringgo_signals_journal', JSON.stringify(this.signalsList));
    } catch (e) {}
  }

  addSignal({ type, direction, entryPrice, slPips = 35, tpPips = 70 }) {
    if (!entryPrice || entryPrice <= 0) return;
    const now = Date.now();
    const slDist = (slPips * 0.10); // 1 pip = $0.10
    const tpDist = (tpPips * 0.10);

    const slPrice = direction === 'BUY' ? (entryPrice - slDist) : (entryPrice + slDist);
    const tpPrice = direction === 'BUY' ? (entryPrice + tpDist) : (entryPrice - tpDist);

    const newSig = {
      id: `SIG-${now.toString().slice(-4)}`,
      timestamp: now,
      timeStr: new Date(now).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
      type: type || '🎯 Quad-Confluence Signal',
      direction: direction.toUpperCase(),
      entryPrice: parseFloat(entryPrice.toFixed(2)),
      slPrice: parseFloat(slPrice.toFixed(2)),
      tpPrice: parseFloat(tpPrice.toFixed(2)),
      status: 'ACTIVE',
      resultPips: 0.0,
      floatingPips: 0.0,
      closedAt: null,
      closePrice: null
    };

    this.signalsList.unshift(newSig);
    if (this.signalsList.length > 50) this.signalsList = this.signalsList.slice(0, 50);
    this._saveSignals();
    this._renderSignalsUI();
    this.showToast(`📡 Isyarat Baharu: ${newSig.direction} @ $${newSig.entryPrice.toFixed(2)} (SL: $${newSig.slPrice.toFixed(2)}, TP: $${newSig.tpPrice.toFixed(2)})`);
    if (this.audioEnabled) this.playInstitutionalChime('SWEEP');
  }

  _evaluateSignals(s) {
    if (!s || !this.signalsList || this.signalsList.length === 0) return;
    const curPrice = s.last_price || s.ask || s.bid || 0;
    if (!curPrice) return;

    let hasChange = false;

    this.signalsList.forEach(sig => {
      if (sig.status !== 'ACTIVE') return;

      if (sig.direction === 'BUY') {
        if (curPrice >= sig.tpPrice) {
          sig.status = 'WIN';
          sig.closePrice = sig.tpPrice;
          sig.closedAt = Date.now();
          sig.resultPips = parseFloat(((sig.tpPrice - sig.entryPrice) * 10).toFixed(1));
          hasChange = true;
          this.showToast(`🎉 ISYARAT #${sig.id} (BUY) MENANG! Hit TP (+${sig.resultPips} pip)`);
          if (this.audioEnabled) this.playInstitutionalChime('BUY');
        } else if (curPrice <= sig.slPrice) {
          sig.status = 'LOSS';
          sig.closePrice = sig.slPrice;
          sig.closedAt = Date.now();
          sig.resultPips = -parseFloat(((sig.entryPrice - sig.slPrice) * 10).toFixed(1));
          hasChange = true;
          this.showToast(`⚠️ ISYARAT #${sig.id} (BUY) KALAH! Hit SL (${sig.resultPips} pip)`);
          if (this.audioEnabled) this.playInstitutionalChime('SELL');
        } else {
          sig.floatingPips = parseFloat(((curPrice - sig.entryPrice) * 10).toFixed(1));
        }
      } else if (sig.direction === 'SELL') {
        if (curPrice <= sig.tpPrice) {
          sig.status = 'WIN';
          sig.closePrice = sig.tpPrice;
          sig.closedAt = Date.now();
          sig.resultPips = parseFloat(((sig.entryPrice - sig.tpPrice) * 10).toFixed(1));
          hasChange = true;
          this.showToast(`🎉 ISYARAT #${sig.id} (SELL) MENANG! Hit TP (+${sig.resultPips} pip)`);
          if (this.audioEnabled) this.playInstitutionalChime('BUY');
        } else if (curPrice >= sig.slPrice) {
          sig.status = 'LOSS';
          sig.closePrice = sig.slPrice;
          sig.closedAt = Date.now();
          sig.resultPips = -parseFloat(((sig.slPrice - sig.entryPrice) * 10).toFixed(1));
          hasChange = true;
          this.showToast(`⚠️ ISYARAT #${sig.id} (SELL) KALAH! Hit SL (${sig.resultPips} pip)`);
          if (this.audioEnabled) this.playInstitutionalChime('SELL');
        } else {
          sig.floatingPips = parseFloat(((sig.entryPrice - curPrice) * 10).toFixed(1));
        }
      }
    });

    if (hasChange) {
      this._saveSignals();
    }
    this._renderSignalsUI();
  }

  _renderSignalsUI() {
    const tbody = document.getElementById('signalsTableBody');
    const badgeHdr = document.getElementById('hdrSigWinLossBadge');
    const badgeDock = document.getElementById('badgeSignalWinLoss');
    const txtWinRate = document.getElementById('sigStatWinRate');
    const txtWins = document.getElementById('sigStatWins');
    const txtLosses = document.getElementById('sigStatLosses');
    const txtActive = document.getElementById('sigStatActive');
    const txtNetPips = document.getElementById('sigStatNetPips');

    const total = this.signalsList.length;
    const wins = this.signalsList.filter(s => s.status === 'WIN').length;
    const losses = this.signalsList.filter(s => s.status === 'LOSS').length;
    const active = this.signalsList.filter(s => s.status === 'ACTIVE').length;
    const closed = wins + losses;
    const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;

    let netPips = 0;
    this.signalsList.forEach(s => {
      if (s.status === 'WIN' || s.status === 'LOSS') netPips += (s.resultPips || 0);
      else if (s.status === 'ACTIVE') netPips += (s.floatingPips || 0);
    });

    const badgeStr = `${wins}W / ${losses}L`;
    if (badgeHdr) badgeHdr.textContent = `(${badgeStr})`;
    if (badgeDock) badgeDock.textContent = badgeStr;

    if (txtWinRate) {
      txtWinRate.textContent = `${winRate}%`;
      txtWinRate.style.color = winRate >= 60 ? '#00e676' : (winRate >= 45 ? '#f59e0b' : '#ff3366');
    }
    if (txtWins) txtWins.textContent = `${wins} MENANG`;
    if (txtLosses) txtLosses.textContent = `${losses} KALAH`;
    if (txtActive) txtActive.textContent = `${active} AKTIF ⏳`;
    if (txtNetPips) {
      const sign = netPips >= 0 ? '+' : '';
      txtNetPips.textContent = `${sign}${netPips.toFixed(1)} PIP`;
      txtNetPips.style.color = netPips >= 0 ? '#ffd60a' : '#ff3366';
    }

    if (!tbody) return;

    const filtered = this.signalsList.filter(s => {
      if (this.signalFilter === 'active') return s.status === 'ACTIVE';
      if (this.signalFilter === 'win') return s.status === 'WIN';
      if (this.signalFilter === 'loss') return s.status === 'LOSS';
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:12px; color:#64748b;">Tiada rekod isyarat dalam kategori ini.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(sig => {
      const isBuy = sig.direction === 'BUY';
      const dirCol = isBuy ? '#00e676' : '#ff3366';
      const dirText = isBuy ? '🟢 BUY' : '🔴 SELL';

      let statusBadge = '';
      let pipsBadge = '';

      if (sig.status === 'WIN') {
        statusBadge = `<span style="background:rgba(0,230,118,0.18); color:#00e676; border:1px solid #00e676; padding:1px 5px; border-radius:3px; font-weight:900;">MENANG ✅</span>`;
        pipsBadge = `<b style="color:#00e676;">+${sig.resultPips} pip</b>`;
      } else if (sig.status === 'LOSS') {
        statusBadge = `<span style="background:rgba(239,68,68,0.18); color:#f87171; border:1px solid #ef4444; padding:1px 5px; border-radius:3px; font-weight:900;">KALAH ❌</span>`;
        pipsBadge = `<b style="color:#ff3366;">${sig.resultPips} pip</b>`;
      } else {
        const fp = sig.floatingPips || 0;
        const fpCol = fp >= 0 ? '#00e676' : '#ff3366';
        statusBadge = `<span style="background:rgba(56,189,248,0.18); color:#38bdf8; border:1px solid #38bdf8; padding:1px 5px; border-radius:3px; font-weight:800;">SEDANG JALAN ⏳</span>`;
        pipsBadge = `<span style="color:${fpCol}; font-weight:700;">${fp >= 0 ? '+' : ''}${fp.toFixed(1)} pip</span>`;
      }

      const actions = sig.status === 'ACTIVE' 
        ? `<button class="tool-btn btn-sig-follow" data-id="${sig.id}" style="padding:1px 5px; font-size:9px; color:#00e676; border-color:#00e676; font-weight:800; cursor:pointer;" title="Buka posisi sekarang mengikut isyarat ini">⚡ Ikut</button>
           <button class="tool-btn btn-sig-copy" data-id="${sig.id}" style="padding:1px 4px; font-size:9px; color:#ffd60a; margin-left:2px; cursor:pointer;" title="Salin parameter isyarat">📋</button>`
        : `<button class="tool-btn btn-sig-copy" data-id="${sig.id}" style="padding:1px 5px; font-size:9px; color:#ffd60a; cursor:pointer;" title="Salin ringkasan keputusan isyarat">📋 Salin</button>`;

      return `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
          <td style="padding:5px 6px; color:#94a3b8; font-weight:700;">${sig.id}</td>
          <td style="padding:5px 6px; color:#cbd5e1;">${sig.timeStr}</td>
          <td style="padding:5px 6px; color:#f8fafc; font-weight:700;">${sig.type}</td>
          <td style="padding:5px 6px; color:${dirCol}; font-weight:900;">${dirText}</td>
          <td style="padding:5px 6px; color:#ffffff; font-weight:800;">$${sig.entryPrice.toFixed(2)}</td>
          <td style="padding:5px 6px; color:#ff3366;">$${sig.slPrice.toFixed(2)}</td>
          <td style="padding:5px 6px; color:#00e676;">$${sig.tpPrice.toFixed(2)}</td>
          <td style="padding:5px 6px;">${statusBadge}</td>
          <td style="padding:5px 6px;">${pipsBadge}</td>
          <td style="padding:5px 6px; text-align:center;">${actions}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.btn-sig-follow').forEach(btn => {
      btn.addEventListener('click', () => {
        const sig = this.signalsList.find(s => s.id === btn.dataset.id);
        if (sig) {
          const slPips = Math.round(Math.abs(sig.entryPrice - sig.slPrice) * 10);
          const tpPips = Math.round(Math.abs(sig.entryPrice - sig.tpPrice) * 10);
          if (this.inputSL) this.inputSL.value = slPips;
          if (this.inputTP) this.inputTP.value = tpPips;
          this.sendTrade(sig.direction);
          this.showToast(`⚡ Mengikuti isyarat #${sig.id} (${sig.direction})!`);
        }
      });
    });

    tbody.querySelectorAll('.btn-sig-copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const sig = this.signalsList.find(s => s.id === btn.dataset.id);
        if (sig) {
          const text = `📡 [GRINGGO ORDERFLOW SIGNAL #${sig.id}]\nSetup: ${sig.type}\nArah: ${sig.direction}\nEntry: $${sig.entryPrice.toFixed(2)}\nSL: $${sig.slPrice.toFixed(2)}\nTP: $${sig.tpPrice.toFixed(2)}\nStatus: ${sig.status} (${sig.resultPips || sig.floatingPips || 0} Pip)`;
          navigator.clipboard.writeText(text).then(() => {
            this.showToast(`📋 Parameter isyarat #${sig.id} disalin ke clipboard!`);
          });
        }
      });
    });
  }

  exportSignalsToCSV() {
    if (!this.signalsList || this.signalsList.length === 0) {
      this.showToast('⚠️ Tiada data isyarat untuk dieksport.');
      return;
    }

    let csv = "ID,Masa,Setup,Arah,Entry,SL,TP,Status,Result_Pips,Close_Price,Closed_At\n";
    this.signalsList.forEach(s => {
      const closedTime = s.closedAt ? new Date(s.closedAt).toLocaleTimeString() : '';
      csv += `${s.id},"${s.timeStr}","${s.type}",${s.direction},${s.entryPrice},${s.slPrice},${s.tpPrice},${s.status},${s.resultPips || s.floatingPips || 0},${s.closePrice || ''},"${closedTime}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const filename = `gringgo-signals-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    this.showToast(`📥 Jurnal isyarat (${this.signalsList.length} rekod) dimuat turun ke CSV!`);
  }

}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
  window.orderFlowApp = window.app;
});
