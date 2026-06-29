import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getBackendAdapter } from '@/lib/backends/router';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const since = request.nextUrl.searchParams.get('since');
  
  let query = db.select().from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.seq));
  
  if (since) {
    const sinceNum = parseInt(since, 10);
    query = db.select().from(messages)
      .where(and(eq(messages.sessionId, id), eq(messages.seq, sinceNum)))
      .orderBy(asc(messages.seq));
  }
  
  const msgs = await query;
  return NextResponse.json(msgs);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content } = body;
  
  if (!content) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }
  
  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  
  // 插入 user 消息
  const msgId = ulid();
  const now = new Date();
  const [lastMsg] = await db.select({ seq: messages.seq }).from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(desc(messages.seq))
    .limit(1);
  const nextSeq = lastMsg ? lastMsg.seq + 1 : 1;
  await db.insert(messages).values({
    id: msgId,
    sessionId: id,
    seq: nextSeq,
    role: 'user',
    content,
    createdAt: now,
  });
  
  // 通过 backend adapter 发送消息
  const adapter = getBackendAdapter(session.backend);
  adapter.send(id, content).catch(console.error);
  
  return NextResponse.json({ id: msgId, role: 'user', content }, { status: 201 });
}