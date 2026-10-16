/**
 * F2-08（潜伏项）：旁路只读 shell 的「禁内联代码」漏了 node 预加载选项的 data: URL 形态。
 *
 * 漏洞（读码核实 + 真 node 22 实测）：当时的内联旗标判定只认 -e / -p / -c / --eval / --print
 * （它当时是一条叫 `SCRIPT_INLINE_FLAG_RE` 的正则，H4-10 之后已改成函数 `isInlineCodeFlag`，见 pi-coding-tools.ts）。
 * 但 `node --import data:text/javascript,<代码> scripts/ok.js` 里 Node 会把 data: URL 的内容当模块源码直接执行，
 * 与 `-e` 等价，`--loader` / `--experimental-loader`（Node 把选项名里的 `_` 当 `-`，`--experimental_loader` 同样生效）也一样；
 * scheme 大小写不敏感、URL 解析会剥掉首尾空白。这些写法原先全部被放行。
 * 当前没有调用方传 readOnly: true，所以是潜伏的；趁没人接线先补。
 *
 * 钉三件事：
 *   A. 预加载选项（--import / --loader / --experimental-loader / --require / -r）的值是 data: URL → 拒；
 *   B. 既有放行行为不变：值是仓内文件 / 包名的预加载、脚本自己参数里出现 data: 字样，照常放行；
 *   C. 同类开关盘点的对照：-e / -p / -c / --eval / --print 各种写法仍拒；python / ruby / perl 等解释器不在白名单、整体拒。
 *
 * 全程只做纯函数校验（不 spawn、不碰网）；data: 载荷只用无害的 `0`。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-preload-inline-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });

const { validateReadonlyShellCommand } = await import("@/lib/server/pi-coding-tools");

const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined);

const DATA = "data:text/javascript,0";

describe("A · 预加载选项的值是 data: URL = 内联代码，一律拒", () => {
  const REJECT: Array<[string, string]> = [
    ["--import 空格分隔", `node --import ${DATA} scripts/ok.js`],
    ["--import= 等号形态", `node --import=${DATA} scripts/ok.js`],
    ["--import 值带双引号", `node --import "${DATA}" scripts/ok.js`],
    ["--import 值带单引号", `node --import '${DATA}' scripts/ok.js`],
    ["scheme 大写（URL scheme 大小写不敏感）", `node --import DATA:text/javascript,0 scripts/ok.js`],
    ["值前导空格（URL 解析会剥掉）", `node --import=" ${DATA}" scripts/ok.js`],
    ["--loader", `node --loader ${DATA} scripts/ok.js`],
    ["--loader=", `node --loader=${DATA} scripts/ok.js`],
    ["--experimental-loader", `node --experimental-loader ${DATA} scripts/ok.js`],
    ["--experimental_loader（下划线，node 同样认）", `node --experimental_loader ${DATA} scripts/ok.js`],
    ["--experimental_loader=", `node --experimental_loader=${DATA} scripts/ok.js`],
    ["--require（CJS 目前不支持 data:，但与 --import 同类，一并拒）", `node --require ${DATA} scripts/ok.js`],
    ["-r", `node -r ${DATA} scripts/ok.js`],
    ["先放行的预加载、后面又跟一个 data:", `node --import ./scripts/pre.mjs --import ${DATA} scripts/ok.js`],
    ["选项排在脚本之后（拿不准归 node 还是脚本，沿用「宁可拒」）", `node scripts/ok.js --import ${DATA}`],
    ["绝对路径的 node", `/usr/bin/node --import ${DATA} scripts/ok.js`],
  ];

  it.each(REJECT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});

describe("B · 既有放行行为不变（不误杀仓内预加载 / 脚本自己的 data: 参数）", () => {
  const ACCEPT: Array<[string, string]> = [
    ["普通脚本", "node scripts/ok.js"],
    ["--import 仓内文件", "node --import ./scripts/pre.mjs scripts/ok.js"],
    ["--import= 仓内文件", "node --import=./scripts/pre.mjs scripts/ok.js"],
    ["--import 包名", "node --import tsx scripts/ok.js"],
    ["-r 仓内文件", "node -r ./scripts/pre.js scripts/ok.js"],
    ["--require= 仓内文件", "node --require=./scripts/pre.js scripts/ok.js"],
    ["--loader 仓内文件", "node --loader ./scripts/hooks.mjs scripts/ok.js"],
    ["--experimental-loader= 仓内文件", "node --experimental-loader=./scripts/hooks.mjs scripts/ok.js"],
    ["脚本自己的参数里有 data: 字样（前一个 token 不是预加载选项）", "node scripts/ok.js data:text/plain,hello"],
    ["预加载 + 脚本参数里有 data:", "node --import ./scripts/pre.mjs scripts/ok.js data:x"],
  ];

  it.each(ACCEPT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });
});

describe("C · 同类开关盘点的对照：原有内联拦截不退化，其它解释器整体不在白名单", () => {
  it.each([
    ["node -e", `node -e 0`],
    ["node --eval", `node --eval 0`],
    ["node --eval=", `node --eval=0`],
    ["node -p", `node -p 0`],
    ["node --print", `node --print 0`],
    ["node -pe 合并短参数", `node -pe 0`],
    ["node -e 与代码粘连", `node -e0`],
    ["node -c（--check，宁可拒）", `node -c scripts/ok.js`],
    ["bash -c", `bash -c 'true'`],
    ["sh -ec 合并短参数", `sh -ec 'true'`],
    ["bash -xc 合并短参数", `bash -xc 'true'`],
  ])("原有拦截：%s", (_desc, cmd) => {
    expect(check(cmd).ok, cmd).toBe(false);
  });

  it.each([
    "python -c 0",
    "python3 -c 0",
    "/usr/bin/python3 -c 0",
    "ruby -e 0",
    "perl -e 0",
    "perl -E 0",
    "php -r 0",
    "lua -e 0",
    "deno eval 0",
    "bun -e 0",
    "tsx -e 0",
    "awk 'BEGIN{}'",
    "sed -e p scripts/ok.js",
    "env node -e 0",
    "xargs echo",
    "npx node -e 0",
    "osascript -e 0",
  ])("非白名单解释器整体拒：%s", (cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, cmd).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});

/**
 * H4-10（第六轮 review）：内联旗标判定原先是一条正则（叫 `SCRIPT_INLINE_FLAG_RE`，现已改成函数 `isInlineCodeFlag`，
 * 由 `INLINE_LONG_FLAG_RE` + `SINGLE_DASH_FLAG_RE` 组成），写的是 `^-[a-zA-Z]*[ecp]` 的「前缀匹配」，
 * 脚本自己的 `-verbose` / `-print` / `-quiet` / `-debug` 这类单横线长参数被当成内联代码拒了
 * （`-ve` / `-p` / `-quie` / `-de` 的前缀都落在 `[ecp]` 上）。
 *
 * 光加行尾锚不够：`-verbose` 恰好以 `e` 结尾，`^-[a-zA-Z]*[ecp]$` 照样命中。真正的内联形态是：
 *   - node：`-e` / `-p` / `-pe`（1~2 个字母；node 没有更长的单横线簇，`-econsole.log(1)` 之类 node 直接报 bad option）；
 *   - bash / sh：`-c` 可以出现在任意长度的合并簇里（`bash -eufxc 'cmd'` 是合法的 5 字母簇、真的会执行 cmd）。
 * 所以规则分两半：含 `c` 的纯字母簇不论多长一律拒；含 e / p（不含 c）的纯字母簇只在 ≤ 3 个字母时当簇拒——
 * 3 而不是 2：比 node 实际的 `-e` / `-p` / `-pe` 多放一档，perl 风格的 `-ne` / `-lpe` 宁可拒（代码里是 `letters.length <= 3`）。
 * 是「含」不是「只含」：`-xe`、`-eu`、`-ver` 也在内，所以 `bash -eu script.sh` 会被误拒（偏严，HANDOFF 已承认）。
 * 更长的是长参数名、放行。带非字母尾巴（`-e0`、`-e"…"` 粘连、`-p3000`）仍按旧口径拒，`=` 之前同样套用纯字母规则。
 */
describe("D · H4-10：脚本自己的单横线长参数不被当成内联代码，真正的内联形态一个不漏", () => {
  it.each([
    ["-verbose", "node scripts/ok.js -verbose"],
    ["-print", "node scripts/ok.js -print"],
    ["-quiet", "node scripts/ok.js -quiet"],
    ["-debug", "node scripts/ok.js -debug"],
    ["-pretty", "node scripts/ok.js -pretty"],
    ["-help（4 个字母，长参数名）", "node scripts/ok.js -help"],
    ["-port", "node scripts/ok.js -port"],
    ["-verbose=true（Go 风格单横线 + 等号）", "node scripts/ok.js -verbose=true"],
    ["-print=json", "node scripts/ok.js -print=json"],
    ["-v / -vv（不含 e c p）", "node scripts/ok.js -v -vv"],
    ["bash 脚本的 -verbose", "bash scripts/ok.sh -verbose"],
    ["前置位置也放行（node 自己的 -v）", "node -v scripts/ok.js"],
    ["两个长参数 + 值", "node scripts/ok.js -verbose -print out.txt"],
    ["双横线长参数本来就放行", "node scripts/ok.js --verbose --print-width 80"],
  ])("放行：%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });

  it.each([
    ["-e 'code'", "node -e 'console.log(1)'"],
    ["-p", "node -p 0"],
    ["-pe", "node -pe 0"],
    ["-ne（perl 风格簇，宁可拒）", "node -ne 0"],
    ["-ep", "node -ep 0"],
    ["-lpe（3 字母簇）", "node -lpe 0"],
    ["--eval", "node --eval 0"],
    ["--eval=", "node --eval=0"],
    ["--print", "node --print 0"],
    ["--print=", "node --print=0"],
    ["-c", "node -c scripts/ok.js"],
    ["-e 与代码粘连", "node -e0"],
    ["-e 与引号代码粘连（引号被 shell 剥掉后是 -erequire(…)）", `node -e"require('fs')"`],
    ["-p 粘连数字", "node -p3000"],
    ["-e=…", "node -e=0"],
    ["bash -c", "bash -c 'true'"],
    ["bash -xc", "bash -xc 'true'"],
    ["bash -cx（c 在前）", "bash -cx 'true'"],
    ["sh -ec", "sh -ec 'true'"],
    ["bash -lc", "bash -lc 'true'"],
    ["bash 5 字母合并簇里夹 c（真实合法写法，不能因簇长就放过）", "bash -eufxc 'true'"],
    ["bash 6 字母合并簇 c 在中间", "bash -euxcvf 'true'"],
    ["选项排在脚本之后（拿不准归谁，宁可拒）", "node scripts/ok.js -e 0"],
    ["脚本之后的合并簇", "bash scripts/ok.sh -xc 'true'"],
    ["pnpm / npm 的 -c 簇一并拒（只放 run|test，不放内联）", "npm test -c 'true'"],
  ])("仍拒：%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});
