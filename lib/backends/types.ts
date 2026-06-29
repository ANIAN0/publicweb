import { WebtoolEvent } from '../protocol/events';

export interface ModelInfo { id: string; label: string; isDefault?: boolean }
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolResults?: ToolResult[] }

export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { toolCallId: string; output: string; isError?: boolean }

export interface BackendAdapter {
  readonly id: 'eveagent' | 'claudecode' | 'pi';
  /** 列出可用模型；eveagent 来自 eve /info，local 走 LocalBackend 间接从本地 client 缓存读 */
  listModels(deviceId?: string): Promise<ModelInfo[]>;
  /** 创建或续接一个 session handle；后端内部持有状态 */
  startSession(opts: { sessionId: string; model: string; history: ChatMessage[]; deviceId?: string }): Promise<void>;
  /** 发送一条用户消息（不等待响应） */
  send(sessionId: string, content: string): Promise<void>;
  /** 主动停止当前 turn（不 kill agent 进程） */
  stop(sessionId: string): Promise<void>;
  /** 订阅一个 session 的事件 */
  onEvent(sessionId: string, cb: (e: WebtoolEvent) => void): () => void;
}