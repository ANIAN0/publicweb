// 会话附件上传：multipart 字段 file → data/attachments/{sessionId}/{id}/
// 返回 id/filename/mediaType/size/url，供 messages POST 引用
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  MAX_ATTACHMENT_BYTES,
  saveAttachment,
} from '@/lib/attachments/store';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  const db = await getDb();
  const [session] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'file field required' }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `file too large (max ${MAX_ATTACHMENT_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const stored = await saveAttachment({
      sessionId,
      filename: file.name || 'file',
      mediaType: file.type || 'application/octet-stream',
      data: buf,
    });
    return NextResponse.json(
      {
        id: stored.id,
        filename: stored.filename,
        mediaType: stored.mediaType,
        size: stored.size,
        url: stored.url,
      },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
