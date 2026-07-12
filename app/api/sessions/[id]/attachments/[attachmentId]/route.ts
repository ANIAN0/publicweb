// 下载会话附件（消息 file part 的 url 指向此端点）
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { readAttachmentMeta } from '@/lib/attachments/store';
import { mimeFromFilename } from '@/lib/mime';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id: sessionId, attachmentId } = await params;
  const db = await getDb();
  const [session] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const meta = await readAttachmentMeta(sessionId, attachmentId);
  if (!meta) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }

  // APP-016：共用 mimeFromFilename
  const mediaType = mimeFromFilename(meta.filename);
  return new NextResponse(new Uint8Array(meta.data), {
    status: 200,
    headers: {
      'Content-Type': mediaType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
