/**
 * F2-08（续）：旁路只读 shell「禁内联代码」的同类开关盘点——预加载选项之外，还有两处能把 data: URL 当代码跑。
 *
 * tests/readonly-shell-preload-inline.test.ts 已钉住 --import / --loader / --experimental-loader / --require / -r。
 * 这里补的是盘点时（真 node 22 / npm 10 实测）发现的另两个同机制开关，它们同样不在当时的内联旗标判定里
 * （那时是一条叫 `SCRIPT_INLINE_FLAG_RE` 的正则，现已改成函数 `isInlineCodeFlag`，见 pi-coding-tools.ts）：
 *   1. node `--test-reporter`：值是 data: URL 时，reporter 模块源码就是 URL 里的内容（`--test_reporter` 下划线、空格分隔都生效）；
 *   2. npm `--node-options`：npm 把它原样塞进子进程的 NODE_OPTIONS，里面写 `--import=data:…` 等于内联代码
 *      （`npm run x --node-options=…` / `npm test --node-options …` / `npm --node-options=… run x` 都生效；
 *      下划线写法 `--node_options` 实测无效；pnpm 不认该选项）。
 * 当前没有调用方传 readOnly: true，所以是潜伏的。
 *
 * 钉三件事：
 *   A. 真 node 实测这两种写法确实会执行 data: 里的代码（样例有杀伤力，防止测试空转）；
 *   B. 校验层对这两种写法一律拒绝；
 *   C. 既有放行行为不变：reporter 用内置名 / 仓内文件、--node-options 只带普通选项、脚本自己的参数里有 data: 字样，照常放行。
 *
 * 全程 data: 载荷只用无害的 console.log 标记；校验用纯函数（不 spawn 业务命令、不碰网）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-inline-family-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });
await fs.writeFile(path.join(CWD, "t.test.js"), 'require("node:test")("t", () => {});\n');
await fs.writeFile(path.join(CWD, "empty.mjs"), "\n");

const { validateReadonlyShellCommand } = await import("@/lib/server/pi-coding-tools");

const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined);

const isWin = process.platform === "win32";

/** 无害载荷：只往 stdout 打一个标记 */
const REPORTER_DATA =
  'data:text/javascript,export default async function*(s){console.log("MARK-REPORTER");for await(const e of s){}}';
// NODE_OPTIONS 会按引号规则吃掉值里的双引号，所以这个载荷不带引号：打印一个数字当标记
const IMPORT_DATA = "data:text/javascript,console.log(48879)";
/** 校验用的最小 data: 值（不带引号，方便拼命令） */
const DATA = "data:text/javascript,0";

describe.skipIf(isWin)("A · 真 node 实测：这两种写法确实会执行 data: URL 里的代码", () => {
  it("--test-reporter=data:…（等号 / 空格 / 下划线三种写法）", () => {
    for (const args of [
      [`--test-reporter=${REPORTER_DATA}`],
      ["--test-reporter", REPORTER_DATA],
      [`--test_reporter=${REPORTER_DATA}`],
    ]) {
      const r = spawnSync(process.execPath, ["--test", ...args, "t.test.js"], {
        cwd: CWD,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(r.stdout, args.join(" ")).toContain("MARK-REPORTER");
    }
  });

  it("NODE_OPTIONS=--import=data:…（npm --node-options 就是把值原样放进它）", () => {
    const r = spawnSync(process.execPath, ["empty.mjs"], {
      cwd: CWD,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: `--import=${IMPORT_DATA}` },
    });
    expect(r.stdout).toContain("48879");
  });
});

describe("B · 校验层必须拒绝", () => {
  const REJECT: Array<[string, string]> = [
    ["node --test-reporter= 等号形态", `node --test --test-reporter=${DATA} t.test.js`],
    ["node --test-reporter 空格分隔", `node --test --test-reporter ${DATA} t.test.js`],
    ["node --test_reporter 下划线（node 同样认）", `node --test --test_reporter=${DATA} t.test.js`],
    ["--test-reporter 值带引号", `node --test --test-reporter "${DATA}" t.test.js`],
    ["--test-reporter scheme 大写", `node --test --test-reporter=DATA:text/javascript,0 t.test.js`],
    ["npm run … --node-options= 等号形态", `npm run test --node-options=--import=${DATA}`],
    ["npm test --node-options 空格分隔", `npm test --node-options "--import=${DATA}"`],
    ["npm --node-options=… run test（选项在动词之前）", `npm --node-options=--import=${DATA} run test`],
    ["--node-options 里是 --import 空格 data:", `npm run test --node-options="--import ${DATA}"`],
    ["--node-options 里是 --require=data:（与 --import 同类，一并拒）", `npm test --node-options="--require=${DATA}"`],
    ["--node-options 里 data: 在别的选项之后", `npm test --node-options="--max-old-space-size=512 --import=${DATA}"`],
    ["--node-options scheme 大写", `npm test --node-options=--import=DATA:text/javascript,0`],
    ["pnpm 也一并拒（pnpm 不认该选项，但拿不准归谁就宁可拒）", `pnpm run test --node-options=--import=${DATA}`],
  ];

  it.each(REJECT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});

describe("C · 既有放行行为不变", () => {
  const ACCEPT: Array<[string, string]> = [
    ["node --test 跑仓内测试文件", "node --test t.test.js"],
    ["--test-reporter 用内置名", "node --test --test-reporter=spec t.test.js"],
    ["--test-reporter 用内置名（空格）", "node --test --test-reporter spec t.test.js"],
    ["--test-reporter 用仓内文件", "node --test --test-reporter ./scripts/reporter.mjs t.test.js"],
    ["npm test", "npm test"],
    ["npm run test", "npm run test"],
    ["--node-options 只带普通选项（等号）", "npm run test --node-options=--max-old-space-size=4096"],
    ["--node-options 只带普通选项（空格）", 'npm test --node-options "--max-old-space-size=4096"'],
    ["--node-options 里预加载仓内文件", "npm test --node-options=--import=./scripts/pre.mjs"],
    ["脚本自己的参数里有 data: 字样（前一个 token 不是上述选项）", "npm test -- data:text/plain,hello"],
    ["node 脚本自己的参数里有 data: 字样", "node scripts/ok.js data:text/plain,hello"],
  ];

  it.each(ACCEPT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });
});
