/**
 * API Key 权限域。
 *
 * 用枚举而不是自由字符串：scope 拼错会让鉴权静默失效（少了检查），
 * 而 TS 的联合类型能在编译期拦住这类错误。
 * `*` 表示全权，仅限内部/管理用途。
 */
export const API_KEY_SCOPES = ['tasks:read', 'tasks:write', 'user:read', 'admin', '*'] as const;

export type ApiKeyScopes = (typeof API_KEY_SCOPES)[number];

export function isValidScope(value: string): value is ApiKeyScopes {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}
