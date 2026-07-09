# webtool

通用 chatUI 前端 + 会话持久化层。本地运行（不部署），作为 **tool/eve（云端 agent）、本地 pi、本地 claudecode** 三类后端的统一图形层与 会话权威源。

- 技术栈：Next.js 16（App Router）+ React 19 + Drizzle ORM + turso（`@tursodatabase/database`）+ Tailwind v4
- 通信边：浏览器 ↔ webtool 走 同源 HTTP + SSE；webtool ↔ 本地 client 走反向出站 WS（`/ws/devices`）；webtool ↔ eveagent 走 HTTP（`eve/client` SDK → `EVE_HOST`，独立部署的 eve）
- 兄弟项目：`webtool-clients/webtool-client/`（本地 CLI，反向连本项目的 WS 网关）

> 更深入的拓扑、事件协议、表结构见项目知识库：`../project-kb/architecture/webtool-system-architecture.md`、`../project-kb/architecture/webtool-2.0-tech-decisions.md`

---

## 文件树

```text
webtool/
├── app/                          # Next.js App Router：页面 + REST API
│   ├── api/                      #   HTTP REST 路由（浏览器 ↔ webtool）
│   │   ├── sessions/             #     会话列表/创建、单会话 CRUD、SSE、发消息、重试、停止
│   │   │   ├── route.ts          #       GET/POST 会话列表与创建
│   │   │   └── [id]/
│   │   │       ├── route.ts          #   单会话 GET/PATCH/DELETE（软删除）
│   │   │       ├── events/route.ts   #   SSE 事件流（订阅 sessionEventBus，断线按 lastEventId 续传）
│   │   │       ├── messages/route.ts #   发送用户消息 / 拉取历史
│   │   │       ├── retry/route.ts    #   重试上一个 turn
│   │   │       └── stop/route.ts     #   主动停止当前 turn
│   │   ├── devices/              #     设备管理
│   │   │   ├── route.ts          #       设备列表
│   │   │   ├── register/route.ts #       设备注册（凭 setup-token 换 long-lived token）
│   │   │   └── [id]/
│   │   │       ├── models/route.ts          # 查询设备某 backend 的模型清单
│   │   │       └── refresh-models/route.ts  # 触发设备重新探测模型
│   │   └── setup-tokens/route.ts #     一次性 setup token（24h 有效，用于设备首次注册）
│   ├── sessions/                 #   会话 UI
│   │   ├── new/page.tsx          #     新建会话页
│   │   └── [id]/page.tsx         #     会话详情页（chatUI 主界面）
│   ├── devices/                  #   设备管理 UI
│   │   ├── page.tsx
│   │   └── _components/AddDeviceDialog.tsx
│   ├── layout.tsx                #   根布局
│   ├── page.tsx                  #   首页
│   ├── globals.css               #   全局样式（Tailwind v4 入口）
│   └── favicon.ico
│
├── components/chat/              # 聊天 UI 组件
│   ├── ConfirmDialog.tsx         #   确认弹窗（如删除会话）
│   ├── InterruptBanner.tsx       #   中断/断连横幅
│
├── lib/                          # 后端业务逻辑（与 Next 框架解耦，可单测）
│   ├── backends/                 #   后端适配器层（统一 BackendAdapter 接口）
│   │   ├── types.ts              #     BackendAdapter 接口定义（listModels/startSession/send/stop/onEvent）
│   │   ├── router.ts             #     按 backend 名分发到 adapter（eveagent→EveagentBackend；claudecode/pi→LocalBackend）
│   │   ├── eveagent.ts           #     eve 远程后端：eve/client SDK，per-turn 走 clientContext 续接历史
│   │   ├── local.ts              #     本地后端：经反向 WS 把 session.start/send/stop 派发给本地 client
│   │   ├── event-bus.ts          #     EveagentBackend 内部事件总线（与本地后端的 sessionEventBus 隔离，避免互相干扰）
│   │   └── persist.ts            #     共享持久化：把 WebtoolEvent 增量写入 messages 表（text/reasoning/tool/finishReason）
│   ├── db/                       #   数据库层
│   │   ├── client.ts             #     turso 驱动 + drizzle-orm/sqlite-proxy 适配 + 迁移入口（全局缓存连接，抗 HMR）
│   │   └── schema.ts             #     Drizzle schema：devices / device_supported_backends / device_models / setup_tokens / sessions / messages
│   ├── events/session-bus.ts     #   全局 session 事件总线（device-gateway 上行 → SSE 端点订阅；本地后端用）
│   ├── protocol/                 #   协议类型定义
│   │   ├── events.ts             #     WebtoolEvent：所有后端归一的 8 种事件类型
│   │   └── ws-messages.ts        #     webtool ↔ 本地 client 的 WS 消息（WsToClient / WsFromClient）
│   └── auth/token.ts             #   token 生成 / sha256 哈希 / 校验（setup-token 与 device long-lived token 共用）
│
├── server/                       # 自定义 Next.js server 的扩展
│   └── ws/device-gateway.ts      #   /ws/devices 反向 WS 网关：token 鉴权、ping/pong 心跳（90s 超时）、
│   │                              #   设备重连自动续接（30 分钟内未完成 session）、处理 device.hello/models.report/session.event
│   └── (server.ts 在根目录)
│
├── drizzle/                      # Drizzle 迁移产物（drizzle-kit generate 生成，勿手改）
│   ├── 0000_flowery_thunderbolt.sql       # 初始 schema
│   ├── 0001_messages_tool_persistence.sql # messages 表 tool_calls/tool_results/reasoning 持久化
│   └── meta/                     #   快照 + _journal.json
│
├── public/                       # 静态资源（next.svg / vercel.svg 等 SVG）
├── data/                         # SQLite 文件存放处（运行时生成，默认 ./data/webtool.db；.gitignore 忽略）
│
├── server.ts                     # 自定义 server 入口：Next prepare 后在同一 HTTP 端口挂 /ws/devices 网关
├── instrumentation.ts            # Next 启动钩子：nodejs runtime 下跑 drizzle migrate
├── next.config.ts                # Next 配置：声明 @tursodatabase/database 为 serverExternalPackages（已去除 withEve 宿主包装）
├── drizzle.config.ts             # drizzle-kit 配置（schema=./lib/db/schema.ts, out=./drizzle, dialect=sqlite）
├── package.json                  # 依赖与脚本（dev/start = tsx server.ts；build = next build；test = vitest）
├── pnpm-lock.yaml                # pnpm 锁文件
├── pnpm-workspace.yaml           # 仅声明 ignoredBuiltDependencies（sharp / unrs-resolver）；非真正 workspace 根
├── tsconfig.json                 # TypeScript 配置
├── eslint.config.mjs             # ESLint（eslint-config-next）
├── postcss.config.mjs            # PostCSS + Tailwind v4
├── next-env.d.ts                 # Next 类型声明（自动生成）
├── .env / .env.example           # 环境变量：DATABASE_URL / ANTHROPIC_API_KEY / AI_GATEWAY_API_KEY / EVE_HOST
├── .dns-override.cjs             # DNS 钉子：把 hunian003-evework.hf.space 钉到单一可达 IP，绕过 undici Happy Eyeballs 并发超时
├── .gitignore
├── AGENTS.md / CLAUDE.md         # agent 行为准则（CLAUDE.md = `@AGENTS.md`，继承自项目根）
├── skills-lock.json              # skills 版本锁
└── .claude/                      # Claude Code 本地配置（settings.local.json + skills）
```

构建/缓存产物目录（已忽略，不在源码阅读范围）：`.next/`、`.eve/`、`node_modules/`、`.git/`。

---

## 启动

```bash
pnpm install
pnpm dev      # = tsx server.ts，启动 Next + WS 网关于 http://localhost:3000
```

`dev` 与 `start` 都走 `tsx server.ts`（自定义 server），不是 `next dev`——因为 WS 网关必须挂在同一 HTTP 端口上。启动时 `instrumentation.ts` 自动应用 `drizzle/` 下的迁移。

## 三类后端如何被路由

`lib/backends/router.ts` 按 session 的 `backend` 字段分发：

| backend | adapter | 路径 |
|---------|---------|------|
| `eveagent` | `EveagentBackend` | HTTP `eve/client` SDK → `EVE_HOST`（独立部署的 eve，默认云端） |
| `claudecode` / `pi` | `LocalBackend` | 反向 WS → 本地 `webtool-client` → spawn 子进程 |

所有后端输出统一归一为 `WebtoolEvent`（`lib/protocol/events.ts`），经 `persist.ts` 落库 + 经 `sessionEventBus` 推 SSE——这是 webtool 作为会话权威源的核心机制。
