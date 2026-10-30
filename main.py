import os
import io
import shutil
import zipfile
import urllib.request
from pathlib import Path

base_dir = Path(__file__).parent

# ─── AUTO-UPDATER DARI GITHUB SETIAP KALI START / RESTART ───
try:
    print("[Auto-Updater] Menyemak & memuat turun kod terkini dari GitHub (gringgo1986/order-flow)...")
    zip_url = "https://github.com/gringgo1986/order-flow/archive/refs/heads/main.zip"
    req = urllib.request.Request(zip_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        z = zipfile.ZipFile(io.BytesIO(resp.read()))
        updated_count = 0
        for member in z.infolist():
            parts = member.filename.split("/")[1:]
            if not parts or not parts[0]:
                continue
            # Jangan timpa fail database dan fail keselamatan
            if parts[0] in ["users.db", ".github_token"]:
                continue
            target_path = base_dir.joinpath(*parts)
            if member.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
            else:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                with z.open(member) as src_f, open(target_path, "wb") as dst_f:
                    dst_f.write(src_f.read())
                updated_count += 1
        print(f"[Auto-Updater] Berjaya mengemas kini {updated_count} fail secara automatik dari GitHub!")
except Exception as e:
    print(f"[Auto-Updater Warning] Gagal muat turun kemas kini automatik: {e}")

# Auto-fix Windows backslash filenames on Linux systems
try:
    for item in list(base_dir.iterdir()):
        if item.is_file() and ("\\" in item.name):
            parts = item.name.split("\\")
            target = base_dir.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
except Exception as e:
    print(f"[Auto-Fix Error] {e}")

import uvicorn
from app import app

if __name__ == "__main__":
    port = int(os.environ.get("SERVER_PORT", os.environ.get("PORT", 25867)))
    print(f"Starting Gringgo Orderflow Server on 0.0.0.0:{port}...")
    uvicorn.run("app:app", host="0.0.0.0", port=port, workers=1)
