# XMind 文件兼容性验证

2026-09-07 已完成一次独立解析验证。验证对象是当前 `buildXMind()` 实际生成并写入磁盘的 `.xmind` 文件，使用 XMind 官方开源读取器重新打开，未将文件上传到任何服务。

## 方法与结果

1. 获取固定版本的公开 npm 包 `xmind-viewer@1.1.2` 和 `jszip@3.10.1`，校验脚本内固定的 SHA-512 完整性值。
2. 使用当前产品代码生成包含 25 个章节、76 个主题节点的人工测试文件；测试文本包含中文、日文、阿拉伯文、希伯来文、韩文、emoji、引号和尖括号。
3. 将文件写入磁盘，再由 **JSZip 独立解压并检查 CRC32**。
4. 将真实 JSZip 实例交给 **官方 `loadFromXMind()`**，随后使用 **官方 `Workbook` 构造函数**建立完整的递归主题模型。
5. 遍历官方模型，验证全部 76 个节点、章节与子节点层级、多语种原文、4 小时以上时间戳；检查读取结果中的视频位置链接、总结笔记和 Prompt。
6. 检查 ZIP 清单引用均存在，并用截断 ZIP 作为负向对照，确认读取器会拒绝损坏文件。

结果：全部断言通过。没有改动生产导出模块，也没有增加产品运行依赖。

## 重跑

在项目根目录执行：

```powershell
node --import tsx tests/compatibility/verify-xmind.ts
```

此项为独立、主动运行的兼容性检查，**不属于默认离线单元测试**。需要网络下载两个固定的公开测试工具包，以及系统 `tar` 命令。包仅解压到一次性临时目录，不安装进项目，结束后自动清理。测试文件始终在本地处理。

输出文件：

- `tests/compatibility/artifacts/multilingual-learning-notes.xmind`：实际生成的人工兼容性测试文件，不是真实视频总结。
- `tests/compatibility/artifacts/xmind-validation.json`：时间、工具版本、文件 SHA-256、节点计数和断言范围。每次重跑更新记录。

## 验证范围

这证明当前导出文件可被 XMind 官方开源读取器读取，并构建完整主题模型。它**不代表已验证 XMind 桌面版视觉布局、编辑后保存回读、所有历史版本或 XMind 8 的 XML 格式**。官方开源读取器版本较早，且不是桌面客户端的完整实现。

## 一手来源

- [XMind 官方 xmind-viewer 仓库](https://github.com/xmindltd/xmind-viewer)
- [官方读取器：xmindLoader.ts](https://github.com/xmindltd/xmind-viewer/blob/master/src/xmindLoader.ts)
- [官方主题模型：topic.ts](https://github.com/xmindltd/xmind-viewer/blob/master/src/model/topic.ts)
- [官方工作簿模型：workbook.ts](https://github.com/xmindltd/xmind-viewer/blob/master/src/model/workbook.ts)
- [官方 SDK 的 ZIP 生成规则](https://github.com/xmindltd/xmind-sdk-js/blob/master/src/utils/zipper.ts)

实际执行的是固定版本 npm 包中的原始 `dist/xmindLoader.js` 与 `dist/model/workbook.js`，未复制或替换其读取逻辑。
