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
| `POST` | `/v1/auth/google`     | `{idToken, nonce?}` → `{token, user}`。首次登录即建号                                     |
| `GET`  | `/v1/me`              | 账号、今日用量、视频库、`features.librarySearch`                                          |
| `POST` | `/v1/library/search`  | `{query, limit?}` → 跨视频检索命中片段；未配置向量服务时 `501`                            |
| `POST` | `/v1/jobs`            | `{request}`（一个 `AiRequest`）。命中缓存 `200 {cached:true, result}`；否则 `202 {jobId}` |
| `GET`  | `/v1/jobs/:id`        | 轮询任务状态                                                                              |
| `GET`  | `/v1/jobs/:id/events` | SSE 进度流                                                                                |
| `POST` | `/v1/jobs/:id/cancel` | 取消                                                                                      |

命中缓存的请求**不入队、不计额度** —— 它本来就没花钱。

## 跨视频知识库

托管模式处理过的视频会被切成重叠片段并向量化，之后可以在**自己看过的所有视频**里按语义检索。

- 切片规则见 [chunking.ts](ai/chunking.ts)。中文按字计 token、英文按四字符计一个 —— 不做这个区分，中文片段会大出四倍
- 检索只在调用者 `library` 里的视频上做。产物缓存是全站共享的，**视频库不是**
- 同一个视频最多返回 2 条，否则一个视频会占满整页结果
- 不设相关度阈值：多少分算「相关」要按具体 embedding 模型标定，没有真实数据量之前给不出可信的数，所以原样返回分数

### 配置向量服务

Anthropic **没有 embedding 接口**，所以用 Claude 跑对话时必须另配一家。默认指向阿里云百炼（大陆可直连，OpenAI 兼容）：

| 变量                            | 默认值                                              | 说明                             |
| ------------------------------- | --------------------------------------------------- | -------------------------------- |
| `SIDENOTE_EMBEDDING_API_KEY`    | 无                                                  | **不设就整个功能关闭**，其余照常 |
| `SIDENOTE_EMBEDDING_BASE_URL`   | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容的 `/embeddings` 路径 |
| `SIDENOTE_EMBEDDING_MODEL`      | `text-embedding-v3`                                 |                                  |
| `SIDENOTE_EMBEDDING_DIMENSIONS` | `1024`                                              | 必须等于模型实际输出的维度       |
| `SIDENOTE_EMBEDDING_BATCH`      | `10`                                                | 每次请求的文本条数，各家上限不同 |

配好后先验一次，别等索引灌满了才发现不对：

```bash
npm run check:embeddings
```

它会用**接近真实长度**的片段做检索（一句话的语料比真实情况难得多，用它判断会误伤一个本来能用的模型），检查两件事：维度是否等于配置值，以及换一种说法、几乎不重合的用词能否检索到正确片段。

百炼 `text-embedding-v3` @ 1024 维实测（2026-09-10，中英各一组）：正确命中 0.60–0.75，领先第二名 0.15–0.29；**完全无关的问题最高也有 0.34**。分离度是够的，但那个下限并不低 —— 这就是代码里不设绝对阈值的原因：`score > 0.3` 这种过滤器会把什么都放进来，而多少分算相关要按模型标定，换一家就得重来。

维度会写进 `chunks.embedding` 的列类型。改了维度而表已存在，启动会**直接报错并指名要改的变量**，而不是等到每次插入都失败。换供应商需要 `DROP TABLE chunks` 重新索引。

pgvector 是扩展，不少托管 Postgres 没装或不给应用角色 `CREATE EXTENSION`。装不上不会让服务起不来：`store.chunks` 为空，`/v1/library/search` 返回 501，`/v1/me` 里 `features.librarySearch` 为 `false`，扩展据此直接隐藏入口。

## 安全

- 服务商 API Key 只存在于服务端进程，任何路径都不下发给客户端
- **不保存密码**。身份来自 Google，本服务只存 Google 的账号标识（sub）与邮箱
- ID token 在本地验签（Google 公钥，RS256），不把凭证塞进 URL 交给 tokeninfo 接口
- 校验 `aud` 等于本服务的客户端 ID —— 少了这一步，任何 Google 应用的凭证都能登进来
- 账号以 Google 的 `sub` 为键，不以邮箱为键：用户改了 Google 邮箱，笔记和额度还是他的
- 会话令牌是 HMAC-SHA256 签名的不透明令牌，不是 JWT —— 只有一个签发方和一个验证方，固定算法可以完全避开 JWT 头部混淆那一类问题
- 登录失败按 IP 限流：验签要向 Google 取公钥并做签名运算，不能让人白嫖
- 任务归属逐个校验，不因为 id 难猜就假定安全

## 运行

```bash
cp server/.env server/.env   # 填好 Key，这个文件已在 .gitignore 里
npm run server                        # 或 npm run server:dev 热重载
```

`server/.env` 由 Node 的 `--env-file-if-exists` 读取，**文件不存在也不会报错** —— 线上用平台的 secrets 注入环境变量，不需要这个文件。真实进程里已有的同名变量优先，`.env` 不会覆盖它。

Key 只存在于这两个地方：本机的 `server/.env`，和线上平台的 secrets。它不进仓库、不进镜像、不下发给扩展。

不设 `DATABASE_URL` 会使用内存存储，重启后账号和缓存全部丢失，仅适合本地调试。生产接 Postgres，表结构见 [schema.sql](store/schema.sql)，首次启动自动建表。

## 部署

完整步骤、环境变量清单、托管位置的取舍与运维须知见 [DEPLOY.md](../DEPLOY.md)。三条必须知道的：

- 服务端要直连模型服务商，**大陆机房访问不了 OpenAI / Anthropic**，DeepSeek 可达。
- 任务长达数分钟且走 SSE，**不能用 Serverless**，必须常驻进程。
- 任务状态与登录限流在进程内存里，**目前只能单实例**；`fly.toml` 已锁 `max_machines_running = 1`。

## 验证

单元测试默认用内存存储，所以 **Postgres 实现只有一处覆盖**，部署前请跑一次：

```bash
docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote   -p 5433:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/sidenote npm test
```

没设 `DATABASE_URL` 时这组测试自动跳过，不影响其他机器。

用 `pgvector/pgvector:pg16` 而不是 `postgres:16-alpine`：后者没有 pgvector，向量那组断言会**自动跳过**而不是失败，看起来一样绿。

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
- 队列跨进程（当前是进程内队列，多实例部署需要换成 Redis）
