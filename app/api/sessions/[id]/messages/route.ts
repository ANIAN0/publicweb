import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, asc, desc, gt } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { isPendingStale } from '@/lib/backends/pending';
import type { MessageAttachmentRef } from '@/lib/backends/types';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  publicUrlFor,
  readAttachmentBuffer,
} from '@/lib/attachments/store';
import { debugLog } from '@/lib/debug-log';
import { z } from 'zod';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { beginTurnMaterialize } from '@/lib/backends/persist';
import { TurnBusyError, withTurnLock, releaseTurnLock } from '@/lib/backends/turn-lock';
import { mimeFromFilename } from '@/lib/mime';

// APP-004：messages POST body Zod 校验
const messagePostSchema = z.object({
  content: z.string().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1),
        filename: z.string().min(1),
        mediaType: z.string().optional(),
        size: z.number().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
}).refine(
  (b) => (typeof b.content === 'string' && b.content.trim().length > 0) || (b.attachments?.length ?? 0) > 0,
  { message: 'content or attachments required' },
);

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

  // 查 pendingUserMessage + stale 隐藏(C-006):stale 时返回 null 并同步清 db 过期 pending
  const [session] = await db.select({ pendingUserMessage: sessions.pendingUserMessage })
    .from(sessions).where(eq(sessions.id, id)).limit(1);
  let pendingUserMessage: string | null = session?.pendingUserMessage ?? null;
  if (pendingUserMessage) {
    const stale = await isPendingStale(id);
    if (stale) {
      pendingUserMessage = null;
      // 同步清 db 过期 pending(避免下次 GET 重复判断 + T-006 误触发 resume)
      await db.update(sessions).set({
        pendingUserMessage: null,
        pendingUserMessageCreatedAt: null,
      }).where(eq(sessions.id, id));
      await releaseTurnLock(id);
    }
  }

  // 返回结构从数组改为 {messages, pendingUserMessage}(T-007 前端适配)
  return NextResponse.json({ messages: msgs, pendingUserMessage });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = await parseJsonBody(request, messagePostSchema);
  if (!parsed.ok) return parsed.response;

  const text = typeof parsed.data.content === 'string' ? parsed.data.content : '';
  const attachments = parsed.data.attachments ?? [];

  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return NextResponse.json(
      { error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` },
      { status: 400 },
    );
  }

  // 校验附件已落盘，补全 url
  const resolved: MessageAttachmentRef[] = [];
  for (const a of attachments) {
    const buf = await readAttachmentBuffer(id, a.id);
    if (!buf) {
      return NextResponse.json({ error: `attachment not found: ${a.id}` }, { status: 400 });
    }
    resolved.push({
      id: a.id,
      // 文件元数据以服务端落盘结果为准，禁止客户端伪造 URL/MIME/size。
      filename: buf.filename,
      mediaType: mimeFromFilename(buf.filename),
      size: buf.data.byteLength,
      url: publicUrlFor(id, a.id),
    });
  }

  // APP-001：未删除 session 才允许发消息
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  const db = await getDb();

  // 组装 user parts：text + file（AI SDK FileUIPart 形态）
  const parts: Array<Record<string, unknown>> = [];
  if (text.trim()) {
    parts.push({ type: 'text', text });
  }
  for (const a of resolved) {
    parts.push({
      type: 'file',
      filename: a.filename,
      mediaType: a.mediaType,
      url: a.url,
    });
  }
  // 仅附件时仍保证有可读文本 part，方便历史列表标题
  if (!text.trim() && resolved.length > 0) {
    parts.unshift({
      type: 'text',
      text: resolved.map((a) => `[附件] ${a.filename}`).join('\n'),
    });
  }

  const displayContent =
    text.trim() ||
    (resolved.length > 0 ? resolved.map((a) => a.filename).join(', ') : '');

  // 数据库级 target 锁 + user 消息 + pending 在同一 BEGIN IMMEDIATE 事务内完成。
  const msgId = ulid();
  const runId = ulid();
  const now = new Date();
  try {
    await withTurnLock({
      backend: session.backend,
      targetId: session.targetId,
      sessionId: id,
      runId,
      acquiredAt: now,
    }, async (tx) => {
      const [last] = await tx.select({ seq: messages.seq }).from(messages)
        .where(eq(messages.sessionId, id))
        .orderBy(desc(messages.seq))
        .limit(1);
      const nextSeq = (last?.seq ?? 0) + 1;
      await tx.insert(messages).values({
        id: msgId,
        sessionId: id,
        seq: nextSeq,
        role: 'user',
        parts: JSON.stringify(parts),
        createdAt: now,
      });
      const updates: Record<string, unknown> = {
        lastActiveAt: now,
        pendingUserMessage: displayContent,
        pendingUserMessageCreatedAt: now,
      };
      if (session.title === null && session.userTitle === null) {
        updates.title = displayContent.length > 30 ? displayContent.slice(0, 30) : displayContent;
      }
      await tx.update(sessions).set(updates).where(eq(sessions.id, id));
      debugLog('app', `user message insert ok sid=${id} seq=${nextSeq} id=${msgId}`);
    });
  } catch (err) {
    if (err instanceof TurnBusyError) {
      return NextResponse.json({
        error: err.conflictingSessionId === id ? 'turn_in_progress' : 'target_busy',
        message: err.conflictingSessionId === id
          ? '当前会话已有进行中的回复，请等待完成或停止后再发送'
          : '该执行端已有其他会话的进行中 turn，请稍后再试',
        conflictingSessionId: err.conflictingSessionId,
      }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    debugLog('app', `user message insert failed sid=${id} err=${msg}`);
    return NextResponse.json(
      { error: 'failed to allocate message seq', detail: msg },
      { status: 500 },
    );
  }

  // 通过 backend adapter 发送（含附件引用）
  const adapter = getBackendAdapter(session.backend);
  // 新一轮物化：丢弃上一 turn 的 settled 快照，避免与迟到 chunk 交错
  beginTurnMaterialize(id, runId);
  // agent 侧 content：用户原文；仅附件时用简短占位，各 adapter 会再注入附件
  const agentContent = text.trim() || (resolved.length > 0 ? '请查看附件' : '');
  try {
    await adapter.send(id, agentContent, {
      ...(resolved.length ? { attachments: resolved } : {}),
      runId,
    });
  } catch (err) {
    await db.update(sessions).set({
      pendingUserMessage: null,
      pendingUserMessageCreatedAt: null,
    }).where(eq(sessions.id, id));
    await releaseTurnLock(id, runId);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'send_failed', detail }, { status: 503 });
  }

  return NextResponse.json(
    { id: msgId, role: 'user', content: displayContent, attachments: resolved },
    { status: 201 },
  );
}
