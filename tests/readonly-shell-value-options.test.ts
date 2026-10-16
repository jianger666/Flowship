/**
 * K4-01（潜伏，第七轮 review，实证）：旁路只读 shell 里「带值但不是预加载的选项」会让真脚本逃过全部检查，方向是放行。
 *
 * 机制：`checkBypassRunScript` 取「第一个不以 `-` 开头的 token」当脚本 / 子命令。带值选项（空格分隔）的**值**不以 `-` 开头，
 * 于是值被当成脚本：它落在工作目录里就通过钳制，真正被执行的脚本（下一个 token）成了没人看的普通参数。
 *   bash -o pipefail ../outside/ok.sh        → 脚本被判成 `pipefail`
 *   node --conditions dev ../outside/evil.js → 脚本被判成 `dev`
 *   npm test --prefix ../outside             → `--prefix` 换了 package 根目录，跑的是仓外的 package.json
 *   pnpm --dir=../outside run test           → 同上（等号形态以 `-` 开头、整体被跳过）
 * 同一类的另几条（本测试一并钉住，真 bash 5 / npm 10 / pnpm 10 / node 22 在临时目录里实测过）：
 *   bash +o pipefail x.sh / bash -xo pipefail x.sh：`+o`、含 `o` 的合并簇同样吃掉下一个参数；
 *   npm --loglevel test run deploy / pnpm --reporter test run deploy：`test` 被当成动词，真正跑的是 `deploy`（发版脚本名检查被绕开）；
 *   npm --prefi=<dir>：npm 的 nopt 接受唯一前缀缩写，字面名黑名单拦不住（pnpm 不缩写）；
 *   node --run=deploy：等号形态也能跑 package.json 里的脚本，同样绕开发版脚本名检查。
 * 当前没有调用方传 readOnly: true，所以是潜伏的；趁没人接线先补（接线之前必须先修）。
 *
 * 钉三件事：
 *   A. 报告里的 6 条反例 + 上面补出来的同类写法，一律拒（保守拒绝：拿不准「这个 token 是不是某个选项的值」就拒，
 *      选项后面紧跟仓内合法脚本也拒——校验层不认识这个选项，就无从确认哪个操作数是脚本）；
 *   B. 既有放行行为不变：不带选项 / 只带白名单布尔旗标 / `--xxx=值` 形态 / 脚本自己的参数，照常放行；
 *   C. 脚本之后的 token 是脚本自己的 argv，不受「前导选项」规则约束（沿用既有口径）。
 *
 * 全程只做纯函数校验（不 spawn、不碰网）；被引用的仓外路径只是字符串、不会被执行。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-value-options-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });

const { validateReadonlyShellCommand } = await import("@/lib/server/pi-coding-tools");

const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined);

/** 仓外路径（只是字符串，不会被执行） */
const OUT_ABS = path.join(TMP_ROOT, "outside", "evil.js");

/** 第三项 = 拒绝文案里应点名的前导选项（文案里写成 `选项`）；「越界」是路径钳制那条文案，原样匹配 */
type Row = [desc: string, cmd: string, reasonHas?: string];

const expectRejected = (rows: Row[]) =>
  it.each(rows)("%s", (_desc, cmd, reasonHas) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    if (reasonHas) {
      const needle = reasonHas === "越界" ? reasonHas : `\`${reasonHas}\``;
      expect(verdict.reason ?? "", `${cmd} 的拒绝文案应点名 ${needle}`).toContain(needle);
    }
  });

const expectAccepted = (rows: Array<[string, string]>) =>
  it.each(rows)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });

describe("A1 · 报告里的 6 条反例（原先全部 ok:true，方向是放行）", () => {
  expectRejected([
    ["bash -o pipefail + 仓外脚本", "bash -o pipefail ../outside/ok.sh", "-o"],
    ["bash -o pipefail + 发版脚本名（deploy 检查被绕开）", "bash -o pipefail scripts/deploy.sh", "-o"],
    ["node --conditions dev + 仓外脚本", "node --conditions dev ../outside/evil.js", "--conditions"],
    ["node --env-file .env + 仓外脚本", "node --env-file .env ../outside/evil.js", "--env-file"],
    ["npm test --prefix ../outside", "npm test --prefix ../outside", "--prefix"],
    ["pnpm --dir=../outside run test", "pnpm --dir=../outside run test", "--dir"],
  ]);

  it("对照：不带选项的仓外脚本本来就拒（保证上面的拒绝不是被别的原因顶替）", () => {
    expect(check("bash ../outside/ok.sh").ok).toBe(false);
    expect(check("node ../outside/evil.js").ok).toBe(false);
    expect(check(`node ${OUT_ABS}`).ok).toBe(false);
  });
});

describe("A2 · bash / sh：带值选项整体拒（-o / -O / --rcfile / --init-file，含 + 形态与合并簇）", () => {
  expectRejected([
    ["-o 之后紧跟仓内合法脚本（保守拒绝：不认识 -o 的值，就无从确认哪个是脚本）", "bash -o pipefail scripts/ok.sh", "-o"],
    ["-O extglob + 仓外脚本", "bash -O extglob ../outside/ok.sh", "-O"],
    ["sh -o + 仓外脚本", "sh -o pipefail ../outside/ok.sh", "-o"],
    ["sh -o + 仓内脚本", "sh -o pipefail scripts/ok.sh", "-o"],
    ["+o（unset 形态，同样吃掉下一个参数；真 bash 实测 `bash +o pipefail b.sh` 跑的是 b.sh）", "bash +o pipefail ../outside/ok.sh", "+o"],
    ["+o + 仓内脚本", "bash +o pipefail scripts/ok.sh", "+o"],
    ["合并簇 -xo（o 收尾的簇同样带值；不含 e / c / p，原先的内联检查拦不到）", "bash -xo pipefail ../outside/ok.sh", "-xo"],
    ["合并簇 -xO", "bash -xO extglob ../outside/ok.sh", "-xO"],
    ["--rcfile 空格形态 + 仓外脚本", "bash --rcfile scripts/rc.sh ../outside/ok.sh", "--rcfile"],
    ["--rcfile 空格形态 + 仓内脚本", "bash --rcfile scripts/rc.sh scripts/ok.sh", "--rcfile"],
    ["--rcfile= 等号形态（真 bash 报 invalid option，但不靠它兜底）", "bash --rcfile=scripts/rc.sh scripts/ok.sh", "--rcfile"],
    ["--init-file 空格形态", "bash --init-file scripts/rc.sh scripts/ok.sh", "--init-file"],
    ["--init-file= 等号形态", "bash --init-file=scripts/rc.sh scripts/ok.sh", "--init-file"],
    ["+x（unset 形态一律拒：没有「跑脚本文件」的合法用途）", "bash +x scripts/ok.sh", "+x"],
    ["孤立的 -（bash 里等于 `--`，之后的才是脚本；不认识的前导 token 一律拒）", "bash - scripts/ok.sh", "-"],
    ["不认识的长选项", "bash --some-future-flag scripts/ok.sh", "--some-future-flag"],
    ["数字 / 带 = 的单横线形态", "bash -1 scripts/ok.sh", "-1"],
  ]);
});

/**
 * A3 按「独立分支」覆盖（第八轮测试质量项）：原先是 2 个 bin × 8 个选项 × 7 种写法位置 = 112 行的笛卡尔积，
 * 可是校验里真正独立的判定只有下面这几条——选项名表里每一项（`PKG_DENIED_LONG_FLAGS` 的 6 个名字）、短选项字符 `C` / `w` 各一条、
 * `=` 值写法（长 / 短各一条）、「全部 token 扫一遍而不是只看前导位置」（按位置分）、仓内目标也拒（不核实目标）。
 * 每个分支各取一行，bin 只有 npm / pnpm 两个、两边各跑一遍（两边走同一个判定函数，这里按 bin 各验一次是为了钉住「两个 bin 都接了这道门」）。
 * 条数：6×2 + 2×2 + 2×2 + 4×2 + 1×2 = 30 行；下面接着的缩写 / 合并簇 / 下划线 8 行不变，A3 合计 38 行（原先 112 + 8 = 120 行）。
 * pnpm 的 `--config.<键>` 前缀整类拒是 `isDeniedPkgOption` 里的另一条独立分支，行在 readonly-shell-whitelist-r8.test.ts 的 B 组。
 */
describe("A3 · npm / pnpm：换目录 / 换配置 / 换 shell 的选项，空格 / 等号 / 缩写 / 任意位置都拒", () => {
  // 选项名表（长）：每个名字一行，空格写法、仓外目标。真 npm 10 里 --globalconfig 换配置、--script-shell 换执行脚本的 shell
  const LONG_NAMES = ["--prefix", "--dir", "--workspace", "--userconfig", "--globalconfig", "--script-shell"];
  // 短选项：-C（pnpm 的 --dir 短写）、-w（--workspace 短写），各一条字符分支
  const SHORT_NAMES = ["-C", "-w"];
  for (const bin of ["npm", "pnpm"]) {
    describe(bin, () => {
      const rows: Row[] = [];
      for (const opt of LONG_NAMES) rows.push([`长选项名 ${opt}（空格 · 仓外）`, `${bin} test ${opt} ../outside`, opt]);
      for (const opt of SHORT_NAMES) rows.push([`短选项 ${opt}（空格 · 仓外）`, `${bin} test ${opt} ../outside`, opt]);
      // `=` 值写法：长选项（名字取 `=` 之前）与短选项（`-C=值`）是两条不同的判定
      rows.push(["`=` 写法 · 长选项 --dir=", `${bin} test --dir=../outside`, "--dir"]);
      rows.push(["`=` 写法 · 短选项 -C=", `${bin} test -C=../outside`, "-C"]);
      // 位置：禁用选项在所有 token 里扫，不限前导位置，也不在 `--` 处停（拿不准是 npm 的还是脚本的，宁可拒）
      rows.push(["位置 · 动词之前", `${bin} --prefix ../outside run test`, "--prefix"]);
      rows.push(["位置 · 动词与脚本名之间", `${bin} run --prefix ../outside test`, "--prefix"]);
      rows.push(["位置 · 脚本名之后", `${bin} run test --prefix ../outside`, "--prefix"]);
      rows.push(["位置 · `--` 之后", `${bin} run test -- --prefix ../outside`, "--prefix"]);
      // 目标在仓内也拒：不核实目标，名字一命中就拒
      rows.push(["仓内目标也拒", `${bin} test --prefix ./sub`, "--prefix"]);
      expectRejected(rows);
    });
  }

  expectRejected([
    ["npm 唯一前缀缩写 --prefi=（nopt 接受缩写，真 npm 10 实测等价于 --prefix）", "npm test --prefi=../outside", "--prefi"],
    ["npm 缩写 --pre", "npm test --pre ../outside", "--pre"],
    ["npm 缩写 --workspac", "npm test --workspac=pkg", "--workspac"],
    ["npm 缩写 --userconf", "npm run test --userconf ../x.npmrc", "--userconf"],
    ["npm 缩写 --script-s", "npm run test --script-s=/tmp/evil-shell", "--script-s"],
    ["短选项合并簇里带 w（-sw = -s -w，w 吃下一个参数）", "npm test -sw ../outside", "-sw"],
    ["短选项合并簇里带 C（放在脚本名之后：前导白名单管不到，只有这条黑名单能拦）", "pnpm run test -rC ../outside", "-rC"],
    ["下划线写法（npm 的配置名 _ 与 - 等价）", "npm test --script_shell=/tmp/evil-shell", "--script_shell"],
  ]);
});

describe("A4 · npm / pnpm：动词与脚本名之前的未知「选项 + 值」（值被当成动词 / 脚本名，发版脚本名检查被绕开）", () => {
  expectRejected([
    ["npm --loglevel test run deploy（真 npm 10 实测跑的是 deploy 脚本，校验原先把 test 当动词放行）", "npm --loglevel test run deploy", "--loglevel"],
    ["pnpm --reporter test run deploy（真 pnpm 10 实测同样）", "pnpm --reporter test run deploy", "--reporter"],
    ["npm --registry test run release", "npm --registry test run release", "--registry"],
    ["动词之后、脚本名之前的未知选项 + 值：npm run --loglevel x deploy", "npm run --loglevel x deploy", "--loglevel"],
    ["pnpm run --reporter x release", "pnpm run --reporter x release", "--reporter"],
    ["短选项 + 值：pnpm -F foo run test（-F 空格带值，不在布尔白名单）", "pnpm -F foo run test", "-F"],
  ]);
});

describe("A5 · node：除白名单布尔旗标外，其余 --xxx 必须是 =值 形态（空格分隔的带值选项一律拒）", () => {
  expectRejected([
    ["--conditions 空格 + 仓内脚本（保守拒绝）", "node --conditions dev scripts/ok.js", "--conditions"],
    ["-C 空格（--conditions 的短写）", "node -C dev scripts/ok.js", "-C"],
    ["--env-file 空格 + 仓内脚本", "node --env-file .env scripts/ok.js", "--env-file"],
    ["--max-old-space-size 空格", "node --max-old-space-size 4096 scripts/ok.js", "--max-old-space-size"],
    ["--stack-trace-limit 空格 + 仓外脚本", "node --stack-trace-limit 50 ../outside/evil.js", "--stack-trace-limit"],
    ["--input-type 空格", "node --input-type module scripts/ok.js", "--input-type"],
    ["--run 空格（node 22 的 --run 跑 package.json 里的脚本，绕开发版脚本名检查）", "node --run deploy", "--run"],
    ["--run= 等号形态也拒（真 node 22 实测 `node --run=deploy` 同样执行 deploy 脚本）", "node --run=deploy scripts/ok.js", "--run"],
    ["--experimental-config-file= 换配置文件", "node --experimental-config-file=../outside/node.json scripts/ok.js", "--experimental-config-file"],
    ["下划线写法的 --run_x 之类走同一规则（node 把 _ 当 -）：未知旗标", "node --some_future_flag scripts/ok.js", "--some_future_flag"],
    ["不在白名单的布尔旗标（--inspect 会监听调试端口，不放）", "node --inspect scripts/ok.js", "--inspect"],
    ["孤立的 -（node 从 stdin 读脚本）", "node - ../outside/evil.js", "-"],
    ["单横线不认识的（-i REPL）", "node -i scripts/ok.js", "-i"],
    ["带值选项排在预加载之后、脚本之前", "node -r ./scripts/pre.js --conditions dev scripts/ok.js", "--conditions"],
    ["等号形态 + 仓外脚本：脚本照样要钳制", "node --conditions=dev ../outside/evil.js", "越界"],
    ["`--` 之后的第一个操作数是脚本：仓外照拒", "node -- ../outside/evil.js", "越界"],
  ]);
});

describe("B · 既有放行行为不变", () => {
  expectAccepted([
    ["node 不带选项", "node scripts/ok.js"],
    ["node 布尔旗标 --test", "node --test scripts/ok.test.js"],
    ["node --enable-source-maps", "node --enable-source-maps scripts/ok.js"],
    ["node --no-warnings（--no- 是布尔取反）", "node --no-warnings scripts/ok.js"],
    ["node 下划线写法的布尔旗标", "node --enable_source_maps scripts/ok.js"],
    ["node -v（前置位置放行，既有行为）", "node -v scripts/ok.js"],
    ["node --xxx=值 形态", "node --conditions=dev scripts/ok.js"],
    ["node --env-file=.env 等号形态", "node --env-file=.env scripts/ok.js"],
    ["node --max-old-space-size=4096", "node --max-old-space-size=4096 scripts/ok.js"],
    ["node 多个 =值 / 布尔旗标混用", "node --conditions=dev --no-warnings --stack-trace-limit=50 scripts/ok.js"],
    ["node `--` 之后的仓内脚本", "node -- scripts/ok.js"],
    ["node 预加载（空格 / 等号）照常放行", "node -r ./scripts/pre.js --import=./scripts/pre.mjs scripts/ok.js"],
    ["node 预加载 + --test-reporter", "node --test --test-reporter spec scripts/ok.test.js"],
    ["bash 不带选项", "bash scripts/ok.sh"],
    ["bash -r（restricted）", "bash -r scripts/ok.sh"],
    ["bash -x 这类不带值的簇", "bash -x scripts/ok.sh"],
    ["bash -uv 这类不带值的簇", "bash -uv scripts/ok.sh"],
    ["bash 长布尔旗标 --norc / --noprofile / --posix", "bash --norc --noprofile --posix scripts/ok.sh"],
    ["bash `--` 之后的仓内脚本", "bash -- scripts/ok.sh"],
    ["sh 不带选项", "sh scripts/ok.sh"],
    ["绝对路径的 node / bash", "/usr/bin/node scripts/ok.js"],
    ["npm test", "npm test"],
    ["npm run test", "npm run test"],
    ["npm --silent run test", "npm --silent run test"],
    ["npm run --silent test", "npm run --silent test"],
    ["npm --loglevel=silent run test（等号形态）", "npm --loglevel=silent run test"],
    ["npm run test --loglevel=silent", "npm run test --loglevel=silent"],
    ["npm run test --if-present", "npm run test --if-present"],
    ["npm test --workspaces（复数：仓内全部 workspace，不是 --workspace）", "npm test --workspaces"],
    ["pnpm -r run test", "pnpm -r run test"],
    ["pnpm -r test", "pnpm -r test"],
    ["pnpm --filter=foo run test（等号形态）", "pnpm --filter=foo run test"],
    ["pnpm run check", "pnpm run check"],
    ["npm run test --node-options=--max-old-space-size=4096", "npm run test --node-options=--max-old-space-size=4096"],
  ]);
});

describe("C · 脚本之后的 token 是脚本自己的 argv，不受前导选项规则约束", () => {
  expectAccepted([
    ["node 脚本自己的 --conditions dev（空格）", "node scripts/ok.js --conditions dev"],
    ["node 脚本自己的 --env-file .env", "node scripts/ok.js --env-file .env --port 3000"],
    ["node 脚本自己的 --run deploy（argv，不是 node 的选项）", "node scripts/ok.js --run deploy"],
    ["bash 脚本自己的 -o out.txt", "bash scripts/ok.sh -o out.txt"],
    ["bash 脚本自己的 --rcfile x", "bash scripts/ok.sh --rcfile x"],
    ["bash 脚本自己的 -O 值", "bash scripts/ok.sh -O value"],
    ["npm 脚本名之后 `--` 里的脚本参数（不含被禁选项）", "npm run test -- --reporter dot --bail"],
    ["pnpm 脚本名之后 `--` 里的脚本参数", "pnpm run test -- --watch false"],
  ]);
});
