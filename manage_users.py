# -*- coding: utf-8 -*-
"""
manage_users.py
Skrip CLI Pengurusan Pelanggan & Penjualan ID XAUUSD.FLOW PRO
Boleh dijalankan terus dari terminal / command line:
  python manage_users.py list
  python manage_users.py add <username> <password> <nama_whatsapp> [hari] [pakej]
  python manage_users.py renew <username> <tambah_hari>
  python manage_users.py toggle <username>
  python manage_users.py delete <username>
  python manage_users.py reset-admin <password_baru>
"""
import sys
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import auth_db

def print_help():
    print("""
===============================================================
PENGURUSAN PENGGUNA & PENJUALAN ID - XAUUSD.FLOW PRO
===============================================================
Penggunaan:
  python manage_users.py list
      -> Senaraikan semua pengguna, baki hari & status

  python manage_users.py trial <username> <password> <nama_whatsapp>
      -> Cipta ID Percubaan 1 Hari (24 Jam) & paparkan teks WhatsApp rasmi

  python manage_users.py add <username> <password> <nama_whatsapp> [hari=30] [pakej="Bulanan 30 Hari"]
      -> Cipta ID pembeli baharu & paparkan teks WhatsApp siap format
      (Gunakan hari=-1 untuk akses Seumur Hidup / VIP Lifetime)

  python manage_users.py renew <username> <tambah_hari>
      -> Sambung tempoh langganan pengguna (cth: tambah 30 hari)

  python manage_users.py toggle <username>
      -> Gantung atau aktifkan semula akaun pengguna

  python manage_users.py delete <username>
      -> Padam akaun pengguna daripada pangkalan data

  python manage_users.py reset-admin <password_baru>
      -> Tukar kata laluan pentadbir utama 'admin'
===============================================================
""")

def cmd_list():
    users = auth_db.list_users()
    print("\n" + "="*80)
    print(f"{'ID':<4} {'USERNAME':<16} {'NAMA / WHATSAPP':<24} {'PAKEJ':<18} {'BAKI HARI':<10} {'STATUS':<10}")
    print("="*80)
    for u in users:
        days_str = "SEUMUR HIDUP" if u["expires_at"] == "never" else f"{u['remaining_days']} Hari"
        role_icon = "[ADMIN] " if u["role"] == "admin" else "[USER]  "
        print(f"{u['id']:<4} {role_icon + u['username']:<16} {u['full_name'][:22]:<24} {u['plan'][:16]:<18} {days_str:<10} {u['status_label']:<10}")
    print("="*80)
    print(f"Jumlah Pengguna: {len(users)}\n")

def cmd_add(args):
    if len(args) < 3:
        print("Ralat: Parameter tidak mencukupi!")
        print("Format: python manage_users.py add <username> <password> <nama_whatsapp> [hari=30] [pakej]")
        return

    username = args[0].strip()
    password = args[1].strip()
    full_name = args[2].strip()
    duration_days = int(args[3]) if len(args) > 3 else 30
    plan = args[4] if len(args) > 4 else ("VIP Lifetime" if duration_days == -1 else f"Langganan {duration_days} Hari")

    ok, user_id, err = auth_db.create_user(
        username=username,
        password=password,
        full_name=full_name,
        role="member",
        plan=plan,
        duration_days=duration_days,
        notes=full_name
    )

    if not ok:
        print(f"\n[X] GAGAL: {err}\n")
        return

    days_label = "SEUMUR HIDUP (VIP LIFETIME)" if duration_days == -1 else f"{duration_days} HARI"
    wa_msg = f"""Salam {full_name}!
Tahniah, akses Terminal XAUUSD.FLOW PRO anda telah diaktifkan secara rasmi:

* Laman Web: https://gringgo-orderflow.onrender.com
* ID Pengguna: {username}
* Kata Laluan: {password}
* Pakej Akses: {plan} ({days_label})

Selamat berdagang dan semoga beroleh profit konsisten!"""

    print("\n" + "="*65)
    print("[OK] ID PELANGGAN BERJAYA DICIPTA & DIAKTIFKAN!")
    print("="*65)
    print(wa_msg)
    print("="*65)
    print("Salin mesej di atas dan hantarkan kepada pembeli anda.\n")

def cmd_trial(args):
    if len(args) < 3:
        print("Format: python manage_users.py trial <username> <password> <nama_whatsapp>")
        return
    cmd_add([args[0], args[1], args[2], "1", "Trial 1 Hari (24 Jam)"])

def cmd_renew(args):
    if len(args) < 2:
        print("Format: python manage_users.py renew <username> <tambah_hari>")
        return
    username = args[0].strip()
    add_days = int(args[1])

    users = auth_db.list_users()
    matched = [u for u in users if u["username"].lower() == username.lower()]
    if not matched:
        print(f"[X] Pengguna '{username}' tidak ditemui.")
        return

    user = matched[0]
    ok, err = auth_db.update_user(user["id"], add_days=add_days)
    if ok:
        print(f"[OK] Berjaya menambah {add_days} hari langganan untuk '{username}'.")
    else:
        print(f"[X] Gagal: {err}")

def cmd_toggle(args):
    if len(args) < 1:
        print("Format: python manage_users.py toggle <username>")
        return
    username = args[0].strip()

    users = auth_db.list_users()
    matched = [u for u in users if u["username"].lower() == username.lower()]
    if not matched:
        print(f"[X] Pengguna '{username}' tidak ditemui.")
        return

    user = matched[0]
    new_active = 0 if user["is_active"] else 1
    action_text = "mengaktifkan semula" if new_active else "menggantung"

    ok, err = auth_db.update_user(user["id"], is_active=new_active)
    if ok:
        print(f"[OK] Berjaya {action_text} akaun '{username}'.")
    else:
        print(f"[X] Gagal: {err}")

def cmd_delete(args):
    if len(args) < 1:
        print("Format: python manage_users.py delete <username>")
        return
    username = args[0].strip()

    users = auth_db.list_users()
    matched = [u for u in users if u["username"].lower() == username.lower()]
    if not matched:
        print(f"[X] Pengguna '{username}' tidak ditemui.")
        return

    user = matched[0]
    ok, err = auth_db.delete_user(user["id"])
    if ok:
        print(f"[OK] Berjaya memadam akaun '{username}'.")
    else:
        print(f"[X] Gagal: {err}")

def cmd_reset_admin(args):
    if len(args) < 1:
        print("Format: python manage_users.py reset-admin <password_baru>")
        return
    new_pass = args[0].strip()
    users = auth_db.list_users()
    admin_user = [u for u in users if u["username"].lower() == "admin"]
    if not admin_user:
        print("[X] Akaun admin tidak ditemui.")
        return
    ok, err = auth_db.update_user(admin_user[0]["id"], password=new_pass)
    if ok:
        print(f"[OK] Kata laluan 'admin' telah berjaya ditukar kepada: {new_pass}")
    else:
        print(f"[X] Gagal: {err}")

def main():
    if len(sys.argv) < 2:
        print_help()
        return

    action = sys.argv[1].lower()
    args = sys.argv[2:]

    if action == "list":
        cmd_list()
    elif action == "add":
        cmd_add(args)
    elif action == "renew":
        cmd_renew(args)
    elif action == "toggle":
        cmd_toggle(args)
    elif action == "delete":
        cmd_delete(args)
    elif action == "reset-admin":
        cmd_reset_admin(args)
    else:
        print_help()

if __name__ == "__main__":
    main()
