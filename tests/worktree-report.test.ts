/**
 * 客户端 toast 文案只认服务端回报（review F1-03 / F1-05 / D2b-06）：纯函数行为测试。
 */
import { describe, expect, it } from "vitest";

import {
  buildArchiveToast,
  buildDeleteToast,
  buildRestoreToast,
  buildStaleDeletedToast,
  buildStaleForceDescription,
  collectWorktreeRemoval,
  interpretStaleDeleteResponse,
  newDeleteWorktreeReport,
  restoreScheduleParts,
  restoreToastNeeded,
  worktreeReportBody,
  type ArchiveReport,
} from "@/lib/worktree-report";

const keptItem = (repoPath: string) => ({ repoPath, workDir: `/wt/${repoPath}`, reason: "子模块有改动" });
const report = (patch: Partial<ArchiveReport> = {}): ArchiveReport => ({
  cancelledSchedules: 0,
  restoredSchedules: 0,
  ...patch,
});

describe("buildArchiveToast：以服务端回报为准，不按任务形状预测", () => {
  it("清理成功：说已清理隔离工作区；跑着的任务说「已停止并清理」", () => {
    const wt = { removed: true, kept: [], snapshotCount: 0 };
    expect(buildArchiveToast({ title: "A", wasRunning: false, report: report({ worktree: wt }) })).toEqual({
      kind: "success",
      message: "已归档「A」、已清理隔离工作区",
    });
    expect(buildArchiveToast({ title: "A", wasRunning: true, report: report({ worktree: wt }) }).message).toBe(
      "已归档「A」、已停止并清理隔离工作区",
    );
  });

  it("快照失败而保留：绝不说「已清理」，改成 warning 并点出仓名", () => {
    const t = buildArchiveToast({
      title: "A",
      wasRunning: false,
      report: report({ worktree: { removed: false, kept: [keptItem("/code/web")], snapshotCount: 0 } }),
    });
    expect(t.kind).toBe("warning");
    expect(t.message).not.toContain("已清理");
    expect(t.message).toContain("web");
    expect(t.message).toContain("已保留");
  });

  it("部分清理部分保留：说「其余」而不是全清了", () => {
    const t = buildArchiveToast({
      title: "A",
      wasRunning: false,
      report: report({ worktree: { removed: true, kept: [keptItem("/code/web")], snapshotCount: 0 } }),
    });
    expect(t.kind).toBe("warning");
    expect(t.message).toContain("已清理其余隔离工作区");
  });

  it("落了快照：告诉用户未提交的改动已存成快照", () => {
    const t = buildArchiveToast({
      title: "A",
      wasRunning: false,
      report: report({ worktree: { removed: true, kept: [], snapshotCount: 2 } }),
    });
    expect(t.message).toContain("未提交的改动已存成快照");
  });

  it("没有 worktree 回报（chat / 非隔离任务）：不会凭空说已清理；跑着的说仍在后台跑", () => {
    expect(buildArchiveToast({ title: "A", wasRunning: false, report: report() }).message).toBe("已归档「A」");
    expect(buildArchiveToast({ title: "A", wasRunning: true, report: report() }).message).toBe(
      "已归档「A」、任务仍在后台跑",
    );
    // 老服务端没带 report：同样保守
    expect(buildArchiveToast({ title: "A", wasRunning: false, report: undefined }).message).toBe("已归档「A」");
  });

  it("取消了定时：toast 说出来并提示取消归档可恢复（D2b-03）", () => {
    const t = buildArchiveToast({ title: "A", wasRunning: false, report: report({ cancelledSchedules: 3 }) });
    expect(t.message).toBe("已归档「A」、3 个定时已取消（取消归档可恢复）");
  });
});

describe("buildRestoreToast", () => {
  it("恢复了定时才提；没有就是朴素文案", () => {
    expect(buildRestoreToast("A", report({ restoredSchedules: 2 }))).toBe("已恢复「A」、2 个定时已恢复");
    expect(buildRestoreToast("A", report())).toBe("已恢复「A」");
    expect(buildRestoreToast("A", undefined)).toBe("已恢复「A」");
  });

  it("Q9-06：已过点记为「已错过」/ 已用满次数记为「已结束」也要说（归档时承诺过「取消归档可恢复」）", () => {
    // 只有过点的：以前什么提示都没有
    const onlyMissed = report({ missedSchedules: 1 });
    expect(restoreToastNeeded(onlyMissed)).toBe(true);
    expect(buildRestoreToast("A", onlyMissed)).toBe("已恢复「A」、1 个定时在归档期间已过点、记为「已错过」");
    // 混合：恢复 + 过点 + 用满，分句按固定顺序
    expect(buildRestoreToast("A", report({ restoredSchedules: 2, missedSchedules: 1, endedSchedules: 1 }))).toBe(
      "已恢复「A」、2 个定时已恢复、1 个定时在归档期间已过点、记为「已错过」、1 个定时已用满次数、记为「已结束」",
    );
    expect(restoreScheduleParts(report({ restoredSchedules: 1 }))).toEqual(["1 个定时已恢复"]);
    // 没有任何定时结果 → 不弹（没定时不打扰）；旧服务端不带新字段 → 当 0
    expect(restoreToastNeeded(report())).toBe(false);
    expect(restoreToastNeeded(undefined)).toBe(false);
    expect(restoreToastNeeded({ cancelledSchedules: 0, restoredSchedules: 0 })).toBe(false);
  });
});

describe("删除任务：回报收集与 toast", () => {
  it("collectWorktreeRemoval：有详细失败信息用详细的；老形状回退到仓路径列表", () => {
    const r = newDeleteWorktreeReport();
    collectWorktreeRemoval(r, {
      snapshotFailedRepos: ["/code/web"],
      snapshotFailures: [{ repoPath: "/code/web", workDir: "/wt/web", reason: "冲突" }],
      snapshots: [{ repoPath: "/code/api", ref: "refs/flowship/wip/t-api" }],
    });
    expect(r.kept).toEqual([{ repoPath: "/code/web", workDir: "/wt/web", reason: "冲突" }]);
    expect(r.snapshots).toEqual([{ repoPath: "/code/api", ref: "refs/flowship/wip/t-api" }]);

    const legacy = newDeleteWorktreeReport();
    collectWorktreeRemoval(legacy, { snapshotFailedRepos: ["/code/web"] });
    expect(legacy.kept).toHaveLength(1);
    expect(legacy.kept[0].repoPath).toBe("/code/web");
    collectWorktreeRemoval(legacy, null);
    collectWorktreeRemoval(undefined, { snapshotFailedRepos: ["/x"] });
    expect(legacy.kept).toHaveLength(1);
  });

  it("worktreeReportBody：干净时响应不带多余字段", () => {
    expect(worktreeReportBody(newDeleteWorktreeReport())).toEqual({});
    const r = newDeleteWorktreeReport();
    r.kept.push(keptItem("/code/web"));
    expect(Object.keys(worktreeReportBody(r))).toEqual(["worktreeKept"]);
  });

  it("buildDeleteToast：保留的目录要警示并指路；快照告知可找回；干净就是朴素成功", () => {
    expect(buildDeleteToast("A", undefined)).toEqual({ kind: "success", message: "已彻底删除「A」" });
    const kept = buildDeleteToast("A", { worktreeKept: [keptItem("/code/web")] });
    expect(kept.kind).toBe("warning");
    expect(kept.message).toContain("目录已保留");
    expect(kept.message).toContain("会话管理");
    const snap = buildDeleteToast("A", { worktreeSnapshots: [{ repoPath: "/code/web", ref: "refs/x" }] });
    expect(snap).toEqual({ kind: "success", message: "已彻底删除「A」、工作区里未提交的改动已存成快照" });
  });
});

describe("存储页残留工作区", () => {
  it("interpretStaleDeleteResponse：200 → ok（带快照）；409+kept → kept；409 无 kept → 抛出服务端原话", () => {
    expect(interpretStaleDeleteResponse(200, { ok: true, snapshots: [{ ref: "refs/x" }] })).toEqual({
      kind: "ok",
      snapshots: [{ ref: "refs/x" }],
    });
    expect(interpretStaleDeleteResponse(200, null)).toEqual({ kind: "ok", snapshots: [] });
    expect(
      interpretStaleDeleteResponse(409, { error: "x", kept: [{ dirName: "web", reason: "冲突" }] }),
    ).toEqual({ kind: "kept", kept: [{ dirName: "web", reason: "冲突" }] });
    expect(() => interpretStaleDeleteResponse(409, { error: "任务仍存在、请走任务删除" })).toThrow(
      "任务仍存在、请走任务删除",
    );
    expect(() => interpretStaleDeleteResponse(500, null)).toThrow("HTTP 500");
  });

  it("buildStaleForceDescription：点明可能有未提交代码、列出目录与原因，过长折叠", () => {
    const d = buildStaleForceDescription([{ dirName: "web", reason: "子模块有改动" }]);
    expect(d).toContain("未提交代码");
    expect(d).toContain("web：子模块有改动");
    const many = buildStaleForceDescription(
      Array.from({ length: 7 }, (_, i) => ({ dirName: `d${i}`, reason: "r" })),
    );
    expect(many).toContain("另有 2 个");
  });

  it("buildStaleDeletedToast", () => {
    expect(buildStaleDeletedToast(undefined)).toBe("已删除残留工作区");
    expect(buildStaleDeletedToast([{ ref: "a" }, { ref: "b" }])).toContain("2 个目录里未提交的改动已存成快照");
  });
});
