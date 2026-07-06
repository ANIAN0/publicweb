import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { eveServices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateAuth } from '@/lib/backends/eve-auth';

// PATCH /api/eve-services/[id] —— 更新 eve 服务(name/host/model/authType+authConfig 任一)
// auth 整体更新:传 authType 才动 auth(none 清空;bearer/headers 需配 authConfig);不传 authType 则保留原 auth
// auth 变更后,eveagent.getClient 下次调用会因 authKey 变化自动重建 Client(热生效,无需重启)
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const db = await getDb();
  const updates: Record<string, unknown> = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
  };
  // auth 整体更新(传 authType 才动):bearer/headers 需配 authConfig
  if (body.authType !== undefined) {
    const auth = validateAuth(body.authType, body.authConfig);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: 400 });
    }
    updates.authType = auth.authType;
    updates.authConfig = auth.authConfig;
  }
  await db.update(eveServices).set(updates).where(eq(eveServices.id, id));
  return NextResponse.json({ ok: true });
}

// DELETE /api/eve-services/[id] —— 删除 eve 服务
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();
  await db.delete(eveServices).where(eq(eveServices.id, id));
  return NextResponse.json({ ok: true });
}
