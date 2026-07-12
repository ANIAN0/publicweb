import type { Config } from 'drizzle-kit';

// WS-023 / WS-024：与 lib/db/client.ts 的 resolveDbPath 语义对齐
// - DATABASE_URL 默认同为 ./data/webtool.db（相对进程 cwd，即 webtool 包根）
// - 去掉 file: 前缀；drizzle-kit 的 out/schema 也相对包根，勿写绝对路径
// turso 的 connect(path) 期望原生文件路径，去掉 libSQL 的 'file:' 前缀
function resolveDbPath(): string {
  const url = process.env.DATABASE_URL || './data/webtool.db';
  return url.startsWith('file:') ? url.slice(5) : url;
}

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDbPath(),
  },
} satisfies Config;