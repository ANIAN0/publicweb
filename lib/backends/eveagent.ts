import { Client, MessageResponse } from 'eve/client';
import { BackendAdapter, ChatMessage, ExecutionTarget } from './types';
import { WebtoolEvent } from '../protocol/events';
import { EventBus } from './event-bus';
import { getDb } from '../db/client';
import { sessions, messages, eveServices } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { persistSessionEvent } from './persist';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// [eve] 调试日志：追加到 workplace/logs/eve-YYYYMMDD.log（AGENTS.md 第 13 条调试策略）
// 同步追加写，日志失败静默吞掉，不影响主流程
function eveLog(msg: string): void {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  try {
    const dir = join(process.cwd(), '..', 'workplace', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `eve-${day}.log`), `${ts} [eve] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

const eventBus = new EventBus();

/**
 * EveagentBackend — bridges webtool sessions with eve HTTP servers.
 *
 * 一个 eve 部署 = 一个 root agent = 一个 model(部署时 agent.ts 写死),
 * 所以每个 eve 服务(target)绑死一个模型,客户端不能选模型——选模型 = 选 eve 服务。
 * 多个 eve 服务(不同部署/不同模型)通过 eve_services 表管理,listTargets 从表读。
 */
export class EveagentBackend implements BackendAdapter {
  readonly id = 'eveagent' as const;
  readonly label = 'Eveagent';
  readonly description = '远程云端 agent';

  private clients = new Map<string, Client>();           // host → Client(已按 host 缓存,支持多服务)
  private sessionToHost = new Map<string, string>();     // sessionId → host(startSession 记,send 取)
  // Per-webtool-session serialization: queue sends so each turn's response is
  // fully consumed before the next send() goes out. The eve docs require this:
  // "send one follow-up at a time and wait for the next session.waiting event".
  private turnChain = new Map<string, Promise<void>>();
  // Per-session AbortController：send 时建一个，stop 时 abort()，runTurn 结束后清理
  private abortControllers = new Map<string, AbortController>();

  async listTargets(): Promise<ExecutionTarget[]> {
    const db = await getDb();
    const rows = await db.select().from(eveServices);
    // 并发探活每个服务:任何 HTTP 响应都算在线(服务在响应,即使需 auth),
    // 只有网络错误/超时才算离线
    const targets = await Promise.all(rows.map(async (svc) => {
      const online = await this.probe(svc.host);
      return {
        id: svc.id,
        name: svc.name,
        online,
        // 一个 eve 服务绑死一个模型(部署时写死),models 单元素
        models: [{ id: svc.model, label: svc.model, isDefault: true }],
        meta: { host: svc.host },
      } as ExecutionTarget;
    }));
    return targets;
  }

  // 探活:fetch /info,任何 HTTP 响应 = 在线,网络错误/超时 = 离线
  private async probe(host: string): Promise<boolean> {
    try {
      await fetch(`${host}/info`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  async startSession(opts: { sessionId: string; model: string; targetId: string; history: ChatMessage[] }): Promise<void> {
    // targetId = eve_service.id,查 host 记映射。
    // model 由服务端绑定(eve 不接受 client 传 model),这里仅由调用方记录到 sessions.model(展示用)。
    const { sessionId, targetId } = opts;
    const db = await getDb();
    const [svc] = await db.select().from(eveServices).where(eq(eveServices.id, targetId)).limit(1);
    if (!svc) throw new Error(`eve service not found: ${targetId}`);
    this.sessionToHost.set(sessionId, svc.host);
    // 校验 session 行存在(原逻辑)
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) throw new Error(`Session ${sessionId} not found`);
  }

  async send(sessionId: string, content: string): Promise<void> {
    // 取消上一次未结束的 controller（防御性，正常 UI 不会在跑时再点发送）
    const prev = this.turnChain.get(sessionId) ?? Promise.resolve();
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    // 拿 host:优先内存映射,缺失回退查 sessions.targetId → eve_services.host
    let host = this.sessionToHost.get(sessionId);
    if (!host) {
      host = await this.lookupHost(sessionId);
      if (host) this.sessionToHost.set(sessionId, host);
    }
    if (!host) throw new Error(`session ${sessionId} not bound to an eve service`);

    const next = prev.then(() => this.runTurn(sessionId, content, controller.signal, host!)).catch((err) => {
      // abort 抛 AbortError 是预期路径，不打 ERROR 噪音
      if (err?.name !== 'AbortError') {
        console.error(`[eveagent] turn error sid=${sessionId}:`, err);
      }
    }).finally(() => {
      // 收尾：仅当仍是同一个 controller 时清理（防止 stop 后 send 又覆盖）
      if (this.abortControllers.get(sessionId) === controller) {
        this.abortControllers.delete(sessionId);
      }
    });
    this.turnChain.set(sessionId, next);
    return next;
  }

  // 回退查 host:session.targetId → eve_services.host
  private async lookupHost(sessionId: string): Promise<string | undefined> {
    const db = await getDb();
    const [sess] = await db.select({ targetId: sessions.targetId })
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!sess?.targetId) return undefined;
    const [svc] = await db.select({ host: eveServices.host })
      .from(eveServices).where(eq(eveServices.id, sess.targetId)).limit(1);
    return svc?.host ?? undefined;
  }

  private async runTurn(sessionId: string, content: string, signal: AbortSignal, host: string): Promise<void> {
    const db = await getDb();
    const history = await this.loadHistoryForContext(sessionId);

    const client = this.getClient(host);
    const clientSession = client.session();

    const clientContext = history.length > 0
      ? JSON.stringify(history.map((m) => ({ role: m.role, content: m.content })))
      : undefined;

    // [eve] 记录请求：host + content 预览 + history 条数 + clientContext 长度
    eveLog(`runTurn sid=${sessionId} host=${host} content=${JSON.stringify(content.slice(0, 50))} historyLen=${history.length} clientContextLen=${clientContext?.length ?? 0}`);

    const response: MessageResponse = await clientSession.send({
      message: content,
      signal,
      ...(clientContext ? { clientContext } : {}),
    });

    // [eve] 记录 eve 返回的 session 标识（用于诊断 resume / continuation）
    eveLog(`response sid=${sessionId} eveSessionId=${response.sessionId ?? '-'} continuationToken=${response.continuationToken ?? '-'}`);

    // Persist the latest eve identifiers for diagnostics / future resume work.
    if (response.sessionId) {
      await db.update(sessions)
        .set({
          eveSessionId: response.sessionId,
          eveContinuationToken: response.continuationToken ?? null,
        })
        .where(eq(sessions.id, sessionId));
    }

    // Single-use MessageResponse: iterate to consume the NDJSON stream and
    // advance the client cursor. The loop exits when the turn boundary event
    // closes the stream, OR when the signal aborts.
    try {
      for await (const event of response) {
        if (signal.aborted) break;
        // [eve] 记录每个流式事件的 type + data 顶层字段名（截断防刷屏）
        const dataKeys = event?.data ? Object.keys(event.data).join(',') : '-';
        eveLog(`event sid=${sessionId} type=${event?.type} dataKeys=${dataKeys}`);
        const webtoolEvent = this.mapEveEventToWebtoolEvent(event);
        if (!webtoolEvent) {
          // [eve] 未映射的事件（system/status 等），记录后跳过
          eveLog(`event unmapped sid=${sessionId} type=${event?.type} -> skip`);
          continue;
        }
        eveLog(`event mapped sid=${sessionId} eveType=${event?.type} -> webtoolType=${webtoolEvent.type}`);
        eventBus.emit(sessionId, webtoolEvent);
        // 修复 REV-005-15：走共享 persist 模块，确保 reasoning/tool.call/tool.result 都落库
        await persistSessionEvent(sessionId, webtoolEvent);
      }
      // [eve] 流正常结束
      eveLog(`stream end sid=${sessionId} aborted=${signal.aborted}`);
    } catch (err: any) {
      // [eve] 记录异常：名字 + 消息，判断是 abort 还是真错误
      eveLog(`error sid=${sessionId} name=${err?.name} msg=${err?.message} aborted=${signal.aborted}`);
      // signal 触发 abort 时，eve client 可能抛出 AbortError；视为正常停止
      if (err?.name !== 'AbortError' && !signal.aborted) throw err;
    }

    // 主动停止：写最后一条 assistant 消息的 finishReason='interrupted'，
    // 并发 turn.completed（finishReason='interrupted'）让前端解开 isSending
    if (signal.aborted) {
      await this.markInterrupted(sessionId);
      eventBus.emit(sessionId, { type: 'turn.completed', finishReason: 'interrupted' });
      await persistSessionEvent(sessionId, { type: 'turn.completed', finishReason: 'interrupted' });
    }
  }

  // 把 session 当前最后一条 assistant 消息标记为 interrupted finishReason
  private async markInterrupted(sessionId: string): Promise<void> {
    const db = await getDb();
    const [lastAssistant] = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);
    if (lastAssistant && lastAssistant.finishReason === null) {
      await db.update(messages)
        .set({ finishReason: 'interrupted' })
        .where(eq(messages.id, lastAssistant.id));
    }
  }

  async stop(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return;
    controller.abort();
    // 清理工作交给 send 的 .finally 收尾；这里不立即 delete 以避免竞态
  }

  onEvent(sessionId: string, cb: (e: WebtoolEvent) => void): () => void {
    return eventBus.subscribe(sessionId, cb);
  }

  private getClient(host: string): Client {
    let client = this.clients.get(host);
    if (!client) {
      client = new Client({ host });
      this.clients.set(host, client);
    }
    return client;
  }

  private async loadHistoryForContext(sessionId: string): Promise<ChatMessage[]> {
    const db = await getDb();
    const rows = await db.select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq));
    return rows
      .filter((r) => r.content && (r.role === 'user' || r.role === 'assistant'))
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  private mapEveEventToWebtoolEvent(eveEvent: any): WebtoolEvent | null {
    // Per docs/concepts/sessions-runs-and-streaming: streaming deltas carry
    // both `*Delta` and `*SoFar` cumulative fields. We only need the delta.
    if (eveEvent.type === 'message.appended') {
      const delta = eveEvent.data?.messageDelta ?? eveEvent.data?.delta;
      if (delta) return { type: 'text.delta', delta };
    }
    if (eveEvent.type === 'actions.requested' && Array.isArray(eveEvent.data?.actions)) {
      const call = eveEvent.data.actions[0];
      if (call) return { type: 'tool.call', id: call.callId, name: call.toolName, input: call.input };
    }
    if (eveEvent.type === 'action.result') {
      const r = eveEvent.data?.result ?? {};
      const output = typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? '');
      return {
        type: 'tool.result',
        id: r.callId,
        output,
        isError: eveEvent.data?.status === 'failed' || r.isError === true,
      };
    }
    if (eveEvent.type === 'reasoning.appended') {
      const delta = eveEvent.data?.reasoningDelta ?? eveEvent.data?.delta;
      if (delta) return { type: 'reasoning.delta', delta };
    }
    if (eveEvent.type === 'turn.completed') {
      return { type: 'turn.completed', finishReason: eveEvent.data?.finishReason || 'stop' };
    }
    if (eveEvent.type === 'turn.failed' || eveEvent.type === 'step.failed') {
      return { type: 'turn.completed', finishReason: 'error' };
    }
    return null;
  }
}
