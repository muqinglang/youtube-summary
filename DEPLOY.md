# 部署

两件独立的事：**服务端**（托管模式需要）和**扩展发布**（所有人需要）。只想让别人用自带 Key 的版本，跳到[第二部分](#二发布扩展)即可，不需要服务器。

---

## 只能你本人完成的步骤

| 事项                                   | 原因           |
| -------------------------------------- | -------------- |
| 注册 Fly.io / 云厂商账号、绑定支付方式 | 涉及身份与付款 |
| 申请模型服务商 API Key                 | 是你的凭据     |
| 购买并解析域名                         | 需要账号与付款 |
| 注册 Chrome 开发者账号（一次性 $5）    | 同上           |
| 创建 Google OAuth 客户端 ID            | 登录的唯一入口 |

下面每一处需要你填的地方都用 `<尖括号>` 标出。

---

## 一、部署服务端

### 1. 先决定托管在哪

**决定性约束**：服务端要向模型服务商发出站请求。**中国大陆机房访问不了 `api.openai.com` 和 `api.anthropic.com`** —— 用这两家就必须放境外。DeepSeek 的 `api.deepseek.com` 境内可达。

你的用户本来也得能访问 YouTube，所以受众基本在境外。**建议新加坡 / 香港 / 日本**。

**不能用 Serverless**：任务要跑 1.5~7 分钟，进度走 SSE 长连接。Vercel / Netlify Functions、Lambda 都撑不住这种时长。必须常驻进程。

| 平台               | 适合                                                 |
| ------------------ | ---------------------------------------------------- |
| **Fly.io**（推荐） | 常驻进程、SSE 无碍、自带 Postgres，`fly.toml` 已就绪 |
| Railway / Render   | 控制面更简单                                         |
| VPS（新加坡）      | 量大后最省钱，但监控、证书、发布要自己搭             |

### 2. 部署前必须改的两处代码

扩展只会连白名单里的来源，而这个来源写在两个地方：`src/shared/hosted.ts` 的 `HOSTED_ORIGINS`（扩展愿不愿意连）和 `extension/manifest.json` 的 `optional_host_permissions`（Chrome 允不允许连）。两处不一致会在运行时报一个看不出所以然的授权错误，所以 `tests/background/manifest.test.ts` 会拦下——这是故意的。

一条命令同时改两处：

```bash
npm run set-hosted-origin -- https://<你的应用>.fly.dev
npm test        # 确认两处没漂移
npm run build   # 重新打包扩展
```

当前已指向 `https://sidenote.fly.dev`。**Fly 的应用名全球唯一**，如果 `fly launch` 提示这个名字被占了，用它实际给你的名字重跑一次上面的命令即可，不需要改代码。

不用买域名：`fly deploy` 会免费给一个 `<应用名>.fly.dev` 的 HTTPS 地址，白名单直接能用。以后换自有域名，也是再跑一次这条命令。

### 2.5 配置 Google 登录

托管模式**只支持 Google 登录**，没有邮箱密码。服务端不保存任何密码，只保存 Google 的账号标识和邮箱。

这一步必须你来做：

1. **先固定扩展 ID。** 未打包加载时扩展 ID 会变，而 OAuth 的重定向地址里包含它。在 `extension/manifest.json` 加一个 `"key"` 字段固定住（或先发布到应用商店拿正式 ID）。
2. Google Cloud Console → APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → 类型选 **Web application**。
3. Authorized redirect URIs 填：`https://<扩展ID>.chromiumapp.org/`
4. 拿到客户端 ID 后填两处，**必须一致**：
   - `src/shared/google.ts` 的 `GOOGLE_CLIENT_ID`
   - 服务端的 `SIDENOTE_GOOGLE_CLIENT_ID`

服务端会校验每个凭证的 `aud` 等于这个客户端 ID —— 不一致的话，别的应用签发的凭证就能登进来，所以两处对不上时登录会直接失败，这是故意的。

登录流程用的是 **ID token**（本地验签），不是 access token。凭证只走请求体，不会出现在 URL 查询串里进日志。

### 3. 上线前跑一次带数据库的测试

`server/store/postgres.ts` 只有一处覆盖，且默认跳过（其余测试用内存存储）。**部署前务必带数据库跑一次**：

```bash
docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote \
  -p 5433:5432 pgvector/pgvector:pg16
DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/sidenote npm test
```

用 `pgvector/pgvector:pg16` 而不是 `postgres:16-alpine`：后者没有 pgvector，向量那组断言会**自动跳过**而不是失败，看起来一样绿。

配了向量服务的话，同时验一次它本身：

```bash
npm run check:embeddings   # 检查维度是否匹配，以及语义检索是否真的能用
```

再实跑一次镜像，确认交付物本身没问题：

```bash
npm run server:build && docker build -t sidenote-server:local .
docker run --rm -p 8787:8787 \
  -e DATABASE_URL=<你的连接串> \
  -e SIDENOTE_SESSION_SECRET=<至少32位随机串> \
  -e SIDENOTE_PROVIDER=deepseek -e SIDENOTE_MODEL=deepseek-v4-flash \
  -e SIDENOTE_API_KEY=<你的 Key> \
  sidenote-server:local
curl localhost:8787/ready   # 返回 {"ready":true} 才说明数据库连得上
```

### 4. Fly.io 上线

```bash
fly launch --no-deploy                    # 使用仓库里的 fly.toml
fly postgres create --region sin          # 或改用 Neon / Supabase
fly postgres attach <数据库名>            # 自动注入 DATABASE_URL

fly secrets set \
  SIDENOTE_SESSION_SECRET="$(openssl rand -base64 48)" \
  SIDENOTE_PROVIDER=deepseek \
  SIDENOTE_MODEL=deepseek-v4-flash \
  SIDENOTE_API_KEY=<你的 Key> \
  SIDENOTE_GOOGLE_CLIENT_ID=<你的 OAuth 客户端 ID> \
  SIDENOTE_EMBEDDING_API_KEY=<向量服务 Key，不需要跨视频检索就省略> \
  SIDENOTE_CORS_ORIGINS=chrome-extension://<扩展ID>

fly deploy
fly logs
curl https://<你的域名>/ready
```

`fly deploy` 默认用 **Fly 的远程构建器**打镜像，不依赖你本机的 Docker 和网络。本机 `docker build` 失败（例如抓包工具在做 TLS 中间人，容器不信任那张根证书，`npm ci` 会报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）**不影响 `fly deploy`**。

三件容易在这一步翻车的事：

- **别让 Fly 建第二台机器。** 这个服务只能单实例。`max_machines_running = 1` 管的是自动启停，**拦不住部署时为高可用多建一台** —— 实测确实建了两台。只有 `min_machines_running = 0` 才会让 flyctl 跳过那台 HA 机器（仓库里的 `fly.toml` 已改）。已经建出来了就 `fly scale count 1 --app <应用名>` 销毁多余的。
- **`SIDENOTE_SESSION_SECRET` 必须是新随机串。** `.env.example` 里的占位值刚好 33 个字符，长度检查拦不住，而它是公开的 —— 用它上线等于任何人都能伪造任意账号的登录态。现在配置层会直接拒绝这个值，但别的弱口令它管不了。
- **Fly 自家的 Postgres 没有 pgvector。** 2026-09-11 实测：`flyio/postgres-flex:18.1` 的扩展目录里 61 个 control 文件，没有 vector —— 不是权限问题，是镜像里根本没装。跨视频检索需要它的话，用 Neon / Supabase（免费层就有 pgvector），把连接串设成 `DATABASE_URL` 即可。没有它服务照常起，只是那个功能静默关闭（`/v1/me` 里 `features.librarySearch` 为 `false`）。确认办法：

  ```bash
  fly postgres connect -a <数据库名>
  CREATE EXTENSION IF NOT EXISTS vector;   -- 报错就说明这个实例装不了
  ```

- **向量服务的区域要对上机房。** 百炼有北京和新加坡两个端点，**Key 是按区域发的**，拿北京的 Key 打国际端点会 401。部署在境外又用北京端点，至少要接受跨境延迟。真出问题时 `/v1/library/search` 返回 502 并带上状态码，日志里也看得到。

上线后确认这三件事：

```bash
curl https://<你的域名>/ready          # {"ready":true} —— 数据库通了
# 注册一个账号拿到 token，然后：
curl https://<你的域名>/v1/me -H "Authorization: Bearer <token>"
# features.librarySearch 为 true 才说明 pgvector 和向量服务都就位
```

自建 VPS 同理：`docker build` 后把这些作为环境变量注入即可。

### 5. 环境变量

| 变量                        | 必填     | 说明                                                     |
| --------------------------- | -------- | -------------------------------------------------------- |
| `SIDENOTE_SESSION_SECRET`   | ✅       | 会话签名密钥，**至少 32 位**。泄露等同于所有账号可被冒用 |
| `SIDENOTE_PROVIDER`         | ✅       | `openai` / `deepseek` / `anthropic` / `custom`           |
| `SIDENOTE_MODEL`            | ✅       | 模型 id                                                  |
| `SIDENOTE_API_KEY`          | ✅       | 运营方自己的 Key，只存在于服务端进程                     |
| `SIDENOTE_GOOGLE_CLIENT_ID` | ✅       | OAuth 客户端 ID，必须与扩展里那份完全一致                |
| `SIDENOTE_BASE_URL`         | 选填     | 覆盖服务商官方地址；`custom` 时必填                      |
| `DATABASE_URL`              | 强烈建议 | **不设则使用内存存储，重启后账号与缓存全部丢失**         |
| `SIDENOTE_DAILY_JOB_LIMIT`  | 选填     | 单账号每日任务数，默认 20                                |
| `SIDENOTE_CORS_ORIGINS`     | 选填     | 逗号分隔。扩展来源形如 `chrome-extension://<扩展ID>`     |
| `SIDENOTE_LOG`              | 选填     | 设为 `off` 关闭日志                                      |
| `PORT`                      | 选填     | 默认 8787                                                |

跨视频知识库需要另一组变量，**全部选填**，不设就只是这一个功能关闭：

| 变量                            | 说明                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `SIDENOTE_EMBEDDING_API_KEY`    | 向量服务的 Key。不设则关闭该功能                                       |
| `SIDENOTE_EMBEDDING_BASE_URL`   | 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`（阿里云百炼） |
| `SIDENOTE_EMBEDDING_MODEL`      | 默认 `text-embedding-v3`                                               |
| `SIDENOTE_EMBEDDING_DIMENSIONS` | 默认 `1024`，必须等于模型实际输出的维度                                |
| `SIDENOTE_EMBEDDING_BATCH`      | 默认 `10`                                                              |

两件容易踩的事：

- **Anthropic 没有 embedding 接口。** 对话用 Claude 时，这组变量必须指向另一家。
- **数据库要有 pgvector。** Fly 官方 Postgres、Supabase、Neon、RDS 都可以；装不上时服务照常启动，只是 `/v1/library/search` 返回 501、扩展里那个入口自动隐藏。维度改动会在启动时直接报错并指名要改的变量，换供应商需要 `DROP TABLE chunks` 重新索引。

### 6. ⚠️ 目前只能单实例

任务状态与登录限流都在**进程内存**里。开第二个实例会出现：

- 用户轮询 `/v1/jobs/:id` 打到不认识这个任务的实例 → 404
- 登录限流按实例各算一份，N 个实例放宽 N 倍

`fly.toml` 已把 `max_machines_running` 锁成 1，**把约束写进部署配置而不是只写在文档里**。

这不是短期瓶颈——真正的上限是模型服务商的速率限制，不是 Node 进程。要横向扩展时，先把这两处状态搬进 Postgres 或 Redis，再解锁实例数。

### 7. 运维须知

- **滚动发布不丢任务**：关闭时最多等 90 秒让进行中的任务跑完。这条重要——额度是任务启动时就扣的。
- **两个探针分工不同**：`/health` 不碰数据库（数据库不可达时重启帮不上忙，只会变成崩溃循环）；`/ready` 查一次数据库，负载均衡应该看它。
- **⚠️ 建表不是迁移系统**：`schema.sql` 用 `CREATE TABLE IF NOT EXISTS`，多实例启动有 `pg_advisory_lock` 保护。但**一旦要修改已有列，必须先引入正式迁移工具**，不要在 `schema.sql` 上直接改。
- **额度不是可选项**：一个 5 小时视频全套跑完是几毛到一美元的量级。没有额度上限，一个重度用户一个月就能把你干亏。超额后引导用户改用自己的 Key。

---

## 二、发布扩展

浏览器早已禁止从商店外拖拽安装 `.crx`，所以未上架前只能走「开发者模式 → 加载已解压的扩展程序」。

### 方案 A：发 GitHub Release（今天就能做）

```bash
npm run check     # 类型、lint、测试、扩展与服务端构建
```

然后在仓库页 → **Releases** → **Create a new release** → tag `v0.7.0` → 把 `release/sidenote-0.7.0.zip` 拖进附件区 → 发布。

> Release 附件不受 `.gitignore` 影响，所以 `release/` 保持忽略是对的。

要提前告诉使用者两件事，否则一定会来问：

1. 每次启动浏览器会弹「请停用以开发者模式运行的扩展程序」，关掉即可，无法消除
2. 解压后要选**包含 `manifest.json` 的那一层文件夹**

### 方案 B：上架 Chrome 应用商店

已具备：图标全套、隐私说明、无远程代码（CSP 是 `script-src 'self'`，审核加分）、权限已收窄到具体域名。

还需要：

- 开发者账号（一次性 $5）
- **隐私政策的公开 URL** —— `docs/privacy.md` 内容够用，开 GitHub Pages 最快
- 商店截图（1280×800）、简介、分类
- 每个权限的用途说明
- 数据用途申报：**必须如实勾选「字幕内容会发送给第三方」**。默认字幕走 Google 公共接口；托管模式会把字幕上传到你的服务端

商店有 **「不公开」(Unlisted)** 选项：搜不到但有链接就能装，还能自动更新。小范围分发比发 zip 舒服得多。

Edge 加载项商店**免费**，吃同一个 MV3 包，可以同时上。

---

## 上线后自查

```bash
curl https://<你的域名>/health     # {"ok":true}
curl https://<你的域名>/ready      # {"ready":true} —— 数据库连通
```

在扩展里：设置 → 切到「登录用额度」→ 注册 → 「检查账号与额度」应显示邮箱与剩余次数。

然后用**两个不同账号**打开同一个视频生成内容目录：第二个应当立刻返回且不消耗额度。这条验证的是共享缓存——整个托管模式的成本模型都建立在它之上。
