import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { deviceModels, devices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { ModelInfo } from '@/lib/backends/types';

/**
 * GET /api/devices/[id]/models
 * 返回该设备探测并上行缓存的模型清单（含每行 refreshed_at）。
 * 数据来自本地 client 上行 models.report → webtool device_models 表。
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();

  // 校验设备存在；404 而不是返回空数组，避免调用方误判
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, id)).limit(1);
  if (!device) {
    return NextResponse.json({ error: 'device not found' }, { status: 404 });
  }

  const rows = await db.select().from(deviceModels).where(eq(deviceModels.deviceId, id));

  const result = rows.map(row => {
    let models: ModelInfo[] = [];
    try {
      models = JSON.parse(row.modelsJson);
    } catch {
      models = [];
    }
    return {
      backend: row.backend,
      models,
      refreshedAt: row.refreshedAt,
    };
  });

  return NextResponse.json(result);
}