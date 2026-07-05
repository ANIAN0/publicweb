import { Client, MessageResponse } from 'eve/client';
import { BackendAdapter, ChatMessage, ExecutionTarget } from './types';
import { WebtoolEvent, type WebtoolMessageMetadata, type InputResponse } from '../protocol/events';
import { EventBus } from './event-bus';
import { getDb } from '../db/client';
import { sessions, messages, eveServices } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { persistSessionEvent, extractTextFromParts } from './persist';
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

// 剥离 action,只保留前端 UI 可见的 inputRequest 字段(对齐 eve client toMessageInputRequest)
// 前端 InputRequestCard 据此渲染:prompt 问题文案 + display 三态 + options 选项 + allowFreeform 自定义文本
// 注意:options 用 mutable 数组(AI SDK toolMetadata 是 JSONValue,不接受 readonly JSONArray)
function toMessageInputRequest(request: any): {
  requestId: string;
  prompt: string;
  display?: 'confirmation' | 'select' | 'text';
  options?: { id: string; label: string; description?: string; style?: 'danger' | 'default' | 'primary' }[];
  allowFreeform?: boolean;
} {
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    ...(request.display !== undefined ? { display: request.display } : {}),
    ...(request.options !== undefined ? { options: request.options } : {}),
    ...(request.allowFreeform !== undefined ? { allowFreeform: request.allowFreeform } : {}),
  };
}

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
  // 当前 turn 状态:turnId 用于 partId 合成(${turnId}:${stepIndex}:type),startedParts 记录已 part.start 的 partId(避免重复 start),turnEnded 去重边界事件
  private turnState = new Map<string, { turnId: string | null; startedParts: Set<string>; turnEnded: boolean }>();

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

  // 探活:fetch /info,任何 HTTP 响应 = 在线,网络错误/超时 = 离线。
  // 超时 10s:云端 eve(hf.space)首次请求含 DNS+TLS 握手+冷启动,2s 易误判离线
  // (实测首次 ~2s+ 超时,热连接 ~1.8s)。probe 并发(Promise.all),10s 是总上限非 N×10s。
  private async probe(host: string): Promise<boolean> {
    try {
      await fetch(`${host}/info`, { signal: AbortSignal.timeout(10000) });
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

  async send(sessionId: string, content: string, opts?: { inputResponses?: InputResponse[] }): Promise<void> {
    // 取消上一次未结束的 controller（防御性，正常 UI 不会在跑时再点发送）
    const prev = this.turnChain.get(sessionId) ?? Promise.resolve();
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);
    // HITL 回答(inputResponses)透传到 runTurn → clientSession.send;eve 同 session 续接(durable)
    const inputResponses = opts?.inputResponses;

    // 拿 host:优先内存映射,缺失回退查 sessions.targetId → eve_services.host
    let host = this.sessionToHost.get(sessionId);
    if (!host) {
      host = await this.lookupHost(sessionId);
      if (host) this.sessionToHost.set(sessionId, host);
    }
    if (!host) throw new Error(`session ${sessionId} not bound to an eve service`);

    const next = prev.then(() => this.runTurn(sessionId, content, controller.signal, host!, inputResponses)).catch((err) => {
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

  private async runTurn(sessionId: string, content: string, signal: AbortSignal, host: string, inputResponses?: InputResponse[]): Promise<void> {
    const db = await getDb();
    const history = await this.loadHistoryForContext(sessionId);

    const client = this.getClient(host);

    // resume eve durable session:从 db 取上次 turn 持久化的 sessionId + continuationToken,
    // 喂给 client.session(state)。否则每次 client.session() 都新建会话,HITL 回答(inputResponses-only)
    // 无 continuationToken,createHandleMessageBody 命中 "continuationToken===undefined && message===undefined"
    // 返回 null,抛 "Session.send requires a non-empty message, inputResponses, or both"
    // (eve client/session.ts:345-355:inputResponses 必须配 continuationToken 才能构造 body)
    const [sessRow] = await db.select({
      eveSessionId: sessions.eveSessionId,
      eveContinuationToken: sessions.eveContinuationToken,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const sessionState = sessRow?.eveSessionId
      ? { sessionId: sessRow.eveSessionId, continuationToken: sessRow.eveContinuationToken ?? undefined, streamIndex: 0 }
      : undefined;
    if (sessionState) {
      eveLog(`resume sid=${sessionId} eveSessionId=${sessionState.sessionId} hasToken=${sessionState.continuationToken !== undefined} inputResponsesLen=${inputResponses?.length ?? 0}`);
    }
    const clientSession = client.session(sessionState);

    const clientContext = history.length > 0
      ? JSON.stringify(history.map((m) => ({ role: m.role, content: m.content })))
      : undefined;

    // [eve] 记录请求：host + content 预览 + history 条数 + clientContext 长度 + inputResponses 条数
    eveLog(`runTurn sid=${sessionId} host=${host} content=${JSON.stringify(content.slice(0, 50))} historyLen=${history.length} clientContextLen=${clientContext?.length ?? 0} inputResponsesLen=${inputResponses?.length ?? 0}`);

    // eve client send 允许只有 inputResponses 无 message(HITL 回答);content 为空时传 undefined
    // (session.ts 校验:message 或 inputResponses 至少一个非空)
    const response: MessageResponse = await clientSession.send({
      message: content || undefined,
      signal,
      ...(inputResponses?.length ? { inputResponses } : {}),
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
        // event 是 HandleMessageStreamEvent 联合,部分成员(如 SessionCompletedStreamEvent)无 data,用 narrowing
        const eventData = 'data' in event ? (event as { data?: Record<string, unknown> }).data : undefined;
        const dataKeys = eventData ? Object.keys(eventData).join(',') : '-';
        eveLog(`event sid=${sessionId} type=${event?.type} dataKeys=${dataKeys}`);
        // 一个 eve 事件可能映射出多个 WebtoolEvent(actions.requested 遍历、message.appended 先 start 再 delta)
        const webtoolEvents = this.mapEveEventToWebtoolEvent(event, sessionId);
        if (webtoolEvents.length === 0) {
          // [eve] 未映射的事件（system/status 等），记录后跳过
          eveLog(`event unmapped sid=${sessionId} type=${event?.type} -> skip`);
          continue;
        }
        for (const we of webtoolEvents) {
          eveLog(`event mapped sid=${sessionId} eveType=${event?.type} -> webtoolType=${we.type}`);
          eventBus.emit(sessionId, we);
          await persistSessionEvent(sessionId, we);
        }
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
    if (!lastAssistant) return;
    // finishReason 现存于 metadata JSON 列(非旧 finishReason 列)
    let meta: Record<string, unknown> = {};
    try { meta = lastAssistant.metadata ? JSON.parse(lastAssistant.metadata) : {}; } catch { /* 损坏元数据当空 */ }
    if (meta.finishReason === undefined) {
      meta.finishReason = 'interrupted';
      await db.update(messages)
        .set({ metadata: JSON.stringify(meta) })
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
    // 新 schema 无 content 列,从 parts 提取 text(降级点 #2:eve clientContext 仅需文本;完整 parts 传递见 05 后续 adapter 改造)
    const rows = await db.select({ role: messages.role, parts: messages.parts })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq));
    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: extractTextFromParts(r.parts) }))
      .filter((r) => r.content);
  }

  // eve 事件 → WebtoolEvent[](按 04-adapter-mapping.md eve 表 + 06 partId 规则)
  // 一个 eve 事件可能产多个 WebtoolEvent(actions.requested 遍历、message.appended 先 start 再 delta)
  private mapEveEventToWebtoolEvent(eveEvent: any, sessionId: string): WebtoolEvent[] {
    const st = this.turnState.get(sessionId) ?? { turnId: null as string | null, startedParts: new Set<string>(), turnEnded: false };
    this.turnState.set(sessionId, st);
    const out: WebtoolEvent[] = [];
    const t = eveEvent?.type;
    const d = eveEvent?.data ?? {};

    // turn.started:记录 turnId,重置 turnEnded + startedParts(新 turn 重新分配 partId)
    if (t === 'turn.started') {
      st.turnId = d.turnId ?? null;
      st.turnEnded = false;
      st.startedParts.clear();
      return out;
    }

    // message.appended:text 增量;首次先 part.start(streaming),后续 part.delta
    if (t === 'message.appended') {
      const delta = d.messageDelta ?? d.delta;
      if (!delta) return out;
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:text`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'text', text: '', state: 'streaming' } });
        st.startedParts.add(partId);
      }
      out.push({ type: 'part.delta', partId, field: 'text', delta });
      return out;
    }

    // message.completed:text part 结束(带最终 message 校正)
    if (t === 'message.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:text`;
      out.push({ type: 'part.end', partId, part: { type: 'text', text: d.message ?? '', state: 'done' } });
      return out;
    }

    // reasoning.appended:reasoning 增量
    if (t === 'reasoning.appended') {
      const delta = d.reasoningDelta ?? d.delta;
      if (!delta) return out;
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:reasoning`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'reasoning', text: '', state: 'streaming' } });
        st.startedParts.add(partId);
      }
      out.push({ type: 'part.delta', partId, field: 'reasoning', delta });
      return out;
    }

    // reasoning.completed:reasoning part 结束
    if (t === 'reasoning.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:reasoning`;
      out.push({ type: 'part.end', partId, part: { type: 'reasoning', text: d.reasoning ?? '', state: 'done' } });
      return out;
    }

    // actions.requested:遍历整个 actions[](修原只取 [0] 的 bug);eve input 一次性给全 → state=input-available
    if (t === 'actions.requested' && Array.isArray(d.actions)) {
      for (const call of d.actions) {
        if (!call?.callId) continue;
        const partId = call.callId;
        out.push({
          type: 'part.start', partId,
          part: {
            type: 'dynamic-tool',
            toolName: call.toolName ?? call.name ?? 'unknown',
            toolCallId: call.callId,
            state: 'input-available',
            input: call.input ?? {},
          },
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // input.requested:HITL 问题(eve ask_question 或带 approval 的工具)。每个 request → dynamic-tool part
    // state=approval-requested,inputRequest 挂 toolMetadata.eve.inputRequest(前端按 display 渲染卡片)
    // requestId(=action.callId)作 partId,与后续 action.result 的 callId 一致,part.update 能定位
    // 对齐 eve client message-reducer.ts:147-169 的投影
    if (t === 'input.requested' && Array.isArray(d.requests)) {
      for (const request of d.requests) {
        if (!request?.requestId) continue;
        const partId = request.requestId;
        const action = request.action ?? {};
        out.push({
          type: 'part.start', partId,
          part: {
            type: 'dynamic-tool',
            toolName: action.toolName ?? 'ask_question',
            toolCallId: action.callId ?? request.requestId,
            state: 'approval-requested',
            input: action.input ?? {},
            // approval.id=requestId:对齐 eve client,使 ai-elements Confirmation 也可关联
            approval: { id: request.requestId },
            toolMetadata: {
              eve: {
                inputRequest: toMessageInputRequest(request),
                kind: action.kind ?? 'tool-call',
                name: action.toolName ?? 'ask_question',
              },
            },
          },
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // action.result:更新 tool part state + output(completed→output-available / failed→output-error / rejected→output-denied)
    if (t === 'action.result') {
      const r = d.result ?? {};
      const partId = r.callId;
      if (!partId) return out;
      const status = d.status;
      const patch: Record<string, unknown> = {
        state: status === 'failed' ? 'output-error' : status === 'rejected' ? 'output-denied' : 'output-available',
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? ''),
      };
      if (status === 'failed') patch.errorText = r.output ?? '';
      out.push({ type: 'part.update', partId, patch });
      return out;
    }

    // step.completed:token/成本(usage 嵌套在 d.usage:costUsd/inputTokens/outputTokens/cacheReadTokens)。
    // 不写 finishReason 到 metadata——那是 turn 级边界标志(只由 turn.completed 写),
    // 否则 tool-loop 中间 step 的 finishReason='tool-calls' 会让 persist.getOrCreateCurrentAssistant
    // 误判 turn 已结束,把同一 turn 的后续 step 拆到新 assistant 消息(破坏一 turn 一 assistant 语义)。
    if (t === 'step.completed') {
      const meta: Partial<WebtoolMessageMetadata> = {};
      if (d.usage) {
        meta.usage = {
          inputTokens: d.usage.inputTokens,
          outputTokens: d.usage.outputTokens,
          // eve 字段名是 cacheReadTokens,映射到 WebtoolMessageMetadata.usage.cachedInputTokens
          cachedInputTokens: d.usage.cacheReadTokens,
        };
        // cost 也在 d.usage 里(非顶层 d.costUsd)
        if (d.usage.costUsd != null) meta.cost = d.usage.costUsd;
      }
      if (Object.keys(meta).length > 0) out.push({ type: 'message.metadata', metadata: meta });
      return out;
    }

    // session.started:提取 modelId(runtime identity)
    if (t === 'session.started') {
      if (d.runtime?.modelId) out.push({ type: 'message.metadata', metadata: { modelId: d.runtime.modelId } });
      return out;
    }

    // 边界事件:turn.completed/failed/session.waiting/completed/failed(去重,首个边界发 turn.completed)
    const isBoundary = t === 'turn.completed' || t === 'turn.failed' || t === 'session.waiting' || t === 'session.completed' || t === 'session.failed';
    if (isBoundary) {
      if (!st.turnEnded) {
        if (t === 'turn.failed' || t === 'session.failed') {
          out.push({ type: 'turn.completed', finishReason: 'error', error: { code: t, message: d.message ?? t } });
        } else {
          out.push({ type: 'turn.completed', finishReason: 'stop' });
        }
        st.turnEnded = true;
      }
      // session.failed 表示会话死亡,追加 disconnected
      if (t === 'session.failed') {
        out.push({ type: 'session.disconnected', reason: 'restart' });
      }
      return out;
    }

    return out; // 其他事件(step.started/message.received/compaction.*/subagent.*/authorization.*/result.completed)暂未映射
  }
}
