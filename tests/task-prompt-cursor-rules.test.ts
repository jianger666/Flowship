/**
 * task super prompt 里 Cursor 专属的两段 + 「0 份上下文文档整段不注入」+ `[TASK_UPDATED]` 描述对账。
 * 真调 buildSuperPromptWithBudget / buildInitialPrompt（不是源码字符串断言）；接线和模板另用源码 / 文件断言补一层。
 *
 * 为什么只对 Cursor 后端注入：
 * - 「Cursor 账号级 User Rules 忽略声明」：账号级规则是 Cursor 服务端按 API key 归属账号注入 SDK agent 上下文的（settingSources:[] 关不掉），
 *   pi / 自定义后端不走 Cursor 账号，对它们这句声明是纯噪音；
 * - 「项目规则（必读）」：Cursor 链路 settingSources:[]，仓库根的 AGENTS.md 不会自动进入上下文（pi 链路的 resource-loader 会自动注入）——
 *   所以只有 Cursor 才需要补一条必读指令。chat 侧早有同样的补丁，task 这边之前漏了。
 *
 * 默认值（不传 isCursorBackend）= true：保持旧行为，漏传的调用方多一句声明比少一句强。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { __buildChatInitialPromptForTest } from "@/lib/server/chat-runner";
import {
  CURSOR_ACCOUNT_RULES_NOTE,
  buildSuperPromptWithBudget,
  buildTaskUpdateHint,
  captureTaskFieldsSnapshot,
  renderProjectRulesSection,
} from "@/lib/server/task-prompts";
import type { Task } from "@/lib/types";

import { readSource } from "./helpers/source-text";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP_ROOT = path.join(os.tmpdir(), `fe-task-prompt-cursor-rules-${Date.now()}`);
const DIR_WITH = path.join(TMP_ROOT, "repo-with-agents");
const DIR_WITH_2 = path.join(TMP_ROOT, "repo-with-agents-2");
const DIR_WITHOUT = path.join(TMP_ROOT, "repo-without-agents");

beforeAll(async () => {
  for (const d of [DIR_WITH, DIR_WITH_2, DIR_WITHOUT]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(DIR_WITH, "AGENTS.md"), "# rules\n");
  await fs.writeFile(path.join(DIR_WITH_2, "AGENTS.md"), "# rules 2\n");
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

const ACCOUNT_RULES = "Cursor 账号级 User Rules";
const PROJECT_RULES = "## 项目规则（必读）";
/** 带 "## " 前缀 = 只匹配章节标题本身：action-plan 的文案里也会提到「用户提供的上下文文档」这个章节名，不带前缀会误伤 */
const CONTEXT_DOCS_HEADING = "## 用户提供的上下文文档";

const taskOf = (repoPaths: string[], extra: Record<string, unknown> = {}): Task =>
  ({
    id: "t_task_cursor_rules",
    title: "cursor rules",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths,
    createdAt: 1,
    updatedAt: 1,
    events: [],
    ...extra,
  }) as unknown as Task;

const firstAction = () => ({
  action: {
    id: "act_1",
    n: 1,
    type: "plan",
    status: "pending",
    userInstruction: "",
    artifactPath: "actions/1-plan.md",
    startedAt: null,
    endedAt: null,
  } as never,
  userInstruction: "",
});

/** isCursorBackend 不传 = 走默认值；budget 传 undefined 同理 */
const build = async (task: Task, isCursorBackend?: boolean, budget?: number): Promise<string> =>
  (await buildSuperPromptWithBudget(task, [], firstAction(), "", "", "", "", budget, isCursorBackend)).prompt;

const TEXT_DOC = { id: "doc_1", type: "text", title: "需求说明", content: "这是一份需求", createdAt: 1 };

describe("Cursor 账号级 User Rules 忽略声明（task）：只对 Cursor 后端注入", () => {
  it("默认（不传）= Cursor：带完整声明，且夹在「用户规则」与「核心机制」之间", async () => {
    const p = await build(taskOf([]));
    expect(p).toContain(CURSOR_ACCOUNT_RULES_NOTE);
    expect(p.indexOf("## 用户规则（必遵守）")).toBeLessThan(p.indexOf(ACCOUNT_RULES));
    expect(p.indexOf(ACCOUNT_RULES)).toBeLessThan(p.indexOf("## 核心机制"));
  });

  it("显式 Cursor 同默认；pi / 自定义后端：整句都不带（那个注入只有 Cursor 服务端会做）", async () => {
    expect(await build(taskOf([]), true)).toContain(CURSOR_ACCOUNT_RULES_NOTE);
    const p = await build(taskOf([]), false);
    expect(p).not.toContain(ACCOUNT_RULES);
    expect(p).not.toContain(CURSOR_ACCOUNT_RULES_NOTE);
  });

  it("条件注入没误伤相邻章节：两种后端「用户规则」「核心机制」都还在", async () => {
    for (const cursor of [true, false]) {
      const p = await build(taskOf([]), cursor);
      expect(p, String(cursor)).toContain("## 用户规则（必遵守）");
      expect(p, String(cursor)).toContain("## 核心机制：工具 + 消息循环");
    }
  });

  it("声明文案的关键语义留着（忽略 / 不适用于 Flowship / 只认上面那一节）——别被人当成冗余改丢", () => {
    expect(CURSOR_ACCOUNT_RULES_NOTE).toContain("不适用于 Flowship");
    expect(CURSOR_ACCOUNT_RULES_NOTE).toContain("一律忽略");
    expect(CURSOR_ACCOUNT_RULES_NOTE).toContain("只有上面这一节");
  });

  it("chat 与 task 共用同一份声明（单一源）：chat 的 Cursor 起手 prompt 里是同一个常量，pi 里没有", () => {
    const chat = (cursor: boolean): string =>
      __buildChatInitialPromptForTest(
        taskOf([], { id: "t_chat_cursor_rules", mode: "chat" }),
        [],
        "（用户规则占位）",
        { text: "hi" },
        "",
        "",
        "",
        "",
        cursor,
        { turns: [], truncated: false },
      );
    expect(chat(true)).toContain(CURSOR_ACCOUNT_RULES_NOTE);
    expect(chat(false)).not.toContain(ACCOUNT_RULES);
  });
});

describe("「项目规则（必读）」（task）：只对 Cursor 后端、只列真有 AGENTS.md 的工作路径", () => {
  it("Cursor + 仓库根有 AGENTS.md：带该段并列出绝对路径；位置在「用户规则」之后、Cursor 声明之前", async () => {
    const p = await build(taskOf([DIR_WITH]), true);
    expect(p).toContain(PROJECT_RULES);
    expect(p).toContain(`- \`${path.join(DIR_WITH, "AGENTS.md")}\``);
    expect(p).toContain("必须先用 read 工具读一次");
    expect(p.indexOf("## 用户规则（必遵守）")).toBeLessThan(p.indexOf(PROJECT_RULES));
    expect(p.indexOf(PROJECT_RULES)).toBeLessThan(p.indexOf(ACCOUNT_RULES));
  });

  it("多仓：只列有 AGENTS.md 的那几个，没有的不列", async () => {
    const p = await build(taskOf([DIR_WITH, DIR_WITHOUT, DIR_WITH_2]), true);
    expect(p).toContain(path.join(DIR_WITH, "AGENTS.md"));
    expect(p).toContain(path.join(DIR_WITH_2, "AGENTS.md"));
    expect(p).not.toContain(path.join(DIR_WITHOUT, "AGENTS.md"));
  });

  it("Cursor + 没有任何 AGENTS.md / 没绑仓库：整段不注入（空串不占位）", async () => {
    for (const repos of [[DIR_WITHOUT], []]) {
      const p = await build(taskOf(repos), true);
      expect(p, repos.join()).not.toContain(PROJECT_RULES);
    }
  });

  it("pi / 自定义后端：即使仓库根有 AGENTS.md 也不补（它们的 resource-loader 会自动注入，补了就重复）", async () => {
    const p = await build(taskOf([DIR_WITH]), false);
    expect(p).not.toContain(PROJECT_RULES);
    expect(p).not.toContain(path.join(DIR_WITH, "AGENTS.md"));
  });

  it("renderProjectRulesSection 的产物形状：标题 + 一句说明 + 每个文件一行列表", async () => {
    const s = await renderProjectRulesSection(taskOf([DIR_WITH, DIR_WITH_2]));
    const lines = s.split("\n");
    expect(lines[0]).toBe(PROJECT_RULES);
    expect(lines.filter((l) => l.startsWith("- `"))).toEqual([
      `- \`${path.join(DIR_WITH, "AGENTS.md")}\``,
      `- \`${path.join(DIR_WITH_2, "AGENTS.md")}\``,
    ]);
    expect(await renderProjectRulesSection(taskOf([DIR_WITHOUT]))).toBe("");
  });

  it("取的是「工作路径」getTaskWorkRepoPaths（隔离任务 = worktree 路径），不是原仓库路径", () => {
    const src = readSource("src/lib/server/task-prompts.ts");
    const at = src.indexOf("export const renderProjectRulesSection");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 900);
    expect(body).toContain("getTaskWorkRepoPaths(task)");
    expect(body).not.toContain("task.repoPaths");
  });
});

describe("预算统计按真实注入量算", () => {
  it("Cursor 后端：两段的字节计入 perSectionBytes / totalBytes；pi / 自定义后端：都是 0", async () => {
    const run = (cursor: boolean) =>
      buildSuperPromptWithBudget(taskOf([DIR_WITH]), [], firstAction(), "", "", "", "", undefined, cursor);
    const cursor = await run(true);
    const pi = await run(false);
    expect(cursor.perSectionBytes["cursorAccountRulesNote"]).toBe(Buffer.byteLength(CURSOR_ACCOUNT_RULES_NOTE, "utf-8"));
    expect(cursor.perSectionBytes["projectRulesSection"]).toBeGreaterThan(0);
    expect(pi.perSectionBytes["cursorAccountRulesNote"]).toBe(0);
    expect(pi.perSectionBytes["projectRulesSection"]).toBe(0);
    expect(cursor.totalBytes).toBeGreaterThan(pi.totalBytes);
  });
});

describe("接线与模板", () => {
  it("task-runner 把 isCursorProvider(createdProviderId) 传给 buildSuperPromptWithBudget（不传就永远走默认 Cursor）", () => {
    const src = readSource("src/lib/server/task-runner.ts");
    const at = src.indexOf("buildSuperPromptWithBudget(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 1800)).toContain("isCursorProvider(createdProviderId)");
  }, 20_000);

  it("chat-runner 用同一个常量，没有第二份内联文案", () => {
    const chat = readSource("src/lib/server/chat-runner.ts");
    expect(chat).toContain("CURSOR_ACCOUNT_RULES_NOTE");
    expect(chat).not.toContain(ACCOUNT_RULES);
  });

  it("_super.md 用两个模板变量，不再内联声明", async () => {
    const md = await fs.readFile(path.join(ROOT, "prompts/_super.md"), "utf-8");
    expect(md).toContain("{{cursorAccountRulesNote}}");
    expect(md).toContain("{{projectRulesSection}}");
    expect(md).not.toContain(ACCOUNT_RULES);
  });
});

describe("0 份上下文文档：整段不注入（有文档时照旧）", () => {
  it("task：0 份没有「（0 份）」章节，也没有「摸资料」那句；有 1 份时章节还在、带标题", async () => {
    const empty = await build(taskOf([]));
    expect(empty).not.toContain(CONTEXT_DOCS_HEADING);
    expect(empty).not.toContain("摸资料");
    const one = await build(taskOf([], { contextDocs: [TEXT_DOC] }));
    expect(one).toContain(`${CONTEXT_DOCS_HEADING}（1 份）`);
    expect(one).toContain("需求说明");
  });

  it("task：预算极小时 0 份也不会冒出「共 0 份、已因预算裁剪」的怪占位", async () => {
    const p = await build(taskOf([]), true, 1);
    expect(p).not.toContain(CONTEXT_DOCS_HEADING);
    expect(p).not.toContain("共 0 份");
  });

  it("chat：同样 0 份不注入、有文档照常注入", () => {
    const chat = (extra: Record<string, unknown>): string =>
      __buildChatInitialPromptForTest(
        taskOf([], { id: "t_chat_ctx_docs", mode: "chat", ...extra }),
        [],
        "（用户规则占位）",
        { text: "hi" },
        "",
        "",
        "",
        "",
        true,
        { turns: [], truncated: false },
      );
    expect(chat({})).not.toContain(CONTEXT_DOCS_HEADING);
    expect(chat({ contextDocs: [TEXT_DOC] })).toContain(CONTEXT_DOCS_HEADING);
  });

  it("action-plan 不再引用一个 0 份时不存在的章节而不交代：写明「没有该章节 = 用户没加文档」", async () => {
    const md = await fs.readFile(path.join(ROOT, "prompts/action-plan.md"), "utf-8");
    expect(md).toContain("没有该章节 = 用户没加文档");
  });
});

describe("[TASK_UPDATED]：_super.md 的描述与真实输出对账（只有标题和飞书链接，没有「角色」）", () => {
  it("真实输出只含任务标题 / 飞书链接两类行，不含角色", () => {
    const old = taskOf([], { title: "旧标题", feishuStoryUrl: "https://f/old" });
    const snapshot = captureTaskFieldsSnapshot(old);
    const hint = buildTaskUpdateHint(taskOf([], { title: "新标题", feishuStoryUrl: "https://f/new" }), snapshot);
    expect(hint).toContain("任务标题已更新为「新标题」");
    expect(hint).toContain("飞书链接已更新为 https://f/new");
    expect(hint).not.toContain("角色");
  });

  it("_super.md 不再说「列出最新角色 / 角色变了切视角」（角色来自全局设置、没有热更路径），并把飞书链接指向它真实所在的上下文文档", async () => {
    const md = await fs.readFile(path.join(ROOT, "prompts/_super.md"), "utf-8");
    expect(md).not.toContain("新角色视角");
    expect(md).not.toContain("title / 角色");
    expect(md).toContain("上下文文档里的飞书链接");
    expect(md).toContain("用户在详情页改了标题 / 飞书链接、列出最新值");
  });
});
