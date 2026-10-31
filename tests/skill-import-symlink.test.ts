/**
 * Q13-10：「从 Cursor 导入 skill」遇到软链——导入物必须是自包含的真拷贝，而不是又一条软链。
 *
 * 旧实现 `fs.cp(src, tmp, { recursive: true })` 默认不解引用：
 *  - `~/.cursor/skills/<name>` 本身是软链（agentskills 常见的链接装法）→ 拷出来的 dest 还是软链，等于没拷；
 *  - 目录里的软链原样拷成软链，相对链还会被改写成指向「源目录」的绝对路径（源一挪 / 删，导入物就坏）。
 *
 * 新实现：先取顶层真目录、里面的软链全部解引用；断链与两种环跳过（不让整个导入失败）：
 *  - 环①：指向源目录自己 / 祖先（放行的话会把兄弟 skill / 祖先里的其他文件一并拷进来）；
 *  - 环②：指向「从顶层走到这条软链所经过的某一层目录」（子目录里的 `self → .`、指向路径上更高的一层、互相指、目录外共享目录自带的环）。
 *    首版漏掉了环②：fs.cp 对解引用的软链没有环检测，会一路往里钻到 ELOOP、整个导入失败，而旧行为（不解引用）是能导入的——下面「环②」四个用例钉它。
 * r3 加了展开上限：解引用 + 无上限，互相指的目录 / 钻石结构会按路径成倍展开（pnpm 式 node_modules 能把导入卡住）——条目 20 万、字节 2 GiB，
 *    超了整个 skill 导入失败（不是静默截断）。上限用可选参数注入（`importSkillsFromCursor(names, { limits })`），测试用小值、不造 20 万个文件；
 *    计数口径写在文件末尾那组用例的注释里。
 *
 * 变异（逐个改 copySkillTree，对应用例红）：
 *  - 不先 realpath 顶层 → 「顶层是软链」红；`dereference: false` → 「绝对 / 相对 / 外部目录 / 子目录别名」各红；
 *  - 断链也放行（判定里的报错不再当成「跳过」）→ 「断链」「被跳过的断链和环不占上限」红（解引用后 cp 抛 ENOENT、整个导入失败）；
 *  - 去掉环①的拦截 → 「环：指向父目录」「环：指向 home」红（「指向自己」那条仍被环②拦住）；
 *  - 去掉环②的拦截 → 四条「环②」和「互相指向」各红（ELOOP）；环①、环②都去掉 → 所有「环」用例和「被跳过的断链和环不占上限」「互相指向」红（自环、指向父目录：ELOOP 让整个导入失败；指向 home：嵌套复制 32 层、把 home 里的文件带进来）；
 *  - 环②只比直接父目录、不往上比 → 「更高一层」「互相指」「互相指向」红；用逻辑路径而不是真路径比 → 「共享目录自带环」「互相指向」红；
 *  - 环②的起点算上软链自己（恒命中，所有软链都被当成环）→ 凡是要把软链展开的用例都红（「对照」「钻石」「互相指向」「软链指向大文件」……）；起点跳过它所在的那一层 → 「子目录里指向自己」「共享目录自带环」红；
 *  - 在沿路径判之外再加全局去重 → 「环②：互相指」「对照：钻石」「钻石（层层指向同一目录）」「互相指向」红；
 *  - 环②的判断取反 → 所有「环②」和「对照」红；
 *  - 去掉「以 ../ 开头」的判断（把往外爬的路径也当成「在里面」）→ 「指向外部目录」红；
 *  - 去掉 `rel !== ".."`（把「指向自己的子目录」也当环）→ 「子目录别名」红；
 *  - 软链一律跳过 → 「绝对 / 相对 / 外部目录 / 子目录别名」各红。
 *  - r3 的上限（用例名取自末尾那组；列的是该变异会让红的全部用例）：
 *    条目比较 `>` 改 `>=` → 「条目数恰好等于上限」「被跳过的断链和环不占上限」（它的上限 2 恰好等于放行的条目数）「钻石」红；
 *    字节比较 `>` 改 `>=` → 「字节数恰好等于上限」「软链指向大文件」红；
 *    `||` 改 `&&`（只超一项不拦）、超限只 `return false` 不抛、把检查包进 try / catch 吞掉（静默截断）、`importSkillsFromCursor` 整个不透传 limits、`replaceDirWithCopy` 不透传
 *      → 注入了上限的 9 个用例都红（「超过条目上限」「超过字节上限」「条目数恰好等于上限」「字节数恰好等于上限」「软链指向大文件」「钻石」「互相指向」「一个超限、一个正常」「旧版完好」）；
 *    条目不累加 / 只丢注入的条目上限 → 6 个红：「超过条目上限」「条目数恰好等于上限」「钻石」「互相指向」「一个超限、一个正常」「旧版完好」；
 *    字节不累加 / 只丢注入的字节上限 → 「超过字节上限」「字节数恰好等于上限」「软链指向大文件」红；
 *    软链文件的字节漏掉 / 取软链自己的长度 → 「软链指向大文件」红；目录也算字节 → 「字节数恰好等于上限」「软链指向大文件」红；
 *    skill 目录自己不计 → 「条目数恰好等于上限」「钻石」红；被跳过的断链 / 环也计数 → 「被跳过的断链和环不占上限」红；
 *    默认条目上限改小 → 「默认上限」红；默认字节上限改小 → 「默认上限」「超过条目上限」（文案里的「2 GB」）红；
 *    超限后不清临时目录 → 「钻石」「互相指向」「旧版完好」红（三个都断言数据根下没有遗留）；
 *    文案去掉目录名 / 清理建议 / GB 换算 → 「超过条目上限」红；去掉上限数值 → 「超过条目上限」「超过字节上限」红。
 *    （`fs.stat(target)` 改 `fs.lstat(target)` 是等价变异：target 已经是真路径、不是软链；
 *     数字的千分位格式（`toLocaleString("en-US")`）这里触发不了：注入的小值显示成 `10`，默认值的文案要超 20 万条才会出现——这一项没有测试覆盖，不是等价变异。）
 *  （`path.isAbsolute` 那一项在 POSIX 上是等价变异——只有 Windows 跨盘符才会返回绝对路径——本机无法验证；
 *   环②「比到顶层为止」改成「一直比到文件系统根」也是等价变异：再往上的祖先由环①先拦。）
 *
 * 软链夹具在 Windows 上要特权（开发者模式 / 管理员），所以整个文件在 win32 上跳过。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SKILL_COPY_MAX_BYTES, SKILL_COPY_MAX_ENTRIES, importSkillsFromCursor } from "@/lib/server/app-skills";
import { getAppSkillsDir } from "@/lib/server/skills-loader";

let home: string;

const cursorSkills = () => path.join(home, ".cursor", "skills");
const elsewhere = () => path.join(home, "dotfiles");
const appSkill = (name: string) => path.join(getAppSkillsDir(), name);

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
};

/** 路径是什么：不跟随软链；不存在 = "missing" */
const kindOf = async (p: string): Promise<"symlink" | "dir" | "file" | "missing"> => {
  try {
    const st = await fs.lstat(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
};

/** 递归列出目录下所有路径（相对路径、排序），遇到软链不跟随 */
const listAll = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      out.push(path.relative(root, abs));
      if (ent.isDirectory()) await walk(abs);
    }
  };
  await walk(root);
  return out.sort();
};

/** SKILL.md + n−1 个小文件，共 n 个文件 */
const manyFiles = (n: number): Record<string, string> => {
  const files: Record<string, string> = { "SKILL.md": "BIG" };
  for (let i = 1; i < n; i++) files[`f${i}.txt`] = "x";
  return files;
};

/** 数据根下遗留的导入临时目录（`.skill-import-*`，含 `.old` 备份） */
const importLeftovers = async (): Promise<string[]> =>
  (await fs.readdir(path.dirname(getAppSkillsDir()))).filter((n) => n.startsWith(".skill-import"));

/**
 * 钻石：skill/{a,b} → d1；d_i/{a,b} → d_{i+1}；d_k/leaf.txt（共享目录都在 skill 之外）。
 * 源只有 2k + 2 条；解引用后按路径成倍增长（k=4：源 10 条 → 拷出 47 条）。
 */
const makeDiamond = async (k: number): Promise<void> => {
  const ext = path.join(elsewhere(), "diamond");
  await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
  await writeFiles(path.join(ext, `d${k}`), { "leaf.txt": "x" });
  for (let i = 1; i < k; i++) {
    await fs.mkdir(path.join(ext, `d${i}`), { recursive: true });
    for (const n of ["a", "b"]) await fs.symlink(path.join(ext, `d${i + 1}`), path.join(ext, `d${i}`, n));
  }
  for (const n of ["a", "b"]) await fs.symlink(path.join(ext, "d1"), path.join(cursorSkills(), "foo", n));
};

/**
 * 互指：m_i 里有 f.txt 和指向其余每个 m_j 的软链；skill 里给每个 m_i 一个入口软链。
 * 源 n·n + n + 1 条；解引用后按路径成倍增长（n=4：源 21 条 → 拷出 129 条；n=7：源 57 条 → 27399 条）。
 */
const makeMutual = async (n: number): Promise<void> => {
  const ext = path.join(elsewhere(), "mutual");
  await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
  for (let i = 0; i < n; i++) await writeFiles(path.join(ext, `m${i}`), { "f.txt": "x" });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) await fs.symlink(path.join(ext, `m${j}`), path.join(ext, `m${i}`, `to_${j}`));
    }
  }
  for (let i = 0; i < n; i++) await fs.symlink(path.join(ext, `m${i}`), path.join(cursorSkills(), "foo", `to_${i}`));
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "fe-skill-symlink-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.rm(getAppSkillsDir(), { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("importSkillsFromCursor：软链", () => {
  it("顶层是软链（~/.cursor/skills/<name> → 别处的真目录）：导入的是真目录，不是又一条软链", async () => {
    await writeFiles(path.join(elsewhere(), "agent-skills", "linked"), {
      "SKILL.md": "LINKED",
      "scripts/run.sh": "echo run",
    });
    await fs.mkdir(cursorSkills(), { recursive: true });
    await fs.symlink(path.join(elsewhere(), "agent-skills", "linked"), path.join(cursorSkills(), "linked"));

    const res = await importSkillsFromCursor(["linked"]);

    expect(res).toEqual({ imported: ["linked"], failed: [] });
    expect(await kindOf(appSkill("linked"))).toBe("dir");
    expect(await fs.readFile(path.join(appSkill("linked"), "SKILL.md"), "utf8")).toBe("LINKED");
    expect(await kindOf(path.join(appSkill("linked"), "scripts", "run.sh"))).toBe("file");
    // 源（真目录）被删掉之后，导入物还在、内容还在
    await fs.rm(path.join(elsewhere(), "agent-skills"), { recursive: true, force: true });
    expect(await fs.readFile(path.join(appSkill("linked"), "scripts", "run.sh"), "utf8")).toBe("echo run");
  });

  it("目录里的绝对软链（指向目录外的文件）：导入后是真文件，源文件删了也还在", async () => {
    await writeFiles(path.join(elsewhere(), "shared"), { "common.md": "COMMON" });
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(elsewhere(), "shared", "common.md"), path.join(cursorSkills(), "foo", "common.md"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "common.md"))).toBe("file");
    await fs.rm(path.join(elsewhere(), "shared"), { recursive: true, force: true });
    expect(await fs.readFile(path.join(appSkill("foo"), "common.md"), "utf8")).toBe("COMMON");
  });

  it("目录里的相对软链（指向目录内的文件）：导入后是真文件，不是指回源目录的绝对链", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "scripts/run.sh": "echo run" });
    await fs.symlink("scripts/run.sh", path.join(cursorSkills(), "foo", "run-link.sh"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "run-link.sh"))).toBe("file");
    // 源 skill 整个删掉，导入物仍然完整
    await fs.rm(path.join(cursorSkills(), "foo"), { recursive: true, force: true });
    expect(await fs.readFile(path.join(appSkill("foo"), "run-link.sh"), "utf8")).toBe("echo run");
    expect(await fs.readFile(path.join(appSkill("foo"), "scripts", "run.sh"), "utf8")).toBe("echo run");
  });

  it("软链指向目录外的目录（共享目录）：整份内容拷成真目录", async () => {
    await writeFiles(path.join(elsewhere(), "shared-dir"), { "x.txt": "X", "deep/y.txt": "Y" });
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(elsewhere(), "shared-dir"), path.join(cursorSkills(), "foo", "shared"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "shared"))).toBe("dir");
    expect(await fs.readFile(path.join(appSkill("foo"), "shared", "deep", "y.txt"), "utf8")).toBe("Y");
  });

  it("软链指向自己的子目录（别名）：不是环，照常拷成真目录", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "scripts/run.sh": "echo run" });
    await fs.symlink("scripts", path.join(cursorSkills(), "foo", "bin"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "bin"))).toBe("dir");
    expect(await fs.readFile(path.join(appSkill("foo"), "bin", "run.sh"), "utf8")).toBe("echo run");
  });

  it("断链：跳过这一条，其余文件照常导入、整个导入不失败", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "scripts/run.sh": "echo run" });
    await fs.symlink("nope/does-not-exist", path.join(cursorSkills(), "foo", "dangling"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "dangling"))).toBe("missing");
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "scripts", "scripts/run.sh"]);
  });

  // 三种环各用一个用例、每个用例里只放一条环：去掉环保护的变异下，递归复制只会线性增长，不会成倍膨胀。
  // ⚠️ 不要放「指向文件系统根目录」的软链：变异（去掉环保护）会让 cp 真去拷整个磁盘。「指向祖先」由下面的 home 用例覆盖。
  it("环：软链指向自己——跳过，不嵌套复制", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(cursorSkills(), "foo"), path.join(cursorSkills(), "foo", "loop-self"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md"]);
  });

  it("环：软链指向父目录（兄弟 skill 都在里面）——跳过，不把别的 skill 带走", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await writeFiles(path.join(cursorSkills(), "sibling"), { "SKILL.md": "SIBLING-SECRET" });
    await fs.symlink(cursorSkills(), path.join(cursorSkills(), "foo", "loop-parent"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md"]);
  });

  it("环：软链指向更高的祖先（用户 home）——跳过", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await writeFiles(path.join(home, "Documents"), { "private.txt": "PRIVATE" });
    await fs.symlink(home, path.join(cursorSkills(), "foo", "loop-home"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md"]);
  });

  // ── 环②：软链指向「从顶层走到它所经过的某一层目录」。上面三种环的目标都在源目录之外或就是源目录，环②的目标在源目录里面，
  //    环①的判据看不出来；fs.cp 对解引用的软链没有环检测，漏判会一路往里钻到 ELOOP、整个导入失败（旧行为不解引用、这些 skill 能导入）。
  //    每个用例只放一个环；夹具都在临时 home 下，不指向 home / 根。
  it("环②：子目录里的软链指向自己所在的目录（sub/self → .）——跳过这一条，其余照常导入", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "sub/x.txt": "X" });
    await fs.symlink(".", path.join(cursorSkills(), "foo", "sub", "self"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "sub", "sub/x.txt"]);
  });

  it("环②：软链指向路径上更高的一层（a/b/up → ..，指向 a；a 不是源目录的祖先）——跳过", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "a/b/c.txt": "C" });
    await fs.symlink("..", path.join(cursorSkills(), "foo", "a", "b", "up"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "a", "a/b", "a/b/c.txt"]);
  });

  it("环②：两个子目录互相指（a/to_b → ../b、b/to_a → ../a）——各拷成对方内容的一份，里面反指回来的那条跳过", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "a/x.txt": "X", "b/y.txt": "Y" });
    await fs.symlink("../b", path.join(cursorSkills(), "foo", "a", "to_b"));
    await fs.symlink("../a", path.join(cursorSkills(), "foo", "b", "to_a"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual([
      "SKILL.md",
      "a",
      "a/to_b",
      "a/to_b/y.txt",
      "a/x.txt",
      "b",
      "b/to_a",
      "b/to_a/x.txt",
      "b/y.txt",
    ]);
  });

  it("环②：目录外的共享目录里自带环（shared/loop → .）——共享目录的内容照常拷，里面那个环跳过", async () => {
    await writeFiles(path.join(elsewhere(), "shared"), { "s.txt": "SH" });
    await fs.symlink(".", path.join(elsewhere(), "shared", "loop"));
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(elsewhere(), "shared"), path.join(cursorSkills(), "foo", "ext"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "ext", "ext/s.txt"]);
  });

  // ── 对照：下面三种「看起来像环、其实不是」的形态不能被误杀——防止判据退化成「全局去重」或「只要指向自己的子孙 / 兄弟就跳过」。
  it("对照：两条软链指向同一个目录外的目录（钻石）——不是环，各拷一份", async () => {
    await writeFiles(path.join(elsewhere(), "shared"), { "s.txt": "SH" });
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(elsewhere(), "shared"), path.join(cursorSkills(), "foo", "p"));
    await fs.symlink(path.join(elsewhere(), "shared"), path.join(cursorSkills(), "foo", "q"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "p", "p/s.txt", "q", "q/s.txt"]);
  });

  it("对照：子目录里的别名（sub/bin → scripts，指向同级目录）——不是环，照常拷成真目录", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "sub/scripts/run.sh": "echo run" });
    await fs.symlink("scripts", path.join(cursorSkills(), "foo", "sub", "bin"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "sub", "bin"))).toBe("dir");
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "sub", "sub/bin", "sub/bin/run.sh", "sub/scripts", "sub/scripts/run.sh"]);
  });

  it("对照：软链指向兄弟目录（other/link → ../sub）——不是环，照常拷成真目录", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "sub/x.txt": "X", "other/o.txt": "O" });
    await fs.symlink("../sub", path.join(cursorSkills(), "foo", "other", "link"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "other", "link"))).toBe("dir");
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "other", "other/link", "other/link/x.txt", "other/o.txt", "sub", "sub/x.txt"]);
  });

  it("覆盖导入：旧版里的真文件被换成新版（含解引用后的内容），不残留旧文件", async () => {
    await writeFiles(appSkill("foo"), { "SKILL.md": "OLD", "stale.txt": "old-only" });
    await writeFiles(path.join(elsewhere(), "agent-skills", "foo"), { "SKILL.md": "NEW", "scripts/run.sh": "echo run" });
    await fs.mkdir(cursorSkills(), { recursive: true });
    await fs.symlink(path.join(elsewhere(), "agent-skills", "foo"), path.join(cursorSkills(), "foo"));

    const res = await importSkillsFromCursor(["foo"]);

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(appSkill("foo"))).toBe("dir");
    expect(await fs.readFile(path.join(appSkill("foo"), "SKILL.md"), "utf8")).toBe("NEW");
    expect(await kindOf(path.join(appSkill("foo"), "stale.txt"))).toBe("missing");
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "scripts", "scripts/run.sh"]);
    // 数据根下没有遗留的 .skill-import-* 临时目录
    const siblings = await fs.readdir(path.dirname(getAppSkillsDir()));
    expect(siblings.filter((n) => n.startsWith(".skill-import"))).toEqual([]);
  });

  it("对照：没有软链的普通 skill 导入结果不变", async () => {
    await writeFiles(path.join(cursorSkills(), "plain"), { "SKILL.md": "PLAIN", "scripts/run.sh": "echo run", "ref/a.md": "A" });

    const res = await importSkillsFromCursor(["plain"]);

    expect(res).toEqual({ imported: ["plain"], failed: [] });
    expect(await listAll(appSkill("plain"))).toEqual(["SKILL.md", "ref", "ref/a.md", "scripts", "scripts/run.sh"]);
  });

  // ── 展开上限（r3）。解引用 + 无上限：互相指的目录 / 钻石结构会按路径成倍展开（7 个目录两两互指：源 57 条 → 拷出 27399 条），
  //    pnpm 式 node_modules 能把导入卡住。现在条目 20 万、字节 2 GiB，超了整个 skill 导入失败——不是拷一半就当成功（静默截断比失败更糟）。
  //    上限用可选参数注入，这里用小值，不造 20 万个文件。
  //    口径：条目数 = 放行的每个条目（文件、目录、解引用后的软链）+ skill 目录自己 1 条；被跳过的断链 / 环不算；
  //    字节只算文件（指向文件的软链按目标文件的大小，目录不算）；「大于」才失败、恰好等于放行。
  it("默认上限：条目 20 万、字节 2 GiB（远高于 7 个目录两两互指展开出的 27399 条）", () => {
    expect(SKILL_COPY_MAX_ENTRIES).toBe(200_000);
    expect(SKILL_COPY_MAX_BYTES).toBe(2 * 1024 ** 3);
  });

  it("超过条目上限：整个 skill 导入失败、进 failed，不是「导入成功但缺文件」", async () => {
    await writeFiles(path.join(cursorSkills(), "big"), manyFiles(30));

    const res = await importSkillsFromCursor(["big"], { limits: { maxEntries: 10 } });

    expect(res.imported).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].name).toBe("big");
    // 文案：skill 目录名、上限数值（条目是注入的 10、字节是默认的 2 GB）、清理建议；不带临时目录路径，也不带目标 skill 路径
    const msg = res.failed[0].error;
    expect(msg).toContain("目录 big ");
    expect(msg).toContain("10 个文件 / 目录");
    expect(msg).toContain("2 GB");
    expect(msg).toContain("node_modules");
    expect(msg).toContain("互相指向的软链");
    expect(msg).toContain("请清理后重试");
    expect(msg).not.toContain(".skill-import-");
    expect(msg).not.toContain(getAppSkillsDir());
    // 应用库里没有这个 skill：没有半成品，也没有缺文件的版本
    expect(await kindOf(appSkill("big"))).toBe("missing");
  });

  it("超过字节上限：整个 skill 导入失败，文案里是字节上限", async () => {
    await writeFiles(path.join(cursorSkills(), "big"), { "SKILL.md": "x".repeat(60), "a.bin": "x".repeat(60) }); // 共 120 字节

    const res = await importSkillsFromCursor(["big"], { limits: { maxBytes: 100 } });

    expect(res.imported).toEqual([]);
    expect(res.failed).toEqual([{ name: "big", error: expect.stringContaining("100 字节") }]);
    expect(await kindOf(appSkill("big"))).toBe("missing");
  });

  it("条目数恰好等于上限：放行；再少 1 条：失败（口径 = 拷出的条目数 + skill 目录自己 1 条）", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO", "sub/a.txt": "A" }); // 拷出 3 条：SKILL.md、sub、sub/a.txt

    const ok = await importSkillsFromCursor(["foo"], { limits: { maxEntries: 4 } });
    expect(ok).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "sub", "sub/a.txt"]);

    await fs.rm(appSkill("foo"), { recursive: true, force: true });
    const over = await importSkillsFromCursor(["foo"], { limits: { maxEntries: 3 } });
    expect(over.imported).toEqual([]);
    expect(over.failed.map((f) => f.name)).toEqual(["foo"]);
    expect(await kindOf(appSkill("foo"))).toBe("missing");
  });

  it("字节数恰好等于上限：放行；再少 1 字节：失败（只算文件内容，目录不算）", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "0123456789", "sub/a.txt": "012345" }); // 文件共 16 字节，另有一个目录

    const ok = await importSkillsFromCursor(["foo"], { limits: { maxBytes: 16 } });
    expect(ok).toEqual({ imported: ["foo"], failed: [] });

    await fs.rm(appSkill("foo"), { recursive: true, force: true });
    const over = await importSkillsFromCursor(["foo"], { limits: { maxBytes: 15 } });
    expect(over.imported).toEqual([]);
    expect(over.failed.map((f) => f.name)).toEqual(["foo"]);
    expect(await kindOf(appSkill("foo"))).toBe("missing");
  });

  it("软链指向目录外的大文件：字节按目标文件的大小算，不是软链自己的长度", async () => {
    await writeFiles(path.join(elsewhere(), "shared"), { "big.bin": "x".repeat(300) });
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    await fs.symlink(path.join(elsewhere(), "shared", "big.bin"), path.join(cursorSkills(), "foo", "big-link.bin"));

    // 3（SKILL.md）+ 300（big.bin）= 303
    const over = await importSkillsFromCursor(["foo"], { limits: { maxBytes: 302 } });
    expect(over.imported).toEqual([]);
    expect(over.failed.map((f) => f.name)).toEqual(["foo"]);

    const ok = await importSkillsFromCursor(["foo"], { limits: { maxBytes: 303 } });
    expect(ok).toEqual({ imported: ["foo"], failed: [] });
    expect(await kindOf(path.join(appSkill("foo"), "big-link.bin"))).toBe("file");
  });

  it("被跳过的断链和环不占上限：只算真正拷出去的条目", async () => {
    await writeFiles(path.join(cursorSkills(), "foo"), { "SKILL.md": "FOO" });
    for (const i of [1, 2, 3]) await fs.symlink(`nope/${i}`, path.join(cursorSkills(), "foo", `dangling${i}`));
    await fs.symlink(path.join(cursorSkills(), "foo"), path.join(cursorSkills(), "foo", "loop-self"));

    // 拷出 SKILL.md 一条 + skill 目录自己 = 2；3 条断链、1 条自环都被跳过，不算
    const res = await importSkillsFromCursor(["foo"], { limits: { maxEntries: 2 } });

    expect(res).toEqual({ imported: ["foo"], failed: [] });
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md"]);
  });

  it("钻石（层层指向同一目录）成倍展开：被上限拦下、整个 skill 失败；同名旧版完好、没有遗留的临时目录", async () => {
    await makeDiamond(4); // 源 10 条
    const full = await importSkillsFromCursor(["foo"]); // 默认上限：放行
    expect(full).toEqual({ imported: ["foo"], failed: [] });
    const expanded = await listAll(appSkill("foo"));
    expect(expanded.length).toBeGreaterThan(40); // 确实成倍展开了（源只有 10 条）

    // 恰好放行：拷出 expanded.length 条 + skill 目录自己
    const edge = await importSkillsFromCursor(["foo"], { limits: { maxEntries: expanded.length + 1 } });
    expect(edge).toEqual({ imported: ["foo"], failed: [] });

    // 少 1 条就失败；上一次导入的旧版内容原样还在
    const over = await importSkillsFromCursor(["foo"], { limits: { maxEntries: expanded.length } });
    expect(over.imported).toEqual([]);
    expect(over.failed.map((f) => f.name)).toEqual(["foo"]);
    expect(await listAll(appSkill("foo"))).toEqual(expanded);
    expect(await importLeftovers()).toEqual([]);
  });

  it("互相指向的目录（N=4）成倍展开：被上限拦下、整个 skill 失败；同名旧版完好、没有遗留的临时目录", async () => {
    await makeMutual(4); // 源 21 条
    const full = await importSkillsFromCursor(["foo"]);
    expect(full).toEqual({ imported: ["foo"], failed: [] });
    const expanded = await listAll(appSkill("foo"));
    expect(expanded.length).toBeGreaterThan(100); // 确实成倍展开了（源只有 21 条）

    const over = await importSkillsFromCursor(["foo"], { limits: { maxEntries: Math.floor(expanded.length / 2) } });
    expect(over.imported).toEqual([]);
    expect(over.failed.map((f) => f.name)).toEqual(["foo"]);
    expect(await listAll(appSkill("foo"))).toEqual(expanded);
    expect(await importLeftovers()).toEqual([]);
  });

  it("一个超限、一个正常：分别进 failed / imported，互不影响", async () => {
    await writeFiles(path.join(cursorSkills(), "big"), manyFiles(30));
    await writeFiles(path.join(cursorSkills(), "small"), { "SKILL.md": "SMALL", "ref/a.md": "A" });

    const res = await importSkillsFromCursor(["big", "small"], { limits: { maxEntries: 10 } });

    expect(res.imported).toEqual(["small"]);
    expect(res.failed.map((f) => f.name)).toEqual(["big"]);
    expect(await kindOf(appSkill("big"))).toBe("missing");
    expect(await listAll(appSkill("small"))).toEqual(["SKILL.md", "ref", "ref/a.md"]);
  });

  it("超限失败：同名旧版内容完好，数据根下没有遗留的临时目录", async () => {
    await writeFiles(appSkill("foo"), { "SKILL.md": "OLD", "keep.txt": "keep" });
    await writeFiles(path.join(cursorSkills(), "foo"), manyFiles(30));

    const res = await importSkillsFromCursor(["foo"], { limits: { maxEntries: 10 } });

    expect(res.imported).toEqual([]);
    expect(res.failed.map((f) => f.name)).toEqual(["foo"]);
    expect(await listAll(appSkill("foo"))).toEqual(["SKILL.md", "keep.txt"]);
    expect(await fs.readFile(path.join(appSkill("foo"), "SKILL.md"), "utf8")).toBe("OLD");
    expect(await importLeftovers()).toEqual([]);
  });
});
