# syntax=docker/dockerfile:1.7
#
# 多阶段构建：构建期需要 devDependencies（tsc/vitest），运行期只需要 6 个运行时依赖。
# 不这么分的话镜像会带着 typescript、eslint、vitest 一起上线。

# ── 构建阶段 ──────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# 先只拷贝清单文件：依赖不变时这一层可以命中缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

# ── 运行阶段 ──────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm store 挂的是 buildkit cache mount，本来就不会进镜像层，
# 不要在这里 rm 它：mountpoint 在同一个 RUN 里删不掉，会报 “Directory not empty” 让构建失败。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod \
 && rm -rf /root/.cache

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# 非 root 运行：容器逃逸后的第一道门槛
USER node

# outer / admin / inner / openapi / metrics
EXPOSE 4600 4601 4602 4603 4604

# 用存活探针而不是完整健康检查：后者会连数据库，
# 数据库抖动时会让编排系统误杀所有实例
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER__PORT||4600)+'/api/v1/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js", "serve", "--config", "./dist/config/config.yaml"]
