import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { eveServices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateAuth } from '@/lib/backends/eve-auth';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { debugLog } from '@/lib/debug-log';

// APP-004：PATCH body Zod（字段均可选，至少一项会更新）
const patchBodySchema = z.object({
  name: z.string().optional(),
  host: z.string().optional(),
  model: z.string().optional(),
  authType: z.string().optional(),
  authConfig: z.unknown().optional(),
});

// PATCH /api/eve-services/[id]
// APP-013：不存在返回 404
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = await parseJsonBody(request, patchBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const db = await getDb();
  const [existing] = await db
    .select({ id: eveServices.id })
    .from(eveServices)
    .where(eq(eveServices.id, id))
    .limit(1);
  if (!existing) {
    debugLog('app', `eve-services PATCH 404 id=${id}`);
    return NextResponse.json({ error: 'Eve service not found' }, { status: 404 });
  }

  const updates: Record<string, unknown> = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
  };
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

// DELETE /api/eve-services/[id]
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();
  const [existing] = await db
    .select({ id: eveServices.id })
    .from(eveServices)
    .where(eq(eveServices.id, id))
    .limit(1);
  if (!existing) {
    debugLog('app', `eve-services DELETE 404 id=${id}`);
    return NextResponse.json({ error: 'Eve service not found' }, { status: 404 });
  }
  await db.delete(eveServices).where(eq(eveServices.id, id));
  return NextResponse.json({ ok: true });
}
