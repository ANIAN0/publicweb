import { ChatMessage } from '../backends/types';

export type WsToClient =
  | { type: 'session.start'; sessionId: string; backend: 'claudecode' | 'pi'; model: string; history: ChatMessage[] }
  | { type: 'session.send';  sessionId: string; content: string }
  | { type: 'session.stop';  sessionId: string }
  | { type: 'refresh';       backend: 'claudecode' | 'pi' }
  | { type: 'ping';          ts: number };

export type WsFromClient =
  | { type: 'session.event'; sessionId: string; event: import('./events').WebtoolEvent }
  | { type: 'models.report'; backend: 'claudecode' | 'pi'; models: { id: string; label: string; isDefault?: boolean }[] }
  | { type: 'device.hello';  name: string; hostname?: string; supportedBackends: ('claudecode' | 'pi')[] }
  | { type: 'pong';          ts: number };