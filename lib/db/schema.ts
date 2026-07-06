import { sqliteTable, text, integer, primaryKey, unique } from 'drizzle-orm/sqlite-core';

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),                                  // ulid
  name: text('name').notNull(),
  hostname: text('hostname'),                                  // 本地 client 上报
  longLivedTokenHash: text('long_lived_token_hash').notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  online: integer('online', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const deviceSupportedBackends = sqliteTable('device_supported_backends', {
  deviceId: text('device_id').notNull().references(() => devices.id),
  backend: text('backend').notNull(),                          // 'claudecode' | 'pi'
}, t => ({ pk: primaryKey({ columns: [t.deviceId, t.backend] }) }));

export const deviceModels = sqliteTable('device_models', {
  deviceId: text('device_id').notNull().references(() => devices.id),
  backend: text('backend').notNull(),
  modelsJson: text('models_json').notNull(),                   // JSON: [{id, label, default?}]
  refreshedAt: integer('refreshed_at', { mode: 'timestamp' }).notNull(),
}, t => ({ pk: primaryKey({ columns: [t.deviceId, t.backend] }) }));

export const setupTokens = sqliteTable('setup_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),                      // 一次性 token 的 SHA256
  deviceName: text('device_name').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// eve 服务端点(与 devices 对称):eveagent 后端的执行端点。
// 一个 eve 部署 = 一个 root agent = 一个 model(部署时 agent.ts 写死),
// 所以 model 列存该服务绑定的模型。eve info() 需 auth 拉不到,由部署者添加服务时填。
export const eveServices = sqliteTable('eve_services', {
  id: text('id').primaryKey(),                                  // ulid
  name: text('name').notNull(),                                 // 展示名 "云端 eve"
  host: text('host').notNull(),                                 // https://hunian003-evework.hf.space
  model: text('model').notNull(),                               // 该服务绑定的模型(部署者填)
  // auth 形态:none=无认证 / bearer=Authorization: Bearer <token> / headers=自定义请求头
  // 一个 eve 服务一套 auth,选模型=选服务时连带选 auth
  authType: text('auth_type').notNull().default('none'),        // 'none' | 'bearer' | 'headers'
  // auth 配置(JSON,明文存——webtool 本地运行,db 文件在用户本机,威胁模型类似本地 .env):
  //   bearer → { token: string }
  //   headers → { headers: Record<string,string> }
  //   none   → null
  // GET /api/eve-services 返回时 token 脱敏(不回显明文),PATCH 单独更新
  authConfig: text('auth_config'),
  online: integer('online', { mode: 'boolean' }).default(false),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                                 // ulid
  backend: text('backend').notNull(),                           // 'eveagent' | 'claudecode' | 'pi'
  // 多态执行端点 id:local 存 device.id,eveagent 存 eve_service.id,由适配器解释。
  // 去外键因 target 多态;每个 session 都必须绑定一个 target。
  targetId: text('target_id').notNull(),
  model: text('model').notNull(),
  title: text('title'),                                        // 自动标题（首条用户消息前 30 字）
  userTitle: text('user_title'),                                // 用户自定义，覆盖 title
  eveSessionId: text('eve_session_id'),                        // eveagent 专用
  eveContinuationToken: text('eve_continuation_token'),        // eveagent 专用
  localSessionRef: text('local_session_ref'),                  // 本地 client 内部 ID
  streamIndex: integer('stream_index').notNull().default(0),   // eve stream resume 游标
  pendingUserMessage: text('pending_user_message'),            // 已提交但 turn 未完成的消息内容
  pendingUserMessageCreatedAt: integer('pending_user_message_created_at', { mode: 'timestamp' }), // pending 写入时刻,stale 判断用
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),                                 // UIMessage.id(ulid)
  sessionId: text('session_id').notNull().references(() => sessions.id),
  seq: integer('seq').notNull(),                               // 会话内顺序(拉取/重放/增量 since)
  role: text('role').notNull(),                                // 'user' | 'assistant' | 'system'
  parts: text('parts').notNull(),                              // JSON: Array<UIMessagePart> — 完整保序
  metadata: text('metadata'),                                  // JSON: WebtoolMessageMetadata(可空)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  // REV-005-14:单 session 内 seq 唯一,防 select max(seq)+1 竞态产生重复 seq,
  // 破坏 orderBy(seq) 与增量拉取语义。
  sessionSeqUnique: unique('messages_session_seq_unique').on(t.sessionId, t.seq),
}));
