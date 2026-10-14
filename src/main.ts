#!/usr/bin/env node
/**
 * 进程入口。
 *
 * 只做三件事：加载 .env、构造 CLI、执行。真正的装配在 src/serve/wire.ts。
 * 所有未捕获异常由 src/core/lifecycle.ts 统一接管（含退出码与超时）。
 */
import 'dotenv/config';
import { createCli } from './cli/index.js';

async function bootstrap(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

void bootstrap().catch((err: unknown) => {
  // 此时 logger 可能还没建立，直接写 stderr 保证错误不丢
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
