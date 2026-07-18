# Proposal：Chat 模式接入飞书（双向同步 + 流式卡片）

> 2026-07-18 方案讨论定稿（用户拍板）。范围：**只做 chat 模式**（task 模式将来再议）；
> chat 范围内**不设二期、一期全量交付**（决策 #9）。
> 目标体验：像 cursor-feedback 一样——AI 回复实时推到飞书私聊（流式卡片打字机），
> 用户在飞书里回复能直接续接会话；app 和飞书两边谁先回都行、状态一致。

## 一、已拍板的决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | app 侧用户消息回显到飞书 | **嵌进回复卡片顶部引用块**（「💬 你在 app：xxx」），不单发消息 → 每轮固定只有一条飞书消息（回复卡片创建时），不因回显翻倍震动 |
| 2 | 多 chat 并行时飞书消息路由 | **回复锚定**（飞书「回复」某张卡片 → 精确映射到该 chat）；直接发消息时：只有 1 个活跃 chat 就直接进、多个则 bot 回一条提示让用户回复指定卡片 |
| 3 | 推送开关粒度 | **只做全局开关**（设置页），chat 级开关不做 |
| 4 | 前置条件引导 | 设置页做引导检查：CLI 登录 + scope 逐项探测 + bot 私聊会话已建立，缺项给深链一键直达（详见 4.4b） |
| 5 | 卡片形态 | **思考过程折叠面板（默认收起）+ 正文流式打字机 + header 实时状态行**，参考 Hermes 飞书流式卡片插件的分区设计 |
| 6 | 推送范围 | 只推「AI 回复」这一轮内容；工具调用进折叠区完整 timeline + header 实时显示当前工具（决策 #9 后升级，Hermes 式） |
| 7 | 消息类型覆盖 | app 能发/能收的全部类型都有映射或明确降级（见 4.5 矩阵）：文本 / 图片 / 本机路径附件 / @文件 / skill / ask_user 提问 / 错误态 |
| 8 | ask_user 交互按钮 | **进一期**（用户拍板）：选项渲染成卡片按钮，点按钮直接答题；自由文本回复通道并存 |
| 9 | 交付节奏 | **不设二期、一期全量做完**（用户拍板）：含工具调用完整 timeline、飞书侧命令词。范围外只剩 task 模式（用户明确本期只做 chat） |
| 10 | 飞书应用复用 | **复用 lark-cli `config init` 时创建的那个自建应用**，不新建：bot 身份 = appId+appSecret 自动获得、无需额外登录；只需去开放平台后台给它补 scope（设置页引导直达，见 4.4b） |
| 11 | 飞书侧发起新对话 | **做**：0 个活跃 chat 时直接发消息自动新建 chat（用默认 workdir/model）；`/new` 强制开新对话 |
| 12 | assistant 回复里的本地图片 | **出向也上传**（与入向对称）：流式期间占位「[图片上传中…]」、finalize 时替换为 img_key 真图；上传失败降级「[图片：仅 app 内可见]」 |
| 13 | `/list` 命令词 | **做**：列出当前活跃 chat（标题 + 状态），配合多 chat 路由 |
| 14 | 防睡眠 + 断线补拉 | **做**（借鉴 cursor-feedback-extension）：仅接电源时阻止系统睡眠、电池供电不生效不偷电（mac `caffeinate -s` / win `SetThreadExecutionState`，见 4.4c）；**防睡眠做成独立设置项**（`feishuBridgeKeepAwake`，默认开，用户可关）；断线补拉无副作用、不做开关——consumer 重连后用 im 历史消息 API 补拉断线窗口内的 p2p 消息、按 message_id 去重后注入 |
| 15 | 完成时通知 | **不追加**「✅ 完成」小消息（用户拍板选 a）：每轮只在卡片创建时通知一次，完成态靠卡片 header/未读红点体现 |
| 16 | emoji 表情回执 | **做**：bot 给用户消息点表情做轻量回执（不发新消息不震动）——注入成功 **GET**（用户指定）、进队列 ⏳、失败 ❌（另附错误提示消息） |
| 17 | `/status` `/help` | **做**：`/status` 回桥接健康状态（consumer 存活/活跃 chat 数/上次推送时间）；`/help` 列命令清单 |
| 18 | 卡片深链回 app | **做**：Flowship 注册自定义 URL 协议（`flowship://tasks/<id>`），卡片 footer 放「在 app 中打开」链接；桌面点击直达对应 chat，手机点击无动作 |
| 19 | app 常驻 | **做**（用户拍板「cmd+W 一按就关了确实不太好」）：关窗不退出、退到菜单栏/系统托盘驻留（Tray），点击恢复窗口；设置页可选「开机自启动」（`app.setLoginItemSettings`）；真正退出走 Tray 菜单或 Cmd+Q |
| 20 | 飞书撤回同步出队 | **做**：订阅撤回事件（`im.message.recalled_v1`），消息还在队列（agent 忙未注入）→ 从队列移除；已注入的无法撤、不处理 |
| 21 | `/history [n]` | **做**：拉该 chat 最近 n 轮对话摘要发到飞书（默认 3 轮），在外接手老对话时补上下文 |
| 22 | 双平台兼容 | **全部功能 Windows + macOS 都要好使**（用户拍板）：防睡眠、深链、Tray、自启、CLI 调用逐项做平台适配（见 4.6） |
| 23 | header 耗时心跳 | **做**：长轮次时 header 显示已耗时（「🔧 执行工具(12)·已运行 3m20s」），随既有节流更新顺带刷、不额外请求 |
| 24 | 错误卡片重试按钮 | **做**：agent 出错 finalize 的红卡带「重试」按钮（点击重发上一条用户消息），复用按钮回调基建 |

## 二、能力调研结论（已验证）

### 2.1 飞书流式卡片（CardKit OpenAPI，官方支持）

官方场景就是「AI 大模型打字机输出」。链路四步：

1. `POST /open-apis/cardkit/v1/cards` 创建卡片实体（JSON 2.0、`streaming_mode: true`）
2. `POST /open-apis/im/v1/messages` 发 `interactive` 消息，content 挂 `card_id`
3. 流式期间反复 `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`
   传**全量文本** + **严格递增 sequence** → 飞书自动算增量、打字机逐字渲染
4. 结束时 `PATCH /open-apis/cardkit/v1/cards/:card_id/settings` 关闭 `streaming_mode`

关键性质 / 约束：

- **卡片实体与消息解耦**：发出后 14 天内可持续更新（流式、加组件、改属性），更新**不触发新通知**——只有第 2 步发消息那一下通知一次
- 限流 1000 次/分、50 次/秒 → 必须节流（见 4.3）
- 单卡 content 上限 10 万字符；`update_multi` 必须为 `true`
- 权限 scope：`cardkit:card:write`（tenant_access_token / bot 身份）
- 打字机效果条件：旧文本是新文本的前缀 → 增量打字；前缀不同 → 全量直接上屏（无动画）

### 2.2 lark-cli 能力面（本机 v1.0.68 实测）

- **没有 cardkit 一等命令**，但有裸调逃生舱：`lark-cli api <METHOD> <path> --as bot --data '<json>'`
  （已用 `--dry-run` 验证能拼出 CardKit 请求）。登录态复用 `~/.lark-cli`，**不用自己管 token**
- 发消息：`lark-cli im +messages-send --user-id ou_xxx --msg-type interactive --content '...'`
- **收消息不需要公网 webhook**：`lark-cli event consume im.message.receive_v1 --as bot`
  走本地 event bus daemon 长连接，stdout 输出 NDJSON、stderr 有 ready 标记
  （`[event] ready event_key=...`），天生适合常驻子进程
- 必须用 **bot 身份**发（`--as bot`）：飞书全系「不通知操作人自己」，
  用本人 user 身份发给自己永远收不到通知（meegle @ 通知踩过同款坑）

### 2.3 现有代码挂点（子代理摸底结论）

- **出（推送）**：chat 的流式已有现成事件——`chat-runner.ts` 流式期间发
  `assistant_delta`（ephemeral SSE）、完成落 `assistant_message` + `done`；
  server 内可用 `subscribeTaskStream(taskId, listener)`（`task-stream.ts`）旁路订阅，
  不用动状态机
- **入（注入）**：复用现有内部函数，**不新造 send 逻辑**：
  - chat 自由消息 → `chat-runner.ts` 的 `sendChatMessage`（agent 忙时 `enqueueChatMessage`
    入队，`CHAT_QUEUE_MAX=5`，现成逻辑）；无会话冷启动 → `runChatSession(bootArgs)`
  - 注入后落 `user_reply` 事件 → app UI 自动看到这条飞书来的消息（两边状态一致）
- **通知降噪参考**：`task-attention-watcher.tsx` 已有「窗口前台不弹系统通知」逻辑，
  飞书通道独立于它、不互相影响

## 三、架构

```text
出（app → 飞书）
  chat-runner 流式回复
    → subscribeTaskStream 旁路（assistant_delta / done）
    → FeishuCardStream（每轮一张卡片）
        创建卡片实体（含回显引用块 + 折叠思考区 + 正文）
        → im 发 interactive 消息（↞ 唯一一次通知）
        → 节流 PUT 流式更新正文 / 思考区
        → done 时 finalize（header 置「完成」、关 streaming_mode）
    → 记录 cardId / messageId ↔ taskId 映射（落盘）

入（飞书 → app）
  常驻子进程 lark-cli event consume im.message.receive_v1 --as bot
    → 过滤：仅 p2p + 发送人是本人 open_id
    → 路由：
        带 root_id（回复某卡片）→ 查映射 → 精确命中 taskId
        直接发 → 活跃 chat 唯一 → 进；0 个 → 自动新建 chat；
                多个 → bot 回提示「请回复对应卡片」
    → pending ask？→ ask-reply；否则 sendChatMessage / enqueueChatMessage（复用现有链路）
    → 落 user_reply 事件 → app UI 同步显示

  常驻子进程 lark-cli event consume card.action.trigger --as bot（ask_user 按钮）
    → 解析按钮 value（taskId/askId/questionId/optionId）
    → ask-reply → PATCH 卡片置「✅ 已选」

  常驻子进程 lark-cli event consume im.message.recalled_v1 --as bot（撤回）
    → 被撤消息还在队列 → 出队 + 撤 ⏳ 回执
```

## 四、详细设计

### 4.1 卡片结构（JSON 2.0）

```jsonc
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true,
    "update_multi": true,
    "streaming_config": {
      "print_frequency_ms": { "default": 70 },
      "print_step": { "default": 1 },
      "print_strategy": "fast"
    }
  },
  "header": {
    // 状态行随阶段更新，长轮次带已耗时（随既有节流刷新顺带更新、不额外请求）：
    // 🤔 思考中… / 🔧 执行工具(12)：Shell·已运行 3m20s / ⏸ 等你回答 / ✅ 完成
    "title": { "tag": "plain_text", "content": "<chat 标题>" },
    "subtitle": { "tag": "plain_text", "content": "🤔 思考中…" },
    "template": "blue" // 完成后切 green、出错切 red
  },
  "body": {
    "elements": [
      // ① 回显引用块（仅 app 侧发起本轮时存在）
      { "tag": "markdown", "element_id": "md_quote", "content": "> 💬 你在 app：xxx" },
      // ② 「思考与工具」折叠面板（默认收起、流式更新，Hermes 式 timeline）
      //    思考段落与工具调用行按时间顺序混排：
      //    🧠 思考文本… / 🔧 Shell：pnpm typecheck ✓ / 🔧 Read：src/lib/foo.ts ✓
      {
        "tag": "collapsible_panel",
        "element_id": "panel_process",
        "expanded": false,
        "header": { "title": { "tag": "markdown", "content": "🧠 思考与工具" } },
        "elements": [
          { "tag": "markdown", "element_id": "md_process", "content": "" }
        ]
      },
      // ③ 正文（最终回复、打字机流式）
      { "tag": "markdown", "element_id": "md_answer", "content": "" },
      // ④ footer：耗时 / 模型（完成时填充）+「在 app 中打开」深链
      //    flowship://tasks/<id>（Electron 壳注册自定义协议、路由到对应 chat 页）
      { "tag": "markdown", "element_id": "md_footer", "content": "" }
    ]
  }
}
```

- 一轮回复 = 一张新卡片（Hermes 同款「一轮一卡」）
- 过程区和正文是两个 element，各自独立流式更新（共用同一张卡的递增 sequence）
- 工具调用双呈现：**timeline 进折叠区**（工具名 + 关键参数摘要一行 + 成败标记，
  不放全量输出）+ **header subtitle 实时显示当前动作**（如「🔧 Shell：pnpm lint」）；
  工具全量输出不推飞书（太大、app 内看）

### 4.2 出向：FeishuCardStream

新模块 `src/lib/server/feishu-bridge/`：

| 文件 | 职责 |
|------|------|
| `lark-api.ts` | `execFile` 封装 lark-cli：`larkApi(method, path, data)`（裸调 CardKit）、`sendCardMessage(userId, cardId)`；串行队列防并发打爆 CLI |
| `card-stream.ts` | 单轮卡片生命周期状态机：`start(taskId, echo?)` → `pushProcess(fullText)`（思考+工具 timeline 混排）/ `pushAnswer(fullText)` / `setHeaderAction(text)` → `appendAskUser(questions)` → `finalize(ok, stats)`；内部节流 + sequence 管理 |
| `card-map.ts` | `cardMessageId ↔ taskId` 映射，落盘 `<dataRoot>/feishu-bridge/card-map.json`（进程重启后回复锚定仍可用；只留最近 N 条防膨胀） |
| `outbound.ts` | 订阅逻辑：全局开关开启时对每个 chat task `subscribeTaskStream`，把 `assistant_delta` / `thinking` / `tool_call` / `tool_result` / `ask_user_request` / `done` / `error` 翻译成 card-stream 调用 |

节流策略（抄 Hermes 默认值）：**250ms 或攒够 600 字符先到先 flush**，
远低于 50 次/秒限流；`sequence` 单卡内严格递增（一个计数器）。

### 4.3 入向：FeishuInbound

| 文件 | 职责 |
|------|------|
| `inbound.ts` | 常驻子进程管理：spawn **三个** consumer（一进程一 EventKey）——`im.message.receive_v1`（私聊消息）+ `card.action.trigger`（卡片按钮回调）+ `im.message.recalled_v1`（撤回同步出队），均 `--as bot`；等 stderr ready 标记再认为就绪；stdin 保持打开（EOF = 优雅退出，**不能** `</dev/null`）；崩溃退避重启；app 退出时优雅 stop（不 kill -9，避免漏退订） |
| `router.ts` | 消息路由：解析 NDJSON → 过滤 p2p + 本人 open_id → 按 root_id 查 card-map / 按活跃 chat 数兜底 → 调 `sendChatMessage` / `enqueueChatMessage` → 失败时 bot 回一条错误提示 |
| `card-action.ts` | 按钮回调处理：按 value 里的 action 类型分发——ask_user 答题（taskId/askId/questionId/optionId → `ask-reply` → PATCH 卡片置已答态）、错误重试（taskId + 原消息 → 重发 → PATCH 卡片置「重试中」） |

路由规则细化：

1. 消息带 `root_id`（用户用了「回复」）→ card-map 命中 → 注入对应 task
2. 直接发消息：
   - 活跃 chat（runStatus 非终态、最近 24h 有动静）恰好 1 个 → 直接注入
   - 0 个 → **自动新建 chat**（默认 workdir/model 走 config.json，标题取消息前缀），
     bot 回「已开新对话：xxx」后正常注入（决策 #11）
   - ≥2 个 → bot 回「有 N 个进行中的对话，请回复对应卡片来指定」（列出各 chat 标题）
3. agent 正忙 → `enqueueChatMessage`（现成）；队满 → bot 回提示
4. 注入成功后落 `user_reply` 事件（带来源标记，如 `meta.source: "feishu"`），app UI 同步可见
5. **emoji 回执**（决策 #16，reaction API、不发消息不震动）：注入成功给用户消息点
   **GET**、进队列点 ⏳、失败点 ❌（另附一条错误提示说明原因）

### 4.4 入向路由与 ask_user（细化）

chat 模式里 agent 也会内联提问（`ask_user_request`）。ask_user 的答题有**两条并存通道**：

**① 卡片按钮（主通道）**：`ask_user_request` 到达时，卡片追加问题文本 + 选项按钮
（button 组件，`value` 内嵌 `{ taskId, askId, questionId, optionId }`）。
用户点按钮 → 飞书回调 `card.action.trigger` 事件 → 从 value 取出参数 →
走 `ask-reply`（校验 askId/token 复用现有逻辑）→ 答完 **PATCH 卡片**：
按钮区替换为「✅ 已选：xxx」、header 恢复流式状态。

**② 自由文本（并存兜底）**：入向文本消息在「定位到 taskId」后分一层：

1. 该 task 有 pending ask → 走 `ask-reply`（回序号选选项、或直接打字答开放性问题）
2. 无 pending ask → 走 `chat-reply`（agent 忙则入队）

pending ask 判定复用现有 `getPendingAsk(taskId)`（注意它是进程内存态，服务重启后
按「无 pending」兜底走 chat-reply，agent 收到消息也能自己接上，可接受）。

按钮与文本竞态：先到先得——`ask-reply` 现有的 askId/token 一次性校验天然防重复提交，
后到的一方 bot 回「该问题已回答」提示（按钮侧则 PATCH 卡片体现已答态）。

### 4.4b 设置页（全局开关 + 引导检查）与飞书应用复用

**应用复用（决策 #10）**：桥接直接复用用户在 lark-cli `config init --new` 时创建的
那个自建应用，**不新建应用**：

- bot 身份（tenant_access_token）由 appId + appSecret 自动获得，无需 `auth login`
  （lark-shared skill 明文：bot 只需后台开通 scope）
- 该应用大概率已具备部分 im scope（lark-cli init 流程授权过），缺的按需补
- lark-cli 权限报错会返回 `console_url`（直达开放平台后台权限页）+
  `permission_violations`（缺哪些 scope）——引导检查直接把这个链接给用户点

桥接所需 scope 清单（引导检查逐项探测）：

| scope | 用途 |
|-------|------|
| `im:message:send_as_bot` | bot 发私聊消息/卡片 |
| `im:message`（接收相关） | event consume 收私聊消息 |
| `cardkit:card:write` | 创建/流式更新卡片实体 |
| `im:resource`（图片/文件） | 上传回显图片、下载飞书图片/文件 |

另需应用开启**机器人能力**（bot capability，开放平台后台应用功能页勾选）——
没有 bot 能力收不到 p2p 消息，引导检查探测失败时提示去后台开。

**「免后台手动设置」的可行边界（2026-07-18 调研，用户诉求：别让用户去后台点）**：

- 完全零后台操作**做不到**——飞书平台安全设计：应用权限变更、机器人能力开关
  都没有开放「静默修改」的 API（`scopes/apply` API 只是把审批单推给租户管理员，
  不是直接生效）
- 但能压到**「点一个链接 → 点一次确认」**：开放平台支持权限预填深链
  `https://open.feishu.cn/app/<appId>/auth?q=<逗号分隔scopes>&op_from=openapi&token_type=tenant`
  ——打开就是勾好的权限列表，用户点「确认开通」即可，不用自己找。引导检查
  用这个深链（lark-cli 权限报错返回的 `console_url` 就是同形态）
- **只按免审权限设计**（用户拍板）：桥接用到的 scope（im 收发 / cardkit /
  im:resource）都按「点完立即生效」处理，引导检查做成「点完回来点重试」；
  不为「需审核权限 + 管理员审批」做任何流程设计——真遇到某租户把这些 scope
  配成需审核，检查项保持红灯 + 提示原因即可，不做审批跟踪
- 机器人能力：实现时先实测 lark-cli `config init` 建的应用是否已带 bot 能力
  （若模板已含则零操作）；没带则深链到应用功能页让用户勾一次（仅此一处
  没有预填深链可用）
- 引导检查全自动探测缺什么、只把「缺的」以深链形式给出，配好即绿

`FeishuCliSection` 下新增「消息桥接」块：

- 全局开关：`settings.feishuChatBridge`（存 `<dataRoot>/config.json`，走 local-store）
- 子开关：「插电时防休眠」`settings.feishuBridgeKeepAwake`（默认开，见 4.4c；
  标题自解释、不加 help text）
- 开启时引导检查（按序）：
  1. lark-cli 已安装已登录（现成状态探测）
  2. scope 探测：按上表试调（如建一张不发送的卡片实体探 cardkit），失败展示
     `console_url` 直达链接 + 缺失 scope 列表
  3. bot 私聊会话存在：试发/探测失败（`P2P chat not found`）→ 提示「请在飞书里给
     bot 发一条任意消息建立会话」
- 检查项 UI 复用 setup-checklist 的样式惯例
- **全绿时 bot 主动发一条欢迎消息**（含命令清单）——既是绑定成功确认、
  也顺手建立/验证私聊会话，用户马上能回一句试链路

### 4.4c 防睡眠 + 断线补拉（决策 #14，借鉴同级仓库 cursor-feedback-extension）

cursor-feedback-extension 实测验证过的「锁屏/合盖还能用」组合拳，直接抄：

- **防睡眠（主手段，独立设置项，双平台）**：
  - macOS：spawn `/usr/bin/caffeinate -s`——`-s` 语义本身就是「仅接电源时阻止
    系统睡眠」，电池供电自动不生效（不偷电），进程退出断言自动释放
  - Windows：spawn PowerShell 调 Win32 `SetThreadExecutionState(ES_CONTINUOUS |
    ES_SYSTEM_REQUIRED)`；该 API 不区分电源，脚本内每 30s 轮询电池状态、
    接电才持有断言、拔电立即释放（两个实现都直接抄 cursor-feedback-extension
    的 `keep-awake.ts`，它已双平台验证过）
  - 子进程意外退出 10s 后拉起。锁屏 ≠ 睡眠，锁屏本来就不断网——接电 +
    防睡眠断言后合盖也能持续收发。
  - 设置项 `settings.feishuBridgeKeepAwake`（默认开）：桥接开 + 该项开才 spawn，
    任一关掉即停——「插电时整机不睡」是可感知的系统行为变化，留给用户选。
- **断线补拉（兜底）**：电池合盖 / 网络抖动等场景长连接会断。consumer 重连
  ready 后，用 im 历史消息 API（`im/v1/messages` list，按 chat_id + 时间窗）
  补拉断线窗口内的 p2p 消息，按 message_id 去重后走正常路由注入——
  避免「睡醒了但消息已丢、用户还得重发」。
- 记录「最后处理的消息时间戳」落盘（跟 card-map 同目录），补拉窗口从它算起。

### 4.5 消息类型映射矩阵（app chat 能发/能收的全部类型）

app chat 输入 payload 全集（`chat-reply` 请求体）：`text` 文本、`images[]` 图片
（base64，≤6 张 / 单图 10MB / 整批 30MB，服务端落盘 `uploads/`）、`attachments[]`
本机绝对路径（picker 附文件/目录，≤10）、`skills[]`（`/skill` 引用，≤8）；
文本内还可能含 `@rel/path` 文件引用（纯文本、服务端无特殊解析）。
assistant 侧事件：`assistant_message/delta` markdown、`tool_call/result`、`thinking`、
`ask_user_request`（chat 里也会内联提问）、`compact_summary`、`error`。

#### 出向（app → 飞书卡片）

| 类型 | 映射 | 降级 |
|------|------|------|
| 用户文本 | 回显引用块（决策 #1） | — |
| 用户图片 | 从 `uploads/` 上传飞书取 img_key、嵌进引用块下方（卡片 markdown 支持 `![](img_key)`） | 上传失败 → 「📎 N 张图」文字摘要 |
| 用户 attachments（本机路径） | 引用块内列路径文本 +「仅本机可读」——飞书侧无法访问本机路径，不假装可点 | — |
| `@rel/path` / `/skill` | 文本原样保留在引用块 | — |
| assistant markdown 正文 | 正文 element 流式打字机 | — |
| assistant 正文里的本地图片 | 流式期间先占位「[图片上传中…]」（避免破坏打字机前缀条件），finalize 时上传飞书取 img_key 替换为真图（此刻全量上屏一次、可接受） | 上传失败 → 「[图片：仅 app 内可见]」 |
| thinking | 「思考与工具」折叠面板流式 | — |
| tool_call / tool_result | 折叠面板 timeline 一行（工具名 + 参数摘要 + ✓/✗）+ header 实时当前动作；全量输出不推 | — |
| **ask_user 提问** | 追加到当前卡片：问题文本 + **选项渲染成交互按钮**（button 组件，value 内嵌 `taskId/askId/questionId/optionId`）；header 置「⏸ 等你回答」；自由文本回复仍可用（打字答开放性问题） | 按钮回调链路异常时降级为「回复序号」文本模式 |
| compact_summary | 不推 | — |
| error | header 置红 + 错误一行 + **「重试」按钮**（点击重发上一条用户消息，走按钮回调基建） | 按钮链路异常时用户手动重发 |

#### 入向（飞书 → app）

| 类型 | 映射 | 降级 |
|------|------|------|
| 文本 | 有 pending ask → 走 `ask-reply`（答案文本/序号）；否则 → `chat-reply` text | — |
| 图片 | lark-cli 下载 → base64 → `images[]`（沿用 6 张/10MB/30MB 限制） | 超限 → bot 回提示 |
| 富文本 post | 提取文本 + 图，按上两行处理 | 其余元素丢弃 |
| 文件 | 下载到 `uploads/` → 以绝对路径进 `attachments[]` | 超大 → bot 回提示 |
| `/skill` 文本 | 解析命中本机 skill → 补 `skills[]` 字段；未命中当普通文本 | — |
| **命令词** | 保留字优先于 skill 解析：`/stop` 停止当前 run、`/compact` 压缩会话、`/new [首条消息]` 强制开新 chat、`/list` 列出活跃 chat（标题+状态）、`/history [n]` 最近 n 轮对话摘要（默认 3）、`/status` 桥接健康状态、`/help` 命令清单；执行后 bot 回执行结果 | 未知 `/xxx` 走 skill/普通文本路径 |
| **撤回消息** | 订阅 `im.message.recalled_v1`：被撤消息还在队列 → 移除并撤掉 ⏳ 回执；已注入 → 不处理 | — |
| 其他类型（表情包/语音等） | bot 回「暂不支持该消息类型」 | — |

#### 回显细节

- 用户在 **app** 发消息 → 本轮卡片顶部带引用块（决策 #1）
- 用户在 **飞书** 发消息 → 飞书里本来就有这条消息，卡片不带引用块；app 侧靠
  `user_reply` 事件显示，气泡带飞书来源小图标（`meta.source: "feishu"`），
  一眼区分「在外面发的」
- 排队消息：agent 忙时攒了多条 → 下一轮卡片引用块合并显示

### 4.6 双平台兼容（决策 #22，Windows + macOS 逐项对照）

| 功能 | macOS | Windows |
|------|-------|---------|
| 防睡眠 | `caffeinate -s` | PowerShell `SetThreadExecutionState` + 30s 电池轮询（见 4.4c） |
| 深链 `flowship://` | `app.setAsDefaultProtocolClient` + `open-url` 事件 | 同 API（写注册表）+ **`second-instance` 事件从 argv 取 URL**（Windows 深链是拉起第二实例传参、不是事件）；单实例锁已有、顺手接 |
| Tray 常驻 | 菜单栏 `Tray`（模板图标适配深浅色） | 系统托盘 `Tray`（.ico 图标）；关窗 `hide()` 双平台一致，真退出走 Tray 菜单 |
| 开机自启 | `app.setLoginItemSettings` | 同 API（写 Run 注册表键）；设置页同一个开关 |
| lark-cli 调用 | `tools/bin/lark-cli` | `tools/bin/lark-cli.exe`（feishu-cli.ts 现有安装链已处理平台后缀，桥接统一走它暴露的二进制路径） |
| event consume 子进程 | spawn + stderr ready 标记 | 同；注意 Windows 下优雅退出用 stdin EOF（不能发 SIGTERM 语义信号） |
| caffeinate/PowerShell 路径 | `/usr/bin/caffeinate` 写死 | `powershell.exe` 走 PATH；两端都判 `process.platform` 分支 |

## 五、边界与坑（实现时必须处理）

1. **sequence 严格递增**：同一张卡所有更新（thinking + answer + header）共用一个
   单调计数器；乱序会被飞书拒绝
2. **打字机前缀条件**：`PUT content` 传全量文本且旧文本必须是新文本前缀——
   流式期间**不要回改已推送的文本**（如后处理去尾空格），否则动画退化为全量上屏
3. **半截代码块**：飞书对未闭合围栏渲染成 raw markdown。可接受瞬时半截
   （下次 flush 会补上）；如效果差，flush 时检测未闭合 ``` 就临时补一个闭合围栏
4. **test / 正式双实例重复消费**：两个实例（8776 + 8876）同时跑 `event consume`
   会重复收消息、重复注入。约定：**桥接开关只在一个实例上开**；实现上给
   inbound 加启动检查（探测同 event key 是否已有 consumer，`lark-cli event status`），
   已被占用则拒绝启动并在设置页提示。**跨机器同理**：两台电脑都跑 Flowship 开
   桥接会抢同一应用的事件流（分发行为未定义）——约定只在一台机器上开，
   `/status` 输出带机器名方便识别被谁占用
5. **进程生命周期**：event consume 子进程要纳入 kill-orphans 体系；崩溃指数退避重启；
   ready 标记未出现视为启动失败
6. **身份安全**：只处理 `sender.open_id == 本人 open_id` 的 p2p 消息（本人 open_id
   从 lark-cli 用户身份接口取一次并缓存）；其他人发给 bot 的消息一律忽略
7. **卡片 14 天有效期**：card-map 里的旧映射过期后回复锚定失效 → 兜底走「活跃 chat
   数量判断」路径，不报错
8. **无会话冷启动**：飞书消息进来时 chat 无 agent 会话 → 复用 chat-reply 的
   bootArgs 路径（apiKey/model 从 config.json 取）；boot 失败 bot 回错误提示
9. **飞书消息类型**：按 4.5 入向矩阵处理（text / 图片 / post / 文件 / skill）；
   矩阵之外的类型（表情包、语音等）bot 回「暂不支持」，不静默丢
10. **错误可见性**：出向推送失败（限流/网络）静默降级不影响 app 主流程，
    但要记 log；连续失败 N 次在 app 内 toast 提示桥接异常
11. **按钮回调应答机制**：飞书交互卡片回调若不及时应答、用户侧按钮会转圈/报超时。
    实现时先验证 lark-cli 长连接模式下 `card.action.trigger` 是否自动 ack；
    若不自动，点击后立即 PATCH 卡片（置「处理中…」再置已答态）作为视觉应答兜底；
    整条链路走不通则退回「回复序号」文本答题（4.5 矩阵的降级路径）
12. **按钮回调也要校验身份**：p2p 卡片可被转发，别人点按钮回调照样进来——
    `card.action.trigger` 处理时校验 operator open_id == 本人，非本人忽略
13. **超长回复**：单卡 content 上限 10 万字符；接近上限时正文截断 +
    尾部固定一行「内容过长，完整回复在 app 内查看」
14. **reaction emoji 键名**：飞书 reaction API 用 `emoji_type` 枚举键，实现时对照
    官方表情键名表确认 GET/⏳/❌ 对应键（GET 不在 reaction 可用列表时挑最接近
    的替代并告知用户）；reaction 失败静默降级（回执是锦上添花、不影响注入）
15. **深链协议**：`flowship://` 注册后要处理「app 未运行时点击」（macOS 会拉起
    app，启动完成后再路由）；URL 参数只带 taskId、不带敏感信息
16. **补拉窗口上限**：断线太久（如 >30 分钟）不做全量补拉注入——旧消息一股脑
    灌给 agent 只会乱；超窗丢弃 + bot 回「离线期间有 N 条消息未处理，需要的话
    重新发」

## 六、实施步骤（可派活拆分）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| S1 | `lark-api.ts` + `card-stream.ts`：CardKit 裸调封装 + 单轮卡片状态机 + 单测（mock execFile） | 无 |
| S2 | `outbound.ts`：subscribeTaskStream 旁路 → 卡片推送；含回显引用块（文本+图片）、思考与工具 timeline、header 实时动作、正文本地图片 finalize 上传 | S1 |
| S3 | `inbound.ts` + `router.ts`：常驻 consume 子进程（三个 EventKey，见 4.3）+ 路由注入（文本/图片/文件/skill/命令词，全集见 4.5）+ 0 活跃自动新建 chat + card-map + 防睡眠（双平台）+ 断线补拉 + 单测（路由规则/命令词解析） | S1（card-map 写入在 S2） |
| S3b | `card-action.ts`：ask_user 按钮 + 错误重试按钮渲染（S2 侧出卡）+ `card.action.trigger` 回调分发 → ask-reply / 重发 → 卡片置终态 | S2 + S3 |
| S3c | emoji 回执（GET/⏳/❌ reaction）+ 命令词全套（`/history` 摘要、`/status` `/help` 等）+ 撤回出队 consumer | S3 |
| S4 | 设置页开关（含防休眠子开关、开机自启开关）+ 引导检查（scope 探测 + console_url 直达 + bot 会话检测）+ config.json 字段 | 可与 S2/S3 并行 |
| S4b | Electron 壳：`flowship://` 协议注册（mac open-url / win second-instance）+ 路由到对应 chat 页；卡片 footer 深链（S2 侧拼 URL） | 可独立并行 |
| S4c | Electron 壳：Tray 常驻（关窗不退出、托盘菜单）+ 开机自启（`setLoginItemSettings`），双平台 | 可独立并行 |
| S5 | 联调冒烟：test 实例真发真收（含点按钮答题、图片双向、命令词、撤回出队、深链、Tray；注意双实例消费坑 #4）；Windows 侧至少过一遍防睡眠/深链/Tray 冒烟 | S1–S4c 全部 |

S1 可先行；S2/S3 相互独立可并行派两个子代理；S4/S4b/S4c 独立；S3b/S3c 在 S2/S3 汇合后做。

## 六b、S5 真联调实测结论（2026-07-19 凌晨，开发时回写）

冒烟环境：worktree standalone 产物 + 独立 dataRoot（/tmp，端口 4123，不碰正式/test 实例）。

1. **出向全链路真跑通**：chat 消息 → agent 流式回复 → 飞书流式卡片（打字机）→
   finalize，零失败；ask_user 提问 → 卡片追加按钮成功
2. **emoji 键名实测**（坑 #14 落定）：`Get`（GET 非法）/ `Typing`（无 Hourglass）/
   `CrossMark`
3. **CardKit element_id 硬约束**（新坑，已修）：字母开头、≤20 字符——askId 直拼必超，
   按钮/问题 element_id 改短哈希（card-stream/card-action 单一来源 helper）
4. **bootstrap 不能挂 instrumentation**（新坑，已修）：instrumentation 的 webpack
   bundle 不吃 serverExternalPackages，桥接模块图静态引到 @cursor/sdk 会
   ModuleParseError 毒化全部路由 → 改挂 /api/tasks 与 /api/feishu-bridge/status
   route 模块加载
5. **scope 实况**：lark-cli init 建的应用没有大 `im:message`，只有细分
   `im:message:readonly` / `im:message.p2p_msg:readonly`——实测收消息可用，
   探测按等价表放行（cardkit:card:write / im:resource / send_as_bot 都已有，
   **用户零配置**）
6. **card.action.trigger 需要一次性订阅回调**：应用后台没订阅时 consumer 退出、
   CLI 给扫码订阅链接——已做成 `unsupported` 态 + 设置页「去订阅」按钮；
   订阅完 30s 轮询自动恢复（这是按钮回调唯一的一次性人工步骤）
7. **im.message.recalled_v1 当前 lark-cli（1.0.68）不支持**：consumer 标记
   optional + unsupported、优雅降级不拖整体状态；CLI 更新收录后自动恢复

## 七、范围外（决策 #9：不设二期，一期全量；以下是明确不做/后议的）

- **task 模式接入**：用户明确本期只做 chat；将来接入时直接复用本期的卡片流式 +
  按钮回调基建
- **chat 级开关**：决策 #3 拍板只做全局开关（不是延期、是不做）
- **每 chat 独立话题群模式**：决策 #2 拍板走回复锚定（不是延期、是不做）
