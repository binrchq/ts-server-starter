-- MySQL 版本。注意差异：UUID 用 CHAR(36)，JSON 用 JSON 类型，
-- 没有 CREATE INDEX IF NOT EXISTS，所以索引建在 CREATE TABLE 内。

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  roles         JSON         NOT NULL,
  status        VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY idx_users_email_lower (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tasks (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  owner_id      CHAR(36)     NOT NULL,
  title         VARCHAR(255) NOT NULL,
  status        VARCHAR(32)  NOT NULL DEFAULT 'pending',
  priority      INT          NOT NULL DEFAULT 0,
  due_at        DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_tasks_owner_status (owner_id, status, created_at),
  CONSTRAINT fk_tasks_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
