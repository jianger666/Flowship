# 项目 Agent 工作规则

## 借 Cursor 识图（无视觉能力的模型）

- 当当前模型没有图像输入能力、但需要识别图片（截图、界面选项、报错画面等）时，借用 `cursor-delegate` 让 Composer 2.5 识图，而不是直接回"看不了"。
- 图片获取：
  1. DSH 宿主已配置文本模型图片兜底（`textModelImageFallback: save-to-inbox`、`imageInboxDir: .agents/tmp-vision`）：用户贴图发送后，当前模型会收到一条插件源通知，其中包含图片已保存到 `.agents/tmp-vision/` 的文件相对路径，直接使用该路径即可。
  2. 其他宿主或通知缺失时，请用户提供图片文件路径。
- 清理机制：每次识图前先清空 `.agents/tmp-vision/` 内残留的旧图片（目录已入 `.gitignore`；DSH 侧另有 24 小时 TTL 兜底清理）；简报中使用相对工作区路径；worker 沙箱只允许读写工作区，不要把工作区外的路径直接交给它。
- 执行 `node .agents/skills/cursor-delegate/scripts/run-cursor-agent.mjs --workspace <绝对路径> --task <简报>`；简报需说明：这是只读识图任务、图片相对路径、用户的具体问题，并要求逐项详细描述图片内容（文字、选项、状态、高亮等）。
- 把 worker 返回的识别结果转述给用户；无论成功还是失败，本轮结束后删除对应临时图片，保证 `.agents/tmp-vision/` 只在任务进行中存在文件。
- 识图结果是辅助证据：转述时说明来自 Composer 委派，不要声称是当前模型亲自看到。
- 截图可能包含客户数据或其他秘密时，先向用户确认再委派（图片会发送给 Cursor 服务）；worker 返回 `ok: false` 时如实报告，不要编造识别结果。

## 打包 / 验证流程（默认网页热更，用户要求打 app 才打包）

### 三端口约定

| 端口 | 服务 | 说明 |
|---|---|---|
| **8776** | FlowshipTest 桌面包 | 测试 App 内嵌 server，`pnpm electron:test:restart` 重启后就是它 |
| **8876** | Flowship 正式桌面包 | 正式 App 内嵌 server（别动） |
| **8676** | test 网页热更 | `pnpm dev:web`（`next dev` + HMR），日常改 UI 看它 |

> 注意：8776 是「测试桌面包」的端口、**不是**独立网页服务。想网页热更请走 `pnpm dev:web`（8676），不要直接用 8876（正式包占用）或去碰打包。

### 默认：网页热更新（最快）

- **日常改 UI 验证默认走 `pnpm dev:web`**：起 `next dev --turbo` 在 **8676**，自动清掉宿主注入的 `__NEXT_PRIVATE_STANDALONE_CONFIG` / `NEXT_DEPLOYMENT_ID` / `FLOWSHIP_DATA_DIR`（前两个会让 `next build/dev` 报 `generate is not a function`，后者常被注入成正式包数据目录）、再把数据目录写死到 `fe-ai-flow-test`、起完自动开 `http://localhost:8676/settings`。HMR 秒刷新，改完 typecheck/lint 过即可让用户刷新看效果，**不打包壳**。要换端口/数据目录用 `DEV_WEB_PORT` / `DEV_WEB_DATA_DIR`，别用 `PORT` / `FLOWSHIP_DATA_DIR`。`pnpm start` 同样是 `next dev --turbo`（默认 8876，别跟正式桌面包抢端口）。
- 生产 / `next build` 仍走 webpack（发版链不动）；`next.config.mjs` 的 server 侧 `node:` externals 只给 webpack 用。开发一律 Turbopack（`turbopack.root`），不要再起无 `--turbo` 的 `next dev`。

### 打 test 包并重启（仅当需要 app 验收 / 用户明确要求）

- **用户明确要求「打 app / 打包看看」时就打**（用户不要求时默认网页热更，不要动辄打 5 分钟包）。
- test 打包和进程级重启不属于「操作 App」：授权范围仅是 **构建、组 server 布局、打 staging unpacked test 包、精确退出旧 FlowshipTest 进程、部署到规范路径、启动新 test 包**，不包含读取或操作界面。
- 一条命令：`pnpm electron:test:restart`（内部顺序：`BUILD_STANDALONE=1 pnpm build` → `pnpm electron:server` → `pnpm exec electron-builder` 打 **staging**（`dist/electron/.test-restart-staging/`、`productName=FlowshipTest`）→ 确认 staging 产物 → 退出旧 FlowshipTest → 备份并替换规范路径（mac `dist/electron/mac-{arch}/FlowshipTest.app` / win `dist/electron/win-unpacked/FlowshipTest.exe`）→ 启动规范路径新包）。仅 `electron:dist:test` 仍可用于只打 mac test 包（仍写规范路径）。
- 脚本内已固化两条修复：① spawn 前自动剔除注入的 standalone 环境变量（防 `generate is not a function`）；② 退出旧测试 App 时 osascript 优雅退出被 TCC 权限拦 / 超时，自动降级成进程级精确退出（`pkill -x FlowshipTest`，不碰正式 Flowship）。
- 命令调用：`process.execPath` + `npm_execpath` 调 pnpm，`pnpm exec electron-builder` 调 builder；禁止依赖 `pnpm.cmd` / `electron-builder.cmd` 或 shell 拼接。
- **除非用户明确要求 App UI 自动化验收或操作**，Agent 不得使用 computer-use、浏览器自动化、截图、可访问性树等方式打开、查看、点击或验收 App；启动新 test 包后直接交给用户查看，不得自行进入界面验收。
- 该流程只做进程级重启。**构建/打包失败**：旧 FlowshipTest 保持运行、脚本非零退出。**部署失败**：尽力从 `dist/electron/.test-restart-backup/` 恢复上一可用包并尝试启动旧版，再非零退出。**启动失败**：新包已在规范路径时给出明确错误。
- 只终止精确命名的 **FlowshipTest** 测试进程，不得影响正式 **Flowship** 或其他 Electron 进程。
