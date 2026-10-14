/**
 * 集成测试用的 HTTP 夹具。
 *
 * 用 listen(0) 拿系统分配的临时端口，而不是写死 4600/4601 ——
 * 写死端口意味着本机开着 dev server 时测试就红，这类「环境相关失败」
 * 会迅速培养出「重跑一次就好了」的坏习惯。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { WiredApplication } from '../../src/serve/wire.js';

export interface RunningChannel {
  layer: string;
  baseUrl: string;
  close(): Promise<void>;
}

export function resolveAddress(server: Server): { port: number; host: string } {
  const address = server.address() as AddressInfo;
  return { port: address.port, host: '127.0.0.1' };
}

export async function startChannel(app: Express): Promise<RunningChannel> {
  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });
  const { port, host } = resolveAddress(server);
  return {
    layer: 'test',
    baseUrl: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 为 wired 应用里的每个 layer 各起一个临时端口 */
export async function startLayers(wired: WiredApplication): Promise<Record<string, RunningChannel>> {
  const started: Record<string, RunningChannel> = {};
  for (const channel of wired.channels) {
    const app = wired.httpService.createApp(channel);
    const running = await startChannel(app);
    started[channel.layer] = { ...running, layer: channel.layer };
  }
  return started;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export async function request<T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0 && (response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed as T };
}

export const JSON_HEADERS = { 'content-type': 'application/json' };

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
