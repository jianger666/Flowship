/**
 * 推进失败「是否补写 error 事件」判定（纯函数）。
 *
 * 场景起点：ensureTaskWorktrees 抛错时 runner 不写事件、路由只回 400——
 * 用户关弹窗后事件流里查不到失败原因。路由补写，但必须保守：
 * 让位 / 准入拒绝 / 已写过 / 正在跑 / 终态 都不写。
 */
import { describe, expect, it } from "vitest";

import {
  ADVANCE_ADMISSION_REJECT_PREFIX,
  shouldRecordAdvanceFailure,
  type AdvanceFailureContext,
} from "../src/lib/server/advance-failure";

const STALE = "正在停止/任务已变更、请重发";
const WORKTREE_MSG =
  "仓库 /repo/a 创建隔离工作区失败（分支 flow/x）：fatal: not a git repository\n下一步：检查主仓是否可达";

const ctx = (over: Partial<AdvanceFailureContext> = {}): AdvanceFailureContext => ({
  message: WORKTREE_MSG,
  staleMessage: STALE,
  startedAt: 1_000,
  recentEvents: [],
  runStatus: "idle",
  repoStatus: "developing",
  ...over,
});

describe("shouldRecordAdvanceFailure", () => {
  it("ensureTaskWorktrees 类失败（runner 没写事件、任务空闲）→ 要补写", () => {
    expect(
      shouldRecordAdvanceFailure(
        ctx({
          // runner 只写过「正在准备工作区…」info，没有 error
          recentEvents: [
            { kind: "info", text: "正在准备工作区…", ts: 1_001 },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("runStatus=error 的任务重试推进又失败 → 仍要补写（推进是恢复手段）", () => {
    expect(shouldRecordAdvanceFailure(ctx({ runStatus: "error" }))).toBe(true);
    expect(shouldRecordAdvanceFailure(ctx({ runStatus: "awaiting_user" }))).toBe(
      true,
    );
  });

  it("让位文案（stop / 任务已变更）不写：那是用户主动停的，不是推进失败", () => {
    expect(shouldRecordAdvanceFailure(ctx({ message: STALE }))).toBe(false);
    // 首尾空白不影响比对
    expect(shouldRecordAdvanceFailure(ctx({ message: `  ${STALE}\n` }))).toBe(
      false,
    );
  });

  it("准入条件不满足（前置校验拒绝）不写：什么都没开始、弹窗已给原因", () => {
    expect(
      shouldRecordAdvanceFailure(
        ctx({ message: `${ADVANCE_ADMISSION_REJECT_PREFIX}：build 前必须先有 plan` }),
      ),
    ).toBe(false);
  });

  it("任务正在 running（并发撞车）/ 已终态不写：避免给正常在跑的任务塞红色失败", () => {
    expect(shouldRecordAdvanceFailure(ctx({ runStatus: "running" }))).toBe(false);
    expect(shouldRecordAdvanceFailure(ctx({ repoStatus: "merged" }))).toBe(false);
    expect(shouldRecordAdvanceFailure(ctx({ repoStatus: "abandoned" }))).toBe(
      false,
    );
  });

  it("runner 已写过同文案 error（wk 门禁 / 测试任务切分支）→ 不重复写", () => {
    expect(
      shouldRecordAdvanceFailure(
        ctx({
          recentEvents: [{ kind: "error", text: WORKTREE_MSG, ts: 1_050 }],
        }),
      ),
    ).toBe(false);
  });

  it("只认本次请求之后的 error：更早的同文案 error 不算已写（上一次推进失败留下的）", () => {
    expect(
      shouldRecordAdvanceFailure(
        ctx({
          recentEvents: [{ kind: "error", text: WORKTREE_MSG, ts: 999 }],
        }),
      ),
    ).toBe(true);
  });

  it("别的 error 文案 / 别的 kind 同文案都不算已写", () => {
    expect(
      shouldRecordAdvanceFailure(
        ctx({
          recentEvents: [
            { kind: "error", text: "另一件事出错了", ts: 1_100 },
            { kind: "info", text: WORKTREE_MSG, ts: 1_100 },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("空文案不写（没有可留痕的内容）", () => {
    expect(shouldRecordAdvanceFailure(ctx({ message: "   " }))).toBe(false);
  });
});
