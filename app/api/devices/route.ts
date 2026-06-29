import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const db = getDb();
  const allDevices = await db.select().from(devices);
  
  // 获取每个设备的 supported backends
  const result = await Promise.all(allDevices.map(async (device) => {
    const backends = await db.select().from(deviceSupportedBackends)
      .where(eq(deviceSupportedBackends.deviceId, device.id));
    return {
      id: device.id,
      name: device.name,
      hostname: device.hostname,
      online: device.online,
      lastSeenAt: device.lastSeenAt,
      supportedBackends: backends.map(b => b.backend),
    };
  }));
  
  return NextResponse.json(result);
}