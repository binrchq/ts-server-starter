# 常用操作入口。CI 用的就是这些目标，避免「本地能过、CI 不能过」。
SHELL := /bin/sh
.DEFAULT_GOAL := help
PNPM ?= pnpm

.PHONY: help install dev build start typecheck lint format test test-coverage verify smoke \
        migrate-up migrate-down migrate-status migrate-create routes docker-build docker-up docker-down clean

help: ## 列出所有目标
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## 安装依赖
	$(PNPM) install

dev: ## 本地热重载启动（读 src/config/config.yaml + .env）
	$(PNPM) dev

build: ## 编译到 dist/ 并拷贝静态资源
	$(PNPM) build

start: ## 运行编译产物
	$(PNPM) start

typecheck: ## 类型检查（源码 + 测试）
	$(PNPM) typecheck

lint: ## ESLint
	$(PNPM) lint

format: ## Prettier 格式化
	$(PNPM) format

test: ## 单元 + 集成测试
	$(PNPM) test

test-coverage: ## 带覆盖率
	$(PNPM) test:coverage

verify: ## 提交前自检：类型 + lint + 测试
	$(PNPM) verify

smoke: ## 针对已启动的实例跑端到端冒烟
	$(PNPM) smoke

migrate-up: ## 应用迁移
	$(PNPM) migrate up

migrate-down: ## 回滚一步
	$(PNPM) migrate down --steps 1

migrate-status: ## 迁移状态（含 drift 检测）
	$(PNPM) migrate status

migrate-create: ## 生成迁移骨架：make migrate-create name=add_orders
	@test -n "$(name)" || (echo "用法: make migrate-create name=<snake_case_name>"; exit 1)
	$(PNPM) migrate create $(name)

routes: ## 打印路由矩阵
	$(PNPM) routes

docker-build: ## 构建镜像
	docker build -t ts-server-starter:local .

docker-up: ## 起全套（app + postgres + redis）
	docker compose up -d --build

docker-down: ## 停全套并保留数据卷
	docker compose down

clean: ## 清理构建产物与覆盖率
	rm -rf dist coverage logs
