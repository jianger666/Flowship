/**
 * D1 冒烟套件（scripts/browser-e2e/smoke-suite.cjs）的静态契约测试：不起 Electron，只读脚本源码。
 * 目的：套件被后人改动时，「流程数 / 每流程带安全断言 / 开关复位 / 默认不碰外网 / 不直接起 Electron 二进制」这些底线不会悄悄丢。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.resolve(__dirname, "../scripts/browser-e2e/smoke-suite.cjs"), "utf8");

/** 切出 `flow("名字", async (c) => {...});` 的名字与函数体（以下一个顶层 `flow(` / REAL_FLOWS 注释为界） */
const FLOW_RE = /^flow\("([^"]+)"/gm;
const flows = (() => {
  const marks = [...SRC.matchAll(FLOW_RE)].map((m) => ({ name: m[1], start: m.index ?? 0 }));
  const endOfAll = SRC.indexOf("// ═══════════════════════ 可选：真实外网站点");
  return marks.map((m, i) => ({ name: m.name, body: SRC.slice(m.start, i + 1 < marks.length ? marks[i + 1].start : endOfAll) }));
})();

/** 默认路径 = REAL_FLOWS 之前的全部源码（含 helper 与 24 个流程） */
const DEFAULT_PATH_SRC = SRC.slice(0, SRC.indexOf("const REAL_FLOWS = ["));

describe("browser smoke suite（静态契约）", () => {
  it("流程数 ≥ 18，名字互不重复", () => {
    expect(flows.length).toBeGreaterThanOrEqual(18);
    expect(new Set(flows.map((f) => f.name)).size).toBe(flows.length);
  });

  it("每个流程名都有 [sec] 标注（perf / debug / record 三个「有则做」流程除外）", () => {
    const missing = flows.filter((f) => !/\[sec\]/.test(f.name) && !/\((perf|debug|record)\)/.test(f.name)).map((f) => f.name);
    expect(missing).toEqual([]);
  });

  it("每个带 [sec] 的流程体里真的有一条以 [sec] 开头的断言，或名字对应的红线用 noLeak 检查", () => {
    const weak = flows
      .filter((f) => /\[sec\]/.test(f.name))
      .filter((f) => !/c\.(check|known)\("(\[sec\]|红线)/.test(f.body) && !/c\.noLeak\(/.test(f.body) && !/c\.check\("\[sec\]/.test(f.body))
      .map((f) => f.name);
    expect(weak).toEqual([]);
  });

  it("流程体保持短（≤ 60 行，流程是『冒烟』不是回归）", () => {
    const long = flows.filter((f) => f.body.split("\n").length > 60).map((f) => f.name);
    expect(long).toEqual([]);
  });

  it("SMOKE_REAL_SITES 默认关：只有环境变量显式为 1 才开，真实站点只出现在 REAL_FLOWS 里", () => {
    expect(SRC).toMatch(/process\.env\.SMOKE_REAL_SITES === "1"/);
    expect(SRC).toMatch(/if \(REAL_SITES\) for/);
    // 默认路径（REAL_FLOWS 之前）不允许出现任何外网 https 地址（本机 https 夹具是 `${tls.base}` 拼出来的）
    expect(DEFAULT_PATH_SRC).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|\$\{|localhost|x["'/]|[a-z0-9]+\.localhost)[a-z0-9.-]+\.[a-z]{2,}/i);
    // 真实站点不计入总数
    expect(SRC).toMatch(/counted: false|, false\)\)/);
  });

  it("不直接起 Electron 二进制 / 不 spawn electron；只经 run.mjs 启动，退出只用 app.exit", () => {
    expect(SRC).not.toMatch(/spawn\([^)]*electron/i);
    expect(SRC).not.toMatch(/exec(File)?(Sync)?\([^)]*electron/i);
    expect(SRC).not.toMatch(/process\.exit\(/);
    expect(SRC).toMatch(/app\.exit\(/);
    expect(SRC).toMatch(/run\.mjs scripts\/browser-e2e\/smoke-suite\.cjs/);
    // 唯一允许的外部命令是 openssl 生成本机自签名证书
    const execs = [...SRC.matchAll(/execFileSync\("([^"]+)"/g)].map((m) => m[1]);
    expect(execs.every((e) => e === "openssl")).toBe(true);
  });

  it("不碰 Flowship / FlowshipTest 与 8676 / 8776 / 8876 端口，夹具只监听 127.0.0.1 随机端口", () => {
    expect(SRC).not.toMatch(/\b8[678]76\b/);
    expect(SRC).not.toMatch(/Application Support\/Flowship/);
    expect(SRC).toMatch(/listen\(0, "127\.0\.0\.1"/);
    expect(SRC).not.toMatch(/listen\([^0)]/);
  });

  it("开关复位：runner 在 finally 里把配置复位为 DEFAULT_CFG 并 close_session；临时 userData", () => {
    expect(SRC).toMatch(/finally \{[\s\S]*manager\.onConfig\(DEFAULT_CFG\)[\s\S]*close_session/);
    expect(SRC).toMatch(/app\.setPath\("userData", USERDATA\)/);
    expect(SRC).toMatch(/mkdtempSync\(path\.join\(os\.tmpdir\(\)/);
    expect(SRC).toMatch(/show: false/);
  });

  it("一个流程失败不中断其它流程，且有 FAIL 时退出码非 0；总表格式固定", () => {
    expect(SRC).toMatch(/SMOKE SUMMARY \$\{passed\}\/\$\{counted\.length\} passed/);
    expect(SRC).toMatch(/`FLOW \$\{r\.idx\} \$\{r\.name\}/);
    expect(SRC).toMatch(/SKIP\(\$\{r\.reason\}\)/);
    expect(SRC).toMatch(/app\.exit\(failed === 0 \? 0 : 1\)/);
    // 单个流程的异常被 try/catch 吞成 FAIL，不向上抛
    expect(SRC).toMatch(/catch \(e\) \{\s*if \(e instanceof SkipFlow\)/);
  });

  it("对未注册能力 SKIP(TODO-E2:…)，而不是失败", () => {
    expect(SRC).toMatch(/TODO-E2:op \$\{op\} 未注册/);
    for (const op of ["perf", "debug", "record"]) expect(SRC).toContain(`c.needOp("${op}")`);
  });

  it("夹具 helper 齐全：startHttp / startHttps / ctx.call / ctx.tryCall / waitFor", () => {
    for (const name of ["const startHttp", "const startHttps", "call: async", "tryCall: async", "const waitFor"]) expect(SRC).toContain(name);
  });

  it("已知缺陷 KNOWN 只通过 c.known 登记（不得用放宽 c.check 的方式）", () => {
    const knownCount = [...SRC.matchAll(/c\.known\(/g)].length;
    expect(knownCount).toBeLessThanOrEqual(3);
  });
});
