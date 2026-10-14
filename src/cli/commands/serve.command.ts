/**
 * `serve` 子命令 —— 生产/开发都走这里启动。
 */
import { Command } from 'commander';
import { wire } from '../../serve/wire.js';
import { Serve } from '../../serve/serve.js';

export function createServeCommand(): Command {
  return new Command('serve')
    .description('启动 HTTP 服务（多端口）与后台任务')
    .option('-c, --config <path>', 'config.yaml 路径')
    .option('--port <number>', '覆盖 outer 端口', (value) => Number.parseInt(value, 10))
    .option('--shutdown-timeout <ms>', '优雅退出超时（毫秒）', (value) => Number.parseInt(value, 10))
    .action(async (options: { config?: string; port?: number; shutdownTimeout?: number }) => {
      const app = await wire({
        ...(options.config ? { configPath: options.config } : {}),
        ...(options.port ? { overrides: { server: { port: options.port } } } : {}),
      });

      const serve = new Serve(app, {
        ...(options.shutdownTimeout ? { shutdownTimeoutMs: options.shutdownTimeout } : {}),
      });
      await serve.run();
    });
}
