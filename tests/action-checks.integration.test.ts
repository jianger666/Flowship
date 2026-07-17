/**
 * action-checks 集成测试
 *
 * 1) computeWorktreeFingerprint（对真实临时 git 仓）
 *    背景：V0.11.x 把指纹从「sh -c 跑多行 POSIX 脚本」重写成纯 Node execFile git
 *    （Windows 没有 sh、旧实现在 Windows 静默失效）。本测试锁语义不回归：
 *    干净仓稳定、tracked 改动 / untracked 新增 / untracked 内容变化都要引起指纹变化。
 * 2) 必备段标题锚定 + checkDev 直推读 artifact（审查加固）
 *
 * ⚠️ FE_AI_FLOW_DATA_DIR 必须在 import task-fs-core 之前设好：DATA_DIR =
 * path.join(dataRoot(), "tasks") 在模块加载时冻结。用动态 import 保证隔离到 TMP。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-fingerprint-it-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

// 动态 import：等 DATA_DIR 冻结到 TMP 后再加载
const { computeWorktreeFingerprint, runActionCheck } = await import(
  "@/lib/server/action-checks"
);
const { getActionArtifactPath } = await import("@/lib/server/task-fs-core");

const REPO = path.join(TMP_ROOT, "repo");
/** 非 git 目录：review 跳过基底 commit / 指纹比对，专心验必备段正则 */
const PLAIN_REPO = path.join(TMP_ROOT, "plain-repo");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

/** 拼最小 Task / ActionRecord，只够跑 runActionCheck；taskId 带随机防撞 */
const makeTaskAction = (
  type: ActionRecord["type"],
  n: number,
  repoPath: string,
  extras?: Partial<ActionRecord>,
): { task: Task; action: ActionRecord } => {
  const action: ActionRecord = {
    id: `act_${n}`,
    n,
    type,
    status: "awaiting_ack",
    userInstruction: "",
    artifactPath: `actions/${n}-${type}.md`,
    startedAt: Date.now(),
    endedAt: Date.now(),
    ...extras,
  };
  const task = {
    id: `t_gate_${type}_${n}_${Math.random().toString(36).slice(2, 8)}`,
    title: "gate-test",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: action.id,
    actions: [action],
    events: [],
    mrs: [],
    repoPaths: [repoPath],
    nonGitRepoPaths: repoPath === PLAIN_REPO ? [repoPath] : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Task;
  return { task, action };
};

const writeArtifact = async (
  taskId: string,
  n: number,
  type: string,
  content: string,
): Promise<void> => {
  const abs = getActionArtifactPath(taskId, n, type);
  // 锁死落在 TMP：防 DATA_DIR 误冻到 cwd/data 污染正式数据
  if (!abs.startsWith(TMP_ROOT)) {
    throw new Error(`artifact 路径未隔离到 TMP：${abs}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
};

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  await fs.mkdir(PLAIN_REPO, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
  await fs.writeFile(path.join(REPO, ".gitignore"), "ignored.txt\n");
  git("add", "-A");
  git("commit", "-m", "init");
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("computeWorktreeFingerprint 真 git 集成", () => {
  it("干净工作区：指纹非空且稳定（连算两次一致）", async () => {
    const a = await computeWorktreeFingerprint(REPO);
    const b = await computeWorktreeFingerprint(REPO);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("tracked 文件改动 → 指纹变化、还原后回到基线", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    await fs.writeFile(path.join(REPO, "a.txt"), "changed\n");
    expect(await computeWorktreeFingerprint(REPO)).not.toBe(baseline);
    await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
  });

  it("新增 untracked 文件 → 指纹变化；内容再变 → 指纹继续变化", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    const newFile = path.join(REPO, "b.txt");
    await fs.writeFile(newFile, "v1\n");
    const withUntracked = await computeWorktreeFingerprint(REPO);
    expect(withUntracked).not.toBe(baseline);
    // 路径集不变、只有内容变——靠 hash-object 部分才能感知（status hash 感知不到）
    await fs.writeFile(newFile, "v2\n");
    expect(await computeWorktreeFingerprint(REPO)).not.toBe(withUntracked);
    await fs.rm(newFile);
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
  });

  it("gitignore 的文件不进指纹", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    await fs.writeFile(path.join(REPO, "ignored.txt"), "noise\n");
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
    await fs.rm(path.join(REPO, "ignored.txt"));
  });

  it("非 git 目录 → null（无法比对、不拦）", async () => {
    const plainDir = path.join(TMP_ROOT, "not-a-repo");
    await fs.mkdir(plainDir, { recursive: true });
    expect(await computeWorktreeFingerprint(plainDir)).toBeNull();
  });
});

describe("必备段标题锚定（审查加固）", () => {
  // 只写总评 bullets（含「bug 复审结论」「跟飞书 story…」）→ 旧裸词会全绿、标题锚定后应红
  it("review：仅总评 bullet 不含 ## 段标题 → 缺必备段", async () => {
    const { task, action } = makeTaskAction("review", 1, PLAIN_REPO);
    await writeArtifact(
      task.id,
      1,
      "review",
      `# 复核：x

## 总评

- **跟飞书 story 原始需求一致性**：高
- **bug 复审结论**：未发现高置信 bug
- **建议结论**：可交付
`,
    );
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/跟飞书需求对照|bug 复审/);
  });

  it("review：骨架标题齐全 → 通过", async () => {
    const { task, action } = makeTaskAction("review", 2, PLAIN_REPO);
    await writeArtifact(
      task.id,
      2,
      "review",
      `# 复核：x

## 总评

- **建议结论**：可交付

## 跟飞书需求对照

| 飞书需求项 | 来源 | 本次是否覆盖 |
|---|---|---|
| 导出 | story | ✅ |

## bug 复审

未发现高置信 bug
`,
    );
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(true);
  });

  it("build：仅总览「全量校验」bullet、无 ## 全量校验 → 缺必备段", async () => {
    const { task, action } = makeTaskAction("build", 3, PLAIN_REPO);
    await writeArtifact(
      task.id,
      3,
      "build",
      `# 编码实现：x

## 总览

- 全量校验：lint=pass、typecheck=pass
- 偏离 plan：无

## Task 完成情况

### Task 1：改文案（✓ 完成）

- **改动文件**：\`a.txt\`
`,
    );
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/全量校验/);
  });

  it("build：有 ## 全量校验 标题 → 通过", async () => {
    const { task, action } = makeTaskAction("build", 4, PLAIN_REPO);
    await writeArtifact(
      task.id,
      4,
      "build",
      `# 编码实现：x

## 总览

- 全量校验：lint=pass、typecheck=pass

## 全量校验

| 项 | 命令 | 退出码 |
|---|---|---|
| Lint | pnpm lint | 0 |
`,
    );
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(true);
  });
});

describe("checkDev 直推读 artifact（审查加固）", () => {
  // 过短不走 ENOENT 退避，单独锁「内容为空」分支（快）
  it("无 MR + artifact 过短 → 不通过", async () => {
    const { task, action } = makeTaskAction("dev", 5, PLAIN_REPO, {
      devPushMode: "direct",
    });
    await writeArtifact(task.id, 5, "dev", "太短\n");
    const tooShort = await runActionCheck(task, action);
    expect(tooShort.passed).toBe(false);
    expect(tooShort.details).toMatch(/联调没写 artifact/);
  });

  // readArtifactWithRetry 对 ENOENT 退避约 7.5s
  it(
    "无 MR + artifact 缺失 → 不通过",
    async () => {
      const { task, action } = makeTaskAction("dev", 6, PLAIN_REPO, {
        devPushMode: "direct",
      });
      const abs = getActionArtifactPath(task.id, 6, "dev");
      expect(abs.startsWith(TMP_ROOT)).toBe(true);
      await fs.rm(abs, { force: true });
      const t0 = Date.now();
      const missing = await runActionCheck(task, action);
      expect(Date.now() - t0).toBeGreaterThan(5000);
      expect(missing.passed).toBe(false);
      expect(missing.details).toMatch(/联调没写 artifact/);
    },
    20_000,
  );

  it("无 MR + artifact 足够长 → 通过", async () => {
    const { task, action } = makeTaskAction("dev", 7, PLAIN_REPO, {
      devPushMode: "direct",
    });
    await writeArtifact(
      task.id,
      7,
      "dev",
      `# 联调记录

已本地 merge 到 dev 并推送 origin/dev。
流水线结果：pass。自测 checklist 见下。
`,
    );
    const result = await runActionCheck(task, action);
    expect(result.passed).toBe(true);
    expect(result.details).toMatch(/直推/);
  });
});
