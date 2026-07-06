// 聊天消息长度限制(对齐 template lib/chat/limits.ts)
// MAX_CHAT_MESSAGE_CHARS:Unicode 码点上限(超长按钮变灰 + 错误提示,不静默截断)
export const MAX_CHAT_MESSAGE_CHARS = 8000;

// 按 Unicode 码点计数([...str].length,对齐 template getChatMessageLength)
// str.length 按 UTF-16 单元计数,emoji/罕见字符代理对会多算;[...str] 按 Unicode 码点计数准确
export function getChatMessageLength(str: string): number {
  return [...str].length;
}
