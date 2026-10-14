-- 审计日志。
--
-- 为什么和业务日志分开：审计要回答「谁在什么时候对什么做了什么」，
-- 需要按 user/action 检索且长期保留，语义与 debug 日志完全不同。
--
-- user_id 为什么不是 UUID：审计必须能记录**任何**主体，包括
-- 开发旁路身份（dev-user-0001）、API Key 主体、未来的服务账号。
-- 把 id 空间绑死在 UUID 上会让这些主体直接写不进来（审计缺口比"类型不够漂亮"严重得多）。

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  action        VARCHAR(64)  NOT NULL,
  outcome       VARCHAR(16)  NOT NULL,
  user_id       VARCHAR(64),
  resource      VARCHAR(255) NOT NULL DEFAULT '',
  ip            VARCHAR(64)  NOT NULL DEFAULT '',
  user_agent    TEXT         NOT NULL DEFAULT '',
  request_id    VARCHAR(64)  NOT NULL DEFAULT '',
  detail        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 两个主要检索方向：按人查、按动作查
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs (action, created_at DESC);
-- outcome=denied/failure 是安全分析的主入口，单独给一个部分索引
CREATE INDEX IF NOT EXISTS idx_audit_logs_failed_time ON audit_logs (created_at DESC) WHERE outcome <> 'success';
