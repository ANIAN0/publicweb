import { Client, MessageResponse } from 'eve/client';
import { BackendAdapter, ModelInfo, ChatMessage } from './types';
import { WebtoolEvent } from '../protocol/events';
import { EventBus } from './event-bus';
import { getDb } from '../db/client';
import { sessions, messages } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { ulid } from 'ulid';

const eventBus = new EventBus();

/**
 * EveagentBackend — bridges webtool sessions with an eve HTTP server.
 *
 * Deployed eve servers (e.g. https://hunian003-evework.hf.space) end a turn with
 * `session.completed`, which makes the eve client reset its local state. The next
 * user message therefore starts a fresh durable session on the server, so we pass
 * the webtool-side history as `clientContext` on every turn to keep the model
 * aware of the conversation. See docs/guides/client/continuations and
 * docs/concepts/sessions-runs-and-streaming in the eve repo.
 */
export class EveagentBackend implements BackendAdapter {
  readonly id = 'eveagent' as const;
  private clients = new Map<string, Client>();
  // Per-webtool-session serialization: queue sends so each turn's response is
  // fully consumed before the next send() goes out. The eve docs require this:
  // "send one follow-up at a time and wait for the next session.waiting event".
  private turnChain = new Map<string, Promise<void>>();

  async listModels(): Promise<ModelInfo[]> {
    // info() requires auth on the deployed eve server; fall back to a hard-coded
    // label so the chat UI can still render. Frontend hardcodes its own model
    // for now, so this path is rarely hit.
    return [{ id: 'eveagent-default', label: 'eve agent (remote)', isDefault: true }];
  }

  async startSession(opts: { sessionId: string; model: string; history: ChatMessage[]; deviceId?: string }): Promise<void> {
    // No eve-side setup needed: the per-turn send() creates a fresh eve session
    // and ships history via clientContext. We only verify the row exists.
    const { sessionId } = opts;
    const db = getDb();
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) throw new Error(`Session ${sessionId} not found`);
  }

  async send(sessionId: string, content: string): Promise<void> {
    const prev = this.turnChain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.runTurn(sessionId, content)).catch((err) => {
      console.error(`[eveagent] turn error sid=${sessionId}:`, err);
    });
    this.turnChain.set(sessionId, next);
    return next;
  }

  private async runTurn(sessionId: string, content: string): Promise<void> {
    const db = getDb();
    const history = await this.loadHistoryForContext(sessionId);

    const client = this.getClient();
    const clientSession = client.session();

    const clientContext = history.length > 0
      ? JSON.stringify(history.map((m) => ({ role: m.role, content: m.content })))
      : undefined;

    const response: MessageResponse = await clientSession.send({
      message: content,
      ...(clientContext ? { clientContext } : {}),
    });

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
    // (`session.waiting` / `session.completed` / `session.failed`) closes the
    // stream.
    for await (const event of response) {
      const webtoolEvent = this.mapEveEventToWebtoolEvent(event);
      if (!webtoolEvent) continue;
      eventBus.emit(sessionId, webtoolEvent);
      await this.persistEvent(sessionId, webtoolEvent);
    }
  }

  async stop(sessionId: string): Promise<void> {
    // No abort signal plumbing yet — eve's per-turn model means the in-flight
    // turn will end on its own; subsequent turns are blocked by the chain.
    void sessionId;
  }

  onEvent(sessionId: string, cb: (e: WebtoolEvent) => void): () => void {
    return eventBus.subscribe(sessionId, cb);
  }

  private getClient(): Client {
    const host = process.env.EVE_HOST || 'http://127.0.0.1:3000';
    let client = this.clients.get(host);
    if (!client) {
      client = new Client({ host });
      this.clients.set(host, client);
    }
    return client;
  }

  private async loadHistoryForContext(sessionId: string): Promise<ChatMessage[]> {
    const db = getDb();
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

  private async persistEvent(sessionId: string, event: WebtoolEvent): Promise<void> {
    const db = getDb();
    const [lastMsg] = await db.select({ seq: messages.seq }).from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.seq))
      .limit(1);
    const nextSeq = lastMsg ? lastMsg.seq + 1 : 1;

    if (event.type === 'text.delta') {
      // Append to the last assistant message; create a new row if needed.
      const [existing] = await db.select().from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant'), eq(messages.seq, nextSeq - 1)))
        .limit(1);
      if (existing) {
        await db.update(messages)
          .set({ content: existing.content + event.delta })
          .where(eq(messages.id, existing.id));
      } else {
        await db.insert(messages).values({
          id: ulid(),
          sessionId,
          seq: nextSeq,
          role: 'assistant',
          content: event.delta,
          createdAt: new Date(),
        });
      }
    } else if (event.type === 'turn.completed') {
      const [lastAssistant] = await db.select().from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
        .orderBy(desc(messages.seq))
        .limit(1);
      if (lastAssistant) {
        await db.update(messages)
          .set({ finishReason: event.finishReason })
          .where(eq(messages.id, lastAssistant.id));
      }
    }
  }
}
