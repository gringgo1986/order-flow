"""
SQLite Authentication, User Management, and Membership Subscription Engine for XAUUSD.FLOW PRO
"""
import sqlite3
import hashlib
import secrets
import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

DB_PATH = Path(__file__).parent / "users.db"

def get_connection():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def hash_password(password: str, salt: Optional[str] = None) -> str:
    if not salt:
        salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
    return f"{salt}${hashed}"

def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, expected_hash = stored_hash.split("$", 1)
        actual_hash = hashlib.sha256((salt + password).encode('utf-8')).hexdigest()
        return secrets.compare_digest(actual_hash, expected_hash)
    except Exception:
        return False

def init_db():
    conn = get_connection()
    c = conn.cursor()
    # Users table
    c.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        plan TEXT NOT NULL DEFAULT 'Bulanan 30 Hari',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login TEXT,
        notes TEXT
    )
    """)

    # Sessions table
    c.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
    """)

    # Check if admin exists; if not, create default admin
    c.execute("SELECT id FROM users WHERE username = 'admin'")
    row = c.fetchone()
    if not row:
        now_iso = datetime.datetime.utcnow().isoformat()
        admin_pass_hash = hash_password("admin123#")
        c.execute("""
        INSERT INTO users (username, password_hash, full_name, role, plan, created_at, expires_at, is_active, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "admin",
            admin_pass_hash,
            "Pengasas Sistem (Admin)",
            "admin",
            "VIP Lifetime",
            now_iso,
            "never",
            1,
            "Default Root Administrator"
        ))
        conn.commit()
        print("[Auth] Default admin account created: admin / admin123#")
    conn.close()

def calculate_remaining_days(expires_at: str) -> int:
    if expires_at == "never":
        return 99999
    try:
        exp_dt = datetime.datetime.fromisoformat(expires_at)
        now_dt = datetime.datetime.utcnow()
        diff = (exp_dt - now_dt).total_seconds()
        if diff <= 0:
            return 0
        return max(0, int(diff // 86400) + 1)
    except Exception:
        return 0

def authenticate(username: str, password: str) -> Tuple[bool, Optional[Dict[str, Any]], Optional[str]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username.strip(),))
    row = c.fetchone()
    if not row:
        conn.close()
        return False, None, "ID Pengguna tidak ditemui. Sila semak semula."

    user = dict(row)
    if not verify_password(password, user["password_hash"]):
        conn.close()
        return False, None, "Kata laluan tidak sah. Sila cuba lagi."

    if not user["is_active"]:
        conn.close()
        return False, None, "Akaun anda telah digantung oleh Pentadbir. Sila hubungi Admin."

    # Check expiration
    if user["expires_at"] != "never":
        try:
            exp_dt = datetime.datetime.fromisoformat(user["expires_at"])
            if datetime.datetime.utcnow() > exp_dt:
                conn.close()
                return False, None, "Tempoh langganan akaun anda telah tamat. Sila hubungi Admin untuk menyambung akses."
        except Exception:
            pass

    # Update last_login
    now_iso = datetime.datetime.utcnow().isoformat()
    c.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_iso, user["id"]))
    conn.commit()
    conn.close()

    user.pop("password_hash", None)
    user["remaining_days"] = calculate_remaining_days(user["expires_at"])
    return True, user, None

def create_session(user_id: int, duration_days: int = 14) -> str:
    conn = get_connection()
    c = conn.cursor()
    session_id = secrets.token_urlsafe(32)
    now = datetime.datetime.utcnow()
    exp = now + datetime.timedelta(days=duration_days)
    c.execute("""
    INSERT INTO sessions (session_id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
    """, (session_id, user_id, now.isoformat(), exp.isoformat()))
    conn.commit()
    conn.close()
    return session_id

def validate_session(session_id: str) -> Optional[Dict[str, Any]]:
    if not session_id:
        return None
    conn = get_connection()
    c = conn.cursor()
    c.execute("""
    SELECT s.session_id, s.expires_at as session_exp, u.*
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.session_id = ?
    """, (session_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return None

    data = dict(row)
    now = datetime.datetime.utcnow()
    # Check session timeout
    try:
        if now > datetime.datetime.fromisoformat(data["session_exp"]):
            c.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            conn.close()
            return None
    except Exception:
        pass

    # Check user active status
    if not data["is_active"]:
        conn.close()
        return None

    # Check subscription expiration
    if data["expires_at"] != "never":
        try:
            if now > datetime.datetime.fromisoformat(data["expires_at"]):
                conn.close()
                return None
        except Exception:
            pass

    conn.close()
    data.pop("password_hash", None)
    data["remaining_days"] = calculate_remaining_days(data["expires_at"])
    return data

def destroy_session(session_id: str):
    conn = get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
    conn.commit()
    conn.close()

def list_users() -> List[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT id, username, full_name, role, plan, created_at, expires_at, is_active, last_login, notes FROM users ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    users = []
    now = datetime.datetime.utcnow()
    for r in rows:
        u = dict(r)
        u["remaining_days"] = calculate_remaining_days(u["expires_at"])
        if not u["is_active"]:
            u["status_label"] = "DIGANTUNG"
            u["status_color"] = "#ef4444"
        elif u["expires_at"] != "never" and u["remaining_days"] <= 0:
            u["status_label"] = "TAMAT TEMPOH"
            u["status_color"] = "#f97316"
        else:
            u["status_label"] = "AKTIF"
            u["status_color"] = "#10b981"
        users.append(u)
    return users

def create_user(
    username: str,
    password: str,
    full_name: str,
    role: str = "member",
    plan: str = "Bulanan 30 Hari",
    duration_days: int = 30,
    notes: str = ""
) -> Tuple[bool, Optional[int], Optional[str]]:
    username = username.strip()
    if not username or len(username) < 3:
        return False, None, "ID Pengguna mestilah sekurang-kurangnya 3 aksara."
    if not password or len(password) < 4:
        return False, None, "Kata laluan mestilah sekurang-kurangnya 4 aksara."

    now = datetime.datetime.utcnow()
    if duration_days == -1 or plan == "VIP Lifetime":
        expires_at = "never"
    else:
        expires_at = (now + datetime.timedelta(days=max(1, duration_days))).isoformat()

    conn = get_connection()
    c = conn.cursor()
    try:
        p_hash = hash_password(password)
        c.execute("""
        INSERT INTO users (username, password_hash, full_name, role, plan, created_at, expires_at, is_active, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            username,
            p_hash,
            full_name.strip() or username,
            role,
            plan,
            now.isoformat(),
            expires_at,
            1,
            notes.strip()
        ))
        conn.commit()
        user_id = c.lastrowid
        conn.close()
        return True, user_id, None
    except sqlite3.IntegrityError:
        conn.close()
        return False, None, f"ID Pengguna '{username}' sudah wujud. Sila gunakan ID lain."
    except Exception as e:
        conn.close()
        return False, None, str(e)

def update_user(user_id: int, **kwargs) -> Tuple[bool, Optional[str]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return False, "Pengguna tidak ditemui."

    allowed = ["full_name", "role", "plan", "is_active", "notes"]
    updates = []
    params = []

    for k in allowed:
        if k in kwargs and kwargs[k] is not None:
            updates.append(f"{k} = ?")
            params.append(kwargs[k])

    if "password" in kwargs and kwargs["password"]:
        updates.append("password_hash = ?")
        params.append(hash_password(kwargs["password"]))

    # Extend duration
    if "add_days" in kwargs and kwargs["add_days"]:
        add_d = int(kwargs["add_days"])
        current_exp = row["expires_at"]
        now = datetime.datetime.utcnow()
        if current_exp == "never":
            pass
        else:
            try:
                base_dt = datetime.datetime.fromisoformat(current_exp)
                if base_dt < now:
                    base_dt = now
            except Exception:
                base_dt = now
            new_exp = (base_dt + datetime.timedelta(days=add_d)).isoformat()
            updates.append("expires_at = ?")
            params.append(new_exp)

    if "set_lifetime" in kwargs and kwargs["set_lifetime"]:
        updates.append("expires_at = ?")
        params.append("never")

    if not updates:
        conn.close()
        return True, None

    params.append(user_id)
    c.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return True, None

def delete_user(user_id: int) -> Tuple[bool, Optional[str]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE id = ?", (user_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return False, "Pengguna tidak wujud."
    if row["role"] == "admin":
        # Check if other admin exists
        c.execute("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND id != ?", (user_id,))
        if c.fetchone()["cnt"] == 0:
            conn.close()
            return False, "Tidak boleh memadam pentadbir tunggal sistem."

    c.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    c.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return True, None

# Run table creation on import
init_db()
