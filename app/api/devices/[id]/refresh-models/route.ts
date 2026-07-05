import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { devices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { sendToDevice } from '@/server/ws/device-gateway';

/**
 * POST /api/devices/[id]/refresh-models
 * webtool 主动要求本地 client 重探测 claudecode / pi 模型清单（仍按既有协议上行 models.report）。
 * 设备不在线时返回 503，便于前端区分"指令已发送"与"设备离线"。
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();

  const [device] = await db.select({ id: devices.id, online: devices.online })
    .from(devices).where(eq(devices.id, id)).limit(1);
  if (!device) {
    return NextResponse.json({ error: 'device not found' }, { status: 404 });
  }

  const delivered = sendToDevice(id, { type: 'refresh' });
  if (!delivered) {
    return NextResponse.json({ error: 'device offline' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}