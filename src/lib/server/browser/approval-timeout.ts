/**
 * 主进程会弹 evaluate 审批卡的工具，server 侧本地超时该给多长（R6-33）。
 *
 * # 背景
 * 主进程 `ensureEvaluateApproval`（electron-app/browser/evaluate-approval.mjs）最长等用户 120 秒（`EVALUATE_PROMPT_TIMEOUT_MS`）；
 * 而 bridge 的默认本地超时只有 60 秒（`BROWSER_DEFAULT_REQUEST_TIMEOUT_MS`）。凡是会弹审批卡的工具不给更长的 `timeoutMs`，server 就在 60 秒时
 * 发带 id 的 `cancel` 把审批卡撤掉：用户在 60–120 秒之间点了「允许」也无效，AI 拿到的是「超过 60 秒没有响应」而不是 `DENIED`。
 * `browser_evaluate` 早就按「审批等待 + slack」给了 135 秒；heap_snapshot / 可执行 mock / debug 的 condition·scope 现在也走同一道审批，必须同口径。
 *
 * # 口径
 * 本地超时 = 审批等待（120s）+ 动作自身预算 + slack（15s）：本地超时必须比主进程自己的超时长一截，才能拿到主进程返回的 `DENIED` / 结果，
 * 而不是本地先炸。**只在「可能弹审批」时加长**：
 *  · 总闸（`evaluateEnabled`）开着 → 主进程一定免审批 → 用默认超时（返回 `undefined`）；
 *  · 总闸关着 → server 无法预知本会话有没有「仅本任务」批准（那是主进程会话态），所以对**会弹审批的 action 一律加长**——
 *    代价只是「主进程真卡死时 server 多等一会儿」，比「用户批准了却被 60 秒超时撤卡」轻得多。
 * 不会弹审批的 action（block / set_headers / list / metrics / list_breakpoints …）保持默认超时。
 */

/** 与主进程 evaluate-approval.mjs 的 `EVALUATE_PROMPT_TIMEOUT_MS` 一致（`tests/browser-r6-approval-timeout.test.ts` 对账） */
export const EVALUATE_APPROVAL_WAIT_MS = 120_000;
/** 本地超时要比对端自己的超时长一截，否则本地先炸、对端的语义（DENIED / matched:false …）就丢了 */
export const WAITING_SLACK_MS = 15_000;
/** 审批通过后动作自身的预算：创建 mock 规则（Fetch.enable ≤8s + 动作队列）/ 设条件断点（启用调试器 + setBreakpointByUrl） */
export const APPROVAL_ACTION_BUDGET_MS = 15_000;
/** debug scope：批准后还要逐个作用域读属性（每个 CDP 调用有自己的超时） */
export const DEBUG_SCOPE_ACTION_BUDGET_MS = 30_000;
/** heap_snapshot：批准后才开始取快照（≤500MB 的流式写盘 + 摘要解析），预算给 3 分钟；加起来 ≥300s */
export const HEAP_SNAPSHOT_ACTION_BUDGET_MS = 180_000;

/** 审批等待 + 动作预算 + slack */
export const approvalBridgeTimeoutMs = (actionBudgetMs: number = APPROVAL_ACTION_BUDGET_MS): number =>
  EVALUATE_APPROVAL_WAIT_MS + Math.max(0, actionBudgetMs) + WAITING_SLACK_MS;

/**
 * 「可能弹审批」的 action 的本地超时：总闸开着 → `undefined`（走 bridge 默认超时）；否则 {@link approvalBridgeTimeoutMs}。
 * 返回值可直接展开进 `run()` 的 spec：`...(t !== undefined ? { timeoutMs: t } : {})`。
 */
export const approvalAwareTimeoutMs = (opts: { evaluateEnabled: boolean; actionBudgetMs?: number }): number | undefined =>
  opts.evaluateEnabled ? undefined : approvalBridgeTimeoutMs(opts.actionBudgetMs);
