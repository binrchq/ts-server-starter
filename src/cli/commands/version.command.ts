import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';

export function createVersionCommand(): Command {
  return new Command('version')
    .description('打印版本与运行时信息')
    .option('-c, --config <path>', 'config.yaml 路径')
    .action((options: { config?: string }) => {
      const config = loadConfig(options.config ? { configPath: options.config } : {});
      process.stdout.write(
        [
          `${config.app.name} ${config.app.version}`,
          `environment: ${config.environment}`,
          `node:        ${process.version}`,
          `platform:    ${process.platform}/${process.arch}`,
          `pid:         ${process.pid}`,
        ].join('\n') + '\n',
      );
    });
}
