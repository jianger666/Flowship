/**
 * 「本轮由群里非属主触发」的按轮次标记——给 Flowship 系统工具的硬拒闸用（见 flowship-tools.invokeFlowshipTool）。
 *
 * # 为什么需要它
 * 非属主的消息并入同一个任务会话后，会话的工具集是建会话时一次性挂好的（按 callerToken），工具 handler 只认
 * callerToken + task_id，不知道「这一轮是谁触发的」。陌生人若能诱导 agent 调 `submit_work` / `ask_user` /
 * `schedule` / `share_to_group`，就能越过提示词里的口头约束（典型链：诱导 agent `ask_user` 问属主，再自己回「确认」）。
 * 所以由发起这一轮的注入链在 `agent.send` 之前登记本标记，handler 入口按 taskId 查到就拒。
 *
 * # 两种范围（scope）
 * - `all`（默认）：设置里的「只答疑」提示词开关开着——这一轮 Flowship 系统工具整体硬拒（白名单放行），pi 还会收窄工具集。
 *   {@link isNonOwnerTurnActive} 只认这一种，原有调用方的语义不变。
 * - `desktop`：提示词开关关着（群成员与属主「同权」）——系统工具照常放行，**唯独电脑操作（desktop_*）仍然拒绝**。
 *   电脑操作是动属主的电脑（看屏幕、敲键鼠、锁屏时还会用属主的开机密码解锁），和改代码 / 推进任务不是一个量级的权限，
 *   不能随「只答疑」开关一起放开。{@link isGroupNonOwnerTurnActive} 两种范围都认。
 *
 * # 生命周期（宁可多清也别漏清——漏清 = 属主自己的 submit_work 被拒）
 * ## 登记（谁在什么时刻写标记，都在「内容交给 agent」之前）
 * - `beginNonOwnerTurn`（send 起点型标记）：
 *   · `sendToTaskSessionBody`（task-runner）在 `agent.send` 之前，非属主轮 scope=all、「所有者空 @ 引用别人」scope=desktop；
 *   · `internalStartAgent`（task-runner，新 agent 的首次 send 之前）：外来内容驱动的新启动（输入条唤醒、压缩续接接力），scope 由调用方给、缺省 desktop；
 *   · 一次性问答 agent（oneshot，task-runner）：外来内容那种，scope=desktop。
 * - `beginForeignContentMidRun`（midRun 型标记，**本轮已经在跑、中途才收到别人写的内容**——没有「send 起点」可以登记）：
 *   `ask-inject`（非属主答了 agent 挂着的 `ask_user`）、`task-question-inject` 的「顶掉提问」回写、`chat-inject`（`registerForeignMark`）、
 *   `chat-runner` 的 `runChatSession`（首包前）与 `sendChatMessage`。
 *
 * ## 清除（按「谁清」分）
 * - **按 token**——`endNonOwnerTurn(taskId, token)`（不误清后继）：只给 task 型 send 起点标记收口——`consumeSessionRun` 的最外层 finally（task-runner）；没交给 consume 的出口
 *   （send 失败 / stale / 让位）由 `sendToTaskSessionBody` 的 finally 兜；`internalStartAgent` 的 finally（没进 consume 的早退）；一次性问答 agent 的 finally。
 *   **chat 侧（chat-runner / chat-inject）与 midRun 回滚方（ask-inject / task-question-inject）对它零调用**：第十五轮评审 P3-3 起这些回滚全是下面的让位版。
 *   第十六轮评审 P3-D1：这里和 {@link beginForeignContentMidRun} 的注释原先还把 chat-inject 的回滚写在「按 token」名下（写反了，后人可能照着改回硬清），已更正，
 *   `non-owner-turn-run-alive.test.ts` 有源码钉着「这四个文件里没有 `endNonOwnerTurn` / `clearNonOwnerTurn` 调用」。
 * - **按名（只清 midRun 型）**——`endMidRunForeignContent(taskId)`：
 *   · task：`consumeSessionRun` 的最外层 finally；
 *   · chat：**主清除点是 `finalizeChatRunIfCurrent` 的 finished 分支**——在放掉 `runActive` 之前、同一个同步段里清（随后 flush 可能为排队的外来内容登记**下一轮**的标记，
 *     清除不能晚于它；清过回写 `ctx.midRunMarkCleared`，`consumeChatRun` 的 finally 据此不再做兜底的第二次清；第十六轮评审 P3-D4：此前这里漏了它）。其余出口（取消 / 报错 /
 *     重连放弃 / finalize 抛错的兜底关会话）仍由 `consumeChatRun` 的 finally 清；另有 `runChatSession` 的 finally 与 lease 失效出口，以及 `closeChatSession` 在 `reason=restart` 时
 *     （摘表者清；`forceClearChatRun` 经它走到这里，边界见下面「已知边界」）。这些 finally 看到表里是别的实例时不碰（新会话已为新的外来内容登记了标记）。
 * - **让位版回滚**——`rollbackForeignContentMidRun(taskId, token)`：登记之后被别路沿用过（`shared`）且此刻有 run 在跑就让位，其余照清；
 *   ask-inject / task-question-inject askSkip / chat-inject / `sendChatMessage` 的失主出口用它（见该函数的注释）。
 * - **按 task 无条件清**——`clearNonOwnerTurn(taskId)`（不看 token）：
 *   · `closeTaskSession` **真关到了会话**才清：没有会话（带 / 不带 `expectedSessionInstanceId` 各一个 `return`）/ agentId 不符 / 实例号不符——**三种情形、共四个 `return false`**——
 *     都在清除之前，那几种情形标记不动（第十四轮评审 P3-6 ①：此前写「无条件清」偏满；第十五轮评审 P3-6：「三处」改「三种情形四个 return」）；
 *   · 属主自己的 send 起点：task 型 `sendToTaskSessionBody` 的 `if (!opts.nonOwnerTurn) clearNonOwnerTurn`；**新 agent 的起点**同口径——
 *     `internalStartAgent` 在首次 send 之前、没带 `foreignContentTurn` 时清（第十五轮评审 P3-1）；**一次性问答 agent（oneshot）的属主启动**也一样——
 *     `startOneShotQuestion` 在首次 `sendTurn` 之前、没带 `foreignContent` 时清（第十六轮评审 P3-T1：此前外来一支登记、属主一支什么都不做，强清不再清标记之后
 *     属主的一次性问答 / 定时到点那一轮会带着旧标记跑、被白白拒 desktop_* / 写备注 / 建定时；fail-closed，所以只是 P3）。
 *     至此 `src` 里 `clearNonOwnerTurn(` 共 **四处调用**：`closeTaskSession`、`internalStartAgent`、`sendToTaskSessionBody`、`startOneShotQuestion`
 *     （`task-reconnect-keeps-marker.test.ts` 钉着个数与位置）；
 *   · **强清 `forceClearStaleRunnerState` 不清标记**（第十五轮评审 P3-1：第十四轮曾在强清里清，但强清并不让旧 run 停、desktop 闸又只认 taskId 上的标记，
 *     清了之后到后继起跑之前，被强清的活 run 照样能调 desktop_*；改成属主的新启动在 send 之前才清，见上一条）。
 *     **残留：强清路径已收口、剩一条更窄的（第十八轮，第十六轮评审 P3-T2；用户授权按推荐处理；第十九轮评审 R19-3 订正此前「已收口」偏满）**：属主的新启动在 send 之前清掉标记之后，被强清放弃、但并没有真停的旧 run 本来不再受限——强清前已 cancel 并等了 5 秒，
 *     而取消之后给 `run.wait()` 的收尾宽限 30 秒（`CANCEL_WAIT_GRACE_MS`）**只罩 `wait()`**：计时要等 stream 循环结束才开始，流阶段（工具调用恰好发生在这）没有这个上限、只有 24h 硬顶（第十七轮评审 N1）。
 *     收口 = **过期会话闸**（`flowship-tools.ts` 的 `invokeFlowshipTool` 咽喉，`isStaleSessionRestrictedCall`）：标记会拒的那几类调用（`desktop_*` 除收尾、`groupOpenTurnToolDenied` 命中的那几个），
 *     不管标记在不在，都要求调用方的 callerToken 仍是该任务**当前**会话登记的那一个（`matchExpectedCallerToken`）。callerToken 表是 task / chat / 一次性问答共用的同一张**单槽**表，
 *     「标记没了的那一刻旧 run 的 token 已经对不上」在各路径上靠的**不是同一件事**（第十九轮评审 R19-6 订正此前「后继的 token 先装好」的统一说法——它对 chat 不成立）：
 *     · task 的 `internalStartAgent` 与一次性问答：先装后继 token（`installSessionIfCurrent` / `setOneShotCallerToken`），再清 / 重登记标记；
 *     · task 的属主 send 起点（`sendToTaskSessionBody`）：先清标记、再靠 `resumeTaskSession` 装新 token（最长约 180 秒），这段靠 `forceClearStaleRunnerState` 在强清时**同步作废旧 token**（`invalidateCallerToken`，第十九轮 R19-3 补）兜住；
 *     · chat：**没有**「属主新启动清标记」这一步——标记在 `closeChatSession(reason:"restart")` 里摘表当场清，旧 token 在**同一个同步段**里被 `setChatAwaitingNotifier(taskId, null)` 摘掉（所有 reason 都摘，不止 restart），
 *       新 token 要到后继会话的 `registerChatNotifier` 才装，中间表里没有 token（fail-closed）。靠的是「单槽 + 同一个同步段」，不是「后继先装」；`closeChatSession` 是同步函数，摘表与摘 token 之间不能插 `await`（`stale-session-gate.test.ts` 钉着）。
 *     再调这些工具只会得到 `CALLER_MISMATCH_ERROR`。标记还在时仍走标记自己的拒绝文案（闸放在标记闸后面）。「让强清真正停掉旧 run」没做——那要碰 SDK 层，也不是这里的职责。
 *     **闸只圈上面这几类**（第二十轮评审 R20-7）：圈外的 `browser_navigate` / `click` / `type` / `upload` 等，旧 run 在标记没了之后仍不受限，见下面「`beginNonOwnerTurn` 覆盖」一条。
 *     **仍管不到的一条**：`abortStuckRunForSend`（假死恢复）刻意保留 session 给后继 send 复用，新旧 run 共用同一个 token，闸区分不了「同一个会话里被放弃的 run」——它防的是「被接管的会话」；
 *     现状与引入闸之前一致、没有退化，如实记在 COMPUTER-USE.md / HANDOFF。
 *     上面「属主 send 起点」的两个新启动点（`internalStartAgent` / `startOneShotQuestion`）共用这一道闸；`stale-session-gate.test.ts` 与 `task-forceclear-keeps-marker.test.ts` 的真链路用例钉着。
 * - TTL / 绝对上限（见下）：任何异常漏清的最后兜底。
 *
 * ## midRun 型标记（中途补登）的让位
 * `beginForeignContentMidRun` / `endMidRunForeignContent`：**本轮已经在跑、中途才收到别人写的内容**（非属主答了 agent 挂着的
 * `ask_user`，答案写进 curl stdout 同一轮继续）——没有「send 起点」可以登记，就在送达前补登一个 `midRun` 标记，
 * run 收尾（consumeSessionRun / consumeChatRun 的 finally）按名清掉；登记之后又被别路沿用过的标记（`shared`），
 * 登记者没送达时的回滚在「此刻还有 run 在跑」时让位（{@link rollbackForeignContentMidRun}，第十轮评审 N1），留给沿用者那一轮的收尾；
 * 此刻没有 run 在跑（探针答「不在」：沿用者没送达）就照清（第十一轮评审 P3-1）；chat 的「在跑」包含自动重连链在飞——重连空窗里表是空的、
 * 那一轮其实还在（第十二轮评审 P2-1）；
 *
 * ## 同一轮的续接（缺省的「关会话就清」会把标记清掉，续接要自己处理，忘了处理就是 fail-open）
 * 目前 task 型有两处（chat 型没有等价的续接——读码结论：chat-runner 里只有堆水位回收**空闲**热会话，`chatReclaimBlock` 挡掉 run 在跑的会话，
 * `closeChatSession` 只有 `reason=restart` 才清标记，重连只摘表不清标记；第十五轮评审的子代理读码得出同一结论，**没有用例钉着**）：
 * ① **task 型自动重连链**——它关旧的坏会话时 `closeTaskSession` 传 `keepNonOwnerTurn`（重连是同一轮的续接，标记要留给 resume 出来的新会话，
 *   收尾仍归 consumeSessionRun 的 finally；此前它在这里被无条件清掉、续上的那一轮没有标记地跑，第十三轮评审 P2-2）；
 * ② **task 型 run 内水位的「自动压缩续接」**——旧 consume 的 finally 随后按旧 token 清，光保留不够，所以关会话之前读 `isGroupNonOwnerTurnActive` / `isNonOwnerTurnActive`、
 *   为真就给接力的 `resumeCurrentActionWithMessage` 传 `foreignContentTurn: true` 与旧标记的 scope，让新启动在首次 send 之前重新登记（第十四轮评审 P2；scope 沿用是第十五轮评审 P3-2）。
 *   可达性（如实）：`FLOWSHIP_TOKEN_WATERMARK` 总开关默认关；开了之后要同时满足 非问答 run、堆占用 ≥ 0.5、本 action 续接不超过 3 次、
 *   **且会话累计 input ≥ 2,000,000 token**（`session-rotate.ts` 的 `ROTATE_SESSION_INPUT_TOKENS`；第十五轮评审 P3-2 ④：此前少列了这一条；
 *   「会话累计」指 `sessionInputTokens`，老任务缺这个字段时 `isSessionRotationDue` 回退成任务累计 `totalInputTokens`，第十六轮评审 P3-D4）。
 *
 * ## 已知边界与已定的取舍（第十八轮起这几条都已决定、不再悬着；用户 2026-11-24 09:51 授权「都按你推荐的来」）
 * - **chat 后台子代理结果回灌（F3 / 第十六轮评审 P3-C1）——已定：回灌轮按出处继承标记**。此前回灌（`drainBackgroundResults`）不带 `foreignContentTurn`：空闲唤醒那一轮必然没有标记
 *   （`finalizeChatRunIfCurrent` 先在 finished 分支清掉上一轮的标记、再回灌）、steer 进正在跑的一轮则归那一轮的标记状态——没有标记的那一轮能调 `desktop_*` / 写所有者备注 / 建定时，这些闸都只认 taskId 上的标记。现在：
 *   · **记出处**：`cursor-subagent.ts` 在**派出那一刻**（同步、第一个 `await` 之前）读 `isGroupNonOwnerTurnActive(taskId)` 记进 job（读不出 / 抛错按外来处理，fail-closed），收尾事件带 `foreignOrigin`；
 *     前台调用被用户插话转后台的同样按派出时刻——收尾时标记通常早清了，所以不能到收尾才读；
 *   · **带标记送达**：入队时给外来来源的结果加队内前缀（`subagent-background.ts` 的 `markForeignOriginResult`，只认开头；唯一的出口 `joinResultsForAgent` 统一剥掉，送进 agent 的正文不含它，
 *     另多一句限制说明）；空闲唤醒走 `sendChatMessage(…, { foreignContentTurn: true })`——唤醒的新一轮 send 之前登记 `desktop` 标记；
 *   · **steer 只进「已有活标记」的一轮**：那一轮有标记就照常 steer（并 `beginForeignContentMidRun` 加入、置 `shared`，登记者之后回滚会让位）；没有标记（属主自己的新一轮）就**不 steer**、攒着，
 *     这一轮收尾后按空闲那一支带标记唤醒——与 `sendQueuedChatMessageNow` 不把 `foreignContentTurn` 队列项 steer 进别人那一轮同一原则；属主来源的回灌与以前逐字相同。
 *   链只在 scope=desktop 的轮里存在——**不是**因为「scope=all 的轮里 `subagent` 被白名单拦掉」（第十九轮评审 R19-7 订正此前这句话：Cursor 后端的 `subagent` 经 `withFlowshipSdkCustomTools` 的 extraTools 展开挂入、
 *   不经 `invokeFlowshipTool`，没有标记 / 白名单判断，`NON_OWNER_TURN_ALLOWED_TOOLS` 对它不起作用；pi 后端的 `subagent` 只在 scope=all 的轮里随工具集收窄一起下线）。真正的两条前提：
 *   ① **chat 的标记只有 midRun 一个来源、且 `beginForeignContentMidRun` 硬编码 scope=desktop**——chat 侧从不登记 scope=all（`beginNonOwnerTurn(` 只在 task-runner 里被调）；
 *   ② **后台运行（`run_in_background`）只在 chat 会话里挂**——`backgroundSubagents: true` 只由 chat-runner 传，task 模式（含 scope=all 的轮）的 `subagent` 直接回「当前会话不支持 run_in_background」。
 *   两条前提都有源码钉着（`stale-session-gate.test.ts`「chat 从不登记 scope=all / task 不开后台」）；任何一条被改，这段要重新评估：scope=all 的轮里若能起后台子代理，回灌会用 desktop 标记送达，比 all 松。
 *   钉着：`chat-background-foreign-origin.test.ts`（真 chat-runner + 真子代理链路 + 假 SDK）、`cursor-subagent-background.test.ts`、`subagent-background.test.ts`。
 *   **已知边界——`resume`（第十九轮评审 R19-5；已定：写明、不做）**：`foreignOrigin` 读的是「这一次派出（含 resume）那一刻」的标记状态，不记子代理当初是不是在外来轮里建的；
 *   属主的一轮主动 `resume` 一个外来轮建的子代理，它带着外来上下文的输出按属主来源回来（不带限制说明、不扣留）。读码已核实路径存在、威胁面是推测（要属主的模型主动传出那个 id、子代理自己没有 Flowship 受限工具）。
 *   理由与反悔路径（登记表里给 agentId 记污染位）见 `cursor-subagent.ts` 的 `readForeignTurn` 注释。
 * - **chat 侧强清（`forceClearChatRun` → `closeChatSession(reason:"restart")` 摘表当场按名清 midRun 标记；第十六轮评审 P3-C3）——已收口**：与 task 侧同一道过期会话闸。`closeChatSession` 是**同步函数**，
 *   在摘表之后、同一个同步段里 `setChatAwaitingNotifier(taskId, null)` 撤掉旧会话的 awaiting notifier 与 callerToken（所有 reason 都撤、不止 restart；早于 `agent.close()`），被放弃的旧 run 之后调受限工具得到 `CALLER_MISMATCH_ERROR`——
 *   不依赖 SDK 的 `close()` 是否让旧 run 的工具调用立刻失效（那一点仍没有核实）。保证靠的是「单槽 + 同一个同步段」，**不是**「后继 token 先装好」（chat 的后继 token 要到 `registerChatNotifier` 才装，在它之后）。
 *   「摘表者清标记」是第七轮评审 N1 为「旧 run 迟到的收尾不误清新会话的标记」定的分工，不变。
 *   **chat 的 stop 与「本轮自然收尾」撞车**（第十九轮评审 R19-2）：stop 先同步摘 token（`invalidateCallerToken`）、再 await 好几步才 `cancelChatRun`；这几步里若 run 恰好自然收尾，`finalizeChatRunIfCurrent` 的 finished 分支
 *   原来会保留会话、留下一个**没有 token 的空壳**（后继 send 复用它，整段会话里受限调用都被拒）。现在 finished 分支发现本实例的 token 已不是表里那个
 *   （`isRegisteredCallerTokenRevoked(taskId, rec.callerToken)`：登记过、且表里已不是它；没登记过的记录不算）就按 stop 收口：关会话（保留持久化的会话号）、不再 flush / drain——下一次 send 走 resume，会重新登记 token。
 *   **这个分支不清队**（第二十轮评审 R20-1：第十九轮这里写过 `failQueuedItems(cancelled)`，是 R19-2 自己带出的回归——stop 摘 token 到它取排队文本之间隔着好几个 await，
 *   分支先清队就让「已停止，N 条排队消息未送达」那张卡拿不到文本、不写，排队的话气泡消失却没有任何提示）：队里的话留给 stop 紧随的 `failQueuedItemsCapturingTexts` + `noticeTalkQueueDropped`。
 *   chat 会话 token 的摘除方只有 stop 与 DELETE（`cleanupChatTaskState`，它在那之前已清队），所以不清队没有代价；`tests/chat-stop-finish-race.test.ts` 用真 `stopTaskAgent` 链路钉着。
 * - **`beginNonOwnerTurn` 覆盖、不取严（第十六轮评审 P3-T4）——已定：保持覆盖**。强清留下的 `all` 标记会被后来没传 scope 的外来唤醒（缺省 `desktop`，如 `task-question-inject`）覆盖成 `desktop`；
 *   这个降级的风险（仍活着的旧 run 从整体硬拒降成只拒电脑操作）**只被过期会话闸收窄、没有去掉**：闸只圈 `desktop_*`（除收尾）与 `groupOpenTurnToolDenied` 命中的那批（浏览器登录态 / 页面脚本及其兄弟入口、写所有者备注、新建定时、自动推进、挂自定义 Action），这批对旧 run 按 callerToken 直接拒；
 *   圈外的——`browser_navigate` / `click` / `type` / `upload` 这类（`flowship-tools.ts` 里这些 handler 自己不核对 token）——scope=all 的旧 run 在标记被覆盖 / 清掉之后就不再受限，直到它被真正停掉（pi 后端的原生工具同理：`withNonOwnerTurnDeny` 只看标记；旧 run 在 pi 下能否还活着取决于 `close()` 是否中止会话，没核实）。
 *   已定（第二十轮评审 R20-7，按推荐）：保持现状、只把文案写准，不扩圈。理由：扩到整个 `browser_*` 要让凡是 token 对不上的合法路径（见 `isStaleSessionRestrictedCall` 注释里「口径不齐」那几类）冒被误拒的风险，而这条链要同时满足「被强清放弃、cancel 卡住没停、外来内容驱动、之后又被没传 scope 的外来唤醒降级」，可达性是推测；反悔路径 = 把 `isStaleSessionRestrictedCall` 扩成按名字前缀圈 `browser_*`（`tests/stale-session-gate.test.ts` 的清单对账会红、要同步改）。取严的代价是反过来的：上一轮留下的 `all` 会把**同权的后继轮**
 *   误限制成整体硬拒。覆盖语义有用例钉着（`non-owner-turn-scope.test.ts`「后继轮覆盖」；`stale-session-gate.test.ts` 的 T4 故事钉了「降级之后旧 run 仍被拒、后继照常」）。
 * - **`closeTaskSession` 缺省「清标记」不反转、标记不做引用计数（第十三 ~ 十七轮评审的设计建议）——已定：保持**。反转 = 19 个调用点（`task-runner` 17、`task-fs` 1、`/api/tasks/[id]` 1）的语义一起翻
 *   （16 个「这一轮确实结束」的点要逐个补显式清除，再改一批钉着「缺省清」的测试），换来的是把「续接点忘了声明保留」从 fail-open 变成 fail-safe；而续接点本来就是少数且已枚举
 *   （task 自动重连 3 处显式 `keepNonOwnerTurn: true`、压缩续接靠 `foreignContentTurn` 重新登记），「新增调用点忘了判断」由 `task-reconnect-keeps-marker.test.ts` 的**调用点清单**拦着
 *   （清单按「文件 → 所在顶层函数 → 个数」对账：新增 / 删除 / 把调用挪进别的函数都会红、逼着人工核对再改；**钉不到**的是同一函数内部的位置，也不是机器证明每个点的语义正确——
 *   第十九轮评审 R19-12 订正此前「19 处全部钉死」的说法）。以后若再冒出「续接点忘了保留」的新漏洞，再回头考虑反转。引用计数同理没做：旧 run 越权的窗口已由过期会话闸收窄（只圈 `desktop_*` 与恒拒清单那批，圈外的见上一条；第二十轮评审 R20-7 订正此前「收口」偏满），
 *   剩下的残留（沿用者只是排了队、让位后标记多留一阵）都是 fail-safe，不值得在 token / 按名 / 让位三套规则之上再加一层所有权。
 *
 * ## TTL（{@link NON_OWNER_TURN_TTL_MS}）
 * 任何异常漏清的最后兜底，过期视为不在非属主轮。
 *   **滑动**：这一轮只要还在调工具（含白名单里的 `wait`），工具咽喉就调 {@link touchNonOwnerTurn} 续期——
 *   固定窗口会被「连调两次 30 分钟的 wait」熬过期（第 20 轮评审 N1），之后 submit_work / shell 就放行了。
 *   **以 run 存活为准**（第二轮评审 P1-5）：只靠 Flowship 工具调用续期，Cursor 内置 shell 跑一条超过 TTL 的长命令
 *   （`sleep 2800 && …`）期间没有任何 Flowship 工具调用，标记就过期了，之后 desktop_* / 恒拒清单全放行。
 *   所以标记过期时先问「这个 task 的 run 还活着吗」（{@link registerNonOwnerRunProbe}，task / chat 两个 runner 各登记一个探针）：
 *   活着就续、不过期——标记的寿命跟着 run 走，TTL 回到它本来的职责：只兜「漏清 + run 已经没了」。
 *   探针只在 TTL 已过时才问（热路径零成本）；探针抛错按「还活着」算（fail-closed）；
 *   再加一道绝对上限 {@link NON_OWNER_TURN_MAX_AGE_MS}（比 24h 的 run 硬超时还长）：漏清的标记碰上后继的活 run 也不会永生。
 *   两种范围的标记共用同一套续期 / 清理。
 *
 * 只记在内存（进程重启 = 会话全断、标记自然消失）；模块级单例走 globalThis，抗 HMR / 多入口重复加载。
 */

const KEY = "__flowshipNonOwnerTurnGuardV1__";

/** 兜底 TTL：一轮答疑远不会跑这么久；漏清时最多让属主的系统工具被拒这么长时间 */
export const NON_OWNER_TURN_TTL_MS = 45 * 60 * 1000;

/**
 * 标记的绝对寿命上限（从登记起算、不续）：task / chat 的 run 都有 24h 硬超时，这里取 25h——
 * 正常的 run 永远先于它结束；它只管「标记漏清、又恰好有后继的活 run 让探针一直答『活着』」这种极端情形。
 */
export const NON_OWNER_TURN_MAX_AGE_MS = 25 * 60 * 60 * 1000;

/** 标记的范围：all = 系统工具整体硬拒（提示词开关开）；desktop = 只拒电脑操作（提示词开关关、同权） */
export type NonOwnerTurnScope = "all" | "desktop";

type Marker = {
  token: string;
  startedAt: number;
  /** 登记时刻（不随续期变）：绝对上限的起点 */
  beganAt: number;
  scope: NonOwnerTurnScope;
  /** 中途补登的（不是某次 send 起点登记的）：run 收尾要按名清，见 {@link endMidRunForeignContent} */
  midRun?: boolean;
  /**
   * 登记之后又有别路的外来内容沿用了这个 midRun 标记（{@link beginForeignContentMidRun} 见到活标记时返回 undefined 的那些）：
   * 它们没有自己的 token，那一轮**只靠这个标记**限制 desktop_* / 恒拒清单。有它、且此刻这个 task 还有 run 在跑时，登记者的回滚
   * （{@link rollbackForeignContentMidRun}）让位，留给沿用者那一轮的收尾按名清（第十轮评审 N1）；探针答「没在跑」就当沿用者没送达，回滚照清（第十一轮评审 P3-1）。
   * 注意 `shared` 只记「有人沿用过」、不记「谁」：沿用者只是排了队（会话忙）时，在跑的那一轮是别人的（常是属主自己的），让位后标记要等那一轮收尾才清
   * （fail-safe，多限制一阵；要精确得记持有人——已决定不做引用计数，理由见头部「已知边界与已定的取舍」）。
   */
  shared?: boolean;
};
/** 「这个 task 此刻有没有 run 在跑」——由持有 run 表的模块登记，本模块不 import 它们（避免成环） */
export type NonOwnerRunProbe = (taskId: string) => boolean;
type Store = {
  marks: Map<string, Marker>;
  seq: number;
  probes: Map<string, NonOwnerRunProbe>;
};

const store = (): Store => {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  if (!g[KEY]) g[KEY] = { marks: new Map(), seq: 0, probes: new Map() };
  // 旧版本（热更新前）留下的 store 没有 probes 字段：补上，别让它 undefined.values()
  if (!g[KEY]!.probes) g[KEY]!.probes = new Map();
  return g[KEY]!;
};

/**
 * 登记一个「run 还活着吗」探针（按名字登记，同名覆盖——HMR / 重复加载安全）。
 * 任何一个探针答「活着」就算活着；没登记任何探针时标记只按 TTL 兜底（单测 / 极早期启动）。
 */
export const registerNonOwnerRunProbe = (
  name: string,
  probe: NonOwnerRunProbe,
): void => {
  store().probes.set(name, probe);
};

/** 单测用：换上 / 摘掉某个探针（传 null 摘掉）。不进 `__resetNonOwnerTurnGuardForTest`——探针是模块加载时登记的、重置标记不该连它一起清 */
export const __setNonOwnerRunProbeForTest = (
  name: string,
  probe: NonOwnerRunProbe | null,
): void => {
  if (probe) store().probes.set(name, probe);
  else store().probes.delete(name);
};

const runAlive = (taskId: string): boolean => {
  for (const probe of store().probes.values()) {
    try {
      if (probe(taskId)) return true;
    } catch {
      // 探针坏了就不知道 run 在不在：按「在」算（fail-closed，宁可多拦一阵也不放行）；
      // 标记仍会被 run 收尾 / 属主下一次 send 起点 / 绝对上限清掉
      return true;
    }
  }
  return false;
};

/** 取还没过期的标记（过期且 run 也不在了的顺手清掉并视为没有） */
const liveMarker = (taskId: string | undefined, now: number): Marker | null => {
  if (!taskId) return null;
  const s = store();
  const m = s.marks.get(taskId);
  if (!m) return null;
  if (now - m.beganAt > NON_OWNER_TURN_MAX_AGE_MS) {
    s.marks.delete(taskId);
    return null;
  }
  if (now - m.startedAt > NON_OWNER_TURN_TTL_MS) {
    // 久没人续期：要么漏清（run 早没了），要么 run 还在、只是在跑一条不经 Flowship 工具的长命令——后者不能放行
    if (!runAlive(taskId)) {
      s.marks.delete(taskId);
      return null;
    }
    m.startedAt = now;
  }
  return m;
};

/**
 * 登记「本轮是非属主触发」；覆盖旧标记（同 task 同一时刻只有一轮）。返回本轮 token。
 * 覆盖 = 后登记的范围说了算，**不取严**：旧标记是 `all`、后来的是缺省 `desktop` 就被降级（用例钉着这个语义）——强清留下的旧 run 若仍活着，会随之从整体硬拒降成只拒电脑操作；
 * 第十六轮评审 P3-T4：已决定保持覆盖（第十八轮；旧 run 的越权由咽喉的过期会话闸按 callerToken 拦住，取严反而会误限制同权的后继轮），理由见头部「已知边界与已定的取舍」。
 */
export const beginNonOwnerTurn = (
  taskId: string,
  now = Date.now(),
  scope: NonOwnerTurnScope = "all",
): string => {
  const s = store();
  s.seq += 1;
  const token = `no-${now.toString(36)}-${s.seq}`;
  s.marks.set(taskId, { token, startedAt: now, beganAt: now, scope });
  return token;
};

/**
 * 本轮**已经在跑**、中途收到别人写的内容（非属主答了 agent 挂着的 ask_user）：在把内容交给 agent 之前补登一个
 * scope=desktop 的标记，让这一轮后面的 desktop_* / 恒拒清单（见 flowship-tools）不再放行。
 *
 * - 这个 task 此刻已有活标记 → 不新建、不降级、不覆盖，返回 undefined（已有的 all / desktop 标记至少一样严，收口归它的登记者）。
 *   已有的是 midRun 标记时顺手记一笔「有别路在靠它」（`shared`）：它的登记者（可能正挂在一个长 await 里，如 ask-inject 等 ask-wait 的 curl，最长 15 秒）
 *   之后回滚时不能把沿用者这一轮的保护一起清掉，见 {@link rollbackForeignContentMidRun}；
 * - 没有 → 新建 midRun 标记，返回 token。送达失败要回滚时**一律走让位版** {@link rollbackForeignContentMidRun}（只在「登记之后被沿用过、且此刻有 run 在跑」时让位，其余照清）。
 *
 *   【第十六轮评审 P3-D1 订正】这一段原先把回滚分成两类——「登记者已占住投递位 → 按 token 硬清（`endNonOwnerTurn`）／没占住 → 让位版」，并写着「chat-inject 的回滚走
 *   `endNonOwnerTurn`」「自己沿用自己的回滚若也走让位版会被自己置的 `shared` 挡住」。第十五轮评审 P3-3 F1 之后这两句都不成立（本文件头部的清除清单与下面
 *   {@link rollbackForeignContentMidRun} 的注释才是现状；`non-owner-turn-run-alive.test.ts` 钉着 chat 侧不再有硬清调用）：
 *   · **「占着投递位」不是全程成立的**（第十四轮评审 P3-1 订正此前的「进不来」）：`await agent.send`（最长 SDK_SEND_TIMEOUT_MS = 120 秒）期间用户 stop 会把实例摘表、投递位空出来，
 *     这时外来内容起的新会话可以沿用这个标记（置 `shared`）；登记者迟到的失主出口若还按 token 硬清，就把沿用者那一轮的保护清掉了。所以 chat 侧回滚全是让位版：
 *     `sendChatMessage` 的三个失主出口（send 抛错 / 发送期间被停或实例已失 / 状态写入后失主）；chat-inject 的外层 finally（没送出去）、`enqueueOrReject`（直送 busy 改入队）、
 *     同 id 已被别处结算（`already_settled`，第十六轮评审 P3-C2 补上的出口）、新会话首条被别路会话占位改入队（`runChatSession` 回 `already_running`，不把标记挂在别人那一轮上，
 *     第十四轮评审 P3-2）、askSkip 回写失败的收回。
 *   · **登记点紧贴送达**：`sendChatMessage`（带 `foreignContentTurn`）先认领 `runActive`、其间无 await 再登记；chat-inject 的直送 / 新会话路径是登记后**同步**进入
 *     `sendChatMessage` / `runChatSession`（后者的占位记录先于它首包前的 begin）。**送达一成立 token 就交出去了**（直送 send 返回 sent、askSkip 回写成功、新会话占位挂上之后各置
 *     `foreignRef.token = undefined`，第十三轮评审 P3-1），此后的 commit / 读盘等收尾 await 抛错不再回滚。
 *   · **「自己沿用自己」已被消掉**：`registerForeignMark` 在自己的 token 还活着时不再二次登记（{@link isLiveMarkerToken}）；`runChatSession` 回 `already_running` 发生在它内层 begin 之前。
 *     仍有的自沿用只剩 `runChatSession` 内层那次 begin（紧贴 `agent.send`、chat-inject 的 token 此时已交出去）：它自己丢弃 token，清除靠 finally 里的按名清
 *     （{@link endMidRunForeignContent}，表里是别的实例时不清）。
 *   · task / ask 侧：ask-inject 的三处回滚、task-question-inject 的「顶掉提问」回写（askSkip）——登记后要等一个自己并不占位的长 await（等 ask-wait 的 curl，最长 15 秒；会话此刻 idle，
 *     别路能直送并沿用这个标记），同样用让位版（第十一轮评审 P3-3 之前这两处 askSkip 误按硬清回滚）。
 *   第十二轮评审 P3-4 订正过「没有长 await」「自己后续登记沿用」两种说法；分界既不是「有没有长 await」，也不是按模块分。
 *   送达成功的由 run 收尾调 {@link endMidRunForeignContent}（或被紧随其后的 send 起点登记的标记取代）。
 */
export const beginForeignContentMidRun = (
  taskId: string,
  now = Date.now(),
): string | undefined => {
  const live = liveMarker(taskId, now);
  if (live) {
    if (live.midRun) live.shared = true;
    return undefined;
  }
  const s = store();
  s.seq += 1;
  const token = `no-${now.toString(36)}-${s.seq}`;
  s.marks.set(taskId, { token, startedAt: now, beganAt: now, scope: "desktop", midRun: true });
  return token;
};

/** run 收尾：只清「中途补登」的那种标记（send 起点登记的由各自 token 收口，这里不碰） */
export const endMidRunForeignContent = (taskId: string): void => {
  const s = store();
  if (s.marks.get(taskId)?.midRun) s.marks.delete(taskId);
};

/**
 * 只读：这个 token 登记出来的标记，此刻是不是该 task 上**还活着的那一个**（没被清、没被别的标记覆盖、没过期）。
 * 给「登记者想知道自己的标记还在不在」的调用方用——典型是 chat-inject 的 `registerForeignMark`：直送路径登记过、`sendChatMessage` 没送出去又落到
 * 新会话路径时，自己的标记还活着，就不该再 {@link beginForeignContentMidRun} 一次——第二次会见到「活标记」把它置 `shared`（自己沿用自己），
 * 之后别路真沿用时分不清谁是谁，回滚要么清掉别人靠着的、要么清不掉自己的（第十五轮评审 P3-3 F1）。
 * 没有 token（undefined / 空串）恒为 false。过期且 run 不在的标记按 {@link liveMarker} 的惯例顺手清掉、视为不在。
 */
export const isLiveMarkerToken = (
  taskId: string | undefined,
  token: string | undefined,
  now = Date.now(),
): boolean => !!token && liveMarker(taskId, now)?.token === token;

/**
 * 「没送达」的回滚（只给 {@link beginForeignContentMidRun} 返回的 token 用）：按 token 清，但**登记之后被别路沿用过的标记不清**。
 *
 * 为什么：ask-inject 在入口登记（答案可能被 ask-wait 的 curl 带进正在跑的那一轮，标记必须先于写入就位），随后 `await fulfillAskWait`——
 * 槽上没有 curl 时答案压在槽里等 curl，最长 15 秒。这个窗口里别路的外来内容（所有者空 @ 引用别人）到了，见到活标记就沿用它（没有自己的 token）、
 * 会话 idle 时直送成功，那一轮只靠它限制 desktop_* / 恒拒清单。窗口到点登记者回滚——按 token 一清，沿用者那一轮后半程就不再受限
 * （第十轮评审 N1，安全边界）。有人沿用过就让位：标记留给沿用者那一轮的收尾按名清（{@link endMidRunForeignContent}）。
 *
 * 让位只在「此刻这个 task 还有 run 在跑」时成立（{@link registerNonOwnerRunProbe} 的探针；chat 的「在跑」= 表里 runActive **或自动重连链在飞**，
 * 重连的退避 / 摘坏实例之后的空窗里表是空的、那一轮其实还在，第十二轮评审 P2-1；task 侧重连期间 runningTasks 不摘，探针一直答「在跑」——
 * 但探针答得准只保住了「让位」这个判断，**标记本身**在 task 侧此前被重连链的 closeTaskSession 无条件清掉，现在由它的 `keepNonOwnerTurn` 保住，
 * 第十三轮评审 P2-2）：沿用者送达了，那一轮在跑，
 * 标记留给它的收尾按名清；**沿用过、此刻探针却答「没在跑」，就当沿用者没送达**（send 抛错 / 没有会话），没人会再为这个标记收尾，留着只会把属主下一整轮的
 * desktop_* / 写所有者备注 / 新建定时多限制到那一轮结束（chat 没有「属主 send 起点清」，只剩惰性 TTL），所以直接清（第十一轮评审 P3-1）。
 * 这条推断只在探针答得准时才成立——它此前就在重连空窗里错过一次，所以别再把「没有 run 在跑 = 沿用者没送达」当作自明的事实。
 * 探针抛错按「在跑」算（fail-closed，见 {@link runAlive}）。
 *
 * 残留（都是 fail-safe：多限制一阵，不是漏保护；根治得给「沿用」记持有人——标记引用计数，已决定不做，见头部「已知边界与已定的取舍」）：
 * · 沿用者的 `agent.send` 还悬着时（此刻 runActive 已置位）登记者就回滚、让位了，随后沿用者的 send 才失败——标记没人收尾，仍留到下一轮 run 收尾 / TTL；
 * · 让位之后，登记者自己那份标记没有持有人：它之后往下走的送达若没成功，外层 `endNonOwnerTurn` 拿的 token 已经交出去了（askSkip 收回时会把 `foreignRef.token` 复位），
 *   标记留到别人的 run 收尾 / TTL（第十二轮评审 P3-1）；
 * · 「此刻有 run 在跑」不区分是谁的 run：沿用者只是排了队（会话忙）时，在跑的是别人（常是属主自己）那一轮，让位后标记要等那一轮收尾才清（第十二轮评审 P3-2）。
 * · **chat-inject 的回滚现在都是让位版**（第十五轮评审 P3-3 F1；此前外层 finally 的 `endNonOwnerTurn(id, foreignRef.token)` 是硬清，第十四轮评审 P3-1 只改了
 *   `sendChatMessage` 的三个失主出口，清单也漏了另外两处）：外层 finally（`handleChatReplyInject`，没送出去）、`enqueueOrReject`（直送 busy 改入队）、
 *   新会话首条撞上别路会话占位（`already_running`）改入队；第十六轮评审 P3-C2 又补上第四个出口——`already_settled`（同 id 在 claim 之后、入队之前被别处结算，200 终态 JSON、
 *   不入队，此前不回滚，竞态窗口里预登记的标记会挂到属主此刻那一轮上）。同形状的交错——直送路径登记 T、`sendChatMessage` 返回 `send_failed`、落到新会话路径，
 *   此时别路 B 也沿用了 T 并起了新会话，A 的 `runChatSession` 回 `already_running` 后若按 token 硬清，B 那一轮就没有保护了。
 *   为了让「让位」判得准，`registerForeignMark` 在**自己的 token 还活着**时不再二次登记（{@link isLiveMarkerToken}）：二次登记会把自己的标记置 `shared`（自己沿用自己），
 *   让位版就分不清「别人在靠它」和「只是自己重复登记」。仍有的自沿用只剩 `runChatSession` 内层那次 begin（紧贴 `agent.send`、token 已交出去之后），
 *   它之后不会再有 chat-inject 这一路的回滚。
 *   残留（fail-safe）：沿用者只是排了队（会话忙）时，让位后标记要等当前那一轮收尾才清——同上一条「此刻有 run 在跑不区分是谁的 run」。
 *   根治是给标记记持有人（引用计数）——**已决定不做**（第十八轮；评审第六节的设计建议，连同 `closeTaskSession` 缺省反转一并保持现状，理由见头部「已知边界与已定的取舍」）。
 * 不影响 {@link endNonOwnerTurn}：它是 send 起点标记的按 token 收口（task 型 consume / sendToTaskSessionBody / internalStartAgent 的 finally）、
 * 以及调用方已确知没有沿用者的回滚，语义不变（`non-owner-turn-run-alive.test.ts` 钉着）。
 */
export const rollbackForeignContentMidRun = (
  taskId: string,
  token: string | undefined,
): void => {
  if (!token) return;
  const s = store();
  const m = s.marks.get(taskId);
  if (!m || m.token !== token) return;
  if (m.shared && runAlive(taskId)) return;
  s.marks.delete(taskId);
};

/** 按 token 收口：标记已被后继覆盖 / 已清则 no-op */
export const endNonOwnerTurn = (
  taskId: string,
  token: string | undefined,
): void => {
  if (!token) return;
  const s = store();
  if (s.marks.get(taskId)?.token === token) s.marks.delete(taskId);
};

/**
 * 按 task 清，不看 token / 登记者。全仓只有四处调用（`task-reconnect-keeps-marker.test.ts` 钉着个数与位置）：`closeTaskSession`（真关到了会话才清、可被 `keepNonOwnerTurn` 绕开）、
 * `internalStartAgent` 与 `startOneShotQuestion`（属主自己的新启动，首次 send 之前清）、`sendToTaskSessionBody`（属主自己的 send 起点）。
 * 没有为「任务停止 / 删除」「强清」单独调用它：停止 / 删除要么经 `closeTaskSession`（真关到了会话才清）、要么靠 run 收尾与 TTL；强清不碰标记（第十五轮评审 P3-1）。
 * （第十六轮评审 P3-D4 订正此前这条 JSDoc 里「任务停止删除 / 强清残留」的说法。）
 * 「无条件」只指本函数自己：调用方（`closeTaskSession` 等）能不能走到这一步、同一轮续接要不要先绕开，见本文件头部的生命周期说明。
 */
export const clearNonOwnerTurn = (taskId: string): void => {
  store().marks.delete(taskId);
};

/**
 * 此刻该 task 是否处在「系统工具整体硬拒」的非属主轮里（提示词开关开着那种，scope=all；过期自动视为否并顺手清掉）。
 * 提示词开关关着的同权轮（scope=desktop）不算——它只拒电脑操作，见 {@link isGroupNonOwnerTurnActive}。
 */
export const isNonOwnerTurnActive = (
  taskId: string | undefined,
  now = Date.now(),
): boolean => liveMarker(taskId, now)?.scope === "all";

/**
 * 此刻该 task 是否处在**群里非属主触发的一轮**（不论「只答疑」提示词开关开还是关）。
 * 电脑操作（desktop_*）看这个：群里的陌生人不能让 AI 动属主的电脑、更不能让它解锁，开关关着（同权）也一样。
 */
export const isGroupNonOwnerTurnActive = (
  taskId: string | undefined,
  now = Date.now(),
): boolean => liveMarker(taskId, now) !== null;

/**
 * 续期：这一轮还在调工具（含白名单里的 wait）就把起点刷新到 now，固定 TTL 只兜「漏清后没人再调工具」。
 * 两种范围的标记都续（同权轮里的电脑操作拦截也靠它撑过长轮次）；返回值只回答「此刻是否处在系统工具硬拒的非属主轮」
 * （scope=all；过期的视为否，并顺手清掉）——保持原有语义。工具咽喉（invokeFlowshipTool / pi 的 execute 包装）调用；
 * {@link isNonOwnerTurnActive} 保持纯查询，不续期。
 */
export const touchNonOwnerTurn = (
  taskId: string | undefined,
  now = Date.now(),
): boolean => {
  const m = liveMarker(taskId, now);
  if (!m) return false;
  m.startedAt = now;
  return m.scope === "all";
};

/** 单测重置 */
export const __resetNonOwnerTurnGuardForTest = (): void => {
  store().marks.clear();
  store().seq = 0;
};
