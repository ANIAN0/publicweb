import { getDb } from './client';
import { eveServices } from './schema';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';

// 默认云端 eve 服务种子:eve info() 需 auth 拉不到模型,这里预置部署者已知的默认模型。
// eve 默认 anthropic/claude-sonnet-5(见 eve/default-agent-model.ts)。
// LIB-025：可用环境变量覆盖（部署/私有 eve 时不必改代码）
//   WEBTOOL_DEFAULT_EVE_HOST / WEBTOOL_DEFAULT_EVE_MODEL / WEBTOOL_DEFAULT_EVE_NAME
function defaultEveServices(): Array<{ name: string; host: string; model: string }> {
  return [
    {
      name: process.env.WEBTOOL_DEFAULT_EVE_NAME || '云端 eve',
      host: process.env.WEBTOOL_DEFAULT_EVE_HOST || 'https://hunian003-evework.hf.space',
      model: process.env.WEBTOOL_DEFAULT_EVE_MODEL || 'anthropic/claude-sonnet-5',
    },
  ];
}

/**
 * 幂等种子:eve_services 表为空时插入默认云端 eve 服务。
 * 管理服务(增删)由 /api/eve-services CRUD 负责,这里只保证首次启动有一个可用端点,
 * 让引导页能立即拉到 eveagent 的 target。
 *
 * LIB-026 调用顺序约定（instrumentation / server 启动）：
 *   1. getDb() / migrate 完成 schema
 *   2. ensureSeed() 仅在表空时插默认行（不覆盖用户数据）
 *   3. 业务路由 / WS gateway 才开始对外服务
 * 本函数自身不强制 migrate；调用方须保证 migrate 已成功。
 */
export async function ensureSeed(): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ c: sql<number>`count(*)` }).from(eveServices);
  if (Number(row?.c ?? 0) > 0) return;  // 已有数据,跳过
  const now = new Date();
  for (const s of defaultEveServices()) {
    await db.insert(eveServices).values({
      id: ulid(),
      name: s.name,
      host: s.host,
      model: s.model,
      createdAt: now,
    });
  }
}
