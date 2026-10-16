/**
 * N8-01：旁路只读 shell 的 pg-exec「命令头」必须是严格语法（潜伏的 P3，趁没人接线先补）
 *
 * 漏洞（读码核实，与报告一致且更宽）：validateReadonlyShellCommand 只要整条命令里出现
 * `…/pg-exec.mjs` 字样就走 pg-exec 分支，而那一支只校验「SQL 部分」和「横线开头的 flag」，
 * **命令头本身不要求以 `node <pg-exec.mjs>` 开头**。于是：
 *   - `NODE_OPTIONS="--require ./x.js" node scripts/pg-exec.mjs --env t -- 'SELECT 1'`
 *     （环境变量前缀 → 先加载任意仓内脚本）；
 *   - `touch pwned scripts/pg-exec.mjs -- 'SELECT 1'`（头是任意命令，`pg-exec.mjs` 只是个参数）；
 *   - `git push origin x -- 'SELECT pg-exec.mjs'`（`pg-exec.mjs` 甚至只出现在 SQL 字符串里）
 * 全都过校验、被 bash 原样执行。
 * 当前没有调用方传 readOnly:true（旁路已改 honor-system），所以是潜伏的；加固成本低，趁没人接线先补。
 *
 * 钉四件事：
 *   A. 头必须严格是 `node <路径>/pg-exec.mjs [--env|--user|--database <值>]*`，否则拒；
 *   B. 好人写法照常放行（相对 / 绝对 / 带空格路径、`--flag=value`、绝对路径的 node）；
 *   C. 真实走只读 shell 的 def.execute：坏命令不会被执行（标记文件不出现），拒绝文案是旁路的；
 *   D. （余项）系统性 fuzz：绕过候选表逐条「校验 + 真 shell 跑」——脚本路径钳到仓内 scripts/pg-exec.mjs 的 realpath、
 *      node 二进制不许是 `./node` 之类、绕过文本分派的写法（拼引号 / 大小写 / 链接）落到通用分支也不行、
 *      `--` 后的换行不许把命令截成两条。表里每行都在真只读 shell 上跑过：被放行的只能是可信假脚本，标记文件一个都不许出现。
 *
 * 全程只在临时目录里活动，不连任何数据库（pg-exec.mjs 都是只打印一行的假脚本）。
 *
 * 注：A/B/C 的 25 条用例输入原样保留；唯一的夹具改动是校验时注入「仓」根（REPO_OPTS）——脚本路径钳到仓内之后，
 * 夹具里的假脚本必须被声明为「仓」才算可信（缺省的 process.cwd() 是真仓）。
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-pg-head-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });
// 假的 pg-exec：只打印一行，证明「好命令」真的被放行执行
await fs.writeFile(
  path.join(CWD, "scripts", "pg-exec.mjs"),
  `process.stdout.write("PG-EXEC-FAKE-RAN");\n`,
);
// 「坏人脚本」：被 NODE_OPTIONS --require 加载就会落标记文件
const REQUIRE_MARKER = path.join(CWD, "require-marker");
await fs.writeFile(
  path.join(CWD, "evil.js"),
  `require("node:fs").writeFileSync(${JSON.stringify(REQUIRE_MARKER)}, "x");\n`,
);

const { buildReadOnlyToolDefs, validateReadonlyShellCommand } = await import(
  "@/lib/server/pi-coding-tools"
);

// 「仓」= 本夹具的 CWD（里面的假 scripts/pg-exec.mjs 就是唯一可信脚本）；
// 不注入的话缺省是 process.cwd()（真仓），夹具里的假脚本会被当成「仓外同名文件」拒掉——这正是 D 段要钉的行为
const REPO_OPTS = { pgExecRepoRoot: CWD };

const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined, REPO_OPTS);

const execShell = async (command: string): Promise<string> => {
  const shell = buildReadOnlyToolDefs(CWD, { taskId: "t1" }, REPO_OPTS).find(
    (d) => (d as { name?: unknown }).name === "shell",
  ) as unknown as {
    execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  const out = await shell.execute("call-1", { command });
  return out.content.map((c) => c.text).join("\n");
};

describe("A · pg-exec 命令头必须是严格的 `node <pg-exec.mjs> [--flag 值]*`", () => {
  it.each([
    [
      "环境变量前缀（带引号，一个 token）",
      `NODE_OPTIONS="--require ./evil.js" node scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
    [
      "环境变量前缀（多个赋值）",
      `FOO=bar BAR=baz node scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
    [
      "env 命令包一层",
      `env NODE_OPTIONS=--inspect node scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
    [
      "头是任意命令、pg-exec.mjs 只是个参数",
      `touch pwned scripts/pg-exec.mjs -- 'SELECT 1'`,
    ],
    [
      "读仓外文件（cat 任意路径 + pg-exec.mjs 凑数）",
      `cat /etc/hosts scripts/pg-exec.mjs -- 'SELECT 1'`,
    ],
    [
      "pg-exec.mjs 只出现在 SQL 字符串里，头是 git push",
      `git push origin main -- 'SELECT pg-exec.mjs'`,
    ],
    [
      "node 先跑别的脚本、pg-exec.mjs 排在后面当参数",
      `node ./evil.js scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
    [
      "脚本之后多出位置参数",
      `node scripts/pg-exec.mjs extra-arg --env t -- 'SELECT 1'`,
    ],
    [
      "flag 缺值",
      `node scripts/pg-exec.mjs --env t --user -- 'SELECT 1'`,
    ],
    [
      "flag 的值是另一个 flag",
      `node scripts/pg-exec.mjs --env --user -- 'SELECT 1'`,
    ],
    [
      "用 sh 代替 node 执行",
      `sh scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
    [
      "脚本路径里藏 $HOME（双引号内 shell 照样展开）",
      `node "$HOME/scripts/pg-exec.mjs" --env t -- 'SELECT 1'`,
    ],
    [
      "flag 值里引用 GitLab token 环境变量（借 pg-exec 的报错外带）",
      `node scripts/pg-exec.mjs --env "$FLOWSHIP_GITLAB_TOKEN" -- 'SELECT 1'`,
    ],
    [
      "node 带绝对路径但夹了赋值（X=…/node 在 shell 里是环境变量赋值、不是命令）",
      `X=/usr/bin/node scripts/pg-exec.mjs --env t -- 'SELECT 1'`,
    ],
  ])("拒绝：%s", (_name, cmd) => {
    const r = check(cmd);
    expect(r.ok, cmd).toBe(false);
    expect(r.reason ?? "", cmd).toContain("旁路只读");
  });
});

describe("B · 好人写法照常放行（没有误杀）", () => {
  it.each([
    ["相对路径", `node scripts/pg-exec.mjs --env test -- 'SELECT 1'`],
    ["绝对路径加引号", `node "/repo/scripts/pg-exec.mjs" --env test -- 'SELECT * FROM t LIMIT 5'`],
    ["路径含空格", `node "/Applications/My App/scripts/pg-exec.mjs" --env test -- 'SELECT 1'`],
    ["环境名带序号 + user", `node scripts/pg-exec.mjs --env test:2 --user u1 -- 'SELECT 1'`],
    ["--flag=value 写法", `node scripts/pg-exec.mjs --env=test --database=crm -- 'SELECT 1'`],
    ["三个 flag 全给", `node scripts/pg-exec.mjs --env test --user u1 --database crm -- 'SELECT 1'`],
    ["node 用绝对路径", `/usr/local/bin/node scripts/pg-exec.mjs --env test -- 'SELECT 1'`],
    ["没有任何 flag", `node scripts/pg-exec.mjs -- 'SELECT 1'`],
    ["SQL 末尾分号", `node scripts/pg-exec.mjs --env test -- 'SELECT 1;'`],
  ])("放行：%s", (_name, cmd) => {
    const r = check(cmd);
    expect(r.ok, `${cmd} → ${r.reason ?? ""}`).toBe(true);
  });
});

describe("C · 真实走只读 shell 工具：坏命令不会被执行", () => {
  const skipWin = process.platform === "win32"; // 用 bash 语法，Windows 靠 Git Bash 另测

  it.skipIf(skipWin)(
    "头是任意命令（touch）：被拒绝、标记文件不出现；同形的好命令仍能跑",
    async () => {
      const marker = path.join(CWD, "pwned-by-head");
      const out = await execShell(`touch pwned-by-head scripts/pg-exec.mjs -- 'SELECT 1'`);
      expect(out).toContain("旁路只读");
      expect(existsSync(marker)).toBe(false);

      // 对照：规范写法真的被放行并执行（证明上面不是「什么都拒」造成的假绿）
      const ok = await execShell(`node scripts/pg-exec.mjs --env test -- 'SELECT 1'`);
      expect(ok).toContain("PG-EXEC-FAKE-RAN");
    },
    60_000,
  );

  it.skipIf(skipWin)(
    "NODE_OPTIONS 前缀：被拒绝、--require 的脚本没被加载（标记文件不出现）",
    async () => {
      const out = await execShell(
        `NODE_OPTIONS="--require ./evil.js" node scripts/pg-exec.mjs --env test -- 'SELECT 1'`,
      );
      expect(out).toContain("旁路只读");
      expect(existsSync(REQUIRE_MARKER)).toBe(false);
    },
    60_000,
  );
});

// ====================== D · 系统性 fuzz（余项） ======================
//
// 夹具世界（与上面的 CWD 夹具互不相干）：
//   R  = 「仓」：唯一可信的 scripts/pg-exec.mjs / ssh-exec.mjs 在这里（假脚本，只打印签名、不落标记）
//   W  = agent 工作目录，≠ 仓：里面有「工作区副本」「根上同名」「假 node」「各种链接」，统统不可信
//   O  = 仓外：同名 pg-exec.mjs、假 node、被读的 secret
//   M  = 标记目录：任何不可信脚本 / 预加载 / 注入命令一旦真被执行，都会在这里落一个文件
// 每行候选都过「校验 + 真只读 shell 跑一遍」：被放行的只能是可信假脚本，M 必须始终为空。
const isWin = process.platform === "win32";
const WORLD = path.join(TMP_ROOT, "world");
const R = path.join(WORLD, "repo");
const W = path.join(WORLD, "work");
const O = path.join(WORLD, "outside");
const M = path.join(WORLD, "markers");
/** 一个肯定不存在的路径（悬空链接的靶子） */
const NONEXISTENT = path.join(WORLD, "nonexistent-dir");

if (!isWin) {
  for (const d of [
    path.join(R, "scripts"),
    path.join(W, "scripts"),
    path.join(W, "sub"),
    path.join(W, "hard"),
    path.join(W, "To Trusted"),
    path.join(W, "scripts-link"),
    path.join(W, "dangling"),
    path.join(W, "loop"),
    path.join(O, "scripts"),
    path.join(O, "deep"),
    M,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  // 假脚本：打印签名 + argv；可信的不落标记，其余一律落标记（谁被执行谁留痕）
  const fakeScript = (sig: string): string =>
    `process.stdout.write("${sig} argv=" + JSON.stringify(process.argv.slice(2)));\n` +
    (sig === "PGEXEC-TRUSTED" || sig === "SSHEXEC-TRUSTED"
      ? ""
      : `require("node:fs").writeFileSync(${JSON.stringify(path.join(M, `ran-${sig}`))}, "x");\n`);
  writeFileSync(path.join(R, "scripts", "pg-exec.mjs"), fakeScript("PGEXEC-TRUSTED"));
  writeFileSync(path.join(R, "scripts", "ssh-exec.mjs"), fakeScript("SSHEXEC-TRUSTED"));
  writeFileSync(path.join(W, "scripts", "pg-exec.mjs"), fakeScript("PGEXEC-WORKCOPY"));
  writeFileSync(path.join(W, "pg-exec.mjs"), fakeScript("PGEXEC-WORKROOT"));
  writeFileSync(path.join(O, "pg-exec.mjs"), fakeScript("PGEXEC-OUTSIDE"));
  writeFileSync(path.join(O, "scripts", "pg-exec.mjs"), fakeScript("PGEXEC-OUTSIDE2"));
  const preload = `require("node:fs").writeFileSync(${JSON.stringify(path.join(M, "preload-ran"))}, "x");\n`;
  writeFileSync(path.join(W, "evil.js"), preload);
  writeFileSync(
    path.join(W, "evil.mjs"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(M, "preload-ran"))}, "x");\n`,
  );
  writeFileSync(path.join(W, "secret.txt"), "TOPSECRET\n");
  // 好人脚本：通用脚本分支的阳性对照（没有它，「什么都拒」也能让上面的拒绝用例全绿）
  writeFileSync(path.join(W, "scripts", "ok.js"), `process.stdout.write("OK-JS argv=" + JSON.stringify(process.argv.slice(2)));\n`);
  writeFileSync(path.join(R, "scripts", "ok.js"), `process.stdout.write("OK-JS-R argv=" + JSON.stringify(process.argv.slice(2)));\n`);
  // 假 node：谁用路径写法调到它，就落标记
  for (const dir of [W, O]) {
    const p = path.join(dir, "node");
    writeFileSync(p, `#!/bin/sh\ntouch ${path.join(M, "fake-node-ran")}\necho FAKE-NODE\n`);
    chmodSync(p, 0o755);
  }
  // 链接族
  symlinkSync(path.join(O, "pg-exec.mjs"), path.join(W, "scripts-link", "pg-exec.mjs")); // 文件链接 → 仓外
  symlinkSync(O, path.join(W, "link-dir")); // 目录链接 → 仓外
  symlinkSync(path.join(R, "scripts", "pg-exec.mjs"), path.join(W, "To Trusted", "pg-exec.mjs")); // → 可信（善意，含空格）
  symlinkSync(path.join(R, "scripts"), path.join(W, "repo-scripts-link")); // 目录链接 → 可信 scripts
  linkSync(path.join(R, "scripts", "pg-exec.mjs"), path.join(W, "hard", "pg-exec.mjs")); // 硬链接 → 可信
  symlinkSync(path.join(NONEXISTENT, "x.mjs"), path.join(W, "dangling", "pg-exec.mjs")); // 悬空
  symlinkSync(path.join(W, "loop", "pg-exec.mjs"), path.join(W, "loop", "pg-exec.mjs")); // 自环
  symlinkSync(path.join(O, "deep"), path.join(R, "jump")); // R/jump → O/deep：`jump/../x` 词法是 R/x、物理是 O/x
  // 反斜杠解释分歧：校验器切 token 时吞掉双引号里的 `\`（看到 R/scripts/ev/../pg-exec.mjs → 可信），
  // bash 保留它（实际走 R/scripts/`ev\`——一个指向仓外的链接——再 `..`，落到 O/pg-exec.mjs）
  mkdirSync(path.join(R, "scripts", "ev"), { recursive: true });
  symlinkSync(path.join(O, "deep"), path.join(R, "scripts", "ev\\"));
  // 「名字无辜、身份是受保护脚本」：只能靠身份判定（realpath / dev+ino）抓到，字面名抓不到
  symlinkSync(path.join(R, "scripts", "pg-exec.mjs"), path.join(W, "innocent.mjs"));
  symlinkSync(path.join(R, "scripts", "ssh-exec.mjs"), path.join(W, "innocent-ssh.mjs"));
  linkSync(path.join(R, "scripts", "pg-exec.mjs"), path.join(W, "hard", "innocent-hard.mjs"));
  // 目录名里带 `(` `)` `#` / NBSP 的合法链接（→ 可信脚本）：证明「头里未加引号的 # ( ) 与特殊空白一律拦」不会误杀写成 "…" 的路径
  // （macOS 上 `Project (copy)`、截图目录里的 U+202F 都是真实会出现的目录名）
  for (const dirName of ["proj (copy)#1", "nb\u00a0sp"]) {
    mkdirSync(path.join(W, dirName), { recursive: true });
    symlinkSync(path.join(R, "scripts", "pg-exec.mjs"), path.join(W, dirName, "pg-exec.mjs"));
  }
}
const WORLD_OPTS = { pgExecRepoRoot: R };
const worldShell = (cwd: string) => {
  const def = buildReadOnlyToolDefs(cwd, { taskId: "t1" }, WORLD_OPTS).find(
    (d) => (d as { name?: unknown }).name === "shell",
  ) as unknown as {
    execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
  };
  return async (command: string, workingDirectory?: string): Promise<string> => {
    const out = await def.execute("call-1", {
      command,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    return out.content.map((c) => c.text).join("\n");
  };
};
const shellOf = { W: isWin ? null : worldShell(W), R: isWin ? null : worldShell(R) };

const E = "node scripts/pg-exec.mjs";
const T = "--env t -- 'SELECT 1'";
const DEL = "--env t -- 'DELETE FROM x'";
const G = `node ${R}/scripts/pg-exec.mjs`;

type Expect = "reject" | "accept" | "safe"; // safe = 放不放行都行，但放行了就只能跑可信假脚本
/** [id, 分类说明, 命令, 期望, workingDirectory?, cwd(缺省 W；"R" = 工作区就是仓本身)] */
type Row = [string, string, string, Expect, string?, ("R" | undefined)?];

const ROWS: Row[] = [
  // ---- 基线：好人写法（绝对 / 相对到仓）----
  ["G1", "绝对路径", `${G} ${T}`, "accept"],
  ["G2", "相对路径 ../repo", `node ../repo/scripts/pg-exec.mjs ${T}`, "accept"],
  ["G3", "三个 flag + 引号路径", `node "${R}/scripts/pg-exec.mjs" --env=t --user u --database d -- 'SELECT 1'`, "accept"],
  // ---- 分隔符：; && || | & 换行（头里 / 头前 / SQL 后 / -- 与 SQL 之间）----
  ["S1", "; 在头", `${G} --env t ; touch ${M}/S1 -- 'SELECT 1'`, "reject"],
  ["S2", "&& 在头", `${G} --env t && touch ${M}/S2 -- 'SELECT 1'`, "reject"],
  ["S3", "|| 在头", `${G} --env t || touch ${M}/S3 -- 'SELECT 1'`, "reject"],
  ["S4", "| 在头", `${G} --env t | touch ${M}/S4 -- 'SELECT 1'`, "reject"],
  ["S5", "换行在头", `${G} --env t\ntouch ${M}/S5 -- 'SELECT 1'`, "reject"],
  ["S6", "前置 ;", `touch ${M}/S6; ${G} --env t -- 'SELECT 1'`, "reject"],
  ["S7", "前置 &", `touch ${M}/S7 & ${G} --env t -- 'SELECT 1'`, "reject"],
  ["S8", "SQL 尾 ;", `${G} --env t -- 'SELECT 1'; touch ${M}/S8`, "reject"],
  ["S9", "SQL 尾 &&", `${G} --env t -- 'SELECT 1' && touch ${M}/S9`, "reject"],
  ["S10", "SQL 尾换行", `${G} --env t -- 'SELECT 1'\ntouch ${M}/S10`, "reject"],
  ["S11", "SQL 尾 |", `${G} --env t -- 'SELECT 1' | touch ${M}/S11`, "reject"],
  ["S12", "`--` 后换行再给 SQL（shell 在 `--` 处截断命令；原先放行并先跑了一条无 SQL 的 pg-exec）", `${G} --env t --\n'SELECT 1'`, "reject"],
  ["S13", "`--` 后 CRLF", `${G} --env t --\r\n'SELECT 1'`, "reject"],
  ["S14", "SQL 尾单个 ;（善意终止符）", `${G} --env t -- 'SELECT 1';`, "accept"],
  // ---- 展开 / 替换 ----
  ["E1", "$() 在 flag 值", `${G} --env $(touch ${M}/E1) -- 'SELECT 1'`, "reject"],
  ["E2", "反引号在 flag 值", `${G} --env \`touch ${M}/E2\` -- 'SELECT 1'`, "reject"],
  ["E3", "双引号内 $()", `${G} --env "$(touch ${M}/E3)" -- 'SELECT 1'`, "reject"],
  ["E4", "脚本路径里 $()", `node "$(touch ${M}/E4)${R}/scripts/pg-exec.mjs" ${T}`, "reject"],
  ["E5", "${IFS} 代空格", `node\${IFS}${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["E6", "SQL 双引号内 $()", `${G} --env t -- "SELECT $(touch ${M}/E6)"`, "reject"],
  ["E7", "SQL 双引号内反引号", `${G} --env t -- "SELECT \`touch ${M}/E7\`"`, "reject"],
  ["E8", "SQL 单引号内 $()（字面量，保守拒）", `${G} --env t -- 'SELECT $(touch ${M}/E8)'`, "reject"],
  ["E9", "~ 路径", `node ~/scripts/pg-exec.mjs ${T}`, "reject"],
  ["E10", "glob ?", `node ${R}/scripts/pg-exe?.mjs ${T}`, "reject"],
  ["E11", "glob *", `node ${R}/scripts/pg-exec.m* ${T}`, "reject"],
  ["E12", "glob []", `node ${R}/scripts/[p]g-exec.mjs ${T}`, "reject"],
  ["E13", "brace", `node ${R}/scripts/{pg-exec,x}.mjs ${T}`, "reject"],
  ["E14", "$'..' ANSI-C", `node $'${R}/scripts/pg-exec.mjs' ${T}`, "reject"],
  ["E15", "flag 值引 GitLab token 变量", `${G} --env "$FLOWSHIP_GITLAB_TOKEN" -- 'SELECT 1'`, "reject"],
  // ---- 引号拼接 / 反斜杠 ----
  ["Q1", "脚本名拼空引号（绕文本分派）", `node ${R}/scripts/pg-exec"".mjs ${DEL}`, "reject"],
  ["Q2", "脚本名拼单引号（绕文本分派）", `node ${R}/scripts/pg-e''xec.mjs ${DEL}`, "reject"],
  ["Q3", "node 名拼引号 no''de", `no''de ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["Q4", 'n"o"de', `n"o"de ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["Q5", "SQL 后拼引号串", `${G} --env t -- 'SELECT 1'"; touch ${M}/Q5"`, "reject"],
  ["Q6", "目录名拼引号（等价写法）", `node '${R}/scripts'/pg-exec.mjs ${T}`, "accept"],
  ["Q7", "SQL 用双引号（善意）", `${G} --env t -- "SELECT 1"`, "accept"],
  ["Q8", "反斜杠 m\\js", `node ${R}/scripts/pg-exec.m\\js ${T}`, "safe"],
  ["Q9", "双引号内反斜杠（bash 保留、校验器吞掉）", `node "${R}/scripts/pg-exec.m\\js" ${T}`, "safe"],
  ["Q10", "反斜杠换行续行", `node ${R}/scripts/pg-exec.\\\nmjs ${T}`, "safe"],
  ["Q11", "ssh-exec 拼引号（原先放行并跑了）", `node ${R}/scripts/ssh-exec"".mjs --env t -- 'ls'`, "reject"],
  ["Q12", "bash 跑拼引号 pg-exec", `bash ${R}/scripts/pg-exec"".mjs ${DEL}`, "reject"],
  ["Q13", "--import 预加载把拼引号 pg-exec 挤出「第一个非 flag 参数」（原先放行并执行了 DELETE + 预加载）", `node --import ./evil.mjs ${R}/scripts/pg-exec"".mjs ${DEL}`, "reject"],
  ["Q14", "node -- 脚本拼引号", `node -- ${R}/scripts/pg-exec"".mjs ${DEL}`, "reject"],
  ["Q15", "双引号内反斜杠 + `..`：校验器看到可信路径、bash 实际落到仓外同名（要靠「头里禁反斜杠」挡）", `node "${R}/scripts/ev\\/../pg-exec.mjs" ${T}`, "reject"],
  // `node --` 后紧跟「真」脚本（Q14 只测了拼引号变体）：首个 `--` 落在 node 与脚本之间，
  // 若按「第一个 --」切 SQL 尾，尾部就是「脚本路径 + 参数 + 第二个 --」，必须整体被拒，不能让 DELETE 溜过去。
  ["Q16", "node -- 真 pg-exec + 写 SQL", `node -- ${R}/scripts/pg-exec.mjs ${DEL}`, "reject"],
  ["Q17", "node -- 真 pg-exec + 只读 SQL（放不放行都行，放行了只能跑可信假脚本）", `node -- ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  // ---- node 参数 / 环境变量前缀 / 包装命令 ----
  ["N1", "--require", `node --require ${W}/evil.js ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N2", "-r", `node -r ${W}/evil.js ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N3", "--import", `node --import ${W}/evil.mjs ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N4", "--eval", `node --eval "require('fs').writeFileSync('${M}/N4','x')" ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N5", "-e", `node -e "1" ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N6", "-p", `node -p "1" ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N7", "--loader", `node --loader ${W}/evil.mjs ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N8", "--require=", `node --require=${W}/evil.js ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N9", "-r 粘连", `node -r${W}/evil.js ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N10", "脚本之后的 --require", `${G} --require ${W}/evil.js -- 'SELECT 1'`, "reject"],
  ["N11", "--inspect-brk", `node --inspect-brk ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["N12", "--env-file", `node --env-file=${W}/secret.txt ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["V1", "NODE_OPTIONS 前缀（引号）", `NODE_OPTIONS="--require ${W}/evil.js" ${G} ${T}`, "reject"],
  ["V2", "NODE_OPTIONS 前缀（无引号）", `NODE_OPTIONS=--require=${W}/evil.js ${G} ${T}`, "reject"],
  ["V3", "env NODE_OPTIONS", `env NODE_OPTIONS=--require=${W}/evil.js ${G} ${T}`, "reject"],
  ["V4", "export …; node", `export NODE_OPTIONS=--require=${W}/evil.js; ${G} ${T}`, "reject"],
  ["V5", "command node", `command ${G} ${T}`, "reject"],
  ["V6", "exec node", `exec ${G} ${T}`, "reject"],
  ["V7", "time node", `time ${G} ${T}`, "reject"],
  ["V8", "nohup node", `nohup ${G} ${T}`, "reject"],
  ["V9", "PATH 劫持前缀", `PATH=${W}:/usr/bin ${G} ${T}`, "reject"],
  ["V10", "NODE_PATH 前缀", `NODE_PATH=${W} ${G} ${T}`, "reject"],
  // ---- 路径穿越 / 同名不在仓内 ----
  ["T1", "../ 到仓外同名（原先放行并执行了仓外那份）", `node ../outside/pg-exec.mjs ${T}`, "reject"],
  ["T2", "绝对路径仓外同名", `node ${O}/pg-exec.mjs ${T}`, "reject"],
  ["T3", "scripts/../../outside", `node scripts/../../outside/pg-exec.mjs ${T}`, "reject"],
  ["T4", "工作区根上同名 ./pg-exec.mjs", `node ./pg-exec.mjs ${T}`, "reject"],
  ["T5", "工作区 scripts/ 副本（≠ 仓）", `${E} ${T}`, "reject"],
  ["T6", "仓外 scripts/ 同名", `node ${O}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["T7", "裸名 pg-exec.mjs", `node pg-exec.mjs ${T}`, "reject"],
  ["T8", "绝对路径含 ../ 回到可信（等价）", `node ${R}/../repo/scripts/pg-exec.mjs ${T}`, "accept"],
  ["T9", "// 与 ./ 变体（等价）", `node ${R}//scripts/./pg-exec.mjs ${T}`, "accept"],
  ["T10", "脚本路径尾斜杠", `node ${R}/scripts/pg-exec.mjs/ ${T}`, "reject"],
  ["T11", "workingDirectory=sub，相对到仓（按执行目录解析）", `node ../../repo/scripts/pg-exec.mjs ${T}`, "accept", "sub"],
  ["T12", "workingDirectory=sub，../scripts 是工作区副本", `node ../scripts/pg-exec.mjs ${T}`, "reject", "sub"],
  // ---- 符号链接 / 硬链接 ----
  ["L1", "文件符号链接 → 仓外", `node ${W}/scripts-link/pg-exec.mjs ${T}`, "reject"],
  ["L2", "目录符号链接 → 仓外", `node ${W}/link-dir/pg-exec.mjs ${T}`, "reject"],
  ["L3", "符号链接 → 可信（含空格目录，等价）", `node "${W}/To Trusted/pg-exec.mjs" ${T}`, "accept"],
  ["L4", "目录链接 → 可信 scripts（等价）", `node ${W}/repo-scripts-link/pg-exec.mjs ${T}`, "accept"],
  ["L5", "硬链接 → 可信（路径不同，严格拒）", `node ${W}/hard/pg-exec.mjs ${T}`, "reject"],
  ["L6", "悬空符号链接", `node ${W}/dangling/pg-exec.mjs ${T}`, "reject"],
  ["L7", "自环符号链接", `node ${W}/loop/pg-exec.mjs ${T}`, "reject"],
  ["L8", "硬链接 + 拼引号走通用分支", `node ${W}/hard/pg-exec"".mjs ${DEL}`, "reject"],
  ["L9", "名字无辜的符号链接 → pg-exec（只能靠身份判定）", `node innocent.mjs ${DEL}`, "reject"],
  ["L10", "名字无辜的符号链接 → ssh-exec", `node innocent-ssh.mjs --env t -- 'ls'`, "reject"],
  ["L11", "名字无辜的硬链接 → pg-exec", `node hard/innocent-hard.mjs ${DEL}`, "reject"],
  ["L12", "`--import=` 的值是指向 pg-exec 的链接", `node --import=./innocent.mjs ./evil.js`, "reject"],
  // ---- 大小写 / 全角 / 同形字 ----
  ["C1", "PG-EXEC.MJS（大小写不敏感 FS 会解析到可信脚本）", `node ${R}/scripts/PG-EXEC.MJS ${DEL}`, "reject"],
  ["C2", "Pg-Exec.mjs", `node ${R}/scripts/Pg-Exec.mjs ${DEL}`, "reject"],
  ["C3", "全角 ｐｇ-exec.mjs", `node ${R}/scripts/ｐｇ-exec.mjs ${DEL}`, "safe"],
  ["C4", "西里尔 р", `node ${R}/scripts/рg-exec.mjs ${DEL}`, "safe"],
  ["C5", "NODE 大写", `NODE ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["C6", "Node.EXE", `Node.EXE ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["C7", "全角 ｎｏｄｅ", `ｎｏｄｅ ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["C8", "en dash –env", `${G} –env t -- 'SELECT 1'`, "reject"],
  ["C9", "全角 －－env", `${G} －－env t -- 'SELECT 1'`, "reject"],
  ["C10", "--ENV 大写", `${G} --ENV t -- 'SELECT 1'`, "reject"],
  ["C11", "SQL 里的全角空格（数据，不是分隔符）", `${G} --env t -- 'SELECT　1'`, "safe"],
  ["C12", "SCRIPTS 目录大写", `node ${R}/SCRIPTS/pg-exec.mjs ${DEL}`, "reject"],
  // ---- 参数顺序 / `--` / 重复 ----
  ["A1", "flag 放在 `--` 之后", `${G} -- 'SELECT 1' --env t`, "reject"],
  ["A2", "flag 放在脚本之前", `node --env t ${R}/scripts/pg-exec.mjs -- 'SELECT 1'`, "reject"],
  ["A3", "重复 --env（善意）", `${G} --env t --env u -- 'SELECT 1'`, "accept"],
  ["A4", "--config", `${G} --config ${W}/secret.txt --env t -- 'SELECT 1'`, "reject"],
  ["A5", "--config=", `${G} --config=${W}/secret.txt -- 'SELECT 1'`, "reject"],
  ["A6", "两个 `--`", `${G} --env t -- 'SELECT 1' -- 'DROP TABLE x'`, "reject"],
  ["A7", "引号包住的 '--'", `${G} --env t '--' 'SELECT 1'`, "reject"],
  ["A8", "缺 `--`", `${G} --env t 'SELECT 1'`, "reject"],
  ["A9", "--env 值以 - 开头", `${G} --env -x -- 'SELECT 1'`, "reject"],
  ["A10", "`-- -- SQL`", `${G} --env t -- -- 'SELECT 1'`, "reject"],
  ["A11", "位置参数混入", `${G} extra --env t -- 'SELECT 1'`, "reject"],
  ["A12", "--env= 空值", `${G} --env= -- 'SELECT 1'`, "reject"],
  // ---- 重定向 / heredoc / 进程替换 ----
  ["R1", "> 在头", `${G} --env t > ${M}/R1 -- 'SELECT 1'`, "reject"],
  ["R2", "> 在尾", `${G} --env t -- 'SELECT 1' > ${M}/R2`, "reject"],
  ["R3", "< 在尾", `${G} --env t -- 'SELECT 1' < /etc/hosts`, "reject"],
  ["R4", "2> 在尾", `${G} --env t -- 'SELECT 1' 2>${M}/R4`, "reject"],
  ["R5", "heredoc", `${G} --env t -- 'SELECT 1' <<EOF\nx\nEOF`, "reject"],
  ["R6", "<<<", `${G} --env t -- 'SELECT 1' <<< x`, "reject"],
  ["R7", "进程替换 <()", `${G} --env <(touch ${M}/R7) -- 'SELECT 1'`, "reject"],
  ["R8", "2>&1 在头", `${G} --env t 2>&1 -- 'SELECT 1'`, "reject"],
  ["R9", "&> 在头", `${G} --env t &>${M}/R9 -- 'SELECT 1'`, "reject"],
  // ---- 空白变体 ----
  ["W1", "tab 分隔", `node\t${R}/scripts/pg-exec.mjs\t--env\tt\t--\t'SELECT 1'`, "accept"],
  ["W2", "多空格 + 前后换行（trim）", ` \n node   ${R}/scripts/pg-exec.mjs   --env   t   --   'SELECT 1' \n`, "accept"],
  ["W3", "NBSP 分隔", `node\u00a0${R}/scripts/pg-exec.mjs --env t -- 'SELECT 1'`, "safe"],
  ["W4", "全角空格分隔", `node\u3000${R}/scripts/pg-exec.mjs --env t -- 'SELECT 1'`, "safe"],
  ["W5", "脚本名带零宽空格", `node ${R}/scripts/pg-exec.mjs\u200b ${T}`, "safe"],
  ["W6", "\\f 分隔", `${G}\f--env t -- 'SELECT 1'`, "safe"],
  ["W7", "\\r 分隔", `${G}\r--env t -- 'SELECT 1'`, "reject"],
  ["W8", "NUL", `${G}\u0000 ${T}`, "safe"],
  ["W9", "\\v 分隔", `${G}\v--env t -- 'SELECT 1'`, "safe"],
  // ---- 差分 fuzz 余项（N8-01）：「校验看到的 argv ≠ shell 实际 argv」的两族 ----
  // 方法：校验放行的命令用真 bash 跑、shim 版 node 原样打印收到的 argv，要求它恰为 [脚本, (flag 值)*, "--", 单个 SQL]。
  // 16000 个变异里 202 条对不上：200 条是下面 U 族、2 条是 H 族（补规则前这两族全部「放行」；真 pg-exec.mjs 的解析器会把畸形 argv
  // 当错误拒掉，所以没有越权执行，但校验不该依赖被调脚本的解析器兜底）。
  // H 族：词首未加引号的 `#` 是注释，把后面整段（含 `-- 'SQL'`）吞掉，实际只执行被截断的前半截（实测 argv 只剩 ["--env"]）
  ["H1", "# 开头的 --env 值：`-- 'SELECT 1'` 被注释吞掉", `${G} --env #x -- 'SELECT 1'`, "reject"],
  ["H2", "单独一个 # token", `${G} --env t # -- 'SELECT 1'`, "reject"],
  ["H3", "--user 的值以 # 开头", `${G} --user #x --env t -- 'SELECT 1'`, "reject"],
  ["H4", "词中的 #（bash 当字面量；头里没有合法用途，保守拒，要用就加引号）", `${G} --env a#b -- 'SELECT 1'`, "reject"],
  ["H5", "SQL 之后的 # 注释", `${G} --env t -- 'SELECT 1' #c`, "reject"],
  ["H6", "# 夹在 -- 与 SQL 之间", `${G} --env t -- #x 'SELECT 1'`, "reject"],
  ["H7", "对照：加了引号的 # 是字面量，放行且 argv 与校验一致", `${G} --env '#x' -- 'SELECT 1'`, "accept"],
  // P 族：未加引号的括号 bash 报语法错、什么都不执行，不构成绕过——只是不放行「必然失败 / 意图不明」的写法
  ["P1", "未加引号的括号在值里", `${G} --env (x) -- 'SELECT 1'`, "reject"],
  ["P2", "单个右括号", `${G} --env t) -- 'SELECT 1'`, "reject"],
  ["P3", "子 shell 包一层", `( ${G} --env t -- 'SELECT 1' )`, "reject"],
  ["P4", "对照：引号里的括号 / # 是路径的一部分，放行（不误杀 `Project (copy)#1` 这类目录名）", `node "${W}/proj (copy)#1/pg-exec.mjs" ${T}`, "accept"],
  // U 族：JS 的 \s 当分隔符、bash 不当的特殊空白（NBSP / 全角空格 / U+2028 / BOM / \v / \f …）
  ["U1", "-- 前是 NBSP（实测 argv=[--env, 't<NBSP>--', SQL]，根本没有 -- 分隔符）", `${G} --env t\u00a0-- 'SELECT 1'`, "reject"],
  ["U2", "-- 前是 U+2028", `${G} --env t\u2028-- 'SELECT 1'`, "reject"],
  ["U3", "-- 前是全角空格 U+3000", `${G} --env t\u3000-- 'SELECT 1'`, "reject"],
  ["U4", "-- 与 SQL 之间是 NBSP（实测 `-- SELECT 1` 粘成了一个参数）", `${G} --env t --\u00a0'SELECT 1'`, "reject"],
  ["U5", "SQL 之后 NBSP + ;（SQL 实际带着尾部 NBSP）", `${G} --env t -- 'SELECT 1'\u00a0;`, "reject"],
  ["U6", "-- 前是 \\v", `${G} --env t\v-- 'SELECT 1'`, "reject"],
  ["U7", "-- 前是 \\f", `${G} --env t\f-- 'SELECT 1'`, "reject"],
  ["U8", "-- 前是 BOM U+FEFF", `${G} --env t\ufeff-- 'SELECT 1'`, "reject"],
  ["U9", "-- 前是 U+2003 em space", `${G} --env t\u2003-- 'SELECT 1'`, "reject"],
  ["U10", "node 与脚本之间是 U+2003", `node\u2003${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["U11", "反斜杠转义的 NBSP（hasUnquotedChars 会跳过转义字符，靠头里禁反斜杠兜住）", `${G} --env t\\\u00a0-- 'SELECT 1'`, "reject"],
  ["U12", "对照：引号里的 NBSP 是路径的一部分，放行", `node "${W}/nb\u00a0sp/pg-exec.mjs" ${T}`, "accept"],
  ["U13", "对照：引号里的 NBSP 在 --env 值里，放行且 argv 与校验一致", `${G} --env 'a\u00a0b' -- 'SELECT 1'`, "accept"],
  ["U14", "SQL 引号内的 NBSP 是数据：放不放行都行，但不能错位成别的命令", `${G} --env t -- 'SELECT\u00a01'`, "safe"],
  // ---- node 二进制路径（原先 `^(?:[^=]*[\\/])?node` 放行任意 …/node）----
  ["B1", "./node（工作区里的假 node，原先放行并执行）", `./node ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["B2", "../outside/node", `../outside/node ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["B3", "仓外绝对路径 node", `${O}/node ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  ["B4", "/usr/local/bin/node（系统目录）", `/usr/local/bin/node ${R}/scripts/pg-exec.mjs ${T}`, "safe"],
  ["B5", "/usr/bin/../.. 回绕到仓外假 node", `/usr/bin/../..${O}/node ${R}/scripts/pg-exec.mjs ${T}`, "reject"],
  // ---- ssh / 其它 ----
  ["X1", "ssh-exec 直接写", `node ${R}/scripts/ssh-exec.mjs --env t -- 'ls'`, "reject"],
  ["X2", "git push + SQL 里提到 pg-exec.mjs", `git push origin main -- 'SELECT pg-exec.mjs'`, "reject"],
  ["X3", "本地 grep 提到 pg-exec.mjs（不是执行它）", `grep pg-exec.mjs secret.txt`, "safe"],
  // ---- cwd = 仓本身（工作区就是 Flowship 仓；绕「文本分派」与大小写不敏感 FS 的关键场景）----
  ["RQ1", "拼引号绕分派，pg-exec + DELETE（原先放行并执行）", `node scripts/pg-exec"".mjs ${DEL}`, "reject", undefined, "R"],
  ["RQ2", "拼引号 ssh-exec（原先放行并执行）", `node scripts/ssh-exec"".mjs --env t -- 'ls'`, "reject", undefined, "R"],
  ["RQ3", "bash 跑拼引号 pg-exec", `bash scripts/pg-exec"".mjs ${DEL}`, "reject", undefined, "R"],
  ["RQ4", "PG-EXEC.MJS + DELETE", `node scripts/PG-EXEC.MJS ${DEL}`, "reject", undefined, "R"],
  ["RQ5", "SCRIPTS 目录大写 + DELETE", `node SCRIPTS/pg-exec.mjs ${DEL}`, "reject", undefined, "R"],
  ["RQ6", "node -- 脚本拼引号", `node -- scripts/pg-exec"".mjs ${DEL}`, "reject", undefined, "R"],
  ["RQ7", "好人写法（相对）", `${E} ${T}`, "accept", undefined, "R"],
  ["RQ8", "好人写法 ./scripts/../scripts", `node ./scripts/../scripts/pg-exec.mjs ${T}`, "accept", undefined, "R"],
  ["RQ9", "`jump/../` 物理 vs 词法（R/jump → 仓外；原先放行并执行了仓外那份）", `node jump/../scripts/pg-exec.mjs ${T}`, "reject", undefined, "R"],
  ["RQ10", "拼引号 pg-exec + 合法 SELECT", `node scripts/pg-exec"".mjs ${T}`, "safe", undefined, "R"],
  ["RQ11", "--require 预加载 + 拼引号 ssh-exec", `node --require ./nothing-here.js scripts/ssh-exec"".mjs --env t -- 'ls'`, "reject", undefined, "R"],
  // ---- 展开：文本里没有字面的 pg-exec.mjs、shell 展开后才是它（cwd = 仓；原先 glob / 花括号 / 续行全部放行并以无 SQL 门的方式跑了可信 pg-exec）----
  ["RG1", "glob ? + DELETE", `node scripts/pg-exe?.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG2", "glob * 在扩展名 + DELETE", `node scripts/pg-exec.m* ${DEL}`, "reject", undefined, "R"],
  ["RG3", "glob [x] + DELETE", `node scripts/[p]g-exec.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG4", "花括号 {pg-exec,x} + DELETE", `node scripts/{pg-exec,x}.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG5", "花括号里含斜杠 scripts{/,x}pg-exec.mjs（basename 切出来是 `,x}pg-exec.mjs`）", `node scripts{/,x}pg-exec.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG6", "目录与文件名都用 glob", `node s*/pg-e*c.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG7", "POSIX 字符类 [[:lower:]]", `node scripts/[[:lower:]]g-exec.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG8", "花括号序列 {p..p}", `node scripts/{p..p}g-exec.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG9", "反斜杠 + 换行续行（校验看到 `pg-exec.<LF>mjs`，shell 拼成 pg-exec.mjs）", `node scripts/pg-exec.\\\nmjs ${DEL}`, "reject", undefined, "R"],
  ["RG10", "bash 跑 glob 版 pg-exec", `bash scripts/pg-exe?.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG11", "glob 版 ssh-exec", `node scripts/ssh-exe?.mjs --env t -- 'ls'`, "reject", undefined, "R"],
  ["RG12", "双引号里的 ${X:-pg} 参数展开", `node scripts/"\${X:-pg}-exec.mjs" ${DEL}`, "reject", undefined, "R"],
  ["RG13", "双引号里的 $(…) 命令替换", `node scripts/"$(echo pg)-exec.mjs" ${DEL}`, "reject", undefined, "R"],
  ["RG14", "双引号里的反引号命令替换", `node scripts/"\`echo pg\`-exec.mjs" ${DEL}`, "reject", undefined, "R"],
  ["RG15", "--flag=值 里的 glob", `node --import=scripts/pg-exe?.mjs ok.js`, "reject", undefined, "R"],
  ["RG16", "对照：同目录别的 .js 带 glob 之外的好写法", `node scripts/ok.js ${T}`, "safe", undefined, "R"],
  // 下面两条走「`-r ./scripts/ok.js` 抢走第一个非 flag 参数」的位置：checkBypassRunScript 只验第一个脚本操作数，
  // 真正被 node 当入口跑的脚本落在第二个操作数，只剩 findGuardedScriptOperand 这一道守卫——单独钉它
  ["RG21", "第二个操作数里的 ${X:-pg} 参数展开（展开后是可信 pg-exec；原先放行并以无 SQL 门的方式执行）", `node -r ./scripts/ok.js scripts/"\${X:-pg}-exec.mjs" ${DEL}`, "reject", undefined, "R"],
  ["RG22", "花括号展开候选过多（9 组二选一 = 512 个）：算不清就拒，不是放行", `node -r ./scripts/ok.js scripts/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}pg-exec.mjs`, "reject", undefined, "R"],
  ["RG23", "第二个操作数里的 glob（同上位置，glob 守卫单独生效）", `node -r ./scripts/ok.js scripts/pg-exe?.mjs ${DEL}`, "reject", undefined, "R"],
  ["RG17", "glob + 末尾孤零零的反斜杠（bash 3.2 吞掉它、glob 照样匹配到可信脚本；校验看到的 basename 带着 `\\`）", `node scripts/[p]g-exec.mjs\\`, "reject", undefined, "R"],
  ["RG18", "`?` glob + 末尾反斜杠", `node scripts/pg-exe?.mjs\\`, "reject", undefined, "R"],
  ["RG19", "通用分支：任意命令末尾的反斜杠", `echo hi\\`, "reject"],
  ["RG20", "pg-exec 头：SQL 之后的末尾反斜杠（放不放行都行，只要不执行不可信的东西）", `${G} --env t -- 'SELECT 1'\\`, "safe"],
  // ---- 通用脚本分支：内联代码执行（cwd = 工作区）----
  ["RI1", "node -p 内联代码", `node -p "require('fs').writeFileSync('${M}/RI1','x')"`, "reject"],
  ["RI2", "node -pe 合并短参数", `node -pe "require('fs').writeFileSync('${M}/RI2','x')"`, "reject"],
  ["RI3", "node --print", `node --print "require('fs').writeFileSync('${M}/RI3','x')"`, "reject"],
  ["RI4", "bash -xc 合并短参数", `bash -xc 'touch ${M}/RI4'`, "reject"],
  ["RI5", "sh -ec 合并短参数", `sh -ec 'touch ${M}/RI5'`, "reject"],
  ["RI6", "node -e 与代码粘连", `node -e"require('fs').writeFileSync('${M}/RI6','x')"`, "reject"],
  ["RI7", "对照：原有的裸 -e / -c 仍拒", `node -e "require('fs').writeFileSync('${M}/RI7','x')"`, "reject"],
  // ---- 通用分支：引号里的命令替换（LOCAL_UNQUOTED_DENY 只看未加引号的反引号）----
  ["RB1", "echo + 双引号反引号", `echo "\`touch ${M}/RB1\`"`, "reject"],
  ["RB2", "git log + 双引号反引号", `git log "\`touch ${M}/RB2\`"`, "reject"],
  ["RB3", "grep 模式里的双引号反引号", `grep "\`touch ${M}/RB3\`" secret.txt`, "reject"],
  ["RB4", "node 脚本参数里的双引号反引号", `node scripts/ok.js "\`touch ${M}/RB4\`"`, "reject"],
  ["RB5", "npm run 参数里的双引号反引号", `npm run test "\`touch ${M}/RB5\`"`, "reject"],
  ["RB6", "双引号里的 $(…)", `echo "$(touch ${M}/RB6)"`, "reject"],
  ["RB7", "单引号里的反引号是字面量：放不放行都行，但绝不能被执行", `echo '\`touch ${M}/RB7\`'`, "safe"],
  // ---- 通用分支：二进制路径（basename 是 node / ls 就放行，shell 实际跑的是工作区 / 仓外那个文件）----
  ["RN1", "./node（工作区假 node）", `./node scripts/ok.js`, "reject"],
  ["RN2", "../outside/node", `../outside/node scripts/ok.js`, "reject"],
  ["RN3", "仓外绝对路径 node", `${O}/node scripts/ok.js`, "reject"],
  ["RN4", "工作区绝对路径 node", `${W}/node scripts/ok.js`, "reject"],
  ["RN5", "/usr/bin/../.. 回绕到仓外假 node", `/usr/bin/../..${O}/node scripts/ok.js`, "reject"],
  ["RN6", "反斜杠路径", `.\\node scripts/ok.js`, "reject"],
];

describe.skipIf(isWin)("D · fuzz 绕过候选表：逐条校验 + 真只读 shell 跑", () => {
  beforeEach(() => {
    for (const f of readdirSync(M)) rmSync(path.join(M, f), { force: true });
  });

  it("候选表自检：id 唯一、覆盖主要类别（防有人删行后表悄悄变薄）", () => {
    const ids = ROWS.map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROWS.length).toBeGreaterThanOrEqual(150);
    for (const prefix of ["S", "E", "Q", "N", "V", "T", "L", "C", "A", "R", "W", "B", "RQ", "RG", "RI", "RB", "RN", "H", "P", "U"]) {
      expect(ids.some((id) => id.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it.each(ROWS)(
    "%s · %s",
    async (_id, _desc, cmd, expectation, workingDirectory, cwdKind) => {
      const cwd = cwdKind === "R" ? R : W;
      const verdict = validateReadonlyShellCommand(cwd, cmd, workingDirectory, undefined, WORLD_OPTS);
      const out = await (cwdKind === "R" ? shellOf.R : shellOf.W)!(cmd, workingDirectory);

      // 无论期望如何：任何不可信脚本 / 预加载 / 注入命令一旦被执行都会落标记
      expect(readdirSync(M), `${cmd}\n→ ${out}`).toEqual([]);
      // 被放行执行的只能是可信假脚本；不可信副本 / 仓外同名 / 假 node / ssh 一个都不许出现，更不许把 DELETE 交给 pg-exec
      expect(out, cmd).not.toMatch(/PGEXEC-(WORKCOPY|WORKROOT|OUTSIDE)|FAKE-NODE|SSHEXEC/);
      expect(out, cmd).not.toContain("DELETE FROM x");

      if (expectation === "reject") {
        expect(verdict.ok, `${cmd} → 不该放行`).toBe(false);
        expect(verdict.reason ?? "", cmd).toContain("旁路只读");
        expect(out, cmd).toContain("旁路只读"); // 真 shell 工具层同样是拒绝文案、没有执行
      } else if (expectation === "accept") {
        expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
        expect(out, cmd).toContain("PGEXEC-TRUSTED"); // 对照：好写法真的跑到了可信脚本（防「什么都拒」造成的假绿）
      }
    },
    60_000,
  );

  it("当前进程自己的 node 绝对路径（nvm / volta 等）放行，且跑的是可信脚本", async () => {
    const exec = process.execPath;
    if (!/[\\/]node(\.exe)?$/.test(exec) || exec.includes("\\") || exec.includes(" ")) return; // 非常规 execPath 不测
    const cmd = `${exec} ${R}/scripts/pg-exec.mjs ${T}`;
    const verdict = validateReadonlyShellCommand(W, cmd, undefined, undefined, WORLD_OPTS);
    expect(verdict.ok, verdict.reason ?? "").toBe(true);
    expect(await shellOf.W!(cmd)).toContain("PGEXEC-TRUSTED");
    expect(readdirSync(M)).toEqual([]);
  });

  it("可信脚本自己都不存在：存在的候选一律拒（fail-closed），不存在的候选不会被执行", async () => {
    const emptyRepo = path.join(WORLD, "empty-repo");
    mkdirSync(emptyRepo, { recursive: true });
    const opts = { pgExecRepoRoot: emptyRepo };
    const existing = validateReadonlyShellCommand(W, `node ${O}/pg-exec.mjs ${T}`, undefined, undefined, opts);
    expect(existing.ok).toBe(false);
    expect(existing.reason ?? "").toContain("无法确认");
    // 对照：不存在的路径放行（shell 同样加载不了它，没有东西可拦；刻意不 fail-closed，理由见 checkPgExecScriptPath）
    const ghost = validateReadonlyShellCommand(W, `node ${WORLD}/ghost/pg-exec.mjs ${T}`, undefined, undefined, opts);
    expect(ghost.ok).toBe(true);
  });

  it("阳性对照：通用脚本分支的好写法照常放行并真的执行（防「什么都拒」造成上面拒绝用例的假绿）", async () => {
    for (const cmd of ["node scripts/ok.js a b", "node ./scripts/ok.js a", "echo hi", "cat secret.txt"]) {
      const verdict = validateReadonlyShellCommand(W, cmd, undefined, undefined, WORLD_OPTS);
      expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
    }
    expect(await shellOf.W!("node scripts/ok.js a b")).toContain('OK-JS argv=["a","b"]');
    expect(await shellOf.W!("echo hi")).toContain("hi");
    expect(await shellOf.R!("node scripts/ok.js x")).toContain("OK-JS-R");
    // 名字相近但不是受保护脚本、也不含通配 / 展开的，不被误杀
    expect(validateReadonlyShellCommand(W, "node scripts/ok.js --env t", undefined, undefined, WORLD_OPTS).ok).toBe(true);
    expect(readdirSync(M)).toEqual([]);
  });

  // 刻意未覆盖：通用脚本分支里仍留着的已知缺口——cwd 内符号链接读仓外文件（node -r ./a.js <仓外脚本> 的
  // 「第一个非 flag 参数」误判已由 H4-01 修掉，见 tests/readonly-shell-preload-path.test.ts）。它不是 pg-exec 头的问题
  // （这条分支当前也没有生产调用方），本文件只钉 pg-exec 头 + 受保护脚本的分派 + 上面这批已修的展开 / 内联 / 命令替换 / 二进制路径；
  // 别在这里误以为符号链接那类已被兜住。
});
