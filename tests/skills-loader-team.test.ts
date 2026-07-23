/**
 * loadSkills / loadSkillsForTask + team 安装/卸载 + chip 过滤纯函数
 *
 * 覆盖：
 * - 启停三分：team = skill-states（enabled=已安装）；app 自管 = settings.disabledSkills；
 *   内置 / 飞书 CLI = 必备只读、不受 disabledSkills
 * - basename 命中 knowledge/skills/<cat>/<basename>/ → 即使 skill-states 标 disabled 也强制注入
 * - teamKnowledgeEnabled=false → 跳过 knowledge + 匹配命中（shared 无总开关不受影响）
 * - installTeamSkill / uninstallTeamSkill：skill-state + custom action 挂/删内聚
 * - skill-states 读写 round-trip + 损坏 fail-open
 * - sync 专用读：损坏 → 备份 + trusted:false → 跳过默认策略
 * - listTeamActions.installed 读 skill-states（同名本地 action 不误标）
 * - scanSkillsDir 跳过 symlink
 * - categoryChipsFor / applyCategoryChip 纯函数
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-skills-team-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

import {
  loadSkills,
  loadSkillsForTask,
  scanSkillsDir,
} from "@/lib/server/skills-loader";
import { listSkillsWithSource } from "@/lib/server/app-skills";
import {
  applyDefaultSkillStates,
  installTeamSkill,
  listTeamActions,
  uninstallTeamSkill,
} from "@/lib/server/team-library";
import {
  createCustomAction,
  getCustomAction,
  listCustomActions,
  removeActionShell,
  removeCustomAction,
  teamActionIdFor,
  updateCustomAction,
} from "@/lib/server/custom-action-fs";
import {
  readTeamSkillStates,
  readTeamSkillStatesForSync,
  writeTeamSkillStates,
  type TeamSkillState,
} from "@/lib/server/team-skill-states";
import {
  applyCategoryChip,
  categoryChipsFor,
  skillsForNav,
  type SkillRow,
} from "@/components/settings/skills-panel/types";

const teamRepo = () => path.join(TMP_ROOT, "team-library", "repo");
const kbSkills = () => path.join(teamRepo(), "knowledge", "skills");
const sharedSkills = () => path.join(teamRepo(), "skills");
const appSkillsDir = () => path.join(TMP_ROOT, "skills");
const feishuSkillsDir = () => path.join(TMP_ROOT, "tools", "skills");
const skillStatesPath = () =>
  path.join(TMP_ROOT, "team-library", "skill-states.json");
const skillStatesDir = () => path.join(TMP_ROOT, "team-library");

const writeSkill = async (dir: string, name: string, desc = "test skill") => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
    "utf-8",
  );
};

/** 给 skill 目录写 action 标记（安装时会挂 custom action） */
const writeActionMarker = async (dir: string, label: string) => {
  await fs.writeFile(
    path.join(dir, ".flowship-action.json"),
    JSON.stringify({ label, exportedAt: Date.now() }),
    "utf-8",
  );
};

const writeConfig = async (patch: Record<string, unknown>) => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TMP_ROOT, "config.json"),
    JSON.stringify(patch),
    "utf-8",
  );
};

const writeStates = async (states: Record<string, TeamSkillState>) => {
  await writeTeamSkillStates(states);
};

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const sub of ["team-library", "skills", "tools", "custom-actions"]) {
    await fs.rm(path.join(TMP_ROOT, sub), { recursive: true, force: true });
  }
  await writeConfig({});
});

describe("loadSkills（启停三分）", () => {
  it("team skill 标 disabled → 不注入；enabled / 不在表里 → 注入", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "team-a"), "team-a");
    await writeSkill(path.join(sharedSkills(), "fe", "team-b"), "team-b");
    await writeSkill(path.join(kbSkills(), "global", "kb-a"), "kb-a");
    await writeStates({ "team-a": "disabled", "kb-a": "enabled" });

    const list = await loadSkills();
    expect(list.find((s) => s.name === "team-a")).toBeUndefined();
    // 不在表里 = 默认已安装（fail-open、sync 后策略补写）
    expect(list.find((s) => s.name === "team-b")).toBeTruthy();
    expect(list.find((s) => s.name === "kb-a")).toBeTruthy();
  });

  it("disabledSkills 只管 app 自管；飞书 CLI / team 均不受它影响", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "team-a"), "team-a");
    await writeSkill(path.join(appSkillsDir(), "my-app"), "my-app");
    await writeSkill(path.join(feishuSkillsDir(), "lark-doc"), "lark-doc");
    // 三个全写进 disabledSkills：只有 app 源的 my-app 被滤
    await writeConfig({ disabledSkills: ["team-a", "my-app", "lark-doc"] });

    const list = await loadSkills();
    expect(list.find((s) => s.name === "team-a")).toBeTruthy();
    expect(list.find((s) => s.name === "lark-doc")).toBeTruthy();
    expect(list.find((s) => s.name === "my-app")).toBeUndefined();
  });

  it("skill-states 不影响非 team 源", async () => {
    await writeSkill(path.join(appSkillsDir(), "my-app"), "my-app");
    await writeStates({ "my-app": "disabled" });
    const list = await loadSkills();
    expect(list.find((s) => s.name === "my-app")).toBeTruthy();
  });

  it("teamKnowledgeEnabled=false：跳过 knowledge；shared 照常", async () => {
    await writeSkill(
      path.join(sharedSkills(), "common", "team-shared-skill"),
      "team-shared-skill",
    );
    await writeSkill(path.join(kbSkills(), "global", "kb-a"), "kb-a");
    await writeConfig({ teamKnowledgeEnabled: false });

    const list = await loadSkills();
    expect(list.find((s) => s.name === "team-shared-skill")).toBeTruthy();
    expect(list.find((s) => s.name === "kb-a")).toBeUndefined();
  });
});

describe("loadSkillsForTask（按仓库 basename 匹配）", () => {
  it("命中 knowledge/skills/<cat>/<basename>/：即使 skill-states 标 disabled 也强制注入", async () => {
    await writeSkill(
      path.join(kbSkills(), "frontend", "crm-web"),
      "crm-web-eng",
      "crm-web 工程 skill",
    );
    await writeSkill(
      path.join(kbSkills(), "global", "knowledge-base-qa"),
      "knowledge-base-qa",
      "知识库问答",
    );
    await writeStates({
      "crm-web-eng": "disabled",
      "knowledge-base-qa": "disabled",
    });

    const base = await loadSkills();
    expect(base.find((s) => s.name === "crm-web-eng")).toBeUndefined();

    const forTask = await loadSkillsForTask([
      "/Users/me/work/crm-web",
      "/tmp/other-repo",
    ]);
    const hit = forTask.find((s) => s.name === "crm-web-eng");
    expect(hit).toBeTruthy();
    expect(hit?.kbRoot).toBe(path.join(teamRepo(), "knowledge"));
    // 未按 basename 匹配的未安装 skill 仍不注入
    expect(forTask.find((s) => s.name === "knowledge-base-qa")).toBeUndefined();
  });

  it("teamKnowledgeEnabled=false：匹配命中不注入；shared 不受影响", async () => {
    await writeSkill(
      path.join(sharedSkills(), "fe", "team-shared-skill"),
      "team-shared-skill",
    );
    await writeSkill(
      path.join(kbSkills(), "frontend", "crm-web"),
      "crm-web-eng",
    );
    await writeConfig({ teamKnowledgeEnabled: false });

    const forTask = await loadSkillsForTask(["/repo/crm-web"]);
    expect(forTask.find((s) => s.name === "crm-web-eng")).toBeUndefined();
    expect(forTask.find((s) => s.name === "team-shared-skill")).toBeTruthy();
  });

  it("repoPaths 空数组：行为等同 loadSkills", async () => {
    await writeSkill(
      path.join(kbSkills(), "backend", "api-server"),
      "api-server-eng",
    );
    const base = await loadSkills();
    const forTask = await loadSkillsForTask([]);
    expect(forTask.map((s) => s.name).sort()).toEqual(
      base.map((s) => s.name).sort(),
    );
  });
});

describe("installTeamSkill / uninstallTeamSkill（只动 skill-states）", () => {
  it("纯 skill（无 action 标记）：安装写 enabled、卸载写 disabled", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "plain"), "plain");
    await writeStates({ plain: "disabled" });

    const inst = await installTeamSkill("plain");
    expect(inst.ok).toBe(true);
    expect((await readTeamSkillStates()).plain).toBe("enabled");
    expect(await listCustomActions()).toHaveLength(0);

    const unin = await uninstallTeamSkill("plain");
    expect(unin.ok).toBe(true);
    expect((await readTeamSkillStates()).plain).toBe("disabled");
  });

  it("带 action 标记：安装只写 states + 返回 actionLabel；不落定义文件", async () => {
    const dir = path.join(sharedSkills(), "common", "shell-skill");
    await writeSkill(dir, "shell-skill");
    await writeActionMarker(dir, "一键巡检");
    await writeStates({ "shell-skill": "disabled" });

    const inst = await installTeamSkill("shell-skill");
    expect(inst.ok && inst.actionLabel).toBe("一键巡检");
    expect((await readTeamSkillStates())["shell-skill"]).toBe("enabled");
    // 无本地定义文件、列表里出现的是派生 def
    const actions = await listCustomActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.id).toBe(teamActionIdFor("shell-skill"));
    expect(actions[0]!.origin).toBe("team");

    const unin = await uninstallTeamSkill("shell-skill");
    expect(unin.ok).toBe(true);
    expect((await readTeamSkillStates())["shell-skill"]).toBe("disabled");
    // 派生随安装态消失
    expect(await listCustomActions()).toHaveLength(0);
  });

  it("name 不存在于 team 源 → 拒绝", async () => {
    const inst = await installTeamSkill("ghost");
    expect(inst.ok).toBe(false);
    const unin = await uninstallTeamSkill("ghost");
    expect(unin.ok).toBe(false);
    expect(await readTeamSkillStates()).toEqual({});
  });
});

describe("派生 team action（listCustomActions / getCustomAction）", () => {
  it("已安装 + 带标记 → 合成虚拟 def（id/label/skill/分组）；未安装不合成", async () => {
    const feDir = path.join(sharedSkills(), "fe", "biz-analyze");
    await writeSkill(feDir, "biz-analyze");
    await writeActionMarker(feDir, "业务分析");
    const kbDir = path.join(kbSkills(), "global", "kb-act");
    await writeSkill(kbDir, "kb-act");
    await writeActionMarker(kbDir, "知识动作");
    // 纯 skill（无标记）不派生
    await writeSkill(path.join(sharedSkills(), "fe", "plain"), "plain");
    await writeStates({ "biz-analyze": "enabled", "kb-act": "disabled" });

    const actions = await listCustomActions();
    expect(actions).toHaveLength(1);
    const def = actions[0]!;
    expect(def.id).toBe("team:biz-analyze");
    expect(def.label).toBe("业务分析");
    expect(def.skill).toBe("biz-analyze");
    expect(def.origin).toBe("team");
    expect(def.teamCategory).toBe("shared:fe");

    // getCustomAction 按派生 id 可取；未安装的取不到
    expect((await getCustomAction("team:biz-analyze"))?.label).toBe("业务分析");
    expect(await getCustomAction("team:kb-act")).toBeNull();
    // knowledge 条目安装后分组 = 顶层目录名
    await writeStates({ "biz-analyze": "enabled", "kb-act": "enabled" });
    expect((await getCustomAction("team:kb-act"))?.teamCategory).toBe("global");
  });

  it("同 skill 本地 app 优先、team 派生被去重", async () => {
    const dir = path.join(sharedSkills(), "fe", "dup-skill");
    await writeSkill(dir, "dup-skill");
    await writeActionMarker(dir, "共享版");
    await writeStates({ "dup-skill": "enabled" });
    // create 要求自管 skill 目录先存在
    await writeSkill(path.join(appSkillsDir(), "dup-skill"), "dup-skill");
    const real = await createCustomAction({
      label: "本地版",
      skill: "dup-skill",
    });

    const actions = await listCustomActions();
    const matching = actions.filter((a) => a.skill === "dup-skill");
    expect(matching).toHaveLength(1);
    expect(matching[0]?.id).toBe("app:dup-skill");
    expect(real.id).toBe("app:dup-skill");
    // getCustomAction("team:…") 与 list 一致：app 同名存在时返 null
    expect(await getCustomAction("team:dup-skill")).toBeNull();
    expect((await getCustomAction("app:dup-skill"))?.label).toBe("本地版");

    // 卸掉 app 壳后 team 版恢复出现
    await removeActionShell("dup-skill");
    const after = await listCustomActions();
    const matchingAfter = after.filter((a) => a.skill === "dup-skill");
    expect(matchingAfter).toHaveLength(1);
    expect(matchingAfter[0]?.id).toBe("team:dup-skill");
    expect((await getCustomAction("team:dup-skill"))?.label).toBe("共享版");
  });

  it("写入口防护：update / remove 对 team: id 直接抛", async () => {
    await expect(
      updateCustomAction("team:whatever", { label: "x" }),
    ).rejects.toThrow(/共享库/);
    await expect(removeCustomAction("team:whatever")).rejects.toThrow(
      /卸载/,
    );
  });
});

describe("team-skill-states 存储", () => {
  it("写读 round-trip、key 排序稳定", async () => {
    await writeTeamSkillStates({ b: "disabled", a: "enabled" });
    const states = await readTeamSkillStates();
    expect(states).toEqual({ a: "enabled", b: "disabled" });
    const raw = await fs.readFile(skillStatesPath(), "utf-8");
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"b"'));
  });

  it("文件不存在 / JSON 损坏 / 非法值 → fail-open 空表或滤掉坏项", async () => {
    expect(await readTeamSkillStates()).toEqual({});
    await fs.mkdir(path.dirname(skillStatesPath()), { recursive: true });
    await fs.writeFile(skillStatesPath(), "{not json", "utf-8");
    expect(await readTeamSkillStates()).toEqual({});
    await fs.writeFile(
      skillStatesPath(),
      JSON.stringify({ ok: "enabled", bad: "maybe", worse: 1 }),
      "utf-8",
    );
    expect(await readTeamSkillStates()).toEqual({ ok: "enabled" });
  });

  it("readTeamSkillStatesForSync：ENOENT → trusted:true；损坏 → 备份 + trusted:false", async () => {
    // 真没文件 = 首次
    expect(await readTeamSkillStatesForSync()).toEqual({
      states: {},
      trusted: true,
    });

    await fs.mkdir(skillStatesDir(), { recursive: true });
    const corruptRaw = "{not-valid-json ;;;";
    await fs.writeFile(skillStatesPath(), corruptRaw, "utf-8");

    const r = await readTeamSkillStatesForSync();
    expect(r).toEqual({ states: {}, trusted: false });

    // 原文件已 rename 走、留下 .corrupt-<ts>
    await expect(fs.access(skillStatesPath())).rejects.toThrow();
    const names = await fs.readdir(skillStatesDir());
    const backups = names.filter((n) =>
      n.startsWith("skill-states.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    expect(
      await fs.readFile(path.join(skillStatesDir(), backups[0]!), "utf-8"),
    ).toBe(corruptRaw);
  });

  it("损坏 → applyDefaultSkillStates 跳过、不把用户 disabled 冲成 enabled", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "keep-off"), "keep-off");
    await fs.mkdir(skillStatesDir(), { recursive: true });
    // 假装用户卸过 keep-off，但文件坏了——旧逻辑会 fail-open 空表再全写 enabled
    await fs.writeFile(
      skillStatesPath(),
      '{"keep-off": "disabled"', // 缺闭合 → 损坏
      "utf-8",
    );

    await applyDefaultSkillStates(teamRepo());

    // 默认策略跳过：不应写出新的 skill-states.json（原文件已备份走）
    await expect(fs.access(skillStatesPath())).rejects.toThrow();
    const names = await fs.readdir(skillStatesDir());
    expect(
      names.some((n) => n.startsWith("skill-states.json.corrupt-")),
    ).toBe(true);
  });

  it("ENOENT + 有 skill → applyDefaultSkillStates 写默认 enabled", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "fresh"), "fresh");
    await applyDefaultSkillStates(teamRepo());
    expect(await readTeamSkillStates()).toEqual({ fresh: "enabled" });
  });
});

describe("listTeamActions.installed（读 skill-states）", () => {
  it("同名本地 action + states disabled → installed=false（不再被本地启发式误标）", async () => {
    const dir = path.join(sharedSkills(), "common", "dup-act");
    await writeSkill(dir, "dup-act");
    await writeActionMarker(dir, "共享版");
    // 用户已卸载 team 版，但本地还留着同名自建 action
    await writeStates({ "dup-act": "disabled" });
    await writeSkill(path.join(appSkillsDir(), "dup-act"), "dup-act");
    await createCustomAction({ label: "本地版", skill: "dup-act" });

    const list = await listTeamActions();
    const entry = list.find((a) => a.skillName === "dup-act");
    expect(entry).toBeTruthy();
    expect(entry!.installed).toBe(false);
  });

  it("states enabled / 不在表里 → installed=true", async () => {
    const onDir = path.join(sharedSkills(), "common", "on-act");
    await writeSkill(onDir, "on-act");
    await writeActionMarker(onDir, "已装");
    const missDir = path.join(sharedSkills(), "common", "miss-act");
    await writeSkill(missDir, "miss-act");
    await writeActionMarker(missDir, "未见过");
    await writeStates({ "on-act": "enabled" });

    const list = await listTeamActions();
    expect(list.find((a) => a.skillName === "on-act")?.installed).toBe(true);
    expect(list.find((a) => a.skillName === "miss-act")?.installed).toBe(true);
  });
});

describe("scanSkillsDir 跳过 symlink", () => {
  it("目录 symlink / 文件 symlink 都不扫进结果（与 copyTree 对齐）", async () => {
    const root = path.join(TMP_ROOT, "scan-symlink-root");
    const outside = path.join(TMP_ROOT, "scan-symlink-outside");
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });

    // 仓外真实 skill（若跟随 symlink 就会被扫到）
    await writeSkill(path.join(outside, "leaked"), "leaked", "仓外");
    // 仓内真实 skill
    await writeSkill(path.join(root, "real"), "real", "仓内");
    // 目录级 symlink → 仓外
    await fs.symlink(
      path.join(outside, "leaked"),
      path.join(root, "via-dir-link"),
    );
    // 文件级 symlink：假 SKILL.md 指仓外
    const decoy = path.join(root, "decoy");
    await fs.mkdir(decoy, { recursive: true });
    await fs.symlink(
      path.join(outside, "leaked", "SKILL.md"),
      path.join(decoy, "SKILL.md"),
    );

    const found = await scanSkillsDir(root);
    expect(found.map((s) => s.name).sort()).toEqual(["real"]);
  });
});

describe("listSkillsWithSource（shared:<cat> 推导 + action 标记）", () => {
  it("skills/<cat>/<name>/ → teamCategory=shared:<cat>；带标记的 hasActionMarker=true", async () => {
    await writeSkill(path.join(sharedSkills(), "fe", "my-fe"), "my-fe");
    await writeSkill(path.join(sharedSkills(), "legacy-flat"), "legacy-flat");
    const actionDir = path.join(sharedSkills(), "common", "with-action");
    await writeSkill(actionDir, "with-action");
    await writeActionMarker(actionDir, "壳");
    await writeSkill(path.join(kbSkills(), "frontend", "eng"), "fe-eng");

    const list = await listSkillsWithSource();
    expect(list.find((s) => s.name === "my-fe")?.teamCategory).toBe("shared:fe");
    expect(list.find((s) => s.name === "legacy-flat")?.teamCategory).toBe(
      "shared:common",
    );
    expect(list.find((s) => s.name === "fe-eng")?.teamCategory).toBe("frontend");
    expect(list.find((s) => s.name === "with-action")?.hasActionMarker).toBe(
      true,
    );
    expect(list.find((s) => s.name === "my-fe")?.hasActionMarker).toBe(false);
  });
});

describe("chip 过滤纯函数", () => {
  const row = (patch: Partial<SkillRow>): SkillRow => ({
    name: "x",
    description: "",
    source: "team",
    editable: false,
    enabled: true,
    absPath: "/x",
    ...patch,
  });
  const data: SkillRow[] = [
    row({ name: "a", teamCategory: "shared:fe" }),
    row({ name: "b", teamCategory: "shared:fe" }),
    row({ name: "c", teamCategory: "shared:common" }),
    row({ name: "d", teamCategory: "shared:xxx" }),
    row({ name: "e", teamCategory: "global" }),
    row({ name: "f", teamCategory: "frontend" }),
    row({ name: "g", source: "app", teamCategory: undefined }),
    row({ name: "h", source: "builtin", teamCategory: undefined }),
  ];

  it("skillsForNav：shared / knowledge / 普通来源三分", () => {
    expect(skillsForNav(data, "shared").map((s) => s.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(skillsForNav(data, "knowledge").map((s) => s.name)).toEqual([
      "e",
      "f",
    ]);
    expect(skillsForNav(data, "app").map((s) => s.name)).toEqual(["g"]);
  });

  it("categoryChipsFor：全部 + 有内容的分类；shared 按 common/fe/... 优先、未知殿后", () => {
    expect(categoryChipsFor(data, "shared")).toEqual([
      { value: "all", label: "全部", count: 4 },
      { value: "common", label: "通用", count: 1 },
      { value: "fe", label: "前端", count: 2 },
      { value: "xxx", label: "xxx", count: 1 },
    ]);
    expect(categoryChipsFor(data, "knowledge")).toEqual([
      { value: "all", label: "全部", count: 2 },
      { value: "frontend", label: "frontend", count: 1 },
      { value: "global", label: "global", count: 1 },
    ]);
    // 非 shared/knowledge 来源无 chip 行
    expect(categoryChipsFor(data, "app")).toEqual([]);
    // 空来源无 chip（连「全部」都不出）
    expect(categoryChipsFor([], "shared")).toEqual([]);
  });

  it("applyCategoryChip：all 不过滤、分类精确过滤", () => {
    expect(applyCategoryChip(data, "shared", "all").map((s) => s.name)).toEqual(
      ["a", "b", "c", "d"],
    );
    expect(applyCategoryChip(data, "shared", "fe").map((s) => s.name)).toEqual([
      "a",
      "b",
    ]);
    expect(
      applyCategoryChip(data, "knowledge", "global").map((s) => s.name),
    ).toEqual(["e"]);
    // 非 shared/knowledge 导航忽略 chip
    expect(applyCategoryChip(data, "app", "fe").map((s) => s.name)).toEqual([
      "g",
    ]);
  });
});
