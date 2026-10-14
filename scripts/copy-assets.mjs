#!/usr/bin/env node
/**
 * 构建后拷贝非 TS 资源。
 *
 * tsc 只处理 .ts，不会把 config.yaml 带进 dist/。
 * 与其在部署脚本里 cp（很容易漏），不如让 build 自己负责。
 */
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集 src/ 下的某个后缀（顺序稳定，日志可比对） */
function collect(dir, extension) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      found.push(...collect(full, extension));
    } else if (entry.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

// 漏拷资源的代价是「构建成功、运行即崩」，而且报错在依赖内部（例如 grpc 读 .proto），
// 一眼看不出是谁没拷贝 —— 所以按后缀全收，而不是手工维护清单。
const src = resolve(root, 'src');
const copies = [resolve(src, 'config/config.yaml'), ...collect(src, '.proto')];

for (const from of copies) {
  const to = join(root, 'dist', relative(src, from));
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  process.stdout.write(`copied ${relative(root, from)} -> ${relative(root, to)}\n`);
}
