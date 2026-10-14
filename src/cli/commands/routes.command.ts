/**
 * `routes` 子命令：把路由矩阵渲染成 Markdown。
 *
 * 用法：`ts-server routes > ROUTERS.md`
 * 这样文档不可能和代码脱节 —— 它是由真实注册表生成的。
 */
import { Command } from 'commander';
import { wire } from '../../serve/wire.js';

export function createRoutesCommand(): Command {
  return new Command('routes')
    .description('输出路由矩阵（Markdown），建议重定向到 ROUTERS.md')
    .option('-c, --config <path>', 'config.yaml 路径')
    .action(async (options: { config?: string }) => {
      // 只装配、不监听：wire 不会 listen，端口不会被占用
      const app = await wire({
        ...(options.config ? { configPath: options.config } : {}),
        overrides: {
          server: { port: 0, adminPort: 0, internalPort: 0, openapiPort: 0, metricsPort: 0 },
          // 这份输出是要重定向进文件的（`routes > ROUTERS.md`），
          // 日志必须让路到 stderr —— 否则启动期的 DEBUG 行会被写进产物里
          logging: { output: 'stderr' },
        },
      });
      process.stdout.write(app.registry.toMarkdown());
      await app.close();
    });
}
