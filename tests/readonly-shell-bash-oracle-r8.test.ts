/**
 * L4-01 的预言机（第八轮）：「被校验器接受的命令，bash 不会对它的参数做任何展开」。
 *
 * 做法：用固定种子的伪随机生成器（确定性、有条数上限）从「花括号 / 逗号 / 波浪线 / 通配 / `$` / 反斜杠 / 引号 / 反引号 /
 * 空格 / `..` `/` 与若干正常字符」里拼参数串；对每一条被 `validateReadonlyShellCommand` **接受**的命令，在临时目录
 * （cwd 里建若干同名文件诱饵通配，HOME 指向假目录）里用真 bash 跑 `printf '%s\0' S <参数串>` 拿实际 argv，
 * 断言它等于校验器视角的字面 token 列表（`splitShellTokens`——校验器全部判断都基于它）。
 *
 * 约束（别改松）：
 *   - 绝不真执行被校验的命令：预言机只跑 `printf`（bash 内建）；PATH 指向一个空目录，即使校验器放行了不该放的东西，
 *     bash 也找不到任何外部命令；字母表里没有能拼出绝对路径命令的字母组合；cwd / HOME 都是临时目录。
 *   - 只验证「接受 ⇒ 无展开」这个方向。被拒绝的不检查（拒绝不会造成校验与执行不一致）。
 *   - 只在 `/bin/bash` 存在时跑（Windows 上 pi 选的 Git Bash 路径不在本机，见最后一个用例的说明）。
 *   - 预言机只覆盖 **bash**。`getShellConfig` 实际选的 shell：darwin / linux 是 `/bin/bash -c`（不存在才退到 PATH 上的 bash，
 *     再不行才是 `sh -c`）；Windows 是 Git for Windows 的 bash.exe（再退到 PATH 上的 bash.exe：Cygwin / MSYS2 / WSL），
 *     没有 cmd / PowerShell 分支；找不到 bash 时 `getShellConfig` 直接抛错。所以 Windows 上也是 bash 语义，但那里的 bash
 *     本测试没跑过——这是「推演」，不是验证。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASH = "/bin/bash";
const HAVE_BASH = process.platform !== "win32" && existsSync(BASH);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ro-oracle-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
/** 校验器的 cwd，同时是预言机 bash 的 cwd（通配诱饵就建在这里） */
const WORK = path.join(TMP_ROOT, "work");
const FAKE_HOME = path.join(TMP_ROOT, "home");
const EMPTY_BIN = path.join(TMP_ROOT, "empty-bin");
mkdirSync(path.join(TMP_ROOT, "data"), { recursive: true });
mkdirSync(path.join(WORK, "scripts"), { recursive: true });
mkdirSync(path.join(WORK, "d"), { recursive: true });
mkdirSync(path.join(FAKE_HOME, ".ssh"), { recursive: true });
mkdirSync(EMPTY_BIN, { recursive: true });
// 诱饵：让 `*` `?` `[ab]` `a*` `*.json` 等通配真的有东西可匹配（内容全空：即使被当脚本 source 也什么都不做）
for (const name of ["a", "b", "ab", "x", "1", "a1", "a.json", "config.json", ".hid", "d/a"]) {
  writeFileSync(path.join(WORK, name), "");
}
writeFileSync(path.join(FAKE_HOME, "x"), "");

const { validateReadonlyShellCommand, splitShellTokens } = await import("@/lib/server/pi-coding-tools");

const OPTS = { pgExecRepoRoot: WORK };
const validate = (command: string) =>
  validateReadonlyShellCommand(WORK, command, undefined, undefined, OPTS);

/** 预言机环境：干净 env、假 HOME、PATH 是空目录（外部命令一个都找不到）、固定 locale */
// NODE_ENV 只是为了满足本仓对 NodeJS.ProcessEnv 的类型扩展（必填），bash 不读它
const ORACLE_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: EMPTY_BIN, HOME: FAKE_HOME, LC_ALL: "C", LANG: "C" };

/** 真 bash 对「参数串」的实际 argv（先放一个哨兵 S，避免零参数时 printf 仍打一个空串） */
const oracleArgv = (argsText: string): string[] => {
  const out = execFileSync(BASH, ["-c", `printf '%s\\0' S ${argsText}`], {
    cwd: WORK,
    env: ORACLE_ENV,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const parts = out.toString("utf8").split("\0");
  parts.pop(); // printf 每个参数后都带一个 \0，末尾多出一个空段
  return parts.slice(1);
};

/** mulberry32：确定性伪随机，种子固定 → 每次跑的候选序列完全相同 */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 字母表：任务要求的那批特殊字符 + 其它会让 bash 做事的字符 + 正常字符（字母只有 a b x：拼不出任何外部命令名 / 绝对路径命令） */
const SPECIAL_ATOMS = [
  "{", "}", ",", "~", "*", "?", "[", "]", "$", "\\", "'", '"', "`", " ", " ", "..", "/", ".",
  "!", "#", ";", "|", "&", "<", ">", "(", ")", "$(", "${", "\t", "\u0001", "\u007f", "\r",
];
const PLAIN_ATOMS = ["a", "b", "x", "ab", "1", "=", ":", "@", "%", "+", "-", "_", "中", "--", "-n"];
const ALL_ATOMS = [...SPECIAL_ATOMS, ...PLAIN_ATOMS, ...PLAIN_ATOMS];
/** 未加引号时校验器允许的字符（字母表里挑出来，用来拼「结构化」的参数：裸段 + 引号段） */
const BARE_ATOMS = ["a", "b", "x", "ab", "1", "=", ":", "@", "%", "+", "-", "_", ",", "..", "/", ".", "--", "-n"];

/** 被测的「宿主」命令头：git log 几乎只剩字符层校验；echo 还要过路径钳制；node 脚本只查前导旗标 / 受保护脚本 */
const HOSTS = ["git log", "echo", "node scripts/ok.js"];

const MAX_CANDIDATES = 12_000;
const TARGET_ACCEPTED = 300;

describe.skipIf(!HAVE_BASH)("预言机 fuzz：被校验器接受的参数，真 bash 不做任何展开（argv == 字面 token 列表）", () => {
  it("预言机自检：这些写法 bash 确实会展开（否则「接受 ⇒ 相等」什么也证明不了）", () => {
    for (const [text, why] of [
      ["{a,b}", "花括号展开成两个参数"],
      ["x{a,b}y", "花括号带前后缀"],
      ["*", "通配匹配到诱饵文件"],
      ["?", "单字符通配"],
      ["[ab]", "字符类通配"],
      ["*.json", "扩展名通配"],
      ["~", "波浪线展开成假 HOME"],
      ["a=~", "bash 3.2 在 `=` 之后也展开 ~"],
      ['"$HOME"', "变量展开成假 HOME"],
      ["{1..3}", "花括号序列"],
    ] as const) {
      const literal = splitShellTokens(text);
      expect(literal, text).not.toBeNull();
      expect(oracleArgv(text), `${text}（${why}）应与字面 token 不同`).not.toEqual(literal);
    }
  });

  it("预言机自检：引号里的同一批字符是字面量（argv == 字面 token 列表），且校验器接受它们", () => {
    for (const text of [
      "'{a,b}'",
      "'*'",
      "'?'",
      "'[ab]'",
      "'~'",
      "'a=~'",
      "'$HOME'",
      "'\\'",
      "'a b'",
      '"{a,b}"',
      '"*"',
      '"?"',
      '"[ab]"',
      '"~"',
      '"a=~"',
      '"cost$"',
      '"a$"b',
      "''",
      '""',
      "'a'\"b\"c",
      "--include='*.ts'",
      "--grep=\"a*{b}~c\"",
    ]) {
      const literal = splitShellTokens(text);
      expect(literal, text).not.toBeNull();
      expect(oracleArgv(text), text).toEqual(literal);
      const verdict = validate(`git log ${text}`);
      expect(verdict.ok, `${text} → ${verdict.reason ?? ""}`).toBe(true);
    }
  });

  it("fuzz：种子固定、至多 12000 个候选、最多 300 条被接受的命令逐条对真 bash", () => {
    const rand = mulberry32(0x5eed_0801);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(arr: readonly T[]): T => arr[int(arr.length)]!;
    const atomsExcept = (banned: string) => ALL_ATOMS.filter((a) => !a.includes(banned));
    const genQuoted = (q: "'" | '"'): string => {
      const pool = atomsExcept(q);
      const n = int(5);
      let body = "";
      for (let i = 0; i < n; i++) body += pick(pool);
      return q + body + q;
    };
    const genWord = (): string => {
      const segs = 1 + int(3);
      let word = "";
      for (let i = 0; i < segs; i++) {
        const r = rand();
        if (r < 0.35) word += pick(BARE_ATOMS);
        else if (r < 0.6) word += genQuoted("'");
        else if (r < 0.85) word += genQuoted('"');
        else word += pick(ALL_ATOMS); // 混进一个原始原子：多数被拒，也能造出 `'a'{b,c}` 这类「引号旁边的裸展开」
      }
      return word;
    };
    const genArgs = (): string => {
      if (rand() < 0.3) {
        // 纯随机原子拼接：绝大多数被拒，用来确认「漏过去的」都对得上
        const n = 1 + int(8);
        let s = "";
        for (let i = 0; i < n; i++) s += pick(ALL_ATOMS);
        return s;
      }
      const words = 1 + int(3);
      const parts: string[] = [];
      for (let i = 0; i < words; i++) parts.push(genWord());
      return parts.join(rand() < 0.9 ? " " : "\t");
    };

    const accepted: Array<{ host: string; args: string }> = [];
    const mismatches: string[] = [];
    let candidates = 0;
    while (accepted.length < TARGET_ACCEPTED && candidates < MAX_CANDIDATES) {
      const host = HOSTS[candidates % HOSTS.length]!;
      const args = genArgs();
      candidates++;
      const verdict = validate(`${host} ${args}`);
      if (!verdict.ok) continue;
      accepted.push({ host, args });
      const literal = splitShellTokens(args);
      if (literal === null) {
        mismatches.push(`${JSON.stringify(args)}：校验器放行了引号未闭合的参数串`);
        continue;
      }
      try {
        const actual = oracleArgv(args);
        if (JSON.stringify(actual) !== JSON.stringify(literal)) {
          mismatches.push(`${host} ${JSON.stringify(args)}：校验器看到 ${JSON.stringify(literal)}，bash 实际 argv 是 ${JSON.stringify(actual)}`);
        }
      } catch (err) {
        mismatches.push(`${host} ${JSON.stringify(args)}：被接受但真 bash 报错（${(err as Error).message.split("\n")[0]}）`);
      }
    }

    expect(mismatches, `不一致 ${mismatches.length} 条：\n${mismatches.slice(0, 10).join("\n")}`).toEqual([]);

    // 非空转：接受的条数足够、三种宿主都有、引号里的特殊字符确实被覆盖到（这些字符只可能出现在引号里，否则不会被接受）
    expect(accepted.length, `候选 ${candidates} 个里只接受 ${accepted.length} 个`).toBeGreaterThanOrEqual(150);
    for (const host of HOSTS) expect(accepted.some((a) => a.host === host), host).toBe(true);
    for (const ch of ["{", "}", "*", "?", "[", "]", "~", ",", "$", "\\", "!", "#", ";", "|", "&", "(", ")", "<", ">"]) {
      expect(accepted.some((a) => a.args.includes(ch)), `被接受的样本里没有覆盖到引号内的 ${ch}`).toBe(true);
    }
    expect(accepted.some((a) => a.args.includes("'")), "单引号").toBe(true);
    expect(accepted.some((a) => a.args.includes('"')), "双引号").toBe(true);
    // 留一行数字在测试输出里，报告 / 复核时看得见覆盖面（种子固定，每次相同）
    console.info(`[oracle-fuzz] 候选 ${candidates}，被接受 ${accepted.length}，与真 bash 不一致 ${mismatches.length}`);
  }, 180_000);

  it("getShellConfig 实际选的 shell：本机 darwin / linux 是 /bin/bash -c（预言机用 /bin/bash 才有意义）", async () => {
    const { getShellConfig } = await import("@earendil-works/pi-coding-agent");
    const cfg = getShellConfig();
    expect(cfg.shell).toBe(BASH);
    expect(cfg.args).toEqual(["-c"]);
  });
});

describe.skipIf(HAVE_BASH)("预言机 fuzz：本机没有 /bin/bash（Windows 或精简容器）——跳过", () => {
  it("跳过说明：预言机只覆盖 bash；此环境不跑", () => {
    expect(HAVE_BASH).toBe(false);
  });
});
