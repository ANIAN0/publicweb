// 协议层历史消息形态（LIB-003 / LIB-016）
// ChatMessage 属 wire/history 契约，不放 backends/types，避免 protocol → backends 分层倒置。
// backends/types 与 client protocol 再 re-export 保持调用方路径稳定。

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
}

/** 会话 history 条目（session.start / 适配器 context） */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}
