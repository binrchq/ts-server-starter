-- 审计日志（MySQL 版）。BIGINT AUTO_INCREMENT 代替 BIGSERIAL，
-- DATETIME(3) 代替 TIMESTAMPTZ，JSON 代替 JSONB。

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action        VARCHAR(64)  NOT NULL,
  outcome       VARCHAR(16)  NOT NULL,
  user_id       VARCHAR(64)  NULL,
  resource      VARCHAR(255) NOT NULL DEFAULT '',
  ip            VARCHAR(64)  NOT NULL DEFAULT '',
  user_agent    TEXT         NOT NULL,
  request_id    VARCHAR(64)  NOT NULL DEFAULT '',
  detail        JSON         NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_logs_user_time (user_id, created_at DESC),
  KEY idx_audit_logs_action_time (action, created_at DESC),
  KEY idx_audit_logs_failed_time (outcome, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
