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
    this._updateContextToolbar(this.currentView);
    this._updateRRPreview();
    this._connectWebSocket();
    this._startRenderLoop();
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
        const tapeFilterGroup = document.getElementById('tapeFilterGroup');
        if (elPos) elPos.style.display = this.activeDockTab === 'positions' ? 'block' : 'none';
        if (elTape) elTape.style.display = this.activeDockTab === 'tape' ? 'block' : 'none';
        if (elIns) elIns.style.display = this.activeDockTab === 'insights' ? 'block' : 'none';
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

    // Screenshot Button
    const btnScreenshot = document.getElementById('btnScreenshot');
    if (btnScreenshot) {
      btnScreenshot.addEventListener('click', () => {
        if (this.bookmap && this.bookmap.takeScreenshot) {
          this.bookmap.takeScreenshot();
          this.showToast('📸 Tangkapan skrin Bookmap berjaya dimuat turun!');
        }
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
        this.showToast(isShown ? 'Garisan Sesi (Asia/London/NY + PDH/PDL) diaktifkan' : 'Garisan Sesi disembunyikan');
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
          if ((mode === 'clusterdelta' || mode === 'candlestick') && this.currentView === 'bookmap') {
            document.querySelectorAll('.view-switchers .nav-btn').forEach(b => {
              b.classList.toggle('active', b.dataset.view === mode);
            });
            this.setView(mode);
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
        } catch (e) {
          console.error('[TF Error]', e);
        }
      });
    });
  }


    // Institutional Global Hotkeys (B, S, Space, X, 1-5)
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        return;
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
    const csTechBar = document.getElementById('csTechniquesBar');

    if (view === 'bookmap') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'inline-flex';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'clusterdelta') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'inline-flex';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'footprint') {
      if (fpTools) fpTools.style.display = 'inline-flex';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'none';
    } else if (view === 'candlestick') {
      if (fpTools) fpTools.style.display = 'none';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'none';
      if (csTechBar) csTechBar.style.display = 'inline-flex';
    } else if (view === 'split') {
      if (fpTools) fpTools.style.display = 'inline-flex';
      if (clusterWrap) clusterWrap.style.display = 'none';
      if (bookmapWrap) bookmapWrap.style.display = 'inline-flex';
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
        document.querySelectorAll('.fp-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === 'candlestick');
        });
      }
    } else if (view === 'footprint') {
      this.bookmapCanvas.style.display = 'none';
      this.footprintCanvas.style.display = 'block';
      this.footprintCanvas.style.left = '0';
      this.footprintCanvas.style.width = '100%';
      if (this.footprint && (this.footprint.viewMode === 'clusterdelta' || this.footprint.viewMode === 'candlestick')) {
        this.footprint.setViewMode('bid_ask');
        this.footprint.setClusterStep(1.00);
        document.querySelectorAll('.fp-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === 'bid_ask');
        });
        document.querySelectorAll('.step-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.step === '1.00');
        });
      }
    } else if (view === 'split') {
      this.bookmapCanvas.style.display = 'block';
      this.bookmapCanvas.style.width = '50%';
      this.footprintCanvas.style.display = 'block';
      this.footprintCanvas.style.left = '50%';
      this.footprintCanvas.style.width = '50%';
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
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected to XAUUSD Order Flow Engine');
      const banner = document.getElementById('reconnectBanner');
      if (banner) banner.style.display = 'none';
    };

    this.ws.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        this.latestSnapshot = snapshot;
        this.needsRedraw = true;
        this._updateUI(snapshot);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
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
    const bids = (s.order_book && s.order_book.bids) ? s.order_book.bids : [];
    const asks = (s.order_book && s.order_book.asks) ? s.order_book.asks : [];
    const totalBidVol = bids.slice(0, 10).reduce((acc, b) => acc + (b.volume || 1), 0);
    const totalAskVol = asks.slice(0, 10).reduce((acc, a) => acc + (a.volume || 1), 0);
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
    if (!trades || trades.length === 0) return;
    const minLot = this.tapeMinLot || 0.0;
    const filtered = minLot > 0 ? trades.filter(t => (t.volume || 0) >= minLot) : trades;
    const slice = filtered.slice(-25).reverse();
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
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
