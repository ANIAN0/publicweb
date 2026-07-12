import { NextRequest, NextResponse } from 'next/server';
import { getBackendAdapter } from '@/lib/backends/router';
import { getActiveSession } from '@/lib/api/get-active-session';
import { debugLog } from '@/lib/debug-log';
import { generationStream } from '@/lib/events/generation-stream';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // APP-001 + APP-003：未删除 session；404 用 JSON
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 读 ?since query(reload 续接)或 Last-Event-ID 头(EventSource 自动重连带),传给 onEvent 回放缓冲
  const sinceEventIdRaw =
    request.nextUrl.searchParams.get('since') ??
    request.headers.get('Last-Event-ID');
  const sinceEventId =
    sinceEventIdRaw !== null && /^\d+$/.test(sinceEventIdRaw)
      ? Number(sinceEventIdRaw)
      : undefined;

  // T-002b：run 级 afterSeq 回放（展示续接）；与 session 级 since 并存
  const afterSeqRaw = request.nextUrl.searchParams.get('afterSeq');
  const afterSeq =
    afterSeqRaw !== null && /^\d+$/.test(afterSeqRaw) ? Number(afterSeqRaw) : undefined;
  const runIdParam = request.nextUrl.searchParams.get('runId') ?? undefined;
  const activeRunId = runIdParam ?? generationStream.getActiveRunId(id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // APP-014：SSE start 包 try/catch，adapter 抛错不击穿 stream
      try {
        const adapter = getBackendAdapter(session.backend);
        // APP-015：controller 已关闭后 enqueue 不再抛
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
          }
        };
        const safeClose = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        };

        const unsubs: Array<() => void> = [];

        // 有 runId 且带 afterSeq（或显式 runId）：先走 generation-stream 回放+实时
        // 载荷附带 runId/seq，前端 T-004 可记忆 lastSeq；旧客户端忽略多余字段仍可读 event
        if (activeRunId && afterSeq !== undefined) {
          const unsubGen = generationStream.subscribe(
            activeRunId,
            afterSeq,
            (item) => {
              const payload = {
                runId: item.runId,
                seq: item.seq,
                event: item.event,
                // 兼容：顶层仍展开 type 时前端旧 apply 读 data 整包会失败；
                // 故同时提供扁平 event 为主 data，seq/runId 作并列字段由 T-004 使用
                ...((item.event && typeof item.event === 'object'
                  ? item.event
                  : {}) as object),
                _runId: item.runId,
                _seq: item.seq,
              };
              safeEnqueue(
                encoder.encode(
                  `id: ${item.seq}\ndata: ${JSON.stringify(payload)}\n\n`,
                ),
              );
            },
          );
          unsubs.push(unsubGen);
        } else {
          // 默认路径：session 级 bus（含 since 回放）
          const unsubscribe = adapter.onEvent(
            id,
            (event, eventId) => {
              const runId = generationStream.getActiveRunId(id);
              const idLine = eventId !== undefined ? `id: ${eventId}\n` : '';
              const payload =
                runId != null
                  ? { ...((event && typeof event === 'object' ? event : {}) as object), _runId: runId, event }
                  : event;
              safeEnqueue(
                encoder.encode(`${idLine}data: ${JSON.stringify(payload)}\n\n`),
              );
            },
            sinceEventId,
          );
          unsubs.push(unsubscribe);
        }

        // SSE 连接时触发 resume(reload 续接):追回崩溃窗口遗漏事件
        adapter.resume?.(id, request.signal).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[events] resume failed sid=${id}:`, err);
          debugLog('app', `events resume failed sid=${id} err=${msg}`);
        });

        // 客户端断开时取消订阅
        request.signal.addEventListener('abort', () => {
          for (const u of unsubs) u();
          safeClose();
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog('app', `events SSE start failed sid=${id} err=${msg}`);
        console.error(`[events] SSE start failed sid=${id}:`, err);
        try {
          controller.error(err instanceof Error ? err : new Error(msg));
        } catch {
          /* controller 已结束 */
        }
      }
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
