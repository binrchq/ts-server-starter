/**
 * 口令哈希（scrypt，Node 内置，零依赖）。
 *
 * 为什么不用 bcrypt：需要原生编译依赖，容器镜像里常常装不上。
 * scrypt 是 RFC 7914 标准算法，抗 GPU/ASIC，Node 内置 —— 对绝大多数服务足够。
 * 存储格式：scrypt$N$r$p$<salt-b64>$<hash-b64>，参数随哈希一起存，
 * 将来调参可以在校验通过后自动 rehash（见 needsRehash）。
 *
 * 注意：scrypt 是 CPU 密集型，必须用 async 版本，否则会阻塞事件循环。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16_384; // CPU/内存开销
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** scrypt 的内存上限必须 > 128*N*r，否则会直接报错 */
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 校验口令。任何解析异常一律视为失败（不抛错，避免把细节泄露给调用方） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await derive(password, salt, Number(nRaw), Number(rRaw), Number(pRaw));
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 参数是否已落后于当前配置（用于登录成功后静默升级哈希） */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N;
}
