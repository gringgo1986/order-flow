/**
 * Full-Height Institutional DOM (Depth of Market) Ladder Engine
 * - Top 16 levels: Resting ASK (Supply / Offer) Liquidity above Market Price
 * - Center Row: Live Market Price, Bid/Ask & Spread Separator
 * - Bottom 16 levels: Resting BID (Demand) Liquidity below Market Price
 * - Includes Live Developing POC (⭐ dPOC), Iceberg Absorption (🧊), Liquidity Walls (🧱),
 *   and Book Imbalance Tug-of-War Footer.
 */

class DOMManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.selectedLot = 0.01;
    this.maxVolScale = 95.0;
    this.levelsEachSide = 16; // 16 Asks + 1 Center Spread Row + 16 Bids = 33 rows full height
    this._attachCenterBtn();
    this._initEvents();
  }

  _initEvents() {
    if (!this.container || this._eventsAttached) return;
    this._eventsAttached = true;
    this.container.addEventListener('click', (e) => {
      const row = e.target.closest('.dom-row');
      if (!row || !row.dataset.price) return;
      const price = parseFloat(row.dataset.price);
      if (!price || isNaN(price)) return;
      const isAsk = row.classList.contains('dom-ask-row');
      const isBid = row.classList.contains('dom-bid-row');
      if (isAsk && window.app && window.app.handleDOMClick) {
        window.app.handleDOMClick('SELL', price);
      } else if (isBid && window.app && window.app.handleDOMClick) {
        window.app.handleDOMClick('BUY', price);
      }
    });
  }

  _attachCenterBtn() {
    setTimeout(() => {
      const btn = document.getElementById('btnDomCenter');
      if (btn && !btn._attached) {
        btn._attached = true;
        btn.addEventListener('click', () => { this.centerDOM(); });
      }
    }, 200);
  }

  centerDOM() {
    if (!this.container) return;
    const centerRow = this.container.querySelector('.dom-center-spread');
    if (centerRow) {
      centerRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  render(snapshot) {
    if (!this.container || !snapshot) return;
    const bids = snapshot.order_book ? snapshot.order_book.bids : {};
    const asks = snapshot.order_book ? snapshot.order_book.asks : {};
    const currentPrice = snapshot.last_price || snapshot.bid || 0;
    const spread = snapshot.spread !== undefined ? snapshot.spread : 0.25;
    const dpoc = (snapshot.session_vp && snapshot.session_vp.dpoc) ? snapshot.session_vp.dpoc : 0;
    const icebergs = snapshot.icebergs || [];
    const spoofEvents = snapshot.spoof_events || [];
    const sess = snapshot.sessions || snapshot.htf_snr || {};
    const pdh = sess.pdh || 0;
    const pdl = sess.pdl || 0;
    const dailyOpen = sess.daily_open || 0;
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

    if (!currentPrice) return;

    const step = 0.10;
    const anchor = Math.round(currentPrice * 10) / 10;

    let totalAskVol = 0;
    let totalBidVol = 0;
    let maxObservedVol = 60.0;

    // Traded Volume Profile Map from Session VP
    const tradedMap = {};
    let maxTraded = 10.0;
    if (snapshot.session_vp && snapshot.session_vp.buckets) {
      for (const b of snapshot.session_vp.buckets) {
        const bp = b.price.toFixed(2);
        tradedMap[bp] = b.total || 0;
        if (b.total > maxTraded) maxTraded = b.total;
      }
    }

    const askRows = [];
    for (let i = this.levelsEachSide; i >= 1; i--) {
      const p = Number((anchor + i * step).toFixed(2));
      const pStr = p.toFixed(2);
      const vol = parseFloat(asks[pStr] ?? asks[p] ?? 0.0);
      totalAskVol += vol;
      if (vol > maxObservedVol) maxObservedVol = vol;
      askRows.push({ p, pStr, vol });
    }

    const bidRows = [];
    for (let i = 1; i <= this.levelsEachSide; i++) {
      const p = Number((anchor - i * step).toFixed(2));
      const pStr = p.toFixed(2);
      const vol = parseFloat(bids[pStr] ?? bids[p] ?? 0.0);
      totalBidVol += vol;
      if (vol > maxObservedVol) maxObservedVol = vol;
      bidRows.push({ p, pStr, vol });
    }

    const scale = Math.max(this.maxVolScale, maxObservedVol * 1.05);
    const nowMs = Date.now();
    let html = '';

    // 1. Render Top Half: ASK Liquidity Ladder (High -> Low down to Ask)
    for (const row of askRows) {
      const { p, pStr, vol } = row;
      const is1D = pdh > 0 && Math.abs(p - pdh) <= 0.08;
      const is1DOpen = dailyOpen > 0 && Math.abs(p - dailyOpen) <= 0.08;
      const isDPOC = dpoc > 0 && Math.abs(p - dpoc) <= 0.08;
      const isH8 = h8Res > 0 && Math.abs(p - h8Res) <= 0.08;
      const isH4 = h4Res > 0 && Math.abs(p - h4Res) <= 0.08;
      const isH1 = h1Res > 0 && Math.abs(p - h1Res) <= 0.08;
      const isM30 = m30Res > 0 && Math.abs(p - m30Res) <= 0.08;
      const isM15 = m15Res > 0 && Math.abs(p - m15Res) <= 0.08;
      const hasIceberg = icebergs.some(ic => Math.abs(ic.price - p) <= 0.11 && (nowMs - ic.timestamp < 90000));
      const hasSpoofPull = spoofEvents.some(sp => sp.type === 'PULLING' && Math.abs(sp.price - p) <= 0.08 && (nowMs - sp.timestamp < 12000));
      const isShark = vol >= 78.0;
      const isWall = vol >= 50.0;
      const askBarWidth = Math.min(100, (vol / scale) * 100);

      let badgePrefix = '';
      if (hasSpoofPull) badgePrefix = '⚡ ';
      else if (is1D) badgePrefix = '🏛️1D-RES ';
      else if (is1DOpen) badgePrefix = '⚡1D-OPEN ';
      else if (isH8) badgePrefix = '🏛️H8 ';
      else if (isH4) badgePrefix = '🏰H4 ';
      else if (isH1) badgePrefix = '⏱️H1 ';
      else if (isM30) badgePrefix = '⏳M30 ';
      else if (isM15) badgePrefix = '⚡M15 ';
      else if (isShark) badgePrefix = '🦈 ';
      else if (hasIceberg) badgePrefix = '🧊 ';
      else if (isDPOC) badgePrefix = '⭐ ';
      else if (isWall) badgePrefix = '🧱 ';

      let rowBgStyle = '';
      if (hasSpoofPull) {
        rowBgStyle = 'background:rgba(239,68,68,0.22); border-right:2px solid #ef4444;';
      } else if (is1D) {
        rowBgStyle = 'background:rgba(253,224,71,0.28); border-right:3px solid #fde047;';
      } else if (is1DOpen) {
        rowBgStyle = 'background:rgba(56,189,248,0.24); border-right:3px solid #38bdf8;';
      } else if (isH8) {
        rowBgStyle = 'background:rgba(225,29,72,0.26); border-right:3px solid #e11d48;';
      } else if (isH4) {
        rowBgStyle = 'background:rgba(236,72,153,0.24); border-right:3px solid #ec4899;';
      } else if (isH1) {
        rowBgStyle = 'background:rgba(249,115,22,0.22); border-right:3px solid #f97316;';
      } else if (isM30) {
        rowBgStyle = 'background:rgba(168,85,247,0.22); border-right:3px solid #a855f7;';
      } else if (isM15) {
        rowBgStyle = 'background:rgba(251,191,36,0.20); border-right:3px solid #fbbf24;';
      } else if (isShark) {
        rowBgStyle = 'background:linear-gradient(90deg, transparent, rgba(255,42,85,0.24)); border-right:2px solid #ff2a55;';
      } else if (isDPOC) {
        rowBgStyle = 'border-left:2px solid #ffd60a; background:rgba(255,214,10,0.06);';
      }

      const priceColor = hasSpoofPull
        ? 'color:#f87171; font-weight:800;'
        : (isShark
          ? 'color:#ff2a55; font-weight:900;'
          : (hasIceberg ? 'color:#00f0ff; font-weight:800;' : (isDPOC ? 'color:#ffd60a; font-weight:800;' : (isWall ? 'color:#ff8fa3; font-weight:700;' : 'color:#cbd5e1;'))));

      html += `
        <div class="dom-row dom-ask-row" data-price="${pStr}" style="cursor:pointer; ${rowBgStyle}" title="⚡ Klik untuk pasang SELL LIMIT @ $${pStr}">
          <div class="dom-col bid-vol" style="position:relative;" title="Volum Terlaksana Sesi @ $${pStr}: ${(tradedMap[pStr] || 0).toFixed(1)}L">
            <div class="dom-bar-traded ask-side" style="width:${Math.min(100, ((tradedMap[pStr] || 0) / maxTraded) * 100).toFixed(1)}%;"></div>
            <span class="dom-wall-tag" style="${isShark ? 'color:#ff2a55; font-weight:900;' : ''}">${isShark ? '🦈JERUNG' : (isWall ? 'WALL' : ((tradedMap[pStr] || 0) > 0 ? (tradedMap[pStr] || 0).toFixed(0) + 'v' : ''))}</span>
          </div>
          <div class="dom-col price" style="${priceColor}">${badgePrefix}${pStr}</div>
          <div class="dom-col ask-vol" title="Kecairan Offer (Ask) @ $${pStr}: ${vol.toFixed(1)} Lots">
            <div class="dom-bar ask ${isShark ? 'wall-glow-ask' : (isWall ? 'wall-glow-ask' : '')}" style="width: ${askBarWidth.toFixed(1)}%; ${isShark ? 'background:#ff2a55;' : ''}"></div>
            <span style="${isShark ? 'color:#fff; font-weight:900;' : (isWall ? 'color:#fff; font-weight:800;' : '')}">${vol > 0 ? vol.toFixed(1) : ''}</span>
          </div>
        </div>
      `;
    }

    // 2. Render Center Spread & Live Price Anchor Row
    const cvd = snapshot.cvd || 0;
    const deltaColor = cvd >= 0 ? '#00e676' : '#ff3366';
    html += `
      <div class="dom-row current-price dom-center-spread">
        <div class="dom-col" style="justify-content:flex-start; padding-left:6px; color:#00e676; font-weight:800; font-size:10px;">
          BID ${(snapshot.bid || currentPrice).toFixed(2)}
        </div>
        <div class="dom-col price" style="color:#ffd60a; font-weight:800; font-size:11px; letter-spacing:0.3px;">
          ⚡ ${currentPrice.toFixed(2)} <span style="color:${deltaColor}; font-size:9px; margin-left:3px;">(${spread.toFixed(2)})</span>
        </div>
        <div class="dom-col" style="justify-content:flex-end; padding-right:6px; color:#ff3366; font-weight:800; font-size:10px;">
          ASK ${(snapshot.ask || currentPrice).toFixed(2)}
        </div>
      </div>
    `;

    // 3. Render Bottom Half: BID Liquidity Ladder (Bid -> Low)
    for (const row of bidRows) {
      const { p, pStr, vol } = row;
      const is1D = pdl > 0 && Math.abs(p - pdl) <= 0.08;
      const is1DOpen = dailyOpen > 0 && Math.abs(p - dailyOpen) <= 0.08;
      const isDPOC = dpoc > 0 && Math.abs(p - dpoc) <= 0.08;
      const isH8 = h8Sup > 0 && Math.abs(p - h8Sup) <= 0.08;
      const isH4 = h4Sup > 0 && Math.abs(p - h4Sup) <= 0.08;
      const isH1 = h1Sup > 0 && Math.abs(p - h1Sup) <= 0.08;
      const isM30 = m30Sup > 0 && Math.abs(p - m30Sup) <= 0.08;
      const isM15 = m15Sup > 0 && Math.abs(p - m15Sup) <= 0.08;
      const hasIceberg = icebergs.some(ic => Math.abs(ic.price - p) <= 0.11 && (nowMs - ic.timestamp < 90000));
      const hasSpoofPull = spoofEvents.some(sp => sp.type === 'PULLING' && Math.abs(sp.price - p) <= 0.08 && (nowMs - sp.timestamp < 12000));
      const isShark = vol >= 78.0;
      const isWall = vol >= 50.0;
      const bidBarWidth = Math.min(100, (vol / scale) * 100);

      let badgePrefix = '';
      if (hasSpoofPull) badgePrefix = '⚡ ';
      else if (is1D) badgePrefix = '🏛️1D-SUP ';
      else if (is1DOpen) badgePrefix = '⚡1D-OPEN ';
      else if (isH8) badgePrefix = '🏛️H8 ';
      else if (isH4) badgePrefix = '🏰H4 ';
      else if (isH1) badgePrefix = '⏱️H1 ';
      else if (isM30) badgePrefix = '⏳M30 ';
      else if (isM15) badgePrefix = '⚡M15 ';
      else if (isShark) badgePrefix = '🦈 ';
      else if (hasIceberg) badgePrefix = '🧊 ';
      else if (isDPOC) badgePrefix = '⭐ ';
      else if (isWall) badgePrefix = '🧱 ';

      let rowBgStyle = '';
      if (hasSpoofPull) {
        rowBgStyle = 'background:rgba(239,68,68,0.22); border-left:2px solid #ef4444;';
      } else if (is1D) {
        rowBgStyle = 'background:rgba(253,224,71,0.28); border-left:3px solid #fde047;';
      } else if (is1DOpen) {
        rowBgStyle = 'background:rgba(56,189,248,0.24); border-left:3px solid #38bdf8;';
      } else if (isH8) {
        rowBgStyle = 'background:rgba(5,150,105,0.26); border-left:3px solid #059669;';
      } else if (isH4) {
        rowBgStyle = 'background:rgba(16,185,129,0.24); border-left:3px solid #10b981;';
      } else if (isH1) {
        rowBgStyle = 'background:rgba(6,182,212,0.22); border-left:3px solid #06b6d4;';
      } else if (isM30) {
        rowBgStyle = 'background:rgba(59,130,246,0.22); border-left:3px solid #3b82f6;';
      } else if (isM15) {
        rowBgStyle = 'background:rgba(45,212,191,0.20); border-left:3px solid #2dd4bf;';
      } else if (isShark) {
        rowBgStyle = 'background:linear-gradient(90deg, rgba(0,245,155,0.24), transparent); border-left:2px solid #00f59b;';
      } else if (isDPOC) {
        rowBgStyle = 'border-left:2px solid #ffd60a; background:rgba(255,214,10,0.06);';
      }

      const priceColor = hasSpoofPull
        ? 'color:#f87171; font-weight:800;'
        : (isShark
          ? 'color:#00f59b; font-weight:900;'
          : (hasIceberg ? 'color:#00f0ff; font-weight:800;' : (isDPOC ? 'color:#ffd60a; font-weight:800;' : (isWall ? 'color:#6ee7b7; font-weight:700;' : 'color:#cbd5e1;'))));

      html += `
        <div class="dom-row dom-bid-row" data-price="${pStr}" style="cursor:pointer; ${rowBgStyle}" title="⚡ Klik untuk pasang BUY LIMIT @ $${pStr}">
          <div class="dom-col bid-vol" title="Kecairan Demand (Bid) @ $${pStr}: ${vol.toFixed(1)} Lots">
            <div class="dom-bar bid ${isShark ? 'wall-glow-bid' : (isWall ? 'wall-glow-bid' : '')}" style="width: ${bidBarWidth.toFixed(1)}%; ${isShark ? 'background:#00f59b;' : ''}"></div>
            <span style="${isShark ? 'color:#fff; font-weight:900;' : (isWall ? 'color:#fff; font-weight:800;' : '')}">${vol > 0 ? vol.toFixed(1) : ''}</span>
          </div>
          <div class="dom-col price" style="${priceColor}">${badgePrefix}${pStr}</div>
          <div class="dom-col ask-vol" style="position:relative;" title="Volum Terlaksana Sesi @ $${pStr}: ${(tradedMap[pStr] || 0).toFixed(1)}L">
            <div class="dom-bar-traded bid-side" style="width:${Math.min(100, ((tradedMap[pStr] || 0) / maxTraded) * 100).toFixed(1)}%;"></div>
            <span class="dom-wall-tag" style="${isShark ? 'color:#00f59b; font-weight:900;' : ''}">${isShark ? '🦈JERUNG' : (isWall ? 'WALL' : ((tradedMap[pStr] || 0) > 0 ? (tradedMap[pStr] || 0).toFixed(0) + 'v' : ''))}</span>
          </div>
        </div>
      `;
    }

    this.container.innerHTML = html;

    // 4. Update Bottom DOM Book Imbalance Footer
    const totalBook = totalBidVol + totalAskVol;
    if (totalBook > 0) {
      const bidPct = Math.round((totalBidVol / totalBook) * 100);
      const askPct = 100 - bidPct;
      const elBidSum = document.getElementById('domBidSum');
      const elAskSum = document.getElementById('domAskSum');
      const elBidBar = document.getElementById('domImbBidBar');
      const elBiasTxt = document.getElementById('domImbBiasText');

      if (elBidSum) elBidSum.textContent = `BID: ${totalBidVol.toFixed(0)}L (${bidPct}%)`;
      if (elAskSum) elAskSum.textContent = `ASK: ${totalAskVol.toFixed(0)}L (${askPct}%)`;
      if (elBidBar) elBidBar.style.width = `${bidPct}%`;
      if (elBiasTxt) {
        const netImb = totalBidVol - totalAskVol;
        if (bidPct >= 53) {
          elBiasTxt.textContent = `🟢 TEKANAN BID +${netImb.toFixed(0)} LOTS`;
          elBiasTxt.style.color = '#00e676';
        } else if (askPct >= 53) {
          elBiasTxt.textContent = `🔴 TEKANAN ASK ${netImb.toFixed(0)} LOTS`;
          elBiasTxt.style.color = '#ff3366';
        } else {
          elBiasTxt.textContent = `⚖️ BUKU PESANAN SEIMBANG`;
          elBiasTxt.style.color = '#ffb703';
        }
      }
    }
  }
}

window.DOMManager = DOMManager;
