// POST /api/sessions/bulk-delete：批量软删会话
// body: { ids: string[] }；逐项容错，不整批 rollback
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { softDeleteSession } from '@/lib/api/soft-delete-session';

const bodySchema = z
  .object({
    // 上限防止误传超大数组拖垮服务；开发清理场景足够
    ids: z.array(z.string().min(1)).min(1).max(500),
  })
  .strict();

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', details: parsed.error.issues },
      { status: 400 },
    );
  }

  // 去重：同一 id 多次只处理一次
  const ids = [...new Set(parsed.data.ids)];
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const id of ids) {
    try {
      const result = await softDeleteSession(id);
      if (result === 'deleted') deleted.push(id);
      else skipped.push(id);
    } catch {
      // 单条异常不阻断整批
      skipped.push(id);
    }
  }

  return NextResponse.json({ deleted, skipped });
}
