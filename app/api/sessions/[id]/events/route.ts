import { NextRequest } from 'next/server';
import { getBackendAdapter } from '@/lib/backends/router';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  // 读 ?since query(reload 续接)或 Last-Event-ID 头(EventSource 自动重连带),传给 onEvent 回放缓冲
  const sinceEventIdRaw = request.nextUrl.searchParams.get('since') ?? request.headers.get('Last-Event-ID');
  const sinceEventId = sinceEventIdRaw !== null && /^\d+$/.test(sinceEventIdRaw) ? Number(sinceEventIdRaw) : undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const adapter = getBackendAdapter(session.backend);
      const unsubscribe = adapter.onEvent(id, (event, eventId) => {
        // 发 id: 让前端 EventSource 自动重连带 Last-Event-ID;eventId 可能 undefined(LocalBackend 无缓冲)
        const idLine = eventId !== undefined ? `id: ${eventId}\n` : '';
        controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`));
      }, sinceEventId);

      // SSE 连接时触发 resume(reload 续接):追回崩溃窗口遗漏事件
      // resume 异步不阻塞 SSE 订阅;LocalBackend 无 resume 保持现状;失败记日志不污染 SSE
      adapter.resume?.(id, request.signal).catch((err) => {
        console.error(`[events] resume failed sid=${id}:`, err);
      });

      // 客户端断开时取消订阅
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}