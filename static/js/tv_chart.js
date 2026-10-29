/**
 * TradingView Lightweight Charts Integration for Gringgo Orderflow
 * Ultra-smooth, responsive 60 FPS Candlestick & Indicator Engine
 */
class TradingViewChartManager {
  constructor(containerId = 'tvCandleChart') {
    this.containerId = containerId;
    this.container = document.getElementById(containerId);
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.ema20Series = null;
    this.ema50Series = null;
    this.vwapSeries = null;

    // Feature Toggles
    this.showEma20 = true;
    this.showEma50 = true;
    this.showVwap = true;
    this.showVolume = true;

    this.allCandles = [];
    this.lastCandleTime = 0;
    this._isInitialized = false;
  }

  init() {
    if (this._isInitialized && this.chart) return;
    if (!this.container) {
      this.container = document.getElementById(this.containerId);
      if (!this.container) return;
    }

    if (typeof LightweightCharts === 'undefined') {
      console.warn('[TradingView] LightweightCharts library not yet loaded. Retrying...');
      setTimeout(() => this.init(), 300);
      return;
    }

    try {
      // Clear container
      this.container.innerHTML = '';

      // Create Chart instance with dark institutional styling
      this.chart = LightweightCharts.createChart(this.container, {
        width: this.container.clientWidth || 800,
        height: this.container.clientHeight || 500,
        layout: {
          background: { type: 'solid', color: '#070c18' },
          textColor: '#94a3b8',
          fontSize: 11,
          fontFamily: "'JetBrains Mono', 'Segoe UI', monospace"
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.45)', style: 1 },
          horzLines: { color: 'rgba(30, 41, 59, 0.45)', style: 1 }
        },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: {
            color: '#38bdf8',
            width: 1,
            style: 3,
            labelBackgroundColor: '#0284c7'
          },
          horzLine: {
            color: '#38bdf8',
            width: 1,
            style: 3,
            labelBackgroundColor: '#0284c7'
          }
        },
        rightPriceScale: {
          borderColor: '#1e293b',
          scaleMargins: {
            top: 0.08,
            bottom: 0.18
          },
          precision: 2,
          mode: 0,
          autoScale: true
        },
        timeScale: {
          borderColor: '#1e293b',
          timeVisible: true,
          secondsVisible: false,
          barSpacing: 8,
          minBarSpacing: 3,
          rightOffset: 8
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true
        }
      });

      // Volume Series (Bottom Sub-Scale)
      this.volumeSeries = this.chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '', // Separate scale
        scaleMargins: {
          top: 0.82,
          bottom: 0.0
        }
      });

      // Candlestick Series (World-Class Vibrant Styling)
      this.candleSeries = this.chart.addCandlestickSeries({
        upColor: '#00e676',
        downColor: '#ff3366',
        borderUpColor: '#00e676',
        borderDownColor: '#ff3366',
        wickUpColor: '#00e676',
        wickDownColor: '#ff3366',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01
        }
      });

      // EMA 20 (Cyan - Fast Trend)
      this.ema20Series = this.chart.addLineSeries({
        color: '#38bdf8',
        lineWidth: 1.5,
        title: 'EMA 20',
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });

      // EMA 50 (Orange - Medium Trend)
      this.ema50Series = this.chart.addLineSeries({
        color: '#fb923c',
        lineWidth: 1.5,
        title: 'EMA 50',
        priceLineVisible: false,
        crosshairMarkerVisible: false
      });

      // VWAP (Neon Yellow - Institutional Benchmark)
      this.vwapSeries = this.chart.addLineSeries({
        color: '#facc15',
        lineWidth: 2.0,
        title: 'VWAP',
        lineStyle: 0,
        priceLineVisible: true,
        crosshairMarkerVisible: false
      });

      // Create Floating OHLC & Legend Header inside Chart
      this._createLegendOverlay();

      // Setup Resize Observer
      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
      }
      window.addEventListener('resize', () => this.resize());

      this._isInitialized = true;
      console.log('[TradingView] Lightweight Charts initialized successfully.');
    } catch (err) {
      console.error('[TradingView] Initialization error:', err);
    }
  }

  _createLegendOverlay() {
    if (!this.container) return;
    let legend = document.getElementById('tvLegendOverlay');
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'tvLegendOverlay';
      legend.style.cssText = `
        position: absolute;
        top: 8px;
        left: 12px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #cbd5e1;
        pointer-events: none;
        background: rgba(8, 13, 24, 0.75);
        backdrop-filter: blur(8px);
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid rgba(56, 189, 248, 0.2);
      `;
      this.container.appendChild(legend);
    }

    // Subscribe to crosshair move for dynamic OHLC inspection
    if (this.chart) {
      this.chart.subscribeCrosshairMove(param => {
        if (!legend) return;
        if (!param || !param.time || !param.seriesPrices) {
          this._updateLegendText(legend, this._latestOhlc);
          return;
        }
        const ohlc = param.seriesPrices.get(this.candleSeries);
        if (ohlc) {
          this._updateLegendText(legend, ohlc);
        }
      });
    }
  }

  _updateLegendText(legend, ohlc) {
    if (!legend) return;
    if (!ohlc) {
      legend.innerHTML = `<span style="color:#ffd60a; font-weight:800;">XAUUSD</span> <span style="color:#64748b;">Menunggu data...</span>`;
      return;
    }
    const isUp = ohlc.close >= ohlc.open;
    const col = isUp ? '#00e676' : '#ff3366';
    const diff = (ohlc.close - ohlc.open).toFixed(2);
    const diffSign = diff >= 0 ? `+${diff}` : diff;

    legend.innerHTML = `
      <span style="color:#ffd60a; font-weight:800; letter-spacing:0.5px;">XAUUSD</span>
      <span>O: <b style="color:${col};">${ohlc.open.toFixed(2)}</b></span>
      <span>H: <b style="color:${col};">${ohlc.high.toFixed(2)}</b></span>
      <span>L: <b style="color:${col};">${ohlc.low.toFixed(2)}</b></span>
      <span>C: <b style="color:${col};">${ohlc.close.toFixed(2)}</b></span>
      <span style="color:${col}; font-weight:700;">(${diffSign})</span>
    `;
  }

  resize() {
    if (!this.chart || !this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) {
      this.chart.applyOptions({ width: w, height: h });
    }
  }

  fitContent() {
    if (this.chart && this.chart.timeScale) {
      this.chart.timeScale().fitContent();
    }
  }

  toggleIndicator(name, show) {
    if (name === 'ema20') {
      this.showEma20 = (show !== undefined) ? show : !this.showEma20;
      if (this.ema20Series) this.ema20Series.applyOptions({ visible: this.showEma20 });
      return this.showEma20;
    }
    if (name === 'ema50') {
      this.showEma50 = (show !== undefined) ? show : !this.showEma50;
      if (this.ema50Series) this.ema50Series.applyOptions({ visible: this.showEma50 });
      return this.showEma50;
    }
    if (name === 'vwap') {
      this.showVwap = (show !== undefined) ? show : !this.showVwap;
      if (this.vwapSeries) this.vwapSeries.applyOptions({ visible: this.showVwap });
      return this.showVwap;
    }
    if (name === 'volume') {
      this.showVolume = (show !== undefined) ? show : !this.showVolume;
      if (this.volumeSeries) this.volumeSeries.applyOptions({ visible: this.showVolume });
      return this.showVolume;
    }
  }

  setHistoricalData(rawCandles) {
    if (!rawCandles || !Array.isArray(rawCandles) || rawCandles.length === 0) return;
    this.init();
    if (!this.candleSeries) return;

    this.allCandles = rawCandles;

    const candleData = [];
    const volumeData = [];
    const closePrices = [];
    const times = [];

    // Deduplicate and sort by timestamp
    const seenTimes = new Set();

    for (const c of rawCandles) {
      const rawSec = Math.floor((c.timestamp || c.time || 0) / (c.timestamp > 1e11 ? 1000 : 1));
      if (!rawSec || isNaN(rawSec) || seenTimes.has(rawSec)) continue;
      seenTimes.add(rawSec);

      const o = parseFloat(c.open || c.o || 0);
      const h = parseFloat(c.high || c.h || o);
      const l = parseFloat(c.low || c.l || o);
      const cl = parseFloat(c.close || c.c || o);
      const vol = parseFloat(c.volume || c.vol || (c.buy_vol + c.sell_vol) || 1.0);

      candleData.push({ time: rawSec, open: o, high: h, low: l, close: cl });
      volumeData.push({
        time: rawSec,
        value: vol,
        color: cl >= o ? 'rgba(0, 230, 118, 0.40)' : 'rgba(255, 51, 102, 0.40)'
      });

      closePrices.push(cl);
      times.push(rawSec);
    }

    candleData.sort((a, b) => a.time - b.time);
    volumeData.sort((a, b) => a.time - b.time);

    try {
      this.candleSeries.setData(candleData);
      if (this.volumeSeries) this.volumeSeries.setData(volumeData);

      // Compute and set EMA 20 & EMA 50
      this._updateIndicators(candleData);

      // Cache latest OHLC
      if (candleData.length > 0) {
        this._latestOhlc = candleData[candleData.length - 1];
        this.lastCandleTime = this._latestOhlc.time;
        const legend = document.getElementById('tvLegendOverlay');
        if (legend) this._updateLegendText(legend, this._latestOhlc);
      }

      this.chart.timeScale().scrollToRealTime();
    } catch (err) {
      console.warn('[TradingView] Error setting historical data:', err);
    }
  }

  _updateIndicators(sortedCandles) {
    if (!sortedCandles || sortedCandles.length === 0) return;

    // EMA 20
    const ema20 = this._calculateEMA(sortedCandles, 20);
    if (this.ema20Series) this.ema20Series.setData(ema20);

    // EMA 50
    const ema50 = this._calculateEMA(sortedCandles, 50);
    if (this.ema50Series) this.ema50Series.setData(ema50);

    // VWAP
    const vwap = this._calculateCumulativeVWAP(sortedCandles);
    if (this.vwapSeries) this.vwapSeries.setData(vwap);
  }

  _calculateEMA(candles, period) {
    const k = 2 / (period + 1);
    let ema = null;
    const result = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i < period - 1) {
        // Not enough data yet
        continue;
      } else if (i === period - 1) {
        // Initial SMA
        let sum = 0;
        for (let j = 0; j < period; j++) sum += candles[j].close;
        ema = sum / period;
        result.push({ time: c.time, value: +ema.toFixed(2) });
      } else {
        ema = (c.close - ema) * k + ema;
        result.push({ time: c.time, value: +ema.toFixed(2) });
      }
    }
    return result;
  }

  _calculateCumulativeVWAP(candles) {
    let cumVol = 0;
    let cumVolPrice = 0;
    const result = [];

    for (const c of candles) {
      const vol = Math.max(1, (c.volume || 10));
      const typ = (c.high + c.low + c.close) / 3;
      cumVolPrice += typ * vol;
      cumVol += vol;
      const vwapVal = cumVolPrice / cumVol;
      result.push({ time: c.time, value: +vwapVal.toFixed(2) });
    }
    return result;
  }

  updateLiveTick(currentCandle, currentPrice) {
    if (!this.candleSeries || !currentCandle) return;

    const rawSec = Math.floor((currentCandle.timestamp || currentCandle.time || Date.now()) / (currentCandle.timestamp > 1e11 ? 1000 : 1));
    const o = parseFloat(currentCandle.open || currentPrice);
    const h = parseFloat(currentCandle.high || Math.max(o, currentPrice));
    const l = parseFloat(currentCandle.low || Math.min(o, currentPrice));
    const cl = parseFloat(currentCandle.close || currentPrice);
    const vol = parseFloat(currentCandle.volume || 1.0);

    const candleItem = {
      time: rawSec,
      open: o,
      high: Math.max(h, currentPrice || cl),
      low: Math.min(l, currentPrice || cl),
      close: currentPrice || cl
    };

    try {
      this.candleSeries.update(candleItem);
      this._latestOhlc = candleItem;

      if (this.volumeSeries) {
        this.volumeSeries.update({
          time: rawSec,
          value: vol,
          color: candleItem.close >= candleItem.open ? 'rgba(0, 230, 118, 0.40)' : 'rgba(255, 51, 102, 0.40)'
        });
      }

      // Update Floating Header Legend
      const legend = document.getElementById('tvLegendOverlay');
      if (legend) this._updateLegendText(legend, candleItem);
    } catch (e) {
      // Occasional timestamp sync adjustments
    }
  }
}

// Global singleton instance
window.tradingViewChartManager = new TradingViewChartManager('tvCandleChart');
