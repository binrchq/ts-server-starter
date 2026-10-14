/**
 * CLI 入口（对应 go-starter 的 cmd/app/cli）。
 * 用 commander 替代 cobra，命令按文件拆分，新增命令只需加一行 register。
 */
import { Command } from 'commander';
import { defaultConfig } from '../config/schema.js';
import { createServeCommand } from './commands/serve.command.js';
import { createMigrateCommand } from './commands/migrate.command.js';
import { createVersionCommand } from './commands/version.command.js';
import { createRoutesCommand } from './commands/routes.command.js';

export function createCli(): Command {
  const program = new Command();

  // 名字/描述/版本与 defaultConfig() 同源：改服务名只需要动一处，
  // 不会出现 `--help` 说 A、启动日志说 B、`--version` 又是第三个版本号。
  const app = defaultConfig().app;

  program
    .name(app.name)
    .description(app.description)
    .version(app.version.replace(/^v/, ''), '-v, --version', '输出 CLI 版本')
    .showHelpAfterError()
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
    });

  program.addCommand(createServeCommand());
  program.addCommand(createMigrateCommand());
  program.addCommand(createVersionCommand());
  program.addCommand(createRoutesCommand());

  return program;
}
