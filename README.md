---
title: Gringgo Orderflow
emoji: 📈
colorFrom: yellow
colorTo: indigo
sdk: docker
app_port: 8000
pinned: false
---

# Gringgo Orderflow - Trading Cockpit ⚡

Aplikasi dagangan profesional khusus untuk **XAUUSD (Emas / Gold)** menggunakan visualisasi **Bookmap (Liquidity Heatmap)** dan analisis mendalam **Order Flow (Footprint, CVD & DOM)** berintegrasi terus dengan **MetaTrader 5 (MT5)**.

---

## 🌟 Ciri-Ciri Utama Aplikasi

### 1. 📊 Bookmap Liquidity Heatmap
- **Visualisasi Kecairan (Liquidity):** Memaparkan *resting limit orders* institusi dalam bentuk peta haba (heatmap) berwarna (Biru = rendah, Sian/Kuning = sederhana, Jingga/Merah Terang = dinding kecairan tebal).
- **Volume Bubbles (Buih Pasaran Agresif):** 
  - **Buih Hijau:** *Market Buy Orders* (agresif beli pada harga Ask).
  - **Buih Merah:** *Market Sell Orders* (agresif jual pada harga Bid).
  - Saiz buih berskala mengikut saiz lot.
  - Pengesanan transaksi gergasi (**Whale 🐋**) dengan lingkaran cincin khas.
- **Pemeriksaan Interaktif:** Arahkan tetikus ke atas mana-mana buih untuk melihat masa milisaat, harga, saiz lot dan pihak pembeli/penjual.

### 2. 🕯️ Order Flow Footprint Chart
- **Kluster Bid x Ask:** Setiap batang lilin (candlestick) dipecahkan kepada paras harga dengan jumlah volum *Market Sell (Bid)* di sebelah kiri dan *Market Buy (Ask)* di sebelah kanan.
- **Pengesanan Ketidakseimbangan (Imbalances):** Menyerlahkan nisbah ketidakseimbangan 300% (diagonal imbalance) secara automatik bagi mengenal pasti tekanan kuat pembeli atau penjual institusi.
- **Point of Control (POC):** Paras harga dengan jumlah volum dagangan tertinggi dalam lilin ditandakan dengan sempadan emas (*gold border*).
- **Delta Lilin & Jumlah Volum:** Ringkasan Delta ($\Delta$) dan Volum ($V$) di bahagian bawah setiap lilin.

### 3. 📈 Cumulative Volume Delta (CVD)
- Carta garis masa nyata di bawah carta utama yang mengira baki bersih volum agresif ($Vol_{buy} - Vol_{sell}$).
- Membantu pedagang mengesan **Divergence** (contoh: harga membuat *higher high* tetapi CVD membuat *lower low* = petanda keletihan pembeli / penyerapan pesanan).

### 4. 🪜 Depth of Market (DOM) & Panel Dagangan 1-Klik
- **Tangga Harga Masa Nyata:** Menunjukkan jumlah pesanan *Resting Bids* dan *Resting Asks* dengan palang volum berwarna.
- **Pelaksanaan Pantas:**
  - Tetapan saiz lot pra-tetap (0.01, 0.05, 0.10, 0.50, 1.00 atau nilai tersuai).
  - Input automatik untuk Stop Loss (SL) dan Take Profit (TP) dalam pips.
  - Butang pantas **BUY MARKET** & **SELL MARKET**.
  - Butang **MOVE SL TO BE** (Break-Even) & **CLOSE ALL POSITIONS**.

### 5. 🔗 Integrasi MetaTrader 5 (MT5) & Mod Simulator
- **Live MT5 Connection:** Menyambung secara terus ke terminal MetaTrader 5 yang sedang dibuka di komputer anda. Mengesan akaun, baki, ekuiti, dan floating profit secara langsung.
- **Mod Simulator / Demo:** Boleh ditukar serta-merta dengan satu klik jika terminal MT5 ditutup atau pada hujung minggu untuk mengkaji corak aliran pesanan.

---

## 🚀 Cara Menjalankan Aplikasi

### Langkah 1: Pastikan MT5 Dibuka
1. Buka aplikasi **MetaTrader 5** di komputer anda.
2. Pastikan butang **"Algo Trading"** (atau *Automated Trading*) pada toolbar MT5 telah diaktifkan (berwarna hijau) supaya aplikasi web dibenarkan menghantar pesanan terus ke akaun anda.

### Langkah 2: Lancarkan Aplikasi
Cuma klik dua kali (double-click) pada fail:
```
run.bat
```
Atau melalui PowerShell:
```powershell
cd "C:\Users\din\.gemini\antigravity\scratch\xauusd-orderflow-bookmap"
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

### Langkah 3: Buka Pelayar Web (Browser)
Buka Google Chrome atau Edge dan layari:
```
http://127.0.0.1:8000
```

---

## 📂 Struktur Fail Projek

```
xauusd-orderflow-bookmap/
├── app.py              # Server FastAPI & WebSocket Hub
├── mt5_engine.py       # Enjin sambungan MT5, pemprosesan tick & Bookmap
├── run.bat             # Pelancar 1-Klik untuk Windows
├── README.md           # Dokumentasi lengkap
└── static/
    ├── index.html      # Antaramuka Cockpit Dagangan
    ├── css/
    │   └── style.css   # Gaya tema gelap Bookmap (Dark Theme)
    └── js/
        ├── bookmap.js  # Render Kanvas Bookmap Heatmap & Volume Bubbles
        ├── footprint.js# Render Kanvas Order Flow Footprint (Bid x Ask)
        ├── dom.js      # Depth of Market Ladder & CVD
        └── app.js      # Pengurusan WebSocket, Order Routing & Logik UI
```
