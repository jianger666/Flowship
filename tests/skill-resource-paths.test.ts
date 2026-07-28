/**
 * skill 自带资源（templates/ references/ scripts/）的路径根，两条注入路径各钉一条
 *
 * 背景（2026-07-28 核实）：一个 skill 身上可能同时挂着**两个根**、语义完全不同——
 *   - **skill 目录** = SKILL.md 所在目录，`templates/` `references/` `scripts/` 这类
 *     skill 自带资源在这里
 *   - **kbRoot** = 知识库根（只有 team `knowledge/skills/**` 源有），`knowledge-base/…`
 *     这类库内路径才以它为根
 * 两者相差 `skills/<cat>/<name>/` 三层。旧版能力清单只给 kbRoot 并标注「本 skill 内的
 * 相对路径以此目录为根解析」，agent 照做会把 `templates/business/x.md` 解析到
 * `<kbRoot>/templates/…`（不存在）→ 读不到团队模板。
 *
 * 所以下面的断言不比对文案，而是**拿 prompt 里给出的根去 resolve 真实相对路径、
 * 断言文件真的存在**——只要哪天两个根又被混起来，resolve 必然落空、测试必红。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-skill-res-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

import { loadSkills, renderSkillsForPrompt } from "@/lib/server/skills-loader";
import { loadActionPrompt } from "@/lib/server/task-prompts";
import type { ActionRecord, Task } from "@/lib/types";

const teamRepo = () => path.join(TMP_ROOT, "team-library", "repo");
const kbRootDir = () => path.join(teamRepo(), "knowledge");
const kbSkills = () => path.join(kbRootDir(), "skills");
const sharedSkills = () => path.join(teamRepo(), "skills");

/** knowledge 源 skill：自带 templates/，同时正文还引用了 kbRoot 相对的库内文件 */
const HARNESS_DIR = () => path.join(kbSkills(), "global", "demo-harness");
/** shared 源 skill：只有自带 templates/、无 kbRoot */
const ACT_DIR = () => path.join(sharedSkills(), "common", "demo-act");

/** skill 自带资源的相对路径（正文里就是这么写的） */
const SELF_REL = "templates/business/doc.md";
/** 知识库库内资源的相对路径（以 kbRoot 为根） */
const KB_REL = "knowledge-base/index/project-skill-map.yaml";

const writeFile = async (abs: string, content: string) => {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
};

const writeSkill = async (dir: string, name: string, body: string) =>
  writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 测试用\n---\n\n${body}\n`,
  );

const writeActionMarker = async (dir: string, label: string) =>
  writeFile(
    path.join(dir, ".flowship-action.json"),
    JSON.stringify({ label, exportedAt: Date.now() }),
  );

const exists = async (abs: string): Promise<boolean> =>
  fs
    .access(abs)
    .then(() => true)
    .catch(() => false);

/** 从渲染结果里取某个字段行的值（`  path: /abs` → `/abs`） */
const fieldOf = (rendered: string, key: string): string => {
  const line = rendered
    .split("\n")
    .find((l) => l.trim().startsWith(`${key}:`));
  if (!line) throw new Error(`渲染结果里没有 ${key} 行：\n${rendered}`);
  return line.trim().slice(key.length + 1).trim();
};

const customAction = (customActionId: string): ActionRecord =>
  ({
    id: "act_1",
    n: 1,
    type: "custom",
    status: "running",
    userInstruction: "",
    artifactPath: "actions/1-custom.md",
    customActionId,
    startedAt: Date.now(),
    endedAt: null,
  }) as unknown as ActionRecord;

const fakeTask = (action: ActionRecord): Task =>
  ({
    id: "t_skill_res",
    title: "skill 资源路径",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: action.id,
    actions: [action],
    mrs: [],
    repoPaths: [path.join(TMP_ROOT, "repo")],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as Task;

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(TMP_ROOT, "team-library"), {
    recursive: true,
    force: true,
  });
  await writeFile(path.join(TMP_ROOT, "config.json"), "{}");

  // knowledge 源：SKILL.md 正文同时引用「自带模板」和「库内索引」两类相对路径
  await writeSkill(
    HARNESS_DIR(),
    "demo-harness",
    [
      "# demo harness",
      "",
      `- 生成文档产物时读取 \`${SELF_REL}\`。`,
      `- 判断知识库来源时读取 \`${KB_REL}\`。`,
    ].join("\n"),
  );
  await writeFile(path.join(HARNESS_DIR(), SELF_REL), "# 模板（skill 自带）\n");
  await writeFile(path.join(kbRootDir(), KB_REL), "projects: []\n");

  // shared 源：挂 action 壳的 skill，自带模板、无 kbRoot
  await writeSkill(
    ACT_DIR(),
    "demo-act",
    ["# demo act", "", `- 产出前先读 \`${SELF_REL}\`。`].join("\n"),
  );
  await writeFile(path.join(ACT_DIR(), SELF_REL), "# 模板（action skill 自带）\n");
  await writeActionMarker(ACT_DIR(), "演示动作");
});

describe("能力清单（renderSkillsForPrompt）：两个根各司其职", () => {
  it("按 prompt 给的根 resolve：skill 目录能读到自带模板、kbRoot 能读到库内索引", async () => {
    const harness = (await loadSkills()).find((s) => s.name === "demo-harness");
    expect(harness?.kbRoot).toBe(kbRootDir());

    const rendered = renderSkillsForPrompt([harness!]);
    // AI 只能从这两行拿到根：path 行推 skill 目录、kbRoot 行直接给知识库根
    const skillDir = path.dirname(fieldOf(rendered, "path"));
    const kbRoot = fieldOf(rendered, "kbRoot");

    // 语义 1：skill 自带资源以 skill 目录为根 —— 解析得到的文件真实存在
    expect(await exists(path.join(skillDir, SELF_REL))).toBe(true);
    // 语义 2：库内资源以 kbRoot 为根 —— 同样真实存在
    expect(await exists(path.join(kbRoot, KB_REL))).toBe(true);

    // 语义 3（本次 bug 的实质）：两个根不可互换 —— 交叉解析必然落空。
    // 旧版把 kbRoot 说成「本 skill 内相对路径」的根，agent 照做就撞这一格。
    expect(await exists(path.join(kbRoot, SELF_REL))).toBe(false);
    expect(await exists(path.join(skillDir, KB_REL))).toBe(false);
    // 两个根确实不同（差 skills/<cat>/<name>/ 三层），不是恰好相等蒙混过关
    expect(skillDir).not.toBe(kbRoot);
  });

  it("回归钉：kbRoot 行只给路径，不得再声称自己是「本 skill 内相对路径」的根", async () => {
    const harness = (await loadSkills()).find((s) => s.name === "demo-harness");
    const rendered = renderSkillsForPrompt([harness!]);

    expect(fieldOf(rendered, "kbRoot")).toBe(kbRootDir());
    // kbRoot 行上不许再挂「相对路径以此为根」这类说明（旧文案就是栽在这）
    expect(rendered).not.toMatch(/kbRoot:[^\n]*相对路径/);
    // 解析规则统一放段首、且把 skill 自带资源指向 path 所在目录
    const header = rendered.split("\n")[0]!;
    expect(header).toContain("templates/");
    expect(header).toContain("path");
  });
});

describe("action 挂载正文（loadCustomActionPlaybook）：正文得知道自己出自哪个目录", () => {
  it("shared 源：playbook 给出 skill 目录绝对路径，按它能 resolve 到自带模板", async () => {
    const action = customAction("team:demo-act");
    const playbook = await loadActionPrompt(action, fakeTask(action));

    const dir = /本 skill 目录：`([^`]+)`/.exec(playbook)?.[1];
    expect(dir).toBe(ACT_DIR());
    expect(await exists(path.join(dir!, SELF_REL))).toBe(true);
    // 无 kbRoot 的源不要凭空编一个知识库根出来
    expect(playbook).not.toContain("知识库根");
  });

  it("knowledge 源：skill 目录与 kbRoot 同时给出，两条相对路径分别 resolve 得到", async () => {
    await writeActionMarker(HARNESS_DIR(), "知识动作");
    const action = customAction("team:demo-harness");
    const playbook = await loadActionPrompt(action, fakeTask(action));

    const dir = /本 skill 目录：`([^`]+)`/.exec(playbook)?.[1];
    const kb = /知识库根 `([^`]+)`/.exec(playbook)?.[1];
    expect(dir).toBe(HARNESS_DIR());
    expect(kb).toBe(kbRootDir());
    expect(await exists(path.join(dir!, SELF_REL))).toBe(true);
    expect(await exists(path.join(kb!, KB_REL))).toBe(true);
  });

  it("skill 缺失时保持原兜底文案、不硬拼一个目录出来", async () => {
    await fs.rm(ACT_DIR(), { recursive: true, force: true });
    const action = customAction("team:demo-act");
    const playbook = await loadActionPrompt(action, fakeTask(action));
    expect(playbook).not.toContain("本 skill 目录");
  });
});
