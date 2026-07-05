import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, asc, desc, gt } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getBackendAdapter } from '@/lib/backends/router';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const since = request.nextUrl.searchParams.get('since');
  
  let query = db.select().from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.seq));
  
  if (since) {
    const sinceNum = parseInt(since, 10);
    // 增量语义：返回 seq 大于 since 的全部消息（修复 REV-005-3：原先 eq 只返回恰好等于的一条）
    query = db.select().from(messages)
      .where(and(eq(messages.sessionId, id), gt(messages.seq, sinceNum)))
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
  
  const db = await getDb();
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
    // user 消息存 parts 单元素(与 assistant 形态统一,见 05-schema-design.md 约束#3)
    parts: JSON.stringify([{ type: 'text', text: content }]),
    createdAt: now,
  });

  // 维护 session：首条 user 消息自动写入 title（仅当 title 与 userTitle 都为空），
  // 并把 lastActiveAt 推到 now，让历史列表排序反映最近活跃。
  const updates: Record<string, unknown> = { lastActiveAt: now };
  if (session.title === null && session.userTitle === null) {
    updates.title = content.length > 30 ? content.slice(0, 30) : content;
  }
  await db.update(sessions).set(updates).where(eq(sessions.id, id));
  
  // 通过 backend adapter 发送消息
  const adapter = getBackendAdapter(session.backend);
  adapter.send(id, content).catch(console.error);
  
  return NextResponse.json({ id: msgId, role: 'user', content }, { status: 201 });
}