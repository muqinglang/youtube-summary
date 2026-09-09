# 开发验证记录

## 0.4.0：布局、章节与多厂商模型（2026-09-07）

已通过严格 TypeScript、ESLint、331 项单元测试及生产构建。新增覆盖真实章节提取、原生字幕模块能力/迟加载/显式切换、三家模型目录、设置迁移、密钥隔离和各自 HTTP 协议。广告隔离的 2 项浏览器测试通过。

浏览器集成使用生产扩展副本和真实 chrome.* API，YouTube 页面与 API 响应为受控夹具。仅测试副本在后台安装传输适配器，将三个精确官方请求地址保留方法、正文与鉴权后转发到本机 HTTP 服务；未知 HTTP 外域请求直接拒绝。生产 dist 不含测试适配器，没有调用付费服务。覆盖章节跳转/高亮、双向语言及显示设置、原生 CC 关闭、提供商/模型选择和持久化、固定地址及 Claude 原生 Messages 协议，并保留总结、问答、导出、取消和 Google 接入流程检查。

已人工检查 1440px 与 390px 截图：没有横向溢出，标题与语言栏位于播放器下方，章节在窄屏为两列。受控播放器的黑色画面不代表实际视频展示。

最终 E2E **9 项全部通过（23.0 秒）**。补充回归覆盖：连接测试进行中切换服务商不重复请求、不显示旧成功结果；清除 Key 后禁用测试；AI 任务中父页按钮与消息均不能绕过设置禁用；键盘切章节后保留焦点；没有原生章节时生成总结章节并跳转。三家服务商设置截图均未包含输入的密钥。

### 用户视频的实站验证

全流程使用真实用户视频 QLLuZbuTIRc，没有页面/网络夹具，独立浏览器配置，不使用付费 AI Key：

- 原 YouTube 标签保持后台，通过原生转录面板读到 **2,354 条字幕**。
- 读到 **57 个真实章节**，初始显示 6 个，展开后 57 个；最后一章为 Closing，5:01:26。
- 点击第二章 What this course covers，真实 HTMLVideoElement 的时间为 **169.004091 秒**，章节高亮与之同步。
- 跳到 1:19 后媒体 readyState 为 4，活动原生字幕轨为空；外部字幕带显示对应原文。截图没有第二层原生字幕。
- 另一次独立模块验证：原生 CC 按钮开启后活动轨道为 en；调用学习页的字幕接管后轨道清空，跳转后仍保持关闭。播放器 getOptions() 仅表示模块可用性，未用其作为字幕开关状态。

实站证据：`test-results/live-extension/run-LktSLr/evidence.json`、`learning-seek.png`、`chapter-seek.png`；模块证据：`test-results/caption-policy-HTNbgM/evidence.json`。

本轮没有宣称真实 AI 总结质量或 Google 译文验证通过；模型接口使用本地 HTTP 验证，Google 语言包仍受下述既有下载限制影响。

## 0.3.0 既有验证记录

日期：2026-09-07。对象为源码构建的 `0.3.0` Manifest V3 扩展，使用独立学习页面，并增加默认 Google 内置翻译。

## 自动化检查

`npm run check` 执行严格 TypeScript、ESLint、Vitest 单元测试及 esbuild 生产构建。0.3.0 严格检查和构建通过，**284 项单元测试**全部通过。Google 模块包含 52 项测试，覆盖语言映射、默认引擎、逐句顺序、空结果拒绝、超时、取消和迟到会话清理。学习页测试另覆盖 Chrome 隐藏标签 URL 时，通过自身扩展上下文安全复用学习标签。

单元测试覆盖字幕多格式解析、长视频分段、签名 URL 保留、被动 fetch / XHR 字幕读取、当前视频隔离、原生转录时间戳、缓存边界、学习标签复用、嵌入播放器换片后的身份锁定、密钥存储、AI 超时取消、引用时间验证及导出结构，另含 PDF 结构（可搜索 CID 文本、分页、链接注解）、清单权限防漂移、托管客户端与服务端（账号、共享缓存、额度）。

`server/store/postgres.ts` 只有一处覆盖，且默认跳过——其余测试都用内存存储。部署前请带上数据库跑一次：

```bash
docker run -d --name sidenote-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=sidenote   -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:devpass@127.0.0.1:5433/sidenote npm test
```

`npm run test:e2e` 的七项集成测试使用真实 Chromium 持久上下文加载 `dist`。运行实际 content scripts、独立学习标签、面板 iframe 和 service worker，不替换 `chrome.*` API。测试中的 YouTube 页面和字幕采用受控夹具；嵌入播放器夹具使用真实 HTMLVideoElement，通过 postMessage 传递状态和执行播放命令。AI 服务是本地 HTTP 服务器，可检查请求正文、鉴权和连接取消。

集成测试覆盖：

1. 点赞旁入口打开独立页、重复点击复用页面、原 YouTube 布局和播放器保持独立；嵌入播放器播放、暂停、倍速和点击字幕跳转。
2. API 设置保存和连接测试；自定义 Prompt 进入实际 HTTP 请求；章节、总结、翻译、搜索、问答和双语字幕显示。视频自带章节在未生成 AI 内容前即可用。
3. 实际下载 `.xmind` 并解包校验；实际下载扩展自己生成的 PDF，读回后确认中文以可搜索的 CID 文本嵌入；排版打印页单独作为一个导出项，保留来源和 Prompt。
4. 401 错误恢复、主动取消后 HTTP 连接终止、导入字幕标明覆盖范围未验证；关闭独立学习标签取消正在进行的 AI 请求。
5. 源页面单页导航和操作栏替换不会替换独立页的视频或中断其 AI 任务；源页切换后仍能使用已读取的本次字幕。
6. 字幕轨延迟出现、字幕接口返回空正文时，通过现代 YouTube 转录 DOM 读取字幕，并正确跳转嵌入播放器。
7. 未配置 Key 时选择「AI 字幕」立即打开设置、引擎保持 Google、不向服务商发出任何请求。该项自行打开学习页、清除密钥并重置引擎，不依赖相邻测试留下的状态。

`npm run test:ads` 的两项独立浏览器测试验证源页面前贴和中插广告不会污染正片元数据或播放时间，广告期间禁止正片跳转，广告结束恢复。

测试副本额外预授权本地测试服务，以避开浏览器原生权限对话框自动化；生产清单仍为按需授权。E2E 不声称覆盖原生权限弹窗的人工点击流程，也不以测试翻译文本冒充外部模型结果。

最终 `npm run test:e2e` 七项全部通过，`npm run test:ads` 两项通过；浏览器页面异常列表为空。

## Google 原生模型验证边界

- Chromium 147 的扩展页面检测到官方 Translator API，英语至简体中文等语言组合返回 `downloadable`。
- Google Chrome 151.0.7922.174 的独立安全测试页在真实点击后开始下载模型；首次观察到下载进度 34.579%，TranslateKit 主组件版本更新至 `2025.11.24.0`。
- 使用同一隔离浏览器配置再次等待五分钟后，英语中文语言包仍未就绪，没有返回译文。因此**没有真实 Google 翻译成功的验证结果**。未使用用户日常浏览器配置，未更改浏览器功能开关或调用 Google 私有接口。
- 最终证据：`test-results/translator-probe-4CMxJF/evidence.json`、`components.txt`。实际语言包下载依赖浏览器和网络；生产页面有下载进度、取消、重试及仅翻译当前句的普通 Google 网页入口。

## 用户视频的真实浏览器验证

视频：[How to Think Clearly In The Era of AI: Full Course (5 Hours)](https://www.youtube.com/watch?v=QLLuZbuTIRc)。以下使用真实 YouTube 页面及播放器，无页面或网络响应夹具。

- 问题重现：字幕轨地址及播放器自身字幕请求返回 HTTP 200 空正文。
- 正常点击「显示转录内容」可得到现代 `get_panel` 响应与 `transcript-segment-view-model` 节点；已据此实现原生面板后备读取。
- 生产扩展从源页面入口打开独立学习标签后，字幕由 0 增至 **2,354 条**；时间点从 **0:00 到 5:02:13**。原生面板缺少精确结束时间，所以界面和 AI 总结仍标明覆盖范围未验证。
- 点击第十条字幕 **1:19** 后，真实嵌入视频 `currentTime = 79`、`duration = 18139.561`、`paused = false`。播放器成功加载，无错误 153。
- 首次独立播放验证确认嵌入请求 HTTP 200，实际收到 `onReady` / `infoDelivery`，点击播放后进入播放状态且时间前进。

最终验证移除 Playwright 的聚焦仿真和后台节流豁免，使用原生 Chromium。源标签确认处于 `hidden`，仍成功读取 2,354 条字幕；学习页点击跳转后媒体 `readyState = 4`、`currentTime = 79.016777`，正常播放。

本地证据：`test-results/live-extension/run-nBBz30/evidence.json`、`captions-loaded.png`、`learning-seek.png`。独立播放器报告 `test-results/real-learning-CQnXHT/diagnostics.json`。这些原文截图不是 AI 翻译效果图。

集成测试截图与真实导出文件位于 `test-results/e2e/extension-independent-lear-fbca6-translation-Q-A-and-exports/`；其中视频和 AI 内容为测试样例。

## 范围与兼容性

XMind 官方开源读取器已实际重开生成文件，验证 25 个章节、76 个节点、多语种文本、四小时以上时间点和来源链接，见 [兼容性报告](xmind-validation.md)。未验证桌面版编辑保存。PDF 曾使用独立 PDF 引擎渲染检查，两页中文、时间点、来源及 Prompt 显示正常。

另一个 TED 视频在测试会话中仍无法取得转录内容。单条用户视频成功不能证明所有视频、地区、账户都能自动读取；失败提示、重新读取和 SRT / VTT 导入仍保留。无字幕视频尚未接入音频转写。

发布包 `release/sidenote-0.3.0.zip` 含 17 个文件，逐个比对与最终 `dist` 一致；SHA-256：`4ebb94bef05a28f0552526b97fcc7e7c99c777dea1275865c94bcb7b7da90f3d`。

未使用付费 API Key，未验证外部模型的质量、费用或响应时延；未进行商店审核、所有地区兼容性或长时间真实课程消耗测试。
