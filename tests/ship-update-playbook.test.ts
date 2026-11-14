/**
 * ship「再次提测」精简版 playbook（prompts/action-ship-update.md）
 *
 * 锁三件事：
 * 1) 选择逻辑 shouldUseShipUpdatePlaybook 的每个分支——判定保守、拿不准一律回落全量版
 * 2) loadActionPrompt 对精简版 / 全量版的选择与占位符填充（含 shipFullPlaybookPath 指向真实存在的全量版）
 * 3) 精简版内容守卫：体积上限、必留铁则不被后续瘦身误删、§0 兜底表引用的全量版章节真实存在、
 *    骨架产出的 artifact 仍能通过 checkShip
 *
 * ⚠️ FLOWSHIP_DATA_DIR 必须在 import task-fs-core 之前设好（DATA_DIR 在模块加载时冻结）、用动态 import。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActionRecord, MRRecord, Task } from "@/lib/types";

const TMP_ROOT = path.join(os.tmpdir(), `fe-ship-update-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { loadActionPrompt, shouldUseShipUpdatePlaybook } = await import(
  "@/lib/server/task-prompts"
);
const { runActionCheck } = await import("@/lib/server/action-checks");
const { getActionArtifactPath, getActionsDir } = await import(
  "@/lib/server/task-fs-core"
);

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const SHIP_FULL = path.join(PROMPTS_DIR, "action-ship.md");
const SHIP_UPDATE = path.join(PROMPTS_DIR, "action-ship-update.md");

/** 本次 ship action 的开始时间；「既有 MR」的 createdAt 都早于它 */
const T0 = 1_700_000_000_000;
const REPO_A = "/w/crm-web";
const REPO_B = "/w/crm-api";

const makeMr = (over: Partial<MRRecord> = {}): MRRecord => ({
  repoPath: REPO_A,
  targetBranch: "test",
  version: 1,
  url: "https://gitlab.example.com/g/crm-web/-/merge_requests/1",
  title: "[前端] 任务",
  branch: "feature/x",
  status: "open",
  createdAt: T0 - 60_000,
  ...over,
});

const makeAction = (over: Partial<ActionRecord> = {}): ActionRecord =>
  ({
    id: "act_9",
    n: 9,
    type: "ship",
    status: "running",
    userInstruction: "",
    artifactPath: "actions/9-ship.md",
    startedAt: T0,
    endedAt: null,
    ...over,
  }) as ActionRecord;

const makeTask = (mrs: MRRecord[], over: Partial<Task> = {}): Task =>
  ({
    id: "t_ship_update",
    title: "再次提测任务",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_9",
    actions: [],
    events: [],
    mrs,
    repoPaths: [REPO_A],
    repoTestBranches: { [REPO_A]: "test" },
    repoDevBranches: { [REPO_A]: "dev" },
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }) as unknown as Task;

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("shouldUseShipUpdatePlaybook（选择逻辑：保守、拿不准回落全量版）", () => {
  it("再次提测：已有 open 的提测 MR、且是本 action 开始前创建 → 精简版", () => {
    expect(shouldUseShipUpdatePlaybook(makeTask([makeMr()]), makeAction())).toBe(
      true,
    );
  });

  it("首次提测：task.mrs 为空 → 全量版", () => {
    expect(shouldUseShipUpdatePlaybook(makeTask([]), makeAction())).toBe(false);
  });

  it("老数据没有 mrs 字段 → 全量版（不抛）", () => {
    const task = makeTask([]);
    delete (task as unknown as { mrs?: unknown }).mrs;
    expect(shouldUseShipUpdatePlaybook(task, makeAction())).toBe(false);
  });

  it("只有联调（dev）MR、没有提测 MR → 全量版", () => {
    const devMr = makeMr({ targetBranch: "dev" });
    expect(shouldUseShipUpdatePlaybook(makeTask([devMr]), makeAction())).toBe(
      false,
    );
  });

  it("联调 MR 与提测 MR 并存 → 精简版（只认提测 MR）", () => {
    const task = makeTask([makeMr({ targetBranch: "dev" }), makeMr()]);
    expect(shouldUseShipUpdatePlaybook(task, makeAction())).toBe(true);
  });

  it.each(["plan", "build", "review", "dev", "custom"] as const)(
    "非 ship（%s）即使有提测 MR 也不用精简版",
    (type) => {
      expect(
        shouldUseShipUpdatePlaybook(makeTask([makeMr()]), makeAction({ type })),
      ).toBe(false);
    },
  );

  it.each([
    "重新走完整流程",
    "按首次提测的完整流程来",
    "走全流程、测试人员也重新探测",
    "重新探测一下测试人员",
    "重走一遍",
    "从头来",
    "Please run the full flow again",
    "do it from scratch",
  ])("用户指令要求完整流程（%s）→ 全量版", (userInstruction) => {
    expect(
      shouldUseShipUpdatePlaybook(
        makeTask([makeMr()]),
        makeAction({ userInstruction }),
      ),
    ).toBe(false);
  });

  it.each([
    "",
    "再次提测",
    "重新提测",
    "把 review 里的 bug 修完再提测一下",
    "修了登录页的样式、重新提个测",
  ])("普通的再次提测指令（%j）不触发回落", (userInstruction) => {
    expect(
      shouldUseShipUpdatePlaybook(
        makeTask([makeMr()]),
        makeAction({ userInstruction }),
      ),
    ).toBe(true);
  });

  it("task 填了 REQ-ID（团队 wk 流程、源分支规则只在全量版）→ 全量版", () => {
    expect(
      shouldUseShipUpdatePlaybook(
        makeTask([makeMr()], { reqId: "REQ-2026-001" }),
        makeAction(),
      ),
    ).toBe(false);
  });

  it("REQ-ID 字面非法 / 空白 = 没有 REQ-ID → 不因此回落", () => {
    for (const reqId of ["", "   ", "REQ 带空格"]) {
      expect(
        shouldUseShipUpdatePlaybook(
          makeTask([makeMr()], { reqId }),
          makeAction(),
        ),
      ).toBe(true);
    }
  });

  it("本 action 内创建的 MR 不算既有（首次提测中途续接不能改判精简版）", () => {
    // createdAt 等于 / 晚于 action.startedAt、缺失 / NaN 一律排除
    for (const createdAt of [T0, T0 + 1, Number.NaN]) {
      expect(
        shouldUseShipUpdatePlaybook(
          makeTask([makeMr({ createdAt })]),
          makeAction(),
        ),
      ).toBe(false);
    }
    const noCreatedAt = makeMr();
    delete (noCreatedAt as unknown as { createdAt?: number }).createdAt;
    expect(
      shouldUseShipUpdatePlaybook(makeTask([noCreatedAt]), makeAction()),
    ).toBe(false);
  });

  it("旧 MR 已 closed / merged → 全量版（submit_mr 不会复用、会新建）", () => {
    for (const status of ["closed", "merged"] as const) {
      expect(
        shouldUseShipUpdatePlaybook(
          makeTask([makeMr({ status })]),
          makeAction(),
        ),
      ).toBe(false);
    }
  });

  it("提测 MR 的目标分支 ≠ 该仓配置的测试分支 → 全量版", () => {
    const mr = makeMr({ targetBranch: "release" });
    expect(shouldUseShipUpdatePlaybook(makeTask([mr]), makeAction())).toBe(false);
  });

  it("老记录缺 targetBranch：兜底成该仓测试分支 → 精简版", () => {
    const mr = makeMr();
    delete (mr as { targetBranch?: string }).targetBranch;
    expect(shouldUseShipUpdatePlaybook(makeTask([mr]), makeAction())).toBe(true);
  });

  it("该仓没配测试分支（走默认 test）：无从比较、提测 MR 照常认", () => {
    const task = makeTask([makeMr()], {
      repoTestBranches: undefined,
      repoDevBranches: undefined,
    });
    expect(shouldUseShipUpdatePlaybook(task, makeAction())).toBe(true);
  });

  it("多仓只有部分仓有既有提测 MR → 精简版（该仓缺 MR 由 playbook 兜底转全量）", () => {
    const task = makeTask([makeMr()], {
      repoPaths: [REPO_A, REPO_B],
      repoTestBranches: { [REPO_A]: "test", [REPO_B]: "test" },
    });
    expect(shouldUseShipUpdatePlaybook(task, makeAction())).toBe(true);
  });
});

describe("loadActionPrompt：精简版 / 全量版选择与占位符填充", () => {
  it("再次提测 → 精简版；{{shipFullPlaybookPath}} / {{actionArtifactsDir}} 已填、无占位符残留", async () => {
    const task = makeTask([makeMr()]);
    const out = await loadActionPrompt(makeAction(), task);
    expect(out).toContain("再次提测·精简版");
    expect(out).not.toContain("V0.6.1 正式版");
    expect(out).toContain(SHIP_FULL);
    expect(out).toContain(getActionsDir(task.id));
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out).not.toContain("（未提供）");
  });

  it("精简版里注入的全量版路径真实存在、且就是全量版（§0 兜底要 read 的就是它）", async () => {
    const out = await loadActionPrompt(makeAction(), makeTask([makeMr()]));
    const m = out.match(/完整版 playbook\*\*：`([^`]+)`/);
    expect(m, "精简版顶部应给出完整版 playbook 的绝对路径").not.toBeNull();
    const full = await fs.readFile(m![1]!, "utf-8");
    expect(path.isAbsolute(m![1]!)).toBe(true);
    expect(full).toContain("V0.6.1 正式版");
  });

  it("首次提测 → 全量版（行为不变）、不带精简版内容", async () => {
    const out = await loadActionPrompt(makeAction(), makeTask([]));
    expect(out).toContain("V0.6.1 正式版");
    expect(out).toContain("### 3.5 冲突门禁");
    expect(out).not.toContain("再次提测·精简版");
    expect(out).not.toMatch(/\{\{\w+\}\}/);
  });

  it("用户指令要求完整流程 → 即使有既有 MR 也走全量版", async () => {
    const out = await loadActionPrompt(
      makeAction({ userInstruction: "重新走完整流程" }),
      makeTask([makeMr()]),
    );
    expect(out).toContain("V0.6.1 正式版");
    expect(out).not.toContain("再次提测·精简版");
  });

  it("首次提测中途续接（task.mrs 已出现本 action 刚建的 v1）仍是全量版、前后一致", async () => {
    const midway = makeTask([makeMr({ createdAt: T0 + 5_000 })]);
    const out = await loadActionPrompt(makeAction(), midway);
    expect(out).toContain("V0.6.1 正式版");
  });

  it("非 ship action 不受影响：build 仍读 action-build.md", async () => {
    const out = await loadActionPrompt(
      makeAction({ type: "build", artifactPath: "actions/9-build.md" }),
      makeTask([makeMr()]),
    );
    expect(out).toContain("Action: build");
    expect(out).not.toContain("再次提测·精简版");
  });
});

describe("精简版内容守卫", () => {
  const readUpdate = () => fs.readFile(SHIP_UPDATE, "utf-8");

  it("体积 ≤ 12KB（初衷就是比 29KB 的全量版小得多）", async () => {
    const [update, full] = await Promise.all([readUpdate(), fs.readFile(SHIP_FULL, "utf-8")]);
    expect(Buffer.byteLength(update, "utf-8")).toBeLessThanOrEqual(12 * 1024);
    expect(Buffer.byteLength(update, "utf-8")).toBeLessThan(
      Buffer.byteLength(full, "utf-8") / 2,
    );
  });

  it.each([
    ["顺序铁则：先 commit 再判有无改动", "先 commit 工作区改动、再判"],
    ["fetch 失败 fail-fast", "fetch 失败 fail-fast"],
    ["绝不 force push", "绝不 force push"],
    ["绝不把测试分支 merge 进 feature", "git merge"],
    ["submit_mr 返回值：has_conflicts", "has_conflicts: true"],
    ["submit_mr 返回值：mr_version", "mr_version"],
    ["submit_mr 返回值：merge_undetermined", "merge_undetermined"],
    ["不 merge MR", "不 merge MR"],
    ["复用已记的测试人员、不重新探测", "feishuTesterUserKeys"],
    ["飞书评论 mention 块", "AT_USER_BLOCK"],
    ["需求群 @", "notify_group_testers"],
    ["v2+ 的「vN 更新」写法", "## v<mrVersion> 更新"],
    ["无改动仓跳过说明（checkShip 依赖）", "跳过、原因：本仓无改动"],
    ["冲突兜底：转完整版 §3.5", "§3.5"],
    ["冲突兜底：转完整版 §3.6", "§3.6"],
    ["完整版路径占位符", "{{shipFullPlaybookPath}}"],
  ])("必留：%s", async (_name, needle) => {
    expect(await readUpdate()).toContain(needle);
  });

  it("§0 兜底表覆盖用户要求的异常：冲突 / push 被拒 / 无既有 MR / 测试人员为空 / 目标分支不同", async () => {
    const md = await readUpdate();
    const table = md.slice(md.indexOf("## 0. 兜底"), md.indexOf("## 铁则"));
    for (const needle of [
      "has_conflicts: true",
      "git push",
      "没有既有提测 MR",
      "feishuTesterUserKeys",
      "targetBranch",
    ]) {
      expect(table, `兜底表缺：${needle}`).toContain(needle);
    }
  });

  it("§0 兜底表指向的全量版章节真实存在（防全量版改标题后精简版指空）", async () => {
    const full = await fs.readFile(SHIP_FULL, "utf-8");
    for (const heading of [
      "### 1. 读上下文",
      "### 2. 飞书 @ 测试人员探测",
      "### 3. 逐仓 push + submit_mr",
      "### 3.5 冲突门禁",
      "### 3.6 AI 智能解冲突",
      "## 源分支：普通流程与 WK 流程",
      "## MR description 模板",
    ]) {
      expect(full, `全量版缺章节：${heading}`).toContain(heading);
    }
  });

  it("不含被扫描守卫禁止的写法（checkout -B / abbrev-ref / 读 config.json 取 token）", async () => {
    const md = await readUpdate();
    expect(md).not.toMatch(/checkout -B/);
    expect(md).not.toMatch(/--abbrev-ref/);
    expect(md).not.toMatch(/jq -r \.gitToken|config\.json/);
  });

  it("骨架产出的 artifact 能通过 checkShip（有 MR 的仓 URL 非空无冲突 + 跳过的仓写了原因）", async () => {
    const md = await readUpdate();
    const skeleton = md.match(/```markdown\n(# Ship #[\s\S]*?)\n```/)?.[1];
    expect(skeleton, "没抠到 artifact 骨架").toBeTruthy();
    const artifact = skeleton!
      .replace("<repoPath 1>", REPO_A)
      .replace("<repoPath 2>", REPO_B);

    const action = makeAction({
      status: "awaiting_ack",
      endedAt: T0 + 1000,
      sideEffects: {
        mrs: [
          {
            repoPath: REPO_A,
            targetBranch: "test",
            mrUrl: "https://gitlab.example.com/g/crm-web/-/merge_requests/1",
            mrVersion: 2,
            branch: "feature/x",
            commitHash: "abc1234",
            hasConflicts: false,
          },
        ],
      },
    } as Partial<ActionRecord>);
    const task = makeTask([makeMr({ version: 2 })], {
      id: `t_ship_update_check_${Math.random().toString(36).slice(2, 8)}`,
      repoPaths: [REPO_A, REPO_B],
    });
    const abs = getActionArtifactPath(task.id, action.n, "ship");
    expect(abs.startsWith(TMP_ROOT)).toBe(true);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, artifact, "utf-8");

    const r = await runActionCheck(task, action);
    expect(r.passed, r.details).toBe(true);
  });
});
