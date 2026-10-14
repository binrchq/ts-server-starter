-- 初始表结构。
--
-- 约定：每个迁移都必须有严格对称的 down，否则回滚会失败（引擎会主动报错而不是跳过）。

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  VARCHAR(128) NOT NULL DEFAULT '',
  roles         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  status        VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 邮箱唯一但不区分大小写：注册时 "A@x.com" 和 "a@x.com" 必须视作同一账号
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS tasks (
  id            UUID PRIMARY KEY,
  owner_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         VARCHAR(255) NOT NULL,
  status        VARCHAR(32)  NOT NULL DEFAULT 'pending',
  priority      INTEGER      NOT NULL DEFAULT 0,
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 查询模式是「某人的任务按状态/时间」，所以索引顺序对应 where + order by
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks (owner_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(64)  NOT NULL,
  prefix        VARCHAR(32)  NOT NULL,
  key_hash      CHAR(64)     NOT NULL,
  scopes        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 只存哈希；唯一索引让鉴权变成一次索引命中，而不是全表扫描比对
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id, created_at DESC);
