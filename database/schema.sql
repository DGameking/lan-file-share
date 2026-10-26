-- 共享文件夹配置
CREATE TABLE IF NOT EXISTS shared_folders (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    permission      TEXT DEFAULT 'read',
    password        TEXT,
    expire_at       INTEGER,
    ip_whitelist    TEXT,
    max_connections INTEGER DEFAULT 10,
    speed_limit     INTEGER DEFAULT 0,
    enabled         INTEGER DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- 设备信息
CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    device_name   TEXT NOT NULL,
    os            TEXT NOT NULL,
    host          TEXT NOT NULL,
    port          INTEGER NOT NULL,
    version       TEXT NOT NULL,
    public_key    TEXT,
    fingerprint   TEXT,
    group_name    TEXT DEFAULT '默认',
    remark        TEXT,
    is_trusted    INTEGER DEFAULT 0,
    is_blacklisted INTEGER DEFAULT 0,
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    is_online     INTEGER DEFAULT 0
);

-- 操作日志
CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    device_id   TEXT,
    device_name TEXT,
    ip          TEXT,
    target      TEXT,
    size        INTEGER,
    result      TEXT,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_event ON logs(event_type);

-- 应用配置
CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 邀请码
CREATE TABLE IF NOT EXISTS invite_codes (
    code      TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expire_at  INTEGER NOT NULL,
    used       INTEGER DEFAULT 0
);

-- 会话聊天消息
CREATE TABLE IF NOT EXISTS chat_messages (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    sender_id   TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'text',
    text        TEXT,
    file_meta   TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages(ts);
