/**
 * 收尾钩子：wk 阶段门禁怎么并进 runActionCheck 的 postCheck
 *
 * 只验「接线」——门禁本体在 wk-gate.test.ts 验过了、这里 mock 掉。
 * 要锁的三件事：
 * 1. 非 wk action 完全不受影响（普通 custom action 的判定不变）
 * 2. 阶段门禁未过 → postCheck.passed=false，且明细带上人可读文案（UI 红条靠它）
 * 3. 门禁降级 / 抽风绝不把本来能过的 action 判黑
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "wk-poststage-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

/** wk-gate 整体 mock：逐例设定 plan / report */
const gate = vi.hoisted(() => ({
  plan: { applies: false, reason: "not-wk", message: "" } as unknown,
  report: { verdict: "pass", message: "wk:repo-execute 阶段门禁已通过" },
  planThrows: false,
}));

vi.mock("@/lib/server/wk-gate", () => ({
  planWkGateForAction: async () => {
    if (gate.planThrows) throw new Error("门禁模块炸了");
    return gate.plan;
  },
  runWkPostStage: async () => gate.report,
}));

const { runActionCheck } = await import("@/lib/server/action-checks");
const { getActionArtifactPath } = await import("@/lib/server/task-fs-core");

/** 造一个 artifact 已落盘的 custom action——checkCustom 本身会过 */
const makeCase = async (): Promise<{ task: Task; action: ActionRecord }> => {
  const n = 1;
  const action: ActionRecord = {
    id: "act_1",
    n,
    type: "custom",
    status: "awaiting_ack",
    userInstruction: "",
    artifactPath: `actions/${n}-custom.md`,
    customActionId: "team:wk-repo-execute",
    startedAt: Date.now(),
    endedAt: Date.now(),
  };
  const task = {
    id: `t_wk_${Math.random().toString(36).slice(2, 8)}`,
    title: "wk-post-stage",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: action.id,
    actions: [action],
    events: [],
    mrs: [],
    repoPaths: [path.join(TMP_ROOT, "repo")],
    nonGitRepoPaths: [path.join(TMP_ROOT, "repo")],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Task;

  const abs = getActionArtifactPath(task.id, n, "custom");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "# 产出\n\n干完了。\n");
  return { task, action };
};

beforeEach(() => {
  gate.plan = { applies: false, reason: "not-wk", message: "" };
  gate.report = { verdict: "pass", message: "wk:repo-execute 阶段门禁已通过" };
  gate.planThrows = false;
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("runActionCheck × wk 阶段门禁", () => {
  it("非 wk action：结果就是原来的类型检查结果、details 不被污染", async () => {
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(true);
    expect(result.details).toBe("自定义 action artifact 已落盘");
  });

  it("wk 门禁通过：passed 仍 true、details 追加门禁结论", async () => {
    gate.plan = {
      applies: true,
      command: "wk:repo-execute",
      stage: "repo-execute",
    };
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);

    expect(result.passed).toBe(true);
    expect(result.details).toContain("自定义 action artifact 已落盘");
    expect(result.details).toContain("阶段门禁已通过");
  });

  it("wk 门禁未过：passed=false + 人可读明细（UI 挂红条让用户知道补什么）", async () => {
    gate.plan = { applies: true, command: "wk:repo-execute" };
    gate.report = {
      verdict: "blocked",
      message:
        "wk:repo-execute 阶段门禁未过：repo-execute quality gate failed\n- verification.md: missing marker `## Unverified Items`",
    };
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);

    expect(result.passed).toBe(false);
    expect(result.details).toContain("## Unverified Items");
    // 类型检查的结论也保留——两边信息都要给用户
    expect(result.details).toContain("自定义 action artifact 已落盘");
  });

  it("wk 门禁降级（没配 doc_repo 等）：不判黑、只挂一行提示", async () => {
    gate.plan = {
      applies: false,
      reason: "no-doc-repo",
      message: "没配 WK产出目录、本次跳过 wk 门禁",
    };
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);

    expect(result.passed).toBe(true);
    expect(result.details).toContain("跳过 wk 门禁");
  });

  it("门禁模块抛错：吞掉、退回纯类型检查结果", async () => {
    gate.planThrows = true;
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);

    expect(result.passed).toBe(true);
    expect(result.details).toBe("自定义 action artifact 已落盘");
  });

  it("Hub 同步失败只 warn：不影响 passed", async () => {
    gate.plan = { applies: true, command: "wk:repo-execute" };
    gate.report = {
      verdict: "warn",
      message: "wk:repo-execute 阶段门禁已通过\nDelivery Hub 同步失败（不影响产物）",
    };
    const { task, action } = await makeCase();
    const result = await runActionCheck(task, action);

    expect(result.passed).toBe(true);
    expect(result.details).toContain("Delivery Hub 同步失败");
  });
});
