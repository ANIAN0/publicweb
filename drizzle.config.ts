import type { Config } from 'drizzle-kit';

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