import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 集成测试会监听临时端口、读写文件，串行执行避免相互干扰
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/cli/**', 'src/types/**'],
    },
  },
});
