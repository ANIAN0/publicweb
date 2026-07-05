import { getDb } from './client';
import { eveServices } from './schema';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';

// 默认云端 eve 服务种子:eve info() 需 auth 拉不到模型,这里预置部署者已知的默认模型。
// eve 默认 anthropic/claude-sonnet-5(见 eve/default-agent-model.ts)。
const DEFAULT_EVE_SERVICES = [
  { name: '云端 eve', host: 'https://hunian003-evework.hf.space', model: 'anthropic/claude-sonnet-5' },
];

/**
 * 幂等种子:eve_services 表为空时插入默认云端 eve 服务。
 * 管理服务(增删)由 /api/eve-services CRUD 负责,这里只保证首次启动有一个可用端点,
 * 让引导页能立即拉到 eveagent 的 target。
 */
export async function ensureSeed(): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ c: sql<number>`count(*)` }).from(eveServices);
  if (Number(row?.c ?? 0) > 0) return;  // 已有数据,跳过
  const now = new Date();
  for (const s of DEFAULT_EVE_SERVICES) {
    await db.insert(eveServices).values({
      id: ulid(),
      name: s.name,
      host: s.host,
      model: s.model,
      createdAt: now,
    });
  }
}
