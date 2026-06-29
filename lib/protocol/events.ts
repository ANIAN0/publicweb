export type WebtoolEvent =
  | { type: 'text.delta';        delta: string }
  | { type: 'tool.call';         id: string; name: string; input: unknown }
  | { type: 'tool.result';       id: string; output: string; isError?: boolean }
  | { type: 'reasoning.delta';   delta: string }
  | { type: 'turn.completed';    finishReason: 'stop' | 'interrupted' | 'error'; error?: { code: string; message: string } }
  | { type: 'session.connected' }
  | { type: 'session.disconnected'; reason: 'client_offline' | 'network' | 'restart' };