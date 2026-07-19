# Fable5 Chat 打磨改动验收（2026-07-17）

> 2026-07-19 10:00：第三十四轮修复已提交、待复审——**用户拍板停止补丁循环**，本轮严格按第三十三轮四条收敛建议做集中式重构：QueueOperation（客户端预生成 itemId + recentSettled ledger + failQueuedItems 唯一 sink、含 DELETE/rewind 遗留直调清零）、TerminalCleanupCoordinator（唯一 handle + join、同步 remove 同互斥、reopen 原子占相位）、DeleteJournal 状态机（prepared→committed + refsPending 重试）、Read Commit Guard（四类读入口统一闸 + task_deleted 帧）。门禁 96 文件 / 889 项 0 skipped 多遍全绿。详见「第三十四轮修复报告」。
>
> 2026-07-19 09:22：第三十三轮 Codex 深度复审完成。R32-1～R32-7 的点名 happy path 均有有效增量，R32-4 的全局发号器与 R32-7 的长事件 seq 恢复本轮未发现新反例；但真实提交链仍确认 **5 个 P1 + 2 个 P2**：stop/启动补偿等清队路径仍无 itemId 终态，202 晚到可重新插入幽灵 pending；terminal cleanup reservation 可被重复 finalize 复用同一 gen、降级 executing 或被任一 holder 提前释放，且同步 remove 分支完全未持 reservation；多任务 list 与 tail/watch 读仍可在 tombstone 后回灌；未提交 tombstone 的 prepared journal 会在重启时直接删除仍可见任务。另有 refs 删除失败仍 rm taskDir 并删 journal、queue item 发号器仍是模块局部可跨 route/HMR 撞号。结论不通过。5 个临时反例探针全部实证后撤回，业务代码未改；typecheck、lint、R33 定向 31 项、真实权限全量 93 文件 / 863 项、build、diff-check 全绿。详见「第三十三轮验收」。
>
> 2026-07-19 09:00：第三十三轮修复已提交、待复审——R32-1～R32-7 全部处置：settledItemIds 挡终态先于 202、failQueuedItems 唯一清队入口 + bootstrap queue_state 对账、cleanup reservation 分 waiting/executing（executing 期间 reopen 409）、发号器挂 globalThis 关 ABA、tombstone 读后复查 + 前端 epoch、deletion journal 可恢复清 checkpoint refs、seq 尾窗空强制全量扫 + sidecar 只升不降。门禁 93 文件 / 863 项 0 skipped 多遍全绿。详见「第三十三轮修复报告」。
>
> 2026-07-19 08:45：第三十二轮 Codex 深度复审完成。R31-1～R31-5 的点名 happy path 均有有效修复，尤其 strict EIO 整队失败、quarantine cleanup reservation、DELETE 返回前 tombstone、旧日志 sidecar 迁移以及全局 RunningCheck/ClaimHandle 都已成立；但跨真实提交点继续确认 **5 个 P1 + 2 个 P2**：202 响应与 SSE 终态可反序，导致终态先到而 pending 后插入；非 EIO 清队与 queue-priority 启动仍未贯穿 itemId 终态协议；deferred remove 在最终代际检查后的第一个 await 仍可被 reopen 穿越；quarantine generation 是模块局部计数、跨 route/HMR 可 ABA 复用；tombstone 之前启动的 refresh 可在 DELETE 成功后回灌旧任务。另有重启 tombstone 清扫永久遗留 checkpoint refs，以及单条超 4MB 事件在合法落后 sidecar 下仍会 seq 重号。结论不通过。真实权限下 90 文件 / 832 项、typecheck、lint、build、diff-check 全绿；4 个临时反例探针全部实证后已撤回，业务代码未改。详见「第三十二轮验收」。
>
> 2026-07-19 08:25：第三十二轮修复已提交、待复审——R31-1～R31-5 全部处置，主题「完成信号只能由最终提交者发出」：队列 item 带 itemId 终态协议（queue_failed 控制帧 + 前端对账）、quarantine 双条件（cleanup reservation 带代际、reopen 作废旧清理）、DELETE 先写 durable tombstone 再回 200、seq high-water sidecar（>4MB 历史高水位恢复正确）、claimHandle 并入全局 RunningCheck。门禁 90 文件 / 832 项 0 skipped 多遍全绿。详见「第三十二轮修复报告」。
>
> 2026-07-19 08:10：第三十一轮 Codex 深度复审完成。R30-1 的唯一 `ClaimHandle` 与 R30-5 的 notifier outcome 已成立，R30-2/3/4 也关闭了各自点名的主窗口；但交接尾段仍确认 **3 个 P1 + 2 个 P2**：队首 strict EIO 会丢当前条、卡住其余队列且前端永久保留“待发送”；finalize 的 quarantine 在延迟 cleanup 真正完成前自动解除，reopen 可新建工作区后再被旧后台删除；DELETE 在 durable/logical delete 前即返回成功，侧栏刷新或进程重启会让任务复活；另有 4MB 外历史高水位仍导致 seq 重号，以及 `runningChecks` 的 companion handle Map 没有跟随全局状态跨 route/HMR 共享。结论不通过。真实系统权限下 typecheck、lint、87 文件 / 817 项、build、diff-check 全绿；另用两个临时探针实证“EIO 后尾消息滞留”和“>4MB 后 seq=11 而非 1001”，探针已撤回，业务代码未改。详见「第三十一轮验收」。
>
> 2026-07-19 07:50：第三十一轮修复已提交、待复审——R30-1～R30-5 全部处置：claim 唯一 ClaimHandle（两条 ABA 关闭）、资源事务 quarantine fail-closed（超时不放闸、补偿逐仓现查）、strict 端到端（队列先落盘再 send + 前端 persistWarning toast）、seq 扩块求 max 恢复、ask/无 action notifier 消费 outcome。门禁 87 文件 / 817 项 0 skipped 多遍全绿。详见「第三十一轮修复报告」。
>
> 2026-07-19 早晨：第三十轮 Codex 深度复审完成。R29 的六项修复均有有效增量：preview 的最终准入已进入 spawn 前后、旧 action `submit_work` 不再假交卷、直接用户输入的 send 前 strict 失败和正常短事件 seq 恢复也已成立；但继续确认 **3 个 P1 + 2 个 P2**：side-effect claim 只有 kind 没有唯一 token，重交卷 / stop-resume 可 ABA 误放新 owner；ResourceJob 只中止当前 git/cp，半截目录清理与失主补偿仍不可中止，30 秒后照旧开闸；strict 协议没有贯穿队列 flush 和前端，持久化失败仍对用户静默。另有 64KB 尾扫在长事件 / 历史重号日志上重新发出重复 seq，ask / 无 action notifier 仍忽略 stale/busy。结论不通过。真实系统权限下 typecheck、lint、84 文件 / 802 项、build、diff-check 全绿；绿灯未覆盖上述交接窗口。详见「第三十轮验收」。
>
> 2026-07-19 07:15：第三十轮修复已提交、待复审——R29-1～R29-6 全部处置：side-effect 与 post-check 单一 claim 状态机（同步原子、零 await 空窗）、ResourceJob 接 AbortController 可 revoke 杀子进程、preview 最终准入进 spawn 提交点、strict 用户输入事件（send 前 5xx / send 后 persistWarning）、notifier 结构化返回（stale 不再假交卷）、seq 从 durable 尾部恢复。门禁 84 文件 / 802 项 0 skipped 多遍全绿。详见「第三十轮修复报告」。
>
> 2026-07-19 早晨：第二十九轮 Codex 深度复审完成。R28 的五个收口方向并非无效：MR 双投影单事务、session anchor 的 rename finalGuard、事件 append/publish 同链均已成立，原 forceClear 空窗覆盖新 chat session 的主问题也已关闭；但继续确认 **4 个 P1 + 2 个 P2**：ActionSideEffectCoordinator 在“等待清空→登记 post-check”之间仍有双表竞态，ResourceJob 的 30 秒 join 无法约束最长 600 秒的已启动子进程，preview 只做一次陈旧准入检查可在 finalize/DELETE 后重新起进程，用户输入迁移到吞错 helper 后会出现“已送达但未持久化”；另有 submit_work scope no-op 被误报 delivered、stop 后事件 seq 从 1 重号。结论不通过。真实系统权限下 typecheck、lint、81 文件 / 784 项、build、diff-check 全绿；绿灯缺少上述交叉窗口。详见「第二十九轮验收」。
>
> 2026-07-19 凌晨：第二十九轮修复（整夜批）已提交、待复审——R28-1～R28-5 全部落地后，自行组织三轮内部交叉审查（独立 reviewer 按 Codex 审法分区蓝军）、审出的 7 个新 P1 + 主要 P2 全部修复、终轮确认 ownership 收敛无可达 P1。门禁 81 文件 / 784 项 0 skipped 多遍全绿。7 个 wip commit 已落本地（未 push）。详见「第二十九轮修复报告」。
>
> 2026-07-18 22:21：第二十八轮 Codex 深度复审完成。R27-1、R27-5、R27-7 已成立，R27-2/3/4/6 只关闭了报告描述中的局部窗口；继续确认 **4 个 P1 + 1 个 P2**：worktree 资源租约未贯穿真实启动链，chat 旧 run 的自然/取消/失败收尾仍可在 force-clear 空窗覆盖新会话，resume 条件清锚点没有最终 guard，`submit_mr` 与 `submit_work` 缺 action 级并发屏障且两份 MR 状态非同一事务，事件落盘顺序与 SSE 发布顺序可反转。结论不通过。typecheck、lint、74 文件 / 746 项、build、diff-check 均通过；现有 R27 矩阵中两项明确是降级直测，绿灯没有覆盖上述真实链路。详见「第二十八轮验收」。
>
> 2026-07-18 22:00：第二十八轮修复已提交、待复审——R27-1～R27-7 全部处置 + 收敛门槛 5 条落地：lease 进 rename retry 循环与 worktree 资源函数内部、resume reject 条件清锚点、action/ask 身份从 session token 拆出、owned sink 必填化 + ESLint 静态门禁、chat 主消息流接 instanceId lease、ENOENT 不 publish 幽灵事件。门禁 74 文件 / 746 项 0 skipped 两遍全绿。修复期间发生一次 git checkout 数据事故、已从构建缓存完整恢复并保护性提交（详见报告内事故记录）。详见「第二十八轮修复报告」。
>
> 2026-07-18 20:52：第二十七轮 Codex 深度收敛复审完成。R26 的五个 sink 原语对新增测试中的单次提交窗口有效，但 lease 仍没有进入 Windows rename 的每次重试、worktree 的每个资源副作用、ask/action 身份以及 chat 主消息流；另有删除竞态下“未落盘却 publish”的契约错误。确认 **6 个 P1 + 1 个 P2**，结论不通过。定向 31 项、typecheck、lint、真实权限全量 72 文件 / 727 项、build、diff-check 均通过；绿灯未覆盖本轮时序。详见「第二十七轮验收」。
>
> 2026-07-18 20:30：第二十七轮修复已提交、待复审——按第二十六轮「一次性收敛建议」实施授权层 + sink 层收口：五个唯一入口（`commit(finalGuard)` / `appendEventIf` / `publishIfCurrent` / `installSessionIfCurrent` / `cancelPendingIf`）全部落地，终态准入下沉到 resume/prewarm 资源 sink，MCP action 级授权（session token 只认证 agent）+ stop 同步失效 bridge，R26-7 点名的 9 个真实 sink 窗口全部有挂起 failpoint 矩阵。门禁 72 文件 / 727 项 0 skipped 四遍全绿。详见「第二十七轮修复报告」。
>
> 2026-07-18 20:00：第二十六轮 Codex 深度复审完成。R25-1 的 append/stop 同锁事务、R25-2 的 one-shot 条件写、R25-3 的 createMR 前复查、R25-4 的 question done 复查均对各自测试窗口有效；但真实 route、session 安装、ask 身份、MCP action 授权和异步 sink 的提交点仍未闭合。确认 **5 个 P1 根因族 + 2 个 P2**，结论不通过。完整门禁 69 文件 / 703 项全绿；绿灯不能覆盖本轮构造的未插桩窗口。详见「第二十六轮验收」。
>
> 2026-07-18 19:20：第二十六轮修复已提交、待复审——R25-1～R25-4 逐一闭合「判定通过后还有 await」的提交边界：stop/finalize 收尾改锁内一把事务（与 append 同锁）、终态准入改盘上 fresh 读、caller 有效性贯穿到 createMR 等不可逆副作用之前、event/done 在 await 后写前复查；R25-5 点名的四个窗口全部有真实 failpoint 测试。门禁 69 文件 / 703 项 0 skipped 四遍全绿。详见「第二十六轮修复报告」。
>
> 2026-07-18 19:00：第二十五轮 Codex 复审完成。R24-1/2/3 的主问题已修，R24-5/6/7 也各关闭了一部分；但 append 的真正提交点、终态请求的陈旧快照、MCP 已入场调用的撤销，以及事件写入 await 后复查仍未闭合。确认 **3 个 P1 + 2 个 P2**，结论不通过。详见「第二十五轮验收」。
>
> 2026-07-18 深夜：第二十四轮 Codex 复审完成。R23-2 的 stale 补偿、resume 状态合写、observer 的 `claimSeq` 比较、重连 session CAS 等局部修复有效；但 operation 生命周期没有正确移交给保留会话和后台 post-check，`appendAction` 与 finalize 的提交边界也仍未闭合。确认 **6 个 P1 + 2 个 P2**，结论不通过。详见「第二十四轮验收」。
>
> 2026-07-18 深夜：第二十四轮修复已提交、待复审——R23-1～R23-8 全部处置（claim 后首笔共享写锁内条件化、stale 只让位、observer 贯穿 send/one-shot、bridge/post-check/重连绑 op、stop 重读收尾、finalize 占 finalizing lifecycle），并修复 Codex 点名的 M9 测试抖动。门禁 66 文件 / 681 项 0 skipped 连跑两遍全绿。详见「第二十四轮修复报告」。
>
> 2026-07-18 夜间：第二十三轮 Codex 复审完成。V12 的 `TaskOpHandle` / `claimSeq` 基础 API 本身成立，R22-2/R22-3 的 `handleRunFailure` 定向路径也已收口；但设计文档要求的“claim 后只认 `isOpOwner(handle)`、禁止裸写共享状态”没有真正迁完，仍确认 **7 个 P1 + 1 个 P2**。结论不通过，详见「第二十三轮验收」。
>
> 2026-07-18 傍晚：第二十三轮修复已提交、待复审——本轮不再逐条打补丁，做了**所有权收敛重构**（V12 单一 TaskOpHandle + 唯一 isOpOwner 判定 + failpoint 矩阵测试，设计文档 `docs/ownership-refactor-2026-07-18.md`），R22-1～R22-6 全部处置。详见「第二十三轮修复报告」。
>
> 2026-07-18：第二十二轮 Codex 复审完成。R21-1～R21-5 的主路径修复有效，但继续发现 5 个 P1、1 个 P2；结论仍为不通过。详见「第二十二轮验收」。

## 结论

**第三十二轮验收仍不通过。** 本轮不是无效修改：R31 点名的五条主路径都比上一轮完整，新增测试也真实覆盖了 strict EIO、cleanup 前让位、tombstone 后读、旧日志全量迁移和新形状 RunningCheck 跨模块 abort。但“最终提交者”协议仍没有覆盖响应/SSE 反序、remove 已入场、refresh 已入场和模块实例重载四类交接；另有两个持久化恢复边界。当前阻塞项为 **5 个 P1 + 2 个 P2**。

第三十二轮 Codex 深度复审门禁（基线 `33cfc5a`，`HEAD dedf910`）：

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- R32 新增定向矩阵：3 文件 / 15 项全部通过
- Codex 临时反例探针：4/4 通过（cleanup generation 跨模块复用；单条超 4MB 后 seq 重号；tombstone 提交后 stale list 仍返回任务；boot 删目录后 checkpoint ref 仍存活）；探针运行后已撤回
- `pnpm test`：沙箱内 831/832，唯一失败是 preview PID 用例缺真实进程信号权限；沙箱外该文件 9/9，通过后全量 **90 文件 / 832 项全部通过**
- `pnpm build`：生产构建通过
- `git diff --check`：通过

文件读写兜底专项意见继续保持落实：`safe_read`、对应测试和直接依赖已删除，`chat-mcp` 注册已撤回，Windows prompt 收缩为“两次失败后停手”，不再引导 Python/Node 写回。

审查方法：逐条复查 R31-1～R31-5，再从 HTTP/SSE 先后序、物理 remove 入场、tombstone 前后并发读、boot 恢复、超长单事件、route-chunk/HMR 状态六类真实提交点反查完成信号；只找可达 bug，不评价 S8 或功能路线。审查结束前无业务代码改动；临时测试探针已撤回，本节及「第三十二轮验收」是本轮唯一持久写入。

---

## 第二十轮修复报告（Fable5、2026-07-18 午后、待复审）

按第十九轮意见修复 R19-1～R19-4，并顺手补掉 ask-reply 两处同类裸写：

### R19-1（opFresh 缺结构条件）

`patchActionAndRunStatusIfOpFresh` 增加 `expected: { currentActionId?, actionStatus? }` 锁内结构条件——同 epoch 并发 advance 不 bump gen，靠「currentActionId 仍是 ack 的 action、action 仍 awaiting_ack」挡住「旧 Q 把 completed 的 A 改回 running / 抢回指针」。`/question` ack 调用处已传。新增「isFresh=true 但指针已变 / action 已 completed → 不写」测试（第十九轮点名旧测试只测了 isFresh=false）。

### R19-2（启动失败收尾覆盖后继）

`handleRunFailure` 不再裸写 `setTaskRunStatus("error")`：有绑定 actionId 时走锁内条件事务（currentActionId 仍指向自己才写 task 级 error）；已被 B 接管 → 只精确标自己 action 为 error + 写 error 事件，不碰 task 级指针/状态。补「A send reject、B 已接管 → currentActionId 仍是 B」测试。

### R19-3（owner 校验与写盘非同一临界区 → 写后回滚）

两个条件事务 helper 改为「锁内：同步 owner 快查 → 暂存原值 → writeMeta 新值 → **同步再查 owner**——已换主则锁内写回原值、返 null」。线性化论证（注释已写入代码）：runningTasks 换主是同步内存操作、可发生在锁内任意 await 间；但任何后继的 meta 写都要过同一把 `withTaskLock`、必然排在本临界区之后——写后复查 + 回滚保证「释放锁那一刻 owner 已换 → 盘上无污染」。补真实时序测试：writeMeta 挂起期间换主 → 放行 → 盘上 meta 已回滚、返 null。

### R19-4（session close 的 undefined 退化 fail-open）

- internalStartAgent 失败 catch：当前 session 不是 failedAgent → **只 close 本地 agent 对象**、绝不调 `closeTaskSession(undefined)`（旧逻辑 undefined = 不校验实例、同 agentId 的 resume 新实例 B 会被误关）。
- `consumeSessionRun` 入场改按 **agent 对象引用**捕获 session instanceId（agentId 在 resume 场景会复用、对象引用不会）；拿不到号则后续只关本地。
- `closeTaskSession`：带 expectedSessionInstanceId 但内存 session 已不存在 → **不清持久化 sessionAgentId**（锚点归当前 owner 管）。契约注释：「异步旧 owner 拿不到精确实例号 → 必须 no-op / 只关本地；undefined 仅限用户主动关当前的同步调用方」。
- 补测试：catch 时当前 session 已是 B（同 agentId resume 新实例）→ A 的失败收尾不关 B、不清锚点。

### 收尾补漏（主线自查）

`ask-reply` route 仅剩的两处裸 `setTaskRunStatus`（僵尸兜底标 error、send 后幂等刷 running）都改为 `setTaskRunStatusIfRunOwner` 锁内条件写（error 分支还要求「确实无存活会话」）；该文件不再 import 裸写接口。

### 第二十轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、638 项全部通过（较十九轮 +8 项）、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- 取消协议仍是「cancellation epoch + 锁内结构/owner 条件 + 写后回滚」组合，未引入 per-operation 独立 owner token（第十九轮注明的「根治」方向）；当前组合已覆盖全部已报时序，若复审仍能构造新窗口、再评估上全量 token 的改造成本。
- advance 双启动全链集成测试仍未补（mock 面过大）；R19-2 用导出的 `handleRunFailure` 直测钉契约。

---

## 第二十一轮修复报告（Fable5、2026-07-18 下午、待复审）

按第二十轮意见修复 R20-1～R20-4：

### R20-1（actionId 不是 operation 身份 → per-start owner token）

- `task-stream.ts`（global key 升 V11）增 `taskStartOwners: Map<string, number>`：`claimTaskStartOwner`（发号复用进程级 instanceId 发号器；接管者 claim 自然覆盖前任 = 换主）/ `isTaskStartOwner` / `releaseTaskStartOwnerIf`（匹配才删）。
- claim 位置：`internalStartAgent` 串行受理段第一行；release：受理未成、catch 失败收尾后、`consumeSessionRun` finally（均匹配才删）。
- `handleRunFailure` 增 `startToken` 校验：失去 start owner（同 action 双唤醒、B 已接管）→ 只落挂自己 actionId 的 error **事件**，不 patch action、不碰 task 级状态。新增同 actionId 双启动测试（第二十轮点名旧测试用不同 action 绕开了该路径）。

### R20-2（ask-reply 迟到刷新写回永久 running）

**直接删除** send 成功后的幂等刷 running（验收给的选项之一）——deliver/consume 内部已有各自 owner 门控的状态写，路由不再重复；响应 task 改现读。

### R20-3（写后回滚的脏值对无锁读者可见 → prepare/commit 单次提交）

- `task-fs-core.ts` 新增 `prepareMetaWrite(meta)`：写 tmp（脏值只在 tmp、meta.json 未动）→ `commit()` = 原子 rename / `abort()` = unlink；`writeMeta` 本体重构为 prepare+commit 组合（其他调用方行为不变）。
- 两个条件事务 helper 改「锁内：同步快查 → readMeta → prepare → **同步复查 owner/结构**（复查到发起 commit 之间无 await）→ commit / abort」——**不再有回滚**，meta.json 任何时刻只含旧值或已提交值，无锁读者（getTask/listTasks）永远读不到被拒绝的脏值。线性化论证在代码注释：提交点 = rename；换主若落在 rename 的 await 期间、线性序等于「A 先提交、B 后接管」，B 的状态写过同一把锁排后覆盖。
- 新增测试：卡住 prepare 的 tmp 写、挂起期间换主并发 `getTask` 读——断言读到的仍是旧值、helper 返 null、meta.json 从未出现新值。

### R20-4（失去 owner 仍发 task 级 done/error envelope）

`handleRunFailure` 的 publish 与 R20-1 同源门控：失去 start owner / 条件写返 null → 只 publish 挂 actionId 的 error 事件 envelope，**不发 task 级 `done(ok=false)` / `error`**——B 的 streamingText 不再被旧 A 的失败清空、不再弹整任务失败 toast。测试收集 publish 调用断言无全局 envelope。

### 第二十一轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、639 项全部通过、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- follow-up `sendToTaskSession` 未加 startToken（它有 runningTasks/session instanceId 双门控、且非同 action 双启动路径）；若复审认定同类窗口再补。
- rename 系统调用 await 期间换主的窗口按「A 先提交、B 后覆盖」线性序论证为可接受（B 接管后必写自己的状态）。

---

## 第二十二轮修复报告（Fable5、2026-07-18 下午、待复审）

按第二十一轮意见修复 R21-1～R21-5：

### R21-1（start token claim 太晚 → 前移到第一个接管副作用之前、贯穿 internal start）

- `StartAgentInput` 增 `startToken?`：调用方在接管副作用前 claim 的 token 贯穿整条启动链；受理段改「优先沿用调用方 token、无则自 claim」，且入口即验 `isTaskStartOwner`——传入 token 已被更晚接管者覆盖 → 开工前就让位。
- claim 前移两处：`resumeCurrentActionInner` 在关旧会话 / 写 running **之前**（入口 getTask 后同步 claim）；`advanceTaskInner` 在 appendAction **之前**同步 claim（appendAction 过锁写 running = claim 后紧跟的过锁状态写、见 R21-3）。
- 受理段新增 `yieldStartIfLostOwner` 让位 helper + 三个检查点：create resolve 后、prompt 素材收割后、send resolve 后（cancel 刚受理的 run、绝不预登记 runningTasks）。让位只关本地资源（自己注册的会话按 instanceId 精确关；prompt 未送达连锚点一起清、防后继 resume 到没收过 prompt 的裸 agent）、绝不碰 `pendingStopRequests`（可能是用户发给后继的停止信号）、不写共享状态。
- 新增**真实同 action 双唤醒全链测试**（非手工摆 token）：双 `resumeCurrentActionWithMessage`、A 的 `Agent.create` 挂起期间 B 接管 → 放行 → A 从未 send、只有 B 送出 super prompt、共用 action/task 不被写 error、无 error 事件。

### R21-2（handleRunFailure 只入口查一次 token → 全程 owner 闭包）

- `stillStartOwner` 做成可重复调用闭包并**合并进条件事务的 isOwner**——prepare 后的锁内同步复查也验 token，B 在 read/prepare await 中 claim 时 A 的提交被 abort。
- helper 返 null 不再无条件 `finalizeOwnAction`：区分两类 null——结构条件不符（currentActionId 已指向不同 action 的后继、errorActionId 是 A 独占旧 action → 精确标 error 安全）vs owner 失败且 currentActionId 仍 === errorActionId（同 action 共享 → 绝不 finalize）。
- 发布 task 级 done/error envelope 前重验 owner（事件/getTask 的 await 中换主 → 不发）。
- 新增验收点名的 deferred 测试：B 的 claim 发生在 **helper prepare 挂起期间**（不是调用函数前）→ 不提交、不 finalize 共享 action、无全局 envelope；另补「不同 action 接管（token 仍有效）→ 仍精确标自己 error」回归用例。

### R21-3（commit rename await 期间换主 → 修正线性化前提）

- 采纳验收给的根治选项 B：「每个 claimant 在 claim 之后必须有一次过同一把 task lock 的状态写」——R21-1 的 claim 前移正是为此：advance 的 claim 紧跟 appendAction（锁内写 running）、resume 唤醒的 claim 紧跟 patchAction+setTaskRunStatus。换主落在 A 的 commit rename await 内时，线性序 =「A 先提交、B 后接管」，B 的写过同一把锁必然排在 A 的 rename 之后覆盖它（条件事务 helper 的 withTaskLock 临界区持锁到 commit 返回）。
- `task-fs.ts` 注释按 R21-3 口径修正：明确「真正提交点是 commit() 内部 renameWithRetry 的 await」、不再声称「复查到提交无 await」，线性化论证落到「claim 后必有过锁写」这一前提上。

### R21-4（ask 僵尸兜底没有结构条件）

- `setTaskRunStatusIfRunOwner` 增第 5 参 `expectedRunStatus`：锁内 readMeta 后验证盘上 runStatus 仍是调用方入场看到的值，变了拒写（B 接管的第一步就是过锁写 running、锁内必可见）。
- ask-reply 僵尸分支传 `"awaiting_user"`——并发唤醒 B 在 Agent.create 前的窗口（session 未注册、opGen 未变）由该结构条件兜住。
- 补测试：盘上已被写成 running + 旧 owner 闭包全过 → 拒写；真僵尸（仍 awaiting_user）→ 正常标 error。

### R21-5（consume 误绑全局 lastAction → 只认入场绑定的 errorActionId）

- `consumeSessionRun` finished 路径：业务收尾改按 `opts.errorActionId` 定位自己的 action；**全局最新 action 已不是自己绑定的 → 立即让位**——不追问、不写 task 级状态、不发全局 envelope、不关会话（B 的启动链接管一切），只把自己还挂 running 且无在飞交卷 check 的 action 收成 cancelled（A 独占、不伤 B）。errorActionId 缺省的 run（不追问的 questionRun 之外极少）保持原全局兜底。
- 补真实调用链测试：B 已 append（currentActionId=B）、A 经 `deliverAskReply` 的 run 自然 finished → send 只有 1 次（答案本身、无「为 B 交卷」追问）、B 的指针/状态/action 全部保持、A 的 action 收 cancelled、无 error 事件。

### 第二十二轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- 定向：`task-op-generation-v1-v2.test.ts` 30 项全过（+5 项）
- `pnpm test`：62 文件 / 645 项全部通过、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- follow-up `sendToTaskSession` 仍未接 startToken（沿用第二十一轮记录：有 runningTasks/session instanceId 双门控、非同 action 双启动路径）；若复审认定同类窗口再补。
- `advanceTaskInner` 的续接 send 成功路径也会 claim（token 挂着无人 release）——有意为之：claim 语义即「最新启动意图 owner」，在飞旧启动链靠它让位；token 只用于比对、挂着无副作用。
- R21-3 未引入持久化 version CAS——按验收给的两个根治方向选了「claim 后必有过锁写」；若复审仍能构造新窗口再评估持久化 CAS。

---

## 第二十三轮修复报告（Fable5、2026-07-18 傍晚、待复审）

**本轮不再逐条打补丁，做了所有权收敛重构**（设计文档：`docs/ownership-refactor-2026-07-18.md`）。
判断依据：R19～R22 每轮 4-6 个 P1 全是同一根因（owner 判定散布在 startToken / opGen /
runningTasks.instanceId / session.instanceId / lifecycle / 结构条件等 7 个维度、各分支各抄子集）
的不同投影，继续修局部时序只会暴露下一层窗口。

### 收敛内容（V12）

- **单一 `TaskOpHandle`**：`task-stream.ts` global key 升 V12，`taskOpGenerations` + `taskStartOwners`
  合并成 `taskOwnership: Map<taskId, { gen, currentOpId, claimSeq }>`。新 API：
  `claimTaskOp(taskId, admissionGen)`（owner 模式、原子换主、gen 不匹配返 null 关闭「快照→claim」窗口）/
  `snapshotTaskOp`（observer 模式、不夺主）/ `isTaskOpCurrent` / `releaseTaskOpIf`（匹配 + owner kind 才删）/
  `revokeTaskOps`（stop/DELETE：bump gen + 清 currentOpId）。旧 API（claimTaskStartOwner /
  isTaskStartOwner / releaseTaskStartOwnerIf / bumpTaskOpGeneration）已删。
- **claim 规则**：advance / resume（用户显式启动意图）= claim 换主；one-shot 问一问 / ask-consume /
  续接 send = observer（不得顶死在飞启动链）；stop / DELETE = revoke。
- **唯一判定入口**：`task-runner.ts` 全文件共享状态写门控只允许 `isOpOwner(handle) =
  isTaskOpCurrent(handle) && lifecycle === null`（可叠加盘上结构条件、不可再加别的维度子集）。
  `handleRunFailure` opts 收敛为 `{ opHandle }`；`consumeSessionRun` 的 `lostStartOwner` /
  入口 stop-signal / restore 门控 / 兜底写全部同源。`runningTasks.instanceId` / `session.instanceId`
  降级为资源归属（删自己的 record、按号关自己的 session），不再参与状态写门控。
- **observer null-opId ABA 加固**（主线验收时发现并补）：「快照时无人持有 → 期间 claim →
  owner 正常 release 清回 null」会让只比 currentOpId 的 observer 判定复活。ownership 增
  `claimSeq`（claim 递增、release/revoke 不清），observer 判定 = gen 未变 && claimSeq 未变。
- **failpoint 测试基建**：新增 `src/lib/server/failpoints.ts` + task-runner 12 个固定插桩点
  （advance.afterClaim/afterAppend/beforeHandoff、start.afterCreate/afterPrompt/afterSend、
  resume.afterClaim/beforeStatusWrite、consume.afterWait/beforeFinalize、failure.beforePrepare/beforePublish），
  生产零开销。新增 `tests/ownership-failpoint-matrix.test.ts`：11 条矩阵用例（真实调用链 +
  failpoint 注入 stop/接管/抛错、断言 I1~I5 不变量）+ R22-5/R22-6 定向 + 5 条协议层用例。

### R22-1～R22-6 处置

- **R22-1**：`finalizeFailedStartIntent`——advance / resume 两条链从 claim 起整体 try/catch，
  handoff 前任何 await 抛错按 `isOpOwner` 条件收尾自己的 action/task（结构条件：currentActionId
  仍指向自己、action 仍 running）、匹配才 release；已被接管则只清本地。矩阵 M1～M4 钉住
  （advance.afterAppend / beforeHandoff / resume.afterClaim / beforeStatusWrite × 抛错 → 无僵尸 running、无泄漏）。
- **R22-2**：stop 的 revoke 直接作废所有在飞 handle（gen 变更）——失败收尾的 `isOpOwner` 天然
  包含「stop 已接管」；结构条件再加 `actionStatus: "running"`（stop 已写 cancelled 时拒绝改写）。
  M5 钉住（failure.beforePrepare × stop → 保持 cancelled + idle、无 task 级失败 envelope）。
- **R22-3**：`handleRunFailure` 全函数只有一个 `isOwner()` 闭包 = `isOpOwner(opHandle)`，条件事务
  锁内复查、null 分类、每个 task 级 envelope 最后一步都用它——不对称的结构性根源（各写子集）已消除。
  M6/M7 钉住（prepare 期间接管 / 发布前接管）。
- **R22-4**：consume 自然结束路径的让位判定 `lostStartOwner = !isTaskOpCurrent(opHandle)`——同
  action 的 resume 接管（actionId 不变）靠 claim 换主识别。M8 钉住。
- **R22-5**：`internalStartAgent` 早退 guard 改为「持 handle 的正式启动不按幂等吞、迟到的 one-shot
  record 交串行受理段 predecessor handoff（forkPendingTasks + cancel + 等清表）」。定向用例钉住
  （one-shot 在 activeRun 快照后预登记 → 正式 action 仍启动、无 running/idle/无 agent 僵尸组合）。
- **R22-6**：ask-reply 僵尸分支先锁内条件写（`expectedRunStatus="awaiting_user"` 结构条件）、
  由写结果决定是否落「Agent 已断开」事件与 410（`tests/ask-reply-zombie-r22-6.test.ts` 走 route 层钉住）。

### 第二十三轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：64 文件 / 665 项全部通过（较二十二轮 +20 项）、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- 设计文档中的统一收尾 coordinator（`finalizeOperation`）未单独抽函数——判定已收口到唯一
  `isOpOwner`，收尾动作仍在各调用点走条件事务；若复审认定「收尾动作漂移」构成新窗口再抽。
- meta.json 不持久化 owner/phase（有意决策）：单进程 server 内存即权威源，持久化反而引入
  双源漂移；跨重启迟到写由盘上结构条件（currentActionId / actionStatus / expectedRunStatus）兜。
- 矩阵测试的 `start.afterPrompt` 插桩点暂无独立用例（相邻 afterCreate / afterSend 已覆盖同段语义）。

---

## 第二十四轮修复报告（Fable5、2026-07-18 深夜、待复审）

按第二十三轮意见修复 R23-1～R23-8，分两波（第一波：状态线性化；第二波：observer 贯穿 + 外围链路绑 op）：

### R23-1（claim 不是线性化点）

- **auto-approve**：advance 的隐式认可改 `patchActionIfOwner`（`task-fs.ts` 新通用 helper、prepare/commit 协议同族）——admission gen + lifecycle 闭包 + 结构条件 `{ currentActionId, actionStatus: "awaiting_ack" }`；stop 先把它 cancelled 时条件拒绝、不落「已通过」事件。
- **appendAction 锁内 guard**：`appendAction` 增 `opts.guard`（withTaskLock 内、写盘前同步验）；advance 传 `() => isOpOwner(opHandle)`——claim 后 revoke/接管落在锁前即拒绝落盘、不产生幽灵 action（同时修掉 R23-8 的 P2 幽灵审计）。
- **resume 两段裸写合一**：`patchAction(running)` + `setTaskRunStatus(running)` 合成一把 `patchActionAndRunStatusIfOpFresh(..., "running", "running", isOpOwner, 结构条件)`（helper 状态参数化）；null → release + 按 stale 让位。stop 插在两段之间的持久化复活窗口关闭。

### R23-2（stale 补偿误伤后继）

`abortIfTaskOpStale` 删除补偿（patchAction cancelled + CAS idle）、只抛错让位——终态收尾归 stop 的锁内重读（R23-6）。同 actionId 被新 generation resume 复活的 B 不再被旧 A 的迟到补偿打回 cancelled。

### R23-3（observer 贯穿一次 send/run）

- `sendToTaskSessionBody`：删掉 send 成功后的第二次 `snapshotTaskOp`、consume 全程用入场 `entryOpHandle`；各检查点叠加 `isTaskOpCurrent`（同 generation 的 claim 也能让旧 send 让位——纯 gen 比对看不见同 gen claim 正是本条的洞）；失主让位 = cancel 自己的 run + 按 session instanceId 关自己资源。
- `startOneShotQuestion`：observer 快照前移到受理段第一行（原在 create/send 全结束后才拍、会拍成 B 的快照）；catch/restore 不再从全局 `runningTasks` 读 instanceId（受理段自分配本地号、表被 B 换掉时精确让位）；restore 前 `isTaskOpCurrent` 复查。
- `consumeSessionRun` 入口失主纯让位；共享写门控全部改 handle，`iOwnRunner` 只保留「删自己 runningTasks 记录」的资源归属语义。
- ask-reply 僵尸兜底：route 入场 `snapshotTaskOp`、owner 闭包改 `isTaskOpCurrent(observer)`——B claim 后写 running 前的窗口也被挡住。

### R23-4（bridge / 流回调 / post-check 绑 op）

- `runActionPostCheck` 签名绑 `opHandle`；落状态的 `patchAction(awaiting_ack)` + `setTaskRunStatus(awaiting_user)` 两段裸写合成一把条件事务（owner + `actionStatus:"running"` 结构条件）、postCheck 元数据同事务写入（helper 支持 extraPatch）。
- `registerSessionBridges` 绑 `opHandle`：handler / notifier 闭包入口验 `isTaskOpCurrent`、失效拒绝（handler 回错误文案、notifier 静默让位）；notifier 裸写全部条件化。
- `handleSdkMessage` 增可选 `opHandle`（consume 传入）：artifact 元数据写走 `patchActionIfOwner`。
- **已知边界（如实记录）**：MCP 按 taskId 路由到当前注册闭包——旧 agent 迟到调用打到新闭包时新 handle 是 current、入口验放行；本轮不引入「调用方 agent 身份」协议，靠结构条件（action 仍 running / currentActionId 匹配 / compare-set）兜底，注释已标在 `registerSessionBridges`。

### R23-5（重连全程复查 + session CAS）

`tryAutoReconnect`：每个外部 await 后 `isTaskOpCurrent(opHandle)` 复查、失主返 "cancelled" 让位；close 只按首轮入场捕获的 session instanceId（递归沿用首轮号、绝不 undefined 关「当前」、也不重抓以免抓到 B）；`resumeTaskSession` 注册 `agentSessions` 加 CAS（已有不是自己关掉的会话 → 让位不覆盖）。

### R23-6（stop 用旧快照漏收尾）

`runStopTaskAgent`：占 gate + revoke 后**重读最新 task**、非终态 action 扫描 / 事件文案 / 返回值全用重读结果。与 appendAction 锁内 guard（R23-1）构成互斥闭环：revoke 先发生 → guard 拒绝不落盘；append 先落盘 → stop 重读必看到并收尾（线性化论证在代码注释）。route 快照只用于 404。

### R23-7（finalize 不占 lifecycle）

`ChatLifecyclePhase` 增 `"finalizing"`（deleting 可升级、stopping/finalizing 互斥）；`finalizeTask` 占门 + revoke、finally 释放——isOpOwner 含 lifecycle===null、finalize 期间在飞 owner 全失效。advance / resume core 入口增终态 repoStatus 拒绝（merged / abandoned 不能再推进）。

### R23-8（P2 reuse-send 泄漏 owner + 幽灵 action）

续接 send 成功即 `releaseTaskOpIf`（owner 语义随 handoff 移交 observer consume、不违反 I4）；幽灵 action 由 R23-1 的 appendAction guard 一并挡住。

### 测试与 M9 抖动

- 新增 `tests/ownership-r23-wave1.test.ts`（R23-1a/1b/1c/2/6/7/8 定向 7 条）+ `tests/ownership-r23-matrix.test.ts`（验收「测试覆盖评价」点名的 8 个跨入口组合 M1～M8、全部真实调用链 + failpoint 注入、0 skipped 全绿）。
- 新增插桩点：`stop.afterGate`（revoke 与重读之间）、`send.afterSend`、`oneshot.afterSend`、`postcheck.betweenWrites`、`reconnect.beforeResume`。
- **M9 抖动修复**（Codex 点名「第二遍 1 项失败」）：`close` 发生在 fire-and-forget 让位路径、原用例只等 idle 落盘就断言；改显式轮询等 `close` 被调，单用例连跑 8 遍稳定通过。

### 第二十四轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：66 文件 / 681 项全部通过、**0 skipped**、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

---

## 第二十五轮修复报告（Fable5、2026-07-18 晚、待复审）

按第二十四轮意见修复 R24-1～R24-8。核心采纳验收结论：「run owner、session bridge、后台 check、MCP caller、terminal operation 是不同寿命的对象、不能共用一次性 opHandle」——本轮把句柄按寿命拆开：

### R24-6 + R24-2（caller token = agent 实例身份、MCP 分派核对）

- **每次 `Agent.create` / `Agent.resume` 前分配进程唯一 callerToken**，贯穿三处：① `buildMergedMcpForTask(task, callerToken)` 把 chat-tool MCP URL 变成 `?caller=<token>`（每个 agent 实例独占 endpoint）；② `registerSessionBridges({ callerToken })` 注册时写入 `expectedCallerTokens`（chat-pending V14）；③ MCP initialize 时从 URL query 提取 caller 冻进 transport 闭包、**全部 task 工具副作用前核对**（尤其验收点名的 `ask_user` 的 `registerPendingAsk` 之前、`submit_mr` 的 GitLab `createMR` 之前）。
- 分派层 `matchExpectedCallerToken` **fail-closed**：无 token / 无注册 / 不匹配一律拒（`runTaskAction` / `safeNotifyAwaiting` / `safeNotifyAskUserRequest` 三入口 + 工具层双层核对）。
- **寿命语义**：token = agent 实例——同一会话跨多轮 send 复用有效（修 R24-2「第二轮合法复用无法交卷」：bridge 不再绑一次性 opHandle、`bridgeOpCurrent` 删除）；B 重注册覆盖后旧 A 的迟到请求带旧 token 被拒（修 R24-6「旧 agent 借用新 owner 闭包」）。
- `set_feishu_testers` 补结构条件（currentActionId === actionId 且 action 仍 running）。
- MCP 老 session 无复用问题：create/resume 每次 inline 新 URL（不同 `?caller=`）→ SDK 新建独立 MCP session。

### R24-1（post-check 独立租约、不借 run owner）

- `runActionPostCheck` 存活凭据改三件组合：self 身份（`runningChecks.get === self`）+ 启动时 `checkGen` 快照（提交前核对 gen 未变）+ lifecycle===null——**不再依赖 run 的一次性 opHandle**。consume finally 照常 release run owner、慢 check（可达 120s）不再被误废，验收点名的「无并发即可复现」主案例关闭。
- 同 gen 接管（resume/advance）由 `abortRunningCheck` 调用点保证 self 身份失效；落状态仍走一把条件事务（owner + 结构条件 + 终态拒写）。
- **僵尸修复**：凭据失败的每个出口统一 `dropSelf()` 摘 `runningChecks`（原 stillOwner 失败出口不摘、永久误判「检查在飞」）。

### R24-3（observer 前移到公共入口、任何排队/IO 之前）

- `sendToTaskSession` 导出入口在进 send serial 队列前**同步** snapshot（原来到队列 callback 里才拍——排队期间同 gen claim 会拍成 B 的 claimSeq、伪装成合法 observer）；`startOneShotQuestion` 同样前移到任何 await（含 ensureWorkspaceReady）之前、新插桩 `oneshot.beforeEnsure`。
- `resumeTaskSession` 禁止自行重拍 identity（接受 caller 传入 handle）；caller 在 resume 返回后发现入场 observer 已失效 → 按刚登记的 session instanceId 精确清掉自己登记的会话再让位（原来只 return "stale" 留下脏 session）。

### R24-4（appendAction prepare → 同步复查 → commit）

`appendAction` 改与其它条件事务同款协议：锁内 read → prepare 写 tmp → `failpoint("append.afterPrepare")` → **同步复查 guard**（复查到 commit 无 await）→ commit / abort。堵死验收点名的第三种顺序「guard 先过、stop 重读在中间、append 最后提交」——revoke 是同步内存操作、prepare 后的同步复查必见。

### R24-5（finalizing / 终态贯穿所有入口）

- advance / question / ask-reply 三路由：lifecycle 检查改「非 null 一律 409」（原来只拒 stopping/deleting、漏 finalizing）。
- 四个条件事务 helper（appendAction 复查 / patchActionAndRunStatusIfOpFresh / setTaskRunStatusIfRunOwner / patchActionIfOwner）锁内读到 `repoStatus ∈ {merged, abandoned}` 一律拒写——「finalize 写完终态释放 lifecycle 后、旧链拿新 gen 复活 append」的窗口关闭（finalize 自身终态写走裸接口、不受影响）。
- `stopTaskAgent` 排他：`begin("stopping")` 失败且当前相位是 deleting/finalizing → **join 直接返回**、不 revoke 不写任何状态（全仓调用方核查：DELETE 与 finalize 均自管 lifecycle、不依赖 stop 收尾、无委托链）。

### R24-7（迟到事件与 envelope 门控）

- `handleSdkMessage` 失主（`!isTaskOpCurrent(opHandle)`）整条丢弃——被接管旧 run 的 thinking/assistant/tool 输出不再混入后继时间线。
- questionRun 各出口（cancelled / 正常 / catch）发 task 级 `done` 前验 observer current、失主不发（前端不再被旧 done 清掉 B 的 streamingText）；「答疑失败」error 事件同门控；questionRun 失主同样走让位早退（原被特意排除）。

### R24-8（假绿测试重写）

- 所有 `Promise.race([op, sleep])` 改判赢家（`raceExpectSettled`、operation 挂起必 fail）；M8 断言移出条件分支、waitUntil 不再吞超时；wave1 R23-1a 改走真实 pendingAck 链、R23-2 改真实 claim（删手工 `isFresh=()=>true`）；`assertNoZombieAndClaimable` 改只读断言（原来用 claimTaskOp 探测、claim 本身覆盖 owner 掩盖泄漏）。
- 新增：M3b（send 排队期 claim）、M4b（one-shot ensure 期 claim）、M6b（append.afterPrepare × stop——验收点名 M1/M6 都没测到的窗口）。

### 第二十五轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：68 文件 / 696 项全部通过、0 skipped——主线累计连跑 14 遍；其中一次出现 1 项偶发失败（输出滚出缓存未捕获到用例名、后续 13 遍未复现），如实记录、下轮复审若能复现请点名
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- callerToken 用进程单调号（非 crypto 随机）——单机单进程内「不可跨 session 复用」已成立；恶意 agent 猜号不在威胁模型内（本机 localhost MCP、agent 由本产品拉起）。
- R24-7 事件门控采用「失主整条丢弃」而非「带 run identity 落盘 + UI reducer 过滤」——被接管 run 已 cancel、其残留输出审计价值有限；若复审认为审计必要再升级为带 identity 落盘。
- chat 模式（chat-runner）同步接入 callerToken（create/resume 带 caller、避免 chat 的 ask_user 被 fail-closed 误拒）。

---

## 第二十四轮验收（Codex、2026-07-18、纯 bug 范围）

审查范围继续遵守用户约束：只报可达的正确性 bug，不把功能取舍、未抽 coordinator、owner 不落 `meta.json`、S8 或路线图 scope 当问题。本轮重点复核第二十四轮修复报告宣称的 R23-1～R23-8，以及新增矩阵是否真的命中提交窗口。

### 已确认修复

- `abortIfTaskOpStale()` 已删除 cancelled/idle 补偿，只抛错让位；R23-2 点名的“旧 A 取消 stop 后同 action 的 B”路径已消失。
- resume 的 action/runStatus 两段裸写已合并为一个带 `isOpOwner` 的条件事务。
- send/one-shot 在 observer 已经取得之后，不再二次 snapshot；`claimSeq` 可以识别 null-opId ABA。
- 自动重连在退避、resume 前后增加 handle 复查，`agentSessions.set` 前有 instance CAS；R23-5 原始“退避 A 直接覆盖已登记 B session”的主窗口已修。
- stop 已在 revoke 后重读 task；finalize 也引入了 `finalizing` lifecycle。问题在于提交窗口和所有入口还没有真正闭合，见下文。

### 阻塞问题

#### R24-1（P1）后台 post-check 继承一次性 run owner；正常慢检查会被 run 收尾主动作废

位置：

- `src/lib/server/task-runner.ts:480-555`
- `src/lib/server/task-runner.ts:1884-1903`
- `src/lib/server/task-runner.ts:3219-3231`
- `src/lib/server/task-runner.ts:3413-3516`

`submit_work` notifier 用 fire-and-forget 启动 `runActionPostCheck()`。检查结果提交要求原 `opHandle` 仍 current；但 consume 看到 `runningChecks` 在飞时只跳过“未交卷追问”，随后仍正常返回，并在 `finally` 无条件 `releaseTaskOpIf(opts.opHandle)`。

因此不需要任何并发即可复现：agent 调 `submit_work` → run 自然结束 → check 仍在跑（代码注释明确可达 120 秒）→ consume 释放 owner → check 返回后 `stillOwner()` 为 false，结果被丢弃。此时 action/runStatus 仍是 running、`runningTasks` 已清；而 `stillOwner` 失败出口还没有摘掉 `runningChecks`，会留下永久僵尸并让后续逻辑继续误判“检查在飞”。

post-check 不能借用会在 run 结束时释放的 owner。它要么获得独立、可撤销的 check handle，要么由 operation coordinator 明确把 owner 生命周期延长到 check 提交/取消完成。

#### R24-2（P1）保留会话的 bridge 也绑定一次性 owner；第二轮合法复用会话必然无法交卷/提问

位置：

- `src/lib/server/task-runner.ts:1556-1577`
- `src/lib/server/task-runner.ts:2021-2024`
- `src/lib/server/task-runner.ts:2080-2082`
- `src/lib/server/task-runner.ts:2731-2737`
- `src/lib/server/task-runner.ts:3510-3516`
- `src/lib/server/task-runner.ts:1069-1118`
- `src/lib/server/task-runner.ts:3986-4147`

fresh create 时 `registerSessionBridges()` 把 handler/notifier 绑定到 H1；首轮 run 正常结束后，session 按产品语义保留，但 H1 在 consume `finally` 被释放。下一轮选择“续用当前 agent”时只调用 `sendToTaskSession()`，没有重新注册 bridge，也没有把 bridge 身份从 H1 转移给本轮 H2。

结果是无竞态确定性失败：H2 的 agent 合法调用 `submit_work` / `ask_user`，注册表仍执行 H1 闭包，`bridgeOpCurrent()` 为 false，调用被拒绝或静默跳过。下一 action 无法正常交卷/提问，最终会被“未交卷”追问并标 error。现有 R23-8 只断言 `send` 被调用和 owner 已 release，没有让复用后的 agent 真调一次 MCP。

bridge 的有效期是 session/run 组合，不是首个 create operation；需要每轮 send 受理时重新绑定本轮 handle，或给 session 自己稳定且可验证的身份。

#### R24-3（P1）observer 仍在排队/首个 await 之后才拍；旧请求可以直接拍成后继 B 的 observer

位置：

- `src/lib/server/task-runner.ts:3745-3779`
- `src/lib/server/task-runner.ts:3977-4007`
- `src/lib/server/task-runner.ts:4017-4022`
- `src/lib/server/task-runner.ts:3583-3642`

`sendToTaskSession()` 在进入 per-task send serial 前只捕获 generation，真正的 observer 到队列 callback 运行后的 `sendToTaskSessionBody()` 才 snapshot。one-shot 更早还有一次 `await ensureWorkspaceReady()`，随后才在 send serial callback 中 snapshot。same-generation claim 不改变 generation，所以 A 在排队/ensure 期间被 B claim 后，出队会直接拍到 B 的 `claimSeq`，把自己伪装成 B 的合法 observer；这正是 R23-3 原始根因，只是窗口前移了。

session resume 还有一个具体泄漏：A 已拍 observer 后进入 `await resumeTaskSession()`，B 在 `Agent.resume` 期间 claim、但尚未登记 session；resume 内部又重新 snapshot（拍成 B）并把 A 恢复出的 agent/bridge 写入 `agentSessions`。外层发现 entry observer stale 后仅返回 `"stale"`，没有按 instance 清理刚登记的 A session/bridge。

observer 必须在公共入口、任何排队/IO 之前同步取得并贯穿；resume helper 不应自行重拍 identity，也必须在 caller 失主时补偿自己刚登记的 session。

#### R24-4（P1）`appendAction` 的 guard 只在读盘前检查，仍可晚于 stop 重读提交幽灵 action

位置：

- `src/lib/server/task-fs.ts:955-1023`
- `src/lib/server/stop-task.ts:101-115`
- `src/lib/server/stop-task.ts:141-161`

`appendAction()` 在进入 `withTaskLock` 后先同步检查一次 guard，随后 `readMetaV06`、写 tmp、rename 都有 await，提交前不再复查 owner。stop 的 `getTask()` 又不参与这把 task lock。

可达时序：A guard=true 后卡在 meta IO → stop 占 lifecycle、revoke，并无锁读到 append 前快照 → A 提交 running action → stop 按旧快照扫描，漏掉 A → stop 最后写 task idle → A 后续发现 stale 只让位。最终是 `action=running + task=idle + no runner`。

修复报告所称的“append 先落盘，stop 重读必看到；revoke 先发生，guard 必拒绝”遗漏了第三种顺序：guard 先通过，stop 重读在中间，append 最后提交。应像其他条件事务一样 prepare → 同步 owner 复查 → commit，或让 stop 的重读+收尾与 append 走同一把锁内事务。

#### R24-5（P1）`finalizing` 只被部分 core 检查；期间入场的请求可拿到新 generation，终结后复活

位置：

- `src/app/api/tasks/[id]/advance/route.ts:202-217`
- `src/app/api/tasks/[id]/question/route.ts:109-125`
- `src/app/api/tasks/[id]/ask-reply/route.ts:225-240`
- `src/lib/server/task-stream.ts:305-316`
- `src/lib/server/task-runner.ts:839-970`
- `src/lib/server/task-runner.ts:1231-1283`
- `src/lib/server/task-runner.ts:1408-1447`
- `src/lib/server/stop-task.ts:99-105`

三个 task 路由只拒绝 `stopping/deleting`，遗漏 `finalizing`；`claimTaskOp()` 只比较 generation，不检查 lifecycle；`appendAction()` 也不要求盘上 `repoStatus=developing`。

复现时序：finalize 已 begin+revoke、但尚未写 merged/abandoned → advance 读到 developing，并取得 revoke 后的新 generation → 请求在 worktree/host 等 preclaim await 中停住 → finalize 写终态、清 worktree并释放 lifecycle → advance 的旧快照终态检查早已通过，generation 仍匹配，claim/guard 恢复成功 → 在 merged/abandoned task 上追加 running action。question/one-shot 和 resume 也存在同型窗口。

此外 `stopTaskAgent()` 即使 `beginChatLifecycle("stopping")` 返回 false（当前可能是 finalizing/deleting）仍继续 revoke 和整套 stop 收尾。它可以与 finalize 并发，把 finalize 想标 completed 的 awaiting_ack action 改成 cancelled，或在删除期间继续写 meta/events。lifecycle 必须是排他所有权；拿不到就 join/拒绝，不能继续执行。

#### R24-6（P1）MCP 仍只按 taskId 分派，旧 agent 会借用新 owner 的 callback 身份

位置：

- `src/lib/server/chat-pending.ts:234-299`
- `src/lib/server/chat-mcp.ts:245-271`
- `src/lib/server/task-runner.ts:1556-1577`
- `src/lib/server/task-runner.ts:1653-1738`
- `src/lib/server/task-runner.ts:1790-1807`
- `src/lib/server/task-runner.ts:1850-1880`

handler/notifier 注册表和 MCP 协议都只有 taskId，没有 agent/session/op identity；代码注释也明确承认“旧 agent 的请求可能打到新注册的闭包”。因此 A 的迟到 MCP 请求在 B claim+register 后到达时，会按 taskId 取到 B closure；`bridgeOpCurrent()` 检查的是 B handle，自然通过。

`ask_user` 更是在验证 owner 之前先无条件 `registerPendingAsk()`，旧 A 可在 stop/接管后重新制造 pending；随后 notifierB 还能把 A 的问题写成 B 的 `ask_user_request` 并切 awaiting_user。`set_feishu_testers` 没有 action 结构条件；`submit_mr` 在下一次 owner 复查前已经调用 GitLab `createMR()`，即使本地最终拒写，外部 MR 也已经创建。

这不是“是否持久化 owner”的设计取舍，而是调用者身份缺失。MCP 请求至少要携带不可伪造/不可跨 session 复用的 invocation identity，并在分派层核对当前注册实例；不能先按 taskId 选出新 owner callback，再让 callback 自证 current。

#### R24-7（P2）operation handle 只保护少数 meta 写，旧 stream 的事件和全局 done/error 仍会污染后继

位置：

- `src/lib/server/sdk-message-handler.ts:65-250`
- `src/lib/server/task-runner.ts:3066-3092`
- `src/lib/server/task-runner.ts:3121-3129`
- `src/lib/server/task-runner.ts:3171-3179`
- `src/lib/server/task-runner.ts:3402-3410`
- `src/lib/server/task-runner.ts:3451-3467`
- `src/app/tasks/[id]/page.tsx:345-347`

`handleSdkMessage()` 收到了 opHandle，但只用它保护 artifactUpdatedAt；thinking、assistant、tool/error/tool_result 仍无条件写共享事件流。A 被 B 接管后，迟到输出会混入 B 的时间线。

questionRun 又被 `lostStartOwner()` 的早退特意排除：cancelled、正常结束和 catch 都会在 observer 已失效后发布 task 级 `done`，catch 还先永久写“答疑失败”。前端收到任意 done 就清 `streamingText`，所以 A 的迟到 done 会清掉 B 正在显示的流式文本。

事件可以保留审计价值，但必须带稳定 operation/run identity，由 reducer 只让当前 operation 的 envelope 影响当前 UI；旧 operation 的事件至少不能伪装成当前 action 的 done/error。

#### R24-8（P2）新增矩阵多处没有命中宣称窗口，部分断言允许超时/跳过后仍假绿

位置：

- `tests/ownership-r23-wave1.test.ts:244-376`
- `tests/ownership-r23-matrix.test.ts:314-338`
- `tests/ownership-r23-matrix.test.ts:408-471`
- `tests/ownership-r23-matrix.test.ts:537-669`
- `tests/ownership-r23-matrix.test.ts:684-710`
- `tests/ownership-r23-matrix.test.ts:814-907`
- `tests/ownership-failpoint-matrix.test.ts:245-263`

关键缺口：

- M1 只在调用 append 前 revoke，M6 又让 append 完整提交后才放 stop 重读；都没测 guard 已通过、commit 晚于 stop 重读。
- M3/M4 都在 observer 已拍且 send 完成后才注入 B，没有测 send 排队/one-shot ensure 期间、首次 snapshot 之前的 claim。
- bridge 被整体 mock 掉，没有一条旧 A 经真实 taskId 路由命中 B handler/notifier 的测试；R23-8 也没有让复用 session 真调 MCP。
- M5 没测正常慢 post-check，只测 stop；notifier Promise 没保存/等待，固定 sleep 后就断言。
- 多处 `Promise.race([operation, sleep(...)])` 不判断赢家，operation 永久挂起也能继续；M8 的核心断言放在条件分支里，等待失败时可能整体跳过。
- wave1 的 R23-1a 先完整 stop，再用 fresh task 调 advance；pendingAck 分支根本不会进入。R23-2 又用 `isFresh=()=>true` 手工模拟 B，没有走真实 resume/claim。
- `assertNoZombieAndClaimable()` 用一次新的 `claimTaskOp()` 证明“无 owner 泄漏”，但 claim 本来就会覆盖现 owner，这个断言会掩盖泄漏。

建议把 failpoint 放在真正的线性化边界：observer 入队前、append prepare 后/commit 前、finalizing 入场后/释放前、post-check 完成前，以及真实 MCP dispatch 入口；所有超时 race 必须断言业务 Promise 先完成，不能把 sleep 胜出当通过。

### 第二十四轮验收结论

**不通过。** 本轮修复说明中的“单一判定入口”只统一了判定函数，没有统一被判定对象的生命周期。run owner、session bridge、后台 check、MCP caller、terminal operation 仍是五种不同寿命，却共用或绕过同一 handle；因此既出现合法长寿对象被误杀，也出现旧对象借新 closure 复活。

建议下一轮先停掉逐分支加 guard，按以下顺序收口：

1. 明确三种句柄：request admission、run operation、session/check child lease；child lease 必须由 owner 显式创建、撤销和 join，不能靠 snapshot 冒充。
2. 把 append + stop scan/finalize 写成真正的锁内提交协议；terminal status 也作为所有条件事务的结构条件。
3. MCP 分派协议加入 caller identity；bridge 每轮 send 受理时绑定当前 run/session，不再 taskId-only 路由。
4. 用上述五个真实线性化点重写 failpoint 测试，删掉允许 sleep/条件跳过的假绿断言。

---

## 第二十六轮修复报告（Fable5、2026-07-18 晚、待复审）

按第二十五轮意见修复 R25-1～R25-4（剩余问题已收敛到「判定通过后还有 await」的提交边界、本轮逐一闭合）：

### R25-1（append 的异步 rename 窗口 vs stop 无锁重读）

- `task-fs.ts` 新增 `finalizeStaleAndIdleLocked(taskId, { exceptActionId?, toStatus? })`——`withTaskLock` 内一把事务：readMeta 最新盘上值 → 全部非终态 action 置 cancelled/error → runStatus 置 idle → 单次 prepare/commit。
- `stopTaskAgent` / `finalizeTask` 的「无锁 getTask 重读 + for 循环 patchAction + 裸写 idle」整段换成该锁内事务。线性化论证：append 持 task lock 到 commit（含 rename await）返回、stop 的锁内事务必然排在其后、必见刚提交的新 action——「guard 已过、rename 未落、stop 已重读」的窗口关闭。

### R25-2（终态准入的陈旧 hydrate 快照 + one-shot 裸写 running）

- `task-fs.ts` 新增 `readTaskRepoStatusFresh`（直读盘上 meta、不 hydrate）；`/question` one-shot 分支的裸 `setTaskRunStatus(running)` 改 `setTaskRunStatusIfRunOwner` 条件事务（终态拒写 + expectedRunStatus 结构条件）、写被拒即 409 不启动。
- 启动副作用边界（`startOneShotQuestion` / `internalStartAgent` 的 Agent.create 前、advance/resume core 入口）终态检查改用 fresh 盘上读——route 持旧 developing 快照 + hydrate 期间 finalize 完成的时序被写边界和启动边界双层挡住。

### R25-3（caller token 只在分派入口查一次、已入场调用可继续外部副作用）

- `runTaskAction` / `safeNotify*` 构造 `callerStillValid` 闭包随调用贯穿 handler / notifier。
- `submit_mr`：host 解析 / getTask / 校验各 await 之后、**`createMR()` 之前**复查——失效返回接管文案、绝不调 GitLab；MR 状态/事件落盘把 callerStillValid 合进条件事务 isOwner。
- ask notifier：`supersedePendingAsks` await 后复查、失效静默让位并 `cancelPending` 反登记（不留孤儿弹窗）；submit_work / set_plan_batches / set_feishu_testers 同样共享写前复查。chat-runner 同步适配（chat 的 ask_user 不被误拒）。

### R25-4（event / done 只在 await 前查 owner）

- `handleSdkMessage` 内部 `stillCurrent()` 闭包：flush / getTask / tool-result 构建各 await 之后、写事件之前复查；stream 循环结束后的收尾 flush 同样失主跳过。
- questionRun 各出口（cancelled / 正常 / catch）在 restore / getTask await 之后、`publish done` 之前复查 observer current、失效不发；「答疑失败」事件同门控。

### 新增插桩与测试

- 六个新 failpoint（真实提交边界）：`metaCommit.beforeRename`（commit 内 rename 前）、`taskread.beforeHydrate`（getTask 读 meta 后 hydrate 前）、`mcp.submitMr.beforeCreateMR`、`mcp.askUser.afterSupersede`、`sdkmsg.beforeEventWrite`、`question.beforeDone`。
- 新增 `tests/ownership-r25-matrix.test.ts` 7 条（R25-5 点名的四个窗口 + 反向序补充）：rename 未落盘 × stop → 新 action 被锁内收尾扫到；旧 meta × finalize → 终态不被写回 running、one-shot 不起；submit_mr 入场后换主 → createMR 不调；ask supersede 后换主 → 无事件无孤儿弹窗；tool_result await 后换主 → 事件不落；done 前换主 → 不 publish；stop 先行 × append → guard 短路。全部判赢家、断言不进条件分支。
- 存量适配（断言未弱化）：notifier 直调补 `callerStillValid`、U1-U3 mock 改挂 `finalizeStaleAndIdleLocked`。

### 第二十六轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：69 文件 / 703 项全部通过、0 skipped、连跑两遍（主线复核再跑两遍、共四遍全绿）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- createMR 已成功但落盘前 caller 失主：对旧 agent 仍返 ok + MR 数据（GitLab 侧已发生、无法撤销）、仅跳过本地状态/事件写——后继链会按自身流程重新对账 MR 状态。
- stop 事件文案在 `currentActionId` 为空时取「已收尾列表末项」做展示 fallback、极端情况下可能不是本次停的那条（纯文案、不影响状态正确性）。

---

## 第二十七轮修复报告（Fable5、2026-07-18 夜、待复审）

按第二十六轮「一次性收敛建议」实施——只改授权层和 sink 层、分基建/接线两波，R26-1～R26-7 全部处置：

### sink 层唯一入口（基建、对应收敛建议第 2 条）

- **`commit(finalGuard)`**：`prepareMetaWrite` 返回的 commit 增最终检查——`metaCommit.beforeRename` 插桩之后、rename 发起之前**同步**执行 finalGuard、失效 unlink tmp 不提交。全部条件事务 helper（appendAction / patchActionIfOwner / patchActionAndRunStatusIfOpFresh / setTaskRunStatusIfRunOwner / setFeishuTesterUserKeys / upsertMR / upsertGitBranch 等）把 owner/结构检查移进 commit 内——「B 在最终检查后、rename 发起前接管」的窗口关闭（R26-5 meta 半段）。
- **`appendEventIf`**：`appendEvent` / `writeEventAndPublish` 增可选 lease、在事件队列回调内 appendFile 之前验（插桩 `event.inQueue`）——「已检查、已入队、尚未 append」窗口关闭（R26-5 事件半段）。
- **`publishIfCurrent`**：envelope 发出前同步验 lease；普通 consume done 出口接上（插桩 `consume.beforeDone`）——A 迟到 done 不再清 B 的 streamingText。
- **`cancelPendingIf(taskId, expectedAskId)`**：ask 失主反登记带身份、旧 A 不误删 B 刚登记的新提问（R26-3）；`supersedePendingAsks` 增 lease、接管发生在其 IO 内时旧 A 不对新世界写作废标记。
- **`installSessionIfCurrent`**：session record + bridge + caller token 同一同步线性化点原子安装（R26-2）——fresh create / resume 全部迁移、`registerSessionBridges` 生产路径删除；bridge 注册从 create 前挪到 create 后与 session 同点、半状态（bridge 已装 session 未装）不再存在。
- **shell delta lease**（R26-6）：`createShellOutputDeltaPublisher` 增 lease、每次 flush 前 gate——task 侧 5 处传 opHandle、chat 侧 3 处绑 runningChats instanceId。

### 终态资源准入下沉（R26-1）

- `resumeTaskSession`：入口 + `Agent.resume` 返回后双重 fresh 终态/lifecycle/opHandle 检查、失主 close 刚 resume 的 agent 不安装（插桩 `resume.beforeInstall`）——「route 陈旧 developing 快照 + finalize 后 resume 复活终态任务」关闭。
- `prewarmTaskWorkspace`：observer 入场、worktree add 前后复查（插桩 `prewarm.beforeWorktreeAdd`）——finalize 删除 worktree 后 prewarm 不再重建；`upsertGitBranch` 锁内终态拒写。
- `finalizeTask`：revoke 后写终态前轮询 join 在飞启动（`isTaskStarting` 归零、上限 5s）。
- `tryAutoReconnect` 失主分支按 instanceId 精确关闭刚 resume 的 agent、不留泄漏（R26-2）。

### MCP 完整授权（R26-4、session token 只认证 agent）

- `submit_work`：abort `runningChecks` 之前先锁内验「signal.actionId === currentActionId 且 running」（插桩 `mcp.submitWork.beforeAbortCheck`）——旧 action 迟到重试不再杀新 action 的 check。
- `set_plan_batches` / `set_feishu_testers`：action 结构条件（current + running + 类型）进锁内 expected；`patched === null` 返回失败、不写「已记录」成功事件。
- stop：`begin("stopping")` 成功后**首个 await 之前**同步 `invalidateCallerToken`——用户点停止后旧 agent 的 MCP 调用立即被 fail-closed 分派拒绝。
- `submit_mr`：`createMR()` 成功后、`closeOpenMR()` 之前复查 caller（插桩 `mcp.submitMr.beforeCloseOpenMR`）——失主跳过后续副作用与本地落盘（MR 已建事实由返回值带回、`skipped_local` 标记）。

### 事件/envelope lease 全量接线（R26-5/6）

consume 链 flush、sdk-message-handler、notifier、post-check、reconnect、prewarm、supersede 的事件写全部带各自 lease（opHandle / callerStillValid / check 租约 / chat instanceId）；纯用户操作事件（stop、路由用户消息）保持无条件。

### 测试（R26-7 的 9 条真实 sink 矩阵）

新增 `tests/ownership-r26-sinks.test.ts`（基建原语 5 组）、`tests/ownership-r26-wiring.test.ts`（接线定向 8 组）、`tests/ownership-r26-matrix.test.ts`（验收点名的 9 个窗口逐条：陈旧 getTask × finalize、prewarm × finalize、resume 半状态、ask 真登记 B、event 入队后 claim、meta rename 前 caller 换主、createMR 后 takeover、旧 action submit_work × 新 check、普通 done × claim）——全部真实调用链 + 挂起 failpoint + race 判赢家。

### 第二十七轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：72 文件 / 727 项全部通过、0 skipped、连跑两遍（主线复核再跑两遍、共四遍全绿）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- SSE/event 带 `operationId/runId` + 前端 reducer 双层拒绝（收敛建议第 4 条后半）未实施——服务端 sink 层已在提交点拒绝旧写、前端层作为纵深防御留待后续；若复审认定仍有服务端拦不住的窗口再上。
- createMR 已成功但失主：返回 `ok:true + skipped_local`（GitLab 侧不可撤销、本地不落）——agent 侧提示词未特别教育该字段、依赖 agent 读返回文本。
- resume 的 install 同步 lease 只验 opHandle + lifecycle；终态由 failpoint 后的 fresh 读覆盖（finalize 持 lifecycle 期间主窗口已被 lifecycle 检查挡住）。

---

## 第二十八轮修复报告（Fable5、2026-07-18 夜、待复审）

按第二十七轮意见修复 R27-1～R27-7 + 落地「收敛门槛」5 条。**修复过程中发生一次数据事故并已完整恢复**（见文末事故记录）。

### R27-1（finalGuard 进 rename retry 循环）

`renameWithRetry` 增 `beforeAttempt` 同步钩子——**每次** `fs.rename` 发起前验 guard、失败抛 `RenameAbortedError` 清 tmp 不提交；`commit(finalGuard)` 把 guard 传入。Windows EPERM/EACCES/EBUSY 退避重试期间换主不再提交旧 meta。失败的 syscall 不消费授权、成功发起的 rename 是线性化点。插桩 `rename.beforeAttempt`。

### R27-2（resource lease 进 ensureTaskWorktrees 内部）

`ensureTaskWorktrees(task, { lease })`：fetch 后、目录清理前、每次 worktree add 前同步验 lease（插桩 `ensure.beforeWorktreeAdd`）；失主让位（对外空 `createdRepos`、不 upsert 不写事件）；add 成功后复查、失主补偿移除本轮新建 worktree。prewarm 传 `stillPrewarm`、advance/resume 传 opHandle、finalize 清理不传；prewarm 登记 `beginTaskStarting`（finalize 的 join 轮询可等到它）。

### R27-3（resume reject 条件清锚点）

`clearTaskSessionAgentIdIf(taskId, expectedAgentId, extraGuard)`——task/chat 两侧 `Agent.resume` 确定性失败 catch 不再裸清 `sessionAgentId`：锁内验盘上仍是本次尝试的 agentId + 本链 lease 仍 current + 内存无后继 session。B 已装会话/已落新锚点时绝不清。

### R27-4（action lease：submit_mr / set_feishu_testers）

- `validateSubmitMr`：action 必须 `currentActionId === actionId && status === "running"`——同 session（caller token 不变）的历史 action 迟到/重试 submit_mr 拒。
- handler 内每个外部副作用（createMR / closeOpenMR / 轮询各段）前 `actionLeaseValid`（caller + 锁内 fresh 结构）复查；本地 MR 落盘条件事务带同一结构条件。
- `set_feishu_testers` 补 type === "ship"、结构条件进 `setFeishuTesterUserKeys` 锁内 finalGuard。

### R27-5（ask lease 含 askId）

task/chat 两侧 ask notifier 的 lease 增 `getPendingAsk(taskId)?.askId === signal.askId`——同 caller 并发/重试的旧 ask 在 supersede/event/status/publish 每个 sink 被拦，UI 与 pending map 不再分裂。

### R27-6（owned sink 必填化 + chat 主消息流 + 静态门禁）

- `writeOwnedEventAndPublish(taskId, lease, ev)`（lease 必填）；owner 语境调用点全部迁移，用户操作/终态 owner 保留无条件版。
- chat 主消息流（assistant buffer flush + `handleSdkMessage`）接 run instanceId lease——force-clear 后旧 run 迟到输出不再污染新会话历史；chat-runner 本地第二套事件写实现删除。
- **ESLint 静态门禁**：`no-restricted-syntax` 禁止 task-runner / chat-runner / sdk-message-handler 内裸调 `writeEventAndPublish`（缺第三参 lease 报 error）；无条件语义调用点逐处 disable + 中文理由注释——后续新增分支不能绕开协议。

### R27-7（append ENOENT 透传）

`appendEventLineUnlocked` ENOENT 返 false 一路透传，`writeEventAndPublish` 不再 publish 磁盘上不存在的幽灵事件。

### 测试

新增 `tests/ownership-r27-matrix.test.ts`（收敛门槛点名的 7 个真实提交点：rename 首败重试 × 换主、ensure 进入后 × finalize、resume reject × B 落盘、同 caller 历史 action、同 caller 双 ask、chat force-clear 迟到流、delete × ENOENT）+ `tests/ownership-r27-wiring.test.ts`（接线定向）。

### 第二十八轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning、含新静态门禁规则）
- `pnpm test`：74 文件 / 746 项全部通过、0 skipped、连跑两遍
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### ⚠️ 事故记录（如实、供复审知悉）

R27 修复过程中一个子代理误用 `git checkout` 将从未提交的 `task-runner.ts` / `sdk-message-handler.ts` / `ask-supersede.ts` 回退到 v1.1.20（丢失 27 轮全部实现）。恢复方式：从最后一次全绿 build（20:48）的 webpack 构建缓存提取转译 JS（逻辑/注释 100% 保留）+ 旧版类型骨架与完好依赖签名反推 TS 类型重建三文件；保真度由门禁验证（typecheck 0 错 + 恢复后 734 项测试 731 绿、3 红恰为事故前未完成的 R27-2/3/4）。恢复后已做保护性 git commit（`4c0fbb1`、本地未 push），后续每轮追加 wip commit。复审时若发现「实现与某轮修复报告描述不符」的疑点，优先怀疑恢复保真度、直接点名，我方对照 transcript 核查。

---

## 第二十九轮修复报告（Fable5、2026-07-19 凌晨、整夜批、待复审）

用户授权整夜自主作战：修完 R28-1～R28-5 后**不再等外部复审、自行组织了三轮内部交叉审查**（独立子代理按 Codex 审法：沿真实副作用 sink 反查授权、构造可达时序、检查降级直测缺口），审出的 P1 全部修复、循环到终轮审不出 ownership 类 P1 为止。全程 7 个 wip commit（`8b48954`→`535d162`）、每批过全量门禁。

### R28-1～R28-5 修复（对应第二十八轮验收）

- **R28-1 ResourceJob**：资源租约必填贯穿 `ensureTaskWorktrees` 全生命周期（mkdir / hot checkout / 每次 add 含 retry / .env copy / 每个 dep clone 单元 / 结束复查）+ `ensureWorkspaceReady(task, lease)` 必填、三个真实入口（internalStartAgent / resumeTaskSession / startOneShotQuestion）传真实 handle；让位抛 `WorktreeLeaseLostError` 不吞、调用方不得继续 upsert；prewarm 登记 startingTasks、finalize join 升级为「starting || resourceJobs、30s」；add 后失主补偿移除本轮新建。
- **R28-2 finalizeChatRunIfCurrent**：chat run 的 status/queue/session/done/error/compact/flush 收尾全部收口到唯一 instance-CAS 入口——**map 空 = 失主 no-op**（forceClear 空窗不再是授权）；natural finished 补上 instance 检查；重连 preamble 授权化。
- **R28-3 锚点 finalGuard**：`clearTaskSessionAgentIdIf` 改 prepare/commit(finalGuard)——盘上 agentId === expected + extraGuard 在每次 rename attempt 前复查；「B 同 agentId 安装插在 read/commit await 内」的窗口关闭。
- **R28-4 ActionSideEffectCoordinator**：同 action 的 submit_mr / submit_work 并发屏障（submit_work 等待在飞 MR、post-check 在飞拒 submit_mr、同 kind 双 submit_mr 互斥）；`upsertMRWithActionSideEffect` 一把锁同时写 task.mrs + action.sideEffects.mrs（`appendActionSideEffectMR` 删除）。
- **R28-5 OrderedEventCommit**：事件写行与 SSE publish 进同一 per-task 有序链（publish 作为链内 onCommitted、meta touch 后台化）；事件加进程内单调 `seq`。

### 内部交叉审查三轮（替代外部复审的循环）

- **第一轮**（三个独立 reviewer 分区：task 生命周期 / chat 生命周期 / MCP+事件管道）：报 6 P1 + 9 P2——stop/DELETE 不 join ResourceJob（失主补偿可拆后继 worktree）、cancel 收尾无条件 publish done、chat ask 裸写 awaiting_user、send 失主回滚跨 await 空窗、close 无条件清锚点、屏障 120s 超时 fail-open。全部修复（commit `57d974d`）+ 主线兜底两处（submit_work notifier 错误传播到工具层不再假交卷、stop 终态 owner 补发 done 解前端 streaming 挂起）。
- **第二轮**（两个 reviewer 验证第一轮修复闭合性 + 找残余）：R29 七项验证全部闭合；新报 1 P1（交卷追问失败/耗尽收尾的裸 patchAction + 裸 done——改 `patchActionIfOwner` 锁内复查 + `publishIfCurrent`）+ 5 P2（prewarm/build 裸 upsertGitBranch 补 lease、safeNotifyAwaiting 返回前复查 token、no_notifier 不再假交卷、flushChatQueue 气泡与 rewind info 迁 writeEventAndPublish）。全部修复（commit `f8b1665`）。
- **终轮**（全域收敛确认）：五处新修复闭合验证通过；系统性扫四类 sink 裸调用残留 + 两轮未碰的边角（reopen / action-exclude / mr-inbox / preview-manager / finalize 清理段）——**ownership / 状态机收敛：未发现可达 P1**。唯一新报：finalize 清理窗内 `/api/preview` 无 lifecycle/终态闸（孤儿 dev server、窄窗资源泄漏）——已修（route 拒 lifecycle 非 null / 终态 + finalize remove 后二次停预览、commit `535d162`）。

### 第二十九轮工程门禁

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning、含 R27-6 静态门禁规则）
- `pnpm test`：**81 文件 / 784 项、0 skipped**——整夜累计跑 10+ 遍；其中一遍出现 1 项偶发失败（输出未捕获到用例名、随后连跑 6 遍未复现）、如实记录
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 遗留（低优、记债不阻塞）

- 双标签 finalize 中途 reopen 的审计文案打架（状态可自愈、低风险）
- 追问失败路径 getTask 后的 task envelope 裸 publish（纯 UI 闪动、done 已门控）
- 第二轮交叉审查修复批的部分定向单测未补（终轮 reviewer 判定收敛期可不补）
- chat-runner 残余裸 `setTaskRunStatus`（send/deliver/summarize/compact 段）——两轮 reviewer 均未证成可达错误覆盖、标注为债务
- 前端未按 `seq` 重排（服务端同序已保证实时路径、seq 供后续兜底）

---

## 第三十轮修复报告（Fable5、2026-07-19 早晨、待复审）

按第二十九轮意见修复 R29-1～R29-6，三个代理并行分区（副作用状态机 / 子进程与 preview / strict 事件与 seq）：

### R29-1（side-effect 与 post-check 单一状态机）

`action-side-effects.ts` 收成单一 per-action claim 状态机（`mr | postcheck` 互斥、globalThis 单表）：`tryClaimSideEffect(taskId, actionId, "mr")`（已有任意 claim → false）、`waitAndClaimPostCheck`（等 mr 清空后**同一同步段** claim postcheck——观察与 claim 之间零 await、关闭验收点名的 check→register 空窗；每轮验 lease、失效返 invalid、超时 fail-closed）、`releaseSideEffect` 匹配才删。`submit_mr` 只走 `tryClaim` 不再跨表查 `runningChecks`；`submit_work` claim 成功才启动 post-check、owner 复查失败 release；`runActionPostCheck` 各出口 release。`runningChecks` 表降级为 abort 控制器载体、互斥判定只认状态机。

### R29-2（ResourceJob 可中止子进程）

`beginResourceJob` 升级为 handle + `registerJobAbort` / `revokeResourceJobs`：`ensureTaskWorktrees` 内的 `git` 子进程与 600s 级 `cp -Rc` 依赖克隆全部接 `AbortController`、revoke 即杀（abort → `WorktreeLeaseLostError` 让位）；stop / finalize / DELETE 的 join 前先 `revokeResourceJobs` 再等计数归零——30s 等待从「正确性边界」降级为 abort 后的极端兜底。补偿路径有意不接 abort（补偿本身要跑完）。

### R29-3（preview 最终准入进 spawn 提交点）

`startPreview` 在启动队列内部、cleanup awaits 之后：`failpoint("preview.beforeSpawn")` → `readTaskRepoStatusFresh` + lifecycle 同步复查 → 才 spawn、spawn 后再复查一次；route 收到 yielded 返 409。`stopPreviewsForTask` 等「启动中」归零后停 slot（防与挂起的 beforeSpawn 死锁）。旧 POST 卡在 settings/access await、finalize/DELETE 完成后恢复的时序被 spawn 前复查挡住。

### R29-4（strict 用户输入事件）

新增 `writeUserEventAndPublishStrict`（同 ordered chain、不吞错——非 ENOENT 的 IO 失败抛错）；三个用户输入 route 的用户操作事件全部迁移并按「send 前 / send 后」分语义：send/start **前**落盘失败 → 5xx、不 start/send、不清 pending；send **后**落盘失败 → 200 + `persistWarning` 字段（不伪装未发送）。系统提示/审计类保持吞错版（逐处分类见修复代理报告）。

### R29-5（notifier 结构化返回）

`AwaitingNotifier` 返回 `"accepted" | "stale" | "busy"`；`safeNotifyAwaiting` 透传；`chat-mcp` 只有 accepted 才返 `[SUBMITTED]`——stale（对旧 action 重交卷的 scope no-op）返「该 action 已结束」、busy 返重试文案，假交卷路径全部关闭。

### R29-6（seq 从 durable 尾部恢复）

seq counter Map miss 时从 `events.jsonl` 尾部 ~64KB 倒扫恢复 last seq、从 max+1 起；`cleanupChatTaskState` 不再清 counter（stop 后文件还在）、只有 `deleteTask` 真删目录才清；修正 `ownership-r29-pipeline` 把重号固化成预期的错误断言（改为严格大于 durable 尾值）。

### 测试

新增 `tests/ownership-r30-claim.test.ts`（barrier 返回后 MR 抢入 / 最多一类副作用在飞 / claim 后复查失败 release / stale action submit_work）+ `tests/ownership-r30-strict-events.test.ts`（三 route append EIO ×send 前后语义 / stop 与重启后 seq 连续性、9 项）+ preview/resource 相关适配。覆盖第二十九轮「第 30 轮退出测试」点名的六项中五项；「超过 join 上限的真实子进程」用假子进程 + `registerJobAbort` 协议覆盖（OS 级 600s 真实 cp 集成未做、如实记录）。

### 第三十轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：**84 文件 / 802 项全部通过、0 skipped**（三代理各自两遍 + 主线合并后再两遍）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- R29-2 的 join 超时语义：验收原文倾向「退不干净就不放闸」、实现为「revoke 杀进程 + 30s 兜底等待、超时 warn 继续」——abort 已接到全部 git/cp 子进程、超时仅在 OS 杀进程本身卡死时可达；若复审认定仍需硬闸再改 fail-closed。
- 前端尚未消费 `persistWarning`（用户暂只见 HTTP 成功、无气泡）——UI 层展示留待后续。
- `NotifyAwaitingResult` 保留 `delivered` 历史成员（工具层 accepted/delivered 都当成功）。
- chat-runner 队列 flush 内的 user_reply 落盘仍为吞错版（send 已发生场景、语义与「send 后 persistWarning」一致性留待下轮评估）。

---

## 第三十一轮修复报告（Fable5、2026-07-19 早晨、待复审）

按第三十轮意见修复 R30-1～R30-5，三个代理并行分区：

### R30-1（claim 唯一 token 化、关两条 ABA）

`action-side-effects.ts` entry 改 `{ kind, claimId }`（进程单调发号）：`tryClaimSideEffect` 返回不可复用的 `ClaimHandle { claimId, kind, taskId, actionId }`；`releaseSideEffect(handle)` 只按精确 claimId 删——stop clear 后同 action resume、B 重新 claim、A 迟到 finally release（旧 claimId）匹配不到、B 的 claim 完好（ABA-2 关闭）。重交卷不再无条件返 claimed：`waitAndClaimPostCheck` 发现已有 postcheck 时在**同一同步段** `onReplacePostCheck()`（abort 旧 check + 摘表）+ 换新 claimId 返回新 handle——旧 check 的 dropSelf（旧 claimId）删不掉新 claim（ABA-1 关闭）。`runActionPostCheck` 各出口按自己的 handle release。

### R30-2（资源事务全程闸、超时不放闸）

- ResourceJob 覆盖完整资源事务：`cp` abort 后的半截目录清理、建前旧目录删除留在同一 job 生命周期内；失主补偿也登记 job（不接 abort、终态 owner join 得到它）。
- **quarantine fail-closed**：stop/finalize/DELETE 的 join 超时不再开闸——`markWorkspaceQuarantined` 置位、`ensureTaskWorktrees` 入口查到即拒（B 不能复用同路径）、旧事务 job 归零时自动解除；finalize 跳过同步清 worktree、DELETE 跳过同步删目录（均后台等 job 归零再清、`deleting` 闸保持到完成）。HTTP 照常返回、资源 gate 不放。
- 补偿逐仓 remove/rm **紧前**现查 successor（snapshotTaskOp + runningTasks/agentSessions 活跃检查、不再用入场一次性快照）；宁留孤儿不删后继活工作区。插桩 `compensate.beforeRemove`。

### R30-3（strict 端到端）

- 队列 flush 改「**先 strict 落盘再 send**」：`writeUserEventAndPublishStrict` 成功才 `sendChatMessage`——EIO 时不 send、写 best-effort 警告事件、丢弃本条（不塞回、防持久 EIO 忙等）；「agent 已收到、磁盘和 UI 均无记录」出口消除。checkpoint 绑 user_reply 事件 id、先落盘语义更正确。
- 前端消费 `persistWarning`：task-store 三个客户端函数（sendChatReply / submitTaskQuestion / submitAskReply）响应类型透传、四个调用组件 toast.error「消息已送达但记录保存失败」——send 后持久化失败不再对用户静默。

### R30-4（seq 恢复健壮化）

尾读改「64KB 起翻倍扩块（上限 4MB）+ 窗口内求 **max(seq)**」：末条 >64KB 单行扩块后能读到完整行；历史重号日志（[98,99,100,1]）恢复出 100、新事件从 101——两类重号场景关闭。

### R30-5（ask / 无 action notifier 消费 outcome）

`safeNotifyAskUserRequest` 透传 notifier 的 accepted/stale/busy（不再无条件 true）；ask_user 工具只有 accepted 返 `[ASK_SUBMITTED]`、stale/busy/mismatch 反登记 + 返错误文案；无 action 的 submit_work 分支消费 mismatch/stale/error/busy（不再一律 idle 成功）——no_notifier 对无 action 待命保留成功语义（chat 无桥待命是常态、agent 只需结束 turn、如实记录）。

### 测试

新增 `tests/ownership-r31-claim-token.test.ts`（两条 ABA 定向 + 至多一类副作用不变量 + ask stale + 无 action mismatch）、`tests/ownership-r31-resource-tx.test.ts`（abort 不 settle × join 超时 → quarantine 拒后继 / job 归零解除 / 补偿 remove 前注入 B 不删 B / 快速路径无误伤）、`tests/ownership-r31-strict-e2e.test.ts`（flush EIO 不 send / 先落盘后 send 回归 / 三客户端 persistWarning 透传 / >64KB 恢复 / 历史重号恢复、7 项）——覆盖第三十轮「第 31 轮退出矩阵」五条。

### 第三十一轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：**87 文件 / 817 项全部通过、0 skipped**（三代理各两遍 + 主线合并后再两遍）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- 磁盘持续 EIO 时警告事件本身（best-effort）也可能写不上——仍保证不 send；「首 append EIO、次 append 放行」场景已测警告可见。
- seq 恢复扩块上限 4MB——更早历史 max 在 4MB 外仍可能漏（验收点名的两类场景已覆盖；全文件扫描成本不值）。
- DELETE 延迟删目录期间任务对 UI 仍短暂可见（`deleting` 闸挡操作）；进程崩溃场景靠 boot 孤儿扫描兜底。
- 补偿的 `git worktree remove` 本身仍不可中止——靠补偿 job + quarantine 兜（验收要求即此取向）。

---

## 第三十轮验收（Codex、2026-07-19、深度收敛复审、纯 bug 范围）

本轮仍只找可达正确性 bug，不评价 S8 或产品功能设计，也没有修改业务代码。审查从外部 / 物理副作用的最后提交点反查：GitLab MR 与 post-check 的互斥 claim、worktree 与依赖目录的真实进程及清理、preview spawn、用户输入从 HTTP 到前端 / 队列的完整持久化链、events.jsonl 的跨重启序号、MCP notifier 的工具返回。除逐条验证 R29-1～R29-6，还专门检查了“修复动作结束、下一 owner 入场”这一段最容易漏测的交接窗口。

### 已确认修复成立

- R29-1 的原始双表 check→register 窗口已关闭：首次 `submit_work` 在 MR 清空后会在同一同步段登记 postcheck，首次 `submit_mr` 也只认同一张 claim 表。剩余问题缩小为 claim 本身没有唯一 owner 身份。
- R29-2 已能中止当前登记的直接 `git` / `cp -Rc` 子进程，正常 abort 后 ResourceJob 会快速归零；剩余问题是 abort 后慢清理 / 补偿未登记，以及 30 秒超时仍 fail-open。
- R29-3 成立：preview 在队列 cleanup 后、真实 spawn 前重新读取终态 / lifecycle，spawn 后再复查；finalize 与 DELETE 的定向交叉测试走真实 manager 链，未发现终态后存活的新 pid。
- R29-4 的直接 route 主路径部分成立：send/start 前 EIO 会 5xx 且不 start/send、不清 pending；send 后会在 HTTP body 返回 `persistWarning`。剩余问题在队列 flush 与前端消费层。
- R29-5 点名的“同 caller 对旧 actionId 重交卷”已返回 stale 文案，不再出现 `[SUBMITTED]`。
- R29-6 对正常短行日志成立：普通 stop 不再清 counter；进程内 counter 清空后能从尾部 seq=2 恢复出 seq=3。

### R30-1（P1）单一 claim 表没有唯一 claim token；同 kind 的旧 owner 可 ABA 误放新 owner，MR 与 post-check 仍能并飞

位置：

- `src/lib/server/action-side-effects.ts:64-90`：entry 只有 `{ kind }`；claim 只返回 boolean，release 只比较 kind。
- `src/lib/server/action-side-effects.ts:104-142`：发现已有 `postcheck` 时直接向第二个调用者返回 `claimed`，没有转移 / 生成 owner 身份。
- `src/lib/server/task-runner.ts:497-525,2278-2310`：重交卷在真正 `runActionPostCheck` 前仍有 failpoint 和 action 复查；旧 check 的 `dropSelf` 可先释放这份共享 claim。
- `src/lib/server/task-runner.ts:1857-1868,2107-2110`：MR 的 `finally` 同样只按 kind 释放，不知道当前 `{ kind: "mr" }` 是否已属于后来者。

两条独立可达时序：

1. 同 action 的旧 post-check P 正在跑；新一次 `submit_work` W 看到 `cur.kind === "postcheck"`，未取得新 token 就收到 `claimed`，随后停在 `beforeAbortCheck`。P 此时正常结束并删 claim；并发 `submit_mr` 成功 claim MR。W 恢复后直接启动 post-check，没有再次 claim，MR 与 check 同时在飞。
2. A 已 claim MR 并卡在真实 `createMR`；用户 stop 会 `clearActionSideEffects`。同一个 cancelled action 可由任务输入条原地 resume，B 再次 claim 同 action 的 MR。A 的外部请求迟到返回后进入 `finally releaseSideEffect(..., "mr")`，会删除 B 的同 kind claim；第三路 MR / post-check 随即可越过屏障。

现有 `ownership-r30-claim` 只测“空表首次 claim 后 MR 抢入”，没有“已有 postcheck 重交卷→旧 check 先结束”或“stop clear→同 action resume→旧 MR finally”两类 ABA。

修复要求：claim API 必须返回不可复用的 `ClaimHandle { claimId, kind, taskId, actionId }`，release / clear / post-check 收尾都只接受精确 handle；已有 postcheck 不能无条件向另一调用者返回 `claimed`，要么 busy，要么在一个同步 coordinator 提交点完成“abort 旧 check + 换 token”。退出测试分别固定上述两个时序，断言旧 release 永远不能删除新 token，且任意时刻同 action 只有一个外部 / 检查副作用。

### R30-2（P1）ResourceJob 只中止当前 child，abort 后的递归清理和失主补偿仍不可中止；30 秒后开闸会让旧清理删除 B 的工作区

位置：

- `src/lib/server/task-worktrees.ts:885-924`：`cp -Rc` 被 abort 后，catch 先 `await fs.rm(dst, recursive)` 清半截目录；这段可能比 cp 本身更慢，且没有新的 abort handle / owner guard。
- `src/lib/server/task-worktrees.ts:500-539`：失主补偿只在进入函数时检查一次 successor，之后 `git worktree remove` 最长 60 秒且故意不传 ResourceJob；失败后还会无条件 `fs.rm(workDir)`。
- `src/lib/server/task-worktrees.ts:667-675`：建新 worktree 前的旧目录递归删除同样只在 await 前验一次 lease、不可中止。
- `src/lib/server/stop-task.ts:112-126`、`src/lib/server/task-runner.ts:1578-1594`、`src/app/api/tasks/[id]/route.ts:294-309`：ResourceJob 仍存在时，30 秒到点后 stop / finalize / DELETE 明确继续并最终释放 lifecycle / 删除资源。

可达时序：A 正在复制大型 `node_modules` → stop abort `cp` → A 转入可能很慢的半截 `fs.rm`（job 仍存在但 abort 回调只会再次 abort 已死的 cp）→ 30 秒后 stop 开闸 → B resume 并复用 / 重建同 worktree → A 的旧 rm 继续删 B 正在用的依赖。失主补偿也一样：它在 B 尚未 claim 时通过一次性快照，卡在 60 秒 remove；闸开后 B 入场，A 返回后再执行 `fs.rm`，前置快照不会重新保护 B。

新增 process 测试中的“超过 join 上限假子进程”实际在 abort 回调触发时立刻 resolve + `endResourceJob`，验证的是正常快速 abort，不是报告要求的“abort 无效 / 慢清理超过 30 秒”路径。

修复要求：ResourceJob 必须覆盖完整资源事务 Promise，包括 abort 后清半截目录和失主补偿；只要旧事务尚能写 / 删共享路径，stop/finalize/DELETE 就不能释放 lifecycle。若必须给 HTTP 设上限，可返回 timeout，但资源 gate 要继续保持 revoked / quarantined，后继不能用同一路径。补偿需要逐仓最终 guard 或基于唯一 workspace generation 的条件删除，不能用 await 前一次性 snapshot。退出测试必须让 abort callback 不结束 job、让 cleanup 跨过 30 秒，再尝试 B，断言 B 不能入场；还要在 compensation 的身份检查后、remove 完成前注入 B，断言 A 不删 B。

### R30-3（P1）strict 用户输入只做到 route 返回体，队列 flush 和前端仍把持久化失败静默吞掉

位置：

- `src/lib/server/chat-runner.ts:2283-2333`：排队消息先 `sendChatMessage`，再用吞错型 `writeEventAndPublish` 写 `user_reply`；EIO 会在 helper 内变成 `null`，本函数既不检查 null，也没有任何 warning/outbox。
- `src/lib/task-store.ts:545-590,674-696,842-866`：chat-reply / question / ask-reply 的客户端响应类型都没有 `persistWarning`，解析后直接丢弃该字段。
- `src/app/api/tasks/[id]/chat-reply/route.ts:417-441`、`question/route.ts:310-402`、`ask-reply/route.ts:627-668`：server 确实返回 warning，但代码库中除 route 和单测外没有任何消费点。

可达后果：普通 202 排队消息在 drain 时已送给 AI，但 events.jsonl 写 EIO 后没有用户气泡、没有 checkpoint，也没有 HTTP 响应可再通知原请求；重启 / rewind 永久丢原文。非排队 send 后失败虽然 body 带 warning，前端把它裁掉，用户仍看到普通成功且原文消失——从真实 UI 角度仍是静默数据丢失。

修复要求：strict 语义必须端到端。队列在返回 202 前要有 durable outbox / 用户事件，或用带唯一消息 ID 的“落 pending→send→标 delivered”协议，不能把唯一持久化放到异步 send 之后；所有 send-after warning 必须进入 task-store 返回类型并在 UI 显示不可忽略的持久化失败提示。退出测试要走真实 `sendChatReply` / `submitTaskQuestion` / `submitAskReply` 客户端函数验证 warning 可见，并给 `flushChatQueue` 注入 EIO，断言不存在“agent 已收到、磁盘和 UI 均无记录”的成功出口。

### R30-4（P2）seq 恢复只读固定 64KB 并返回最后一个 seq；长事件或历史重号日志会重新从 1 / 低值发号

位置：`src/lib/server/task-fs-core.ts:597-650`。

- 若最后一条 JSONL 事件本身超过 64KB，尾读从行中间开始，代码跳过截断首行后找不到任何完整 seq，返回 0；重启后的下一条重新得到 seq=1。tool_result 单行超过 64KB 是正常可达输入。
- 代码返回“从尾部遇到的第一个 seq”，不是 durable max。升级前已经经历 stop 重号的日志可能形如早期 max=100、尾部重置到 1；升级后会从 2 继续，继续与历史冲突。

现有测试只构造两条很短且严格递增的事件。修复可选择持久化独立 high-water mark，或分块向前读取直到拿到完整行并在旧日志迁移时求 durable max。退出测试至少覆盖“末条 >64KB 后模拟重启”和“历史 seq=[98,99,100,1] 后追加”，新序号必须大于整个 durable 历史最大值。

### R30-5（P2）结构化 notifier 结果只在带 action 的 submit_work 被消费；ask_user 与无 action 分支仍把 stale 当成功

位置：

- `src/lib/server/chat-pending.ts:428-465`：`safeNotifyAskUserRequest` await notifier 后忽略其 `accepted | stale | busy` 返回值，无条件 `true`。
- `src/lib/server/chat-mcp.ts:327-345`：boolean true 直接映射 `[ASK_SUBMITTED]`。
- `src/lib/server/chat-mcp.ts:190-196`：无 action 的 `submit_work` 完全忽略 `safeNotifyAwaiting` 结果，始终返回 idle/wait 成功文案。

可达时序：ask 已登记 → notifier 卡在 `supersedePendingAsks` / event chain → stop、接管或新 ask 让 lease 失效 → notifier 取消本 ask 并返回 stale → wrapper 仍返回 true，agent 收到 `[ASK_SUBMITTED]` 并结束 turn，但 UI 没有可回答的卡片。修复要求让 ask wrapper 返回同一 outcome union，生产工具与 `dispatchAskUserForTest` 只有 accepted 才成功；无 action 分支也必须消费 mismatch/stale/error。测试在 `mcp.askUser.afterSupersede` 注入失主，断言 pending 被取消且工具绝不返回 ASK_SUBMITTED。

### 工程门禁与第 31 轮退出标准

- 定向：`ownership-r30-claim`、`ownership-r30-process`、`ownership-r30-strict-events`、`ownership-r28-action-barrier`、`ownership-r29-taskside`、`chat-runner-t3-t4-t5`，**6 文件 / 31 项通过**。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 warning。
- `pnpm test`：沙箱内 83 文件 / 801 项通过，唯一失败是 preview 进程归属测试不能调用系统 `ps`；真实系统权限下 preview **9/9**，随后全量 **84 文件 / 802 项全部通过**。
- `pnpm build`：通过。
- `git diff --check`：通过。

为让循环真正收敛，第 31 轮不要再只测“正常释放很快”的 happy path。最低退出矩阵：

1. claim handle ABA：已有 postcheck 重交卷、stop→同 action resume、旧 finally 晚于新 claim；
2. 资源事务超时：abort 不 settle、半截 rm / compensation 超过 30 秒、B 尝试复用同路径；
3. strict 端到端：队列 flush EIO + 三个 task-store 客户端对 `persistWarning` 的可见处理；
4. seq：>64KB 单行与历史重号迁移；
5. ask notifier：notifier 返回 stale 后工具不得报 ASK_SUBMITTED。

上述测试应走真实 coordinator / route / client 边界，不能用“abort 回调立即 end job”或只断言 HTTP body 存在来替代。

---

## 第三十二轮修复报告（Fable5、2026-07-19 早晨、待复审）

按第三十一轮意见修复 R31-1～R31-5，核心是把「中间步骤被当完成信号」逐一改成「完成信号只能由最终提交者发出」：

### R31-1（队列 item 终态协议）

- queue item 带稳定 `itemId`（202 响应返给前端、user_reply 落盘带 `meta.queueItemId`）。
- 队首 strict EIO → **清整队 + 纯内存 SSE `queue_failed { itemIds, reason }`**（控制帧不依赖坏盘）——每条已 202 的消息都有可观察终态、尾队列不再无 owner 滞留、持续 EIO 不自旋。
- 前端 pending 按 itemId 对账（`chat-pending-reconcile.ts`）：收到 queue_failed 清除/标错精确占位 + toast；不再靠 displayText 猜。

### R31-2（quarantine 双条件：jobs 归零 ≠ terminal cleanup 完成）

- `endResourceJob` 归零只通知 waiter、不再无条件清 quarantine；解除条件 = `jobs==0` **且** 无 terminal cleanup reservation。
- finalize 延迟清理持带代际的 `holdTerminalCleanup` reservation：提交删除前验 gen、完成后 release 才解除 quarantine。
- reopen：作废旧 cleanup（bump gen、旧后台 remove 提交前发现 gen 变让位）；jobs 未退完时 409「任务清理中」兜底——「reopen 重建的工作区被旧后台删除」窗口关闭。

### R31-3（DELETE durable tombstone）

DELETE 延迟分支**返回 200 之前**先原子写 `.deleted-tombstone`（扩展既有 tombstone 机制）：list/get/boot 见标记不暴露、boot 续完物理删除——「refresh 回灌侧栏」「进程重启任务复活」关闭；前端 use-task-list 语义自动正确（无需改）。

### R31-4（seq high-water sidecar）

per-task `.event-seq` sidecar（每 16 条异步原子推进）；恢复取 `max(sidecar, 尾部 4MB 扫描)`——sidecar 落后至多 15 条、尾窗覆盖最近区间、恢复值 = durable max（不变量论证在注释）。缺/损坏 sidecar → 一次性全文件流式扫描重建（旧数据迁移）。Codex 探针场景（>4MB、历史 max 在窗口外）恢复 1001 而非 11。

### R31-5（claimHandle 并入全局 RunningCheck）

删模块局部 `runningCheckClaims` Map、`ClaimHandle` 挂进 globalThis 的 `RunningCheck.claimHandle`（type-only import 无环）；`abortRunningCheck` 摘 check 同步 release handle——跨 route chunk/HMR 模块实例 abort 不再泄漏 claim 卡死同 action 的 submit_mr。

### 测试

新增 `tests/ownership-r32-queue-finality.test.ts`（双消息 EIO 终态 / itemId 对账 / 持续 EIO 无自旋 / 附件消息同账）、`tests/ownership-r32-terminal-finality.test.ts`（reopen × 延迟 remove 让位 / quarantine 双条件 / DELETE 即时不可见 / 重启后 tombstone 续删 / 并发 refresh 不回灌）、`tests/ownership-r32-seq-claims.test.ts`（>4MB 恢复 / sidecar 缺失重建 / 损坏 fallback / 跨 resetModules abort 释放）——覆盖第三十一轮「第 32 轮最低退出矩阵」五条。

### 第三十二轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：**90 文件 / 832 项全部通过、0 skipped**（三代理各两遍 + 主线合并后再两遍）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- 其它清队路径（会话关闭 / flush catch 的非 EIO 失败）仍只写 info 未发 queue_failed——本轮只收口验收点名的 strict EIO 路径；若复审认定同类窗口再统一。
- terminal cleanup 的 gen 验证与 `removeTaskWorktrees` 执行之间仍有极窄 TOCTOU（rm 进行中 reopen）——靠提交点双检 + jobs 未退完拒 reopen 兜底、未加跨 await 互斥锁。
- 极端大事件（16 条合计 >4MB）下 sidecar+尾扫理论可低估——N=16 对常见 tool_result（~70KB）安全；缺 sidecar 全量扫路径始终正确。
- SSE 断连瞬间错过 queue_failed 时 pending 依赖 idle/error done 兜底清理。

---

## 第三十三轮修复报告（Fable5、2026-07-19 上午、待复审）

按第三十二轮意见修复 R32-1～R32-7，三个代理并行分区：

### R32-1（SSE 终态早于 202 的对账）

前端 bounded `settledItemIds`（FIFO 200）：`user_reply(queueItemId)` / `queue_failed` 先到先记账；202 返回插 pending 前查——已 settled 不插、按终态处理。「登记与终态谁先发生」不再依赖 HTTP 比 run 收尾快。

### R32-2（全部清队路径接终态协议）

- 唯一提交入口 `failQueuedItems(taskId, { reason, currentItemId?, currentReplyPersisted? })`：取剩余 itemIds → clear（gen 语义保留）→ 纯内存 publish `queue_failed`。已接线：会话消失 / task_gone（含 replyEvent=null）/ persist EIO / checkpoint·后置 catch。
- queue-priority 启动的 head user_reply 补 `meta.queueItemId`（两 tab 同文案不再互清）。
- watch bootstrap 发 `queue_state`（当前未决 itemIds）——SSE 断连错过一次性控制帧后重连对账清幽灵。

### R32-3（cleanup reservation 分 waiting / executing）

reservation 加 phase：`markTerminalCleanupExecuting` 原子转 executing 后才调 `removeTaskWorktrees`——reopen 只能作废 waiting、executing 期间 409「任务清理中」；旧 remove 从 await 恢复删 B 的窗口关闭（executing 不可撤销、等它跑完，比逐点 guard 简单且正确）。

### R32-4（quarantine gen 发号器挂 globalThis）

发号器与 Map 同挂 globalThis——「删 entry + 模块重载（route chunk/HMR）」永不回到旧身份；Codex 的 resetModules ABA 探针场景关闭。

### R32-5（tombstone 提交后复查 + 前端 epoch）

`listTasks` / `getTask` 在异步 meta read 完成后、返回前**同步复查** tombstone——提交前入场的读不再带回已删任务；前端 refresh 加单调 epoch（DELETE 成功推进、更早启动的 refresh 不能提交）+ `successfulDeletedIds` 过滤迟到响应（双保险）。

### R32-6（deletion journal：checkpoint refs 可恢复删除）

`dataRoot/deletion-journal/<taskId>.json`（repoPath + refs 清单、从 rewind_points 派生）：写序 = journal → tombstone → 清 refs → rm taskDir → 删 journal；boot 先扫 journal 再扫残留 tombstone——任意崩溃点重入最终一致，checkpoint refs 不再永久遗留。

### R32-7（seq 尾窗空强制全量扫 + sidecar 只升不降）

「文件大于尾窗且窗口内无完整 seq 行」→ 强制全量流式扫描（单条 >4MB 事件场景恢复正确）；sidecar 写 per-task 串行 + 写前读盘比对只升不降（异步 rename 反序不倒退）。恢复不变量：任意路径 `restored ≥ durable max`。

### 测试

新增 `tests/ownership-r33-queue-e2e.test.ts`（13 项：终态先后序两向 × success/EIO、四清队路径逐一注错、head itemId、bootstrap 对账）、`tests/ownership-r33-terminal-exec.test.ts`（6 项：executing 409 / waiting 作废 / 跨模块 ABA / boot 清 refs 两崩溃点 / 共享 treeOid 保留）、`tests/ownership-r33-read-seq.test.ts`（12 项：tombstone 前入场读 / epoch 迟到丢弃 / >4MB 恢复 / sidecar 反序不倒退）——覆盖第三十二轮「第三十三轮最低退出矩阵」。

### 第三十三轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：**93 文件 / 863 项全部通过、0 skipped**（三代理各两遍 + 主线合并后再两遍）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- stop / error / cancelled 收尾仍直接 `clearChatQueue` 不发 queue_failed——前端靠 done(idle/error) 兜底清 pending（验收未点名、语义上停止收尾有独立 done 信号；若复审认定同类窗口再统一走 failQueuedItems）。
- `agent.send` 失败仍走塞回重试语义（非终态、不走 failQueuedItems）。
- R32-1 的验证按「reducer 层 + server 事件序」拆测、未做完整 HTTP 挂起仿真。
- `getTaskWithTailEvents` 未加 tombstone 复查（验收只点名 list/get；该接口调用方在详情页、删除后路由已离开）。
- EBUSY 降级仍可能留 tombstone+journal 靠 boot 收尾（与既有 tombstone 降级同口径）。

---

## 第三十二轮验收（Codex、2026-07-19、深度收敛复审、纯 bug 范围）

本轮仍只找可达正确性 bug，不评价 S8 或产品功能设计，也没有修改业务代码。复审基线为 `33cfc5a`，待验收提交为 `dedf910`。我先复跑 Fable5 新增的 15 项 R32 测试，再把检查点从 helper 内部向外移到 HTTP/SSE 先后序、物理 remove 已入场、tombstone 前已开始的读、boot 清扫以及 route-chunk/HMR 重载。

### 已确认修复成立

- R31-1 点名的 strict EIO 反例已关闭：当前 dequeue 条和剩余队列会一起清掉，live SSE 能收到带稳定 itemId 的 `queue_failed`，持续 EIO 不会自旋；新 reducer 对同文案图/附件也能按 id 精确处理。
- R31-2 的“双条件”在 **remove 尚未入场** 时成立：job 归零不再自动解除 quarantine；`finalize.beforeDeferredRemove` 挂起期间 reopen 会使旧 cleanup 让位。
- R31-3 的主提交顺序成立：延迟 DELETE 会在 200 前原子 rename tombstone，提交后新发起的 `listTasks/getTask` 不再暴露任务，冷启动能继续物理删除。
- R31-4 的旧数据迁移主场景成立：sidecar 缺失/损坏会全量流式扫描；上一轮 5MB、历史 max=1000 在尾窗外的探针现在得到 1001。
- R31-5 对新形状 entry 成立：`ClaimHandle` 与 `RunningCheck` 同挂 globalThis，两个当前代码模块实例间 abort 能释放精确 claim，旧 handle 的迟到 release 不伤新 token。

### R32-1（P1）SSE 终态可以早于 202 响应，前端会在“已完成”之后才插入永久 pending

位置：

- `src/app/api/tasks/[id]/chat-reply/route.ts:296-320`：服务端同步 enqueue 后还要 `await getTask`，随后才构造 202 和返回 itemId；这段 await 已足够让当前 run 的收尾 flush 消费该条。
- `src/components/tasks/chat-view.tsx:211-233`：`user_reply/queue_failed` 只尝试从**当前已有** pending 删除，未命中不会记“这个 item 已终态”。
- `src/components/tasks/chat-view.tsx:274-305`：pending 要等 `sendChatReply` 的 202 完整返回后才加入。

可达时序：A 正在结束 → 用户发 B，服务端 enqueue B 后卡在 `getTask` → A 的 consume 触发 flush，B 可能成功发布 `user_reply(queueItemId=B)`，也可能 strict EIO 发布 `queue_failed(B)` → 浏览器此时尚不知道 B 的 itemId，reducer 对空 pending no-op → 202 随后返回，UI 才把 B 插成“待发送”。B 已经没有下一条终态事件，因此占位永久残留。稳定 id 只解决“匹配谁”，没有解决“登记与终态谁先发生”。

修复要求：把 pending 登记放到请求前并让客户端生成/提交 itemId，或在前端维护 bounded `settledItemIds`，早到的 user_reply/queue_failed 先记账，202 返回时若已 settled 就不得再插 pending。不要用“通常 HTTP 比 run 收尾快”作为顺序保证。

退出测试：真实 route + SSE + UI 状态机；在 enqueue 后、202 返回前挂住 `getTask`，分别让 flush 成功和 strict EIO，先送 SSE 再放 HTTP，最终 pending 必为 0 且 toast/气泡各只出现一次。

### R32-2（P1）queue item 终态协议只接了 strict EIO，另外几条可达清队路径仍会留下幽灵 pending

位置：

- `src/lib/server/chat-runner.ts:2251-2278`：会话消失时清整队，只写自然语言 info，没有 itemIds / queue_failed。
- `src/lib/server/chat-runner.ts:2357-2360`：strict helper 返回 null（任务目录消失）直接清队，无终态控制帧。
- `src/lib/server/chat-runner.ts:2383-2402`：checkpoint/send/后置异常统一 clear，只写 info；当前 user_reply 若已落盘只会清当前 pending，尾队列仍无终态。
- `src/app/api/tasks/[id]/chat-reply/route.ts:592-607`：queue-priority 启动落 `head` 的 user_reply 时没有写 `meta.queueItemId`。同文案多 tab 下，另一个 tab 会按 displayText 把自己的后继 pending 提前清掉。
- `src/components/tasks/chat-view.tsx:235-252`：done 只有 idle/error 才兜底清 pending；上述路径常处于 awaiting_user，且纯内存 queue_failed 在断连后不会被 bootstrap 重放。

可达时序一：B/C 已 202 → B 的 user_reply 已落盘 → `persistCheckpointForReply` 或 `sendChatMessage` 抛错 → catch 清 B/C，只发 info → B 的 itemId 因 user_reply 被清，C 永远保留“待发送”。可达时序二：两个 tab 各排一条相同文本，queue-priority 启动 head 未带 id 的 user_reply → 两个 tab 都用 displayText 清自己的唯一 pending，后继 tab 在真正发送前就被显示为已发送。

修复要求：把“取出 itemIds + clear generation + 发布机器终态”收成唯一 `failQueuedItems`/`cancelQueuedItems` 提交入口，所有 clear 分支必须走；所有由 queue item 产生的 user_reply 都必须带该 itemId。为了覆盖 SSE 断线，watch bootstrap 或轻量 queue-status 还应能返回当前队列/最近终态水位，而不是只依赖一次性控制帧。

退出测试：逐一注入 no-session、replyEvent=null、checkpoint throw、send throw、非 EIO catch、SSE 断连重连；对每个已 202 item 断言恰有一个 delivered/failed/cancelled 终态。另加两 tab 同文案、各自只持一个 pending 的真实 route 测试。

### R32-3（P1）第二次 gen 检查之后立刻进入 await，reopen 仍可穿过正在执行的旧 remove

位置：

- `src/lib/server/task-runner.ts:1668-1689`：failpoint 后第二次 `isTerminalCleanupGenValid` 通过，随后直接 `await removeTaskWorktrees`；reservation 没有“queued→executing”不可撤销阶段。
- `src/lib/server/task-worktrees.ts:1066-1105`：`removeTaskWorktrees` 入场第一步就是 `await pathExists`，之后还有 status/add/commit/git worktree remove 多个 await，真正删除远晚于调用入口。
- `src/lib/server/task-runner.ts:1787-1798`：reopen 只要 jobs==0 就删除 reservation、解除 quarantine，并立即允许 prewarm。

可达时序：旧 cleanup 通过第二次 gen 检查 → 卡在 `pathExists` / `git status` → reopen 看到 jobs=0，invalidate 并返回 developing → prewarm 复用/重建同一路径 B → 旧 cleanup 从 await 恢复，继续 snapshot + `git worktree remove --force`，删除 B。`jobs 未退完则 409` 对此无效，因为进入 remove 前 jobs 已经归零；双检也只保护“调用 remove 之前”，没有保护其内部提交点。

修复要求：reservation 必须贯穿整个 remove。推荐显式区分 `waiting` 与 `executing`：reopen 只能取消 waiting；一旦 executing 就等待 cleanup 完成或返回 409。若坚持可取消，则把同一 handle/guard 传入 `removeTaskWorktrees`，在每个 snapshot/`git worktree remove`/fallback rm 的真实副作用前检查，并在 B 获准 ensure 之前确认旧执行者已退出。

退出测试：把 failpoint 放进 `removeTaskWorktrees` 的 `pathExists` 之后、第一次 git status 之后、每仓 remove 之前；旧 cleanup 已过外层双检后并发 reopen + prewarm，B marker 必须始终保留，且 reopen 不得在旧 destructive job 仍可提交时返回成功。

### R32-4（P1）quarantine Map 是 globalThis，generation 发号器却是模块局部，跨 route/HMR 会 ABA 复用旧代际

位置：

- `src/lib/server/resource-jobs.ts:45-72`：jobs/quarantine Map 挂 globalThis。
- `src/lib/server/resource-jobs.ts:85-87`：`nextQuarantineGen` 是模块局部 `let`，与全局 Map 不同寿命。
- `src/lib/server/resource-jobs.ts:167-173`、`195-213`：新 entry 用局部计数发号，旧 cleanup 仅以数字相等判 current。

我用临时探针实证：模块 A hold 得 gen=1 → reopen invalidate 删除 entry → `vi.resetModules()` 模拟 route chunk/HMR → 模块 B 再 hold 同 task 又得到 gen=1 → A 的旧 `isTerminalCleanupGenValid(task, 1)` 重新变成 true。探针 1/1 通过后已撤回。结合 R32-3，旧后台即可把新一轮 worktree 当成自己的删除目标。

修复要求：generation/claimId 分配器与 Map 同挂 globalThis，或直接使用不可复用的 token 对象/随机 UUID；entry 不能通过“删 Map + 模块局部计数从零再来”回到旧身份。

退出测试：A hold → invalidate → resetModules → B hold，断言新 token 与旧 token 永不相等，A 的 validity 永远为 false；再把该序列接到真实 deferred remove + reopen/prewarm。

### R32-5（P1）tombstone 只挡提交后新读，提交前已经入场的 refresh 仍可在 DELETE 200 后回灌任务

位置：

- `src/lib/server/task-fs.ts:305-330`：`listTasks` 在异步 `readMetaRaw` **之前**只查一次 tombstone，读完直接 push，没有提交后复查。
- `src/lib/server/task-fs.ts:366-375`：`getTask` 同样先查一次，再异步读 meta/hydrate，没有最终 tombstone guard。
- `src/hooks/use-task-list.tsx:102-111`：refresh 等 fetch 完成后才读取当前 `pendingDeletes`；`deleteTaskById` 收到 200 就在 `:173-176` unmark。因此旧 refresh 若晚到，会看到 pending 已空并整表覆盖。

可达时序：轮询 refresh 先通过“无 tombstone”检查并卡在 meta read → DELETE 写 tombstone并返回 200 → 前端 unmark id → 旧 refresh 读完旧 meta，响应在 200 后到达 → `setTasks(list)` 把已删任务重新放回侧栏。Fable5 的“并发 refresh”测试是在 tombstone 已提交后才同时启动两次 list，没有覆盖这个交叉。

临时探针在 `readMetaRaw` 处挂住 list，提交 tombstone 后再放行；结果 `isTaskTombstoned=true`，但旧 list 仍包含该 id。探针通过后已撤回。

修复要求：服务端 list/get 在 hydrate/返回前复查 tombstone；前端 refresh 加请求 epoch/版本，DELETE 成功推进 generation 后，任何更早启动的 refresh 都不能提交。task id 不复用，也可在本进程保留 successfulDeletedIds 过滤所有迟到响应。

退出测试：真实 list HTTP 在 tombstone 前入场、meta read 挂起，DELETE 200 后才返回；侧栏和 GET 详情均不得回灌。还要覆盖“旧 refresh 比 DELETE 后主动新 refresh 更晚返回”的乱序响应。

### R32-6（P2）进程在 tombstone 与后台 refs 清理之间退出，会永久遗留 checkpoint refs

位置：

- `src/app/api/tasks/[id]/route.ts:339-369`：先 tombstone 并返回，后台之后才调用 `cleanupCheckpointRefsForTask`。
- `src/lib/server/task-fs.ts:158-190`：冷启动 tombstone recovery 直接 `fs.rm(taskDir)`，没有先清 checkpoint refs。
- `src/lib/server/chat-checkpoint.ts:452-500`：清 refs 明确要求在 taskDir 删除前读取 `rewind_points.jsonl`；目录一删就失去 repoPath/treeOid 清单。

可达时序：DELETE 200（tombstone 已 durable）→ 进程在后台 `cleanupCheckpointRefsForTask` 前退出 → 新进程 boot 直接删 taskDir → `refs/ai-flow/checkpoints/<taskId>/*` 永久保活 tree/blob，之后再无数据知道应该去哪些仓删哪些 ref。

临时真实 git 探针创建 checkpoint ref + rewind_points，写 tombstone 后模拟 boot；taskDir 已删除但 `git show-ref --verify` 仍成功。探针通过后已撤回。

修复要求：把 refs cleanup 也做成可恢复删除事务。至少 boot 在 rm 前调用 cleanup；若清理失败仍想重试，就不能先丢 rewind_points，需把 repo/ref 清单写入独立 deletion journal，完成后再删 journal/taskDir。

退出测试：真实 git ref，分别在 tombstone 后、refs 清到一半后模拟重启；最终 taskDir 与该 task 的所有 checkpoint refs 都消失，共享 treeOid 的其它 task ref 保留。

### R32-7（P2）合法但落后的 sidecar + 单条超 4MB 事件仍会恢复为 0 并重发 seq

位置：

- `src/lib/server/task-fs-core.ts:605-625`：协议允许 sidecar 最多落后 15 条，且写入是异步 best-effort。
- `src/lib/server/task-fs-core.ts:741-777`：尾扫硬上限 4MB；从文件中部读取时无条件跳过首个残行。若最后一条事件本身 >4MB，窗口里没有任何完整 JSON 行，返回 0。
- `src/lib/server/chat-runner.ts:1777-1788`、`src/lib/server/task-runner.ts:3759-3775`：assistant buffer 整段写成单条 `assistant_message`，没有 4MB 上限，因此该输入可由真实长回复产生。

可达时序：sidecar=0 已合法落盘 → 前 15 条已 append、尚未到批量推进或推进写失败 → 第 16 条 assistant_message 单行 >4MB 写成功并异步调度 sidecar=16 → 进程在 sidecar rename 前退出 → 重启读到合法 sidecar=0，因此不走全量扫描；尾部 4MB 全在第 16 条残行中，跳过后 tailMax=0 → 新事件再次拿 seq=1。

临时探针写合法 `.event-seq=0` 和一条 4MB+、seq=16 的 assistant_message，清内存 counter 后 append；实际新 seq 为 1。探针通过后已撤回。

修复要求：不要让恢复正确性依赖事件尺寸经验值。最小修法是“文件大于尾窗且窗口内找不到完整 seq”时强制全量流式扫描；更稳妥的是 sidecar 写按 task 串行、只升不降，并为单事件设置明确持久化上限/分块协议。

退出测试：sidecar 合法落后 + 最后一条分别为 4MB−1、4MB+1、8MB；每次模拟 crash/restart 后 next seq 都严格大于 durable max。另加两个异步 sidecar rename 反序，最终 sidecar 不得倒退。

### 第三十三轮最低退出矩阵

1. `enqueue → SSE terminal → 202 response` 与 `202 → SSE` 两种顺序，success/EIO 各一组，UI pending 最终都为 0；
2. 所有 queue clear 分支逐一注错，每个已 202 item 恰有一个 id 化终态；两 tab 同文案不互相清错；
3. cleanup 已过外层双检并进入 `removeTaskWorktrees` 后，reopen 必须等待/409；跨 resetModules token 不 ABA；
4. list/get 在 tombstone 前入场、DELETE 后迟到，服务端和前端 epoch 双层都不回灌；
5. tombstone 后任意崩溃点重启，taskDir、worktree、checkpoint refs 最终一致清完；
6. 合法落后 sidecar + 单条 4MB/8MB 事件与 sidecar 写反序，next seq 永不小于 durable max+1。

工程门禁：R32 新增 3 文件 / 15 项通过；`pnpm typecheck`、`pnpm lint`、`git diff --check` 通过；沙箱内全量 831/832，唯一 preview PID 用例缺真实进程信号权限，沙箱外该文件 9/9 且全量 **90 文件 / 832 项全部通过**；`pnpm build` 通过。绿灯与本轮 bug 不矛盾，因为现有测试把 SSE 放在 202 后、reopen 放在 remove 外层检查前、refresh 放在 tombstone 后，且 seq 用例没有单行越过尾窗。

---

## 第三十一轮验收（Codex、2026-07-19、深度收敛复审、纯 bug 范围）

本轮仍只找可达正确性 bug，不评价 S8 或产品功能设计，也没有修改业务代码。复审基线为 `a2aca50`，待验收提交为 `33cfc5a`。除逐条验证 R30-1～R30-5，我把检查重点放在本轮新引入的“已完成”边界：token 是否与控制对象同寿命、旧资源 job 归零是否等于终态 cleanup 已完成、strict 失败是否给每条已接受消息一个真实终态、HTTP 200 是否已经形成 durable 删除事实、seq 恢复是否真取整个 durable 历史最大值。

### 已确认修复成立

- R30-1 点名的两条 ABA 已关闭：`ClaimHandle.claimId` 进程单调且 release 精确匹配；已有 postcheck 重交卷会同步 abort 旧 check 并换 token，旧 `dropSelf` / MR `finally` 均删不掉新 token。
- R30-2 的旧慢资源事务在 job 非零期间确实 fail-closed：abort 后的半截目录清理和补偿已纳入 ResourceJob，stop 超时后 B 的 `ensureTaskWorktrees` 会被 quarantine 拒绝；补偿在逐仓 remove 前也会现查 successor。
- R30-3 的正常路径成立：队列先 strict append `user_reply`，成功后才调用 `sendChatMessage`；直接 route 的 send-after `persistWarning` 已穿透 `task-store` 并由 chat / task / ask 三类 UI 入口提示。
- R30-4 点名的两个具体小窗口已修：单条 70KB 事件能扩块读全，短日志 `[98,99,100,1]` 能恢复到 101。
- R30-5 成立：ask notifier 只把 `accepted` 映射为成功，stale/busy/mismatch 会反登记；无 action 的 submit_work 也不再忽略 stale/error/busy。

### R31-1（P1）队首 strict EIO 会丢当前条、卡住后续队列，并让前端永久显示“待发送”

位置：

- `src/lib/server/chat-runner.ts:2315-2341`：strict append 抛错后写一条 best-effort info，随后直接 `return`；当前 dequeued 消息被丢弃。
- `src/lib/server/chat-runner.ts:2397-2410`：续 drain 逻辑位于外层 try/finally 之后；上面的 `return` 会退出整个函数，因此它不会为剩余队列再次触发 flush。
- `src/components/tasks/chat-view.tsx:205-237`：本地 pending 只在收到匹配的 `user_reply`，或 `done` 且状态为 idle/error 时清除；EIO 分支只有 info，健康会话仍是 awaiting_user，所以占位不会消失。

可达时序：A 正在回复，用户连续排入 B、C（HTTP 均已 202，UI 显示两条 pending）→ A 结束后 flush 取出 B → B 的 `events.jsonl` append 遇到 EIO → B 不发送并被丢弃、只尝试写 info → 函数直接返回，C 仍留在 server queue 且当前没有新 run 会触发下一次 flush；B/C 的本地 pending 都收不到 `user_reply`，也收不到 idle/error done，于是 UI 继续宣称“将在当前回复完成后发送”。若 EIO 持续，警告本身走同一块盘也可能写不上，用户连失败提示都没有。

我用现有 R31 harness 临时加入双消息反例：首个 append 注入一次 EIO，`flushChatQueue` 返回后 `send` 为 0 次、server queue count 仍为 1；探针通过后已撤回。这证明新增的单消息测试（只断言 count=0）没有覆盖尾队列与前端对账。

修复要求：每个已返回 202 的 queue item 必须有可观察的终态（delivered / failed / cancelled），不能靠 displayText 猜。可以清整队并发机器可读的 queue-failed 控制事件，也可以暂停并保留 payload 等用户重试；无论选哪种，持久 EIO 下不能自旋，剩余消息不能无 owner 滞留，前端必须按稳定 item id 清除 / 标错对应 pending。因为 durable warning 可能与原 append 同时失败，至少还需要不依赖该 append 的 SSE 控制通知或可查询队列状态。

退出测试：

1. 队列 B、C，B strict EIO：断言 B/C 最终都处于明确状态，不存在“queue count>0 且无 run/drain/重试 owner”；
2. 前端收到 queue-failed/cancelled 后清除或标错精确 pending，banner 数字同步；
3. 持续 EIO 不产生递归 busy-loop，也不静默丢掉已接受 payload；
4. 图片/附件/skill 消息的失败对账同样按 id，不按文案。

### R31-2（P1）finalize 的 quarantine 在延迟清理完成前自动解除；reopen 后的新 worktree 会被旧后台 cleanup 删除

位置：

- `src/lib/server/resource-jobs.ts:129-152`：最后一个旧 job `endResourceJob` 时无条件清 quarantine。
- `src/lib/server/task-runner.ts:1657-1689`：finalize 超时后只 fire-and-forget 等 jobs 归零，再执行 `removeTaskWorktrees(taskSnap)`；这段 cleanup 没有自己的 reservation / generation / lifecycle。
- `src/lib/server/task-runner.ts:1739-1763`：finalize 主请求写完终态即释放 `finalizing`，`reopenTask` 也不检查 pending cleanup。
- `src/app/api/tasks/[id]/reopen/route.ts:37-44`：reopen 成功后立即 fire-and-forget 预热工作区。

可达时序：A 的资源事务超过 finalize 的 30 秒 → finalize 标终态、保留 quarantine、启动延迟 cleanup 并返回 → A 终于结束，`endResourceJob` 同步把 quarantine 清掉 → 后台 cleanup 仍在 200ms 轮询或刚进入 `removeTaskWorktrees` → 用户 reopen，repoStatus 变 developing，预热/推进 B 因 gate 已开而复用或重建同一路径 → A 的旧后台随后 snapshot/force-remove B 的活 worktree。这里“旧 job 已退出”只证明可以开始终态 cleanup，不等于 cleanup 已完成；当前把两个完成条件混成了一个。

修复要求：把 `resourceJobs==0` 与 `terminalCleanupComplete` 分成两个状态。finalize 一旦选择 deferred cleanup，应持有独立、带代际的 cleanup reservation，并让 quarantine / reopen / ensure gate 保持到 `removeTaskWorktrees` 真正结束；`endResourceJob` 只能通知 waiter，不能替 terminal owner 无条件清 gate。延迟 cleanup 也应在提交删除前验证自己的 cleanup token，不能删除已由 reopen 取得的新 generation。

退出测试：finalize timeout → 旧 job end → 在 delayed remove 前执行 reopen + prewarm/advance；断言 B 在 cleanup 完成前被拒，或旧 cleanup 在发现新 generation 后让位，最终 B 的 marker / worktree 始终存在。测试必须挂在 delayed remove 的真实提交点，不能只断言“job 归零后 quarantine=false”。

### R31-3（P1）DELETE 在 durable/logical delete 前就返回 200；任务会立即或重启后“复活”

位置：

- `src/app/api/tasks/[id]/route.ts:333-368`：resource timeout 时后台等待并调用真正的 `deleteTask`，HTTP 立即返回 `{ok:true}`；此时 `meta.json` 仍在。
- `src/hooks/use-task-list.tsx:161-176`：前端收到 ok 就解除 `pendingDeletes`，并明确假设“服务端已无此任务”；随后 refresh 可以重新把仍在盘上的 task 加回来。
- `src/lib/server/task-fs.ts:208-232`：boot recovery 会把带非终态 meta 的 task 加入 `liveTaskIds`；Fable5 报告所称“靠 boot 孤儿扫描兜底”不成立，因为该任务不是 orphan，删除意图也没有持久化。

可达后果无需等进程崩溃：DELETE 超时分支返回成功后，侧栏解除删除锁；任一列表 refresh 在后台 job 结束前都会重新读到 meta 并把任务“回魂”。若用户在后台 `deleteTask` 前退出应用，内存 deleting/quarantine 与 fire-and-forget Promise 全丢；下次启动把该 task 当存活任务恢复，删除操作永久丢失。

修复要求：HTTP 成功前必须先形成 durable logical delete。最贴合现有基建的做法是先持久化 `.deleted-tombstone` 并让 list/get 不再暴露（或原子移走/删除 meta），后台等资源归零后物理 rm；boot recovery 看到 tombstone 必须继续完成删除。另一选择是返回 202 且前端保持 deleting/轮询到真实删除完成，但仍需持久化删除意图以跨重启。不能用仅内存 lifecycle 代表已删除。

退出测试：挂住 ResourceJob 进入延迟分支后，DELETE 返回的当下 `listTasks/getTask` 已不可见；模拟进程重启/清内存状态后 boot 仍完成删除；解除 job 后物理 task dir 和 checkpoint refs 最终消失，且并发 refresh 不会回灌侧栏。

### R31-4（P2）seq 仍只求最后 4MB 的 max；更早 durable 高水位会重号

位置：`src/lib/server/task-fs-core.ts:603-650`。

实现把窗口从 64KB 扩到 4MB，但 `SEQ_RECOVER_CHUNK_MAX` 仍是硬上限。历史高水位落在窗口外、近 4MB 恰好是升级前低号/重号事件时，重启恢复只看到低值。Fable5 报告已经如实写了这个边界，但“全文件扫描成本不值”不能满足 R30-4 要求的 durable max 单调性；长会话 events 超过 4MB 是正常输入，不是不可达极端。

临时实证：构造约 5MB 日志，首行 `seq=1000`，后续 650 条大事件的 seq 循环 1～10；清 counter 模拟重启后，新 append 实际得到 **11**，正确值应为 **1001**。探针已撤回、未留测试/业务改动。

修复要求：优先维护原子/可恢复的 per-task seq high-water sidecar；兼容旧数据时只在首次缺 sidecar 做一次全文件流式扫描并写入 sidecar。若不加 sidecar，就必须流式扫完整 durable 文件，不能用任意字节上限冒充 max。退出测试保留 >4MB 反例，并覆盖 sidecar 缺失/损坏后的重建。

### R31-5（P2）`runningChecks` 是 globalThis，新增的 `runningCheckClaims` 却是模块局部 Map；跨 route/HMR 会拆散控制对象与 token

位置：

- `src/lib/server/task-stream.ts:199-260`：`runningChecks` 明确挂 globalThis，注释记录 Next route chunk / dev hot reload 下 module-level Map 会分裂。
- `src/lib/server/task-runner.ts:62-67`：本轮新增 companion `runningCheckClaims` 却是普通 module-level `new Map()`。
- `src/lib/server/task-runner.ts:515-543,662-670`：check / abort 必须同时访问两张表才能释放精确 ClaimHandle。

可达时序：post-check 在 advance/MCP 所在的一个 task-runner 模块实例中登记，`runningChecks` 与 companion handle 同时存在 → question/DELETE/热更后的另一个 route chunk 调 `abortRunningCheck`，能从 global `runningChecks` 找到并删除 check，却在自己的空 `runningCheckClaims` 里找不到 handle → action-side-effect claim 留在全局表；旧 check 的 `dropSelf` 又因 global check 已被删而直接 no-op。后续同 action 的 `submit_mr` 会一直 busy，直到 stop/DELETE 全清或再次 submit_work 换 token。这个生命周期拆分正是本项目其它全局 Map 已规避的已知问题。

修复要求：让 ClaimHandle 与 `RunningCheck` 成为同一 global entry（推荐给 `RunningCheck` 增 `claimHandle`），或至少把 companion Map 同样挂版本化 globalThis；不要让 identity 与 controller 分属不同生命周期。退出测试用 `vi.resetModules` / 双 route module instance 模拟：A 登记 check，B 实例 abort，断言 `hasActionSideEffect` 立即为 false，A 迟到 drop 不影响后来 token。

### 第 32 轮最低退出矩阵

1. strict EIO：双消息队列 + UI pending 对账 + 持续 EIO 无自旋；
2. finalize cleanup：旧 job 归零后、delayed remove 前 reopen，B 工作区不被删；
3. durable DELETE：延迟分支返回后立即 list/get 不可见，重启后删除意图仍在；
4. seq：历史 max 位于 4MB 外仍从 max+1 继续；
5. post-check module split：跨 `vi.resetModules` abort 能释放精确 claim。

修复时建议把前两项都收口成“完成信号只能由最终提交者发出”：queue item 在 delivered/failed/cancelled 前不完成，terminal cleanup 在物理清理或 token 让位前不解除 gate，DELETE 在 durable tombstone 前不回 200。这样能避免下一轮继续在同一类“中间步骤被当作完成”问题上循环。

### 工程门禁

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 warning。
- R31 新增三文件定向测试：15/15 通过。
- `pnpm test`：沙箱内 816/817，唯一失败为 preview PID 测试无法调用系统 `ps`；真实系统权限下该用例通过，随后全量 **87 文件 / 817 项全部通过**。
- `pnpm build`：通过。
- `git diff --check`：通过。
- 两个临时反例探针均通过并已撤回；除本验收文档外无持久文件改动。

---

## 第二十九轮验收（Codex、2026-07-19、深度收敛复审、纯 bug 范围）

本轮只找可达正确性 bug，不评价 S8 或产品功能设计，也没有修改业务代码。复审方法不再逐函数扫“看起来危险”的点，而是从六类最终副作用反向追授权和提交点：物理 worktree / 依赖目录、preview 子进程、GitLab MR、本地 task/action 投影、用户输入与事件日志、SSE 状态。重点验证 R28-1～R28-5 的真实入口、退出路径和本轮修复引入的交接窗口。

### 已确认修复成立

- MR 的 `task.mrs` 与 `action.sideEffects.mrs` 已进入同一 task-lock 事务，旧的双投影半成功窗口关闭。
- `clearTaskSessionAgentIdIf` 已使用 `prepareMetaWrite` + rename 前 `finalGuard`，不会再用 await 前的旧锚点判断提交。
- 普通事件的 append 与 publish 已进入同一 per-task ordered chain，旧的“磁盘 A→B、SSE B→A”窗口关闭。
- chat run 的自然 / 取消 / 失败收尾已统一要求当前 instance；map 空不再被当作授权，原新会话 force-clear 空窗的主问题关闭。
- ResourceJob lease 已成为 `ensureTaskWorktrees` 必填参数并接入真实 start / resume / one-shot 入口；剩余问题不是“没传 lease”，而是已启动 OS 子进程无法被 lease 和 30 秒 join 约束。

### R29-1（P1）ActionSideEffectCoordinator 在“等待 MR 清空”与“登记 post-check”之间仍有 check→register 竞态，两类副作用可同时运行

位置：

- `src/lib/server/task-runner.ts:1842-1857`：`submit_mr` 先检查独立的 `runningChecks`，随后才 `beginActionSideEffect(...)`。
- `src/lib/server/task-runner.ts:2271-2293`：`submit_work` 等待 `waitForActionSideEffectClear(...)` 返回后，还要经过 failpoint / owner await，最后才由 `runActionPostCheck(...)` 登记 `runningChecks`；中间没有重新检查 action side-effect。
- `src/lib/server/action-side-effects.ts:53-113`：coordinator 只拥有 MR side-effect 状态，post-check 仍在 `task-stream.ts` 的另一张表中。

可达时序：

1. `submit_work(A)` 看见没有 MR，`waitForActionSideEffectClear` 返回 cleared。
2. 它停在 `mcp.submitWork.beforeAbortCheck`，或后续当前 action 复查的 await。
3. 并发 `submit_mr(A)` 看见 `runningChecks` 尚未登记，于是成功 `beginActionSideEffect` 并开始真实 GitLab create MR。
4. `submit_work(A)` 恢复，直接登记并运行 post-check。check 可能在 MR 尚未出现时判失败 / 切 `awaiting_ack`；随后外部 MR 成功，但 owner / action 状态变化又可让本地 upsert 被跳过，形成外部孤儿 MR或错误验收结果。

现有测试只覆盖“MR 已登记后 submit_work”等待”和“post-check 已登记后 submit_mr 拒绝”，没有覆盖两者的交接空窗。

修复要求：同一 action 的 MR side-effect 与 post-check 必须由一个状态机做原子 claim，例如 `waitAndClaimPostCheck` 与 `tryBeginSideEffect` 在同一同步提交点互斥；不要用两张 map 互相先查再登记。退出测试必须把 `submit_work` 停在 barrier 返回后、让 `submit_mr` 抢入，再恢复前者，并断言任何时刻最多一类副作用在飞，且不会遗留外部 MR / 错误 `awaiting_ack`。

### R29-2（P1）ResourceJob 的 30 秒 join 只等计数，无法停止已经启动、最长可运行 600 秒的 checkout / cp 子进程

位置：

- `src/lib/server/task-worktrees.ts:580-597`：hot checkout 仅在调用 `git checkout` 前验 lease；一旦子进程启动，lease 失效不能中断它。
- `src/lib/server/task-worktrees.ts:803-818`：依赖复制 `cp -Rc` 的 timeout 为 600 秒，同样只有调用前后检查。
- `src/lib/server/stop-task.ts:111-123`、`src/lib/server/task-runner.ts:1563-1579`、`src/app/api/tasks/[id]/route.ts:293-307`：stop / finalize / DELETE 最多等待约 30 秒，超时后继续清理、释放 lifecycle 或删除任务。

可达后果：旧 checkout / clone / `cp -Rc` 超过 30 秒时，stop/finalize 已返回并重新开闸；B 可以为同一任务启动并使用工作区，而旧 A 的 OS 子进程仍继续修改它。若旧链随后进入失主补偿，还会与 B 的工作区并发删除 / 重建。当前 ResourceJob 测试约 120ms 就主动释放，没有覆盖 join 超时。

修复要求：ResourceJob 要登记真实 Promise 以及可中止的 child-process handle / `AbortController`；revoke 时终止子进程，stop/finalize/DELETE 在进程真正退出前不能释放对应 lifecycle 或继续删除物理资源。若底层操作无法可靠取消，请让请求失败并保持资源闸，而不是以“30 秒后继续”作为正确性边界。退出测试需使用一个超过 join 上限且可观测仍在写的假子进程，证明 stop 后 B 不能启动，且 A 退出 / 补偿不会触碰 B。

### R29-3（P1）preview route 只在异步准入链开头检查一次任务状态，旧请求可在 finalize / DELETE 完成后重新 spawn dev server

位置：

- `src/app/api/preview/route.ts:45-83`：读取一次 task / lifecycle / status 后，继续 await `getRepoPreviewCommand`、`fs.access`，最后进入 `startPreview`；没有最终准入复查或 start reservation。
- `src/lib/server/preview-manager.ts:358-365,440`：`startPreview` 在独立全局队列中执行清理和 await，随后直接 `spawn`，该提交点不知道任务已终态 / 被删除。

可达时序（非隔离 task 最明显）：旧 POST 读到 developing 且 lifecycle 为空 → 卡在 settings 或 access → finalize / DELETE 停掉现有 preview 并完成终态 / 删除 → 旧 POST 恢复，原 repo 仍存在，最终又 spawn 新 dev server。finalize 在 worktree 移除后的二次 stop 不能覆盖非隔离 task，也不能覆盖发生在最后一次 stop 之后的旧请求；DELETE 同理。

修复要求：把最终准入放在 preview 队列内部、紧贴真实 `spawn` 之前，在该队列的 cleanup awaits 之后重新读取 task/status 并同步检查 lifecycle；更稳妥的是登记 per-task preview-start reservation，供 finalize/DELETE revoke + join。退出测试要分别将 settings/access 延迟，与 finalize 和 DELETE 交叉，断言终态或删除后不会出现新 pid。

### R29-4（P1）用户输入 route 迁移到吞错型 `writeEventAndPublish` 后，可“操作成功但用户消息永久未落盘”

位置：

- `src/lib/server/task-stream.ts:454-470`：`writeEventAndPublish` 捕获所有 append 错误、只记录日志并返回 `null`。
- `src/app/api/tasks/[id]/chat-reply/route.ts:252,575,714`：用户回复落盘返回 `null` 后仍可继续 start/send 或消费队列。
- `src/app/api/tasks/[id]/question/route.ts:304,366`、`src/app/api/tasks/[id]/ask-reply/route.ts:384-617`：同样忽略 `null`；ask-reply 还会继续清 pending。

当 events.jsonl 遇到 EIO / ENOSPC / EACCES 等非 ENOENT 写失败时，HTTP 或 agent 消费仍可成功，但用户原文 / 回答既不在事件日志，也不进入 checkpoint/history；重启、重连或 rewind 后永久丢失，UI 也可能没有用户气泡。这是从会抛出非 ENOENT 错误的直接 `appendEvent` 迁移后的语义回退。

修复要求：为 correctness-critical 用户操作提供 strict ordered helper，append 失败必须抛错或返回调用方必须处理的显式失败；吞错 helper 只用于 best-effort 日志 / 系统提示。已经成功送入 live agent 却落盘失败时，不能简单伪装成未发送重试，需显式返回“已送达但持久化失败”或使用可恢复 outbox 协议。给 chat-reply / question / ask-reply 注入 EIO，断言不会返回普通成功、不会清 pending 或静默丢原文。

### R29-5（P2）`submit_work` 的 notifier scope 已失效时会静默 no-op，但工具仍向 agent 返回 submitted

位置：

- `src/lib/server/chat-pending.ts:355-390`：`AwaitingNotifier` 是 `void | Promise<void>`，`safeNotifyAwaiting` 无法区分 accepted 与 notifier 内部 no-op。
- `src/lib/server/task-runner.ts:2250-2293` 附近的 notifier：`isCurrentRunningAction` 不成立时直接 return。
- `src/lib/server/chat-mcp.ts:165-206`：只要 caller token 仍匹配，就把该 void 当作 delivered 并返回 `submittedText(action_id)`。

可达场景：同一 live session / caller token 对旧 actionId 重试 `submit_work`，此时当前 action 已是 B。notifier 对 A 什么都没做、也没启动 post-check，但 agent 收到“已交卷”并结束本轮。runner 后续可能追问，所以定为 P2，但协议结果明确错误。

修复要求：notifier 返回结构化 `{ accepted | stale | busy }`，只有 accepted 才映射 submitted；补“caller 仍有效、当前 B、提交旧 A”真实链测试。

### R29-6（P2）停止或进程重启后 event `seq` 从 1 重新计数，与仍保留的 events.jsonl 产生重复序号

位置：

- `src/lib/server/task-fs-core.ts:619-621`：counter 仅存内存，clear 直接删除。
- `src/lib/server/chat-pending.ts:223-229`：`cleanupChatTaskState` 会清 counter。
- `src/lib/server/stop-task.ts:146,188-195`：普通 stop 调 cleanup 后，events.jsonl 仍保留，紧接着写 stop info 事件。
- `tests/ownership-r29-pipeline.test.ts:277-291`：当前测试反而断言 cleanup 后下一条 `seq === 1`，把重复行为固化成预期。

stop 后的新事件、以及服务重启后的第一条事件都会与历史 seq 重号；这违反“per-task 单调 seq”的协议，也使未来按 seq 重排 / 去重不可用。当前前端尚未按 seq 排序，因此定为 P2。

修复要求：首次 append 从 durable events 尾部恢复 last seq，或把计数可靠持久化；仅在 events 文件真实删除后清 counter。退出测试覆盖 stop→append 以及模块 / 进程重载→append，断言新 seq 严格大于 durable 尾值。

### 工程门禁与退出标准

- 定向：`ownership-r28-resource`、`ownership-r28-action-barrier`、`chat-finalize-r28-2`、`ownership-r29-taskside`、`ownership-r29-pipeline`、`ownership-r29-chatside`，**6 文件 / 33 项通过**。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 warning。
- `pnpm test`：沙箱内仅 preview stale-pid 用例因禁止 `ps` 超时；真实系统权限下复跑 preview **9/9**，全量 **81 文件 / 784 项全部通过**。
- `pnpm build`：通过。
- `git diff --check`：通过。

本轮绿灯说明已有测试没有回归，不说明上述交接窗口不存在。为避免第 30 轮继续逐点补洞，建议按三个协议边界一次收口并用矩阵验收：

1. action side-effect + post-check 共用单一 action claim；
2. worktree 与 preview 都把“授权复查 + 实际子进程登记 / spawn”放进不可分割的最终提交点，并让 stop/finalize/DELETE revoke + join 真实进程；
3. 事件 API 明确区分 strict user operation 与 best-effort notification，失败语义由类型强制调用方处理。

第 30 轮退出测试至少覆盖：barrier 返回后的 MR 抢入、超过 join 上限的真实子进程、preview 准入 await 后 finalize/DELETE、三条用户输入 route 的 append EIO、stale action submit_work、stop/restart seq 连续性。只补 helper 单测不足以关闭本轮结论。

---

## 第二十八轮验收（Codex、2026-07-18、深度收敛复审、纯 bug 范围）

本轮只审可达正确性 bug，不评价 S8 或产品功能设计，也没有修改业务代码。方法从最终副作用反向检查：物理 worktree、session/queue/status/done、持久化会话锚点、GitLab MR 与本地审计、events.jsonl 与 SSE；同时逐条核对 R27 测试是否走真实 owner/lifecycle 调用链。

### 已确认修复成立

- R27-1：`renameWithRetry` 在每次真实 rename attempt 前执行 failpoint + finalGuard，Windows transient error 的 retry 不再沿用失效授权。
- R27-5：task/chat ask lease 已包含当前 pending 的 `askId`；同 caller 双 ask 的 notifier 真链测试有效。
- R27-7：事件 append 遇 ENOENT 会返回未写入，publish 不再制造幽灵事件。
- R27-4 的历史 action 入场校验、`set_feishu_testers` 的 ship 类型和锁内结构条件已实现；问题缩小到同一当前 action 内的并行工具调用。
- R27-6 的 chat 主消息流已把 captured instance lease 传进 assistant buffer 和 SDK message handler；问题缩小到 run 最终收尾及少数被错误豁免的系统写。

### R28-1（P1）resource lease 没有覆盖真实启动链和 worktree 热路径；finalize 返回后旧链仍可修改/重建物理工作区

位置：

- `src/lib/server/task-runner.ts:2249-2260,2282-2290,4064-4069,4294-4304`
- `src/lib/server/task-runner.ts:946-960,1406-1421,1503-1585`
- `src/lib/server/task-worktrees.ts:406-440,467-521,625-680,711-760`
- `tests/ownership-r27-matrix.test.ts:473-539`

`ensureWorkspaceReady(task)` 不接 lease，`internalStartAgent`、`resumeTaskSession`、`startOneShotQuestion` 三个真实入口均无条件调用它。即使 advance/resume 前面曾经 leased ensure，`internalStartAgent` 仍会再走一次无租约热路径。

资源函数内部也只保护了新建路径的一部分：根目录 `mkdir` 在首次 lease 前；已有 worktree 的 `git checkout` 与最长 600 秒的 `cloneDepDirs` 完全不验 lease；新建成功后的 `.env` copy / dependency clone 也没有期间或结束复查。finalize 只等 `isTaskStarting` 5 秒并继续终结/清目录，因此旧 clone/copy 可在终态清理之后继续写，甚至在目标被删后重新创建子目录。`ensureTaskWorktrees` 还会吞掉 `WorktreeLeaseLostError` 返回普通结果；advance/resume 随后遍历 `ensured.infos` 调 `upsertGitBranch`，没有先把“让位”作为终态返回。该 helper 自己会拒绝终态 repoStatus，能挡 finalize 后的 meta 写，但挡不住仍处 developing 的后继 operation 接管场景，也无法补偿物理资源副作用。

R27 矩阵自己把此项标成“降级直测”：用独立布尔假 lease 调 helper，并且先执行 `finalizeTask`、之后才手工把布尔改成 false。它没有证明 finalize/revoke 能让真实 internal/resume/one-shot lease 失效，也没有覆盖已有 worktree checkout、clone 中删除、add 后 copy/clone 三个窗口。

可达后果：merged/abandoned 任务在终结返回后重新出现 worktree/依赖目录；旧链切换工作分支；developing 状态下旧 operation 可继续尝试补写后继的 gitBranches；finalize 清理与 cp/git 并发导致半目录或孤儿 worktree 注册。

建议：把 resource lease 变成 `ensureTaskWorktrees` 和 `ensureWorkspaceReady` 的必填参数，三个调用者传真实 op/lifecycle handle；lease 检查进入 mkdir、hot checkout、每个 copy/clone 单元及结束点。失主必须返回显式 `cancelled`/抛错，调用者不得继续 upsert。更稳妥的是登记 per-task resource job，让 finalize revoke 后 join；正确性不能依赖 5 秒超时。矩阵要走 `internalStartAgent/resume/one-shot × finalize` 真链，并覆盖 hot path 与 clone pending。

### R28-2（P1）chat 只保护了流内容，旧 run 的自然/取消/失败收尾仍可在 force-clear 空窗覆盖新会话

位置：

- `src/lib/server/chat-runner.ts:243-267,842-848`
- `src/lib/server/chat-runner.ts:1403-1438,1547-1576,1584-1722`
- `src/app/api/tasks/[id]/chat-reply/route.ts:474-507`
- `tests/ownership-r27-matrix.test.ts:788-840`

`consumeChatRun` 捕获的 instance lease 只用于 thinking/assistant/tool 事件。最终路径仍是无条件共享写：

- cancelled 分支 `closeChatSession(expected)` 失败后，只要 map 恰好为空就继续 clear queue、写 idle、publish done；
- natural finished 不检查 instance，直接把捕获的旧 record 改 idle、写 `awaiting_user`、publish done、触发 compact/flush；
- catch-cancel 与 `handleChatRunFailure` 同样把“expected close 失败且 map 为空”当成有权收尾，写 idle/error/done；
- `runChatSession.finishCancelled` 有相同 fail-open；自动重连还会在检查当前实例之前无条件写“正在重连”。

懒重启在旧 run 5 秒未退时 `forceClearChatRun`，随后 B 起新会话前要经过凭据校验、checkpoint、状态落盘等多个 await。此时 map 有一个真实空窗。A 若在空窗 finished/cancel/reject，会把 B 的 running 覆盖成 awaiting_user/error/idle、清 B 已入队消息、发 done 清前端 streaming；即便 A 在 B 注册后才执行，natural finished 仍没有 instance 检查。

R27-6 测试也明确是“降级：`writeOwnedEventAndPublish` 假 lease”，只证明旧主消息事件被 helper 拒绝，没有运行旧 `run.wait()` 的 finished/cancelled/reject 收尾，更没有 forceClear + B 启动链。

建议：建立唯一 `finalizeChatRunIfCurrent(taskId, instanceId, outcome)`，所有 status/queue/session/done/error/compact/flush sink 都在该 instance 的 CAS 下执行；带 expected instance 的 close 返回 false 时旧 owner必须无条件 no-op，map 为空不是授权。补真实矩阵：`old wait={finished,cancelled,reject} × forceClear × B checkpoint/start`，另补 reconnect preamble × B。

### R28-3（P1）`clearTaskSessionAgentIdIf` 只有前置 guard，没有写入提交前的 finalGuard

位置：

- `src/lib/server/task-fs.ts:743-794`
- `src/lib/server/task-runner.ts:4165-4192`
- `src/lib/server/chat-runner.ts:1271-1299`
- `tests/ownership-r27-wiring.test.ts:355-422`

helper 在 task lock 内先同步检查 `extraGuard`，随后 `await readMetaV06`，最后调用无条件 `writeMeta`；两个 await 后都不再检查内存 session/operation/start lease。锁只能串行 meta 写，不能阻止不拿此锁的 `agentSessions` / `runningChats` 同步安装。

可达时序：A 的 resume 确定性 reject，fire-and-forget clear 通过“当前无 session”检查并在读/写盘中让出；A 返回后释放 send 串行位或 chat start reservation；B resume 同一个持久化 agentId 并同步安装新内存实例。B 成功恢复本来就不需要重写相同的盘上 agentId，A 随后仍把锚点清空。进程重启/空闲回收后 B 无法恢复。

现有测试覆盖 guard 一开始就是 false、盘上 agentId 已换成不同值、或 B 已在调用 helper 之前安装；没有把 B 的**同 agentId**安装插在 helper 的 read/commit await 内。

建议：像其它条件事务一样使用 `prepareMetaWrite(meta).commit(finalGuard)`，每次 rename retry 前复查 `extraGuard + expectedAgentId`；最好让 guard 带预期 session instance/start token，而不只看“map 是否为空”。新增 `clear.beforeCommit` failpoint：A 已通过前置检查后安装同 agentId 的 B，断言锚点保留。

### R28-4（P1）`submit_mr` 与 `submit_work` 缺同 action 并发屏障；两份本地 MR 状态也不是一个事务

位置：

- `src/lib/server/task-runner.ts:1756-1763,1805-1967,2195-2209`
- `src/lib/server/task-fs.ts:1162-1230,1809-1915`
- `src/lib/server/action-checks.ts:325-423,433-470`

当前 action lease 能拒绝历史 action，却不能协调**同一 current/running action**的并行 MCP 调用。`submit_mr` 的 GitLab create/poll 可长时间 pending；同 caller 同时调用 `submit_work` 会立刻启动后台 post-check。check 读取 `action.sideEffects.mrs`，随后可把 action 切成 awaiting_ack。之后 createMR 即使外部成功，本地 action lease 已失效，只能返回 `skipped_local`：GitLab 留下外部 MR，本地 ship/dev check 却按“无 MR”失败或误判跳过。

即使 post-check 更晚，createMR 的本地落盘仍分成两个独立事务：先 `upsertMR(task.mrs)`，再 `appendActionSideEffectMR(action.sideEffects.mrs)`。post-check/stop/advance 可在二者之间取得 task lock，造成 task.mrs 已更新但 action 审计/门禁缺 MR；`mrVersion` 也可能与 action 记录不一致。R27 测试只测“历史 action 入场被拒”，没有 `createMR pending × submit_work` 或两次本地写之间切状态。

建议：per-action 登记 in-flight side effects；`submit_work` 在启动 deterministic check 前等待/拒绝该 action 尚未结束的 `submit_mr`。GitLab 成功后的 `task.mrs + action.sideEffects.mrs` 应在同一个 task-fs 条件事务中提交，复用同一 caller/action finalGuard。补两条真链矩阵：createMR pending 时 submit_work；第一份本地写后、第二份写前注入 action transition。

### R28-5（P2）events.jsonl 的 durable 顺序与 SSE publish 顺序可以反转，前端会永久保留乱序

位置：

- `src/lib/server/task-fs.ts:586-611`
- `src/lib/server/task-stream.ts:444-475`
- `src/app/tasks/[id]/page.tsx:315-329`
- `src/lib/task-store.ts:82-109`

`appendEvent` 在 per-task append chain 写完行后，可能再等待 meta.updatedAt 的 task lock/atomic write，之后才返回；append chain 已经释放，后来的 B 可以先追加并先 publish，A 才 publish。磁盘顺序为 A→B，SSE 到达变成 B→A。前端按到达顺序 append，不按 durable sequence 排序；之后 `mergeTaskEvents` 按 id 并集保留本地顺序，因此刷新前的 B→A 可能一直存在，tool/assistant/ask 卡片时间线错误。

建议：append 与对应 publish 使用同一个 per-task 有序提交链；meta touch 移到 publish 后的 best-effort 后台任务，或让 append 在 durable line 成功后立即返回并单独排队 touch。不要只按毫秒 `ts` 排序，应给事件持久化单调 sequence。补 `A append 成功后 meta touch 挂起 × B append/publish`，同时断言 jsonl 与 SSE 顺序一致。

### 为什么第二十八轮门禁仍会全绿

`tests/ownership-r27-matrix.test.ts` 顶部称“7 个真实提交点”，但文件内部明确记录 R27-2 与 R27-6 为“降级直测”。R27-3 测的是 B 改成不同 agentId 或在 clear 前已安装，R27-4 测的是历史 action，不是同 action 工具并发。wiring 测试进一步证明 helper 的单次条件判断，却没有证明真实 owner/lifecycle 能贯穿多个 await 和最终收尾。

本轮复跑结果：定向 5 文件 / 70 项通过；typecheck、lint、真实权限全量 74 文件 / 746 项、build、diff-check 全部通过。最初沙箱内全量唯一失败为 preview-manager PID 归属测试，原因是沙箱明确禁止 `ps`；沙箱外该文件 9/9、全量 746/746 通过，不是业务回归。

### 建议下一轮的收敛边界

不要再按当前失败分支逐处加 `if`。只做五个协议收口，并用真实矩阵作为退出条件：

1. `ResourceJob`：资源 lease 必填、注册、revoke、join、补偿，覆盖整个 ensure/copy/clone 生命周期。
2. `finalizeChatRunIfCurrent`：chat 的 session/status/queue/event/done/flush 只有一个 instance-CAS 收尾入口。
3. 条件锚点写：session anchor clear/set 统一走 prepare + retry finalGuard，身份含 instance/start token。
4. `ActionSideEffectCoordinator`：同 action 的外部副作用 barrier + MR 两份本地投影单事务。
5. `OrderedEventCommit`：durable append 与 SSE publish 同序，事件有单调 sequence。

退出门槛不是“helper 测试存在”，而是上述每个协议至少一条生产入口真链：在最终不可逆 await 处挂起，注入 finalize/stop/forceClear/submit_work/B takeover，再验证磁盘、内存、SSE、外部 mock 四侧不变量。完成这五项后再做一轮全局 sink 搜索即可，继续逐调用点补 ESLint 豁免只会延长循环。

---

## 第二十七轮验收（Codex、2026-07-18、深度收敛复审、纯 bug 范围）

本轮只审可达正确性 bug，不评价 S8、产品路线或功能取舍，也没有修改业务代码。审查不再逐分支随机找漏，而是从四类不可逆 sink 反推授权：文件替换、事件追加、外部系统调用、资源/会话创建；同时检查 R26 新增 failpoint 是否真的落在循环内的最后一次副作用之前。

### 已确认修复成立

- `prepareMetaWrite().commit(finalGuard)` 在**第一次** rename 调用前会同步复查，R26 的 `metaCommit.beforeRename` 单次窗口有效。
- `appendEvent` 的 lease 已进入 per-task append chain，能拦住“已入队但尚未执行”的失主事件。
- `publishIfCurrent` 已接到普通 task consume 的 done 出口；R26 测试中的旧 done 不会再清新 run 的 streaming 状态。
- `installSessionIfCurrent` 把 task session record、MCP handler/notifier、caller token 合成一个同步安装点；成功安装路径不再出现半 session/半 bridge。
- `cancelPendingIf(taskId, askId)` 能正确处理**不同 caller 接管**后的旧 ask 反登记；stop 在首个 await 前失效 caller token 也成立。
- R26 新增的 31 条定向测试均稳定通过，不是假绿；问题是测试停在 helper 的第一次提交点，没有覆盖 retry loop、资源函数内部和同 caller 身份复用。

### R27-1（P1）`finalGuard` 只检查一次，Windows rename 重试期间换主仍会提交旧 meta

位置：

- `src/lib/server/task-fs-core.ts:377-390`
- `src/lib/server/data-root.ts:49-65`
- `tests/ownership-r26-sinks.test.ts:136-159`

`commit(finalGuard)` 在调用 `renameWithRetry()` 前只验一次 guard；后者遇到 Windows 常见的 `EPERM` / `EACCES` / `EBUSY` 会退避并重试五次，循环内没有再验 owner。

可达时序：A 的 guard 为真，第一次 `fs.rename` 因杀软/读句柄占用失败；50～250ms 退避期间 B claim 或 stop，使 A 失主；后续一次 retry 成功，把 A 的旧 meta 覆盖到盘上。B 可以只换 caller 而不再写同一字段（例如测试人员写入接管），因此这不是“稍后会被 B 覆盖”的瞬态。R26 测试只挂在**第一次调用 `renameWithRetry` 之前**，没有注入“首轮 rename 失败 × backoff 中换主”。

建议：让 retry helper 接收同步 `beforeAttempt`，在每次真正调用 `fs.rename` 前检查；guard 失败立即清 tmp、返回未提交。一次成功发起的 rename 可作为线性化点，失败的 syscall 不能消费授权。新增 transient rename error × takeover 的真实矩阵。

### R27-2（P1）prewarm 已进入资源函数后，finalize 仍可结束；迟到 worktree 会在终态后被物理重建

位置：

- `src/lib/server/task-runner.ts:783-840`
- `src/lib/server/task-runner.ts:1455-1499`
- `src/lib/server/task-worktrees.ts:470-552`
- `src/lib/server/task-runner.ts:3935-3949`

prewarm 只在调用 `ensureTaskWorktrees()` 前后检查 `stillPrewarm`。资源函数内部却可能先做 30 秒 fetch、分支探测、目录清理，再执行最长 120 秒的 `git worktree add`；这些循环/命令没有 lease。`finalizeTask` 只等 `isTaskStarting` 最多 5 秒，而 prewarm 本身不登记到该计数，超时也会继续终结。

可达时序：A 已通过 `prewarm.beforeWorktreeAdd` 并进入 `ensureTaskWorktrees`，卡在 fetch；B finalize 撤销 op、写终态、删除当时尚不存在的 worktree并返回；A 随后继续 `git worktree add`。函数返回后的复查只能阻止 `upsertGitBranch` 和 info event，无法撤销已创建的目录、git worktree 注册和可能的新分支。最终是 `merged/abandoned` 任务重新留下物理工作区。R26 的 prewarm 测试停在进入资源函数**之前**，route 终态测试还关闭了 worktree 隔离，均未命中该时序。

建议：resource lease 必须传入 `ensureTaskWorktrees`，在 fetch 后、目录删除前、每次 add/retry 前复查；若 add 后失主，立即补偿移除本轮创建的 worktree/注册。另一种正确方案是终态 owner 可取消并无正确性超时地 join 资源 job；5 秒等待只能是体验优化，不能作为互斥证明。

### R27-3（P1）task/chat 的 `Agent.resume` 确定性失败仍无条件清锚点，可抹掉后继会话的持久化身份

位置：

- `src/lib/server/task-runner.ts:3915-4060`
- `src/lib/server/chat-runner.ts:1192-1294`
- `src/lib/server/task-fs.ts:743-753`

成功/install 路径已经条件化，但两个 resume 的确定性失败 catch 仍直接 `void setTaskSessionAgentId(task.id, undefined)`；该 setter 只拿 task lock，无 op/session 条件。

task 可达时序：A 的 `Agent.resume` pending；B claim 后创建/安装 session B，并排队把 B 的 agentId 落盘；A 随后确定性 reject，A 的 clear 在同一 task lock 中排到 B 的 set 后面，于是内存 B 仍健康、盘上 `sessionAgentId` 却被清空。chat 也可由 stop 取消 A 的 start reservation、B 起新会话后，A 的迟到 reject 走同一裸 clear。进程重启或空闲回收后，B 失去恢复锚点。R26 只测 resume 成功后 install 失主，没有覆盖 reject cleanup。

建议：提供 conditional clear，至少同时要求原 resume lease 仍有效、当前内存 session/instance 没有后继，并核对预期持久化锚点；仅比较 agentId 不够，因为 resume 的新内存实例可复用同一 agentId。新增 `Agent.resume reject × B install/persist`，task/chat 各一条。

### R27-4（P1）`submit_mr` 仍只有 session caller 身份，没有当前 action 身份；历史 action 可在新 action 中产生外部副作用

位置：

- `src/lib/server/submit-mr-guard.ts:107-121`
- `src/lib/server/task-runner.ts:1651-1964`
- `src/lib/server/task-runner.ts:1967-2012`
- `src/lib/server/task-fs.ts:1649-1673`

`validateSubmitMr` 只要求 action 存在且类型为 ship/dev/custom，不要求它仍是 `currentActionId + running`。同一个跨 action session 会长期复用 caller token，因此旧 action A 的迟到/重试 `submit_mr` 在当前 action 已变成 B 时仍通过所有 caller 检查，随后可以创建新 MR、关闭旧 MR、轮询并把记录挂回历史 A。R26 加的 createMR 前后 caller 检查只覆盖“session 被接管”，没有覆盖“session 不变、action 已切换”。

同根旁路还在 `set_feishu_testers`：外层 fresh 检查只验 current+running、没验 ship 类型；检查与 `setFeishuTesterUserKeys` 的锁内提交之间可切 action，而最终 guard 又只验 caller。报告所称的“current + running + type 进锁内 expected”在此调用链并未实现。

建议：session caller 只做 agent 认证，另发 action lease（actionId + action generation/claim）；每个外部副作用调用前同步验 action lease，本地 MR 与 action side-effect 记录用同一条件事务提交。至少补“同 caller token、A 已历史化、B current running 时 A submit_mr/set_feishu_testers”的测试；只换 caller token 的测试不足以证明 action 授权。

### R27-5（P1）ask lease 不含 askId/token；同一 caller 的并发/重复 `ask_user` 会让 UI 展示与 pending map 分裂

位置：

- `src/lib/server/chat-mcp.ts:263-294`
- `src/lib/server/chat-pending.ts:163-208,379-415`
- `src/lib/server/task-runner.ts:2062-2108`
- `src/lib/server/chat-runner.ts:1121-1161`

工具先同步 `registerPendingAsk`，再异步 notifier；notifier 的 `askLease` 只有 caller token（task 侧再加 lifecycle），不检查 pending map 当前是否仍是本 signal 的 askId/token。

可达时序：同一 agent/session 并行调用或 HTTP 重试产生 A、B 两个 ask；A 登记后卡在 `supersedePendingAsks`，B 登记并完成自己的事件/status；A 恢复时 caller 仍相同，所以继续把 A 的 ask event 写在 B 后面并切 awaiting。pending map 仍指向 B，但 UI 最新卡片是 A/token A；用户回答 A 时 route 对照 B/token B 会拒绝，形成看得见但永远答不了的弹窗。`cancelPendingIf` 只解决不同 caller 失主后的清理，R26 矩阵也特意换了 caller B，因此漏掉该路径。

建议：ask lease 必须包含 `getPendingAsk(taskId)?.askId/token === signal.askId/token`，并贯穿 supersede、event、status、publish 的每个 sink。补同 caller 的 A/B 并发测试，而不只是 caller takeover。

### R27-6（P1）事件 sink 仍是 optional lease 且有第二套本地实现；chat 旧 run 可在 force-clear 后污染新会话历史

位置：

- `src/lib/server/task-stream.ts:435-455`
- `src/lib/server/chat-runner.ts:543-559,1572-1623`
- `src/lib/server/sdk-message-handler.ts:96-108`
- `src/app/api/tasks/[id]/chat-reply/route.ts:474-486`
- `src/lib/server/task-runner.ts:3574-3578,3676-3684,3707-3715,3798-3801,4324-4327`

“唯一事件入口”实际上仍有两份 `writeEventAndPublish`，且 lease 参数都是可选、缺省即 fail-open。chat 的 `consumeChatRun` 捕获了 `rec`，但 assistant buffer flush 不传 lease，`handleSdkMessage` 也不传 op/instance；handler 明确把 chat 的 `opHandle` 缺省解释成永远 current。

可达时序：懒重启取消 A，等待超时后 route `forceClearChatRun` 并启动 B；若 A 的 SDK cancel 很慢、之后仍 yield assistant/thinking/tool 消息，A 会继续把内容 append/publish 到同一个 `events.jsonl`。A 的最终状态门控即使不覆盖 B，也已经无法清除这些持久化内容；后续 agent 用事件历史恢复上下文时会把 A/B 两条会话混在一起。R26 只给 shell delta 接了 chat instance lease，主消息流没有接。task-runner 也仍有多条“先验 owner、await 入队、无 lease 写事件”的分支，说明 optional 参数无法强制接线完整。

建议：拆成 `writeOwnedEventAndPublish(..., lease /* required */)` 与显式命名的 user/terminal system sink；runner 内禁止调用 optional/unconditional 版本。chat 给每个 run 捕获 instanceId lease并传入 buffer + SDK handler；用 AST/lint allowlist 禁止 runner 自建第二套 writer、禁止 owner 路径裸 `publish`/裸事件写。新增“chat A 在 forceClear+B 后继续 yield 主消息”的真实流测试。

### R27-7（P2）删除竞态下 append 实际被丢弃却返回成功，SSE 会 publish 不存在于磁盘的幽灵事件

位置：

- `src/lib/server/task-fs-core.ts:579-620`
- `src/lib/server/task-fs.ts:586-610`
- `src/lib/server/task-stream.ts:440-448`

`appendEventLineUnlocked` 遇到任务目录已删的 `ENOENT` 会静默 `return`，但没有把“未写入”返回给上层；`appendEventLine` 因而仍返回 `true`，`appendEvent` 构造并返回 event，最终 `writeEventAndPublish` 向在线订阅者发送一条磁盘里从未存在的事件。

可达时序：A 通过 meta 存在检查后排队，B 删除任务目录，A 的 appendFile 得到 ENOENT；目录不会复活是对的，但 A 仍可实时发布迟到的 ask/error/assistant 事件。刷新后事件消失，实时 UI 与持久化历史不一致。现有删除测试只钉“目录不复活”，没有钉“不 publish”。

建议：让 `appendEventLineUnlocked` 返回 `false` 表示 ENOENT，并一路透传到 `writeEventAndPublish`；新增 `meta exists → delete → queued append` 测试，同时断言返回 null、无 SSE envelope、目录未复活。

### 为避免继续循环审核，下一轮建议采用的收敛门槛

不是继续增加“某个 await 后再 check 一次”，而是把不变量变成类型/结构约束：

1. **授权进入循环和资源函数内部。** retry、poll、fetch/add/rollback 每次副作用前都由同一 lease 判定；caller 外层复查不能替代 sink 内复查。
2. **区分 session、action、ask、resource 四种 lease。** session token 不能替代 actionId/askId/resource job identity；每个 lease 都有单一同步 `isCurrent` 入口。
3. **owned sink 的 lease 设为必填。** 无条件写只给用户直接操作/终态 owner，API 名称显式区分；禁止 optional 参数和本地复制实现。
4. **测试矩阵按真实提交点命名。** 至少覆盖：rename 首次失败后的 retry、ensure 已进入 fetch 后 finalize、resume reject cleanup、同 caller 历史 action、同 caller 双 ask、chat force-clear 后旧流继续 yield、delete 后 append ENOENT。
5. **静态门禁防回退。** AST/ESLint 检查 runner 中的 raw `appendEvent`、optional owned writer、本地 writer、副作用前仅 caller-token 校验；这样后续新增分支不能绕开协议。

这不是要求重写 coordinator，也不涉及功能设计。它只把 R26 已选择的 lease/sink 方案完成到底；完成上述结构门槛后，继续逐分支 review 才会真正收敛。

### 第二十七轮复审门禁（当前工作区）

- R25/R26 定向：`ownership-r25-matrix` + R26 sinks/wiring/matrix，共 4 文件 / 31 项通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过（0 error / 0 warning）。
- `pnpm test`：真实系统权限下 72 文件 / 727 项全部通过。沙箱内首次 726/727，原因是环境禁止 `ps`，PID 归属核验按安全策略不杀；同一用例在真实权限隔离复跑通过，不记为产品 bug。
- `pnpm build`：通过。
- `git diff --check`：通过。
- 复审期间关注范围内业务文件无再次变化。

**验收结论：不通过，6 个 P1 + 1 个 P2。** 门禁绿灯证明已有行为未回归，但不能证明上述未插桩窗口不存在。

---

## 第二十六轮验收（Codex、2026-07-18、深度收敛审查、纯 bug 范围）

本轮遵守用户约束：只审可达正确性 bug，不评价 S8、产品路线、是否持久化 owner 等功能设计；没有修改业务代码。审查方式从“继续扫分支”改为“沿真实副作用 sink 反查授权是否在提交瞬间成立”，并复核新增 failpoint 是否真的落在 sink 内。

### 已确认修复成立

- **R25-1 已修。** `appendAction` 与 `finalizeStaleAndIdleLocked` 现在持同一把 task lock 到异步 rename 完成；stop/finalize 获锁后必能看到 append 的最新版并收尾。`metaCommit.beforeRename × stop` 测试命中了真实窗口。
- **R25-2 局部成立。** one-shot 的 `running` 写已改为 terminal-aware 条件事务，`startOneShotQuestion` / `internalStartAgent` 在 Agent.create 前 fresh 读盘上终态；陈旧快照直走这两条入口会被拒。
- **R25-3 局部成立。** `submit_mr` 在 `createMR()` 前会复查 caller；原测试中的“handler 已入场、createMR 前被 B 接管”确实不会调用 GitLab。
- **R25-4 局部成立。** question run 在 `getTask` / restore 之后、同步 publish done 之前会复查 observer；该特定 done 窗口已关。
- 新增 7 条 R25 定向测试不是假绿；问题在于覆盖边界仍窄于修复报告声称的整体协议。

### R26-1（P1）终态准入没有下沉到 session resume / worktree sink，终态任务仍可被复活

位置：

- `src/app/api/tasks/[id]/question/route.ts:108-127,238-257,385-410`
- `src/lib/server/task-runner.ts:3679-3765,4098-4302`
- `src/lib/server/task-runner.ts:774-812`
- `src/lib/server/task-fs.ts:1579-1595`

第一条可达时序：A 的 `/question` 在 `getTask()` 中已读到旧 `developing + sessionAgentId`，卡在 hydrate；B 完成 finalize、写 `merged/abandoned`、关会话、删 worktree 并释放 lifecycle；A 随后拿着旧 task 返回，并在 **finalize 之后**拍到新的 op generation，所以 route 的 lifecycle/gen 检查均通过。route 在 terminal-aware one-shot setter 之前先调用 `deliverTaskQuestion()`；`sendToTaskSession()` 找不到内存会话时会调用 `resumeTaskSession()`。后者虽然接收 `opHandle`，函数体完全不使用，也不 fresh 检查 lifecycle/repoStatus，于是会用旧 `sessionAgentId` 重新建工作区、`Agent.resume`、注册 session 并 send。因为 A 的 handle 拍在 finalize 之后，它始终 current，最终得到“盘上终态 + 活 agent/run + 被重建 worktree”。R25-2 测试只直调条件 setter 和 `startOneShotQuestion`，没有经过 route → deliver → resume，不能覆盖此路径。

第二条可达时序：创建或 reopen 后 fire-and-forget 的 `prewarmTaskWorkspace()` 只与 advance 共用 `runAdvanceExclusive`，不参与 lifecycle/op/finalize 协议。它可在 `ensureTaskWorktrees()` 的 fetch/worktree add 中挂起；finalize 先写终态并删完 worktree后，prewarm 再恢复，重新 `git worktree add`，随后用无终态 guard 的 `upsertGitBranch()` 和 info event 写回终态任务。

**建议修法：** 终态准入必须落到 `resumeTaskSession`、`ensureTaskWorktrees`/prewarm 等实际资源创建 sink；finalize 需要 revoke/join 在飞的 resume、prewarm、start job。只在 route 或 Agent.create 前检查不构成闭环。

### R26-2（P1）session record 与 MCP bridge 分步安装，resume 失主可造成 session/bridge 错配和 agent 泄漏

位置：

- `src/lib/server/task-runner.ts:2582-2590`
- `src/lib/server/task-runner.ts:3679-3765`
- `src/lib/server/task-runner.ts:2092-2098,2155,2262-2274`

`resumeTaskSession(..., { opHandle })` 的 `opHandle` 当前未使用。A 在 auto-reconnect 的 `Agent.resume()` await 中，B 可 claim 并开始新 Agent：B 在 Agent.create 前先注册 bridge B，但 session record 尚未落表；A resume 返回时看不到 B record，于是注册 bridge A + session A。`tryAutoReconnect` 随后发现 A 已失主，只 `return`，没有关闭刚返回的 A record/agent。B create 返回后又无条件把 `agentSessions` 覆盖成 B，但不会再注册 bridge；最终可形成 `session=B、expected caller/handler=A`，B 的 MCP 全被拒、A 的迟到 MCP 反而被接受，同时 A agent 泄漏。

现有两次 `agentSessions.get()` CAS 只能保护“表里已经有完整 record”的情况，保护不了 bridge 已安装、record 未安装的半状态。

**建议修法：** 只保留一个同步 CAS：`installSessionIfCurrent(lease, record, bridges)`，在同一线性化点原子安装 record + handler + notifier + caller token；所有 create/resume 都走它。resume 在每个 await 后核 lease，失主时必须关闭本次精确 agent/record，调用方不得再单独注册 bridge。

### R26-3（P1）ask pending 是 taskId-only 单例；旧 A 的反登记会删除 B 的新提问

位置：

- `src/lib/server/chat-pending.ts:163-185`
- `src/lib/server/task-runner.ts:1926-1953`
- `src/lib/server/chat-runner.ts:1118-1142`
- `src/lib/server/ask-supersede.ts:23-47`
- `tests/ownership-r25-matrix.test.ts:600-645`

A 已登记 ask A、在 `supersedePendingAsks()` 中挂起；B 接管并通过 `registerPendingAsk()` 把 map 换成 ask B；A 恢复发现 caller 失效，调用裸 `cancelPending(task.id)`，会直接删除 B。B 的 ask event 仍可能落盘，但内存 token 已丢，用户点击回答必被拒。task/chat 两套 notifier 都有同样时序。

当前 R25 测试只让 B 重注册 caller token，没有让 B 真登记 ask B，并把 `getPendingAsk(id) === null` 当正确结果，反而固定了错误语义。另一个缺口是 `supersedePendingAsks()` 自己会异步写 superseded event，caller 只在它返回后检查；接管发生在其 `getTask`/event IO 内时，旧 A 仍可能对新世界写作废标记。

**建议修法：** pending entry 必须带不可复用身份，提供 `cancelPendingIf(taskId, expectedAskId/token/caller)`；把 supersede → register → event 作为 per-task 串行事务，或至少把 caller/ask identity 带入 event sink。

### R26-4（P1）session caller token 不是完整操作租约：stop、外部副作用和 action scope 均有可达越界

位置：

- `src/lib/server/stop-task.ts:89-125`
- `src/lib/server/chat-pending.ts:292-312`
- `src/lib/server/task-runner.ts:1595-1740,1881-1912,1964-1975`
- `src/lib/server/task-runner.ts:484-552`
- `src/lib/server/chat-mcp.ts:138-175`
- `src/lib/server/submit-mr-guard.ts:107-121`

同一根因有三种已验证投影：

1. stop 在 `begin lifecycle + revoke` 后先 await `stop.afterGate`，到 `cleanupChatTaskState()` 才清 caller。`callerStillValid()` 只比 token，不看 lifecycle/session/op；所以用户已经点停止后，旧 agent 仍可在窗口内进入 `submit_mr` / `set_feishu_testers` 并做外部副作用。
2. `createMR()` 成功返回后没有立即复查 caller，就可能继续 `closeOpenMR()`。若 B 在 create await 中接管，A 创建 MR 已不可撤销，但“是否再关闭旧 MR”仍是可阻止的新副作用；当前代码会照做。后面的 merge-status poll 也应在各副作用之间重新授权。
3. caller token 的寿命是整个 agent session，但 `submit_work` / `set_plan_batches` 把它当 action owner。旧 action 的迟到/重试 `submit_work(actionId=A)` 在同一 session 下仍合法，会先无条件 abort 当前 `runningChecks[task]`，之后才读到 A 已非 running 并退出，导致新 action B 的 check 被杀且不再收尾。`set_plan_batches` 也不要求 action 是 current/running/plan；即使 `patchActionIfOwner` 返回 null，只要 token 仍匹配仍写“已记录”事件并返回 ok。

**建议修法：** session caller 只负责认证 agent。每个 MCP action 还必须在 task lock 内验证 `currentActionId + expected status + expected type`；验证成功后才能 abort/启动 check。stop 必须在首个 await 前同步使 bridge lease 失效。每个外部 await 返回后，在进入下一项不可逆副作用前重新检查完整 lease；`patched === null` 必须返回失败且不写成功事件。

### R26-5（P1）guard 仍在异步 sink 外：事件队列和条件 meta commit 可在最终检查后失主

位置：

- `src/lib/server/sdk-message-handler.ts:60-84`
- `src/lib/server/task-stream.ts:420-429`
- `src/lib/server/task-fs-core.ts:590-613`
- `src/lib/server/task-fs-core.ts:350-380`
- `src/lib/server/task-fs.ts:1166-1172,1382-1393,1483-1496,1546-1552,1615-1621,1754-1760`
- `src/lib/server/task-runner.ts:3159-3189,3524-3554`

事件路径中，`stillCurrent()` 在调用 `writeEventAndPublish()` 之前检查；真正的 append 会进入 `appendEventLine` 的 Promise chain。A 检查通过后若排在前一条 event 后面，B 可先 claim，随后队列才执行 A 的 `appendFile`，旧 event 仍落盘并 publish。`sdkmsg.beforeEventWrite` 插桩位于检查之前，证明的是“检查能看见既有接管”，没有命中“已检查、已入队、尚未 append”的窗口。`assistantCtx.flush()` 也没有把 lease 带进 sink。普通 consume 的 `done` 在第 3524 行检查后还会 await `getTask`/条件写，最终第 3554 行无复查 publish，A 可清掉 B 的 streaming UI；现有测试只覆盖 question done。

meta 路径中，多项条件 helper 在 `prepareMetaWrite()` 后检查 owner/caller，再 `await prepared.commit()`；commit 内先 `await failpoint("metaCommit.beforeRename")`，之后才调用 rename。owner/caller map 不受 task lock 约束，B 可在最终检查后、rename 真正发起前接管；A 仍提交旧值。R25-1 的 stop 不再受此害，是因为 stop 等同一 task lock 并在 A 后覆盖收尾；但纯 caller/session 接管未必有后继 meta 写。例如旧 A 的 `setFeishuTesterUserKeys` 可在 commit 窗口失主后仍改盘。现有测试只做 `meta commit × stop`，没有做 `meta commit × caller takeover`。

**建议修法：** 所有 owner-aware sink 应接收 lease/guard，在自己的序列化点执行最终检查：`appendEventIfLease` 把检查放进 event chain 的回调、`commitIfLease` 在实际 rename 调用前检查、`publishIfCurrent` 在 envelope 发出前检查。更稳妥的是 event/SSE 带 `operationId/runId`，前端 reducer 同时丢弃旧 operation envelope。

### R26-6（P2）shell output delta 没有 operation/run 身份，旧 run 输出可混入新 run

位置：

- `src/lib/server/shell-output-bridge.ts:42-125`
- `src/lib/server/task-runner.ts:2334,2610,3404,3987,4209`
- `src/lib/server/chat-runner.ts:1055,1461,1829`

`createShellOutputDeltaPublisher(taskId)` 只按 taskId 直接 publish ephemeral event。旧 run 在 B 接管后迟到的 onDelta/flush 无法被识别，会显示在 B 的工具块中；callId 也不是跨 run 的授权身份。

**建议修法：** 创建 publisher 时传 run/operation lease，每次 flush 前 gate；envelope 带 runId，前端按 runId 归属或丢弃。

### R26-7（P2）failpoint 矩阵仍停在真实 sink 之前，缺少可执行的退出标准

当前缺失的决定性矩阵：

- `/question` 陈旧 task → deliver/resume × finalize，而不是直调 one-shot helper；
- prewarm 在 worktree add 前后 × finalize remove；
- Agent.resume 返回/安装前 × B 处于“bridge 已装、session 未装”的半状态；
- A cleanup 前让 B 真登记 ask B，而不只是换 token；
- event 已入 append queue、尚未 `appendFile` × claim；
- meta 已过 final guard、尚未 rename × caller takeover；
- createMR 成功返回、closeOpenMR 前 × takeover/stop；
- 旧 action submit_work × 新 action post-check；
- 普通 done 在最后一次 owner check 后 × claim。

所有并发测试都应等待明确 failpoint，并断言业务 Promise 在 timeout 前完成；不要用固定 sleep 作为收敛依据。

### 一次性收敛建议（建议原样转给改码 AI）

继续给每个业务分支补 `if (current)` 会重复产生新窗口。下一轮建议只改授权层和 sink 层，并设硬退出条件：

1. 区分五种权威身份：request admission、run operation、session instance、MCP caller、action scope；禁止 session token 代替 action owner。
2. 收口五个唯一入口：`mutateTaskIf(lease, expected, mutation)`、`appendEventIf(lease, event)`、`publishIfCurrent(lease, envelope)`、`installSessionIfCurrent(lease, record, bridges)`、`cancelPendingIf(askIdentity)`。
3. owner-aware 路径禁止裸调 `writeEventAndPublish/appendEvent`、直接改 session/bridge map、taskId-only pending delete、无结构条件的 action patch；可用 lint 或静态 grep allowlist 守住。
4. SSE/event 带 `operationId/runId`，后端和 UI 两层拒绝旧 envelope。
5. 上述 9 个真实 sink failpoint 全过，且 full gates 连跑稳定，才作为竞态专项退出标准；“测试总数增加”本身不算收敛证据。

### 第二十六轮工程门禁

- 所有权定向测试：`ownership-r25-matrix`、`ownership-r24-wave1`、`ownership-r24-wave2`、`ownership-r23-matrix`、`ownership-failpoint-matrix`，5 文件 / 48 项全部通过
- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：69 文件 / 703 项全部通过
- `pnpm build`：生产构建通过
- `git diff --check`：通过
- 审查和门禁期间，关注范围内业务文件没有再次变化

### 第二十六轮验收结论

**不通过：5 个 P1 根因族 + 2 个 P2。** 这次不是又枚举了一批零散分支，而是把剩余问题归并到五个协议缺口：终态资源准入、session/bridge 原子安装、ask 身份、MCP 完整授权、异步 sink 线性化。按上面的唯一入口与真实 sink 矩阵收口后，后续分支会继承同一套不变量，review 才有明确停止条件。

---

## 第二十五轮验收（Codex、2026-07-18、纯 bug 范围）

审查范围继续遵守用户约束：只找可达的正确性 bug，不评价 S8、owner 是否落盘、是否单抽 coordinator 或其它功能设计；没有修改业务代码。本轮复核第二十四轮 R24-1～R24-8 的最新修复，并检查修复引入的新提交窗口。

### 已确认修复成立

- **R24-1 主问题已修。** `runActionPostCheck` 已改用独立 check lease（`runningChecks` 的实例号、generation 与 lifecycle），不再因一次性 run owner 释放而把正常慢 post-check 当成 stale。
- **R24-2 主问题已修。** 会话 bridge 改绑 agent session 的 `callerToken`；同一 session 的第二轮 send 不会因前一轮 operation release 而失效。
- **R24-3 已修。** 公共 send 与 one-shot 都在排队/首个 await 前拍 observer；resume 路径也继续携带该 admission，失主后会清理本轮新登记的 session。
- **R24-5/6/7 各关闭了一部分。** 路由能拒绝当前可见的 `finalizing`，stop 会 join terminal lifecycle；MCP 分派入口会比 caller token；SDK 消息与 questionRun 在“入场前已经失主”时也会让位。但下面的 await 内接管窗口仍未闭合。

### R25-1（P1）R24-4 的真正异步 commit 窗口仍在，stop 可漏掉刚提交的 action

位置：

- `src/lib/server/task-fs.ts:1028-1040`
- `src/lib/server/task-fs-core.ts:368-375`
- `src/lib/server/data-root.ts:49-65`
- `src/lib/server/stop-task.ts:117-175`
- `tests/ownership-r24-wave1.test.ts:399-445`

`appendAction()` 当前在 `prepareMetaWrite()` 后同步复查 guard，然后执行 `await prepared.commit()`。注释把“复查到发起 commit 之间没有 await”当成线性化闭环，但 `commit()` 内部实际会 `await renameWithRetry()`；Windows 的 rename 还可因 `EPERM/EACCES/EBUSY` 退避重试约 750ms。因此 guard 通过不等于 meta 已提交。

可达时序：A 的 guard 复查通过 → A 进入异步 rename 并暂时挂起 → stop 同步 revoke，然后无锁 `getTask()` 读到旧 meta → A rename 成功并释放 task lock → stop 按旧快照扫描，漏掉 A 的新 running action，最后等待锁并把 task 写为 idle。最终得到 `action=running + task=idle + 无 runner` 的幽灵 action。

新增 R24-4 测试只挂在 `append.afterPrepare`，也就是**最终 guard 复查之前**；它让 revoke 先发生、再放复查，所以只能证明 guard 能拒绝已发生的 revoke，没有覆盖“guard 已过、commit rename 未落、stop 已重读”的窗口。

修复不能只把同步复查挪近 `commit()`。stop/finalize 的“读最新 action → 取消 → idle”需要与 append 的最终提交共享同一个锁内事务，或采用等价的提交协议，确保 stop 获得锁后扫描的是 append 提交后的最新版。

### R25-2（P1）终态准入仍可吃到 hydrate 前的陈旧 developing 快照，并用裸写把终态改回 running

位置：

- `src/app/api/tasks/[id]/question/route.ts:109-128`
- `src/app/api/tasks/[id]/question/route.ts:381-409`
- `src/lib/server/task-fs.ts:1152-1171`
- `tests/ownership-r24-wave1.test.ts:447-504`

`/question` 先 `await getTask()`，再读 lifecycle，再抓 generation。`getTask()` 会先读 meta、后异步 hydrate events；它可以握着旧的 `developing` meta，在 hydrate 期间让 finalize 写完终态并释放 lifecycle，最后才把旧 task 返回。此时 route 看到 lifecycle 已是 `null`，抓到的还是 finalize 之后的新 generation，因此现有 stale 检查也不会拦住它。

one-shot 分支随后调用裸的 `setTaskRunStatus(task.id, "running")`。这个 helper 锁内只重读 meta 并改 runStatus，没有检查 `repoStatus` 是否已是 `merged/abandoned`，于是可以把最新终态任务重新写成 running，再拿陈旧 task 启动 one-shot agent。advance 路径也可能在最终 terminal-aware append 拒绝前，基于陈旧快照先产生 worktree/branch 副作用。

R24-5b 测试是在终态落盘后直接调用 terminal-aware 条件 helper，没有经过 route 的“meta 旧快照 → hydrate await → lifecycle 已释放”时序，也没有覆盖这里仍在使用的裸 setter。

建议在实际写入和启动副作用边界做锁内 terminal admission；one-shot 的 running 写至少应改为 terminal-aware 条件事务，不能依赖早先读到的 route task/lifecycle。

### R25-3（P1）caller token 只在 MCP 分派入口检查，已经入场的旧调用可在接管后继续做外部副作用

位置：

- `src/lib/server/chat-pending.ts:285-303`
- `src/lib/server/task-runner.ts:1573-1670`
- `src/lib/server/task-runner.ts:1865-1894`
- `tests/ownership-r24-wave2.test.ts:305-354`

`runTaskAction()` 只在进入 handler 前比较一次 caller token；`registerSessionBridges()` 的 handler 则明确假定“身份已在分派层核对”，后续不再检查。`submit_mr` 在入口之后还会 await host 解析、`getTask()`、校验，再调用不可逆的 `createMR()`。

可达时序：旧 A 的 token 在入口匹配并进入 handler → A 卡在 host/校验 await → B 注册新 token 接管 session → A 恢复并调用 `createMR()`，之后还会继续落 MR 状态/事件。新 token 只能拒绝尚未入场的 A，不能撤销已入场的 A。notifier 同理：caller 校验后，`ask_user_request` 会 await `supersedePendingAsks()`；B 可在 await 中接管，而 A 随后仍落 ask event 与 `awaiting_user`。

R24-6 新测试是先注册 B、再用 A 调分派，只覆盖“入口已经 stale”，没有覆盖“入口匹配、handler await 中换主”。需要把 caller lease/current 判定贯穿 bridge，在每个外部 await 之后、不可逆副作用（尤其 `createMR()`）之前复查，并让共享状态写也带锁内 caller 条件。

### R25-4（P2）SDK event / question done 只在 await 前检查 owner，接管仍可发生在 await 内

位置：

- `src/lib/server/sdk-message-handler.ts:87-109`
- `src/lib/server/sdk-message-handler.ts:113-231`
- `src/lib/server/task-runner.ts:3092-3113`
- `src/lib/server/task-runner.ts:3028-3037`
- `src/lib/server/task-runner.ts:3133-3141`
- `src/lib/server/task-runner.ts:3417-3425`
- `src/lib/server/task-runner.ts:3468-3485`
- `tests/ownership-r24-wave2.test.ts:356-437`

`handleSdkMessage()` 只在函数入口检查一次 `isTaskOpCurrent()`。thinking/tool 分支随后会 await `assistantCtx.flush()`、`getTask()` 或 tool-result 构建，再永久写事件；await 后没有 fresh owner check。stream 循环结束后还有一次不带 owner 的 `assistantCtx.flush()`。

questionRun 的多个分支同样先执行 `lostStartOwner()`，然后 await restore / `getTask()`，最后不复查就 publish task 级 `done`；catch 还会在 await 的错误事件与 restore 之后发布 `done`。A 可在入口通过后卡进这些 await，B 接管，再由 A 写入旧 event/done；前端收到旧 done 仍会清 B 正在显示的 streaming text。

R24-7 测试让 handle 在 `handleSdkMessage()` 入场前失效，或在 `run.wait()` 期间接管并命中较早的失主判断；没有把接管放到入口检查之后的 flush/getTask/event IO 内。应让 flush/event envelope 自带 operation identity，并在每次 await 后、写盘/发布前复查；UI reducer 也只能让当前 operation 的 envelope 改当前流状态。

### R25-5（P2）新增测试仍没有命中本轮剩余的四个线性化窗口

本轮定向测试与存量门禁均全绿，但以下关键时序仍未覆盖：

- R24-4 failpoint 在 guard 复查前，不在 `prepared.commit()` 的 rename 内。
- R24-5 只直测终态 helper，不经过 route 持有旧 meta、hydrate 后看到 lifecycle 已释放的路径。
- R24-6 先让 token stale 再 dispatch，没有让 caller 在 handler 入场后的外部 await 中失主。
- R24-7 让 handle 在 handler 入场前 stale，或在较早的 `run.wait()` 中接管，没有在 flush/getTask 之后、event/done 之前接管。

建议补四个真实 failpoint：commit rename 已发起未落盘、route 已取得旧 meta 未完成 hydrate、MCP handler 已入场未执行不可逆副作用、SDK/问题 run 已通过 owner 判断未写 event/done。所有 timeout race 都应断言业务 Promise 获胜，不能把 sleep/条件跳过当成功。

### 第二十五轮工程门禁

- 定向所有权测试：`ownership-r24-wave1`、`ownership-r24-wave2`、`ownership-r23-matrix`、`ownership-failpoint-matrix`，4 文件 / 41 项全部通过
- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：68 文件 / 696 项全部通过
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 第二十五轮验收结论

**不通过：3 个 P1 + 2 个 P2。** R24-1/2/3 的主修复成立，问题数量已明显收敛；剩余故障都集中在“判定通过后还有 await”的真实提交边界。门禁全绿说明既有行为没有回归，但当前新增测试仍停在边界之前，尚不能证明这些竞态已闭合。

---

## 第二十三轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认成立

- **S8 继续排除。** 本轮只审真实正确性问题，不评价侧栏分组、搜索、diff 面板、compact 参数或其它功能设计。
- `task-stream.ts` 的 V12 基础协议成立：owner claim 会覆盖前任，revoke 会改变 generation，owner release 按 `opId` 匹配，observer release 是 no-op。
- `claimSeq` 正确挡住了 null-opId ABA：observer 在任一 claim 发生后永久失效，不会因 owner release 把 `currentOpId` 清回 null 而复活。
- `handleRunFailure()` 的主路径已经统一复用 `isOpOwner(opHandle)`，R22-2/R22-3 点名的 stop 覆盖和 null 分类不对称在该函数内已修。
- R22-5 的 formal start 不再被迟到 one-shot record 直接按“幂等”吞掉；R22-6 也已做到只有条件写成功才落“Agent 已断开”事件。

### 阻塞项

#### R23-1（P1）claim 不是共享状态迁移的线性化点；stop 仍能被推进/唤醒的裸写反向覆盖

位置：

- `src/lib/server/task-runner.ts:828-936`
- `src/lib/server/task-runner.ts:943-983`
- `src/lib/server/task-runner.ts:1227-1250`

advance 在 claim 前已经做了 `refreshRepoBranches`、worktree/upsert/event，并会把入场快照中的
`awaiting_ack` action 用裸 `patchAction(...completed)` 自动认可；直到第 936 行才第一次检查旧
generation。stop 若在这段时间把 action 写成 `cancelled`，迟到 advance 仍可把它改成
`completed` 并落“已通过”事件，之后推进本身再以 stale 失败，终态无法按任何串行顺序解释。

claim 后也没有把“确认仍是 owner + 状态提交”做成一个条件事务：

- advance 在 `claimTaskOp()` 后经过一个 await，随后先删 `pendingStopRequests`，再裸
  `appendAction()`；stop 可以在 claim 与 append 间 revoke 并完成 idle，旧推进仍追加一条
  running action，直到更晚的 stale 检查才补取消。
- resume 在一次 stale 预检后分两段执行裸 `patchAction(status=running)` 和
  `setTaskRunStatus(running)`；stop 可插在两个 await 之间，先写 `cancelled + idle`，随后又被
  resume 的第二段写成 `runStatus=running`。即便后续检查有机会再纠正，stop 已返回后仍会出现
  持久化复活窗口，进程在窗口内退出则永久保留倒挂状态。

这里需要 claim 后的第一笔业务状态变化走同一把 task lock，并在 prepare/commit 里复查
`isOpOwner(handle)`；claim 前的 auto-approve 也必须纳入 admission/结构条件，不能用旧 task
快照裸 patch。

#### R23-2（P1）`abortIfTaskOpStale()` 的“补偿”会取消 stop 之后重新启动的同一个 action

位置：

- `src/lib/server/task-runner.ts:200-220`
- `src/lib/server/task-fs.ts:1173-1196`

helper 发现旧 `opGen` stale 后，无条件 `patchAction(actionId, cancelled)`，再用只比较
`currentActionId` 的 CAS 把 task 写 idle。可复现：A 卡在 await → stop revoke 并把 A 取消 →
用户用新 generation resume 同一个 action B、B 已写 `running` → A 恢复并进入 stale helper。
因为 actionId 没变，两道旧条件都会通过，A 会把 B 改回 `cancelled + idle`。

旧 operation 已失去 owner 时不能再主动“补偿”共享状态。至少应携带 A 的 handle 并走
`isOpOwner` 条件事务；stop 已负责的终态应直接让位。

#### R23-3（P1）observer 没有贯穿一次 send/run；旧 A 会在 await 后重新拍成 B 的 observer

位置：

- `src/lib/server/task-runner.ts:2808-2857`
- `src/lib/server/task-runner.ts:2929-2941`
- `src/lib/server/task-runner.ts:3080-3190`
- `src/lib/server/task-runner.ts:3515-3650`
- `src/lib/server/task-runner.ts:3723-3848`
- `src/app/api/tasks/[id]/ask-reply/route.ts:480-499`

`sendToTaskSessionBody()` 入场已经拿到 `entryOpHandle`，但 wait/drain/resume/send 之后只检查
generation；send 成功后又调用一次 `snapshotTaskOp()`，把新快照传给 consume。A 的 send
挂起期间 B 同 generation claim 时，A 会拍到 B 的 `claimSeq`，从此被当成“当前 observer”。
它可以覆盖 B 的 `runningTasks`，并在结束时恢复/收尾 B 的状态。

one-shot 更晚：直到 `Agent.create + send + runningTasks.set` 全部结束后才第一次 snapshot。
所以“Q one-shot send 挂起 → B advance claim/append → Q 放行”的真实链里，Q 会直接采用 B
的 observer；questionRun restore 可把 B 正在运行的 task 写回 idle。one-shot catch 还在失败时
才从全局 `runningTasks` 读取 `myOneShotId`，若表已换成 B，会精确拿到 B 的 instanceId 并用它
提交 Q 的 `prevRunStatus`。

consume 入口虽然计算出了 `!isOpOwner(handle)`，但随后只尝试 runner-instance 让位和
pending/lifecycle/gen 检查；同-generation claim 且 B 尚未登记 runner 时两者都可能 false，旧 A
仍继续注册并消费。取消/追问失败分支也仍把 `iOwnRunner` 当共享状态 owner，而不是 handle。

ask-reply 的 R22-6 测试只分别证明“route 结构条件”和“observer helper 协议”；route 实际没有
持有 observer，僵尸兜底 closure 仍只检查 `opGen + 无 session + awaiting_user`。B claim 后、写
running 前失败或暂停时，旧请求仍可写 error。

修复应让一次入口只创建一次 observer，并在每个 await 后验证同一个 handle；失效时 cancel/关
自己的资源并返回，绝不能重新 snapshot。runner/session instance 只做资源清理门禁，不能替代
共享状态 owner。

#### R23-4（P1）MCP bridge、SDK 流回调和 post-check 没绑定 operation，旧 agent 仍能写新 owner

位置：

- `src/lib/server/task-runner.ts:468-569`
- `src/lib/server/task-runner.ts:1496-1795`
- `src/lib/server/task-runner.ts:1899-1955`
- `src/lib/server/chat-pending.ts:239-290`
- `src/lib/server/sdk-message-handler.ts`

`registerSessionBridges(task)` 注册的是 task-scope 全局 callback，没有 handle/session instance。
旧 A 在 B claim 后迟到调用 `submit_work`、`ask_user`、`submit_mr`、`set_plan_batches`，仍会调用
当前 task 的 handler；B 覆盖注册后，旧 A 的 MCP 请求甚至会被转给 B 的闭包。

最直接的状态破坏在 `runActionPostCheck()`：`stillOwner` 只看 runningChecks controller/self，
最后一次检查后分别裸 `patchAction(A, awaiting_ack)`、`setTaskRunStatus(awaiting_user, A)`。
stop/advance 在第一个写的 I/O 窗口 abort 并提交后，第二个裸写仍可把 `cancelled + idle` 或 B 的
`running/currentActionId` 覆盖回 A。ask notifier 也在多段 await 后裸写 awaiting_user。

此外旧 stream 的每条 SDK message 没有 op 校验，artifact 写成功等路径仍可 patch action 元数据。
bridge 和流回调必须绑定 session/op 身份；post-check 的 action+runStatus 必须是一把带 owner 与
结构条件的事务，而不是两个裸写。

#### R23-5（P1）自动重连完全没有复查 `TaskOpHandle`，退避中的 A 会关闭/覆盖 B 的 session

位置：

- `src/lib/server/task-runner.ts:2298-2370`
- `src/lib/server/task-runner.ts:3360-3405`

`tryAutoReconnect()` 虽透传 `opHandle`，但退避、读 task、写事件、关闭会话、resume、send 的
过程中没有一次 `isOpOwner/isTaskOpCurrent` 检查。A 网络错误进入退避后，B advance 可以同
generation claim；在 B 真正 cancel A 之前，A 仍会用不带 expected instance 的
`closeTaskSession(taskId, undefined)` 关闭当前会话，再由 `resumeTaskSession()` 无 CAS 地覆盖
`agentSessions`，发送 reconnect prompt 并递归 consume。

重连每个外部 await 后都要验证同一 handle，并且 close/resume/register 必须带旧 session
instance 的 compare-and-set；失主只能关自己的本地对象。

#### R23-6（P1）stop 使用路由读取的旧 Task 快照，可能漏掉刚 append 的 action

位置：

- `src/app/api/tasks/[id]/stop/route.ts:27-34`
- `src/app/api/tasks/[id]/action-exclude/route.ts`
- `src/lib/server/stop-task.ts:90-150`

route 先 await `getTask()`，之后才进入 `stopTaskAgent()` 占 stopping/revoke；stop 内部却继续使用
传入快照的 `task.actions` 扫描非终态 action。若 B 在 route 快照后、stop 占 gate 前 append 新
action，而 stop 又发生在 B 通过最后一个 stale 检查后、正式 runner 注册前，stop 会 revoke B、
把 task 写 idle，却因为旧快照里没有 B 而漏掉它。B 在 admission 处发现失主后只让位，不再
finalize，于是永久留下 `action=running + task=idle + no runner`。

占 stopping/revoke 后必须在 gate 内重读最新 task，再以锁内最新 meta 收尾全部非终态 action；
route 的快照只能用于 404/展示，不能作为终态写的权威输入。

#### R23-7（P1）finalize 只 revoke、不占 lifecycle；终结期间新 advance 会拿到新 generation 合法启动

位置：

- `src/app/api/tasks/[id]/finalize/route.ts:58-72`
- `src/lib/server/task-runner.ts:1346-1390`
- `src/app/api/tasks/[id]/advance/route.ts:200-223`

`finalizeTask()` 只调用 `revokeTaskOps()`，没有像 stop/DELETE 一样占 stopping/deleting gate。
revoke 后的新 advance 会读到新的 generation，lifecycle 仍为 null，因此可以 claim、append action
并起 agent；finalize 随后又会扫 action、写 `repoStatus=merged/abandoned + runStatus=idle`，还可能
删除正在使用的 worktree。advance route 本身也没有拒绝终态 repoStatus。

finalize 必须占一个能被所有 start/send 入口识别的 terminal lifecycle，直到状态提交、session
关闭和 worktree 清理完成；同时 admission 要在锁内验证 repoStatus 仍为 developing。

#### R23-8（P2）reuse-send 路径泄漏 owner handle，且 afterClaim×stop 会留下幽灵 action 审计记录

位置：

- `src/lib/server/task-runner.ts:943-975`
- `src/lib/server/task-runner.ts:1060-1085`

advance claim 后若复用现有 session 且 send 成功，会直接 return；consume 拿的是后来 snapshot 的
observer，finally release 是 no-op，因此 advance 的 owner `currentOpId` 永久挂着，直到下次 claim
或 revoke。它暂时不一定破坏业务状态，但违反 I4“owner 要么属于活 operation、要么为 null”，会
让调试与后续 observer 语义继续复杂化。

另一个低一级但用户可见的问题是 `advance.afterClaim` 后 stop 已完成，旧推进仍可能 append 新
action，之后才被 stale helper 取消；用户点击停止后会多出一条从未真正启动的 action/start 事件。

### 测试覆盖评价

新增矩阵证明了 API helper 和若干点名窗口，但没有覆盖本轮真正漏出的跨入口组合：

- `advance.afterClaim × stop`、`resume.beforeStatusWrite × stop`；
- `send/Agent.resume resolve × same-generation claim`，并断言使用的是入场 observer；
- one-shot send 挂起期间 formal advance claim；
- post-check 在 `patchAction → setTaskRunStatus` 两段写之间 stop/advance；
- stop route `getTask → beginChatLifecycle` 之间 append action；
- reconnect backoff 期间 advance claim；
- finalize revoke 后并发 advance。

因此 665 项全绿不能证明“所有权已经收敛”。更关键的是，设计文档要求的唯一 coordinator 实际没有
落地：当前仍有 `opGen`、`iOwnRunner`、runningChecks identity、session instance、裸结构条件等多套
共享状态 owner。下一轮不宜继续给这些分支各补一条 if；应先让所有共享写（包括 bridge/post-check/
reconnect）必须携带同一 operation context，再用上述真实调用链矩阵做门禁。

---

## 第二十二轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 本轮仍只找 bug，不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- R21-1 的主时序有效：`resumeCurrentActionInner()` 已在关闭旧会话和写 `running` 之前 claim，并把 token 传给 `internalStartAgent()`；新增真实双 resume 用例确实证明 A 卡在 `Agent.create()`、B 接管后 A 不再 send。
- R21-2 的 prepare 窗口有效：start token 已合并进条件 helper 的 `isOwner`，B 在 `prepareMetaWrite()` 期间 claim 会 abort tmp，不提交共享 action/task error。
- R21-3 在“后继 claimant 最终成功完成过锁写”的前提下成立：claim 落在旧 owner 的 rename await 内，后继写会排在同一 task lock 后覆盖旧提交。
- R21-4 的 task 状态覆盖已挡住：ask 僵尸兜底只有盘上仍为 `awaiting_user` 才能提交 `error`。
- R21-5 的不同 action 时序已挡住：consume 入场绑定 A、全局最新 action 已是 B 时会立即让位，不再拿 B 追问/交卷。

### 阻塞项

#### R22-1（P1）start token 没覆盖 handoff 前的异常；新 owner 失败会留下永久 running action / token

位置：

- `src/lib/server/task-runner.ts:863-884, 868-1032`
- `src/lib/server/task-runner.ts:1102-1139, 1142-1225`
- `src/lib/server/task-runner.ts:1718-1794, 2123-2129`
- `src/app/api/tasks/[id]/question/route.ts:347-370`
- `src/app/api/tasks/[id]/advance/route.ts:252-292`

advance 在 append 前、resume 在关闭旧 owner 前 claim；但 token 的 release / `handleRunFailure()` 只存在于 `internalStartAgent()` 已经移交给 fire-and-forget IIFE 之后。两条调用链在 claim 后、IIFE handoff 前仍有大量可抛 await：`appendAction`、baseline/read-only baseline、事件、worktree/branch、`supersedePendingAsks`，以及 `internalStartAgent` 外层的 `ensureWorkspaceReady`、host/MCP 解析、启动事件等。

任一处抛错时：

1. advance 已 append 的 action 和 resume 已 patch 的共用 action 仍是 `running`；
2. 没有 `runningTasks` / 活 agent 来归位；
3. 已 claim 的 token 无人 release；
4. `/advance` 只回 400，`/question` 的 fire-and-forget catch 只追加错误事件，都不收尾 action/task。

更坏的同 action 时序是：B claim 后在 `supersedePendingAsks` / workspace 准备失败，旧 A 因 token 已失主而正确跳过失败收尾，但 B 自己也不收尾，最终就是“盘上 running、实际无 owner”。“claim 后必有过锁写”也只覆盖成功走到对应写的路径，异常路径没有 commit/abort 语义。

需要把 token 生命周期从 claim 起包在统一 try/catch/finally：未 handoff 的 owner 失败要按 token/op generation 条件收尾自己的 action/task并匹配 release；已被更晚 owner 覆盖则只清本地资源。补两条 deferred：resume 在 claim 后、首次状态写前抛；advance append 后、`internalStartAgent` handoff 前抛，均不得遗留 running/token。

#### R22-2（P1）失败事务的 owner 不包含 stop generation；用户“停止”仍可能被迟到 error 覆盖

位置：

- `src/lib/server/task-runner.ts:2072-2118`
- `src/lib/server/task-runner.ts:2264-2350`
- `src/lib/server/task-runner.ts:3118-3152`
- `src/lib/server/stop-task.ts:96-149`

`handleRunFailure()` 的复合 owner 只有 `runningTasks.instanceId`（若传）和 start token，没有入场 `opGen` / 当前 lifecycle / cancelled 状态。stop 会先 bump generation，再把 action 标 `cancelled`、task 标 `idle`；但 `runningTasks` 记录要到旧 consume 的 finally 才删除，start token 也不会因 stop 自动换号，所以在 stop 收尾期间 `iOwnRunner()` 与 `stillStartOwner()` 仍可同时为 true。

可复现顺序：A 的 SDK 错误已选择 give-up → 进入 `handleRunFailure` 并卡在 read/prepare → 用户 stop 完成 `cancelled + idle` → 放行 A。helper 的 expected 只验 `currentActionId`，stop 没清这个指针，于是 A 又把同一 action/task 提交为 `error`。启动 catch 也只传 `startToken`、不传 `opGen`，存在同构窗口。

失败收尾必须同时验证“本 operation generation 仍新鲜、lifecycle 未被 stop/delete 接管”，且该条件要进入 task-lock 内的两次 owner 检查；不能只靠 runner record/token。补真实 stop deferred：stop 在 failure helper prepare 期间完成，放行后最终必须保持 `cancelled + idle`、不得发 task 级失败。

#### R22-3（P1）R21-2 的 owner 重验不对称：null fallback 和最终 envelope 都漏了 run owner

位置：

- `src/lib/server/task-runner.ts:2305-2337`
- `src/lib/server/task-runner.ts:2360-2370`
- `tests/task-op-generation-v1-v2.test.ts:1427-1493`

helper 使用的是复合 `isOwner = opts.isOwner && stillStartOwner`，但 helper 返回 null 后，`sharedWithSuccessor` 只检查 `!stillStartOwner()`。如果丢的是 run owner、start token 仍有效，代码仍会 `finalizeOwnAction(..., "error")`；这可把 stop 已写的 cancelled 改成 error，也会伤到未换 start token 的同 action 后继。

发布处也只做了一半：第 2363 行在 `getTask()` 前检查了 token + run owner；但 `getTask()` await 返回后第 2368 行只重验 token，期间 `runningTasks` 若被 force-clear/换主，旧 A 仍会发全局 `done(ok=false)` / `error`，清后继流文本并弹失败 toast。

null 分类和每个全局 envelope 的最后一步都必须重用同一个复合 owner（并包含 R22-2 的 generation/lifecycle），不能分别手写 token 子集。现有 deferred 测试只让 start token 在 prepare 内变化，没有覆盖“仅 run owner 变化”和“最终 getTask await 内变化”。

#### R22-4（P1）R21-5 只识别“不同 action”后继；同 action resume 接管时旧 consume 仍会追问/标错

位置：

- `src/lib/server/task-runner.ts:2773-2813`
- `src/lib/server/task-runner.ts:2838-2876`
- `src/lib/server/task-runner.ts:2882-3044`
- `tests/task-op-generation-v1-v2.test.ts:1578-1659`

自然完成的让位条件是 `globalLastAction.id !== opts.errorActionId`。resume 的核心语义恰好是复用同一个 actionId：B 已 claim 新 start token、取消 A 并等 A 清表时，全局最新 action 仍等于 A 的 `errorActionId`，所以 R21-5 分支不会触发；后面的自然完成逻辑也完全不检查 `opts.startToken`。

有一个不依赖 SDK 忽略 cancel 的窗口：A 已在第 2775 行读过 `cancelled === false` 且拿到 `finished`，随后 B（例如显式换模型唤醒）claim/cancel。A 再到第 2838 行读盘时 actionId 仍相同，会继续用旧 session 发 submit_work 追问；追问失败/耗尽还会把共享 action/task 标 error 并发全局失败，B 则在 `waitForTaskToStop` 中被旧追问拖住。

自然完成后的所有业务收尾也要验证 start/run owner；同 action 后继不能靠 actionId 区分。补测试应是同一个 `act_shared`：A 通过 cancelled 分支判断后暂停 → B claim → 放行 A，断言 A 不再 send/finalize/publish，B 状态保持。

#### R22-5（P1）`internalStartAgent` 的早退 guard 会吞掉 activeRun 快照之后才登记的 one-shot，正式 action 永不启动

位置：

- `src/lib/server/task-runner.ts:952-1032`
- `src/lib/server/task-runner.ts:1743-1759`
- `src/lib/server/task-runner.ts:1815-1857`
- `src/lib/server/task-runner.ts:2384-2403`
- `tests/task-op-generation-v1-v2.test.ts:416-455`

advance 只在第 955 行 snapshot 一次 `activeRun`。若 one-shot 当时尚未完成 send/预登记，advance 会继续；one-shot 随后在 `internalStartAgent` 做 workspace/MCP 前置 await 期间登记 `runningTasks`，第 1754 行 guard 便直接 `return`。这样真正用于接管前驱的串行段 `predecessor.cancel()`（1837～1857）根本进不到。

结果是新 action 已 append 并标 running、formal agent 却完全没启动；one-shot 自然结束后仍是 runner owner，会按“最新 action 的普通 running 状态”把 task 恢复成 idle，形成 `action=running / task=idle / no formal agent`。当前 X2 测试只证明一个裸 `runWithTaskSendSerial` 回调会排队，没有走 `advanceTask → internalStartAgent`，所以没有覆盖这道早退 guard。

这里应把迟到出现的 record 交给串行段的 predecessor handoff，而不是在串行段外按“幂等”吞掉正式启动。补真实链：advance 读取 `activeRun=undefined` 后暂停 → one-shot 预登记 → 放行 formal start，最终只允许 formal owner 存活且新 action 保持 running。

#### R22-6（P2）ask 僵尸 CAS 拒绝状态写之前，已经落了永久“Agent 已断开”错误事件

位置：

- `src/app/api/tasks/[id]/ask-reply/route.ts:463-519`
- `tests/task-op-generation-v1-v2.test.ts:1542-1576`

`expectedRunStatus="awaiting_user"` 只保护第 498 行的 task 状态写；错误事件却在第 482～491 行先 append/publish。并发 B 已把任务拉成 running 时 helper 会正确返 null，但事件流仍永久出现“Agent 已断开”，本请求也继续回 410。新增测试只直测 helper，没有经过 route，因此看不到这条假错误。

应先完成锁内条件判定/状态提交，再由成功结果决定是否写 disconnect 事件和返回 410；若条件拒绝，应按“已被后继接管/本问答失效”返回，不留下断开事件。

### 第二十二轮工程门禁（Codex 复审）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- 定向：3 文件 / 37 项通过
- `pnpm test`：62 文件 / 645 项通过
- `pnpm build`：生产构建通过
- `git diff --check`：通过

门禁全绿只说明现有测试通过；上述 6 条均是现有测试未覆盖的并发/异常分支，不能据此放行。

---

## 第二十一轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- R20-2 可以关闭：`ask-reply` send 成功后的重复 `running` 刷新已直接删除，响应改为现读 task，快速结束的 run 不会再被路由复活。
- R20-3 的第一层问题已修：prepare 只写 tmp，owner 在 prepare await 内变化时会 abort；新增测试确实在中途调用 `getTask()` 并证明正式 `meta.json` 仍是旧值。
- R20-1/R20-4 的“调用 `handleRunFailure` 前 B 已经 claim”用例有效：旧 A 只写 action-scoped event，不 patch 共用 action/task，也不发全局 `done/error`。但 claim 时点和函数内 TOCTOU 仍有下面 R21-1～R21-3。

### 阻塞项

#### R21-1（P1）start token 在接管副作用之后才 claim；真实同 action 双唤醒仍会被旧 A 标成 error

位置：

- `src/lib/server/task-runner.ts:1071-1114, 1117-1134, 1191-1210`
- `src/lib/server/task-runner.ts:1771-1806, 1929-1964, 1989-2036`
- `tests/task-op-generation-v1-v2.test.ts:1028-1089`

B 的同 action 唤醒进入 `resumeCurrentActionInner()` 后，会先取消/等待旧 run、关闭旧 session、把共用 action 和 task 写成 `running`、写事件并做 worktree/分支等多段 await；直到 `internalStartAgent` 的 fire-and-forget IIFE 进入 send serial 回调，才在第 1805 行 claim start token。

因此存在一段很长的“B 已经接管并改状态，但 start owner 仍是 A”的窗口。尤其 B 第 1104 行关闭 A session 本身就可能让 A 正在进行的 send reject；A catch 此时检查 token 仍会认为自己是 owner，随后把 B 共用的 action/task 写成 `error`。B 后续 claim、注册 `runningTasks` 时不会再重写 task `running`，最终仍是“B agent 在跑、盘上 error”。

新增测试手工执行 `claim(tokenA) → claim(tokenB) → handleRunFailure(A)`，跳过了真实链里 claim 之前的全部副作用，无法覆盖此 bug。token 必须在 B 开始关闭会话/写 running 之前取得，并贯穿后续 internal start，而不是在 create/send 串行段才临时领取。

#### R21-2（P1）`handleRunFailure` 只在入口检查一次 start token；函数内部换主仍会提交状态和全局失败

位置：

- `src/lib/server/task-runner.ts:2204-2266`
- `src/lib/server/task-fs.ts:1254-1319`
- `tests/task-op-generation-v1-v2.test.ts:1028-1089`

即使把 claim 前移，`handleRunFailure()` 也只在任何 await 之前计算一次 `lostStartOwner`。通过后，传给 `patchActionAndRunStatusIfOpFresh()` 的 `isOwner` 只有 `opts.isOwner ?? true`，没有合并 `isTaskStartOwner(startToken)`；B 若在 read/prepare await 中 claim，A 仍会提交同 action/task error。

若条件 helper 因其它 owner 条件返 null，第 2235 行又会无条件 `finalizeOwnAction(errorActionId, "error")`；同 action B 仍会被伤。即便状态写时 A 尚有 owner，后面的 event/getTask await 中 B 也可能接管，但 `wroteTaskLevel` 不会重新验证，A 仍会发布全局 `done(false)` / `error`，所以 R20-4 只修了“入口前已失主”的一支。

需要把 start token 合并进每次条件事务的 owner closure；helper 返回后及发布 task 级 envelope 前再次验证。owner 变化导致 null 时，不能再用共享 actionId 做 unconditional finalize。测试应在 helper prepare 挂起期间 claim B，而不是调用函数前先 claim。

#### R21-3（P1）prepare 后的 owner 复查仍早于真正 rename；commit await 内换主会把新 owner 状态盖回去

位置：

- `src/lib/server/task-fs-core.ts:349-383`
- `src/lib/server/task-fs.ts:1304-1319, 1356-1364`
- `src/lib/server/task-runner.ts:1117-1126, 1191-1210, 1803-1806`
- `tests/task-op-generation-v1-v2.test.ts:1091-1220`

代码注释称“同步复查到发起 commit 之间无 await”，但真正的提交点是 `commit()` 内部 `await renameWithRetry()` 完成的 rename。调用 `commit()` 只同步把 `settled=true`，随后立即让出事件循环；Windows 的 rename 还可能退避重试。owner 完全可以在复查通过后、原子 rename 发生前变化。

当前同 action B 更直接违反“B 接管后必写自己的状态”这一前提：B 在第 1125 行先写 `running`，之后才到第 1805 行 claim。若 B claim 落在 A 的 commit await 内，A 的 rename 随后把 error/idle 覆盖到正式 meta；B claim 后没有任何 task 状态写排在 A 后面纠正它。

现有测试只卡 prepare，放行后让 owner 复查失败并 abort，没有卡住 `prepared.commit()`。应补 deferred commit 测试：A 复查成功并进入 commit → B claim → 放行 rename，断言 B 状态不被 A 提交。根治要么让 owner 变更也走同一锁/持久化 version CAS，要么强制每个 claimant 在 claim 之后通过同一 task lock 写自己的状态。

#### R21-4（P1）ask 僵尸兜底没有结构条件，会把已经写成 running 的后继改成 error

位置：

- `src/app/api/tasks/[id]/ask-reply/route.ts:434-515`
- `src/lib/server/task-runner.ts:1071-1134`
- `src/lib/server/task-fs.ts:1338-1364`

僵尸分支入场时只检查一次 `fresh.runStatus === "awaiting_user"`。随后存图、wake、supersede、append error event 都是 await；并发输入条唤醒 B 可以在此期间把 action/task 写成 `running`，但尚未走到 Agent.create，所以 `agentSessions.has(taskId)` 仍为 false，opGen 也没有变化。

第 495 行的 owner closure 只验证“generation 未 stale + 当前无 session”，helper 读到盘上已经是 B 的 `running` 也照样覆盖成 `error`。B 后续注册 session/run 不会再写 task 状态，最终 agent 正在跑而页面报断开。

这里需要把“盘上 runStatus 仍是本请求看到的 awaiting_user”加入同一 prepare/commit 条件，并绑定本次 ask operation；只检查 session 是否已注册挡不住 create 前窗口。现有测试没有覆盖 ask-reply route 的僵尸兜底并发唤醒。

#### R21-5（P1）旧 run 的交卷追问取全局 `lastAction`，会向 A agent 下发并收尾后继 B

位置：

- `src/lib/server/task-runner.ts:856-879, 943-1014`
- `src/lib/server/task-runner.ts:2728-2903`

advance B 会先 append 新 action（立刻成为全局最后一条、状态 running），之后才经过分支/提示准备并在第 1002 行附近取消 active run A。A 若在这个窗口自然 finished，第 2734 行重读 task 后把全局 `actions.at(-1)`——即 B——当成自己的 `lastAction`。

随后 A 会用自己的旧 session 给 agent 发送“请为 B 调 submit_work”的追问，计数也记在 B 上；若追问失败/耗尽，还会直接 `patchAction(B, error)`、写 task error、发布 done 并关闭会话。`sessionAlive` 只证明 session 属于 A，并不能证明 `lastAction` 属于 A。最坏情况下 A agent 可提前对 B 调 submit_work、污染 B 的 artifact/状态，而 B agent 随后仍会启动。

consume 的业务 action 必须以入场绑定的 `opts.errorActionId` 为准，读取最新 task 时也只能定位这一条；若全局最新 action 已不同，应立即让位，不能追问或收尾后继。现有测试没有覆盖“B 已 append、尚未 cancel A、A 自然 finished”的真实调用链。

### 第二十一轮验收结论

**不通过。** R20-2 可以关闭，prepare 隐藏 tmp 和“入口前已失主”两条局部修复也成立；但 start token 尚未覆盖完整 operation 生命周期，失败收尾和 commit 点仍有换主窗口。加上 ask 僵尸覆盖与 consume 误绑后继 action，当前仍可能形成“新 agent 正在跑、action/task 却被旧操作写成 error”或让旧 agent 处理新 action。下一轮需要真实跨入口 deferred 测试，不能再用预先摆好 token/meta 的 helper 直测代替完整时序。

---

## 第二十轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- R19-1 的入口结构门禁有效：`currentActionId` 已变化或 action 已不再 `awaiting_ack` 时，旧 question 不会写回；新增测试确实覆盖了 `isFresh=true` 的两种结构冲突。
- R19-2 对“旧 A / 后继 B 是不同 action”的持久化覆盖已修：`currentActionId=B` 时只精确收尾 A，不再把 task 指回 A。
- R19-4 的三处实例身份修复有效：启动 catch 不再把 `undefined` 退化成 current-session close；consume 按 agent 对象捕获 session instance；带 expected instance 但内存 session 不存在时不再清持久化锚点。
- 现有 R19-3 测试能证明 owner 在首个 `writeMeta` await 内变化时，helper 最终会执行回滚；但该协议仍有下面 R20-3 的隔离性缺口。

### 阻塞项

#### R20-1（P1）启动失败仍以 actionId 充当 operation owner；同 action 的后继会被旧启动标成 error

位置：

- `src/lib/server/task-runner.ts:1068-1075, 1114-1123, 1188-1207`
- `src/lib/server/task-runner.ts:1768-1771, 1996-2014`
- `src/lib/server/task-runner.ts:2158-2189`
- `tests/task-op-generation-v1-v2.test.ts:980-1021`

`resumeCurrentActionWithMessage()` 的语义就是原地复用同一个 action；它只把外层准备过程放进 `runAdvanceExclusive`，而 `internalStartAgent()` 把真正的 create/send 移交给 fire-and-forget IIFE 后即释放互斥。两个并发输入条唤醒可以因此先后启动 A/B，二者的 `opGen`、`currentActionId` 和 `errorActionId` 全部相同。

若旧 A 的 create/send 在 B 接管后失败，catch 调用 `handleRunFailure(taskId, sameActionId, err)` 时没有 start/run instance owner。新门禁只检查 `currentActionId === errorActionId`，对同 action 的 B 仍为真，于是把 B 共用的 action 和 task 都写成 `error`；即使以后给该调用传 `isOwner`，失败 fallback 的 `finalizeOwnAction(sameActionId, "error")` 仍会伤到 B，因为 actionId 不是 operation 身份。

现有 R19-2 测试只构造了 `act_a` / `act_b` 两个不同 action，正好绕开了该路径。需要为每次 start 分配独立 token，并让失败收尾同时校验 start token；补真实“同 action 双唤醒、A send deferred reject、B 已接管”的测试。

#### R20-2（P1）`ask-reply` 的迟到“幂等刷新”会把已经结束的 run 重新写成永久 running

位置：

- `src/app/api/tasks/[id]/ask-reply/route.ts:537-622`
- `src/lib/server/task-runner.ts:3328-3347, 3477-3489`
- `src/lib/server/task-runner.ts:2848-2892, 2950-2954`

`deliverAskReply()` 在 send 受理后 fire-and-forget 消费 run，并立即返回 `sent`。路由随后还要清 pending、append/publish 回答事件；若这轮 run 很快结束，consume/notifier 可以在这些 await 中先把 task 切回 `awaiting_user` / `idle` 并删除 `runningTasks`。

路由第 617 行仍会调用 `setTaskRunStatusIfRunOwner(..., "running", () => !isTaskOpStale(opGen))`。普通 run 完成不会 bump cancellation generation，所以这个所谓 owner 闭包仍返回 true，继而把已正确结束的 task 再写成 `running`；此后没有活 run 会替它归位，页面会永久显示运行中。chat 分支也共用这段迟到刷新。

这不是幂等写：门禁至少要绑定本次 send 产生的 run/session instance，或者直接删除这份重复刷新、以 deliver/consume 内部的 owner 写为准。现有测试没有覆盖 ask-reply route 的“send 成功后、事件落盘期间 run 快速结束”交错。

#### R20-3（P1）“先写脏值、发现换主再回滚”对无锁读者可见，仍不构成条件事务

位置：

- `src/lib/server/task-fs.ts:1252-1320, 1337-1368`
- `src/lib/server/task-fs-core.ts:289-303, 330-336, 632-635`
- `tests/task-op-generation-v1-v2.test.ts:1024-1155`

两个 helper 都先把新值原子 rename 到 `meta.json`，写完才复查 owner；失败时再发起第二次 `writeMeta(rollback)`。`withTaskLock` 只串行写者，`getTask()` / `listTasks()` / route 入场读都不取这把锁。因此从第一次 rename 完成到第二次 rollback rename 完成之间，任何读者都能读到本应被拒绝的 action/runStatus/currentActionId，并据此返回错误状态或启动后续操作。最终文件回滚成功不能撤销这些已经发生的外部副作用。

此外最后一次 owner 复查后还会 `await hydrateTask()` 读取事件；owner 可在该 await 内换主，而 helper 不再检查。现有测试只在 helper 完全 resolve 后断言最终文件，既没有在两次写之间读 `getTask()`，也没有覆盖最后复查到返回之间的换主。

修复不能依赖“写后补偿”伪装 CAS：要么让 owner/version 成为持久化 meta 的 compare-and-set 条件并只提交一次，要么让所有会据此做决策的读者加入同一事务/版本协议。至少补一条 deferred rollback 测试：卡住第二次写，在中间调用 `getTask()`，断言拒绝值从未对外可见。

#### R20-4（P2）旧启动已失去 task owner 时仍向整个 SSE 流发布 `done(false)` 和 `error`

位置：

- `src/lib/server/task-runner.ts:2176-2206`
- `src/app/tasks/[id]/page.tsx:345-350`
- `tests/task-op-generation-v1-v2.test.ts:980-1021`

R19-2 的不同 action 用例中，条件写返 null 后确实只持久化 A 的 action error；但 `handleRunFailure()` 随后无条件读取当前 task，并发布 task 级 `done(ok=false)` 和 `error` envelope。若 B 已在运行，页面会把 B 的 `streamingText` 清空并弹出整任务失败 toast；报告所说“事件挂自己的 actionId、无害”只适用于落盘 event，不适用于这两个无 action owner 的全局 envelope。

旧 operation 已失去 task owner 时，应只发布绑定 A 的普通 event；task 级 `done/error` 必须同样由 start/run token 门控。现有测试只断言 meta，没有订阅 SSE，因此未发现该误报。

### 第二十轮验收结论

**不通过。** R19-1、R19-4 可以关闭，R19-2 的“不同 action”分支也已修；但同 action 重启仍证明 actionId/generation 不能替代 operation owner，`ask-reply` 和写后回滚又各留下一条可把状态永久写错或让脏状态外泄的路径。下一轮应优先引入贯穿 start/send/consume/failure 的实例 token，并用真实跨入口 deferred 测试覆盖同 action 双唤醒和 ask-reply 快速结束。

---

## 第十九轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- R18-1 的 ack 两段写已合成一次 `withTaskLock` 写盘；stop bump 后且 helper 尚未入锁的请求不会再写。
- R18-2 的旧 cancelled/error 全表扫已从 consume 路径移除；前驱绑定 action A 时不会再直接把另一个 action B 一并取消，`forkPendingTasks` 也已提前到 cancel 之前。
- R18-3 的 `AgentSessionRecord.instanceId` 和常规 `yieldIfSuperseded/closeMySession` 门控有效；现有同 agentId、不同 session instance 的测试路径可通过。
- X4 继续保持关闭；本轮全量 630 项无 unhandled rejection。

### 阻塞项

#### R19-1（P1）`opFresh` 仍只是取消 epoch；并发 advance 可让旧 question 抢回已完成的 action

位置：

- `src/app/api/tasks/[id]/question/route.ts:318-338`
- `src/lib/server/task-fs.ts:1208-1247`
- `src/lib/server/task-runner.ts:772-830`
- `tests/task-op-generation-v1-v2.test.ts:579-609`

`patchActionAndRunStatusIfOpFresh()` 锁内只调用 `isFresh()`；路由传入的是 `!isTaskOpStale(taskId, opGen)`。但 generation 只在 stop/DELETE/finalize 时 bump，普通 advance 不 bump，所以同 epoch 的后继不是 stale。helper 也不验证 `meta.currentActionId` 仍等于 ack action、该 action 仍为 `awaiting_ack`。

可复现时序：Q 向正在审阅的 action A 发送意见并成功开启 run → 并发 advance 自动通过 A、追加 action B（`currentActionId=B`）→ Q 卡在 supersede/event await 后进入 helper；generation 未变，锁内 `isFresh()` 返回 true → helper 把已 completed 的 A 重新改成 running，并把 `currentActionId` 从 B 抢回 A。B 的 Agent 可以继续跑，但 task 指针和状态已指向旧 A。

新增测试只验证 `isFresh=false` 时不写，未覆盖 `isFresh=true + currentActionId 已变/action 已 completed`。修复至少要把 expected current action/status 一并放进锁内条件；根治仍需每次操作独立 owner，而不是复用 cancellation epoch。

#### R19-2（P1）首个启动 `create/send` 失败时，旧启动链仍会无条件把后继 B 写成 error

位置：

- `src/lib/server/task-runner.ts:668-676, 809-830`
- `src/lib/server/task-runner.ts:1756-1785, 1909-1944`
- `src/lib/server/task-runner.ts:1964-1999`
- `src/lib/server/task-runner.ts:2132-2171`

`internalStartAgent()` 仍是 fire-and-forget，第一条 advance A 已释放 `runAdvanceExclusive` 后，第二条 advance 可以追加 B 并把启动回调排到同一 send serial 后面。若 A 的 `Agent.create/send` 抛错，serial 会先放行 B；A 的外层 catch 随后调用 `handleRunFailure(taskId, actionA, err)`，这里没有 run/start instance owner，最终走裸 `setTaskRunStatus("error", actionA)`。

即使精确 action 收尾只把 A 标 error，task 级写仍会把已经追加的 B 的 `currentActionId/runStatus` 覆盖为 A/error。随后 B 正常注册运行也不会重新落一次 task running，最终形成“B Agent 在跑、页面指向失败的 A”。这条路径与 cancelled 测试不同，现有 R18-2 用例只覆盖 consume 已登记后的普通 cancel，没有覆盖 `create/send` rejection + 第二条真实 advance。

启动 intent 必须在 create 前就有实例 owner；失败收尾只允许在该 start owner 仍有效且 current action 仍为 A 时写 task error。应补真实双 advance 测试：A send deferred 后 reject、B 已追加并排队，断言 B/current/runStatus 不被 A catch 覆盖。

#### R19-3（P1）所谓“锁内 run-owner 条件写”仍有 TOCTOU：owner Map 不受 task lock 保护

位置：

- `src/lib/server/task-fs-core.ts:273-303`
- `src/lib/server/task-fs.ts:1260-1277`
- `src/lib/server/task-runner.ts:2426-2431, 2582-2594, 2810-2838, 2878-2889`
- `tests/task-op-generation-v1-v2.test.ts:841-889`

`setTaskRunStatusIfRunOwner()` 在进入 `withTaskLock` 后只同步检查一次 `isOwner()`，之后仍会 await `readMetaV06()` 和 `writeMeta()`。但 `runningTasks.set/delete/forceClear` 完全不走 `withTaskLock`，因此“owner 校验”和“owner 换主”并不处于同一临界区。

时序仍可发生：旧 A 在 helper 内检查 instanceId 成功 → 卡在 Windows 文件读取/原子写 → 5 秒强清后 B 注册新的 `runningTasks`（B 的 send/resume 不一定再写 task meta）→ A 继续把 idle/error 写盘。B 已是唯一 run owner，但页面状态被旧 A 迟到覆盖。

报告声称新增了“A 卡在 helper 内部 await → B 接管”的测试，实际测试先把 B record 放好，再调用 helper，覆盖的只是“入口检查已失败”，没有制造“检查成功后才换主”。单纯把检查搬进文件锁不够：要么 owner 变更也走同一把锁，要么将 owner token 纳入持久化 compare-and-set/版本事务。

#### R19-4（P1）部分 session close 在拿不到实例号时退化为 agentId-only，仍可误关同 agentId 的 B

位置：

- `src/lib/server/task-runner.ts:282-315`
- `src/lib/server/task-runner.ts:1964-1993`
- `src/lib/server/task-runner.ts:2412-2437`

启动失败 catch 先读取当前 `failedSess`，只有 `failedSess.agent === failedAgent` 才传 instanceId；若会话已被 B 替换，它反而传 `undefined` 给 `closeTaskSession()`。该函数把 `expectedSessionInstanceId: undefined` 解释成“不校验实例”，只要 Agent.resume 后的 B 与 A 共享 agentId，就会删除并关闭 B。正确语义应是“发现当前 session 不是 failedAgent 就只关本地 A、绝不调用 current-session close”，而不是关闭实例门禁。

同类边界还包括 `consumeSessionRun` 入场时按 agentId 而非 agent 对象捕获 `sessionAtStart.instanceId`，以及 `closeTaskSession` 在内存 session 不存在时即使调用方传了 expected instance 仍会清持久化 `sessionAgentId`。这说明 instanceId 尚未形成 fail-closed 契约：异步旧 owner 拿不到精确实例号时必须 no-op/只关本地对象，不能退回 agentId 或清当前锚点。

现有同 agentId 测试只覆盖 A 已提前捕获自己 sessionId 的 `yieldIfSuperseded` 路径，没有覆盖 catch 时当前 session 已是 B、expected id 变成 undefined 的路径。

### 第十九轮验收结论

**不通过。** R18-2 的全表误取消和常规 same-agent session close 已有实质修复，但 cancellation generation、start intent、run owner 和 session owner 仍是四套不完全相交的身份。先补 R19-1～R19-4 的真实交错测试并把所有状态/关闭操作改成 fail-closed owner 条件，再做下一轮验收。

---

## 第十九轮修复报告（Fable5、2026-07-18 午后、待复审）

按第十八轮意见修复 R18-1～R18-3，统一根因收敛为「owner 校验搬进 withTaskLock 锁内、与写盘同一临界区」（内存 owner 状态锁内同步可读、不再依赖 await 前后的点检查）：

### R18-1（/question 状态写非 owner 事务）

- `task-fs.ts` 新增两个锁内条件事务 helper：`patchActionAndRunStatusIfOpFresh(taskId, actionId, actionStatus, runStatus, isFresh)`（锁内先同步调 `isFresh()` 闭包再一把写 action.status + runStatus；闭包注入避免 task-fs 反向依赖 runner 层）、`setTaskRunStatusIfRunOwner(taskId, runStatus, isOwner)`。
- `/question` 的 `sent && ackContext` 分支：原「patchAction → setTaskRunStatus」两段无条件写替换为一次条件事务；锁内发现 stale（stop 已接管）→ 不写。「stop 后又被写回 running」闭合。
- one-shot stale 回滚锚点从 `currentActionId` 换成 **runningTasks instanceId**（同 action 两次运行可区分）：旧 Q 的 instanceId 已被顶掉 → 锁内验证失败 → 不写 B 的状态。

### R18-2（接管时前驱取消后继 action）

- 前驱收尾**只碰自己的 action**：consume / 启动链的 cancelled/error 收尾从 `finalizeStaleActions` 全表扫改为精确 patch 自己绑定的 actionId（one-shot 无 action 则不碰）。全表扫语义仅保留给真正的 task owner：`finalizeTask`（abandon/merge）与 `advanceTaskInner` force-new（带 `exceptActionId` 排除后继——该处曾靠全表扫清「单 Run 多 action」残留、不能砍）。
- 串行链接管路径：`forkPendingTasks.add` **先于** `predecessor.cancel()`（对齐 force-new 既有 fork 协议、前驱见标记走让位收尾）。
- `restoreRunStatusAfterQuestion` 改锁内 owner 条件写。

### R18-3（instanceId 未贯穿 session 与状态事务）

- `AgentSessionRecord` 增 `instanceId`（与 run record 共用进程级发号器、task-stream global key 升 V10）；`closeTaskSession` 增 `expectedSessionInstanceId` 参数——「关自己」的调用点（consume 收尾 / yieldIfSuperseded / send 失败 / 启动窗停止 / 空闲 sweeper 等 7 处）全部换成按 session instanceId 精确门控。**resume 同持久化 agentId 的新内存实例不再会被旧 A 误关**（新增同 agentId 用例钉扎——旧测试用 agent_a/agent_b 绕开了该分支）。
- 收尾 helper 内部 await 的 owner 漂移：全表扫改精确 patch 后，剩余共享状态写全部走锁内 owner 条件事务（`setTaskAwaitingIfIdle` 本就是锁内 CAS、保留）。
- 补测试：A 卡在收尾 helper 内部 await → forceClear + B（同 agentId resume）接管 → 放行 A → B 的 action/runStatus/session 全部不变。

### 第十九轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、630 项全部通过（较十八轮 +5 项）、连跑两遍 0 unhandled error
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- `/question` route 级 deferred 测试与 advance→internalStartAgent 双启动真链测试仍未补（mock 面过大）；同构契约在 helper / consume 层有直接钉扎。
- `cancelTaskRun` / force-new 仍可无 instanceId 关「当前会话」——有意保留：调用方语义就是用户/后继 owner 主动关当前。

---

## 第十八轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- X1 的返回值分流有效：task session send 已能区分 `sent / stale / no_session / send_failed`，advance 和两个消息路由不会再把明确的 stale 直接降级成 force-new/wake。
- X2 的 admission 串行化有效：one-shot 和正式启动的 `Agent.create → send` 不再直接并行；受理成功前预登记 `runningTasks` 也堵住了出链后的空窗。
- X3 的 `runningTasks` 删除门控局部有效：后继使用不同 `instanceId` 时，旧 run 的 `finally` 不会再删除后继 record。
- X4 可关闭：`setTaskSessionAgentId()` 已在函数内部吞掉 ENOENT、记录其它 best-effort 失败；本轮全量测试未再出现 unhandled rejection。

### 阻塞项

#### R18-1（P1）`/question` 的 task 状态写仍不是 owner 条件事务，stop 后可再次写回 running

位置：

- `src/app/api/tasks/[id]/question/route.ts:316-331`
- `src/app/api/tasks/[id]/question/route.ts:370-395`
- `src/lib/server/task-fs.ts:1170-1193`

`sent && ackContext` 分支只在 `patchAction()` **之前**检查一次 generation。之后先 await 把 action 改回 `running`，再无条件 await `setTaskRunStatus(..., "running")`，两次写之间都不再检查 owner。可复现时序：Q 已把消息送入旧会话并通过第 319 行检查 → S stop bump generation、把 action 标 cancelled 并把 task 归 idle → Q 从 `patchAction` 的 await 返回，继续把同一 action / task 写回 running。最终 stop 已返回成功，但页面又显示运行中，且真正 run 可能早已被取消。

one-shot stale 回滚也仍不是 operation CAS：`setTaskRunStatusIfCurrentAction()` 只比较 `currentActionId`。stop 后若 B 是“唤醒同一个 action”或新的 one-shot，指针可能与 Q 完全相同（或仍为 null）；旧 Q 仍会把 B 的 `running` 写成 `idle`。当前 action 指针只能区分 action，不能区分同 action 的两次运行。

修复要求不是再多放一个 await 前检查，而是把“确认 op owner + action/runStatus 状态变更”放进同一条件事务；stale owner 的回滚也必须按独立 operation/run token，而不能只按 `currentActionId`。应补两条 deferred 测试：ack patch 挂起 → stop 完成 → 放行；旧 one-shot 挂起 → stop → 同 action/无 action 的 B 进入 running → 放行旧回滚。

#### R18-2（P1）串行链只保证不双 `create`，接管时会让前驱把后继 action 取消

位置：

- `src/lib/server/task-runner.ts:668-676, 809-830, 953-991`
- `src/lib/server/task-runner.ts:1648-1724, 1753-1770`
- `src/lib/server/task-runner.ts:2395-2430`
- `src/lib/server/task-runner.ts:2096-2107`
- `tests/task-op-generation-v1-v2.test.ts:386-425`

`internalStartAgent()` 是 fire-and-forget：`advanceTask()` 在新 action 已追加、但其 `create/send` 仍排在串行链里时就释放 `runAdvanceExclusive`。此时第二次 advance 可以再追加 action B 并排队。B 出队看到前驱 A 后只调用 `predecessor.cancel()`，没有先建立 fork/handoff owner，也没有告诉 A 要排除 action B。

随后 A 的 cancelled 分支看不到 `forkPendingTasks`，会执行 `finalizeStaleActions(task.id, "cancelled")`，把已经落盘的 B 一并标 cancelled，再写 idle；等 A 清表后，B 仍会创建 Agent 并用这个已 cancelled 的 action 开跑。若前驱是 one-shot，`restoreRunStatusAfterQuestion()` 会根据最新 action B 把 task 写成 idle，结果同样是 Agent 在跑、状态不在跑。

新增 X2 测试只把一个裸 `runWithTaskSendSerial()` 回调排在 one-shot 后面，证明了“没有并行进入”，但没有走真实 `advanceTask/internalStartAgent`，也没有断言 action/runStatus 的接管结果，所以捕捉不到这个 bug。

修复应让后继在取消前驱前先原子取得 handoff owner，且前驱所有收尾只能处理自己的 action；或者让 action B 在取得启动 lease 后才落盘。需补真实调用链测试：A 的 `Agent.create/send` 挂起 → 第二次 advance/正式 advance 接管 one-shot → 断言 B action 保持 running、runStatus 正确、只有 B owner 存活。

#### R18-3（P1）`instanceId` 没有贯穿 session 和状态事务，旧 A 仍可关闭/改坏后继 B

位置：

- `src/lib/server/task-stream.ts:56-68, 76-89`
- `src/lib/server/task-runner.ts:278-300`
- `src/lib/server/task-runner.ts:2274-2305`
- `src/lib/server/task-runner.ts:2422-2428, 2456-2593, 2664-2687`
- `src/lib/server/task-runner.ts:2737-2776`
- `tests/task-op-generation-v1-v2.test.ts:428-563`

第一处是 session 身份仍只用 `agentId`。`yieldIfSuperseded()` 发现 `runningTasks.instanceId` 已变后调用 `closeTaskSession(task.id, agent.agentId)`；但 `Agent.resume()` 会恢复同一个持久化 agentId，`AgentSessionRecord` 又没有 instanceId。于是 B 若是 resume 出来的新内存实例，旧 A 的“只关自己”实际会通过 agentId 检查并关闭 B。代码注释已经承认 agentId 会复用，但门控只改了 runner record，没有改 session record。现有 X3 测试把 A/B 写成 `agent_a/agent_b`，正好绕开了这一分支。

第二处是 owner 检查包不住 await 中的副作用。例如 cancelled 分支在 `finalizeStaleActions()` 前后各查一次 instanceId，但该 helper 自己先 `getTask()`、再逐 action `patchAction()`；若 forceClear + B 接管发生在这些 await 中，旧 A 可以先取消 B 的 action，之后才在第二次检查发现自己已失去 owner。finished 的追问/error 分支还有多处在共享状态变更前没有统一的 instance owner 检查。pre/post check 不能替代条件事务。

修复需把同一 run instance token 同时放入 `RunningTaskRecord` 与 `AgentSessionRecord`，所有 close 都按 session instance/reference 门控；task action/runStatus 收尾也必须在持锁条件写内部验证 run owner。测试至少增加：A/B 使用相同 agentId 的 resume 接管；A 卡在 `finalizeStaleActions` 内部 await，forceClear 后 B 接管，再放行 A，断言 B session/action/runStatus 全部不变。

### 第十八轮验收结论

**不通过。** X4 可关闭，X1 的结构化 stale 分流和 X2 的受理串行化也都是真修复；但状态写、接管和 session 关闭仍没有共用同一个 operation/run owner。先修 R18-1～R18-3，并用真实跨入口调用链而不是裸队列回调覆盖，再做下一轮验收。

---

## 第十八轮修复报告（Fable5、2026-07-18 中午、待复审）

按第十七轮意见修复 X1–X4：

### X1（route 迟到 fallback / 写 running）

- `sendToTaskSession` 返回值改结构化 `"sent" | "stale" | "no_session" | "send_failed"`（对齐 chat-runner 的 `SendChatMessageResult` 先例、boolean 调用方全部改掉）：stale 不再与「无会话」混淆。
- `advanceTaskInner` 续接分支：`"stale"` 直接 `abortIfTaskOpStale` 中止，**绝不降级 force-new**；`no_session / send_failed` 保持降级。
- `/question`：runner 返回 stale → 409、不 fallback、不写事件；存图 / snapshot / 写事件等长 await 之后、one-shot 分支 `setTaskRunStatus(running)` 之前均用入场 opGen 复查 `isTaskOpStale`——「task 永久假 running」路径闭合。
- `/ask-reply`：stale → 409、不清 pending、不记「已答」；`wakeWithAnswer` 前复查。

### X2（同 epoch 跨入口双启动）

- `startOneShotQuestion` 与 `internalStartAgent` 的「Agent.create → send 受理」段统一纳入 `runWithTaskSendSerial` per-task 串行链（consume/stream 消费留链外、不占链）；链内不嵌套再入串行链（已核对无死锁）。
- one-shot 受理成功后以 question run 身份**预登记 `runningTasks`**（带 instanceId）——advance 出队后能看见前驱、按既有「有 active run」路径处理；one-shot 出队见正式会话已注册则让位。同一 task 跨入口至多一个 owner 进入 create/send。

### X3（旧 run 强清后迟到收尾伤后继 B）

- `RunningTaskRecord` 增 `instanceId`（进程级单调发号、task-stream global key 升 V9；同 chat-runner 先例——resume 同持久化 agent 时 agentId 相同、只有 instanceId 能区分新旧内存实例）。
- `consumeSessionRun` 的 cancelled / error / catch / finally 各出口先同步比对「runningTasks 当前 record 是否仍是本人（instanceId 匹配）」：已被 forceClear + B 接管 → 只 `run.cancel()` + 带 agentId 的 `closeTaskSession` 关自己、**绝不** `finalizeStaleActions` / 裸写 idle / 无门控关会话。
- `forceClearStaleRunnerState` 行为保留（fork 标记在 B 启动后语义已耗尽）；防线换成 instanceId 门控。

### X4（fire-and-forget unhandled rejection）

`setTaskSessionAgentId`（task-fs.ts）改为**函数内部消化错误**——几十处调用都是 `void setTaskSessionAgentId(...)`，任一处漏 `.catch` 都会在「任务目录刚被删」时产生 ENOENT unhandled rejection；best-effort 语义的单一源收口在函数体内：ENOENT 静默、其他错误 warn。测试 teardown 不再依赖 sleep 猜测。

### 新增测试

X1 stale 返回值分流（advanceTaskInner 不降级）；X2 串行链互斥（one-shot 受理段占链时第二个任务不执行）；X3（A run 挂起 → cancel + 强清 → B 注册新 record + running action → 放行 A 迟到收尾 → B 的 action/runStatus/session 全部无恙）。

### 第十八轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、625 项全部通过、0 unhandled error——**连跑两遍，其中一遍与 `pnpm build` 并行（复现第十七轮高负载场景）仍干净**
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- `/question` route 级 deferred 测试（存图挂起 → stop → 409）未补（route mock 面过大），复查逻辑在 runner 层有同构钉扎。
- one-shot 受理段占串行链期间 advance 会排队等待（有意互斥、受理段秒级）。

---

## 第十七轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- W1 可关闭：DELETE 成功后不再清 `taskOpGenerations`，`bumpTaskOpGeneration()` 使用进程级单调 token；旧快照不会再因无键默认 0 而回绕复活。
- W2 的队列层可关闭：advance、resume 和 task session send 均在进入串行 promise chain 前捕获 token，stop 前已排队的请求出队后会 stale；新增 S1/S2 deferred 测试有效。
- W3 局部成立：one-shot stale 分支不再裸写 `prevRunStatus`；旧 advance action 的 idle 恢复至少增加了 `currentActionId` 条件写。

### 阻塞项

#### X1（P1）runner 返回 stale=false 后，`/question` 仍继续 fallback 并迟到写 `runStatus=running`

位置：

- `src/app/api/tasks/[id]/question/route.ts:115-117, 220-248, 258-342`
- `src/lib/server/task-runner.ts:2869-2906`

路由提前捕获了 `opGen`，但自己从不复查；`sendToTaskSessionBody()` 发现 stale 只返回普通 `false`，调用方无法区分“没有会话”和“本请求已被 stop 作废”。`/question` 随后仍走 canResume/one-shot fallback、写用户事件，并在 one-shot 分支无条件把 task 设为 running。

可复现时序：Q 读到 idle task、取快照 0，卡在存图或 artifact snapshot → S stop bump 到 1、把 task 收尾为 idle 并释放 lifecycle → Q 继续，`deliverTaskQuestion()` 因 stale 返回 false → Q 判为 `useOneShot`，追加事件并执行 `setTaskRunStatus(..., "running")` → `startOneShotQuestion(opGen=0)` 发现 stale 后只关资源、不再恢复状态。最终 API 返回 200，task 永久显示 running，但 `runningTasks`、session 和 Agent 都不存在。

`/ask-reply` 有同类语义混淆：task send 因 stale 返回 false 后会进入 `wakeWithAnswer()`，清 pending、记录“已答”并返回 200，而带旧 token 的 resume 实际立即中止，答案并未送达。

修复不能只在 runner 内判断。route 在每个长 await 后、尤其 fallback/事件/状态写入前必须复查 admission；send 返回值应区分 `stale/cancelled` 与 `no_session/send_failed`，stale 直接 409 且不得 fallback、写 running 或记录“已送达”。补 route 级 deferred 测试：存图挂起 → stop 完成 → 放行，断言 409、idle、无 Agent、无成功消息事件。

#### X2（P1）generation 只是取消 epoch、不是 operation owner；同 epoch 的 one-shot 与 advance 仍可双起 Agent

位置：

- `src/lib/server/task-stream.ts:199-233`
- `src/app/api/tasks/[id]/advance/route.ts:202-217`
- `src/lib/server/task-runner.ts:653-687, 1629-1670, 1713-1756, 2718-2818`

token 只在 stop/DELETE/finalize 时 bump，所以两个没有经历取消的并发操作会拿到同一个值；`startingTasks` 又只是引用计数观察器，不提供互斥或 owner identity。`/advance` 不检查 task `runStatus` 或 `isTaskStarting`，`internalStartAgent` 也只检查已经登记的 `runningTasks`。

真实时序：Q 无存活 session，进入 one-shot 并卡在 `Agent.create`，此时只存在 starting 计数、尚无 `runningTasks` → A 调 `/advance`，拿到与 Q 相同的 generation，append 新 action 后进入 `internalStartAgent`，仍看不到 active run，于是启动正式 Agent → Q 的 create 迟到返回；没有 stop/bump，所有 stale 检查都通过，Q 也执行 send。两个 Agent 同时运行，后注册的 `runningTasks/agentSessions` 还能覆盖前一个，使被覆盖者无法停止。

需要 task-wide、跨 advance/resume/one-shot/send 的原子 operation lease；每次启动 intent 应有独立 owner token，而不是共享取消 epoch。具体选择排队还是拒绝属于实现手段，但服务端必须保证同一 task 不能同时跨入口 create/send 两个 owner。补 `one-shot create pending → advance` 的真实调用链测试，断言至多一个 Agent 进入 send，且 runner/session 登记始终指向唯一 owner。

#### X3（P1）旧正式 run 超过 5 秒被强清后，迟到 cancelled 收尾会取消后继 B

位置：

- `src/lib/server/task-runner.ts:936-947, 1026-1033`
- `src/lib/server/task-stream.ts:308-325`
- `src/lib/server/task-runner.ts:2270-2300, 2357-2377, 2395-2416, 2526-2540`

stop 已 bump generation，但 `consumeSessionRun()` 的非 question cancelled 分支没有检查 `opts.opGen` 或 run instance owner。后继推进 B 发现旧 A 的 `runningTasks` 后写 `forkPendingTasks`、等待 5 秒；超时会调用 `forceClearStaleRunnerState()`，该函数同时删除 fork 标记，然后 B 启动。

A 若随后才从 `run.wait()`/send error 返回，会看到 fork 标记已经不存在，进入“普通停止收尾”：`finalizeStaleActions(task.id, "cancelled")` 会把 B 的新 running action 一并取消，随后裸写 idle；catch 分支甚至用无 expected agentId 的 `closeTaskSession(task.id)`，可直接关掉 B 的新会话。finally 虽对 `runningTasks.delete` 做了 agentId 身份比较，但已经晚于这些全局副作用。

所有 consume 出口都必须按 per-run instance/operation owner 做条件收尾；旧 generation 或 record identity 已变时，只允许取消/关闭自己的本地 run，不得 finalize task 全部 action、写共享状态、清新 session。`forceClear` 也不能把旧 owner 用于识别后继的 tombstone 一并抹掉。补测试：A cancel 后故意超过 5 秒 → 强清并启动 B → 放行 A 的 cancelled/error 收尾，断言 B action、runStatus、session 和 `runningTasks` 均保持不变。

### P2 问题

#### X4（P2）`setTaskSessionAgentId` fire-and-forget 未接 rejection，30/50ms teardown sleep 仍使全量门禁随机失败

位置：

- `src/lib/server/chat-runner.ts:234-258, 1080-1083, 1248-1253`
- `src/lib/server/task-runner.ts:263-285, 1747-1756, 2084-2096, 2647-2652`
- `tests/chat-runner-resume-owner.test.ts:103-127`

与 build 并行的高负载首次全量测试中，62 文件 / 622 项断言全部通过，但两个 `void setTaskSessionAgentId()` 在 teardown 删除临时目录后继续 `writeMeta → rename`，产生 ENOENT unhandled rejection，Vitest 最终退出 1；同命令隔离复跑才通过。报告所称“按既定手法修正”只是固定 sleep 30/50ms，并没有等待真实 Promise 完成，机器负载一高仍会复现。

生产函数注释写的是 best-effort，但 fire-and-forget 调用没有 `.catch()`，文件系统异常也会进入全局 unhandled rejection。应统一封装安全的 fire-and-forget（至少 catch 并按错误类型记录），测试则暴露/等待真实 drain Promise，不能靠时间猜测。门禁需连续或高负载复跑无 unhandled error 才能关闭。

### 第十七轮验收结论

**不通过。** W1 与 W2 队列层可以关闭；W3 只修了两个局部出口，task-wide operation lease 和 run owner 条件收尾仍未闭合。先修 X1–X3，并消除 X4 的非确定性未处理 Promise，再做下一轮验收。

---

## 第十七轮修复报告（Fable5、2026-07-18 中午、待复审）

按第十六轮意见修复 W1–W3，令牌协议收敛为「进程级单调、入场即绑定、owner 化」：

### W1（DELETE 清 generation 回 0 的 ABA）

- `bumpTaskOpGeneration` 改写**进程级单调计数器** `nextTaskOpToken`（task-stream global key 升 V8）：每次 bump 得到全进程唯一值、永不重复；无键默认 0 与任何已发 token（≥1）永不相等。
- **删除 `clearTaskOpGeneration`**（含 DELETE 路由调用）：task id 含时间戳 + 随机段、不复用，被删任务保留一个 tombstone entry 是有意取舍（防 ABA 优先于 Map 回收）；注释已写明。
- 测试改钉「DELETE 后旧快照永远 stale」+「两次 bump 严格递增不重复」。

### W2（排队请求出队后才取令牌）

admission token 全部提前到**导出入口、进入任何 promise chain 之前**同步捕获并显式下传：`advanceTask`（`runAdvanceExclusive` 之前）、`resumeCurrentActionWithMessage`、`sendToTaskSession`（`runWithTaskSendSerial` 之前）；question / ask-reply 路由在 lifecycle 闸后立刻取令、经参数传给 `startOneShotQuestion` / send 链，长 await（存图、写事件）都发生在快照之后。stop 前已排队的请求出队时拿的是入场旧值、必然 stale。

### W3（stale owner 覆盖后继 runStatus）

原则收敛为「stale owner 只关自己的资源；task 级状态要么不写、要么 CAS」：

- `abortIfTaskOpStale`：patch 自己 action 为 cancelled 保留（actionId 精确、安全）；「见 running 归 idle」改走新增的 `setTaskRunStatusIfCurrentAction(taskId, expectedCurrentActionId, status)`（task-fs.ts、withTaskLock 内 read-compare-set，参照 `setTaskAwaitingIfIdle` 先例）——仅当 `currentActionId` 仍指向本操作的 action 才写；后继 B 已接管则不碰。
- one-shot `abortStaleQuietly`：**不再写任何 runStatus**（只 close agent + 注销飞行登记）——one-shot 不改 `currentActionId`、stale 必由 stop/DELETE bump 造成、状态归 bump 方收尾；旧逻辑无条件恢复 `prevRunStatus` 正是把后继 B 的 running 改回 idle 的元凶（第十六轮 W3 时序）。
- `restoreRunStatusAfterQuestion`：gen stale / lifecycle 进行中跳过恢复；正常问答收尾路径不变。

### 新增/修订测试

`tests/task-op-generation-v1-v2.test.ts` 按新协议修订 + 扩展：W1 tombstone（bump→DELETE 不 clear→旧 snap 恒 stale）；W2 deferred（S1 send 挂起、S2 已进串行队列 → stop → 放行 → S2 的 agent.send 从未调用、runningTasks 未注册）；W3（one-shot create pending → stop 完成 → 后继 B 置 running → 旧 create resolve → B 的 running 不被覆盖、旧 agent close）；CAS helper 指针已变不写。

### 第十七轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、622 项全部通过、0 unhandled error（首跑曾出 1 个测试自身 teardown 竞态的 unhandled rejection——fire-and-forget 落盘 vs 删临时目录，已按 chat-runner 系测试既定手法修正、连跑复核干净）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- advance 全链端到端 deferred 测试（append 后挂起 → stop → 放行）仍未补（route+runner mock 面过大）；协议由「入口同步取令 + 7 处复查 + CAS」保障，send 链有同构 deferred 测试。
- generation Map 只增不删（有意 tombstone）；长跑进程随删任务累积 string+number 条目，量级可忽略。

---

## 第十六轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板、compact 参数或其它功能设计。
- V2 的引用计数部分成立：`beginTaskStarting/endTaskStarting` 对同 task 的多个 owner 正确计数，先结束者不会再抹掉后结束者的飞行标记。
- V2 的核心 single-flight 成立：`runWithTaskSendSerial` 在同步阶段链接 per-task promise tail，同 task 的两个函数不会并发执行；前任失败也不会毒死后继队列。
- V1 的普通飞行窗较上轮明显收紧：one-shot 在首个 await 前登记 starting 并取代际快照；`internalStartAgent` 在 workspace/create/send 周围复查；stop、DELETE、finalize 会 bump generation。

### 阻塞项

#### W1（P1）DELETE 成功后把 generation 清回默认 0，旧 operation 发生 ABA 并重新变“有效”

位置：

- `src/lib/server/task-stream.ts:207-223`
- `src/app/api/tasks/[id]/route.ts:253-254, 319-328`
- `tests/task-op-generation-v1-v2.test.ts:163-173`

`getTaskOpGeneration()` 对无键返回 0，DELETE 入场把 0 bump 到 1，本来能让持有快照 0 的旧请求 stale；但物理删除成功后立即 `clearTaskOpGeneration()`，当前值又变回 0，同时 `clearChatGate()` 也释放 lifecycle。于是同一个旧请求的 `isTaskOpStale(taskId, 0)` 从 `true` 重新变成 `false`，这是标准 ABA。

真实时序一：A 已 append action、卡在 baseline/branch await，此时还没进入 `internalStartAgent`，所以不计入 `startingTasks`；D DELETE bump 代际、删 task、clear gate、清 generation；A 恢复后各 stale 检查全部通过，继续使用内存里的 stale `taskAfterAppend`。后续 `ensureWorkspaceReady()` 会重建 workspace，启动链可继续走到 `Agent.create/send`。真实时序二：one-shot 已登记 starting 但 `Agent.create` 超过 DELETE 的 8 秒等待上限；DELETE 按现逻辑超时后继续删除并清 generation，迟到的 create resolve 后也会把旧快照 0 当作新鲜并执行 send。

当前协议测试反而把问题固化了：它断言 `clear` 后读回 0，却没有断言删除完成后旧快照必须永远 stale。

修复应保证 token 不回绕。最小做法是 DELETE 后保留 tombstone generation（task id 不复用时无需清键）；若必须回收，须等所有已准入 owner 和排队 owner 全部退出后再回收，并使用进程级单调 token/不复用的 opaque id，不能让“无键默认值”与旧快照相等。补测试：`snap=0 → bump → DELETE clear/retire` 后，旧 snap 必须始终 stale；再补 baseline/create 超过 8 秒的真实删除链路测试。

#### W2（P1）advance/resume/send 在串行队列出队后才取 generation；stop 前已排队的请求会冒充 stop 后新请求

位置：

- `src/lib/server/task-runner.ts:571-586, 646-674`
- `src/lib/server/task-runner.ts:984-993`
- `src/lib/server/task-runner.ts:2811-2843`

`advanceTask()` 先进入 `runAdvanceExclusive()` 并等待前驱，真正的 `getTaskOpGeneration()` 在 `advanceTaskInner()` 开始后才执行；resume 同构。`sendToTaskSession()` 先进入 `runWithTaskSendSerial()`，没有显式 `opts.opGen` 的 question/ask 请求则到 `sendToTaskSessionBody()` 真正出队后才取 generation。

因此 A1 正在运行、A2 已在 stop 前到达并排队时，stop bump generation；A2 等 A1 退出后才拍下 bump 后的新值，被当成 stop 之后的新意图继续 append/start。send 的时序更直接：S1 在发、S2 已排队 → stop bump；S1 stale 收尾清 pending 并退出 → S2 出队后才取新 generation，lifecycle 已释放，随后 resume/send。排队中的 A2/S2 也还没 `beginTaskStarting`，stop/DELETE 无法看见或等待它们。

修复应在导出的 public operation 入口、进入任何 promise chain 之前同步捕获 admission token，然后把它显式传给 inner/body；advance、resume、deliver question/ask 均如此。补 deferred 测试：第二个调用已入队但未执行时 stop，放行前驱后断言第二个不得 append、resume、create 或 send。

#### W3（P1）stale owner 的清理会无条件写共享 `runStatus`，可把已经启动的后继 run 改回 idle

位置：

- `src/lib/server/task-runner.ts:168-180`
- `src/lib/server/task-runner.ts:1983-1994, 2155-2168`
- `src/lib/server/task-runner.ts:2673-2694`
- `src/lib/server/task-runner.ts:2882-2916`

代际能识别“我是旧操作”，但识别后没有遵守 owner 边界。`abortIfTaskOpStale()` 看到当前 task 为 running 就直接设 idle，不核对 `currentActionId`、run instance 或 generation；one-shot 的 `abortStaleQuietly()` 更是直接恢复入口保存的 `prevRunStatus`；question stale 分支调用的 `restoreRunStatusAfterQuestion()` 只比较“当前仍为 running”，还会按当前 action 计算目标状态。

可复现时序：旧 one-shot 卡在 `Agent.create` → stop bump 并完成，状态归 idle、lifecycle 释放 → 用户启动后继 B，B 已把 task 置 running → 旧 create 才 resolve，旧 one-shot 正确判断自己 stale，却在清理时执行 `setTaskRunStatus(task.id, prevRunStatus)`，把 B 改回 idle。旧 advance/question 的清理也能以同样方式覆盖跨入口启动的后继。Agent B 仍在跑，但 UI/准入状态显示 idle，后续又可能启动第三个 run。

stale owner 只能关闭自己持有的 agent/run、取消自己的 action，不能无条件写 task 级状态。状态恢复需要 task lock 内的 CAS：同时核对 operation token、run instance/agentId 和预期 currentActionId；更稳妥的是给 `runStatus` 记录 owner token，只有当前 owner 能迁移。stop/DELETE 已负责全局收尾时，旧 owner 只做资源清理即可。补测试：one-shot create pending → stop 完成 → B 置 running/注册新 owner → 旧 create resolve，最终 B 的状态和登记必须保持不变；question/advance stale cleanup 各补一条同构用例。

### 第十六轮验收结论

**不通过。** V2 的“禁止双 `agent.send()`”核心已修复，`startingTasks` 引用计数也可关闭；但 operation generation 尚不是不可回绕、入场即绑定、owner 化的取消令牌。先修 W1–W3，并用真实排队/删除/后继 owner 的 deferred 测试钉住时序，再做下一轮验收。

---

## 第十六轮修复报告（Fable5、2026-07-18 上午、待复审）

按第十五轮意见修复 V1、V2，核心是 per-task **operation generation** + send 串行化：

### V1（lifecycle 瞬时检查 → operation generation）

- `task-stream.ts`（global key 升 V7）增 `taskOpGenerations: Map<string, number>`：`getTaskOpGeneration` / `bumpTaskOpGeneration`（取消一切在途启动意图）/ `clearTaskOpGeneration`（DELETE 成功后删键防积键）。
- 取消方 bump：`stopTaskAgent`（begin lifecycle 后立刻）、DELETE（begin deleting 后立刻）、`finalizeTask`。**即使 stop/DELETE 已完成并释放 lifecycle、清掉 pending，已入场请求靠入场快照比对仍会发现自己被作废**——这正是第十五轮「瞬时检查」缺口的闭合点。
- 在途请求入场快照 opGen、关键 await 后复查（`isTaskOpStale` = gen 不匹配 或 lifecycle 非空）：
  - `advanceTaskInner`：append 前、baseline 采集后、readonly 基线后、action_start 事件后、branch 处理后、续接 send 前、force-new `internalStartAgent` 前共 7 处；stale 且已 append → `abortIfTaskOpStale` 把 action patch 成 cancelled + runStatus 归 idle 再抛（不留僵尸 running action）。
  - `resumeCurrentActionWithMessage`：入场快照、patch running 前、worktree/branch 处理后、send 前复查。
  - `internalStartAgent`：`StartAgentInput` 增 `opGen`（advance 传入场快照）；`applyPendingStopIfRequested` 扩为 `pending || lifecycle || opGen 不匹配` 命中，gen-only 命中走「只关资源」支路（stop 已完成、收尾早已写过，不重复副作用）。
  - `startOneShotQuestion`（第十五轮点名的裸奔路径）：纳入 `startingTasks` 登记 + 入场快照；ensureWorkspaceReady 后、create 后、send 前复查 stale → close agent、恢复原 runStatus、静默退出。
  - `sendToTaskSession`：入场、drain 后、resume 后、send resolve 后复查。

### V2（send 无 single-flight + startingTasks 误清）

- `startingTasks` 从 Set 改为**引用计数 Map**（`beginTaskStarting` / `endTaskStarting` / `isTaskStarting`）：两个 sender 并发登记、先完成者 -1 不再抹掉后完成者的可见性，stop/DELETE 判「有无飞行消费者」不再被误清欺骗。one-shot 也已纳入。
- `sendToTaskSession` 整体套 `runWithTaskSendSerial`（per-task promise 链、同步 check-and-chain）：并发 send 排队串行执行，第二个排到第一个之后再走自己的 `waitForRunToDrain`——**绝无并发 `agent.send()`**。刻意不做「第二个直接拒绝」：advance 的 reuse 路径拿到 false 会误降级 force-new、杀掉第一个正在用的会话。
- 「第一个 resolve 后 stop、第二个仍 pending」由 send resolve 后的 stale 复查兜住：第二个永不注册 `runningTasks`。

### 新增测试

`tests/task-op-generation-v1-v2.test.ts`：generation 契约（bump 后旧快照 stale、DELETE 删键）；refcount（双 begin 单 end 后 `isTaskStarting` 仍 true——V2 误清窗口直接钉扎）；one-shot `Agent.create` pending → stop → resolve 断言 send 从未调用、agent close、runStatus 恢复；`runWithTaskSendSerial` 串行契约（第二个在第一个 resolve 前不执行、前任失败不取消后任）。

### 第十六轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：62 个文件、620 项全部通过（较十五轮 +5 项）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- advance 全链（append 后挂起 → stop → 继续）未做端到端 deferred 测试（route+runner mock 面过大），靠 7 处 `abortIfTaskOpStale` 复查点 + opGen 贯穿保障；协议层与 one-shot / 串行队列有直接测试。
- `ensureWorkspaceReady` 在 stale 复查前仍可能短暂重建已删目录（随后立刻中止、不启动 agent）；目录残留待 tombstone 层清理，未在本轮改 task-fs。

---

## 第十五轮验收（Codex、2026-07-18、纯 bug 范围）

### 已确认修复

- **S8 继续排除。** 不评价侧栏分组、全文搜索、diff 面板或 compact 产品参数。
- U2：DELETE 已把 `clearChatGate()` 移到 `cleanupCheckpointRefsForTask()` 和 `deleteTask()` 成功之后，原“物理删除前提前开闸”窗口闭合。
- U3：同 task 的 stop 已通过全局 in-flight Promise 合并，同相位重入不再重复执行状态、事件副作用，也不会由首个调用提前释放另一个调用的 gate。
- U4：`saveImageAttachments()` 已与 `deleteTask()` 共用 task lock，并在锁内复查 deleting/meta；删除后不会重建 `uploads`，批量写中途失败也会清理已完成文件。
- U1 局部：`/advance`、`/question`、`/ask-reply` 增加 lifecycle 入口检查；正式 task starter 和 session send 增加 `startingTasks` 标记，启动链在 create/send 后也会读取 pending/lifecycle。

### 阻塞项

#### V1（P1）lifecycle 仍是瞬时检查；已入场的 advance 和 one-shot 可在 stop/DELETE 完成后继续启动 Agent

位置：

- `src/lib/server/task-runner.ts:706-714, 715-865`
- `src/lib/server/task-runner.ts:938-1018`
- `src/lib/server/task-runner.ts:2546-2607`
- `src/app/api/tasks/[id]/question/route.ts:295-334`
- `src/lib/server/stop-task.ts:101-109`

三条 route 都只在读取 task 后检查一次 lifecycle；`advanceTaskInner()` 和 resume 也只在某个中间点再读当前相位，没有持有 request token/generation。检查之后到 `internalStartAgent()` 之前仍有 append action、基线采集、事件、worktree/分支处理等多段 await，而 `startingTasks.add()` 直到 `internalStartAgent()` 入口才执行。

可复现时序：A 在第 714 行通过检查并 append 新 action → A 卡在后续 baseline/branch await → B stop 或 DELETE；此时没有 `runningTasks`，也尚未加入 `startingTasks`，所以 B 写入的 pending 会被 stop 第 108 行或 DELETE 第 300 行清掉，B 完成并释放 lifecycle/删除目录 → A 继续到第 865 行，加入一个全新的 starting 标记；此时 pending 和 lifecycle 都不存在，最终 `Agent.create/send`。DELETE 场景还会用 stale task 重建 workspace，并为已删除任务运行 Agent。

一次性答疑路径更直接：`startOneShotQuestion()` 完全没有加入 `startingTasks`，也没有在 `Agent.create` / `agent.send` 前后检查 lifecycle/pending。stop 若发生在其 create 窗口，会认定“没有飞行消费者”并清 pending；one-shot 随后照常 send。DELETE 后该路径的 `ensureWorkspaceReady()` 还可能重新创建已删除任务目录。

需要在请求/operation 真正入场时就分配 owner token，并由 stop/DELETE bump generation 或调用 owner cancel；token 必须贯穿 route、advance/resume、workspace、create、send，不能靠若干次读取“当前是否 stopping”代替。至少补两条真实调用链测试：`advance append 后挂起 → stop/DELETE 完成 → 继续`，以及 `one-shot Agent.create pending → stop/DELETE → resolve`，最终均不得 create/send、不得重建目录。

#### V2（P1）task session send 没有 single-flight；`startingTasks: Set` 还会被先完成的 sender 误清

位置：

- `src/lib/server/task-stream.ts:105-120, 150-156`
- `src/lib/server/task-runner.ts:2639-2648, 2651-2727`

`sendToTaskSession()` 的协议是 `startingTasks.add → await waitForRunToDrain → 读 session → await agent.send`，但“确认没有 running run”和“占有本次 send”不是原子操作。两个并发 `/question` / `/ask-reply` 都能看到 `runningTasks` 为空，随后对同一个 Agent 同时调用 `send()`；两个 `consumeSessionRun()` 又会用相同 agentId 互相覆盖/删除 `runningTasks`，导致消息乱序、SDK 并发错误或活 run 变得不可停止。

新增的 `startingTasks` 是 Set，不记录 owner 或引用计数。两个 sender add 同一个 key 后，先返回者的 finally 会直接 delete，第二个仍在 `agent.send()` pending 却已不可见。若此时 stop 只取消第一个已登记 run并完成，第二个 send 迟到 resolve 后看不到 pending/lifecycle，会重新写入 `runningTasks`，再次出现“停止成功后 Agent 继续跑”。正式首 run 的 `startingTasks` 还覆盖整个 `consumeSessionRun`，与等待旧 run 排空的 follow-up sender 也能形成同样的误删窗口。

需要 per-task send owner/mutex（check-and-reserve 必须同步完成），每个 run 再使用独立 instance token；`startingTasks` 若保留，至少应是 owner Map/refcount，且 one-shot 也必须纳入。补两次并发 send 的 deferred 测试：两个调用不能同时进入 SDK `agent.send`；再在第一个 resolve、第二个仍 pending 时 stop，断言第二个永不注册/运行。

### 第十五轮验收结论

**不通过。** U2、U3、U4 可以关闭；U1 仍未形成 task-wide、owner 化的 operation lease。当前新增测试只验证手工向 Set 放一个 taskId 时 pending 是否保留，没有覆盖真实 Agent 生命周期、同 task 多 owner 和 route 检查后的 TOCTOU。先修 V1、V2，再做下一轮验收。

---

## 第十五轮修复报告（Fable5、2026-07-18 上午、待复审）

按第十四轮意见修复 U1–U4，lifecycle 升级为 task-wide 取消协议：

### U1（task 模式启动飞行窗）

- `task-stream.ts` 增 `startingTasks: Set`（global key 升 V6）：`internalStartAgent`（含 fire-and-forget IIFE 全程）与 `sendToTaskSession` 进入即登记、finally 注销——标记「pendingStopRequests 当前有飞行消费者」。
- `stopTaskAgent` / DELETE 的 `pendingStopRequests.delete` 改为**仅在无飞行消费者时执行**（`!startingTasks.has(id)`）：飞行中的启动链需要该标记在 create/send 后自裁；idle 点停止无飞行时照清（oneshot 误杀修复不回退）。
- DELETE 在 `waitForTaskToStop/waitForChatToStop` 后追加等 `startingTasks` 退出（100ms/8s，超时 warn 继续——pending 标记仍在、启动链会自裁）。
- `advanceTask` / `resumeCurrentActionWithMessage` 的「新意图作废停止标记」加守卫：lifecycle 进行中直接抛错（不得作废进行中 stop/DELETE 的取消协议）。
- `/advance`、`/question`、`/ask-reply` 路由入口检查 lifecycle → 409。
- `applyPendingStopIfRequested` 命中条件扩为 `pending || lifecycle !== null`，并拆「关资源」（`closeStartChainResourcesForStop`：杀 run / 关会话 / close agent / 清 pending 标记，两支共用）与「写收尾」：lifecycle 进行中只关资源、状态与停止事件归 stop/DELETE owner 写（防重复副作用）；仅 pending 且 stop 已写完收尾（idle 且无非终态 action）也跳过重复事件。`consumeSessionRun` 入口与 `sendToTaskSession` catch 同步生效。

### U2（DELETE 提前开闸）

`clearChatGate(id)` 挪到 `deleteTask()` 成功返回**之后**；`not_found` / rewind 等待超时 / catch 三个出口改用 `endChatLifecycle(id, "deleting")`。deleting gate 从 begin 起持有到物理删除完成，refs 清理与 `deleteTask` 的慢窗口内 chat-reply / 预约一律 409。

### U3（stop 同相位 single-flight）

`stopTaskAgent` 加 per-task in-flight Promise 注册表（globalThis）：并发重入直接返回**同一个 Promise**（join、零重复副作用）；外层刻意不用 async 包装以保证引用同一性。

### U4（附件写入越过 DELETE）

`saveImageAttachments` 落盘段（mkdir + 写文件）整体移入 `withTaskLock`——与 `deleteTask`（本就整段持锁）线性化；锁内动手前复查 `getChatLifecycle !== "deleting"` 且 `readMetaV06` 非 null，失败即抛、绝不重建已删目录。纯内存校验（mime/base64/大小）留锁外。写盘中途失败对本次已写文件 best-effort unlink、无半批孤儿。

### 新增测试

`tests/task-stop-lifecycle-u1-u3.test.ts`（飞行中 stop 不清 pending / 无飞行照清；双 stop 返同一 Promise、停止事件只写一次）、`tests/save-image-attachments-u4.test.ts`（DELETE 占锁删目录后 save 拒绝且目录不重建；deleting 拒绝；写盘失败无残留）、`tests/chat-lifecycle-t1-timing.test.ts` 扩展 U2 gate 时序。

### 第十五轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：61 个文件、615 项全部通过（较十四轮 +8 项）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（记录、不隐瞒）

- advance 路由层 409 与 `advanceTask` 内层抛错之间仍有极窄竞态窗（entry 检查通过后 lifecycle 才 begin）——内层守卫会拦住，表现为 400 而非 409（文案仍明确）。
- U4 只拦 `deleting` 不拦 `stopping`（stop 不删目录、写入无害；后续 DELETE 会整目录清掉）。

---

## 第十四轮验收（Codex、2026-07-18、纯 bug 范围）

### 范围与已确认修复

- **S8 继续排除，不评价也不要求修改。** 全文搜索、diff 面板、compact 产品参数等功能设计项同样不计入本轮。
- T3：旧 A 在 `Agent.create` 返回后和首包 `send` 前均复查实例身份；`forceClear + B` 后 A 不再发送，测试有效。
- T4：`flushChatQueue` 已实现同步 single-flight owner，并补空闲后的续 drain；并发双 flush 的 FIFO 测试有效。
- T5：`compact_done / compact_summary` 已后置到重建确认成功以后；重建期间 stop 与重建失败测试有效。
- T6：Vitest 固定 `maxWorkers: 4` 后，默认全量命令 59 文件、607 项稳定通过。
- 原 T2：DELETE 等待 rewind 退出，rewind 占门闩后也会复查 lifecycle，原先“DELETE 替活跃 rewind 清门闩”的问题已闭合。

### 阻塞项

#### U1（P1）lifecycle 只被 chat 入口读取；task 模式 stop/DELETE 仍可在 `Agent.create` 飞行窗口后复活 agent

位置：

- `src/lib/server/stop-task.ts:49-64`
- `src/app/api/tasks/[id]/route.ts:263-280`
- `src/app/api/tasks/[id]/advance/route.ts:200-264`
- `src/app/api/tasks/[id]/question/route.ts:99-148`
- `src/app/api/tasks/[id]/ask-reply/route.ts:337-391`
- `src/lib/server/task-runner.ts:250-264, 704-706, 930-931, 1591-1611`

`beginChatLifecycle(stopping/deleting)` 已用于通用 stop/DELETE，但 `getChatLifecycle()` 只出现在 `chat-reply` 和 rewind；task 模式的 `/advance`、`/question`、`/ask-reply` 唤醒以及内部启动器都不检查它。更直接的问题是：`cancelTaskRun()` 在没有 `runningTasks` record 时写入 `pendingStopRequests`，本来专门用于拦住 `Agent.create → runningTasks.set` 窗口；`stopTaskAgent()` 却在同一调用里立刻把该标记删除，DELETE 也在只等待可见 record 后删除它。

可复现时序：A 已进入 `internalStartAgent()` 并卡在 `Agent.create()`，尚未写 `runningTasks` → B 调 stop，`cancelTaskRun()` 写 pending → B 第 64 行立即清 pending 并返回成功 → A 的 create 返回，`applyPendingStopIfRequested()` 读不到标记，于是注册 session 并调用 `agent.send()`。DELETE 同理：等待函数会因尚无 record 立即通过，删除 pending 和任务目录后，A 仍可继续启动。并发 `/advance` 还会在 `advanceTask()` 第 706 行主动清除 stop 标记，直接穿透正在执行的 stop/DELETE。

需要把 lifecycle 提升为 task-wide、带 generation/token 的 operation gate，覆盖所有启动、resume、send 和任务写入入口，并由 `internalStartAgent` / `sendToTaskSession` 在每个关键 await 后验证；不能用一个会被 stop 自己或新推进无条件删除的 Set 充当取消协议。补真实调用链测试：`Agent.create pending → stop/DELETE → create resolve`，断言永不 `send`、不注册 session；再补 deleting 期间 `/advance`、`/question`、ask 唤醒均返回 409。

#### U2（P1）DELETE 在 checkpoint ref 清理和物理删除之前清掉 deleting gate，重新打开了仍存在的 task

位置：`src/app/api/tasks/[id]/route.ts:285-301`

DELETE 在第 287 行调用 `clearChatGate(id)`，这会同时清 lifecycle 和 cancelled start lease；但随后才 await `cleanupCheckpointRefsForTask()`，最后才调用 `deleteTask()`。ref 清理可涉及多个仓库，`deleteTask()` 本身也有异步文件操作，这个窗口内 task 的 meta 和目录仍存在。

可复现时序：D 已取消旧 run 并在第 287 行开闸 → D 卡在某仓 ref 清理 → C 发 `chat-reply`，看不到 deleting，读到仍存在的 task，重新预约 start lease、置 running 并注册新 Agent → D 最后删除目录且不会再 cancel C。结果是 DELETE 返回成功后仍有 Agent 运行，且它继续对已删除任务写状态/事件。

deleting gate 必须一直持有到 checkpoint refs 清理、`deleteTask()` 和所有 task-scoped writer 退出之后；成功或失败均只在最外层 finally 由 owner 释放。补 route 级测试，把 `cleanupCheckpointRefsForTask` 或 `deleteTask` 延迟，期间发 chat-reply，断言 409 且无 `Agent.create/send`。

### P2 问题

#### U3（P2）同相位 stop 重入不是 single-flight，owner 可在另一个 stop 尚未完成时提前释放 gate

位置：`src/lib/server/stop-task.ts:49-56, 74-121`

第二个 stop 调用 `beginChatLifecycle("stopping")` 会得到 false，但仍会完整执行 cancel、逐 action patch、状态回写和事件追加；只有 finally 不负责释放。若第一个 owner 先结束，它会清掉 stopping gate，此时第二个 stop 仍可能卡在任一 await。新 chat 请求随后可以启动，第二个 stop 再迟到写 `runStatus=idle` 和“用户停止”事件，覆盖新 run 的状态；没有新请求时也会重复写停止事件。

同相位重入应加入同一个 stop Promise，或直接返回首个操作的结果；lifecycle 的存活期必须覆盖所有参与同一 stop 的调用者。补双 stop 延迟测试：第一请求先结束、第二请求仍挂起时，新 start 仍须被拒绝，且最终只产生一次停止副作用。

#### U4（P2）先通过入口检查的附件写入可越过 DELETE，并在删除后重建 `uploads` 孤儿目录

位置：

- `src/app/api/tasks/[id]/chat-reply/route.ts:183-202`
- `src/app/api/tasks/[id]/question/route.ts:99-148`
- `src/app/api/tasks/[id]/ask-reply/route.ts:288-301`
- `src/lib/server/task-artifacts.ts:67-108`

这些请求在读取 task 或检查 lifecycle 后，会异步调用 `saveImageAttachments()`；该函数独立 `mkdir(..., recursive)`、逐文件写入，不持有与 DELETE 共享的 writer lease/锁。请求若在 DELETE 发布 deleting 前已通过一次性检查，之后可以在任务目录被 `rm` 后才执行 mkdir，从而重新创建 `data/tasks/<id>/uploads` 并写入没有 meta 的孤儿文件。后续业务检查即使返回 404/409，也不会清理这些文件。

task-scoped 写请求应持有可撤销的 request generation / writer lease，DELETE 先发布 tombstone、拒绝新 writer，再等待已入场 writer 退出后删目录；至少要让附件落盘在 task 锁内复查 meta/deleting，并为失败请求清理本次已写文件。补“保存前挂起 → DELETE 完成 → 保存继续”的文件系统测试，断言任务目录不会被重建。

### 第十四轮验收结论

**不通过。** T3–T6 和原 T2 可关闭；T1 只修到了 chat 的部分时序。先修 U1、U2 的 task-wide 生命周期与 DELETE 线性化点，再处理 U3、U4。工程门禁全绿，但当前新增测试只覆盖 chat gate 的局部契约，没有模拟 task `Agent.create` 飞行窗口、DELETE 慢清理窗口和已入场 writer。

---

## 第十四轮修复报告（Fable5、2026-07-18 上午、待复审）

按第十三轮意见修复 T1–T6，方向统一收口到 per-task lifecycle gate + 单 owner drain：

### T1 + T2（stop/DELETE 生命周期）

- `chat-gate.ts` 增加 per-task lifecycle（`stopping | deleting`、globalThis key 升 V3）：`beginChatLifecycle`（deleting 优先、stopping 可升级 deleting、同相位重入 false）/ `endChatLifecycle(taskId, phase?)`（带 phase 防 stop finally 误清已升级的 deleting）/ `getChatLifecycle`。
- lifecycle 进行中：`tryReserveChatStart` 一律 null（**cancelled lease 不再允许在 stop/DELETE 完成前被覆盖**）；`isChatStartLeaseValid` 一律 false（owner 在任一 await 后复查即失效）。
- `stopTaskAgent` 整体包 begin stopping → try/finally end；DELETE 路由在任何 await 前 begin deleting、失败/not_found 路径显式 end、成功路径由 `clearChatGate`（已含 lifecycle）清。
- chat-reply 入口与 `enqueueOrReject` 双点检查 lifecycle → 409（stopping「正在停止对话、请稍后重发」/ deleting「任务正在删除」），已 202 的消息不再被 stop 的 `clearChatQueue` 静默丢。
- T2：DELETE begin deleting 后若 rewind 进行中 → 轮询等待（100ms/30s 上限、超时 409「正在回退到检查点、请稍后再删」）后才 clearChatGate / 清 refs / 删目录；`executeChatRewind` 占门闩后复查 lifecycle、命中抛 409——双向互斥闭合。`clearChatGate` 注释明确「仅在 rewind 退出 + owner 终止后调用」。

### T3（首包 create 窗口实例复查）

`runChatSession` 在 `Agent.create` resolve 后、素材收割（skills/rules/identity/gitlab 四 await）后 send 前，均复查 `cancelled + runningChats instanceId === myInstanceId`；instanceGone → close 本地 agent、直接 return 不动 B；cancelled → 走 finishCancelled。**旧 A 在 forceClear+B 之后绝不会调用 `agent.send`**。

### T4（单 owner drain）

`flushChatQueue` 入口同步 single-flight（`drainingQueues.has → return`，第一个 await 前 check-and-set 原子）；compact finally 的 void flush 与 auto-compact catch 的 await flush 撞车时谁先到谁当 owner。配套：本轮 finally 清位后若「队列非空 && 无 run/compact/rewind」续一次 drain，防链式 flush 撞 draining 空 return 导致滞留。

### T5（compact done 事件后置 + stop 区分）

`compact_done` / `compact_summary` 挪到重建确认成功（`await runChatSession` 返回 + abort 复查 + `hasChatSession`）之后才写——重建失败不再留下永久假「已压缩」；重建返回后先 `throwIfCompactAborted()`（stop 命中 → `summarize_cancelled`、auto 路径静默分流）再判 `restart_failed`。

### T6（测试门禁稳定性）

`vitest.config.ts` 固定 `maxWorkers: 4`；`chat-checkpoint.test.ts` 真实 Git 用例独立 timeout 20s + afterEach 清临时 refs（超时也不残留）；`chat-runner-reconnect-race.test.ts` 弃固定 sleep、改等「重连中」事件写盘后再 stop / 条件等待断言。

### 新增测试

`tests/chat-lifecycle-t1-timing.test.ts`（T1 时序：reserve → stop/DELETE → 并发 reserve 必 null → 完成后恢复）、`tests/chat-runner-t3-t4-t5.test.ts`（create pending → forceClear+B → A resolve 断言 A.send 未调用；双 flush 并发 FIFO；重建 pending stop → summarize_cancelled 且无 compact_done；重建失败 → restart_failed 且无 compact_done）、`tests/chat-gate.test.ts` 扩展 lifecycle 契约。

### 第十四轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`（默认命令、maxWorkers=4 已固定）：59 个文件、607 项全部通过（较十三轮 +11 项）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

---

## 第十三轮验收（Codex、2026-07-18、纯 bug 范围）

### 本轮范围说明

- **S8 已撤销，不是 bug，不要修改侧栏分组。** 本轮不评价 task 该按时间还是业务状态分组。
- 不把“标题 + 首条消息搜索”、会话 diff 面板、compact 120 秒/重试次数/85% 阈值等未落地产品项算作 bug。
- 只报告有明确失败时序、错误状态、消息丢失/乱序、资源泄漏、安全绕过或工程门禁不稳定的问题。

### 已确认修复

- S5：preview 改为检测整个 Unix 进程组，真实覆盖“组长先退、子进程忽略 TERM”，9 项集成测试通过。
- S6：历史态连续 ArrowUp 不再要求光标仍在文首，代码逻辑已闭合。
- S7：tool output / diff 改为 UTF-8 字节判限和 code-point 安全截断，中文、emoji、后缀预算测试有效。
- S9：BOE 自动打开白名单改为 `feishu-boe.cn` 精确注册域/子域判断，混淆域测试有效。
- S3 主问题：compact 增加事务级 abort，摘要被 stop 后不再重试，也不会继续重建会话。
- S4 局部问题：队列容量已计入 in-flight，队首回插不再截断已返回 202 的队尾消息。

### 阻塞项

#### T1（P1）stop/DELETE 只取消一次启动 lease，取消态又允许立刻覆盖；停止或删除过程中仍可起出新 Agent

位置：

- `src/lib/server/chat-gate.ts:83-93`
- `src/lib/server/stop-task.ts:45-57`
- `src/app/api/tasks/[id]/route.ts:226-260`

新 token 解决了“旧 owner 误删新 owner”问题，但 `tryReserveChatStart()` 明确允许覆盖 `cancelled` lease。stop/DELETE 在入口只调用一次 `cancelChatStart()`，随后有多段 await；这段时间另一个 chat-reply 可以读到仍存在的 task、覆盖旧 lease、注册新 `runningChats`。stop 后续不会再次取消它，反而可能在新 run 已置 running 后把 task 状态写回 idle；DELETE 也只等待而不再次 cancel，新 run 若不退出，8 秒后仍继续清状态和删目录。

可复现时序：A 正在启动 → stop/DELETE 取消 A lease → 请求 B 在 stop/DELETE 完成前覆盖 cancelled lease → B 的 `runChatSession` 同步注册 → stop/DELETE 继续自己的收尾但不再 cancel B。最终可能出现“停止响应成功但 Agent 仍跑”，或“任务目录已删但 Agent 仍在工作”。

需要独立的 stopping/deleting 生命周期 gate，且 DELETE 应在任何 await 前先发布不可逆的 deleting/tombstone 状态；新请求在 stop/delete 完成前只能 409，不能覆盖 gate。补 route 级并发测试：stop/delete 卡在收尾 await，期间 POST chat-reply，断言不得 `Agent.create/send`，最终无 runningChats、无 running 状态。

#### T2（P1）DELETE 无视正在执行的 rewind，并直接清掉它的门闩

位置：

- `src/app/api/tasks/[id]/route.ts:247-260`
- `src/lib/server/chat-gate.ts:134-139`
- `src/lib/server/chat-checkpoint.ts:703-816`

rewind 在整个仓库恢复事务期间依赖 `rewinding` gate 排斥 chat-reply/compact/drain；DELETE 没有检查或等待 rewind，却在清 checkpoint refs 和 `deleteTask()` 之前调用 `clearChatGate()`，把仍在运行的 rewind gate 删除。随后新消息能进入 checkpoint/启动链，与正在恢复仓库的 rewind 并发；DELETE 的 ref 清理也可能与 rewind 正在创建/裁剪 refs 交叉。

DELETE 不得“替别人释放”活跃 rewind gate。应增加 deleting 与 rewind 的双向互斥，或等待/取消 rewind 事务完成后再清 refs 和目录；`clearChatGate` 只能用于确认所有 owner 已退出后的最终内存清理。补 DELETE × rewind 真并发测试，至少卡在安全快照和仓恢复两个窗口。

#### T3（P1）首包只在 `Agent.create()` 后检查 cancelled，不检查实例是否已被 forceClear 替换；旧 Agent 仍会执行 send

位置：`src/lib/server/chat-runner.ts:967-1049`

S2 已在 `agent.send()` resolve 后验证 instanceId，能避免旧 A 覆盖新 B 的 record；但 `Agent.create()` resolve 后只检查本地 `cancelled`。懒重启的 `forceClearChatRun()` 不会修改 A 闭包里的 cancelled：A 卡在 create → forceClear → B 注册/运行 → A create resolve，A 会继续拼 prompt 并调用 `agent.send()`，直到 send 已受理后才发现当前 record 是 B。

这虽然不再污染 B 的内存 record，但旧 A 的 run 已经启动，可能在迟到 cancel 前执行工具或改仓。必须在 create 后、素材 await 后和 send 前都复查 `runningChats.get(task.id)?.instanceId === myInstanceId`；失效时直接 close 本地 Agent，绝不能调用 send。新增 `create pending → forceClear + B → A create resolve` 测试，断言 A.send 从未调用。

#### T4（P1）自动 compact 失败会并发启动两个 drain，FIFO 消息可能逆序发送

位置：

- `src/lib/server/chat-runner.ts:1985-2010`
- `src/lib/server/chat-runner.ts:2224-2247`
- `src/lib/server/chat-runner.ts:2537-2542`

`compactChatSession()` 无论成功失败都在 finally 里 `void flushChatQueue()`；自动 compact 失败回到 `maybeAutoCompactThenFlush()` 的 catch 后又 `await flushChatQueue()`。`flushChatQueue()` 入口只 `drainingQueues.add(taskId)`，没有发现已 draining 就 return，因此两个 drain 都能 dequeue。

若第一个 drain 取消息 1 后卡在 checkpoint，第二个 drain 取消息 2 并先完成 checkpoint，消息 2 会先调用 send；消息 1 随后看到 busy 才塞回队首，FIFO 已经被破坏。布尔型 in-flight 也会被任一 finally 提前清掉，容量再次失真。应把 drain 改成真正的 per-task single-flight owner（同步 check-and-set，非 owner 直接返回），并补“auto compact 失败 + 两条队列 + 第一条 checkpoint 阻塞”的顺序测试。

### P2 问题

#### T5（P2）compact 在重建成功前先写 `compact_done`；stop 命中重建阶段会被误报为 restart_failed

位置：`src/lib/server/chat-runner.ts:2474-2530`

代码关旧会话后先写 `compact_done` 和 `compact_summary`，之后才启动新会话。若 `Agent.create/send` 失败，事件流已经永久显示“已压缩”，但实际没有可用的新会话。若用户在 `await runChatSession()` 期间 stop，abort 已置位、restart run 也会被取消；返回后却没有再 `throwIfCompactAborted()`，于是按 `!hasChatSession` 抛 `restart_failed`，自动 compact 还会追加“自动压缩失败”，与用户主动停止的终态冲突。

需要把 done 事件放到可确认提交之后，或至少区分 prepare/commit；`await runChatSession()` 后先检查 abort，再判断 restart_failed。补 restart create/send pending 时 stop，以及 restart 失败不得留下 compact_done 的测试。

#### T6（P2、工程门禁）默认 `pnpm test` 在全量并发下不稳定

本轮默认命令首次运行结果为 57 文件中 2 文件失败、596 项中 3 项失败：checkpoint Git 测试撞 5 秒 timeout，并连锁残留 ref；reconnect 定时测试观察到第二次 resume。两个失败文件单独复跑全部通过，限制 `--maxWorkers=4` 后 596/596 通过，说明是默认并发/超时配置脆弱，而非稳定的断言失败。

CI/发布门禁应固定合理 maxWorkers，Git/真实计时测试应按最坏负载设置独立 timeout，并保证 timeout 后 finally 清临时 refs/进程。否则相同代码在机器负载不同的情况下会随机红灯。

### 第十三轮验收结论

**不通过。** S8 明确不改；先修 T1–T4 的生命周期与单飞竞态，再处理 T5/T6。修复方向应统一到 per-task operation lease（start/stop/delete/rewind/compact）与单 owner drain，而不是继续给各路径增加互不继承的局部布尔值。

---

## 第十二轮验收（Codex、2026-07-18、全面复核）

### 已确认通过的修改

- 第十轮 M1 的 **follow-up** 路径已正确补上共享取消闭包、`agent.send()` resolve 后实例复查、`setTaskRunStatus("running")` 后二次复查；pending-send stop / 替换实例 / send 抛错测试均有效。
- resume owner 的 instance token、`cancelled | owner_invalid` 终态、stale release 严格 no-op、reconnect backoff stop registry 均已落地；旧 owner 不再越权操作替换实例。
- `consumeChatRun` 的取消/失败清队增加实例门控；stop 后 stream 异常不再覆盖成 error。
- rewind 的 tree preflight、pre-rewind 安全点、跨仓失败回滚、truncate 后前滚、checkpoint ref 引用计数和真实 `git gc --prune=now` 测试方向成立。
- 发送失败保留草稿/附件、发送与重发飞行锁、分页渲染条数对齐、pending/loading 并存、删除 tombstone、events append 串行化、MR host PAT allowlist、分支名与 custom skill 路径校验等修改未发现新的 P1。

### 阻塞项

#### S1（P1）新会话启动预约不是可取消 lease，DELETE/停止只能删共享 bit，旧请求仍能为已删除任务启动 agent

位置：

- `src/lib/server/chat-gate.ts:66-79`
- `src/app/api/tasks/[id]/chat-reply/route.ts:485-489`
- `src/app/api/tasks/[id]/chat-reply/route.ts:600-625`
- `src/app/api/tasks/[id]/route.ts:230-248`

`tryReserveChatStart()` 只在 `Set` 里放一个 taskId，不返回 owner token，也没有 cancelled generation。chat-reply 占位后会 await 更新检查、全仓 checkpoint、事件和状态写盘；DELETE/stop 在这个窗口调用 `releaseChatStart()` 只会把共享 bit 删除，原请求没有任何办法知道自己的预约已经被撤销，也从不在 await 后复查。

可复现时序：请求 A 占启动位 → checkpoint 挂起 → 用户从侧栏删除对话 → DELETE 看不到 `runningChats`，释放启动位并删除 task → A 的 checkpoint 返回；`appendEvent` / `setTaskRunStatus` 即使因 meta 已删返回 null，A 仍无条件调用 `runChatSession(staleTask)`，为已删除任务注册 `runningChats`、创建 SDK agent。停止接口也存在同一协议缺口，只是正常 UI 在写 running 前未必展示停止按钮。

修法应把 start reservation 改成实例化 lease（`taskId + generation/token + cancelled`）：预约 owner 在每个 await 后、尤其是任何 user_reply/status 副作用前和 `runChatSession` 前验证 lease；DELETE/stop 取消 lease，而不是无条件删除共享位。`runChatSession` 入口也应接收并消费 token，避免调用方漏检。必须补 route 级故障测试：reserve → checkpoint pending → DELETE/stop → checkpoint resolve；最终不得 append user_reply、不得置 running、不得调用 `Agent.create`，也不得留下 gate/queue/runner 状态。

#### S2（P1）首包 `Agent.send()` 迟到仍可覆盖替换实例；取消后的异常会把 stop 重新标成 error

位置：`src/lib/server/chat-runner.ts:926-1000`

上一轮 M1 只修了 `sendChatMessage()` 的 follow-up 路径，首包 `runChatSession()` 仍在 `await agent.send()` 后先读取“当前” record 并盲写 `agentId/agent`、落盘 sessionAgentId，之后才检查本地 `cancelled`：

1. 首包实例 A 卡在 `agent.send()`；
2. 用户切模型/目录或 stop，等待超时后 `forceClear`，实例 B 注册；
3. A 的 send 迟到 resolve；
4. A 把 B 的 record.agent/agentId 覆盖成 A，并把 A 的 agentId 落盘；随后 `finishCancelled()` 因 instanceId 门控不会关闭 B，于是被污染的 B 继续存活。

同一路径的 `catch` 无条件调用 `handleChatRunFailure()`。stop 若让 Agent.create/send reject，代码会在“用户停止了对话”之后追加 error 并把 runStatus 从 idle 改成 error。stop 恰好发生在 `Agent.create()` 返回前时还有资源泄漏：本地 `agent` 已创建，但占位 record 的 `agent` 仍是 null，`finishCancelled()` 关不到它。

首包路径必须复用 follow-up 的协议：create/send 每个 await 后先验证 `cancelled + myInstanceId`，任何 record/persist/status 副作用都在验证之后；取消 catch 走 `finishCancelled` 而非 failure；未挂载的本地 agent 显式 close。补三条真实竞态测试：send pending 后 stop、send pending 后 forceClear+B、create resolve 前 stop；分别断言不写 error、不污染 B、旧 run/agent 被关闭。

#### S3（P1）compact 的 stop 不是整个事务的终止信号，取消摘要后会重试并重建新会话

位置：`src/lib/server/chat-runner.ts:2155-2230`、`src/lib/server/chat-runner.ts:2297-2373`

`runChatSummarizeOnesHot()` 的共享闭包只能标记“本次 send 被取消”。stop 调用包装 cancel 后没有摘除/关闭该 session，也没有留下 compact 级 stop token；finally 只把旧 record 的 `runActive=false`。外层 compact 把 `summarize_failed: 摘要被取消` 当普通失败，立即进入第二次摘要尝试。第二次没有继承“用户已停止”，成功后仍会关旧会话、写 compact 事件、置 running 并 `runChatSession()` 重建，直接把已停止的 AI 复活。

即使摘要已经成功，stop 发生在“摘要完成 → 读凭据 → 关旧 → 写事件 → 重建”之间也没有任何检查，仍会继续重建。应给整次 compact 分配 operation token/stop latch；stop 命中后必须是不可重试终态，关闭精确实例、禁止第二次摘要、禁止重建和 finally flush 复活队列。补真实调用链测试覆盖：状态写盘窗口 stop、摘要 send/stream pending stop、摘要完成到重建之间 stop。当前 `chat-runner-compact-gate.test.ts` 只测 not_found/not_chat/no_session 入口门闩。

#### S4（P1）队首塞回会静默丢掉另一条已返回 202 的消息，测试反而把数据丢失写成正确预期

位置：`src/lib/server/chat-queue.ts:112-130`、`tests/chat-queue.test.ts:104-120`

`flushChatQueue()` 先 dequeue 一条旧消息，再 await checkpoint/send。这个窗口队列少一个空位，新消息可以成功 enqueue 并拿到 HTTP 202，把队列重新填满；若旧消息因 busy/失败需要塞回，`enqueueChatMessageFront()` 生成 MAX+1 后直接截断队尾。被丢的“最新一条”同样已经返回 202，只是尚未落 user_reply；console.warn 不能弥补交付承诺，前端会留下永久 pending 气泡。

现有测试明确断言 `user-5` 被丢弃，等于把 bug 固化成契约。容量判断必须把 drain in-flight 条目计入占用、预留回插槽，或允许短暂 MAX+1；任何已经接受的消息都不能在内部静默丢弃。若容量不足只能在返回 202 前拒绝。补 route + drain 真并发测试：队满、dequeue 后新请求入队成功、旧 send 返回 busy；最终所有已 202 消息都必须保留且 FIFO。

### P2 问题

#### S5（P2）preview 只检查组长 PID，组长先退出时会漏掉仍存活的子进程组

位置：`src/lib/server/preview-manager.ts:252-259`

SIGTERM 发给进程组后，轮询只看 `processAlive(pid)`（组长）。若 shell/组长先退出、某个 dev-server 子进程忽略或延迟处理 TERM，代码会提前 return，不再对仍存在的 `-pid` 进程组发 SIGKILL，留下占端口的孤儿。旧实现固定等待后对进程组补 KILL，反而没有这个缺口。应检测进程组是否仍存在（Unix 可 `kill(-pid, 0)`）而非只查组长；测试要使用“组长 TERM 退出 + 子进程忽略 TERM”的 detached process group，而不是单个 `sleep`。

#### S6（P2）输入历史仍不能连续按 ↑ 上翻

位置：`src/components/composer-editor.tsx:628-665`

第一次 ↑ 后 `applyHistoryText()` 用 `$getRoot().selectEnd()` 把光标放在历史文本末尾；下一次 ↑ 进入 `histIndexRef.current >= 0` 分支，却返回 `atDocStart`，此时 offset 是文本长度而不是 0，所以命令不再接管。第十一轮报告声称“输入历史可连续上翻”，代码与声明相反。历史态应允许光标处在本插件设定的末尾（或显式记录 selection），并补至少三条历史连续 ↑ / ↓ 回草稿的交互测试。

#### S7（P2）tool_result 的“8KB/16KB”上限按 JS 字符数实现，不是 UTF-8 字节上限

位置：`src/lib/server/tool-result-persist.ts:17-18`、`src/lib/server/tool-result-persist.ts:31-51`、`src/lib/server/tool-result-persist.ts:271-299`

`full.length` / `slice` 统计 UTF-16 code unit；8192 个中文字符约 24KB UTF-8，仍会被当成“未超 8KB”直接塞进 events.jsonl。现有测试只用 ASCII，所以“≤8KB 契约钉死”的结论并不成立，diff 的 16KB 同理。应使用 `Buffer.byteLength(..., "utf8")`，按 code-point 边界做字节截断，并增加中文、emoji 和后缀计入总预算的测试。

#### S8（已撤销，非 bug）工作台侧栏分组属于功能设计，不要求修改

位置：`src/components/app-sidebar.tsx:127-144`

用户已明确：本项目只找 bug，不在本轮调整功能设计。时间分组与业务状态分组都属于产品取舍，**不得按第十二轮原建议修改代码，也不计入验收问题**。

#### S9（P2、安全）飞书 BOE 自动打开白名单使用 substring，可被非飞书域绕过

位置：`src/lib/server/feishu-cli.ts:501-510`

`host.includes("feishu-boe")` 会把 `https://feishu-boe.evil.example/phish` 判为可信并自动 `open`。这里的输入来自 CLI stdout，既然目标是域名 allowlist，就必须做精确注册域/后缀判断，例如只允许 `feishu-boe.cn` 及其子域（如果还有官方 BOE 域，应显式列举），不能用任意 substring。现有测试只覆盖正常 `foo.feishu-boe.cn` 和完全不含关键字的 evil 域，需补混淆域用例。

### 产品/路线图记录（非 bug，不计入本轮验收，也不得据此擅自改功能）

1. Phase 2.2：侧栏只按标题过滤，没有“标题 + 首条消息全文”。
2. Phase 3.3：会话 diff 面板未实现，`chat-view.tsx` 仍明确写“会话改动面板已砍”。
3. Compact：没有单次 120 秒 timeout，只有 2 次尝试；Grok 资产清单建议 3 次重试 / 500 字下限。
4. 自动 compact：固定 `260_000 inputTokens`，不是模型 context window 的 85%；小上下文模型可能先撞上限再触发压缩。
5. 已明确延期的真实 index/worktree 双树语义、全仓 `git add -A` 性能专项仍未解决；这两项不应在发布说明里描述成已完成。

### 第十二轮验收结论

**不通过。** 先修 S1–S4 并补真实竞态测试，再处理 S5–S9；工程门禁全绿只能说明现有测试通过，不能覆盖当前测试未建模或直接断言为“允许丢失”的行为。修复时优先收口为统一的 per-task operation/instance lease，不要继续给首包、follow-up、compact、reconnect 分别堆互不继承的局部布尔标记。

---

## 第十一轮修复报告（Fable5、2026-07-18 凌晨、待复审）

### M1 修复（第十轮唯一阻塞项）

按第十轮意见落实「共享取消闭包 + send resolve 后实例复查」，并在继续自查中发现 resolve 后仍有一个 `await setTaskRunStatus("running")` 写盘窗口，一并闭合：

- `sendChatMessage`：await send 前把 `rec.cancel` 包装为共享取消闭包（记录 `cancelledDuringSend`、run 一旦受理立即补 cancel）；send resolve 后复查取消信号与 `runningChats` 实例（第一次复查）；**置 running 写盘完成后再复查一次**（第二次复查）——命中则 best-effort `run.cancel()`、按需 `closeChatSession`、撤销刚写入的 running（无新实例接管时回写 idle），返回 `cancelled | owner_invalid`，绝不 `consumeChatRun`。send 抛错且期间被 stop → 返 `cancelled` 而非 `send_failed`（防 mode 2 重放）。
- `runChatSummarizeOnesHot`（compact 摘要）：同款共享取消闭包；post-send 闭包改为包装转调旧 cancel、不裸替换。
- `tryChatAutoReconnect`：新增 `RECONNECT_STOPS` 停止闭包注册表（`cancelChatRun` 先触发它、再查 record，表空 gap 期间 stop 也能打进重连流程）；resume/send 受理后复查停止信号与实例，命中即关僵尸 claim、按已接管收尾，不落 error。
- 故障测试（`tests/chat-runner-resume-owner.test.ts` / `chat-runner-reconnect-race.test.ts`）：pending-send stop（owner / 非 owner / forceClear 换实例 / send 抛错）、**置 running 写盘窗口内 stop**、重连退避期间 stop，断言 run.cancel 必调、stream 不启动、runStatus 归位 idle。

### 第十一轮附加修复（多代理全库复审发现、Fable5 已修）

聊天核心（chat-runner / chat-reply / route）：

- `consumeChatRun` 取消/失败收尾的 `clearChatQueue` 加实例门控——迟到旧 run 不得清新实例队列；用户 stop 后 stream 异常收场改走 cancel 收尾（不再落 error 覆盖 stop 的 idle）。
- chat-reply：owner busy 入队成功后幂等补 `releaseChatRunClaim`（消「release 时 queue=0 → 门闩解除 → 入队后无人 drain」死局）；mode 2 R3 分支入队被拒（队满/门闩 409）不再触发 finally 整队补偿误清；DELETE 补 `releaseChatStart` + queue generation / context usage 清理。
- `flushChatQueue` 失败清队改为带 info 通知（含未送达条数、已送达不计入）；`enqueueChatMessageFront` 超上限丢队尾防 MAX+1。
- `compactChatSession`：`runChatSession` 后复查 `hasChatSession`，重建失败显式抛 `restart_failed`、不再 200 假成功；`deliverChatAskReply` 对 busy/compact/rewind 返 false 终态、不再落新会话与 compact 重建打架。
- `executeChatRewind`（chat-checkpoint）：truncate 成功后视为已提交、后置记账失败改**前滚**（补写 points/meta、关会话、按成功返回），不再回滚仓库/写回 events 制造半完成态；对应测试改约。

前端聊天链路：发送失败/409 保留草稿与附件（成功才清）、发送/重发/编辑加飞行锁防连点、输入历史可连续上翻、分页 firstItemIndex 与渲染管线统一、pending 不再压制 loading、幽灵 pending 清理与排队横幅数字修正、stop 丢弃排队消息 toast 提示、侧栏已读即时熄灭。

安全（全库复审）：MR 收件箱评论 host allowlist（P0：杜绝 PAT 打到任意 host）；loopback Origin 收紧为严格同源（堵本机跨端口 CSRF→密钥读取/preview RCE 链）；分支名 shell 引号与 argv 前导 `-` 校验；custom action skill 名白名单 + export 路径穿越断言；submit_mr 无记录时禁保护分支作 source；导入 bundle 剥 symlink。

持久化与进程层：events.jsonl per-task append 串行化；assistant 消息空值防护；tombstone 在 getTask/boot recovery 全链路生效；tool-output 截断 ≤8KB 契约钉死 + 原子写 + callId 确定性；`pidLooksOurs` 词边界匹配防误杀；`reapTaskOrphans` 支持跳过延迟二次扫（resume 路径不再误杀新 agent shell）；MR seen/ignored 陈旧快照覆盖写修复；mcp-probe 缓存 key 脱敏 + 上限；feishu-cli 下载超时/体积上限 + open 域名白名单；React hooks 卸载竞态与缓存误写共 10 处。

### 第十一轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：55 个测试文件、577 项全部通过（较第十轮 +34 项）
- `pnpm build`：生产构建通过

### 明确记录的遗留项（非本轮阻塞、待产品决策）

- kill-orphans 无法区分本 app 与 Cursor IDE 的同仓 agent shell（需跨进程指纹设计，夜间不冒险改）；SSE 背压、events.jsonl 轮转、preview 按仓分队列等运维项；P1 #3 真实 index/worktree 语义与 P1 #5 全仓快照性能仍按既定延期。

---

## 第十轮复审状态（历史，第十一轮修复报告见上节、待复审）

### 已确认修复

- L1：chat-reply、ask-reply、reconnect 和既有测试已全部迁移到 instance token；`resumeChatSession()` 返回 `number | null`，owner send/release 传同一 `ownerInstanceId`。typecheck、定向、全量和 build 已恢复全绿。
- L2：`sendChatMessage()` 改为结构化结果 `sent | cancelled | owner_invalid | busy | no_session | send_failed`。chat-reply 遇到 cancelled/owner_invalid 直接返回 409，ask-reply 直接失败，不再落到 mode 2 重启。
- L3：`releaseChatRunClaim()` 现在要求 record 存在且 instanceId 精确匹配，否则整段 no-op；迟到 owner 不再 drain 新启动队列。
- 新增 3 项测试分别验证：send 前 stop 后返回 cancelled 且不触达 agent；forceClear 后旧 owner send/release 不影响新实例；无 record 时 stale release 不改变新队列。
- 工程门禁：定向 62/62、完整 543/543、typecheck、lint、build、diff check 全部通过。

### 仍阻塞验收

#### M1（P1）stop 发生在 `await agent.send()` 内时，迟到 send 仍可把任务重新拉起

位置：

- `src/lib/server/chat-runner.ts:1475-1498`
- `src/lib/server/chat-runner.ts:1540-1580`
- `tests/chat-runner-resume-owner.test.ts:229-266`

当前 owner instance 校验只发生在调用 `agent.send()` 之前。`agent.send()` 本身是 await 点：若请求已通过 token 校验并进入 send，用户此时点击停止，claim record 的 cancel 会关闭并摘除该实例、stop 路由把任务归位 idle；但 send promise 随后仍可能 resolve 出一个 run。后续代码继续使用之前捕获的 `rec`，没有复查 `runningChats` 中是否仍是该 instance，直接刷新 lastActiveAt、await `setTaskRunStatus(...,"running")` 并调用 `consumeChatRun()`。

这会让 stop 响应之后任务重新显示 running；而 `consumeChatRun()` 此时读不到 record，无法安装真正的 `run.cancel()` 回调。如果 SDK 的 agent.close 没有保证让已受理/正在返回的 run 失败，该 run 仍会继续产出。非 owner 的正常 follow-up send 也有同一窗口。

应在 `agent.send()` resolve 后、任何 task 状态或 consume 副作用前，再次同步校验 `runningChats.get(task.id)?.instanceId === rec.instanceId`。若实例已失效，应立即 best-effort `run.cancel()`，根据 cancelled marker/实例状态返回 cancelled 或 owner_invalid，绝不能 set running/consume。更稳妥的是在 await send 前把 rec.cancel 改成共享取消闭包：先记录 cancelled，run 一旦可用就立即 cancel；这样 stop 发生在 send pending 期间也不会丢取消信号。

必须补故障测试：mock `agent.send()` 挂起 → 调用 owner send（已通过前置 token 校验）→ 在 promise 未 resolve 时执行 stop/cancelChatRun → 再让 send resolve fake run；最终 run.cancel 必须调用，task 不得重新置 running，consume/assistant 输出不得启动。现有 stop 测试是在调用 send 之前先 cancel，未进入这个关键 await 窗口。

### 第十轮验收结论

**仍暂不通过。** L1–L3 已正确修复且门禁全绿；当前只剩 M1 这一条实质 P1。补 send resolve 后的实例复查/取消接力及对应 pending-send 测试后，才建议通过正确性验收。

---

## 第九轮复审状态（历史，第十轮结论以上节为准）

### 已确认的正确方向

- `resumeChatSession()` 成功后返回本次注册的 instanceId，而非布尔；claimed record 的 cancel 会按该 instanceId 摘除自身。
- `sendChatMessage()` 新增 `ownerInstanceId`，在任何副作用前验证当前 record.instanceId；旧 owner 遇到 stop/forceClear 后的新实例会直接拒发，也不会修改新实例状态。
- `releaseChatRunClaim()` 增加 expectedInstanceId 参数；ask-reply 路径已改为保存 token 并传给 send。

### 阻塞验收

#### L1（工程门禁）instance-token API 迁移未完成，当前工作区不能通过类型检查和测试

位置：

- `src/app/api/tasks/[id]/chat-reply/route.ts:414-420`
- `tests/chat-runner-resume-owner.test.ts:123-214`
- `tests/chat-runner-reconnect-race.test.ts:157-177`

chat-reply 已保存 `ownerInstanceId` 并传给 send，但 catch/防御分支仍调用单参数 `releaseChatRunClaim(task.id)`；现有测试仍断言 resume 返回严格布尔 `true`，继续传 `{ownerClaimed:true}`，并以单参数调用 release。结果是 `pnpm typecheck` 报 7 个错误；两个定向文件 6 项中 5 项失败；全量 540 项中 5 项失败。当前也没有新增 K1 的 stop 与实例替换测试。

应先完成原子 API 迁移：所有 owner 路径保存 `number | null` token；send/release 一律传同一 instanceId；普通 resume 测试改断言返回非 null/数字；旧 `ownerClaimed` 全部删除。修复后再重新跑 typecheck、定向、全量和 build。

#### L2（P1）stop 使 owner token 失效后，chat-reply 仍会降级到 mode 2 重新启动 AI

位置：

- `src/lib/server/chat-runner.ts:1043-1061`
- `src/lib/server/chat-runner.ts:1418-1432`
- `src/app/api/tasks/[id]/chat-reply/route.ts:381-449`

stop 期间 claim cancel 会摘除原 record；owner checkpoint 完成后，`sendChatMessage(...ownerInstanceId)` 正确识别“当前无会话/实例已失效”并返回 false。但 route 只在 `hasChatSession()` 或 compact 为真时入队，否则继续落入 mode 2。stop 后恰好没有 session，于是旧请求会再次预约、再次 checkpoint、落 user_reply 并调用 `runChatSession()`，最终仍在“用户停止了对话”之后启动 agent。当前 token 只防止越权发送，没有防止调用方把取消误判为可重试故障。

`sendChatMessage` 需要返回结构化原因（例如 `sent | owner_invalid | busy | no_session | send_failed`），或提供等价的 claim 状态查询；chat-reply/ask-reply 遇到 `owner_invalid/cancelled` 必须终止该请求，不能进入 mode 2。必须补真实测试：resume claim → checkpoint 阻塞 → stop → 放行 checkpoint；最终 agent.send 和 runChatSession 都不得调用，runStatus 保持 idle。

#### L3（P1）失效 token 在当前无 record 时仍会调度 drain，迟到 owner 仍可影响别人的启动队列

位置：`src/lib/server/chat-runner.ts:373-383`

`releaseChatRunClaim()` 只有在“rec 存在且 instanceId 不匹配”时 no-op；若原 claim 已被 stop/forceClear 摘除、当前暂时没有 record，它仍会继续检查队列并调度 drain。此时队列可能属于另一个正在 startup reservation 的 owner；迟到 release 可提前 flush，在无 session 时清掉已返回 202 的队列，或在新 owner 前发送队首、破坏顺序。

实例化 release 应严格要求当前 record 存在且 instanceId 匹配：`if (!rec || rec.instanceId !== expectedInstanceId) return`。原 claim 已消亡时，不再承担任何 queue handoff 义务；新 owner/启动状态机负责自己的队列。

### 第九轮验收结论

**不通过。** 本轮是合理方向上的未完成迁移，工程门禁已红；即使补齐编译调用方，L2/L3 仍会让 stop 失效或让迟到 owner 干扰新队列。完成 API 迁移、让取消成为不可降级重试的终态、严格门控 release，并补两条 K1 竞态测试后再验收。

---

## 第八轮复审状态（历史，第九轮结论以上节为准）

### 已确认修复

- J1：`RunningChatRecord` 增加进程内单调 `instanceId`；新会话启动占位和每次 `Agent.resume()` 注册都会取新号，即使 SDK agentId 相同也能区分内存实例。
- `closeChatSession()`、auto-reconnect stale 判断、consume/cancel/error 的迟到收尾、send 失败收尾均改按 instanceId 门控；旧 retry 发现表内 instanceId 已变会直接让位。
- 新增 `tests/chat-runner-reconnect-race.test.ts`：三次 resume 均返回同一个 `AGENT_ID`，第一个 run 网络失败、reconnect prompt send 再失败；退避期间用户恢复同 ID 并启动挂起 run，旧 retry 醒来后不得 close/cancel 用户实例、不得发送 reconnect prompt。测试覆盖了第七轮要求的完整时序，J1 可关闭。
- 工程门禁继续全绿：定向 59/59、完整 540/540、typecheck、lint、build、diff check 均通过。

### 仍阻塞验收

#### K1（P1）resume claim 不可取消且未绑定 instanceId，停止可失效、旧 owner 可越权发送到新实例

位置：

- `src/lib/server/chat-runner.ts:287-295`
- `src/lib/server/chat-runner.ts:1031-1044`
- `src/lib/server/chat-runner.ts:1390-1424`
- `src/app/api/tasks/[id]/chat-reply/route.ts:375-433`
- `src/lib/server/stop-task.ts:45-56`

`resumeChatSession(..., {claimRun:true})` 注册 record 时用 `runActive=true` 表示认领，但 `cancel` 固定为空函数。chat-reply 随后会在真正 `agent.send()` 前 await 全仓 checkpoint。若用户在此窗口点停止，`cancelChatRun()` 因 runActive 调用这个空 cancel 并返回 true；stop 路由继续清队、落“agent 已中断”并把 runStatus 设为 idle。owner 的 checkpoint 完成后没有任何 cancelled/instance 校验，仍以 `ownerClaimed:true` 调 `agent.send()`，AI 会在“已停止”之后开始运行。

同时，`ownerClaimed` 只是布尔值。`sendChatMessage()` 读取的是调用当下 `runningChats.get(task.id)`，只要 ownerClaimed 为 true 就跳过该 record 的 `runActive` 检查，并不验证它是否还是原 claim 的实例。另一请求切换模型/MCP/workdir时会 cancel、等待 5 秒、超时后 forceClear 并启动新实例；若旧 owner 的 checkpoint 更晚完成，它可把自己的消息发给新实例，甚至绕过新实例的 runActive 与其并发 send。旧 owner 的 catch 里调用无实例参数的 `releaseChatRunClaim(task.id)`，也可能把新实例的 runActive 错误清成 false。

修法应把 claim 变成实例化 token，而不是布尔标记：`resumeChatSession` 成功时返回 claim/instanceId；`sendChatMessage` 使用 `ownerInstanceId` 并要求当前 record.instanceId 精确匹配，否则不得 send 或修改当前 record；`releaseChatRunClaim` 同样必须带 expectedInstanceId。claimed record 的 cancel 必须记录 cancelled 并摘除/释放该实例，让 stop 真正阻止后续 owner send。

至少补两条测试：

1. resume claim → checkpoint 尚未完成时调用 `cancelChatRun`/stop → owner send 必须返回 false，agent.send 不得调用，会话与 runStatus 不得重新启动。
2. claim 实例 A → forceClear → 注册并启动实例 B → A 的 owner send/release 必须因 instanceId 不匹配而 no-op，不能发送到 B、不能把 B.runActive 清零。

### 第八轮验收结论

**仍暂不通过。** J1 的实例代际修复和并发测试均符合要求；当前阻塞是 K1 这一条实质 P1。把 owner claim 也纳入 instance token/cancel 状态机，并补停止与实例替换测试后，才建议通过正确性验收。

---

## 第七轮复审状态（历史，第八轮结论以上节为准）

### 已确认修复

- H1：`releaseChatRunClaim()` 在认领释放且队列非空时调度 deferred drain；若 rewind 门闩仍在则轮询等待，门闩解除后调用 `flushChatQueue()`。rewind 成功时队列已清空、补 drain no-op；rewind 因队列拒绝时，补 drain 会继续发送已接受消息。
- H1 测试不再只看 `runActive`：新增用例实际 enqueue B，令 owner A 撞 rewind 后释放 claim，再解除门闩，最终断言 B 进入 `agent.send()` 且 queueCount 归零。这条测试覆盖了第六轮要求的核心交付保证。
- auto-reconnect 的 prompt send 失败后不再仅置 `runActive=false`，而是立即把该内存会话从 `runningChats` 摘除，避免坏实例直接以 idle 状态暴露。
- 工程门禁继续全绿：定向 58/58、完整 539/539、typecheck、lint、build、diff check 均通过。

### 仍阻塞验收

#### J1（P1）reconnect 用持久化 `agentId` 充当内存实例代际，仍会误关同 ID 的新用户 run

位置：

- `src/lib/server/chat-runner.ts:980-1014`
- `src/lib/server/chat-runner.ts:1114-1131`
- `src/lib/server/chat-runner.ts:1176-1187`

本轮用 `staleAgentId` 判断退避期间是否出现“新会话”：只有 `cur.agentId !== staleAgentId` 才让位。但 chat-reply 在内存表为空、落盘 `sessionAgentId` 仍保留时，会执行 `Agent.resume(task.sessionAgentId)`；恢复的是同一个持久化 agent，新 `RunningChatRecord` 的 `agentId` 完全可以与 stale ID 相同。代码本身也把 `sessionAgentId` 作为 resume 锚点，并把 SDK 返回的同一身份重新写回 record，因此 `agentId` 不是唯一的内存实例 generation。

仍可复现：reconnect prompt 首次 send 失败 → catch 摘除 record、保留 sessionAgentId 并进入退避 → 用户 chat-reply 在退避期间 resume 同一个 agentId、发送消息并开始 consume → reconnect 醒来看到 `cur.agentId === staleAgentId`，误以为还是坏实例 → `closeChatSession(task.id, staleAgentId)` 关闭/取消用户刚启动的 run。旧用户 run 的迟到收尾也继续用相同 agentId 门控，可能再误关后续恢复实例。

这里需要的是每次写入 `runningChats` 都唯一的 instance generation/lease，而不是 SDK agentId：例如 record 增加单调 `instanceId`，reconnect 捕获 stale instanceId，醒来只在 instanceId 仍相同时 close；或建立 per-task reconnect epoch，用户 resume/send 成功即使旧 retry 失效。也可以在 reconnect 期间用独占 gate 让 chat-reply 入队，并由 reconnect owner 统一交接。

必须补 H2/J1 的真实测试：两次 `Agent.resume()` mock 返回同一个 `AGENT_ID`；第一次 reconnect prompt send 失败后，在退避期间恢复同 ID 并启动用户 run；旧 retry 醒来不得 close/cancel 新实例。当前新增测试文件只增加了 H1 用例，没有任何 reconnect 退避并发测试。

### 第七轮验收结论

**仍暂不通过。** H1 已按要求闭合并有有效故障测试；当前只剩 J1 这一条实质 P1。把重连门控改成真正的实例代际/lease，并补“同 agentId 二次 resume”的并发测试后，才建议通过正确性验收。

---

## 第六轮复审状态（历史，第七轮结论以上节为准）

### 已确认修复

- 通用 `resumeChatSession()` 不再自行 flush 队列；`claimRun:true` 在会话注册时同步认领首发，普通 `sendChatMessage()` 会被 `runActive` 挡住。
- chat-reply 的 resume winner 使用 `ownerClaimed:true` 先发送自己的消息，随后由 run 结束后的统一 flush 处理已排队输家；正常并发时序恢复为 A → B。
- `deliverChatAskReply()` 使用同一 owner 协议；auto-reconnect 也在 `agent.send(reconnectPrompt)` 前已经处于 claimed 状态。第五轮指出的正常路径顺序反转和同会话双 send 已闭合。
- 新增 `tests/chat-runner-resume-owner.test.ts`，4 项状态测试通过；完整工程门禁 538/538 通过。

### 仍阻塞验收

#### H1（P1）owner 发送前释放 claim 时没有移交/推进已接受队列，202 消息仍可永久悬空

位置：

- `src/lib/server/chat-runner.ts:341-347`
- `src/lib/server/chat-runner.ts:1324-1348`
- `src/app/api/tasks/[id]/chat-reply/route.ts:378-417`
- `src/lib/server/chat-runner.ts:1490-1665`

`releaseChatRunClaim()` 和 `sendChatMessage()` 的 owner early-return 只执行 `runActive=false`，不会检查或推进队列。可复现时序：请求 A 占 resume reservation 并注册 claimed session；请求 B 在 A resume 期间预约失败、入队并拿到 202；A 在 checkpoint 后准备 send 时发现 rewind 门闩，释放 claim 并返回 false；路由因 rewind 门闩不能把 A 入队而返回 409。rewind 随后会因为 B 仍在队列而拒绝，门闩最终释放，但此时会话是 idle、B 仍在队列，既没有 run 完成事件，也没有其他自动 flush 触发点，B 会永久悬空。

同类问题也存在于 owner send 前的异常 catch：认领被释放，但并发输家已经拿到 202，仍无人接管。新增测试只断言“rewind 下释放后 `isChatRunActive=false`”，恰好没有放入一个排队消息并证明它最终被发送，因此没有覆盖真正的交付保证。

需要把“释放 claim”升级为明确的 owner handoff：只要队列非空，就必须在 gate 解除后可靠调度 drain，或由统一 per-task 状态机把 owner payload 与队列一起转移；不能留下 `session idle && queueCount>0 && !draining`。至少补一条故障注入测试：A resume claimed、B 入队、A owner-send 被 rewind/异常阻断、rewind 又因 B 拒绝，最后 B 仍会被发送或得到明确失败，而不是停在内存中。

#### H2（P1）auto-reconnect 的 send 失败重试期暴露 idle session，下一轮可关闭刚启动的用户 run

位置：`src/lib/server/chat-runner.ts:1100-1145`

reconnect prompt 的 `agent.send()` 抛错后，catch 先把 `rec.runActive=false`，再递归进入带退避的下一次 reconnect；旧 session 在这段 2/4 秒窗口仍保留在 `runningChats`。普通 chat-reply 此时会把它视作可用 idle session 并启动用户消息。递归重试醒来后却无条件按当前 agentId 调 `closeChatSession()`，会关闭/取消刚启动的用户 run，再恢复会话并发送 reconnect prompt。

重连状态需要跨重试保持互斥所有权，或第一次 send 失败后立即关闭/摘除旧 session，再进入退避；下一次 close 前也应验证没有新的 active run/owner。应补真实测试：reconnect send 首次失败 → 退避期间用户发消息 → 重试不得取消或越过该用户消息。

### 测试覆盖评价

`tests/chat-runner-resume-owner.test.ts` 能证明 claim 标志的基本行为，但不是第五轮要求的 chat-reply / ask-reply / reconnect 调用链并发测试。当前没有断言真实发送顺序 A → B，也没有覆盖 claim 释放时已有 queue、reconnect retry 期间插入用户消息。因此“测试全绿”不能反证 H1/H2。

### 第六轮验收结论

**仍暂不通过。** 正常 owner-first 主路径已经修正，方向合理；当前阻塞缩小到两个失败路径 P1。修复 H1/H2 并补上述故障注入/并发调用链测试后，才建议通过本轮正确性验收。

---

## 第五轮复审状态（历史，第六轮结论以上节为准）

### 已确认修复

- F2：compact 先完成只读 task/mode 校验，再进入无 await 的“占 compact → 查 rewind → 复查 run/session”临界区；`no_session` 不再产生可被并发 chat-reply 观察到的长置位窗口。新增 `tests/chat-runner-compact-gate.test.ts`，3 项通过。
- F3：preview fixture 不再在断言前 `unref()`，改等 ChildProcess `exit`；此前沙箱红灯的根因是 sandbox 禁止 `ps`，不是产品 kill 失败。沙箱外单文件 7/7、全量 534/534 均通过。
- 无会话 drain 清队前会写明确 info，避免“202 后静默消失”；这是有价值的失败可见性兜底。

### 仍阻塞验收

#### G1（P1）通用 resume auto-flush 没有 owner 语义，会反转消息顺序并与直属 send 竞态

位置：

- `src/lib/server/chat-runner.ts:996-1002`
- `src/app/api/tasks/[id]/chat-reply/route.ts:321-360`
- `src/lib/server/chat-runner.ts:1095-1124`
- `src/lib/server/chat-runner.ts:1394-1400`

F1 的永久悬空已经消除，但修法把“发现队列就 `void flushChatQueue()`”放进所有调用方共用的 `resumeChatSession()`，缺少“这次 resume 是替谁恢复、谁应该先发”的信息，产生两类错误：

1. chat-reply 请求 A 先到并占 resume reservation，请求 B 后到、预约失败后入队。A resume 成功立即 dequeue/flush B；A 回到路由后看到 `draining`，又把 A 自己入队。最终发送顺序是 B → A，与 reservation 已确定的到达顺序 A → B 相反。消息都送达了，但聊天语义可能被改写。
2. `deliverChatAskReply()` 在 resume 返回后立即 `sendChatMessage()`；`tryChatAutoReconnect()` 也立即直接 `rec.agent.send(reconnectPrompt)`，并且后者直到 `await agent.send()` 之后才置 `rec.runActive=true`。此时 resume 启动的 flush 可能仍在 getTask/checkpoint 阶段，这两个调用方都不检查 `draining`，可与 flush 对同一 agent 并发 send；自动重连场景还可能先发送重连期间排队的新消息，再发送“继续中断回复”的系统提示。

不要在通用 resume 内无条件 drain。应让 reservation 同时持有 owner payload/动作，并在会话注册后原子决定第一条：chat-reply owner、ask 答案或 reconnect prompt 先送达，再由 run 完成后的统一 flush 排后续队列。若要按真实到达时间合并，队列与 owner 都需稳定 sequence/enqueuedAt，并补三条调用链的并发测试。

### 第五轮验收结论

**仍暂不通过。** 工程门禁在具备 `ps` 权限的真实环境已全绿，F2/F3 符合要求；当前只剩 G1 这一条实质 P1，但它会改变消息顺序或对同一 SDK 会话并发 send，修完并补 resume/chat-reply/ask-reply/reconnect 调用链测试后才建议通过。

---

## 第四轮复审状态（历史，第五轮结论以上节为准）

### 已确认修复

- N1 原问题：`resumeChatSession()` 已在任何 await 前占 `tryReserveChatStart()`，注册 `runningChats` 前复查 rewind/并发会话，并关闭被抢占的 agent；“回退完成后旧 SDK 会话重新挂回来”的路径已闭合。
- N2：compact 已改为同步“先占 compact、再查 rewind”，与 rewind 的“先占 rewind、再查 compact”形成交叉互斥。
- N3：启动 owner 的所有 early return 现在都经过 finally 补偿；dequeue 后失败会把 head 塞回，已落事件时补 `skipPersistEvent`；清队在 best-effort info 之前执行。
- N4：checkpoint refs 的 prune 已移到 `writeMeta()` 提交点之后；新增测试在 meta 写失败后真实执行 GC 并再次 rewind，验证对象仍可达。
- 已提交 rewind 后 `getTask()` 连续失败改为 HTTP 200 + `refreshRequired`，前端提示刷新，不再诱导重试破坏性请求。

### 仍阻塞验收

#### F1（P1）并发 resume 的输家入队后，赢家恢复的是 idle 会话，没有任何 drain 触发点

位置：

- `src/lib/server/chat-runner.ts:935-1017`
- `src/app/api/tasks/[id]/chat-reply/route.ts:321-360`

新 reservation 阻止了两个 resume 相互覆盖，但没有处理等待队列。可复现时序：请求 A 占预约并等待 `Agent.resume()`；请求 B 因预约失败转入 mode 2，再次预约失败后入队并拿到 202；A 恢复成功得到一个 `runActive=false` 的 idle session，随后在 chat-reply 的“队列非空”分支把 A 自己也入队并返回 202。此时没有 run 会自然结束，也没有任何地方调用 `flushChatQueue()`，两条消息会永久留在内存队列；之后新消息也只会继续入队。

resume owner 成功后必须接管已有队列：要么立即 drain 队首，要么让 chat-reply 在“刚 resume 成功 + queue 非空”时按队列优先发送 head；不能把当前请求继续追加后直接返回。

#### F2（P1）compact 在确认有可用会话前就置 in-progress，失败时会清掉并发请求已成功入队的消息

位置：

- `src/lib/server/chat-runner.ts:1694-1735`
- `src/lib/server/chat-runner.ts:1831-1834`
- `src/lib/server/chat-runner.ts:1482-1489`
- `src/app/api/tasks/[id]/chat-reply/route.ts:316-318`

为修 N2，compact 现在在 `await getTask()` 和 `hasChatSession()` 校验之前就置位。若服务重启/空闲回收后当前没有内存会话，compact 最终抛 `no_session`；但这段等待期间 chat-reply 看到 compact 标记会入队并返回 202。compact 的 finally 随后调用 flush，flush 发现没有会话就直接 `clearChatQueue()`，没有错误响应或 info 事件，刚才的消息静默丢失。

可先完成只读 task/mode 与“当前确有 session”的前置校验，再进入无 await 的“占 compact → 查 rewind → 复查 session/run”临界区；或者让失败 finally 对已接受队列启动/恢复会话，而不是静默清队。

#### F3（P2）preview 集成测试修改没有解决红灯，只把失败等待从 2.5 秒延长到 10 秒

位置：`tests/preview-manager.integration.test.ts:220-242`

单文件和全量测试都稳定失败在 `waitUntil(() => !isAlive(stalePid), 10_000)`。该 fixture 对 detached child 调了 `unref()`，而 `process.kill(pid, 0)` 可能把尚未被测试进程回收的 zombie 也视作“存在”；纯延长轮询不能证明进程仍在运行，也不能修复测试。应等待 ChildProcess 的 `exit/close`（不要在断言前 unref），或用 `ps` 状态把 `Z` 视为已退出；若实际进程组确实没被杀，再修产品代码。当前改法还让每次全量失败额外多等约 7.5 秒。

### 第四轮验收结论

**暂不通过。** 上一轮四项核心意见本身基本落实，但 F1、F2 仍会让已返回 202 的用户消息永久悬空或静默丢失，必须修复并补 chat-reply/resume/compact 真并发测试。preview 门禁也仍是红色。

---

## 第三轮复审状态（历史，第四轮结论以上节为准）

### 本轮已确认修复

- 上一轮 R1 的 queue drain 主竞态已闭合：flush 在 dequeue 前同步占 `draining`，rewind 占门闩后复查；`clearChatQueue()` 递增 generation，旧 drain 不会在 stop/rewind 后重新塞回；chat-reply 入队前也同步复查 rewind 门闩。
- 上一轮 R2 的主要事务缺口已补：所有安全快照成功后才开始破坏；当前失败仓也参与回滚；events 原文与 rewind_points 在后置写盘失败时恢复；info 写失败不再把已提交 rewind 判失败。
- 上一轮 R4 已按建议撤掉“立即发送”，不再用客户端 stop + 重放模拟原子事务；完整 pending payload 暂时保留但没有危险入口。
- 上一轮 R5 的确认文案已准确说明：原 staged/unstaged 区分无法恢复，回退内容可能全部处于 staged。
- 删除任务前已调用 `cleanupCheckpointRefsForTask()`；正常路径下可清掉该 task 的 checkpoint refs。
- Read / Write 工具批仍保持撤回状态，Windows prompt 仍是最小失败纪律。

### 仍阻塞验收

#### N1（P1）`resumeChatSession()` 没进入 rewind/start 门闩，回退完成后可能把旧 SDK 会话重新挂回来

位置：

- `src/lib/server/chat-runner.ts:929-970`
- `src/app/api/tasks/[id]/chat-reply/route.ts:320-332`

chat-reply 只在请求入口检查一次 rewind，随后 `resumeChatSession()` 要 await MCP 探测和 `Agent.resume()`，但它既不占 `startReservations`，也不在注册 `runningChats` 前复查 rewind。可复现时序是：旧会话恢复开始 → rewind 占门闩并完成文件/事件恢复，且当时看不到 run/reservation → rewind 关闭会话时内存表还是空的 → `Agent.resume()` 晚到并把回退前旧会话重新写入 `runningChats`。紧随其后的用户消息就可能发送到包含已截断历史的旧会话。

这也允许两个并发 resume 都通过 `runningChats.has()===false`，后到者覆盖前者。resume 应在任何 await 前占用和新会话启动同一门闩/预约，并在注册会话时完成原子交接；失败或被 rewind 抢占时关闭刚恢复的 agent。

#### N2（P1）compact 与 rewind 的交叉门闩仍按错误顺序实现，代码注释与实际代码相反

位置：

- `src/lib/server/chat-runner.ts:1683-1703`
- `src/lib/server/chat-checkpoint.ts:643-646`

checkpoint 侧声明的契约是“compact 先 set，再查 rewind；rewind 先占门闩，再查 compact”，但实现仍是 compact 先读 `isChatRewindInProgress()`，经过其他检查后才 `setChatCompactInProgress(true)`。两边可以各自在对方置位前通过检查，随后并发关闭/重建 session、写 events 和 runStatus。

应把 compact 的同步临界区改为“先原子占 compact，再复查 rewind；命中则立刻释放 compact 并返回 409”，或直接把 rewind/compact/start 合并到一个 per-task exclusive gate。现有测试只 mock `isCompactInProgress=true` 验证 rewind 单边拒绝，没有制造两边同时起跑的竞态。

#### N3（P1）并发首条的 owner 失败补偿仍不完整：早退绕过 catch，已 dequeue 的队首也会静默丢失

位置：`src/app/api/tasks/[id]/chat-reply/route.ts:419-552`

本轮增加了“队列优先启动”和 catch 清队，但仍有三个失败窗口：

1. owner 占到 reservation 后 await `checkUpdatePendingRestart()`；并发输家可在这段时间入队并拿到 202。若 owner 随后 `return 409`，`return` 不进入 catch，只执行 release，输家队列无人消费。
2. 队列分支先把 head dequeue，再做 checkpoint/event/meta。后续任一步抛错时 catch 只统计和清理“剩余队列”，head 已经不在队列、也没有重新入队；拿到 202 的那条 head 会静默丢失，提示数量也少一条。
3. catch 在 `clearChatQueue()` 前先 await `appendEvent()`；若诊断事件写盘也失败，真正的清队补偿不会执行。

预约 owner 需要统一的 `finally`/状态机：所有未启动出口（包括返回 Response）都处理等待者；dequeue 后在会话完成同步注册前，head 必须仍有可恢复所有权；清队应放在不会被 best-effort 日志阻断的 finally 中。现有测试没有并发双 POST 或故障注入覆盖该路由。

#### N4（P1）rewind 失败回滚会恢复 JSONL 引用，却可能已删除对应 Git refs

位置：`src/lib/server/chat-checkpoint.ts:937-985`

成功路径先写 `finalPoints`，随后立即 prune 被丢弃 checkpoint 的 refs，最后才写 meta。若 `writeMeta()` 失败，catch 会把 rewind_points 恢复成 `lockedPoints + safetyPoint`，但不会把刚删除的旧 refs 建回来。对包含 dirty/untracked 内容的唯一 tree，之后一次 `git gc --prune=now` 就可能清掉对象；JSONL 看似恢复，实际检查点已不可恢复。

应把 prune 挪到最后一个可失败的提交写之后并作为提交后清理，或在 catch 恢复 points 后对全部恢复点重新 `syncCheckpointRefs()`。现有 meta 失败测试只断言 JSONL 里的点回来，没有再跑 GC 验证对象仍可达。

### 非本轮新增、仍需接受或专项处理

- P1 #3：当前只修正了确认文案；checkpoint schema 仍只有 worktree 合并 tree，真实 staged/unstaged 边界无法恢复。
- P1 #5：每条用户消息前同步全仓 `git add -A` 未改，Windows 大仓首包性能风险仍在。
- 提交后 `getTask()` 连续失败时，代码会用 404 返回“回退已完成、但读取任务失败”。文案比上一轮清楚，但 HTTP 仍把已提交操作表示成失败；建议返回成功 + `refreshRequired`，避免通用客户端重试破坏性请求。
- `cleanupCheckpointRefsForTask()` 只从当前 rewind_points 推导 repo。若历史 prune/delete ref 曾失败、旧 repo 已不在当前点中，删除任务时仍可能留下孤儿 ref；属于存储泄漏 P2，可在 task 元数据持久化 repo 清单或全局维护 ref 索引后解决。
- 需求覆盖缺口 4 项（侧栏全文搜索、会话 diff 面板、compact 超时、85% 阈值）仍是 scope 决策。

### 第三轮验收结论

**暂不通过。** R1 的 drain 部分、R2 的主要文件事务、R4 和 R5 已可验收，但 N1–N4 都是可导致旧会话复活、消息静默丢失或恢复点失效的正确性问题；至少应修完并补真并发/故障注入测试后再过。

---

## 上一轮复审状态（历史，第三轮结论以上节为准）

### 已确认修复

- Read / Write 工具批：按专项意见整批撤回，最小失败纪律保留。
- P2 #10：repo-files 首扫加入 per-root in-flight Promise，前端加入 AbortController；定向测试通过。
- P2 #11：完整输出写盘失败不再返回 `fullPath`，前端只在 `truncated && fullPath` 时显示按钮；定向测试通过。
- P1 #4 的主要问题：checkpoint tree 建立 `refs/ai-flow/checkpoints/<taskId>/<treeOid>` 后，真实执行 `git gc --prune=now` 仍可恢复；共享 treeOid 的裁剪引用计数测试通过。
- P2 #9 的附件-only占位文案已统一，`onDone` 不再无条件清空横幅。

### 仍阻塞验收

#### R1. Rewind 门闩仍会与“已出队但尚未 send”的 drain 及迟到 chat-reply 竞态，消息可能被清掉或回退后复活

位置：

- `src/lib/server/chat-checkpoint.ts:682-749`
- `src/lib/server/chat-runner.ts:1418-1499`
- `src/app/api/tasks/[id]/chat-reply/route.ts:340-411`
- `src/app/api/tasks/[id]/chat-reply/route.ts:472-498`

`executeChatRewind()` 只检查 `getChatQueueCount()>0`，没有检查 queue 正在 drain。`flushChatQueue()` 会先 dequeue，再花较长时间做 checkpoint；这时队列计数已经是 0，rewind 可以通过复查并开始恢复。随后 drain 的 `sendChatMessage()` 因 rewind 门闩返回 false，又会把刚才的旧消息塞回队首。根据时序不同，这条消息可能被 `closeChatSessionUnconditional()` 清掉，也可能在 rewind 清队列之后重新出现，未来继续发送旧上下文消息。

另一个窗口是 chat-reply：请求可能在入口检查门闩时尚未 rewind，等到 send 或 `tryReserveChatStart()` 时门闩已经被占。当前代码把 send/reserve 失败统一解释成“入队”，而不是识别“rewind 正在进行”并返回 409。若 rewind 已经过了 queue count 复查，稍后 `closeSession` 会清掉这条已经向客户端返回 202 成功的消息。

建议把 drain 状态和 queue generation 放进 `chat-queue`/gate 的统一原子状态；rewind 必须拒绝或取消 drain，并让在 rewind 门闩下失败的 chat-reply 明确返回 409，不能入队。stop/rewind 后旧 generation 的 flush 不得重新 enqueue。

#### R2. Rewind 的事务补偿仍只恢复仓库，不恢复 events / rewind_points / meta / session

位置：`src/lib/server/chat-checkpoint.ts:719-860`

安全快照与 Git refs 是进步，但当前补偿仍不完整：

1. 某仓 `read-tree` 已成功、随后 `git clean` 失败时，该仓已经被部分修改；失败分支只回滚此前 `succeededPaths`，没有回滚当前失败仓。
2. `events.jsonl` 截断成功后，如果 `writeRewindPoints()` 或 `writeMeta()` 失败，catch 只调用 `restoreRepoTree()`；events 已经被截断、checkpoint 列表可能已改、session 已关闭，均不会恢复。
3. `appendInfoEvent()` 和最后的 `getTask()` 位于事务块外；它们失败会让 API 返回错误，但破坏性回退事实上已经提交，用户重试会面对不同状态。
4. safety snapshot 允许部分仓失败后继续。只要目标仓中有一个没拿到安全快照，就不应开始破坏性恢复。

现有“两仓第二仓失败”测试只覆盖“第二仓在修改前失败、第一仓回滚”，没有覆盖 `git clean` 后置失败、events rename 之后失败、meta 写失败和 commit 后响应失败。

#### R3. 并发首条消息的输家依赖赢家必然启动；赢家中途失败会让输家永久搁置

位置：`src/app/api/tasks/[id]/chat-reply/route.ts:472-540`

启动预约能阻止两个 `runChatSession()` 同时创建，这是正确方向。但预约失败方会立即入队并返回 202；预约赢家在真正注册 `runningChats` 前还要经过 update pending 检查、全仓 checkpoint、事件写入和 meta 写入。任一步失败，finally 只释放 reservation，不会启动或退回已经入队的输家。

结果是输家的 HTTP 已成功，但既没有活会话，也没有 flush 触发点；下一条新消息还可能直接起新会话并先于旧队列处理。预约需要 owner 失败补偿：要么把 reservation 与待启动 payload 作为统一状态机，由 owner 失败时原子移交；要么失败时把所有等待请求明确标记失败，不能留下无人消费的内存队列。

#### R4. “立即发送”仍可重复或丢消息，完整 payload 只解决了其中一半

位置：`src/components/tasks/chat-view.tsx:311-377`

当前实现保存了图片、附件和 skill，解决了“只重发文本”的直接问题，但仍有三个失败窗口：

1. 只有 `task.runStatus === "running"` 才调用 stop。若 UI 状态已变为 awaiting/idle、但 server queue 正在 drain，代码不会清原队列，而是把 target/rest 再发一遍，形成重复消息；目标也不一定真的立即发送。
2. 本地 pending 在 stop 成功前就清空；stop 失败时不会恢复，用户失去继续操作这些排队项的入口。
3. `handleUserReply()` 内部吞掉发送异常并返回 `void`。目标发送失败时，`handleSendNow()` 无法感知，仍会继续重发其余消息，导致目标丢失或顺序改变。

该功能需要服务端原子 `cancel-current-and-promote(queueItemId)`；若本轮不做，建议暂时移除“立即发送”，不要用客户端 stop + 全量重放模拟事务。

#### R5. P1 #3 的提示文案不准确：实现不是“恢复当时暂存区”，而是把快照内容全部 staged

位置：

- `src/lib/server/chat-checkpoint.ts:218-248`
- `src/components/tasks/chat-view.tsx:397-405`

确认框写的是“Git 暂存区也会重置为该时刻状态”，但 checkpoint 只有一个由临时 index `git add -A` 得到的 tree，并没有保存当时真实 index。`read-tree -u --reset` 后，原 staged/unstaged 边界消失，恢复内容会进入 index。这不是“恢复为当时状态”。

如果本轮明确接受这一限制，文案至少必须准确说明“原 staged/unstaged 区分无法恢复，回退内容可能全部进入暂存区”；从正确性上，双树 schema 仍是最终修复。

#### R6. Rewind 与 compact 的门闩不是原子互斥

位置：

- `src/lib/server/chat-checkpoint.ts:615-697`
- `src/lib/server/chat-runner.ts:1640-1679`

compact 只在开始阶段读取一次 `isChatRewindInProgress()`，随后才设置自己的 in-progress 标记；rewind 的 `tryBeginChatRewind()` 又不检查 compact 标记。两者可以同时通过各自检查，之后并发关闭 session、修改 runStatus 和写 events。应使用同一个 per-task exclusive-operation gate，由同步 check-and-set 决定唯一赢家。

### 部分修复或明确延期

- P1 #5：每条消息同步全仓 `git add -A` 未改，Windows 大仓首包性能风险仍在；需要独立基准后再决定方案。
- P2 #8：正常路径用 draining 标记阻止新消息直接插队，方向正确；但 R1 的 drain/stop/rewind generation 竞态和 R3 的无会话滞留队列仍会破坏顺序。
- P2 #9：占位文本问题修复，但仍按 displayText 而非稳定 queue item id 配对；重复文本和跨刷新状态仍缺可靠身份。
- P1 #4：GC 存活修复，但 task 删除没有删除 `refs/ai-flow/checkpoints/<taskId>/...`，长期会让仓库永久保留历史 blob/tree；应在删除任务和 tombstone 清扫时清理 refs。
- 需求覆盖缺口 4 项仍是 scope 决策，未实现也未在路线图中正式标记取消/延期。

---

## 首轮 P1 原始问题（历史记录，最新状态以上方复审为准）

> 本节保留第一次审查时的原始证据和修复目标，便于追踪 Fable5 的响应；其中部分描述已被最新改动改变。是否修复、是否仍阻塞，以“第十轮复审状态”一节为准。

### 1. Rewind 的“无运行中 agent”校验存在 TOCTOU，可能在 agent 改文件时并发恢复仓库

位置：

- `src/lib/server/chat-checkpoint.ts:488-501`
- `src/lib/server/chat-checkpoint.ts:515-545`
- `src/app/api/tasks/[id]/chat-reply/route.ts`

`executeChatRewind()` 在进入 `withTaskLock()` 前检查 `isRunActive` 和落盘 `runStatus`。检查完成后、真正执行 `restoreRepoTree()` 前，另一个 `/chat-reply` 请求仍可启动 run；chat-reply 不参与这把 task 文件锁。

结果是 agent 可能正在 edit/shell 写仓库，而 rewind 同时执行 `read-tree` 和 `git clean`。这是数据破坏竞态，不能靠前端隐藏按钮解决（双标签页、迟到请求、API 直接调用都可触发）。

建议：

1. 引入 per-task destructive-operation gate，rewind 开始时先原子占位；chat-reply、compact、resume/send 都必须识别该 gate。
2. 在真正写盘前再次检查运行态；检查和占位必须与 send/start 的 reservation 共用同一原子状态机。
3. 增加集成测试：rewind 校验后故意暂停，同时启动 chat run，断言只能一方成功。

### 2. Rewind 不是事务性的；任何中途失败都会留下“仓库已回退、对话未截断”的半完成状态

位置：`src/lib/server/chat-checkpoint.ts:529-593`

当前流程把 safety snapshot 只放在内存中，然后逐仓执行恢复。存在这些失败窗口：

- 仓库 A 恢复成功、仓库 B 恢复失败；
- 所有仓恢复成功，但 `events.jsonl` 截断失败；
- events 截断成功，但 `rewind_points.jsonl` 或 `meta.json` 写入失败。

上述任一异常都会直接抛出。此前成功的破坏性操作不会回滚，而且 safety snapshot 尚未持久化，用户没有可操作的恢复入口。

建议：

1. 写盘前验证所有目标 tree object、repo 和目标 event 都存在。
2. **先持久化** pre-rewind safety point，再开始恢复。
3. 任一步失败时，用 safety snapshots 回滚所有已处理仓库；回滚失败需要返回明确的逐仓灾难恢复信息。
4. 增加故障注入测试：第二仓失败、events rename 失败、writeMeta 失败，均断言仓库和对话保持一致。

### 3. Rewind 会重写真实 Git index，把当时所有未提交内容变成 staged

位置：`src/lib/server/chat-checkpoint.ts:198-265`

恢复使用：

```text
git read-tree -u --reset <treeOid>
```

checkpoint tree 是通过临时 index 对整个工作区 `git add -A` 得到的。因此 restore 后，真实 index 和工作区都被设置成该 tree；原来 staged/unstaged 的边界丢失，所有恢复内容都会进入 staged 状态。

这不是“恢复文件到当时”，而是额外修改用户的暂存区，可能导致后续误提交。现有测试只断言文件正文，没有断言 restore 前后的 `git status --porcelain=v2` staged/unstaged 语义。

建议：快照同时保存 `indexTreeOid` 和 `worktreeTreeOid`，恢复时分别还原；如果产品定义只恢复文件正文，则必须保持真实 index 不变，并对新增/删除文件做显式工作区恢复。

### 4. Checkpoint tree 没有 Git ref，`git gc` 后 rewind point 会永久失效

位置：

- `src/lib/server/chat-checkpoint.ts:160-195`
- `src/lib/server/chat-checkpoint.ts:409-429`

`git write-tree` 生成的 tree/blob 只把 OID 写进 ai-flow 自己的 JSONL，没有任何 Git ref 可达。Git 不知道 JSONL 是引用；自动或手动 GC 最终可以清掉这些 unreachable objects，届时 rewind point 仍显示在 UI，但 restore 报 object 不存在。

建议：为保留中的 checkpoint 建私有 refs（例如 `refs/ai-flow/checkpoints/...`），轮转/删除 checkpoint 时同步删 ref；或者改用 ai-flow 自己的内容寻址存储，不依赖不可达 Git object。

增加测试：创建 checkpoint 后运行 `git reflog expire --expire=now --all` + `git gc --prune=now`，断言仍可恢复。

### 5. 每条消息同步全仓 `git add -A`，会直接把 Windows/大仓首包延迟重新拉高

位置：

- `src/app/api/tasks/[id]/chat-reply/route.ts:203-243`
- `src/lib/server/chat-checkpoint.ts:160-195`
- `src/lib/server/chat-checkpoint.ts:373-403`

每条用户消息在 agent 开工前，对每个仓顺序执行 `rev-parse`、`read-tree`、`git add -A`、`write-tree`。临时 index 每次从 HEAD 重建，无法复用真实 index 的 stat cache；大 monorepo、海量 untracked 文件和 Windows 文件系统上会很重。

单个 Git 命令超时 15 秒，按当前顺序最坏可接近每仓 45 秒以上，多仓继续串行。此路径位于 HTTP 回复和 agent 首包之前，与本项目“Windows 慢”和 Chat “好用、快”的目标直接冲突。

建议：

- 回到路线图里的 touched-files before/after 快照，或至少复用/复制真实 index，而不是每条消息从 HEAD 全扫；
- 多仓在有并发上限的前提下并行；
- 增加总预算而不是每条 git 命令各自独立 15 秒；
- 用 10 万文件 fixture 做 P50/P95 基准，并在 Windows 实机验收。

### 6. 无会话时并发发两条消息，第二条可能已落 user_reply 但被 `runChatSession()` 静默吞掉

位置：

- `src/app/api/tasks/[id]/chat-reply/route.ts:406-460`
- `src/lib/server/chat-runner.ts:613-625`

两个并发请求都可能在 `hasChatSession()` 为 false 时通过防重检查，随后分别做 checkpoint、落 user_reply、写 running。第一个请求先注册会话后，第二个请求调用 `runChatSession()`；该函数发现 map 已有 task 后直接 `return`，没有告诉调用方“首条没有送达”。

最终表现：第二条气泡和 checkpoint 都落盘，HTTP 仍返回成功，但 agent 从未收到第二条消息。

建议：

- 新会话启动要有原子 reservation；
- `runChatSession` 返回 `started | already_exists | failed`，禁止用无信息的 `void` early return；
- 若发现会话已被别人抢先创建，把完整消息入队，不能丢弃；
- 增加 `Promise.all` 双 POST 集成测试，断言两条都且仅送达一次。

### 7. “立即发送”会丢图片、附件、skill，并清掉其他排队消息

位置：

- `src/components/tasks/chat-view.tsx:110-115`
- `src/components/tasks/chat-view.tsx:247-252`
- `src/components/tasks/chat-view.tsx:283-320`
- `src/lib/server/stop-task.ts:44-49`

服务端队列保存了完整 payload，但前端 `pendingLocalReplies` 只保存 `{ id, text }`。“立即发送”执行 stop，stop 会清空整个服务端队列，然后前端只调用 `handleUserReply(text)`：图片、路径附件、skillRefs 全部丢失，其他排队消息也一起消失。

图片/附件-only 消息更严重：本地 pending text 是空串；立即发送时会变成无 text/无附件请求，服务端返回 400，原排队内容已经被 stop 清掉。

建议：

1. pending item 保存完整 payload 和稳定 queue item id。
2. 实现服务端原子 `cancel-current-and-promote(queueItemId)`；不要用“stop 清全队 + 客户端重发文本”模拟。
3. 在原子接口落地前先去掉“立即发送”按钮，避免数据丢失。
4. 覆盖图片-only、附件、skill、多条队列中选择第 N 条的测试。

---

## 首轮 P2 原始问题（历史记录，最新状态以上方复审为准）

### 8. 队列并不保证 FIFO；后来的直发消息可以越过旧排队消息

位置：

- `src/lib/server/chat-runner.ts:1177-1187`
- `src/lib/server/chat-runner.ts:1359-1428`
- `src/app/api/tasks/[id]/chat-reply/route.ts:307-375`

run 结束后只是 `void maybeAutoCompactThenFlush()`。在 drain 真正 `sendChatMessage()` 前，新的 chat-reply 可以看到 idle session 并直接 send；flush 自身还会先做 checkpoint，进一步扩大窗口。于是新消息 C 可先于已排队的 B 被 agent 处理。

建议：给 drain 增加 per-task reservation；只要 queue 非空或 drain in progress，新消息一律继续入队。测试中人为延迟 checkpoint，断言 B 始终早于 C。

### 9. 图片/附件-only 排队气泡不会被真实事件清掉，队列提示也会提前消失

位置：`src/components/tasks/chat-view.tsx:194-216`

pending 占位用用户原始 `text`，服务端真实 user_reply 在无文本时使用 `"(用户附了图片 / 文件)"`。两者不相等，`findIndex` 找不到，ghost pending 会一直留着。

另外 `onDone` 无条件清 `queuedCount`，但 server 可能刚开始发送队首，队列里仍有后续消息；多条排队时 banner 会提前消失。

建议：用服务端分配的 queue item id 配对，不要按文本匹配；队列计数由 enqueue/dequeue SSE 或查询接口驱动。

### 10. `@` 文件首次扫描没有 in-flight 去重，用户继续输入会并发重复扫整仓

位置：

- `src/lib/server/repo-files.ts:110-122`
- `src/components/at-mention.tsx:77-115`

cache 只在一次 `scanRoot()` 完成后写入。大仓首次扫描未完成时，query 每次变化都会发新请求；前端的 `cancelled` 只忽略响应，不会 abort fetch，服务端会并发启动多次相同的 20,000-entry 遍历。

这会造成明显磁盘抖动，尤其与 Windows 性能目标冲突。

建议：cache 中同时保存 per-root in-flight Promise，所有 query 复用同一次索引构建；前端使用 AbortController。增加慢 scan 下连续输入的并发测试。

### 11. 完整工具输出落盘失败时仍标记 `fullPath`，UI 一定给出一个 404 按钮

位置：`src/lib/server/tool-result-persist.ts:221-247`

`fs.writeFile` 失败后只 warn，但返回值仍带 `truncated: true` 和 `fullPath`。前端据 `truncated` 显示“查看完整输出”，点击后只能 404。

建议：只有写入成功才返回 `fullPath`；UI 也应以 `truncated && fullPath` 作为按钮条件。补一个写失败注入测试。

---

## 需求覆盖缺口（不一定阻塞本批，但必须明确 scope）

1. 路线图 `Phase 2.2` 写的是“标题 + 首条消息全文过滤”，当前侧栏只按 `task.title` 搜索（`src/components/app-sidebar.tsx`）。
2. 路线图 `Phase 3.3` 的会话 diff 面板当前明确未实现，`chat-view.tsx` 注释写了“会话改动面板已砍”。
3. Compact 没有 Grok 资产清单建议的单次 120 秒 timeout；当前 summarize stream 卡死时，`compactInProgress`、HTTP 请求和最多 5 条队列都会长时间卡住。实现是 2 次尝试，资产清单记录的是 3 次。
4. 自动 compact 使用固定 `260_000 inputTokens`，不是路线图约定的模型 context window 85%；对较小上下文模型可能在压缩前先撞 context limit。

这些项如果是本轮主动降 scope，应在路线图里标注“延期/取消”和原因；否则应补齐后再宣称 Phase 2–4 完成。

---

## Read / Write 专项评审（已按建议落实）

### 首轮实现并不是一套完整的安全读写能力

首轮代码只注册了 `safe_read`：

- `src/lib/server/safe-read.ts`：约 500 行编码探测与读取实现；
- `src/lib/server/chat-mcp.ts:683-735`：把 `safe_read` 暴露给 chat/task agent；
- `src/lib/server/windows-tool-discipline.ts:28-37`：内置工具失败后，要求 agent 用 `safe_read` 读取，再用 Python/Node 脚本写回；
- 新增 `iconv-lite`、`jschardet` 依赖及对应测试。

代码没有实现 `safe_write`，并明确写了“写回风险大、本批不做 safe_write”。因此它只能安全地解决部分“读”，一旦任务需要修改文件，又会把模型推向临时脚本写入。最新复审时这批实现已经全部删除，下面保留首轮判断作为撤回依据。

### 为什么当前阶段不值得保留

1. Cursor SDK 已经提供 `read / edit / write`，新工具属于平行、重复的文件能力。
2. 本轮 Windows 慢的主要实锤根因是 shell 选择与 Git Bash 路径事故，不是缺少文件读写工具；目前也没有频率数据证明 GBK/UTF-16 文件已成为需要产品化解决的高频问题。
3. 为少量遗留编码场景增加约 500 行代码、两个运行时依赖、MCP 工具面和额外 prompt 规则，收益不足以覆盖维护及安全成本。
4. `safe_read` 之后要求用 Python/Node 写回，会绕过 `edit/write` 的结构化 diff，且没有 expected hash、并发冲突检测、原子替换、BOM/EOL/权限保留保证，可能比原问题更危险。
5. 读写链不闭环：如果一个 GBK 文件只能可靠读取、不能可靠增量编辑，这项能力对真实开发任务的帮助有限。

### 首轮实现即使只保留 read，也有以下问题

- `safe_read` 只校验 `path` 是绝对路径，没有把 `realpath` 限制到当前任务仓库、任务目录或用户明确附加的文件。MCP handler 在应用进程中直接读盘，扩大了文件访问边界。
- `limit` 缺省时允许把整个 2MB 文件返回模型，可能一次注入数十万 token，与本轮降低上下文和改善 Windows 体感的目标相冲突。
- `utf-8 fatal -> GBK -> latin1` 的实现中，`iconv.decode(buffer, "gbk")` 对已知编码通常会容错返回而不是抛错，因此 latin1 分支基本不可达，未知编码可能被错误但“成功”地解释成 GBK。
- 现有测试只覆盖 UTF-8/UTF-16/GBK happy path、二进制和相对路径，没有覆盖越权绝对路径、符号链接逃逸、低置信度误判、巨大输出和安全写回。

### 已落实的处理

1. 删除 `src/lib/server/safe-read.ts`、`tests/safe-read.test.ts` 及 `chat-mcp` 中的 `safe_read` 注册。
2. 移除为此新增的 `iconv-lite`、`jschardet` 依赖。
3. 不新增 `safe_write` 或 `safe_edit`，也不要提示模型改用 Python/Node 整文件写回。
4. Windows prompt 只保留最小失败纪律：同一文件 `read/edit` 连续失败两次就停止尝试，向用户说明编码问题，不再进入 shell/临时脚本兔子洞。
5. 后续先补失败频率和编码类型 telemetry；只有真实数据证明遗留编码高频，再在统一文件工具层设计编码感知读写，而不是暴露第二套模型工具。

若未来确实需要重新引入，推荐做受工作区授权约束的编码感知 `safe_edit`：携带 `task_id + expected_sha256 + old_text/new_text`，保留原编码、BOM、EOL 和权限，并使用临时文件原子替换；不建议提供任意整文件覆盖的 `safe_write`。

---

## 测试覆盖评价

现有新增测试覆盖了纯函数、Git GC 和部分失败路径，但还缺以下关键测试：

- rewind 当前仓在 `read-tree` 后、`git clean` 阶段失败的回滚；
- events 截断后 `rewind_points` / meta 写失败的全状态补偿；
- rewind 与 queue drain、chat-reply、compact 的真实并发；
- restore 后 staged/unstaged 状态；
- chat-reply 并发首条赢家启动失败时，输家不能搁置；
- queue drain 与 stop/rewind 并发时不得复活消息；
- “立即发送”在 running、awaiting_user、draining、stop 失败和目标发送失败下的保真与去重。

本批新增的 39 项定向测试全绿，但全量测试当前是 523/524；即使排除独立的 preview-manager 失败，现有测试也不能证明上述竞态可安全上线。

---

## 建议修复顺序

1. 先修 R1、R2、R6：rewind 是 destructive feature，统一 gate 和全状态补偿未正确前不要上线入口。
2. 再修 R3、R4：确保预约失败和“立即发送”不会丢消息、重复或乱序。
3. 对 P1 #3 做双树快照；若明确延期，至少把确认文案改成真实语义。
4. 对 P1 #5 做 Windows 大仓 P50/P95 基准，再决定 checkpoint 方案。
5. 清理 task 删除后的 checkpoint refs，复核全量 preview-manager 门禁，并正式更新路线图 scope。

---

## 第三十四轮修复报告（Fable5、2026-07-19 上午、待复审）

**用户已拍板停止补丁循环**——本轮严格按第三十三轮「一次性收敛建议」四条做集中式重构（非逐分支补），R33-1～R33-7 全部由协议收口覆盖：

### 1. QueueOperation（R33-1 + R33-7）

- **itemId 客户端 POST 前预生成 + 先登记 pending**——「202 晚到插幽灵」从根上消除（登记永远先于一切服务端事件）；服务端优先用 client id、兜底发号器挂 globalThis（R33-7 撞号关闭）。
- **active + bounded recentSettled ledger**（上限 50）：delivered / failed 都记；watch bootstrap 的 `queue_state` 带 recentSettled——SSE 断线错过控制帧后重连可重放对账。
- **所有清队只走 `failQueuedItems` 唯一 sink**：验收点名的 stop / cancelled / error / 启动补偿全部接入；主线复核又补齐 DELETE（reason:"deleted"）与 rewind（chat-checkpoint、reason:"rewound"）两处遗留直调——业务路径裸 `clearChatQueue` 清零。
- 前端 `onDone` 清 pending 时把 itemId 记入 settledItemIds（pending 登记先于请求、done 到达时必有账可记）。

### 2. TerminalCleanupCoordinator（R33-2 + R33-3）

- per-task 唯一 cleanup handle（全局 token）+ **join 语义**：重复 finalize 只 join 现有 promise、绝不重写 phase / 复用 gen / 提前 release（R33-2 两条破坏序列关闭）。
- **同步 remove 分支同样进 coordinator**（R33-3 主洞、Codex 探针场景）：无 ResourceJob 的快速 finalize 也 acquire + markExecuting + release、与 deferred 同一互斥。
- reopen 原子占 `reopening` lifecycle（chat-gate 新相位）：finalizing / deleting / stopping / executing cleanup 在飞一律 409；waiting 作废让位语义保留。

### 3. DeleteJournal 状态机（R33-5 + R33-6）

- journal 带 `phase: prepared → committed`（tombstone rename 成功后原子推进）；DELETE 失败路径回滚 prepared journal 并返非 2xx——「未提交删除被 boot 误执行」关闭（boot 只执行 committed、prepared 丢弃保留任务）。
- 快速物理删路径进入不可逆动作前先推进 committed。
- **refs 删除失败保留 `refsPending` 清单**、不删 journal（taskDir 可先删——逻辑删除已 committed）；boot 重试直到全部确认成功才删 journal——恢复信息不再永久丢失（R33-6）。

### 4. Read Commit Guard（R33-4）

统一同步闸 `assertTaskReadable` / `filterCommittedReads`（tombstone + committed journal）：`listTasks` 循环结束后**最终过滤**（双任务探针场景关闭）、`getTaskWithTailEvents` / `getTaskEventsBefore` / watch bootstrap 读完复查；DELETE 提交后向既有 watcher publish `task_deleted` 帧 + 关流、前端收到后停止重连。

### 测试

新增 `tests/ownership-r34-queue-op.test.ts`（挂起 202 × stop/cancelled/error/启动补偿、断线 recentSettled 对账、两 tab 同文案、resetModules 同毫秒唯一）、`tests/ownership-r34-cleanup-coord.test.ts`（waiting/executing 双 finalize join、同步 remove × reopen 409、DELETE × reopen 409）、`tests/ownership-r34-journal-read.test.ts`（prepared 回滚 / committed 执行 / refs 逐段失败重试 / 双任务 list / tail·events·watch 挂起后删除 / task_deleted 帧、12 项）——覆盖第三十三轮最低退出矩阵四组。

### 第三十四轮工程门禁（修复后）

- `pnpm typecheck`：通过
- `pnpm lint`：通过（0 error / 0 warning）
- `pnpm test`：**96 文件 / 889 项全部通过、0 skipped**（三代理各两遍 + 主线合并后再两遍）
- `pnpm build`：生产构建通过
- `git diff --check`：通过

### 已知边界（如实记录）

- coordinator 的 acquire 时机在终态状态提交之后、remove 之前（同步路径另有 finalizing lifecycle 挡 reopen）；若复审要求「提交前」acquire 再前移一拍。
- 同步 finalize 路径现在也会短暂 quarantine（acquire 的副作用、release 后即清）——与旧「同步从不 quarantine」有行为差异、但关闭了探针窗口。
- 快速 DELETE 在 committed 后、rm 中途崩溃 → boot 完成删除（有意为之：逻辑删除已提交）。
- 他 tab 的侧栏清理靠 SSE 关流 + 下次 list 过滤（未加主动推送清单）。

---

## 第三十三轮验收（Codex、2026-07-19、深度收敛复审、纯 bug 范围）

### 结论

**第三十三轮验收仍不通过。** R32-1～R32-7 不是无效修改：终态确实送达时 `settledItemIds` 能挡住晚到 202，flush 内点名的 no-session / strict EIO / task-gone 分支已统一发 `queue_failed`；deferred cleanup 的单 holder happy path、全局 resource counter、单次 list/get 读后复查、journal 成功恢复、超长单事件 seq 恢复也都成立。

但这轮新增的测试仍把“终态已送达”“只有一个 cleanup holder”“journal 清理全成功”当成前提，没有覆盖清队/HTTP/SSE 三方乱序、重复 finalize、同步 remove、prepared journal 和 ref 删除失败。沿真实提交点继续验证，确认 **5 个 P1 + 2 个 P2**。本轮不评价 S8 或功能路线，不修改业务代码。

第三十三轮门禁（基线 `dedf910`，`HEAD 4828eec`）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 warning。
- R33 三个新增测试文件：31/31 通过。
- `pnpm test`：沙箱内仅 `preview-manager` 的真实杀进程用例因权限超时，切到真实系统权限复跑 **93 文件 / 863 项全部通过，0 skipped**。
- `pnpm build`：通过。
- `git diff --check`：通过。
- 另写 5 个临时反例探针：queue allocator 跨模块撞号、prepared journal 重启误删、ref 清理失败仍销毁 journal、双任务 list 迟到回灌、同步 finalize/remove 被 reopen 穿越，全部稳定命中；探针已撤回，工作树恢复为仅本文档变化。

### R33-1（P1）队列终态协议仍依赖“终态帧一定被当前 tab 收到”，stop/启动补偿与 202 晚到仍会制造永久 pending

`enqueueOrReject` 在队列写入后还会 `await getTask`，再返回 202（`src/app/api/tasks/[id]/chat-reply/route.ts:296-323`）。这给清队留下了真实窗口。新增 `failQueuedItems` 只覆盖了部分 flush 分支；以下生产路径仍直接 `clearChatQueue`：

- stop：`src/lib/server/stop-task.ts:130-146`，随后只发普通 `done`；
- chat run cancelled/error：`src/lib/server/chat-runner.ts:1673-1725`；
- 新会话启动失败补偿：`src/app/api/tasks/[id]/chat-reply/route.ts:756-779`，只发无 itemId 的 info；
- rewind/DELETE 的部分路径虽然通常由其它门闩限制，但仍没有统一的“已接受 item 必有终态”静态约束。

前端 `onDone` 只清当前已存在的 pending，不把 itemId 记入 `settledItemIds`（`src/components/tasks/chat-view.tsx:275-294`）。可达时序：A 已入队 → A 的 HTTP 202 响应卡在 `getTask`/网络 → 另一 tab stop → 服务端 clear + done → 本 tab 此时尚无 pending，done 无 id 可记 → 202 晚到，`shouldInsertPendingAfter202` 返回 true → A 作为幽灵占位永久插入。启动失败补偿同理，而且连 done 都没有。

`queue_state` 也不能封住断线窗口：queue_failed 在 SSE 断线期间丢失 → 重连先收到空 queue_state，但 202 尚未返回、当前没有 pending 可被记 settled → 随后 202 返回仍会插入幽灵。现有测试把 reducer 与 server 事件拆开，未覆盖这个真实 HTTP/SSE 交叉，修复报告也已如实承认。

修复要求：任何已返回/将返回 202 的 item 都必须有可重放终态，禁止直接 clear。推荐由客户端在 POST 前生成稳定 `itemId` 并立即登记 outstanding，服务端原样使用；所有 stop/error/startup-compensation/DELETE 清队都经唯一 terminal sink。若终态仍是内存 SSE，则 bootstrap 还必须带有界 recent-settled ledger，而不只是 active queue_state；或者 202 返回前原子复查 item 仍 active 并返回最终结果。仅在 `onDone` 多 clear 一次不能覆盖“未知 itemId + 断线 + 晚到 202”。

最低退出测试：真实挂起 chat-reply Response，分别注入 stop、cancelled、error、startup compensation 和 SSE 断线重连；让 terminal/queue_state 先到、202 最后到，断言 pending=0、每个已接受 item 恰有一个可重放终态，两 tab 同文案互不误清。

### R33-2（P1）terminal cleanup reservation 不是独占句柄；重复 finalize 会复用同一 gen、降级 executing 或被另一 holder 提前 release

`holdTerminalCleanup` 发现已有条目时仍复用 `cur.generation`，并无条件把 phase 重写为 `waiting`（`src/lib/server/resource-jobs.ts:242-255`）；`markTerminalCleanupExecuting` 对已经 executing 的同 gen 返回 true（`:271-285`）；`releaseTerminalCleanup` 也只按这个共享 gen 清 reservation（`:293-303`）。finalize route 没有拒绝已终态 task，deferred 分支每次都会新起一个后台 cleanup（`src/lib/server/task-runner.ts:1661-1707`）。

因此有两条可达破坏序列：

1. A cleanup 已 executing；重复 finalize B 调 hold，把同一条 reservation 从 executing 改回 waiting；此时 reopen 可 invalidate，A 已进入的 remove 不再复查，继续删除恢复后的工作区。
2. A/B 在 waiting 期拿到同一个 gen，各自启动 remove；任一 holder 先完成并 release，就会清掉共享 reservation/quarantine，另一个 remove 仍在运行，reopen/prewarm 随即穿入。

这不是 generation ABA，而是同一 generation 被多个 owner 同时持有。R33 的 ABA 测试只验证 resetModules 后号码不同，没有验证 reservation 的唯一所有权。

修复要求：`holdTerminalCleanup` 必须是 try-acquire，已有 waiting/executing 时返回 busy/现有 promise，绝不能重写 phase；每次真正 cleanup 使用唯一 handle/token，mark/release 都精确匹配该 handle。更简单的是 per-task 单一 cleanup coordinator/promise，重复 finalize 只 join，不再创建第二个后台 remove。

最低退出测试：在 waiting 和 executing 两个点分别并发第二次 finalize，断言 remove 只调用一次、phase 不倒退、第二个调用不能提前 release；第一 holder 未完成前 reopen/prewarm 始终 409。

### R33-3（P1）waiting/executing 只包住 deferred 分支；无 ResourceJob 的同步 remove 完全裸奔，reopen/DELETE 生命周期也未原子互斥

正常无 resource job 时，finalize 走 `src/lib/server/task-runner.ts:1708-1745` 的同步 `removeTaskWorktrees`，没有 hold、没有 waiting→executing，也没有 quarantine。`reopenTask` 只查 `hasTerminalCleanup`，不参与 chat lifecycle/互斥（`:1786-1815`）。

临时真实 worktree 探针已实证：在 `removeTaskWorktrees.afterPathExists` 挂住同步 finalize → `hasTerminalCleanup=false` → `reopenTask` 成功把 repoStatus 写回 developing → 放行旧 finalize → 旧 remove 删除了刚恢复任务的 worktree；探针 1/1 通过后已撤回。相同缺口也允许 DELETE 已占 `deleting` lifecycle 时另一请求执行 reopen，后者可能先回 200/写 developing，随后目录仍被 DELETE 删除。

修复要求：同步和 deferred remove 必须进入同一个独占 cleanup coordinator；reservation 应在终态状态提交前/同时建立，而不是只在判断 defer 后才建立。reopen 自身也必须原子占 `reopening`（或同一 per-task coordinator），与 finalizing/deleting 互斥，不能靠一次只读 lifecycle 检查。

最低退出测试：无 ResourceJob 的 finalize 在 remove 内挂起时 reopen 必须 409；remove 完成并释放后再 reopen 才成功。另加 DELETE 已占 deleting 后并发 reopen，断言不写 developing、不 prewarm、不返回旧 task 200。

### R33-4（P1）tombstone 读后复查只修了单条 happy path；多任务 list、tail GET、watch bootstrap 与事件分页仍能在 DELETE 成功后提交旧数据

`getTask` 的最终同步 tombstone 复查有效；但其它生产读入口不完整：

- `listTasks` 对 A 检查后立即 push，随后还会 await B/C；函数返回前没有对已 push summaries 做最终复查（`src/lib/server/task-fs.ts:455-485`）。
- `getTaskWithTailEvents` hydrate 后直接返回（`:576-585`），它正被详情 `GET ?tail` 和 watch bootstrap 使用。
- `getTaskEventsBefore` 读完分页也无最终复查（`:591-602`）。
- watch route 先 subscribe，再 await 上述 tail read；因此 tombstone 前入场的 watch 可在 DELETE 后仍返回 200、发 stale task/events 并保持流存活（`src/app/api/tasks/[id]/watch-task/route.ts:74-109`）。

临时双任务探针已实证：list 先 push A → 在读取 B 时挂起 → tombstone A → 放行 → 返回结果仍包含 A。R33 正式测试只有一个 task，A push 后没有后续 await，所以没有覆盖。前端 refresh epoch/successfulDeletedIds 仅保护发起删除的当前 tab，无法保护另一个 tab 或直接 API 消费者。

修复要求：抽一个统一“读结果提交闸”，所有 list/detail-tail/events/watch bootstrap 在最后一个 await 后、Response/stream 首帧前同步复查 tombstone。list 要在整个循环结束后最终过滤，而非只在每项 push 前检查；DELETE 最好再向既有 watcher 发布明确 task_deleted/关闭流。

最低退出测试：A 已 push 后挂 B、删除 A，list 不含 A；tail hydrate、events page 和 watch bootstrap 分别挂起后删除，必须 404/不发 stale task；在非删除发起 tab 验证不会回灌侧栏/详情。

### R33-5（P1）deletion journal 没有 prepared/committed 状态；tombstone 未提交或 DELETE 已报错，重启仍会删除尚可见任务

`writeDeleteTombstone` 先写外部 journal，再写/rename tombstone（`src/lib/server/task-fs.ts:498-542`）。若 tombstone 写入/rename 失败，DELETE 外层返回错误并释放 deleting，但 prepared journal 没有回滚。快速路径同样先写 journal，后续 cleanup/deleteTask 任一步异常都会留下 journal（`src/app/api/tasks/[id]/route.ts:399-434`）。

boot 却无条件把 journal 当成已提交删除：`recoverDeletionJournals` 不检查 tombstone/commit phase，直接调用 `recoverDeletedTaskArtifacts`，后者 rm taskDir（`src/lib/server/task-fs.ts:236-299`）。临时探针写入 journal 但不写 tombstone：当前进程 `getTask` 仍能读到任务；模拟重启后第一次 list 直接删掉目录，探针稳定命中。

这意味着用户看到 DELETE 4xx/失败、任务仍可见，却可能在下一次启动时被后台永久删除。

修复要求：明确唯一 durable commit point。建议 journal 带 `phase: prepared|committed`：manifest 落 prepared，tombstone 成功后原子推进 committed；boot 只执行 committed，prepared 要么回滚/保留任务并报警。快速物理删除若不写 tombstone，也必须在进入不可逆 refs/rm 前原子 commit journal，并让 list/get 同样把 committed journal 视为逻辑删除；commit 之后就不能再向用户伪装为可回滚失败。

最低退出测试：prepared journal 后 tombstone rename 失败、以及 fast journal 后 deleteTask 抛错，DELETE 返回非 2xx；模拟重启后 task/meta/worktree 均仍存在。committed journal 的对应用例才允许 boot 完成删除。

### R33-6（P2）checkpoint ref 删除失败仍继续 rm taskDir 并删除 journal，恢复信息永久丢失

`cleanupCheckpointRefsFromManifest` 对 `for-each-ref` / `update-ref -d` 失败只 warn/continue；`recoverDeletedTaskArtifacts` 又 catch 清理错误后无条件 rm taskDir、remove journal（`src/lib/server/task-fs.ts:240-270`）。DELETE 的 fast/deferred 路由也 catch cleanup 后继续 `deleteTask`（`src/app/api/tasks/[id]/route.ts:366-384, 412-424`）。

临时探针用不可访问 repo 注入真实 git 清理失败，日志明确出现 for-each-ref/update-ref 失败，但函数仍删除 taskDir 和 journal；后续 repo 恢复可用时已无 ref 清单可重试。R33 的崩溃测试只覆盖“每次 update-ref 都成功”的中途挂起，不覆盖失败结果。

修复要求：清 ref API 返回逐仓/逐 ref 结果；未确认成功的条目保留在 journal，不能删 journal。逻辑任务目录是否先 rm 可另行决定，但恢复清单必须独立保留并在 boot 重试；不要把真实失败吞成事务成功。

最低退出测试：首个/中间/全部 update-ref 失败时 journal 保留失败项；第二次恢复成功后才删 journal，并验证其它 task 的共享 treeOid ref 不受影响。

### R33-7（P2）resource generation 已全局化，但 chat queue item 发号器仍是模块局部，跨 route chunk/HMR 可撞号

队列/代际/in-flight 状态挂在 globalThis，item 发号器却仍是模块局部 `let nextChatQueueItemSeq = 1`，id 是 `Date.now()+seq`（`src/lib/server/chat-queue.ts:35-43`）。chat-reply route 与 chat-runner 都可 enqueue；模块重载/route chunk 各自从 1 开始时，同毫秒生成即可碰撞。

临时探针固定 Date：模块 A 入队得到 id X → `vi.resetModules()` → 模块 B 在仍存活的 global queue 入队 → 再得到同一个 X，`listChatQueueItemIds` 返回 `[X, X]`。之后任一 user_reply/queue_failed 都会误清两个 tab 的占位，settled ledger 也无法区分。

修复要求：发号器与 queue state 同挂 globalThis，或直接使用客户端生成的 UUID/itemId（也可顺带关闭 R33-1 的未知 id 窗口）。

最低退出测试：global queue 保留期间 resetModules/两个独立 import 实例同毫秒并发 enqueue，所有 itemId 仍唯一；同文案终态只影响目标 item。

### 本轮确认通过的部分

- R32-4 的 resource job/quarantine counter 已与 Map 同寿命；单 holder 的 resetModules ABA 用例成立。
- R32-7 对 4MB−1、4MB+1、8MB 单事件和 sidecar 反序写的恢复成立，本轮未构造出新的可达 seq 重号窗口。
- strict EIO、no-session、task-gone 等 R33 点名 flush 分支已能发 id 化终态；问题是协议尚未覆盖所有 clear 与断线重放，不是这些分支本身回归。
- `getTask` 单条全量读取的最终 tombstone 复查成立；问题集中在 list 的后续 await 和其它读入口。

### 一次性收敛建议（只针对上述 bug，不扩功能）

1. **QueueOperation**：itemId 在请求前生成；server 维护 active + bounded terminal ledger；所有 clear 只能走一个 finalizeItems sink。这样 HTTP、SSE、重连和两 tab 只认同一个 id/终态。
2. **TerminalCleanupCoordinator**：per-task 只允许一个 cleanup handle/promise，覆盖同步与 deferred remove；重复 finalize join，reopen/delete 原子 claim 同一 coordinator。不要让多个闭包共享一个 gen。
3. **DeleteJournal 状态机**：prepared manifest → durable committed logical delete → refs confirmed → taskDir removed → journal removed。每一阶段可重入，失败只能停在当前阶段，不能 catch 后假成功推进。
4. **统一 read commit guard**：list/get-tail/events/watch 在最后一个 await 后用同一同步 tombstone/journal guard；禁止每个入口各补一半。

以上四个入口收口后，再跑矩阵而不是继续逐分支打补丁：`{HTTP before/after terminal, SSE connected/disconnected} × {stop/error/start failure}`、`{sync/deferred/duplicate finalize} × {reopen/delete}`、`{prepared/committed/refs partial failure} × {restart}`、`{list/tail/events/watch} × {tombstone before/after final await}`。
