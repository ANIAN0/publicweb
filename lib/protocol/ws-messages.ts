// LIB-003：协议层只依赖 protocol/*，不从 backends 倒挂类型
// M-006 C-001：控制面帧与内容帧分离；内容走 UIMessageChunk 信封（含中心 runId）
import type { ChatMessage } from './messages';
import type {
  InputResponse,
  LegacyPartEvent,
  SessionLifecycleEvent,
  StreamContentEnvelope,
  WebtoolEvent,
} from './events';

/** 经 WS 下发的附件载荷（client 落本地盘后 agent 可读路径） */
export type WsAttachmentPayload = {
  id: string;
  filename: string;
  mediaType: string;
  /** 原始字节 base64（不带 data: 前缀） */
  dataBase64: string;
};

// ---------------------------------------------------------------------------
// 中心 → 执行端（控制面）
// ---------------------------------------------------------------------------

// 心跳由 ws 库协议级 ping/pong 处理（device-gateway.ts），不再使用 JSON 层 ping/pong
export type WsToClient =
  // session.start：启动/续接 session；backendSessionRef 透传 resume
  | {
      type: 'session.start';
      sessionId: string;
      backend: 'claudecode' | 'pi';
      model: string;
      history: ChatMessage[];
      backendSessionRef?: string;
      cwd?: string;
    }
  // session.send：用户消息 + 中心分配的本 turn runId（执行端后续 session.event 必须带回）
  | {
      type: 'session.send';
      sessionId: string;
      content: string;
      /** 中心分配；执行端不得改写或另造 */
      runId: string;
      attachments?: WsAttachmentPayload[];
    }
  // session.respondInput：HITL 独立通道
  | { type: 'session.respondInput'; sessionId: string; responses: InputResponse[] }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'refresh'; backend: 'claudecode' | 'pi' }
  // session.meta 落库完成回执
  | {
      type: 'session.meta.ack';
      sessionId: string;
      backendSessionRef: string;
      metaId?: string;
      ok: boolean;
      error?: string;
    };

// ---------------------------------------------------------------------------
// 执行端 → 中心
// ---------------------------------------------------------------------------

/**
 * session.event 内容载荷：
 * - 目标：StreamContentEnvelope（runId + chunk）
 * - 过渡：LegacyPartEvent / SessionLifecycleEvent / 扁平 WebtoolEvent
 */
export type SessionEventPayload =
  | StreamContentEnvelope
  | LegacyPartEvent
  | SessionLifecycleEvent
  | WebtoolEvent;

export type WsFromClient =
  // 内容帧：优先信封；过渡期 event 可为 legacy part.*
  | {
      type: 'session.event';
      sessionId: string;
      event: SessionEventPayload;
    }
  // session.meta：backend session 引用
  | {
      type: 'session.meta';
      sessionId: string;
      backendSessionRef: string;
      metaId?: string;
    }
  | {
      type: 'models.report';
      backend: 'claudecode' | 'pi';
      models: { id: string; label: string; isDefault?: boolean }[];
    }
  | {
      type: 'device.hello';
      name: string;
      hostname?: string;
      supportedBackends: ('claudecode' | 'pi')[];
    }
  | {
      type: 'device.heartbeat';
      sessionCount: number;
      uptimeMs: number;
      modelsCount?: number;
      lastError?: string | null;
    }
  | {
      type: 'device.error';
      code: string;
      message: string;
      category?: 'network' | 'backend' | 'protocol' | 'auth' | 'stall' | 'unknown';
      sessionId?: string;
      stack?: string;
      context?: Record<string, unknown>;
    };
