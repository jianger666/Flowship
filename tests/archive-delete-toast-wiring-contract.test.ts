/**
 * 归档 / 删除 toast 与存储页「删残留工作区」的接线契约（第三轮 review F1-03/04/05、D2b-01/03/06）。
 *
 * 行为本身由 worktree-report.test.ts（纯函数）与 *-route.test.ts（服务端）覆盖；
 * 这里只钉「组件没有退回按任务形状预测 / 裸 fs.rm 式删除」这类接线，tsconfig 是 jsx:preserve，组件没法直接 import。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

const sessions = src("src/app/sessions/page.tsx");
const sidebar = src("src/components/app-sidebar.tsx");

describe("归档 toast：文案只认服务端回报（D2b-06）", () => {
  for (const [name, text] of [
    ["会话管理页", sessions],
    ["侧栏", sidebar],
  ] as const) {
    it(`${name}：用 setTaskArchivedWithReport + buildArchiveToast，不再自己按任务形状拼「已清理隔离工作区」`, () => {
      expect(text).toContain("setTaskArchivedWithReport(task.id, ");
      expect(text).toContain("buildArchiveToast(");
      expect(text).not.toMatch(/已(停止并)?清理隔离工作区/);
      // 旧的单参 setTaskArchived 不会被误用回去（它丢掉 report）
      expect(text).not.toMatch(/[^\w]setTaskArchived\(/);
    });

    it(`${name}：撤销归档拿到的恢复结果会告诉用户（D2b-03；Q9-06 起「已过点记为已错过」也说，由 restoreToastNeeded 判）`, () => {
      expect(text).toContain("restoreToastNeeded(restoreReport)");
      expect(text).toContain("buildRestoreToast(");
      // 不退回「只在 restoredSchedules > 0 才说」的旧口径（那样过点的定时静默）
      expect(text).not.toMatch(/restoreReport\?\.restoredSchedules \?\? 0\) > 0/);
    });
  }

  it("保留目录时 toast 走 warning 而不是 success", () => {
    expect(sessions).toMatch(/archiveToast\.kind === "warning" \? toast\.warning : toast\.success/);
    expect(sidebar).toMatch(/archiveToast\.kind === "warning" \? toast\.warning : toast\.success/);
  });
});

describe("会话管理页：删除链路（F1-03 / F1-05 / D2b-01）", () => {
  it("删会话：带 onReport 拿服务端回报，用 buildDeleteToast 出文案", () => {
    expect(sessions).toMatch(/deleteTaskById\(task\.id, \{ onReport:/);
    expect(sessions).toContain("buildDeleteToast(task.title, report)");
    expect(sessions).not.toContain("toast.success(`已彻底删除「${task.title}」`)");
  });

  it("确认文案提醒「可能有未提交的代码」，单删 / 批量删都带上", () => {
    expect(sessions).toMatch(/const DELETE_UNCOMMITTED_NOTE =\s*"[^"]*未提交的代码/);
    const singleAt = sessions.indexOf('title: "彻底删除？"');
    expect(sessions.slice(singleAt, singleAt + 500)).toContain("DELETE_UNCOMMITTED_NOTE");
    const batchAt = sessions.indexOf("title: `删除 ${toDelete.size} 项？`");
    expect(sessions.slice(batchAt, batchAt + 600)).toContain("DELETE_UNCOMMITTED_NOTE");
    const staleAt = sessions.indexOf('title: "删除残留工作区？"');
    expect(sessions.slice(staleAt, staleAt + 400)).toContain("未提交的代码");
  });

  it("残留工作区：被守卫拦下（409）→ 二次确认 → 才带 force=1 重发；批量里不替用户强删", () => {
    expect(sessions).toContain("interpretStaleDeleteResponse(res.status, body)");
    expect(sessions).toContain('force ? "&force=1" : ""');
    const handleAt = sessions.indexOf("const handleDeleteStale = async");
    const handle = sessions.slice(handleAt, handleAt + 2500);
    expect(handle).toContain('outcome.kind === "kept"');
    expect(handle).toContain("buildStaleForceDescription(outcome.kept)");
    expect(handle).toContain("deleteStaleWorktree(s.id, true)");
    // 批量只调不带 force 的版本
    const batchAt = sessions.indexOf("const handleBatchDelete = async");
    const batch = sessions.slice(batchAt, sessions.indexOf("const restorePinnedOrder", batchAt) > 0 ? sessions.indexOf("const restorePinnedOrder", batchAt) : batchAt + 4000);
    expect(batch).toContain("deleteStaleWorktree(jobs[i].id)");
    expect(batch).not.toContain("force=1");
    expect(batch).not.toMatch(/deleteStaleWorktree\([^)]*true\)/);
    // 不再有「只看 res.ok」的裸 fetch 删除
    expect(batch).not.toContain("if (!res.ok) throw new Error(`HTTP ${res.status}`)");
  });
});

describe("存储页 GET：任务目录 du 有界并发（D2b-02）", () => {
  it("storage route 不再对 task 目录串行 await dirSize（见 storage-du-concurrency.test.ts 的行为测试）", () => {
    const route = src("src/app/api/system/storage/route.ts");
    expect(route).not.toMatch(/for \(const \w+ of [^)]*\) \{\s*[^}]*await dirSize\(/);
  });
});
