import os
import shutil
from pathlib import Path

# Auto-fix Windows backslash filenames on Linux systems
base_dir = Path(__file__).parent
try:
    for item in list(base_dir.iterdir()):
        if item.is_file() and ("\\" in item.name):
            parts = item.name.split("\\")
            target = base_dir.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            print(f"[Auto-Fix] Copied {item.name} -> {target}")
except Exception as e:
    print(f"[Auto-Fix Error] {e}")

import uvicorn
from app import app

if __name__ == "__main__":
    port = int(os.environ.get("SERVER_PORT", os.environ.get("PORT", 25867)))
    print(f"Starting Gringgo Orderflow Server on 0.0.0.0:{port}...")
    uvicorn.run("app:app", host="0.0.0.0", port=port, workers=1)
