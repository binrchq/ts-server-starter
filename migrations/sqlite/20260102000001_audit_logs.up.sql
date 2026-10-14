-- 审计日志（SQLite 版）。JSONB 退化为 TEXT，detail 由应用层序列化。

CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action        VARCHAR(64)  NOT NULL,
  outcome       VARCHAR(16)  NOT NULL,
  user_id       VARCHAR(64),
  resource      VARCHAR(255) NOT NULL DEFAULT '',
  ip            VARCHAR(64)  NOT NULL DEFAULT '',
  user_agent    TEXT         NOT NULL DEFAULT '',
  request_id    VARCHAR(64)  NOT NULL DEFAULT '',
  detail        TEXT         NOT NULL DEFAULT '{}',
  created_at    TEXT         NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs (action, created_at DESC);
