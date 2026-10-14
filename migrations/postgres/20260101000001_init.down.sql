-- 与 up 严格对称：逆序删除
DROP INDEX IF EXISTS idx_api_keys_user;
DROP INDEX IF EXISTS idx_api_keys_key_hash;
DROP TABLE IF EXISTS api_keys;

DROP INDEX IF EXISTS idx_tasks_owner_status;
DROP TABLE IF EXISTS tasks;

DROP INDEX IF EXISTS idx_users_email_lower;
DROP TABLE IF EXISTS users;
