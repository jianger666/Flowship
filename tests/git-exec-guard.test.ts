/**
 * 「src 下没有漏网的 git 调用点」守卫（R14 Q10-04 / Q10-07 / Q10-02）。
 *
 * 规则：`src/` 里每一处拉起 git 子进程的地方，env 都必须来自 `git-exec.ts` 的 `gitEnv()`——
 * 剔宿主注入变量 + 剔 GitLab PAT + 不等人输入（GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never）。
 * 新增 git 调用点忘了带 env（= 整份继承 process.env，PAT 与宿主变量原样交给用户仓的钩子 / fsmonitor / 外部 diff 驱动）会在这里红。
 *
 * 判定口径（保守，宁可误报也不漏）：调用点之后的**代码**里必须有属性赋值 `env: gitEnv(…)`（或 `env: x ?? gitEnv(…)`）；
 * 注释里写的 `gitEnv()` 不算数，先算好存进变量再 `env: e` 传进去也不认（要内联，才扫得出来）。
 *
 * 这是源码级扫描，补的是行为测试覆盖不到的调用点（`git config --get`、`git show`、`git log` 这类不拉起用户命令的只读调用）；
 * 能拉起用户命令的路径另有真钩子行为测试（git-hook-env.test.ts）。
 *
 * 扫描器自己也有负例自测——它哪天悄悄失效（正则被改坏、目录写错）会让上面的规则空转，所以：
 * ① 必须扫到一批已知文件、总数不低于下限；② 对合成源码必须报得出漏网、不误报、窗口按调用点切分。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (rel: string): string => readFileSync(path.join(srcDir, rel), "utf-8");

/** 一个调用点往后看多少字符找 `env: gitEnv(`；到下一个调用点为止，不让后一处借前一处的 */
const WINDOW_CHARS = 900;

/**
 * 把注释抹成空白（保留换行与长度，行号不变）：注释里写的 `gitEnv()` 不算数，注释里的示例调用也不算调用点。
 * 行注释只认「行首或空白之后的 //」——`https://` 的 // 前面是 `:`，不会被当成注释。
 */
const blank = (s: string): string => s.replace(/[^\n]/g, " ");
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)\/\/.*$/gm, (m: string, lead: string) => lead + blank(m.slice(lead.length)));

/** env 必须是属性赋值，值来自 gitEnv：`env: gitEnv(…)`，或 team-library 的 `env: env ?? gitEnv()` */
const ENV_FROM_GIT_ENV_RE = /\benv\s*:\s*(?:[\w$.]+\s*\?\?\s*)?gitEnv\(/;

/** 拉起 git 的 child_process 调用：execFile* / spawn* / fork，第一个参数是字面量 "git"（允许 cp.execFile 这类带前缀的写法） */
const ARGV_CALL_RE =
  /(?<![\w$])(execFileAsync|execFile|execFileSync|spawn|spawnSync|fork)\(\s*(["'`])git\2/g;
/** shell 型：exec("git status") / execSync(`git ...`) */
const SHELL_CALL_RE = /(?<![\w$])(exec|execSync|execAsync)\(\s*(["'`])git\s/g;

interface GitCallSite {
  line: number;
  fn: string;
  window: string;
}

const findGitCallSites = (rawText: string): GitCallSite[] => {
  const text = stripComments(rawText);
  const hits = [...text.matchAll(ARGV_CALL_RE), ...text.matchAll(SHELL_CALL_RE)].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return hits.map((m, i) => {
    const start = m.index ?? 0;
    const nextStart = i + 1 < hits.length ? (hits[i + 1].index ?? 0) : text.length;
    return {
      line: text.slice(0, start).split("\n").length,
      fn: m[1],
      window: text.slice(start, Math.min(nextStart, start + WINDOW_CHARS)),
    };
  });
};

const usesGitEnv = (site: GitCallSite): boolean => ENV_FROM_GIT_ENV_RE.test(site.window);

const listSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
};

const scanSrc = (): Array<GitCallSite & { file: string }> =>
  listSourceFiles(srcDir).flatMap((file) =>
    findGitCallSites(readFileSync(file, "utf-8")).map((site) => ({
      ...site,
      file: path.relative(path.dirname(srcDir), file),
    })),
  );

describe("src 下每一处 git 调用点的 env 都来自 gitEnv()", () => {
  it("没有漏网：每个 git 调用点的 env 属性必须来自 gitEnv(…)（注释里写的不算）", () => {
    const offenders = scanSrc()
      .filter((s) => !usesGitEnv(s))
      .map((s) => `${s.file}:${s.line} ${s.fn}("git", …)`);

    expect(
      offenders,
      "这些 git 调用点没把 env 交给 gitEnv()——PAT / 宿主变量会原样进用户仓的钩子里（见 git-exec.ts 文件头）",
    ).toEqual([]);
  });

  it("扫描器没失效：已知有 git 调用的文件都扫得到，总数不低于下限", () => {
    const sites = scanSrc();
    const files = new Set(sites.map((s) => s.file.replace(/\\/g, "/")));

    for (const f of [
      "action-checks",
      "chat-checkpoint",
      "git-branches",
      "submit-mr-guard",
      "task-changes",
      "task-worktrees",
      "team-library",
      "team-skill-authors",
      "testing-task-branches",
      "wk-source-branch",
    ]) {
      expect(files.has(`src/lib/server/${f}.ts`), `${f}.ts 应该被扫描到`).toBe(true);
    }
    // 写这条守卫时全仓 22 处；留出重构余量，但不能掉到只剩零头
    expect(sites.length).toBeGreaterThanOrEqual(18);
  });

  it("env 约定只在 git-exec.ts 定义：别处不许再自己赋值 GIT_TERMINAL_PROMPT / GCM_INTERACTIVE", () => {
    const assign = /(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE)["']?\s*[:=]\s*["'`]/;
    const offenders = listSourceFiles(srcDir)
      .filter((f) => path.basename(f) !== "git-exec.ts")
      .filter((f) => assign.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(path.dirname(srcDir), f));

    expect(offenders, "git 子进程的 env 约定收口在 git-exec.ts，别处再赋值就是第 6 种写法").toEqual([]);
  });

  it("git 输出容量只用共享的 GIT_MAX_BUFFER：分支 / refs 枚举不许再写 MiB 字面量（Q10-02）", () => {
    for (const rel of ["lib/server/git-branches.ts", "lib/server/wk-source-branch.ts"]) {
      const values = [...read(rel).matchAll(/maxBuffer:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
      expect(values.length, `${rel} 应该有 maxBuffer`).toBeGreaterThan(0);
      expect(values.filter((v) => v !== "GIT_MAX_BUFFER"), rel).toEqual([]);
    }
  });

  it("团队库网络 git 的 env 也经 gitEnv、不再整份展开 process.env（TL_GIT_TOKEN 作为 extra 传入）", () => {
    const m = read("lib/server/team-library.ts").match(/const buildGitTokenEnv = [\s\S]*?;\n/);
    expect(m, "找不到 buildGitTokenEnv").not.toBeNull();
    expect(m![0]).toContain("gitEnv(");
    expect(m![0]).toContain("GIT_TOKEN_ENV");
    expect(m![0]).not.toContain("process.env");
  });
});

describe("扫描器自测：对合成源码报得出漏网、不误报", () => {
  it("没带 env / 没带 gitEnv 的调用报出来；带 gitEnv 的（含多行写法）不报", () => {
    const text = [
      `await execFileAsync("git", ["status"], { cwd });`,
      `await execFileAsync(`,
      `  "git",`,
      `  ["config", "--get", "remote.origin.url"],`,
      `  { cwd, timeout: 10_000, env: gitEnv() },`,
      `);`,
    ].join("\n");

    const sites = findGitCallSites(text);

    expect(sites.map((s) => [s.line, usesGitEnv(s)])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("窗口按调用点切分：第二处不能借第一处的 gitEnv(", () => {
    const text = [
      `execFileSync("git", ["a"], { env: gitEnv() });`,
      `execFileSync("git", ["b"], { cwd });`,
    ].join("\n");

    expect(findGitCallSites(text).map(usesGitEnv)).toEqual([true, false]);
  });

  it("spawn / spawnSync / fork / 带前缀的 cp.execFile / shell 型 exec 都认得；变量名里带 spawn 的、非 git 命令不算", () => {
    const text = [
      `spawn("git", ["x"], {});`,
      `spawnSync('git', ["x"]);`,
      `cp.execFile("git", ["x"], () => {});`,
      "execSync(`git status`);",
      `exec("git log");`,
      `respawn("git", ["x"]);`,
      `spawn("node", ["x"]);`,
      `execFile("gitk", ["x"]);`,
    ].join("\n");

    expect(findGitCallSites(text).map((s) => [s.line, s.fn])).toEqual([
      [1, "spawn"],
      [2, "spawnSync"],
      [3, "execFile"],
      [4, "execSync"],
      [5, "exec"],
    ]);
  });

  it("注释里写的 gitEnv() 不算数：env 实际是 process.env / 展开 process.env 照样报漏网（行注释、块注释都是）", () => {
    const lineComment = [
      `await execFileAsync("git", ["status"], {`,
      `  cwd,`,
      `  // 本该走 gitEnv()，先整份继承`,
      `  env: process.env,`,
      `});`,
    ].join("\n");
    const blockComment = [
      `await execFileAsync("git", ["status"], {`,
      `  /* env: gitEnv() */`,
      `  env: { ...process.env },`,
      `});`,
    ].join("\n");

    expect(findGitCallSites(lineComment).map(usesGitEnv)).toEqual([false]);
    expect(findGitCallSites(blockComment).map(usesGitEnv)).toEqual([false]);
  });

  it("注释里的示例调用不算调用点；行号不受抹注释影响", () => {
    const text = [
      `// 例：execFileAsync("git", ["x"], { cwd })`,
      `/* spawn("git", ["y"])`,
      `   execSync("git z") */`,
      `execFileSync("git", ["real"], { env: gitEnv() });`,
    ].join("\n");

    const sites = findGitCallSites(text);

    expect(sites.map((s) => [s.line, s.fn])).toEqual([[4, "execFileSync"]]);
  });

  it("认得的合法写法：内联 gitEnv(…) 的各种形态，以及 URL 里的 // 不被当成注释", () => {
    for (const envExpr of [
      "env: gitEnv()",
      "env: gitEnv(opts.env)",
      "env: env ?? gitEnv()",
      'env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" })',
      "env:gitEnv()",
    ]) {
      const [site] = findGitCallSites(`execFileAsync("git", args, { cwd, ${envExpr} });`);
      expect(usesGitEnv(site), envExpr).toBe(true);
    }
    const [url] = findGitCallSites(
      `execFileAsync("git", ["clone", "https://example.com/x.git"], { env: gitEnv() });`,
    );
    expect(usesGitEnv(url)).toBe(true);
  });

  it("不认的写法（保守判漏网）：没有 env、整份 process.env、只剔宿主变量、先存进变量再传", () => {
    for (const envExpr of [
      "",
      ", env: process.env",
      ", env: { ...process.env }",
      ", env: stripHostInjectedEnv()",
      ", env: e",
    ]) {
      const [site] = findGitCallSites(`execFileAsync("git", args, { cwd${envExpr} });`);
      expect(usesGitEnv(site), JSON.stringify(envExpr)).toBe(false);
    }
  });
});
