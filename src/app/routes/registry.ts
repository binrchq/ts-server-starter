/**
 * 路由注册表。
 *
 * 除了「让路由可枚举」，它解决一个实际问题：多端口架构下
 * 「这个接口到底开在哪个端口、需要什么权限」很难靠读代码回答。
 * 注册表把答案结构化，既可自动生成 ROUTERS.md，也能挂到 admin 端口供线上自查。
 */
export type AccessLevel = 'public' | 'user' | 'admin' | 'internal';
export type RateLimitPolicy = 'global' | 'auth' | 'none' | `strict:${string}`;

export interface RouteRecord {
  layer: string;
  method: string;
  path: string;
  access: AccessLevel;
  rateLimit: RateLimitPolicy;
  description: string;
  hasValidation: boolean;
}

export class RouteRegistry {
  private readonly records: RouteRecord[] = [];

  add(record: RouteRecord): void {
    this.records.push(record);
  }

  list(layer?: string): RouteRecord[] {
    return layer ? this.records.filter((r) => r.layer === layer) : [...this.records];
  }

  toMarkdown(): string {
    const layers = [...new Set(this.records.map((r) => r.layer))];
    const lines: string[] = ['# Route Matrix', '', '> 由 `RouteRegistry.toMarkdown()` 生成，请勿手工维护。', ''];

    for (const layer of layers) {
      lines.push(`## ${layer}`, '', '| Method | Path | Access | Rate limit | Validation | Description |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const record of this.list(layer).sort((a, b) => a.path.localeCompare(b.path))) {
        lines.push(
          `| ${record.method.toUpperCase()} | \`${record.path}\` | ${record.access} | ${record.rateLimit} | ${
            record.hasValidation ? 'yes' : '-'
          } | ${record.description || '-'} |`,
        );
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
