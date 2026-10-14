/**
 * Etcd 状态适配器测试。
 *
 * 分两层验证：
 *  1. `EtcdState` 的 CAS / 锁 / 计数逻辑 —— 用内存原语，起 etcd 也能跑
 *  2. `Etcd3Kv` 对 etcd3 builder API 的翻译 —— 用一个模拟 etcd3 的假客户端，
 *     重点验证「用 mod_revision 而非 version 做 fencing」这条容易出错的设计
 *
 * 关键回归点：锁在 TTL 过期后被别人拿到，原持有者的 release() 绝不能删掉新锁。
 * 用 etcd 的 `version` 会中招（删除后重置），用 `mod_revision` 才安全。
 */
import { describe, expect, it } from 'vitest';
import { Etcd3Kv } from '../src/infra/state/etcd-client.js';
import { EtcdState, type EtcdEntry, type EtcdKvLike } from '../src/infra/state/etcd-state.js';

/** 行为等价于 etcd 的最小原语：令牌为**全局单调**的 revision */
class InMemoryEtcdKv implements EtcdKvLike {
  private readonly store = new Map<string, { value: string; revision: number; expiresAt: number }>();
  private revision = 0;
  closed = false;

  private live(key: string): { value: string; revision: number; expiresAt: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<EtcdEntry | null> {
    const entry = this.live(key);
    return entry ? { value: entry.value, version: entry.revision } : null;
  }

  async put(key: string, value: string, ttlMs?: number): Promise<void> {
    this.revision += 1;
    this.store.set(key, {
      value,
      revision: this.revision,
      expiresAt: ttlMs ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
    });
  }

  async delete(key: string, version?: number): Promise<boolean> {
    const entry = this.live(key);
    if (!entry) return false;
    if (version !== undefined && entry.revision !== version) return false;
    this.store.delete(key);
    return true;
  }

  async compareAndSet(key: string, expected: number, value: string, ttlMs?: number): Promise<number | null> {
    const entry = this.live(key);
    const current = entry ? entry.revision : 0;
    if (current !== expected) return null;
    this.revision += 1;
    this.store.set(key, {
      value,
      revision: this.revision,
      expiresAt: ttlMs ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
    });
    return this.revision;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** 测试辅助：模拟 TTL 到期 */
  forceExpire(key: string): void {
    this.store.delete(key);
  }

  raw(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
}

describe('EtcdState：基本读写', () => {
  it('set/get 走 JSON 序列化，delete 生效', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    await state.set('user:1', { name: 'alice' });
    expect(await state.get<{ name: string }>('user:1')).toEqual({ name: 'alice' });
    expect(await state.delete('user:1')).toBe(true);
    expect(await state.get('user:1')).toBeUndefined();
  });

  it('keyPrefix 会加在所有键上', async () => {
    const kv = new InMemoryEtcdKv();
    const state = new EtcdState(kv, 'state:');
    await state.set('k', 1);
    expect(kv.raw('state:k')).toBe('1');
  });
});

describe('EtcdState：setIfAbsent / increment', () => {
  it('setIfAbsent 只有第一次成功', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    expect(await state.setIfAbsent('once', 'first')).toBe(true);
    expect(await state.setIfAbsent('once', 'second')).toBe(false);
    expect(await state.get('once')).toBe('first');
  });

  it('并发 increment 不丢更新（CAS 重试）', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    const results = await Promise.all(Array.from({ length: 50 }, () => state.increment('counter', 1, 60_000)));
    expect(await state.get('counter')).toBe(50);
    expect(Math.max(...results)).toBe(50);
  });

  it('increment(-1) 可用于回滚额度', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    await state.increment('quota', 3, 60_000);
    expect(await state.increment('quota', -1, 60_000)).toBe(2);
  });
});

describe('EtcdState：分布式锁', () => {
  it('同一把锁只能被一个持有者拿到', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    const first = await state.acquireLock('job', 30_000);
    expect(first).not.toBeNull();
    expect(await state.acquireLock('job', 30_000)).toBeNull();
    await first?.release();
    expect(await state.acquireLock('job', 30_000)).not.toBeNull();
  });

  it('extend 只有在仍持有时成功', async () => {
    const state = new EtcdState(new InMemoryEtcdKv());
    const lock = await state.acquireLock('job', 30_000);
    expect(await lock?.extend(60_000)).toBe(true);
    await lock?.release();
    expect(await lock?.extend(60_000)).toBe(false);
    expect(lock?.held).toBe(false);
  });

  it('TTL 过期锁易主后，旧持有者 release 不会误删新锁（fencing）', async () => {
    const kv = new InMemoryEtcdKv();
    const state = new EtcdState(kv);
    const stale = await state.acquireLock('job', 30_000);
    expect(stale).not.toBeNull();

    // 模拟 TTL 到期：锁消失，别人拿到新锁
    kv.forceExpire('job');
    const fresh = await state.acquireLock('job', 30_000);
    expect(fresh).not.toBeNull();
    const freshToken = kv.raw('job');

    // 旧持有者此时才来释放：必须失败，且新锁原封不动
    expect(await stale?.release()).toBe(false);
    expect(kv.raw('job')).toBe(freshToken);
    expect(fresh?.held).toBe(true);
  });
});

// ─── Etcd3Kv：把 etcd3 builder API 翻译成原语 ────────────────────────────────

interface FakeLease {
  revoked: boolean;
  revoke(): Promise<void>;
}

class FakePutBuilder {
  private raw = '';
  private leaseRef: unknown;
  constructor(
    private readonly client: FakeEtcd3Client,
    private readonly key: string,
  ) {}
  value(v: string): this {
    this.raw = v;
    return this;
  }
  lease(l: unknown): this {
    this.leaseRef = l;
    return this;
  }
  async exec(): Promise<void> {
    this.client.applyPut(this.key, this.raw, this.leaseRef);
  }
}

class FakeDeleteBuilder {
  private keyName = '';
  constructor(private readonly client: FakeEtcd3Client) {}
  key(k: string): this {
    this.keyName = k;
    return this;
  }
  async exec(): Promise<{ deleted: number }> {
    return { deleted: this.client.applyDelete(this.keyName) ? 1 : 0 };
  }
}

class FakeTxnBuilder {
  private op?: { exec(): Promise<unknown> };
  constructor(
    private readonly client: FakeEtcd3Client,
    private readonly key: string,
    private readonly expected: number,
  ) {}
  then(next: { exec(): Promise<unknown> }): this {
    this.op = next;
    return this;
  }
  async commit(): Promise<{ succeeded: boolean }> {
    if (this.client.revisionOf(this.key) !== this.expected) return { succeeded: false };
    await this.op?.exec();
    return { succeeded: true };
  }
}

class FakeEtcd3Client {
  readonly entries = new Map<string, { value: string; mod: number; lease?: FakeLease }>();
  readonly leases = new Set<FakeLease>();
  readonly leaseCalls: Array<{ ttl: number; autoKeepAlive?: boolean }> = [];
  closed = false;
  private mod = 0;

  private bump(): number {
    this.mod += 1;
    return this.mod;
  }

  revisionOf(key: string): number {
    return this.entries.get(key)?.mod ?? 0;
  }

  applyPut(key: string, value: string, lease?: unknown): void {
    this.entries.set(key, { value, mod: this.bump(), lease: lease as FakeLease | undefined });
  }

  applyDelete(key: string, expected?: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (expected !== undefined && entry.mod !== expected) return false;
    this.entries.delete(key);
    return true;
  }

  get(key: string) {
    return {
      exec: async () => {
        const entry = this.entries.get(key);
        return {
          kvs: entry ? [{ value: Buffer.from(entry.value), version: entry.mod, mod_revision: entry.mod }] : [],
        };
      },
    };
  }

  put(key: string): FakePutBuilder {
    return new FakePutBuilder(this, key);
  }

  delete(): FakeDeleteBuilder {
    return new FakeDeleteBuilder(this);
  }

  if(key: string, _column: string, _cmp: string, expected: number): FakeTxnBuilder {
    return new FakeTxnBuilder(this, key, expected);
  }

  lease(ttlSeconds: number, options?: { autoKeepAlive?: boolean }): FakeLease {
    const lease: FakeLease = {
      revoked: false,
      revoke: async () => {
        lease.revoked = true;
        this.leases.delete(lease);
        for (const [key, entry] of this.entries) {
          if (entry.lease === lease) this.entries.delete(key);
        }
      },
    };
    this.leases.add(lease);
    this.leaseCalls.push({ ttl: ttlSeconds, ...options });
    return lease;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** 给测试用：FakeEtcd3Client 结构上满足 Etcd3Kv 的构造函数参数 */
function makeKv(client: FakeEtcd3Client): Etcd3Kv {
  return new Etcd3Kv(client);
}

describe('Etcd3Kv：etcd3 翻译层', () => {
  it('put/get 读回值，并把毫秒 TTL 换算成秒级租约（autoKeepAlive=false）', async () => {
    const client = new FakeEtcd3Client();
    const kv = makeKv(client);
    await kv.put('a', 'hello', 5_000);

    expect(await kv.get('a')).toEqual({ value: 'hello', version: 1 });
    expect(client.leaseCalls[0]).toEqual({ ttl: 5, autoKeepAlive: false });
    await kv.close();
  });

  it('compareAndSet：不存在时可创建，令牌不匹配时返回 null', async () => {
    const kv = makeKv(new FakeEtcd3Client());
    expect(await kv.compareAndSet('lock', 0, 'token-a', 30_000)).toBe(1);
    expect(await kv.compareAndSet('lock', 0, 'token-b', 30_000)).toBeNull();
    expect(await kv.get('lock')).toEqual({ value: 'token-a', version: 1 });
  });

  it('失败的 CAS 会回收它临时申请的租约（不泄漏 lease）', async () => {
    const client = new FakeEtcd3Client();
    const kv = makeKv(client);
    await kv.put('lock', 'held', 30_000);
    expect(client.leases.size).toBe(1);

    // revision 是 1，用 999 作前置条件必然失败
    expect(await kv.compareAndSet('lock', 999, 'other', 30_000)).toBeNull();
    // 临时申请的新租约被回收，只剩原来那个，且原值未被破坏
    expect(client.leases.size).toBe(1);
    expect(await kv.get('lock')).toEqual({ value: 'held', version: 1 });
  });

  it('删除使用 mod_revision：删除重建后旧令牌失效', async () => {
    const client = new FakeEtcd3Client();
    const kv = makeKv(client);
    await kv.put('k', 'v1');
    const first = (await kv.get('k'))?.version ?? 0;
    expect(first).toBe(1);
    expect(await kv.delete('k')).toBe(true);

    await kv.put('k', 'v2');
    const second = (await kv.get('k'))?.version ?? 0;
    expect(second).toBe(2); // 全局单调，不回退
    expect(await kv.delete('k', first)).toBe(false);
    expect(await kv.get('k')).toEqual({ value: 'v2', version: 2 });
    expect(await kv.delete('k', second)).toBe(true);
  });

  it('close 回收所有租约并关闭客户端', async () => {
    const client = new FakeEtcd3Client();
    const kv = makeKv(client);
    await kv.put('a', '1', 5_000);
    await kv.put('b', '2', 5_000);
    expect(client.leases.size).toBe(2);

    await kv.close();
    expect(client.leases.size).toBe(0);
    expect(client.closed).toBe(true);
  });
});
