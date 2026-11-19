/**
 * 仓名取末段（`repoTail`）认 Windows 反斜杠（R14 Q7b-05）
 *
 * 背景：全库有十来处用 `p.split("/").filter(Boolean).pop() ?? p` 取仓名，只认 `/`。
 * Windows 仓路径 `C:\w\crm-web` 里没有 `/`，整条路径被当成「仓名」：
 *  - 给 agent 的 prompt / 事件流 / 飞书卡片 / 任务页里，仓名位置显示整条盘符路径。
 * 修法：取仓名统一走 `path-utils.repoTail`（先把 `\` 归一成 `/` 再取末段）；
 * POSIX 路径的结果与历史写法逐字一致。本文件钉行为 + 扫源码防旧写法回流。
 */
import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ActionRecord, Task } from "@/lib/types";

// FLOWSHIP_DATA_DIR 必须在加载任何 server 模块前设好（数据根在模块加载时冻结）→ 全部动态 import
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-repo-tail-win-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { repoTail } = await import("@/lib/path-utils");
const { renderRepoBranchSection, renderRepoSection } = await import(
  "@/lib/server/task-prompts"
);
const { buildDepPrepareHint, getTaskWorktreesDir } = await import(
  "@/lib/server/task-worktrees"
);
const { buildAllActionMrLinks } = await import(
  "@/lib/server/feishu-bridge/group-broadcast"
);
const { repoTailOf, repoTailsLabel } = await import(
  "@/lib/server/feishu-bridge/chats-panel"
);
const { buildDefaultDailyTaskTitle } = await import("@/lib/task-display");

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

/** 历史写法（修复前各处内联的那一句），POSIX 对照用 */
const legacyTail = (p: string): string =>
  p.split("/").filter(Boolean).pop() ?? p;

describe("repoTail：取仓路径末段", () => {
  it.each([
    "/a/b/crm-web",
    "/a/b/crm-web/",
    "/a/b/crm-web///",
    "/crm-web",
    "crm-web",
    "a//b///c//",
    "./crm-web",
    "",
    "/",
    "///",
  ])("POSIX %j：与历史写法逐字一致", (p) => {
    expect(repoTail(p)).toBe(legacyTail(p));
  });

  it.each([
    ["盘符反斜杠", "C:\\w\\crm-web", "crm-web"],
    ["盘符反斜杠 + 尾随分隔符", "C:\\w\\crm-web\\", "crm-web"],
    ["盘符正斜杠", "C:/w/crm-web", "crm-web"],
    ["混用分隔符", "C:\\w/crm-web", "crm-web"],
    ["UNC", "\\\\srv\\share\\crm-web", "crm-web"],
    ["中文仓名", "D:\\代码\\登录服务", "登录服务"],
  ])("Windows %s：%j → 仓名", (_name, p, want) => {
    expect(repoTail(p)).toBe(want);
  });

  it("取不到末段（全是分隔符）→ 原值兜底，不返回空串", () => {
    expect(repoTail("\\\\")).toBe("\\\\");
    expect(repoTail("///")).toBe("///");
  });
});

// ----------------- prompt：仓库分支段 -----------------

const promptTask = (patch: Partial<Task> = {}): Task =>
  ({
    id: "t_prompt_win",
    title: "prompt-win",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: ["C:\\w\\crm-web", "D:/w/pay/"],
    repoBaseBranches: { "C:\\w\\crm-web": "master" },
    createdAt: 1,
    updatedAt: 1,
    events: [],
    ...patch,
  }) as Task;

describe("prompt 仓库分支段（renderRepoBranchSection）", () => {
  it("每个仓用仓名末段做标题、括号里才是完整路径（Windows 反斜杠 / 正斜杠 + 尾随分隔符）", () => {
    const text = renderRepoBranchSection(promptTask());
    expect(text).toContain("- `crm-web`（C:\\w\\crm-web）：线上分支=master");
    expect(text).toContain("- `pay`（D:/w/pay/）：线上分支=");
    // 修复前：标题位置是整条盘符路径
    expect(text).not.toContain("- `C:\\w\\crm-web`（");
  });

  it("测试任务：被测业务分支未就绪的仓名单也用仓名末段", () => {
    const text = renderRepoBranchSection(
      promptTask({
        workRole: "qa",
        feishuStoryUrl: "https://project.feishu.cn/demo/story/detail/123",
        // pay 配了被测分支、crm-web 没配 → 名单里只有 crm-web
        repoFeatureBranches: { "D:/w/pay/": "feature/pay" },
      } as Partial<Task>),
    );
    expect(text).toContain("以下仓库的被测业务分支尚未就绪：`crm-web`。");
    expect(text).not.toContain("`C:\\w\\crm-web`。");
  });
});

// ----------------- 飞书：MR 按钮标签 / 对话列表仓名 -----------------

describe("飞书卡片里的仓名", () => {
  const mrAction = (...repoPaths: string[]): ActionRecord =>
    ({
      id: "act_mr",
      n: 1,
      type: "ship",
      status: "awaiting_ack",
      userInstruction: "",
      artifactPath: "actions/1-ship.md",
      startedAt: 1,
      sideEffects: {
        mrs: repoPaths.map((repoPath, i) => ({
          repoPath,
          mrUrl: `https://git.example.com/x/-/merge_requests/${i + 1}`,
          mrVersion: 1,
        })),
      },
    }) as unknown as ActionRecord;

  it("MR 链接按钮：标签是「MR · 仓名」（Windows 反斜杠 / 尾随分隔符都认）", () => {
    const links = buildAllActionMrLinks(
      mrAction("C:\\w\\crm-web", "D:\\w\\pay\\", "/w/crm-api/"),
    );
    expect(links.map((l) => l.label)).toEqual([
      "MR · crm-web",
      "MR · pay",
      "MR · crm-api",
    ]);
  });

  it("MR 记录没有仓路径 / 路径全是分隔符 → 退回「MR」", () => {
    const links = buildAllActionMrLinks(mrAction("", "\\\\", "/"));
    expect(links.map((l) => l.label)).toEqual(["MR", "MR", "MR"]);
  });

  it("对话列表的仓名：repoTailOf / repoTailsLabel 认反斜杠，并按仓名去重", () => {
    expect(repoTailOf(["C:\\w\\crm-web"])).toBe("crm-web");
    expect(repoTailOf(["  D:\\w\\pay\\  "])).toBe("pay");
    expect(repoTailOf(undefined)).toBe("未绑仓库");
    expect(repoTailOf(["   ", "\\"])).toBe("未绑仓库");
    // 不同盘符下同名仓只显示一次
    expect(
      repoTailsLabel(["C:\\w\\crm-web", "D:/w/pay/", "/x/crm-web"]),
    ).toBe("crm-web、pay");
  });
});

// ----------------- prompt：隔离任务的逐仓列表 -----------------

describe("隔离任务 prompt 的逐仓列表（renderRepoSection）", () => {
  const isoTask = (patch: Partial<Task> = {}): Task =>
    ({
      id: "t_iso_win",
      title: "iso-win",
      mode: "task",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      isolateWorktree: true,
      repoPaths: ["C:\\w\\crm-web", "D:\\w\\scripts\\"],
      nonGitRepoPaths: ["D:\\w\\scripts\\"],
      gitBranches: [{ repoPath: "C:\\w\\crm-web", name: "flow/login" }],
      createdAt: 1,
      updatedAt: 1,
      events: [],
      ...patch,
    }) as unknown as Task;

  it("git 仓：标题是仓名末段，分支写已检出的任务分支，括号里才是原仓库完整路径", () => {
    const text = renderRepoSection(isoTask());
    expect(text).toContain(
      "  - `crm-web`：分支 `flow/login`（原仓库 `C:\\w\\crm-web`）",
    );
    // 修复前：标题位置是整条盘符路径
    expect(text).not.toContain("  - `C:\\w\\crm-web`：");
  });

  it("非 git 目录：标题同样是末段（带尾随分隔符也认），括号里是原地使用的路径", () => {
    const text = renderRepoSection(isoTask());
    expect(text).toContain(
      "  - `scripts`：非 git 目录、原地使用（`D:\\w\\scripts\\`）",
    );
    expect(text).not.toContain("  - `D:\\w\\scripts\\`：");
  });
});

// ----------------- 依赖准备提示 / 只读仓检测：用「名字里带反斜杠的真目录」在 POSIX 上复现 -----------------
//
// POSIX 文件名允许含 `\`：`<tmp>/C:\w\crm-web` 是一个真实存在的目录（整条名字当作一个文件名）。
// 对 repoTail 来说它等价于 Windows 路径 `…\C:\w\crm-web`，取末段是 crm-web；
// 旧写法按 `/` 切、末段是整个 `C:\w\crm-web`。这样不用 Windows 机器也能跑真 fs / 真 git 的路径。

const WEIRD_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-repo-tail-weird-"));
afterAll(() => {
  rmSync(WEIRD_ROOT, { recursive: true, force: true });
});

describe("依赖准备提示（buildDepPrepareHint）里的仓名", () => {
  it("仓名位置是末段 crm-web，不是带盘符的整条路径", async () => {
    const orig = path.join(WEIRD_ROOT, "dep", "C:\\w\\crm-web");
    mkdirSync(path.join(orig, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(orig, "node_modules", "pkg", "i.js"), "1");
    const task = {
      id: "t_dep_hint_win",
      mode: "task",
      title: "dep-hint-win",
      repoStatus: "developing",
      runStatus: "idle",
      repoPaths: [orig],
      isolateWorktree: true,
      actions: [],
      mrs: [],
    } as unknown as Task;
    // 隔离任务的工作目录：存在、但还没有 node_modules（→ 需要克隆 / 提示）
    mkdirSync(path.join(getTaskWorktreesDir(task.id), "crm-web"), {
      recursive: true,
    });

    const hint = await buildDepPrepareHint(task);
    expect(hint).toBeDefined();
    expect(hint).toContain("- `crm-web`：");
    expect(hint).not.toContain("- `C:\\w\\crm-web`：");
  });
});

// ----------------- 任务页：日常任务默认标题 -----------------

describe("日常任务默认标题（buildDefaultDailyTaskTitle）", () => {
  const at = new Date(2026, 9, 25, 12, 30);

  it.each([
    ["Windows 反斜杠", ["C:\\w\\crm-web"], "crm-web"],
    ["Windows 尾随分隔符", ["C:\\w\\crm-web\\\\"], "crm-web"],
    ["Windows 正斜杠", ["C:/w/crm-web/"], "crm-web"],
    ["POSIX", ["/w/crm-web/"], "crm-web"],
    ["多仓只取第一个", ["C:\\w\\crm-web", "D:\\w\\pay"], "crm-web"],
  ])("%s → 标题里是首仓末段", (_name, paths, want) => {
    const title = buildDefaultDailyTaskTitle(paths, at);
    expect(title.startsWith(`日常 · ${want} · `)).toBe(true);
  });

  it("没有仓 / 路径全是分隔符 → 兜底「任务」", () => {
    expect(buildDefaultDailyTaskTitle([], at).startsWith("日常 · 任务 · ")).toBe(
      true,
    );
    expect(
      buildDefaultDailyTaskTitle(["\\\\"], at).startsWith("日常 · 任务 · "),
    ).toBe(true);
  });
});

// ----------------- 源码扫描：旧写法不得回流 -----------------

describe("源码扫描：取仓名只许走 repoTail", () => {
  // 修复前各处内联的写法（允许 prettier 把链式调用拆行）
  const LEGACY = /\.split\(\s*["']\/["']\s*\)\s*\.filter\(\s*Boolean\s*\)\s*\.(?:pop\(\)|at\(\s*-1\s*\))/;
  const SRC_ROOT = path.join(process.cwd(), "src");
  // 唯一属主：helper 自己（以及它旁边已归一化分隔符的 getUniqueRepoDirNames）
  const OWNER = path.join("lib", "path-utils.ts");

  it("src 下除 path-utils.ts 外没有 `.split(\"/\").filter(Boolean).pop()` 旧写法", () => {
    const files = (readdirSync(SRC_ROOT, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("node_modules"))
      .filter((f) => f !== OWNER);
    expect(files.length).toBeGreaterThan(100); // 防扫描路径写错而空过
    const offenders = files.filter((f) =>
      LEGACY.test(readFileSync(path.join(SRC_ROOT, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  // 展示文案点（事件流 / prompt 文本 / 任务页标签）里取仓名的调用点——不起真 worktree / 不停任务就没法逐个造集成用例，
  // 所以用「该写法必须还在」钉住：谁把某一处改回整条路径（`repoTail(p)` → `p`）会让次数对不上
  const SITES: Array<[file: string, snippet: string, count: number]> = [
    ["src/lib/server/task-runner.ts", ".map((p) => repoTail(p))", 2], // 预热 / 创建隔离工作区的事件文案
    ["src/lib/server/task-runner.ts", "formatWorktreeCleanupNotes(removed, repoTail)", 2], // 停任务 / 终结后的清理文案
    ["src/lib/server/task-runner.ts", "${repoTail(c.repoPath)}", 4], // 依赖准备结果文案
    ["src/components/tasks/workspace-actions.tsx", "{repoTail(c.repoPath)}", 1], // 任务页工作区卡片
  ];
  const countOf = (text: string, snippet: string): number =>
    text.split(snippet).length - 1;

  it.each(SITES)("%s 里 `%s` 恰好出现 %i 处（取仓名都经 repoTail）", (file, snippet, count) => {
    const text = readFileSync(path.join(process.cwd(), file), "utf8");
    expect(countOf(text, snippet)).toBe(count);
  });

  it("task-runner 不再自己定义 repoTail（统一用 path-utils 导出的那个）", () => {
    const text = readFileSync(
      path.join(process.cwd(), "src/lib/server/task-runner.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/const repoTail\s*=/);
    expect(text).toMatch(
      /import \{[^}]*\brepoTail\b[^}]*\} from "@\/lib\/path-utils"/,
    );
  });

  it("扫描规则本身有效：能认出旧写法（含拆行），不误伤 repoTail 调用", () => {
    expect(LEGACY.test('p.split("/").filter(Boolean).pop() ?? p')).toBe(true);
    expect(LEGACY.test("p\n  .split('/')\n  .filter(Boolean)\n  .pop()")).toBe(
      true,
    );
    expect(LEGACY.test("p.split('/').filter(Boolean).at(-1)")).toBe(true);
    expect(LEGACY.test("repoTail(p)")).toBe(false);
    expect(LEGACY.test("p.split(/[\\\\/]/).filter(Boolean).pop() ?? p")).toBe(
      false,
    );
  });
});
