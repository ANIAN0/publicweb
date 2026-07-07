import { ChatMessage } from '../backends/types';
import type { InputResponse } from './events';

// 心跳由 ws 库协议级 ping/pong 处理（device-gateway.ts），不再使用 JSON 层 ping/pong
// （修复 REV-005-9：移除永不触发的 JSON ping/pong，避免误导）
export type WsToClient =
  // session.start：启动/续接 session；backendSessionRef 透传给 client 走 resume（server 从 sessions.localSessionRef 读）
  | { type: 'session.start'; sessionId: string; backend: 'claudecode' | 'pi'; model: string; history: ChatMessage[]; backendSessionRef?: string }
  // session.send：发消息；inputResponses 用于回答 HITL（claude AskUserQuestion / pi extension_ui_request）
  | { type: 'session.send';  sessionId: string; content: string; inputResponses?: InputResponse[] }
  | { type: 'session.stop';  sessionId: string }
  | { type: 'refresh';       backend: 'claudecode' | 'pi' };

export type WsFromClient =
  | { type: 'session.event'; sessionId: string; event: import('./events').WebtoolEvent }
  // session.meta：client 上报 backend session 引用（claudecode sessionId / pi sessionFile），server 落库 sessions.localSessionRef 做 resume
  | { type: 'session.meta';  sessionId: string; backendSessionRef: string }
  | { type: 'models.report'; backend: 'claudecode' | 'pi'; models: { id: string; label: string; isDefault?: boolean }[] }
  | { type: 'device.hello';  name: string; hostname?: string; supportedBackends: ('claudecode' | 'pi')[] };