# 旁听服务端

托管模式的 AI 网关：账号、共享缓存、任务编排。**只做这三件事** —— 字幕读取、翻译、PDF / XMind / Markdown 导出全部留在扩展里。

## 为什么这样切

| 能力                   | 在哪       | 原因                                                                              |
| ---------------------- | ---------- | --------------------------------------------------------------------------------- |
| 字幕读取               | 扩展       | 服务端 IP 抓 YouTube 字幕会被封，用户浏览器带自己的 cookie 和住宅 IP 成功率高得多 |
| PDF / XMind / Markdown | 扩展       | 本机生成已经跑通且免费，搬上来只增加带宽和存储                                    |
| 默认字幕翻译           | 扩展       | `translate.googleapis.com` 是未公开接口，集中调用被封得更快                       |
| 5 个 AI 任务           | **服务端** | 成本、缓存、可观测性全在这里                                                      |

## 共享缓存：这个服务存在的理由

扩展里每个用户的 `chrome.storage` 是隔离的，同一个视频一万个人看就付一万次钱。服务端把派生结果按**视频**存，不按用户存。

两层缓存，效果可以在 [tests/server/cache.test.ts](../tests/server/cache.test.ts) 里数出来：

**1. 产物缓存（`artifacts`）** —— 第一个观众付钱，后面所有人读一行数据库。

```
用户 A 生成内容目录 → 4 次分段 + 1 次汇总 = 5 次模型调用
用户 B 生成同一个   → cached: true，模型调用次数不变
```

**2. 片段摘要缓存（`digests`）** —— 跨任务复用。`outline` 和 `guide` 不带任何额外上下文，喂给模型的证据**逐字节相同**，所以第二个任务只花 1 次调用而不是 31 次。

```
outline    → digest 4, final 1
guide      → digest 4, final 2   ← 分段全部命中缓存
summarize  → digest 8, final 3   ← 带用户 Prompt，证据确实不同，不假装能共享
```

缓存键包含 `任务 + 语言 + 模型 + Prompt + 字幕指纹 + PIPELINE_VERSION`。改了提示词或 schema 就把 `PIPELINE_VERSION` 加一，旧产物自然失效，而不是继续端出当前代码不会产生的结果。

## 复用扩展的流水线

`ai-service.ts` / `client.ts` / `validation.ts` 是**同一份源码**，扩展和服务端共用，没有第二份实现。

- 请求体直接用扩展的 `aiRequestSchema` 校验 —— 客户端和服务端的契约不可能漂移，改一个字段两边同时编译失败
- 分段分析、分层归并、结构不符把出错字段回喂给模型重试、单批失败跳过并标注覆盖率 —— 全部继承，不重写

`runAi` 只多接一个可选的 `digests` 存储：扩展不传，行为和以前完全一样；服务端传，就有了上面的跨用户复用。

## 接口

| 方法   | 路径                  | 说明                                                                                      |
| ------ | --------------------- | ----------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/register`   | `{email, password}` → `{token, user}`，密码至少 10 位                                     |
| `POST` | `/v1/auth/login`      | 同上。邮箱不存在和密码错误返回**完全相同**的响应                                          |
| `GET`  | `/v1/me`              | 账号、今日用量、视频库                                                                    |
| `POST` | `/v1/jobs`            | `{request}`（一个 `AiRequest`）。命中缓存 `200 {cached:true, result}`；否则 `202 {jobId}` |
| `GET`  | `/v1/jobs/:id`        | 轮询任务状态                                                                              |
| `GET`  | `/v1/jobs/:id/events` | SSE 进度流                                                                                |
| `POST` | `/v1/jobs/:id/cancel` | 取消                                                                                      |

命中缓存的请求**不入队、不计额度** —— 它本来就没花钱。

## 安全

- 服务商 API Key 只存在于服务端进程，任何路径都不下发给客户端
- 密码用 `node:crypto` 的 scrypt（N=32768, r=8），每条独立盐，`timingSafeEqual` 比对；无原生依赖
- 会话令牌是 HMAC-SHA256 签名的不透明令牌，不是 JWT —— 只有一个签发方和一个验证方，固定算法可以完全避开 JWT 头部混淆那一类问题
- 登录失败按 `IP + 邮箱` 限流
- 任务归属逐个校验，不因为 id 难猜就假定安全

## 运行

```bash
cp server/.env.example server/.env   # 填好后 export，或用你习惯的方式注入
npm run server                        # 或 npm run server:dev 热重载
```

不设 `DATABASE_URL` 会使用内存存储，重启后账号和缓存全部丢失，仅适合本地调试。生产接 Postgres，表结构见 [schema.sql](store/schema.sql)，首次启动自动建表。

## 部署

### 一个决定托管位置的硬约束

服务端要向模型服务商发出站请求。**中国大陆机房访问不了 `api.openai.com` 和 `api.anthropic.com`** —— 如果托管模型选这两家，服务端就必须放在境外。DeepSeek 的 `api.deepseek.com` 是境内可达的，选它则大陆机房可行。

另外用户本来就得能访问 YouTube，所以受众基本在境外。**综合建议放新加坡 / 香港 / 日本**，离用户近，出站也通。

### 不能用 Serverless

任务要跑 1.5~7 分钟，进度走 SSE 长连接。Vercel / Netlify Functions、Lambda 都撑不住这种时长的响应流。**必须是常驻进程**。

### 平台

| 平台                                  | 适合         | 说明                                                         |
| ------------------------------------- | ------------ | ------------------------------------------------------------ |
| **Fly.io**（推荐）                    | 现在         | 常驻进程、SSE 无碍、自带 Postgres、单机配置已写进 `fly.toml` |
| Railway / Render                      | 想少配点东西 | 同类，控制面更简单                                           |
| VPS（Hetzner / Vultr / 腾讯云新加坡） | 量大之后     | 最省钱，但监控、证书、发布都要自己搭                         |

### Fly.io 上线

```bash
fly launch --no-deploy                    # 用仓库里的 fly.toml
fly postgres create --region sin          # 或改用 Neon / Supabase
fly postgres attach <数据库名>            # 自动注入 DATABASE_URL

fly secrets set   SIDENOTE_SESSION_SECRET="$(openssl rand -base64 48)"   SIDENOTE_PROVIDER=deepseek   SIDENOTE_MODEL=deepseek-v4-flash   SIDENOTE_API_KEY=sk-...   SIDENOTE_CORS_ORIGINS=chrome-extension://<扩展ID>

fly deploy
```

自建同理：`docker build -t sidenote-server .`，把上面这些作为环境变量注入。

### ⚠️ 目前只能单实例

任务状态和登录限流都在**进程内存**里（`server/jobs/queue.ts` 与 `app.ts` 的 `loginAttempts`）。开第二个实例会出现：

- 用户轮询 `/v1/jobs/:id`，请求打到不认识这个任务的实例 → 404
- 登录限流按实例各算一份，N 个实例等于放宽 N 倍

`fly.toml` 里已经把 `max_machines_running` 锁成 1，把约束写进部署配置而不是只写在文档里。

**这不是短期瓶颈** —— 真正的上限是模型服务商的速率，不是 Node 进程。要横向扩展时，先把这两处状态搬进 Postgres 或 Redis，再解锁实例数。

### 发布与数据

- **滚动发布不会丢任务**：`app.close()` 会等进行中的任务跑完，最多 90 秒；超时才中断并记警告。这条很重要 —— 额度是启动任务时就扣的，丢任务等于用户白付。
- **`/health` 与 `/ready` 分工不同**：`/health` 不碰数据库（数据库不可达时重启帮不上忙，只会变成崩溃循环）；`/ready` 会查一次数据库，负载均衡应该看它。
- **建表有并发锁**：多实例同时启动时用 `pg_advisory_lock` 串行化。但 `CREATE TABLE IF NOT EXISTS` **不是迁移系统** —— 一旦要改已有列，请先引入正式的迁移工具，不要在 `schema.sql` 上改。
- 密钥只走环境变量，镜像以非 root 用户运行。

## 验证

单元测试默认用内存存储，所以 **Postgres 实现只有一处覆盖**，部署前请跑一次：

```bash
docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote   -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/sidenote npm test
```

没设 `DATABASE_URL` 时这组测试自动跳过，不影响其他机器。

镜像本身也建议实跑一次再部署：

```bash
npm run server:build && docker build -t sidenote-server:local .
docker run --rm -p 8787:8787 -e DATABASE_URL=... -e SIDENOTE_SESSION_SECRET=...   -e SIDENOTE_PROVIDER=... -e SIDENOTE_MODEL=... -e SIDENOTE_API_KEY=... sidenote-server:local
curl localhost:8787/ready   # 通了才说明数据库连得上
```

### 一个不是 bug 的差异

Postgres 的 `jsonb` 会把对象键名排序存储，所以产物读回来时**键序和写入时不同**，内容完全等价。没有任何代码按位置读这些结构，但不要用逐字节比较来断言缓存一致性。

## 还没做

- 计费与订阅（现在只有每日任务数上限，超出后引导用户改用自己的 Key）
- pgvector 跨视频知识库（表结构已按这个方向设计）
- 队列跨进程（当前是进程内队列，多实例部署需要换成 Redis）
- OAuth 登录
