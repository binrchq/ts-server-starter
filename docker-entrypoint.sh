#!/bin/sh
# 容器入口：可选地先跑迁移再启动。
# 迁移默认关闭 —— 多副本滚动发布时每个实例都跑迁移会互相打架，
# 正确做法是单独一个 job 执行（见 deploy/README.md）。
set -e

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] applying migrations..."
  node dist/main.js migrate up --config "${CONFIG_PATH:-./dist/config/config.yaml}"
fi

exec "$@"
