/**
 * 代码改动入口的三条业务判断（src/lib/changes/panel-state.ts）：
 * 能不能取数 / 要不要挂入口 / 选中的提交失效后要不要自动回落。
 *
 * 这些规则写在组件里就只能靠肉眼，而 UI 又没法在这个环境里真机看——所以抽成纯函数、在这里钉死。
 */
import { describe, expect, it } from "vitest";

import {
  canLoadChanges,
  shouldFallBackToBranch,
  shouldShowChangesEntry,
} from "@/lib/changes/panel-state";
import type { TaskChangeScope, TaskRepoChanges } from "@/lib/types";

import { makeRepo } from "./helpers/changes-fixtures";

const unavailable = (u: NonNullable<TaskRepoChanges["unavailable"]>, path = "/w/a"): TaskRepoChanges =>
  makeRepo({ repoPath: path, shortName: path, unavailable: u, base: null });

describe("canLoadChanges：有工作目录且绑了仓才取数", () => {
  it("有 workCwd 且有仓 → 可以", () => {
    expect(canLoadChanges({ workCwd: "/w/a", repoPaths: ["/w/a"] })).toBe(true);
  });

  it("没有 workCwd（task 未启动 / chat 没选目录）→ 不取", () => {
    expect(canLoadChanges({ workCwd: undefined, repoPaths: ["/w/a"] })).toBe(false);
    expect(canLoadChanges({ workCwd: "", repoPaths: ["/w/a"] })).toBe(false);
  });

  it("没有仓 → 不取（chat 的 repoPaths[0] 是用户选的目录，空了就是没选）", () => {
    expect(canLoadChanges({ workCwd: "/w/a", repoPaths: [] })).toBe(false);
  });
});

describe("shouldShowChangesEntry：入口 chip 要不要挂", () => {
  it("没有任何仓信息 → 不挂", () => {
    expect(shouldShowChangesEntry([], false)).toBe(false);
    expect(shouldShowChangesEntry([], true)).toBe(false);
  });

  it("正常的仓 → 挂（task / chat 都是）", () => {
    expect(shouldShowChangesEntry([makeRepo()], false)).toBe(true);
    expect(shouldShowChangesEntry([makeRepo()], true)).toBe(true);
  });

  it("chat：目录不是 git 仓库 / 目录不存在 → 不挂（挂一个只会说「不是 git 仓库」的按钮没意义）", () => {
    expect(shouldShowChangesEntry([unavailable("not_git")], true)).toBe(false);
    expect(shouldShowChangesEntry([unavailable("dir_missing")], true)).toBe(false);
    expect(
      shouldShowChangesEntry([unavailable("not_git", "/w/a"), unavailable("dir_missing", "/w/b")], true),
    ).toBe(false);
  });

  it("chat：只要有一个仓能读就挂", () => {
    expect(shouldShowChangesEntry([unavailable("not_git", "/w/a"), makeRepo({ repoPath: "/w/b" })], true)).toBe(
      true,
    );
  });

  it("chat：读失败 / 还没有提交 → 照挂（点开能看到原因、能刷新，比入口凭空消失强）", () => {
    expect(shouldShowChangesEntry([unavailable("git_error")], true)).toBe(true);
    expect(shouldShowChangesEntry([unavailable("no_head")], true)).toBe(true);
  });

  it("task：不是 git 的仓照挂（面板里逐仓说明原因，多仓时别的仓还有内容）", () => {
    expect(shouldShowChangesEntry([unavailable("not_git")], false)).toBe(true);
    expect(shouldShowChangesEntry([unavailable("dir_missing")], false)).toBe(true);
  });
});

describe("shouldFallBackToBranch：选中的提交失效 → 自动切回整条分支", () => {
  const commit: TaskChangeScope = { kind: "commit", sha: "a".repeat(40) };
  const invalid = (path = "/w/a") => unavailable("scope_invalid", path);

  it("单仓：commit 范围 + 该仓 scope_invalid → 回落", () => {
    expect(shouldFallBackToBranch(commit, [invalid()], false)).toBe(true);
  });

  it("多仓：所有仓都 scope_invalid 才回落", () => {
    expect(shouldFallBackToBranch(commit, [invalid("/w/a"), invalid("/w/b")], false)).toBe(true);
  });

  it("多仓：只有一个仓失效 → 不回落（别的仓还有内容，失效仓里面板自己提示）", () => {
    expect(shouldFallBackToBranch(commit, [invalid("/w/a"), makeRepo({ repoPath: "/w/b" })], false)).toBe(
      false,
    );
  });

  it("响应还没跟上当前查询（stale）→ 不判断，那份 data 是上一个范围的", () => {
    expect(shouldFallBackToBranch(commit, [invalid()], true)).toBe(false);
  });

  it("不是 commit 范围 → 永不回落（branch / uncommitted 本来就是兜底范围）", () => {
    expect(shouldFallBackToBranch({ kind: "branch" }, [invalid()], false)).toBe(false);
    expect(shouldFallBackToBranch({ kind: "uncommitted" }, [invalid()], false)).toBe(false);
  });

  it("还没有数据 / 仓清单为空 → 不回落", () => {
    expect(shouldFallBackToBranch(commit, null, false)).toBe(false);
    expect(shouldFallBackToBranch(commit, [], false)).toBe(false);
  });

  it("commit 范围读到了正常内容 → 不回落", () => {
    expect(shouldFallBackToBranch(commit, [makeRepo()], false)).toBe(false);
  });

  it("别的失败原因（git_error / not_git）不触发回落——那是读不到，不是提交失效", () => {
    expect(shouldFallBackToBranch(commit, [unavailable("git_error")], false)).toBe(false);
    expect(shouldFallBackToBranch(commit, [unavailable("not_git")], false)).toBe(false);
  });
});
