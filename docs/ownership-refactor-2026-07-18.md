# Task 启动/接管所有权收敛重构（2026-07-18）

> 背景：fable5-chat-polish 验收连续 22 轮（R19～R22 每轮 4-6 个 P1）都是同一根因的不同投影——
> 任务启动与接管没有单一、可证明的 owner 状态机。owner 判定散布在 7 个维度
> （startToken / opGen / runningTasks.instanceId / session.instanceId / lifecycle /
> pendingStopRequests / 盘上结构条件），各分支各抄子集、必然漂移。
> 本轮不再逐条打补丁，收敛成「一个 op handle、一个判定入口、一个收尾 coordinator」。

## 核心设计

### 1. 单一 TaskOpHandle（内存权威、不持久化）

本 app 是 Electron 壳内单进程 Next server，所有竞态在同一事件循环——内存就是权威源，
**不把 owner 写进 meta.json**（双源漂移比收益大）。盘上结构条件（currentActionId /
actionStatus / expectedRunStatus）保留，作为跨重启迟到写的第二道防线。

`task-stream.ts` global state 升 **V12**：

```ts
/** V12：taskOpGenerations 与 start owner 合并成单一 ownership 状态 */
interface TaskOwnershipState {
  /** 进程单调 generation：stop/DELETE bump（作废所有在飞 op 的准入）；tombstone 语义保留（W1） */
  gen: number;
  /** 当前启动/运行链的 owner op id；后继 claim 覆盖 = 换主；null = 无人持有 */
  currentOpId: number | null;
}
// state 里：taskOwnership: Map<string, TaskOwnershipState>
// 旧字段 taskOpGenerations、taskStartOwners 删除（gen 迁入 taskOwnership.gen）

export interface TaskOpHandle {
  taskId: string;
  opId: number; // 复用 nextTaskRunInstanceId 发号器
  gen: number;  // claim 时快照的 generation
}
```

```ts
export interface TaskOpHandle {
  taskId: string;
  /**
   * owner = claim 换主拿到的自己 opId；
   * observer = 入场快照的 currentOpId（可能 null）——只用于「之后有没有人接管」判定、
   * 自己不持有所有权、release 对它是 no-op。
   */
  kind: "owner" | "observer";
  opId: number | null;
  gen: number; // claim / snapshot 时快照的 generation
  /** claim / snapshot 时快照的 claim 计数（observer 判定用、防 null-opId ABA、见下） */
  claimSeq: number;
}
```

**observer 判定不比 currentOpId、比 claimSeq**（落地时补的 ABA 加固）：
「快照时无人持有（opId=null）→ 期间某 owner claim → owner 正常 release 清回 null」会让
只比 currentOpId 的 observer 判定重新变 true、迟到写复活。ownership state 加 `claimSeq`
（每次 claim 递增、release/revoke 不清），observer 判定 = `gen 未变 && claimSeq 未变`；
owner 判定 = `gen 未变 && currentOpId 仍是自己`。

新 API（`task-stream.ts` 导出、替换 claimTaskStartOwner / isTaskStartOwner / releaseTaskStartOwnerIf）：

```ts
/**
 * owner 模式：claim = 原子换主（覆盖前任 currentOpId）。
 * admissionGen 必须等于当前 gen（路由入场同步快照的准入号）——
 * 不等说明 claim 前已有 stop/DELETE、返 null（关闭「快照→claim」窗口）。
 */
export const claimTaskOp = (taskId: string, admissionGen: number): TaskOpHandle | null;

/**
 * observer 模式：快照当前 { currentOpId, gen }、**不夺主**。
 * one-shot / ask-consume 用——之后任何后继 claim / stop revoke 都会让快照失效、
 * 它们的迟到写被同一个 isTaskOpCurrent 挡掉；但它们自己绝不 dethrone 在飞的启动链
 * （claim 会——那是「答问答把在飞推进顶死」的倒挂）。
 */
export const snapshotTaskOp = (taskId: string): TaskOpHandle;

/** 唯一判定（owner / observer 通用；不含 lifecycle——组合版见 task-runner 的 isOpOwner） */
export const isTaskOpCurrent = (h: TaskOpHandle): boolean;
// 实现：o.currentOpId === h.opId && o.gen === h.gen

/** owner 收尾释放：匹配才清 currentOpId（防误删接管者）；observer handle 调它是 no-op */
export const releaseTaskOpIf = (h: TaskOpHandle): void;

/** stop/DELETE：bump gen + currentOpId 置 null（所有在飞 op / 快照立即失效） */
export const revokeTaskOps = (taskId: string): void;

/** 准入快照（路由入场同步取；语义 = 旧 getTaskOpGeneration） */
export const getTaskOpGeneration = (taskId: string): number; // 保留名字、读 taskOwnership.gen
```

`task-runner.ts` 里唯一的组合判定（**全文件只允许这一个 owner 闭包工厂**）：

```ts
/** 唯一 owner 判定入口：op 仍是当前 + lifecycle 无 stop/DELETE 在飞 */
const isOpOwner = (h: TaskOpHandle): boolean =>
  isTaskOpCurrent(h) && getChatLifecycle(h.taskId) === null;
```

### 2. claim 规则（谁 claim、谁不 claim）

**规则一句话：claim = 用户显式的启动/接管意图（推进、唤醒）；其它链路一律 observer；stop/DELETE = revoke。**

| 入口 | 模式 | 说明 |
|---|---|---|
| advanceTaskCore | ✅ claim（appendAction 前、现 claimTaskStartOwner 位置） | 换主=接管前任（含在飞 one-shot / ask-consume） |
| resumeCurrentActionCore | ✅ claim（入口 getTask 后同步、现位置） | 同 action 双唤醒靠 opId 区分 |
| startOneShotQuestion | 👁 observer（受理段快照） | 不夺主（问一问不得顶死在飞启动链）；后继 claim / stop revoke 后它的 restore 写自动失效（W3）；runningTasks 层的 predecessor handoff 照旧（R22-5） |
| deliverAskReply / sendToTaskSession 续接 consume | 👁 observer（send 受理时快照） | 同上：答问答不夺主；后继 advance/resume claim 后其收尾写全部失效（R21-5/R22-4） |
| ask-reply 僵尸兜底分支 | 👁 observer | 门控 = observer 快照仍 current + 无 session + expectedRunStatus 结构条件 |
| stopTaskAgent / DELETE | revokeTaskOps（bump gen + 清 currentOpId） | 替换 bumpTaskOpGeneration 调用点 |

claim 失败（返 null）= 准入已作废，语义同旧 `abortIfTaskOpStale` 抛错路径。
⚠️ observer 的 opId 可能恰好等于某 owner 的 opId（快照到在飞 owner）——所以 releaseTaskOpIf
必须按 `kind === "owner"` 才真删，防 observer 收尾把 owner 的号误释放。

### 3. 判定替换清单（call-site mapping）

| 现状 | 改成 |
|---|---|
| `stillStartOwner()` + `opts.opGen` 比对 + lifecycle 查（handleRunFailure 复合闭包） | `isOpOwner(handle)`（+ 可选 `opts.isOwner` 资源归属，见下） |
| `lostStartOwner()`（consume） | `!isOpOwner(handle)` |
| `yieldStartIfLostOwner`（internalStartAgent） | 判定换 `!isOpOwner(handle)`、让位动作不变 |
| `abortIfTaskOpStale(id, opGen)` | `if (!isOpOwner(handle)) throw ...`（claim 之后的检查点）；claim 之前的准入检查保留 gen 快照比对 |
| consume 入口 stop-signal 的 `opGen 不匹配` | `!isTaskOpCurrent(handle)` |
| finalizeFailedStartIntent 的三条件 | `isOpOwner(handle)` |
| handleRunFailure 发 envelope 前重验 | `isOpOwner(handle)`（每个 await 后同一入口） |

`runningTasks.instanceId` / `session.instanceId` **保留但降级为资源归属**：只用于
「删自己的 runningTasks 记录」「按号关自己的 session」（finally / closeMySession /
yieldIfSuperseded），**一律不再参与共享状态写的门控**（状态写门控只认 isOpOwner + 盘上结构条件）。
`pendingStopRequests` / `forkPendingTasks` 语义不变。

`task-fs.ts` 条件事务 helper（patchActionAndRunStatusIfOpFresh / setTaskRunStatusIfRunOwner）
**签名不变**（isOwner 闭包 + 结构条件 + prepare/commit 协议不变），调用方统一传 `() => isOpOwner(handle)`。

### 4. 统一收尾 coordinator

`task-runner.ts` 新增唯一收尾函数，start 链 catch、consume finally、handleRunFailure 尾部全部收口：

```ts
/**
 * 唯一 op 收尾：
 * - 仍是 owner：按 outcome 条件事务写 action/task 终态（结构条件照旧）
 * - 已失主：只清本地资源（自己的 runner record / session by instanceId / 本地 agent）
 * - 无论哪种：releaseTaskOpIf（匹配才删）
 */
const finalizeOperation = async (
  h: TaskOpHandle,
  outcome: "cancelled" | "error" | "yielded",
  ctx: { actionId?: string; runnerInstanceId?: number; sessionInstanceId?: number; agent?: ... },
): Promise<void>;
```

禁止链路中间自写共享状态（patchAction/setTaskRunStatus 裸调），全部走条件事务 + isOpOwner。

### 5. failpoint 测试基建

新文件 `src/lib/server/failpoints.ts`：

```ts
type FailpointFn = () => void | Promise<void>;
const hooks = new Map<string, FailpointFn>();
/** 生产零开销：未注册直接返回；测试 setFailpoint 注入「stop / 二次唤醒 / advance」 */
export const failpoint = async (name: string): Promise<void> => {
  const fn = hooks.get(name);
  if (fn) await fn();
};
export const setFailpoint = (name: string, fn: FailpointFn): void => { hooks.set(name, fn); };
export const clearFailpoints = (): void => { hooks.clear(); };
```

task-runner 固定插桩点（名字就用这些、测试按名注入）：

- `advance.afterClaim`（claim 后、appendAction 前）
- `advance.afterAppend`（append 后、baseline 前）
- `advance.beforeHandoff`（internalStartAgent 调用前）
- `start.afterCreate`（Agent.create resolve 后）
- `start.afterPrompt`（prompt 素材收割后）
- `start.afterSend`（send resolve 后、预登记前）
- `resume.afterClaim`（resume claim 后、关旧会话前）
- `resume.beforeStatusWrite`（patchAction running 前）
- `consume.afterWait`（run.wait 返回后）
- `consume.beforeFinalize`（自然结束业务收尾前）
- `failure.beforePrepare`（handleRunFailure 条件事务前）
- `failure.beforePublish`（发 task 级 envelope 前）

矩阵测试（新文件 `tests/ownership-failpoint-matrix.test.ts`）：
{插桩点} × {注入动作：stop / 同 action resume / advance 新 action / 抛错}，
每个组合跑真实调用链（advanceTask / resumeCurrentActionWithMessage + mock Agent），断言固定不变量：

- **I1 终态不回退**：cancelled/completed 的 action、idle 的 task 不被迟到写改成 error/running
- **I2 无僵尸**：链路收敛后无「action running 但无活 runner 且 op 无人持有」
- **I3 后继不被伤**：接管后前任的写不落盘、不发 task 级 done(false)/error envelope
- **I4 无泄漏**：收敛后 currentOpId 要么 null 要么属于活跃 run；runningTasks/session 无孤儿
- **I5 stop 终态**：stop 完成后 runStatus=idle + 非终态 action=cancelled、不被迟到写覆盖

R22-1～R22-6 六个点名场景改写为矩阵里的定向用例（同文件、注明对应编号）。

## 范围控制

**只动**：`task-stream.ts`、`task-runner.ts`、`stop-task.ts`、`task-fs.ts`（如需）、
`app/api/tasks/[id]/{advance,question,ask-reply}/route.ts`、`failpoints.ts`（新）、相关测试。
**不动**：chat-runner / chat-gate 内部 lease 机制（只消费 getChatLifecycle）、UI、rewind、queue、checkpoint。

## 迁移约束

- 开发期不写向后兼容：旧 API（claimTaskStartOwner / isTaskStartOwner / releaseTaskStartOwnerIf /
  bumpTaskOpGeneration 直调）直接删，引用处全部迁新 API；global key V11 → V12。
- 现有 645 项测试是行为资产：断言全部保留，仅迁移 claim/API 管道代码；不得删除或弱化断言。
- 门禁：`pnpm typecheck` + `pnpm lint`（0 warning）+ `pnpm test` 连跑两遍 + `pnpm build`。
