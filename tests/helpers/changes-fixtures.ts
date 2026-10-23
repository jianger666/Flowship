/**
 * 代码改动面板测试的共用夹具：造一个文件 / 一个仓的改动结果。
 * （放 helpers/ 不会被当成用例——vitest 只收 tests/**\/*.test.ts）
 */
import type { TaskChangeFile, TaskRepoChanges } from "@/lib/types";

export const makeFile = (over: Partial<TaskChangeFile> & { path: string }): TaskChangeFile => ({
  status: "modified",
  added: 3,
  removed: 1,
  binary: false,
  untracked: false,
  absolutePath: `/work/app/${over.path}`,
  ...over,
});

export const makeRepo = (over: Partial<TaskRepoChanges> = {}): TaskRepoChanges => {
  const files = over.files ?? [];
  return {
    repoPath: "/work/app",
    shortName: "app",
    workDir: "/work/app",
    isolated: false,
    branch: "feat/diff",
    base: { kind: "merge-base", label: "origin/main", shortSha: "abc1234" },
    files,
    totals: {
      files: files.length,
      added: files.reduce((s, f) => s + (f.added ?? 0), 0),
      removed: files.reduce((s, f) => s + (f.removed ?? 0), 0),
    },
    ...over,
  };
};
