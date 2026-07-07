import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

// DELETE /api/devices/[id]：删除设备 + 关联数据（supportedBackends/models）
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();
  // 先删关联数据（外键关系）
  await db.delete(deviceSupportedBackends).where(eq(deviceSupportedBackends.deviceId, id));
  await db.delete(deviceModels).where(eq(deviceModels.deviceId, id));
  // 删设备
  const result = await db.delete(devices).where(eq(devices.id, id));
  return NextResponse.json({ ok: true });
}
