import { ChatMessage } from '../backends/types';

// 心跳由 ws 库协议级 ping/pong 处理（device-gateway.ts），不再使用 JSON 层 ping/pong
// （修复 REV-005-9：移除永不触发的 JSON ping/pong，避免误导）
export type WsToClient =
  | { type: 'session.start'; sessionId: string; backend: 'claudecode' | 'pi'; model: string; history: ChatMessage[] }
  | { type: 'session.send';  sessionId: string; content: string }
  | { type: 'session.stop';  sessionId: string }
  | { type: 'refresh';       backend: 'claudecode' | 'pi' };

export type WsFromClient =
  | { type: 'session.event'; sessionId: string; event: import('./events').WebtoolEvent }
  | { type: 'models.report'; backend: 'claudecode' | 'pi'; models: { id: string; label: string; isDefault?: boolean }[] }
  | { type: 'device.hello';  name: string; hostname?: string; supportedBackends: ('claudecode' | 'pi')[] };