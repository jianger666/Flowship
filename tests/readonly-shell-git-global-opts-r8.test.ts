/**
 * L4-01 同类（第八轮，我方复核时用真 git 实测补出来的）：git 的动词之前的全局选项也得走白名单。
 *
 * 机制：旁路只读 shell 的 git 分支原先取「第一个不以 `-` 开头的 token」当动词，再去 READONLY_GIT_VERBS 查表。
 * 这跟第七轮 K4-01 在 node / npm / pnpm / bash 上修掉的是同一类问题——**带值全局选项（空格分隔）的值不以 `-` 开头，被当成了动词**：
 *   git --namespace log branch zzz       校验器看到动词 `log`（在白名单里），真实动词是 `branch zzz`；
 *   git --namespace status checkout x    校验器看到 `status`，真实执行的是 checkout（切分支，改 HEAD 与工作树）；
 *   git --attr-source log push …         同理（`--attr-source <值>` 空格形态同样吃掉下一个 token）。
 * 真 git 2.42.0 在临时仓库里实测：前两条都真的执行了（创建了分支 zzz / 切了分支）。这是写方向的绕过，不是「多拒一条」。
 * 当前没有调用方传 readOnly: true，所以是潜伏的（接线之前必须先修）。
 *
 * 修法（与本轮其它条目同一设计）：动词之前只放确定不带值的布尔全局旗标（GIT_LEADING_BOOL_FLAGS），其余一律拒——
 * 包括 `-c` / `--namespace=` / `--exec-path=` 等等号形态（不吃下一个 token，但同样会改 git 的行为，没有逐项验过就不放）。
 *
 * 钉三件事：
 *   A. 这些写法一律拒，且拒绝文案点名那个前导选项（不会被别的拒绝原因顶替）；
 *   B. 常用写法照常放行（`git --no-pager log --oneline -5` 等）；
 *   C. 用真 git 做两个对照（只在本机有 git 时跑）：样例确实有杀伤力（防止测试空转）；白名单里每个旗标在真 git 里确实不吃下一个 token。
 *      只执行本文件里写死的参数数组（execFileSync、不经 shell），不执行任何被校验器放行的命令；仓库、HOME 都是临时目录。
 *
 * 局限：C 只在 git 2.42.0 上实测过；别的 git 版本里这些旗标的行为是推演（旗标名都是 git 一直有的老旗标，但没逐版本验证）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ro-gitopts-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
mkdirSync(process.env.FLOWSHIP_DATA_DIR, { recursive: true });
mkdirSync(CWD, { recursive: true });

const { validateReadonlyShellCommand, __gitLeadingBoolFlagsForTest } = await import("@/lib/server/pi-coding-tools");

const OPTS = { pgExecRepoRoot: CWD };
const check = (command: string) => validateReadonlyShellCommand(CWD, command, undefined, undefined, OPTS);

/** 第三项 = 拒绝文案里应点名的前导选项（文案里写成 `选项`） */
type Row = [desc: string, cmd: string, optionNamed: string];

describe("A · 动词之前的全局选项：除白名单布尔旗标外一律拒（原先 `--namespace <值>` 的值被当成动词）", () => {
  const REJECT: Row[] = [
    ["--namespace 空格 + 值恰好是 log：真实动词是 branch（真 git 会创建分支）", "git --namespace log branch zzz", "--namespace"],
    ["--namespace 空格 + 值是 status：真实动词是 checkout（真 git 会切分支）", "git --namespace status checkout other", "--namespace"],
    ["--namespace 空格 + 值是 show：真实动词是 reset", "git --namespace show reset --hard", "--namespace"],
    ["--namespace 空格 + 值是 diff：真实动词是 push", "git --namespace diff push origin main", "--namespace"],
    ["--namespace= 等号形态（不吃下一个 token，但没验过就不放）", "git --namespace=x log", "--namespace"],
    ["--attr-source 空格（真 git 2.42 实测同样吃掉下一个 token）", "git --attr-source log push origin x", "--attr-source"],
    ["--attr-source= 等号形态", "git --attr-source=HEAD log", "--attr-source"],
    ["-c 带配置（pager / alias / sshCommand 都能借它换成别的程序）", "git -c core.pager=x log", "-c"],
    ["-c 紧跟的值被当动词的旧路径也拒：-c 在白名单之外", "git -c user.name=x log", "-c"],
    ["--exec-path= 换 git 子命令目录", "git --exec-path=/nonexistent log", "--exec-path"],
    ["--config-env 空格形态", "git --config-env core.pager=X log", "--config-env"],
    ["--super-prefix 空格形态", "git --super-prefix x log", "--super-prefix"],
    ["--paginate（会起 pager 程序）", "git --paginate log", "--paginate"],
    ["-p（--paginate 的短写）", "git -p log", "-p"],
    ["--bare", "git --bare log", "--bare"],
    ["白名单旗标之后跟不认识的：整串按顺序查，不因前面有合法旗标而放过", "git --no-pager --namespace log push", "--namespace"],
    ["白名单旗标夹在中间", "git --namespace status --no-pager checkout other", "--namespace"],
    ["未知的将来旗标", "git --some-future-flag log", "--some-future-flag"],
    ["孤立的 -", "git - log", "-"],
  ];

  it.each(REJECT)("%s", (_desc, cmd, optionNamed) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    expect(verdict.reason ?? "", `${cmd} 的拒绝文案应点名 \`${optionNamed}\``).toContain(`\`${optionNamed}\``);
  });

  it("没有动词（只有全局选项）仍拒；动词不在白名单仍拒（既有行为）", () => {
    for (const cmd of ["git", "git --no-pager", "git push", "git --no-pager checkout x", "git ''"]) {
      const verdict = check(cmd);
      expect(verdict.ok, cmd).toBe(false);
      expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    }
  });

  it("既有的 GIT_BANNED_FLAG 仍在：-C / --git-dir / --work-tree / --no-index / --output 照拒", () => {
    for (const cmd of [
      "git -C /tmp status",
      "git --git-dir=/tmp/x.git status",
      "git --work-tree=/tmp status",
      "git diff --no-index a b",
      "git log --output=x",
    ]) {
      const verdict = check(cmd);
      expect(verdict.ok, cmd).toBe(false);
      expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    }
  });
});

describe("B · 常用写法照常放行（改白名单没有误杀）", () => {
  const ACCEPT: Array<[string, string]> = [
    ["git log", "git log"],
    ["git --no-pager log --oneline -5（既有放行行为）", "git --no-pager log --oneline -5"],
    ["git -P diff --stat（-P 是 --no-pager 的短写）", "git -P diff --stat"],
    ["git --no-optional-locks status", "git --no-optional-locks status"],
    ["git --no-replace-objects log -1", "git --no-replace-objects log -1"],
    ["多个白名单旗标连用", "git --no-pager --no-optional-locks status --short"],
    ["--literal-pathspecs", "git --literal-pathspecs log -- f"],
    ["动词之后的选项不受前导白名单约束（它们是动词自己的选项）", "git log --since='2 weeks ago' --author=me --stat"],
    ["git branch 列表形态（既有，对方的 E 组也钉了）", "git --no-pager branch -a"],
  ];
  it.each(ACCEPT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });
});

const HAVE_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const GIT_HOME = path.join(TMP_ROOT, "githome");
const REPO = path.join(TMP_ROOT, "repo");
/**
 * 隔离的 git 环境：假 HOME、不读系统 / 全局配置、固定身份。
 * 故意不继承宿主 env；Next 的类型补丁让 NodeJS.ProcessEnv 的 NODE_ENV 必填，
 * 普通对象要先过 unknown（同 boot-manifest.test.ts），而不是往 git 的环境里塞一个无关的 NODE_ENV。
 */
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: GIT_HOME,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
} as unknown as NodeJS.ProcessEnv;
/** 只执行本文件写死的参数数组（不经 shell、不执行校验器放行的任何命令） */
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: REPO, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });

describe.skipIf(!HAVE_GIT)("C · 真 git 对照（git 2.42.0 实测；只在本机有 git 时跑）", () => {
  const setup = () => {
    mkdirSync(GIT_HOME, { recursive: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q", ".");
    writeFileSync(path.join(REPO, "f"), "hi\n");
    git("add", "f");
    git("commit", "-qm", "init");
    git("branch", "other");
  };

  it("样例有杀伤力：`git --namespace log branch zzz` 真的创建了分支（校验器按「第一个非 - token」会把它当 log 放行）", () => {
    setup();
    expect(git("branch", "--list", "zzz").trim()).toBe("");
    git("--namespace", "log", "branch", "zzz");
    expect(git("branch", "--list", "zzz").trim()).toContain("zzz");
    // 校验器现在拒它（上面 A 组钉了原因）
    expect(check("git --namespace log branch zzz").ok).toBe(false);
  });

  it("样例有杀伤力：`git --namespace status checkout other` 真的切了分支（动作类动词借此绕过动词白名单）", () => {
    const before = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(before).not.toBe("other");
    git("--namespace", "status", "checkout", "other");
    expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("other");
    expect(check("git --namespace status checkout other").ok).toBe(false);
  });

  it("白名单里每个旗标在真 git 里都是不吃下一个 token 的布尔旗标（后面的 rev-parse 照常执行）", () => {
    expect(__gitLeadingBoolFlagsForTest.length).toBeGreaterThan(0);
    for (const flag of __gitLeadingBoolFlagsForTest) {
      expect(git(flag, "rev-parse", "--is-inside-work-tree").trim(), flag).toBe("true");
    }
  });
});

describe.skipIf(HAVE_GIT)("C · 本机没有 git——真 git 对照跳过", () => {
  it("跳过说明：C 组只在本机有 git 时跑；A / B 组是纯函数校验、照常跑", () => {
    expect(HAVE_GIT).toBe(false);
  });
});
