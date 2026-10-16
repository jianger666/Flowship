/**
 * L4-01（第八轮 review，实证；潜伏——当前没有调用方传 readOnly: true）：只读 shell 守卫从「黑名单 + 词法判断」改成白名单。
 *
 * 背景：同一条路径连续三轮每轮被找出一类新绕过（预加载 → 带值选项 → 花括号 / 通配 / `=` 形态 / 路径值选项）。
 * 根因是设计：`LOCAL_UNQUOTED_DENY` 是黑名单，没列进去的字符 bash 照样展开（`{` `}` `*` `?` `[` `]` `~`）；
 * 校验按字面做 path.resolve，bash 先展开再执行，两边看到的 argv 不是一回事。
 *
 * 这一轮改成（本文件钉行为；「被接受的输入 bash 不做任何展开」由 readonly-shell-bash-oracle-r8.test.ts 用真 bash 做预言机）：
 *   A. 未加引号的字符只放行 [A-Za-z0-9_@%+=:,./-]（外加分隔用的空格 / tab），其余一律拒；双引号里不许出现 $ ` \（$ 紧跟收尾引号除外）；
 *   B. node / npm / pnpm 的 `--x=y` 形态也走白名单（未知拒、pnpm 的 --config.* 一律拒、--node-options 里的内层选项同样过白名单）；
 *   C. wc / grep / head / tail / cat / ls 只放行布尔旗标 + 数字值，路径值选项（--files0-from / -f / --file / --exclude-from …）拒；
 *   D. 部署发布类脚本名：分隔符加 `:` `/`，加驼峰边界；
 *   E. git branch 只放行列表形态；
 *   F. 既有常见写法仍放行；G. echo 与 ls / pwd / wc 一样走路径钳制（订正一处错误注释）；
 *   H. 任何输入（超长 / 深嵌套 / 畸形）都返回结果、不抛错（原先 2000 个 `{x}` 抛 Maximum call stack size exceeded；
 *      顺带补的两处：引号内超长通配串会让 RegExp 在 `.test` 时抛 SyntaxError、10 万个引号让 pg-exec token 正则二次回溯卡死）。
 *
 * 全程只做纯函数校验（不 spawn、不碰网）；被引用的路径只是字符串、不会被执行。数据目录是假的临时目录，没有任何真实密钥。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ro-r8-"));
const DATA = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA;
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });
await fs.mkdir(path.join(CWD, "sub"), { recursive: true });
await fs.writeFile(path.join(DATA, "config.json"), JSON.stringify({ fake: true }));
await fs.writeFile(path.join(CWD, "hello.txt"), "hello\n");
await fs.writeFile(path.join(CWD, "app.log"), "line1\nline2\n");

const { validateReadonlyShellCommand, __hasPgExecTokenForTest } = await import("@/lib/server/pi-coding-tools");

/** 仓（pg-exec 可信脚本所在）指到工作目录：不依赖真实仓里有没有 scripts/pg-exec.mjs */
const OPTS = { pgExecRepoRoot: CWD };
const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined, OPTS);
const FAKE_CONFIG = path.join(DATA, "config.json");

/** 第三项 = 拒绝文案里应出现的子串（原样匹配）；缺省只要求带「旁路只读」 */
type Row = [desc: string, cmd: string, reasonHas?: string];

const expectRejected = (rows: Row[]) =>
  it.each(rows)("%s", (_desc, cmd, reasonHas) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${JSON.stringify(cmd)} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    if (reasonHas) {
      expect(verdict.reason ?? "", `${cmd} 的拒绝文案应含 ${reasonHas}`).toContain(reasonHas);
    }
  });

const expectAccepted = (rows: Array<[string, string]>) =>
  it.each(rows)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${JSON.stringify(cmd)} → ${verdict.reason ?? ""}`).toBe(true);
  });

describe("A1 · 审查报告里的 7 条字面样例（原先全部 ok:true）", () => {
  expectRejected([
    ["node {-p,1}（展开成 node -p 1：内联代码）", "node {-p,1}", "「{」"],
    ["bash {-c,true}（展开成 bash -c true）", "bash {-c,true}", "「{」"],
    ["cat {..,x}/config.json（展开成 ../config.json x/config.json）", "cat {..,x}/config.json", "「{」"],
    ["ls {~,x}/.ssh（花括号先展开，再展开 ~）", "ls {~,x}/.ssh", "「{」"],
    ["npm run {deploy,test}（展开后含 deploy）", "npm run {deploy,test}", "「{」"],
    ["cat *.json", "cat *.json", "「*」"],
    ["cat ?onfig.json", "cat ?onfig.json", "「?」"],
  ]);
});

describe("A2 · 未加引号的字符白名单：花括号 / 通配 / 波浪线 / 脱字符 / 其它特殊字符一律拒", () => {
  expectRejected([
    ["`{` 单个（不配对 bash 当字面量，但白名单不区分）", "git log a{b", "「{」"],
    ["`}`", "git log a}b", "「}」"],
    ["`*` 在目录名", "ls s*", "「*」"],
    ["`*` 在 grep 的文件参数", "grep x *.log", "「*」"],
    ["`?`", "ls hell?.txt", "「?」"],
    ["`[`", "cat [h]ello.txt", "「[」"],
    ["`]`", "git log a]b", "「]」"],
    ["字符类 [!a]*", "ls [!a]*", "「[」"],
    ["`~` 词首", "cat ~/x", "「~」"],
    ["`~user`", "cat ~root/x", "「~」"],
    ["`~` 在 `=` 之后（真 bash 3.2 实测 `echo a=~` 输出 a=<HOME>）", "echo a=~", "「~」"],
    ["`~` 词中（bash 不展开，但白名单一刀切：要用就加引号）", "git log HEAD~1", "「~」"],
    ["`^`（HEAD^ 同上）", "git show HEAD^", "「^」"],
    ["`!`", "echo hi!", "「!」"],
    ["`#`", "echo hi #x", "「#」"],
    ["`(` `)`", "echo (a)", "「(」"],
    ["`<`", "cat < hello.txt", "「<」"],
    ["`>`", "echo hi > hello.txt", "「>」"],
    ["`;`", "ls ; ls", "「;」"],
    ["`&`", "ls & ls", "「&」"],
    ["`|`", "cat hello.txt | cat", "「|」"],
    ["反斜杠转义", "cat hello\\ .txt", "「\\」"],
    ["`$`", "cat $HOME", "「$」"],
    ["非 ASCII 的未加引号路径（要用请加引号）", "cat 中文.md", "「中」"],
    ["未加引号的 NBSP", "cat hello.txt\u00a0app.log"],
    ["词中换行（bash 的命令分隔符）", "ls\nls"],
    ["末尾的 CR（JS trim 会吞掉、bash 不会：bash 实际参数是 `hello.txt\\r`）", "cat hello.txt\r"],
    ["开头的 NBSP（JS trim 会吞掉、bash 不会：实际命令名是 `\\u00a0ls`）", "\u00a0ls"],
  ]);

  it("拒绝文案告诉模型怎么改（加单引号），并回显出问题的那个字符", () => {
    const verdict = check("cat *.json");
    expect(verdict.reason ?? "").toContain("单引号");
    expect(verdict.reason ?? "").toContain("[A-Za-z0-9_@%+=:,./-]");
  });
});

describe("A3 · 引号内：单引号全是字面量放行；双引号不许 $ ` \\（$ 紧跟收尾引号除外，bash 实测当字面量）", () => {
  expectAccepted([
    ["单引号里的 `*`（字面量）", "cat '*.json'"],
    ["单引号里的 `{}` 与逗号", "ls '{a,b}'"],
    ["单引号里的 `~`（词中，字面量）", "cat 'x~/y'"],
    ["单引号里的 `?` `[` `]`", "ls 'h?llo[1].txt'"],
    ["单引号里的 `$`（字面量；grep 的 pattern 槽不查 $）", "grep 'cost$' app.log"],
    ["单引号里的反斜杠（grep 的转义常用）", "grep 'a\\.b' app.log"],
    ["双引号里的 `*` `{}` `~`（双引号内不做花括号 / 通配 / 波浪线展开）", `git log --grep="a*{b}~c"`],
    ["双引号里的 `$` 紧跟收尾引号（既有行为：`grep \"cost$\"`）", 'grep "cost$" app.log'],
    ["引号与裸字符拼接", `git log --format='%h %s' --since="2 weeks ago"`],
    ["引号里的中文路径（未加引号才拒）", "cat '中文.md'"],
    ["空引号参数", "git log ''"],
    ["git 常见写法：HEAD~1 加引号", "git log 'HEAD~1'"],
    ["git 常见写法：HEAD^ 加引号", "git show 'HEAD^'"],
    ["行尾换行 / 前导换行是模型常带的多余空白（bash 不当 argv）", "\nls\n"],
  ]);

  expectRejected([
    ["双引号里的 $VAR（bash 会展开）", 'git log "$X"', "「$」"],
    ["双引号里的 ${…}", 'git log "${X}"'],
    ["双引号里的 $ 后面还有字符", 'git log "a$b"', "「$」"],
    ["双引号里的反引号", 'git log "`x`"'],
    ["双引号里的反斜杠（bash 只转义 $ ` \" \\ 换行，其余原样保留，校验器却一律吞掉）", 'git log "a\\b"', "「\\」"],
    ["双引号里的 \\\"", 'git log "a\\"b"', "「\\」"],
    ["双引号里 $ 后面不是收尾引号（这里是 `$'`，在双引号内不是 ANSI-C 引用，但保守拒）", `git log "$'"`, "「$」"],
    ["引号里词首的 `~`：既有规则（文件参数以 ~ 开头一律拒，与引号无关）", "cat '~/x'", "相对路径"],
    ["引号未闭合", "git log 'abc", "引号未闭合"],
    ["引号内的控制字符 \\u0001（bash 内部有特殊用途的字节，拿不准就拒）", "git log 'a\u0001b'", "控制字符"],
    ["引号内的 DEL \\u007f", "git log 'a\u007fb'", "控制字符"],
    ["引号内的 CR", "git log 'a\rb'", "控制字符"],
  ]);

  it("单引号里的反引号 / $( 仍拒（沿用既有保守口径：放不放行都不会被执行，这里不放宽）", () => {
    expect(check("echo '`x`'").ok).toBe(false);
    expect(check("echo '$(x)'").ok).toBe(false);
  });
});

describe("B1 · node 的 --x=y 形态走白名单（未知拒；--env-file 的值要钳在工作目录内）", () => {
  expectRejected([
    ["node --env-file=<仓外>（审查报告样例）", "node --env-file=../outside/.env scripts/ok.js", "`--env-file`"],
    ["node --env-file=<绝对仓外>", `node --env-file=${FAKE_CONFIG} scripts/ok.js`, "`--env-file`"],
    ["node --env-file-if-exists=<仓外>", "node --env-file-if-exists=../outside/.env scripts/ok.js", "`--env-file-if-exists`"],
    ["node --env-file= 空值", "node --env-file= scripts/ok.js", "`--env-file`"],
    ["node --inspect=0.0.0.0:9229（审查报告样例：对外开调试端口）", "node --inspect=0.0.0.0:9229 scripts/ok.js", "`--inspect`"],
    ["node --inspect-brk=9229", "node --inspect-brk=9229 scripts/ok.js", "`--inspect-brk`"],
    ["node --redirect-warnings=<文件>（落盘）", "node --redirect-warnings=out.txt scripts/ok.js", "`--redirect-warnings`"],
    ["node --diagnostic-dir=<目录>（落盘）", "node --diagnostic-dir=sub scripts/ok.js", "`--diagnostic-dir`"],
    ["node --cpu-prof-dir=<目录>（落盘）", "node --cpu-prof-dir=sub scripts/ok.js", "`--cpu-prof-dir`"],
    ["node --title=x（未知的等号形态）", "node --title=x scripts/ok.js", "`--title`"],
    ["node --max-old-space-size=abc（值不是数字）", "node --max-old-space-size=abc scripts/ok.js", "`--max-old-space-size`"],
    ["node --stack-trace-limit= 空值", "node --stack-trace-limit= scripts/ok.js", "`--stack-trace-limit`"],
    ["下划线写法同一规则", "node --inspect_brk=9229 scripts/ok.js", "`--inspect_brk`"],
  ]);

  expectAccepted([
    ["--env-file=.env（仓内，既有放行行为）", "node --env-file=.env scripts/ok.js"],
    ["--env-file=sub/.env", "node --env-file=sub/.env scripts/ok.js"],
    ["--conditions=dev", "node --conditions=dev scripts/ok.js"],
    ["--max-old-space-size=4096", "node --max-old-space-size=4096 scripts/ok.js"],
    ["--stack-trace-limit=50", "node --stack-trace-limit=50 scripts/ok.js"],
    ["多个白名单项混用", "node --conditions=dev --no-warnings --stack-trace-limit=50 scripts/ok.js"],
    ["脚本之后是脚本自己的 argv，不受前导白名单约束", "node scripts/ok.js --inspect=0.0.0.0:9229 --env-file=x"],
  ]);
});

describe("B2 · npm / pnpm 的 --x=y 形态走白名单；pnpm 的 --config.* 任意位置都拒；npm 脚本名之后的选项也是 npm 的", () => {
  expectRejected([
    ["pnpm --config.script-shell=（审查报告样例：换执行脚本的 shell）", "pnpm --config.script-shell=./scripts/x.sh run test", "--config.script-shell"],
    ["pnpm --config.node-options=（真 pnpm 10 实测会把值塞进 NODE_OPTIONS）", "pnpm --config.node-options=--no-warnings run test", "--config.node-options"],
    ["pnpm --config.registry=", "pnpm --config.registry=http://example.invalid test", "--config.registry"],
    ["pnpm --config.* 在脚本名之后", "pnpm run test --config.script-shell=./scripts/x.sh", "--config.script-shell"],
    ["pnpm --config.* 在 `--` 之后（拿不准是 pnpm 的还是脚本的，宁可拒）", "pnpm run test -- --config.script-shell=x", "--config.script-shell"],
    ["pnpm --config.x（不带 = ）", "pnpm --config.x run test", "--config.x"],
    ["npm --config.* 同样拒", "npm --config.script-shell=x test", "--config.script-shell"],
    ["--config. 的大小写变体（保守：不区分大小写）", "pnpm --CONFIG.script-shell=x test", "--CONFIG.script-shell"],
    ["npm 前导 --registry=（未知的等号形态）", "npm --registry=http://example.invalid test", "`--registry`"],
    ["npm 前导 --cache=", "npm --cache=../outside test", "`--cache`"],
    ["pnpm 前导 --store-dir=", "pnpm --store-dir=../outside run test", "`--store-dir`"],
    ["pnpm 前导 --use-node-version=", "pnpm --use-node-version=20 run test", "`--use-node-version`"],
    ["动词之后、脚本名之前的未知等号形态", "npm run --registry=http://example.invalid test", "`--registry`"],
    // npm 的选项出现在脚本名之后同样被 npm 解析（真 npm 10.9 实测 `npm run test --foo=bar` → npm_config_foo=bar，不会传给脚本）
    ["npm 脚本名之后的未知等号形态", "npm run test --registry=http://example.invalid", "`--registry`"],
    // 真 npm 10.9 实测：`--node-opt=…` / `--node-o=…`（唯一前缀缩写）会写进 NODE_OPTIONS，exact 名字的预加载检查看不到
    ["npm 脚本名之后的 --node-opt= 缩写（真 npm 实测等价于 --node-options）", "npm run test --node-opt=--import=data:text/javascript,1", "`--node-opt`"],
    ["npm 脚本名之后的 --node-o= 缩写", "npm test --node-o=--require=../evil.js", "`--node-o`"],
    ["npm 脚本名之后的未知布尔旗标", "npm run test --bail", "`--bail`"],
    ["--node-options 里的内层选项也走 node 白名单：--inspect=…", "npm run test --node-options=--inspect=0.0.0.0:9229", "`--inspect`"],
    ["--node-options 里的内层未知布尔旗标", "npm run test --node-options=--inspect", "`--inspect`"],
    ["--node-options 里的内层非选项", "npm run test --node-options=foo", "--node-options"],
    // 空格形态：真 npm 10.9.4 实测下一个 token 整个是值（NODE_OPTIONS 就是它），所以值同样过内层规则
    ["--node-options 空格形态：内层 --inspect=…", `npm test --node-options "--inspect=0.0.0.0:9229"`, "`--inspect`"],
    ["--node-options 空格形态：预加载指到工作目录外", `npm test --node-options "--require ../evil.js"`],
    ["--node-options 空格形态：值不是选项", "npm test --node-options foo", "--node-options"],
    ["--node-options 空格形态：值是 `--`", "npm test --node-options -- foo"],
  ]);

  expectAccepted([
    ["npm --loglevel=silent run test（既有放行行为）", "npm --loglevel=silent run test"],
    ["npm run test --loglevel=silent", "npm run test --loglevel=silent"],
    ["pnpm --filter=foo run test", "pnpm --filter=foo run test"],
    ["pnpm --filter=@scope/pkg test", "pnpm --filter=@scope/pkg test"],
    ["npm run test --node-options=--max-old-space-size=4096（内层白名单项）", "npm run test --node-options=--max-old-space-size=4096"],
    ["npm test --node-options 空格形态（既有放行行为；真 npm 实测值就是下一个 token）", `npm test --node-options "--max-old-space-size=4096"`],
    ["--node-options 空格形态之后接 -- 与脚本参数", `npm run test --node-options "--max-old-space-size=4096" -- --watch`],
    ["npm run test --if-present", "npm run test --if-present"],
    ["npm test --workspaces", "npm test --workspaces"],
    ["`--` 之后是脚本自己的参数，不受 npm 选项白名单约束", "npm run test -- --watch --reporter=dot"],
    ["pnpm 脚本名之后的参数是脚本的（真 pnpm 10 实测会传给脚本，不当 pnpm 选项）", "pnpm run test --watch"],
  ]);
});

describe("C · wc / grep / head / tail / cat / ls：只放行布尔旗标 + 数字值；路径值选项一律拒", () => {
  expectRejected([
    ["wc --files0-from=<数据目录>/config.json（审查报告样例，假数据目录）", `wc --files0-from=${FAKE_CONFIG}`, "`--files0-from`"],
    ["wc --files0-from=<仓内文件>（仓内也拒：选项本身读任意文件列表）", "wc --files0-from=hello.txt", "`--files0-from`"],
    ["grep -f <数据目录>/config.json x file.txt（审查报告样例）", `grep -f ${FAKE_CONFIG} x app.log`, "`-f`"],
    ["grep -f <仓内文件>", "grep -f hello.txt x app.log", "`-f`"],
    ["grep --file=", `grep --file=${FAKE_CONFIG} x app.log`, "`--file`"],
    ["grep --exclude-from=", `grep -r --exclude-from=${FAKE_CONFIG} x .`, "`--exclude-from`"],
    ["grep --include-from=", "grep -r --include-from=hello.txt x .", "`--include-from`"],
    ["grep 合并簇里带 f（-rf）：只指出出问题的那个字母", `grep -rf ${FAKE_CONFIG} x .`, "`-f`"],
    ["grep 粘连值 -fhello.txt：只指出 -f，不回显粘连的值", "grep -fhello.txt x app.log", "`-f`"],
    ["grep -d / -D（带值）", "grep -d recurse x .", "`-d`"],
    ["grep --label=（未知）", "grep --label=x y app.log", "`--label`"],
    ["tail -f（永不退出，且 -f 在别的实现里是带值）", "tail -f app.log", "`-f`"],
    ["tail -F", "tail -F app.log", "`-F`"],
    ["tail --follow", "tail --follow app.log", "`--follow`"],
    ["tail --pid=1（带值）", "tail --pid=1 app.log", "`--pid`"],
    ["head -n 的值不是数字（值是路径）", "head -n ../outside/x hello.txt", "`-n`"],
    ["head -n 缺值", "head -n", "`-n`"],
    ["head --bytes 非数字", "head --bytes=abc hello.txt", "`--bytes`"],
    ["cat 不认识的旗标", "cat -z hello.txt", "`-z`"],
    ["cat --未知长旗标", "cat --files0-from=x hello.txt", "`--files0-from`"],
    ["ls -I（GNU 带值：忽略模式；BSD 里含义不同，两边都不放）", "ls -I x", "`-I`"],
    ["ls --ignore=", "ls --ignore=x", "`--ignore`"],
    ["ls --color=always（长旗标也只认布尔白名单）", "ls --color=always", "`--color`"],
    ["孤立的 `-`（stdin 标记）", "cat - hello.txt", "`-`"],
  ]);

  expectAccepted([
    ["ls", "ls"],
    ["ls -la", "ls -la"],
    ["ls -lah sub", "ls -lah sub"],
    ["ls -R", "ls -R"],
    ["ls --all --human-readable（GNU 长旗标，白名单内）", "ls --all --human-readable"],
    ["cat -n", "cat -n hello.txt"],
    ["cat -- 之后全是操作数", "cat -- hello.txt"],
    ["head -n 5（数字值、空格分隔）", "head -n 5 hello.txt"],
    ["head -n5（粘连）", "head -n5 hello.txt"],
    ["head -5（-NUM 简写）", "head -5 hello.txt"],
    ["head -c 100", "head -c 100 hello.txt"],
    ["head --lines=5", "head --lines=5 hello.txt"],
    ["tail -n 50（既有放行行为）", "tail -n 50 app.log"],
    ["tail -n +2", "tail -n +2 app.log"],
    ["tail -50", "tail -50 app.log"],
    ["wc -l", "wc -l app.log"],
    ["wc -lw", "wc -lw app.log hello.txt"],
    ["wc --lines", "wc --lines app.log"],
    ["grep -rn（既有放行行为）", "grep -rn hello ."],
    ["grep -rnE", "grep -rnE hello ."],
    ["grep -A 3 -B 3", "grep -A 3 -B 3 line app.log"],
    ["grep -C3", "grep -C3 line app.log"],
    ["grep -m 1", "grep -m 1 line app.log"],
    ["grep -e 多个 pattern（值是 pattern，不是文件）", "grep -e line1 -e line2 app.log"],
    ["grep -ie（簇尾的 e 吃下一个 token 当 pattern）", "grep -ie LINE app.log"],
    ["grep -e 的 pattern 以 - 开头", "grep -e -x app.log"],
    ["grep -- 之后第一个是 pattern", "grep -- -x app.log"],
    ["grep --include='*.ts'（glob，不是路径值；既有放行行为）", "grep -rn --include='*.ts' hello ."],
    ["grep --exclude-dir=node_modules", "grep -rn --exclude-dir=node_modules hello ."],
    ["grep 的 pattern 不是文件参数（既有放行行为）", "grep 'cost$' app.log"],
    ["echo 不受旗标白名单约束（-n 照常）", "echo -n hi"],
    ["pwd -P", "pwd -P"],
  ]);

  it("路径操作数仍照旧钳制（旗标白名单不替代路径钳制）", () => {
    for (const cmd of ["cat ../outside.txt", `cat ${FAKE_CONFIG}`, "ls ..", "head -n 5 ../x", "tail -n 5 /etc/hosts", "wc -l ../x", "grep x ../x", "grep -r x .."]) {
      const verdict = check(cmd);
      expect(verdict.ok, cmd).toBe(false);
      expect(verdict.reason ?? "", cmd).toContain("旁路只读");
    }
  });

  it("head / tail / cat 没有文件操作数仍拒（数字值不能被当成文件操作数顶数）", () => {
    for (const cmd of ["head -n 5", "tail -n 50", "cat", "cat -n"]) {
      expect(check(cmd).ok, cmd).toBe(false);
    }
  });

  it("grep 必须带 pattern（-e 给了 pattern 则可以没有操作数）", () => {
    expect(check("grep").ok).toBe(false);
    expect(check("grep -rn").ok).toBe(false);
    expect(check("grep -rn -e hello").ok).toBe(true);
  });

  it("拒绝文案不回显 `=` / 粘连之后的值（那可能是路径）", () => {
    for (const cmd of [
      `wc --files0-from=${FAKE_CONFIG}`,
      `grep --file=${FAKE_CONFIG} x app.log`,
      `grep -f${FAKE_CONFIG} x app.log`,
      `head -n${FAKE_CONFIG} hello.txt`,
    ]) {
      const verdict = check(cmd);
      expect(verdict.ok, cmd).toBe(false);
      expect(verdict.reason ?? "", cmd).not.toContain("config.json");
      expect(verdict.reason ?? "", cmd).not.toContain(DATA);
    }
  });
});

describe("D · 部署发布类脚本名：分隔符加 `:` `/`，加驼峰边界", () => {
  expectRejected([
    ["npm run deploy:prod（审查报告样例）", "npm run deploy:prod", "部署/发布/上线"],
    ["pnpm run release:patch（审查报告样例）", "pnpm run release:patch", "部署/发布/上线"],
    ["npm run deployProd（审查报告样例：驼峰）", "npm run deployProd", "部署/发布/上线"],
    ["冒号在后：test:deploy", "npm run test:deploy", "部署/发布/上线"],
    ["斜杠分隔：ci/publish", "npm run ci/publish", "部署/发布/上线"],
    ["驼峰在后：buildRelease", "pnpm run buildRelease", "部署/发布/上线"],
    ["驼峰中间：autoDeployNow", "npm run autoDeployNow", "部署/发布/上线"],
    ["首字母大写：DeployProd", "npm run DeployProd", "部署/发布/上线"],
    ["全大写：DEPLOY", "npm run DEPLOY", "部署/发布/上线"],
    ["全大写加下划线：RELEASE_NOTES", "npm run RELEASE_NOTES", "部署/发布/上线"],
    ["数字边界：deploy2prod", "npm run deploy2prod", "部署/发布/上线"],
    ["`--` 之后的脚本名", "npm run -- deploy:prod", "部署/发布/上线"],
    ["node 脚本文件名带驼峰", "node scripts/deployProd.js", "部署/发布/上线"],
    ["bash 脚本文件名带冒号", "bash scripts/release:patch.sh", "部署/发布/上线"],
    ["脚本名含空格的发版关键字（引号里）", "npm run 'deploy prod'", "部署/发布/上线"],
    ["中文：发版（引号里）", "npm run '发版'", "部署/发布/上线"],
    ["中文：上线（引号里）", "npm run '上线脚本'", "部署/发布/上线"],
    ["既有：deploy", "npm run deploy", "部署/发布/上线"],
    ["既有：release-notes", "npm run release-notes", "部署/发布/上线"],
    ["既有：scripts/deploy.sh", "bash scripts/deploy.sh", "部署/发布/上线"],
    ["既有：publish.js", "node scripts/publish.js", "部署/发布/上线"],
  ]);

  expectAccepted([
    ["test:unit", "npm run test:unit"],
    ["lint:fix", "pnpm run lint:fix"],
    ["build:dev", "npm run build:dev"],
    ["productList（prod 只是前缀，不是单词）", "npm run productList"],
    ["product-list（既有）", "npm run product-list"],
    ["reproduce", "npm run reproduce"],
    ["preprod（既有：整词才算）", "npm run preprod"],
    ["onlinestatus（既有：整词才算）", "npm run onlinestatus"],
    ["node scripts/productList.js", "node scripts/productList.js"],
    ["node scripts/check.js", "node scripts/check.js"],
  ]);
});

describe("E · git branch 只放行列表形态（会改 ref 的写形态一律拒）", () => {
  expectRejected([
    ["git branch -D x（审查报告样例）", "git branch -D x", "git branch"],
    ["git branch newbranch（创建分支，审查报告样例）", "git branch newbranch", "git branch"],
    ["git branch -d x", "git branch -d x", "git branch"],
    ["git branch --delete x", "git branch --delete x", "git branch"],
    ["git branch --del x（长选项缩写）", "git branch --del x", "git branch"],
    ["git branch -m a b（改名）", "git branch -m a b", "git branch"],
    ["git branch -M a b", "git branch -M a b", "git branch"],
    ["git branch -c a b（复制）", "git branch -c a b", "git branch"],
    ["git branch -f x HEAD", "git branch -f x HEAD", "git branch"],
    ["git branch -u origin/main（改 upstream）", "git branch -u origin/main", "git branch"],
    ["git branch --set-upstream-to=origin/main", "git branch --set-upstream-to=origin/main", "git branch"],
    ["git branch --unset-upstream", "git branch --unset-upstream", "git branch"],
    ["git branch --edit-description", "git branch --edit-description", "git branch"],
    ["git branch --track x origin/x", "git branch --track x origin/x", "git branch"],
    ["git branch -l x（旧版里是创建 reflog 的创建形态）", "git branch -l x", "git branch"],
    ["合并簇里带 D：-avD", "git branch -avD x", "git branch"],
    // 真 git 2.42 实测：`git branch -v nb1` / `-vv` / `--verbose` 后跟名字会创建分支，`-a` / `-r` 后跟名字是 fatal，
    // 所以「带 -v 的名字」不能当 pattern 放行，只有 --list / --contains 才把后面的名字变成 pattern
    ["git branch -v newbranch（真 git 实测会创建）", "git branch -v newbranch", "git branch"],
    ["git branch -vv newbranch", "git branch -vv newbranch", "git branch"],
    ["git branch --verbose newbranch", "git branch --verbose newbranch", "git branch"],
    ["git branch -a newbranch（真 git 实测 fatal，但不靠它兜底）", "git branch -a newbranch", "git branch"],
    ["git branch --show-current newbranch", "git branch --show-current newbranch", "git branch"],
    ["`--` 之后的名字", "git branch -- newbranch", "git branch"],
    ["--list 后面夹写旗标", "git branch --list -D x", "git branch"],
    ["前面带全局选项也一样拒", "git --no-pager branch -D x", "git branch"],
    ["带值的未知选项 --contains 以外的 --merged", "git branch --merged HEAD", "git branch"],
  ]);

  expectAccepted([
    ["git branch（列出）", "git branch"],
    ["git branch -a（既有放行行为）", "git branch -a"],
    ["git branch -r", "git branch -r"],
    ["git branch -v", "git branch -v"],
    ["git branch -vv", "git branch -vv"],
    ["git branch -av", "git branch -av"],
    ["git branch --all / --remotes / --verbose", "git branch --all --remotes --verbose"],
    ["git branch --show-current", "git branch --show-current"],
    ["git branch --list", "git branch --list"],
    ["git branch --list 'feat/*'（pattern 加引号）", "git branch --list 'feat/*'"],
    ["git branch -r --list 'origin/*'", "git branch -r --list 'origin/*'"],
    ["git branch --contains HEAD", "git branch --contains HEAD"],
    ["git branch -a --contains abc123", "git branch -a --contains abc123"],
    ["git branch --contains=abc123", "git branch --contains=abc123"],
    ["git --no-pager branch -a", "git --no-pager branch -a"],
    ["别的只读动词不受影响：git log --oneline -5", "git log --oneline -5"],
    ["git diff main...HEAD --stat（既有放行行为）", "git diff main...HEAD --stat"],
    ["git status --short", "git status --short"],
  ]);
});

describe("F · 既有常见写法仍放行（改白名单没有放松 / 误杀）", () => {
  expectAccepted([
    ["npm test", "npm test"],
    ["pnpm run test", "pnpm run test"],
    ["npm run test -- --watch", "npm run test -- --watch"],
    ["pnpm -r test", "pnpm -r test"],
    ["node scripts/ok.js --flag", "node scripts/ok.js --flag"],
    ["bash scripts/ok.sh arg", "bash scripts/ok.sh arg"],
    ["node ./scripts/check.js --env test", "node ./scripts/check.js --env test"],
    ["绝对路径的 node", "/usr/bin/node scripts/ok.js"],
    ["echo hi", "echo hi"],
    ["pwd", "pwd"],
  ]);
});

describe("G · echo 与 ls / pwd / wc 一样走路径钳制（订正 pi-coding-tools 里「echo 不走这里」的错误注释）", () => {
  it("echo 的非旗标参数同样做路径钳制：越界拒", () => {
    const verdict = check("echo ../../outside");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason ?? "").toContain("越界");
  });

  it("echo 的参数里出现 $ 同样拒（引号包着也一样）；grep 的 pattern 槽是唯一豁免", () => {
    const echoed = check("echo 'cost$'");
    expect(echoed.ok).toBe(false);
    expect(echoed.reason ?? "").toContain("文件参数里不允许");
    expect(check("grep 'cost$' app.log").ok).toBe(true);
  });

  it("echo 指到凭据文件名同样拒", () => {
    expect(check(`echo ${FAKE_CONFIG}`).ok).toBe(false);
  });
});

describe("H · 任何输入（超长 / 深嵌套）都返回结果、不抛错", () => {
  const verdictOf = (cmd: string) => {
    let verdict: ReturnType<typeof check> | undefined;
    expect(() => {
      verdict = check(cmd);
    }, `命令长度 ${cmd.length}`).not.toThrow();
    expect(typeof verdict?.ok).toBe("boolean");
    return verdict!;
  };

  it("审查报告实证：node 后面接 2000 个 {x}（原先抛 Maximum call stack size exceeded）", () => {
    const verdict = verdictOf(`node ${"{x}".repeat(2000)}`);
    expect(verdict.ok).toBe(false);
  });

  it("深嵌套花括号 / 超长未加引号输入：一律 ok:false", () => {
    for (const cmd of [
      `node ${"{a,".repeat(5000)}b${"}".repeat(5000)}`,
      `node ${"{".repeat(100_000)}`,
      `node scripts/ok.js ${"{x}".repeat(50_000)}`,
      `cat ${"*".repeat(100_000)}`,
      `echo ${"~".repeat(100_000)}`,
      `echo ${"[".repeat(100_000)}`,
      `git log ${"$(".repeat(30_000)}`,
    ]) {
      expect(verdictOf(cmd).ok, cmd.slice(0, 30)).toBe(false);
    }
  });

  it("超长 / 深嵌套的引号输入：不抛错（未闭合 → 拒；闭合的字面量 → 返回结果）", () => {
    verdictOf(`echo ${"'".repeat(100_001)}`); // 奇数个单引号 → 未闭合 → 拒
    expect(verdictOf(`echo ${"'".repeat(100_001)}`).ok).toBe(false);
    expect(verdictOf(`echo ${'"'.repeat(100_001)}`).ok).toBe(false);
    verdictOf(`echo ${"'{x}'".repeat(20_000)}`);
    verdictOf(`echo ${`"'"`.repeat(20_000)}`);
    verdictOf(`git log ${"'a b' ".repeat(20_000)}`);
    verdictOf(`cat ${"a/".repeat(50_000)}x`);
    verdictOf(`ls ${"-a ".repeat(30_000)}`);
    verdictOf(`git branch ${"-a ".repeat(30_000)}`);
    verdictOf(`grep ${"-e x ".repeat(20_000)} app.log`);
    verdictOf(`npm run ${"--silent ".repeat(20_000)}test`);
    verdictOf(`node ${"--no-warnings ".repeat(20_000)}scripts/ok.js`);
    verdictOf("x".repeat(1_000_000));
  });

  it("引号里的超长通配串（globBasenameRegex 仍会对它建正则）：返回结果、不抛错", () => {
    verdictOf(`node scripts/ok.js '${"*".repeat(20_000)}'`);
    verdictOf(`node scripts/ok.js '${"[".repeat(20_000)}'`);
    verdictOf(`node scripts/ok.js '${"?*".repeat(10_000)}x'`);
    // 没超过上限的连续 `*`：不合并的话 `.*.*…x$` 在匹配失败时的回溯按高次多项式增长（pg-exec.mjs 含一个 x）
    verdictOf(`node scripts/ok.js '${"*".repeat(900)}x'`);
    verdictOf(`node scripts/ok.js '${"*e".repeat(400)}x*'`);
    verdictOf(`bash '${"{a,".repeat(5_000)}b${"}".repeat(5_000)}'`);
  });

  it("pg-exec token 判定：与原正则（L4-01 之前的实现）随机等价；10 万个引号不再二次回溯", () => {
    // 原实现：只用于这里做对照，不在源码里了
    const ORIGINAL = /(^|\s|["'])((?:\S*\/)?pg-exec\.mjs)(?=[\s"']|$)/;
    // 固定种子的线性同余，保证可复现（不依赖 Math.random）
    let seed = 0x5eed0802;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const pieces = ["pg-exec.mjs", "pg-exec.mj", "xpg-exec.mjs", " ", "\t", "\n", "\u00a0", "'", '"', "/", "a", "-", ".", "scripts/", "node ", "\\", "$"];
    let withToken = 0;
    for (let i = 0; i < 20_000; i++) {
      let s = "";
      for (let k = 1 + rnd(7); k > 0; k--) s += pieces[rnd(pieces.length)];
      const expected = ORIGINAL.test(s);
      if (expected) withToken += 1;
      expect(__hasPgExecTokenForTest(s), JSON.stringify(s)).toBe(expected);
    }
    // 对照样本里两类结果都要有，否则这个等价比对是空的
    expect(withToken).toBeGreaterThan(500);
    expect(withToken).toBeLessThan(19_500);
    // 线性：10 万个引号（原正则在这上面按平方增长）；只断言结果、不断言耗时
    expect(__hasPgExecTokenForTest(`echo ${"'".repeat(100_000)}`)).toBe(false);
    expect(__hasPgExecTokenForTest(`echo ${"'".repeat(100_000)}pg-exec.mjs`)).toBe(true);
  });

  it("带 NUL / 孤立代理项 / 全部特殊字符的畸形输入：不抛错", () => {
    for (const cmd of ["cat \u0000", "cat '\u0000'", "echo \ud800", "echo '\udfff'", "\u0000", "'", '"', "\\", "``", "$(", "{", "}", "{}", "[", "~", "--", "-", "git branch -", "git branch --"]) {
      verdictOf(cmd);
    }
    // 非字符串 / 空串不抛
    expect(validateReadonlyShellCommand(CWD, undefined, undefined, undefined, OPTS).ok).toBe(false);
    expect(validateReadonlyShellCommand(CWD, 123, undefined, undefined, OPTS).ok).toBe(false);
    expect(validateReadonlyShellCommand(CWD, "   ", undefined, undefined, OPTS).ok).toBe(false);
  });
});
