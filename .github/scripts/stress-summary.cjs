// 临时验证分支专用：汇总 stress-out/r-<组>-*.json（vitest JSON 报告）。
// 分两组统计：a = 默认超时（5s，与日常门禁一致），b = 放宽到 60s（把「纯慢」和「真失败」分开）。
// 每组输出：失败次数、按用例聚合的失败原文（带耗时）、最慢用例排行。结果用 ::notice / ::error 注解（匿名可见）。
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "stress-out";
const os = process.env.RUNNER_OS || "?";
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const noAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^r-.*\.json$/.test(f)).sort() : [];
const groups = [
  ["A 组（默认 5s 超时）", all.filter((f) => /^r-a-/.test(f))],
  ["B 组（放宽 60s 超时）", all.filter((f) => /^r-b-/.test(f))],
];
const other = all.filter((f) => !/^r-[ab]-/.test(f));
if (other.length) groups.push(["其它", other]);

const summarize = (label, files) => {
  let runs = 0;
  let badRuns = 0;
  let unparsable = 0;
  let totalTests = 0;
  let totalFailed = 0;
  const byCase = new Map(); // 失败聚合：key -> { n, msg }
  const speed = new Map(); // 耗时聚合：key -> { max, over3s, n }

  const bump = (key, msg) => {
    const e = byCase.get(key) || { n: 0, msg };
    e.n += 1;
    byCase.set(key, e);
  };

  for (const f of files) {
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      unparsable += 1;
      continue;
    }
    runs += 1;
    totalTests += r.numTotalTests || 0;
    totalFailed += r.numFailedTests || 0;
    if ((r.numFailedTests || 0) > 0 || r.success === false) badRuns += 1;
    for (const tr of r.testResults || []) {
      const base = path.basename(String(tr.name).replace(/\\/g, "/"));
      const asserts = tr.assertionResults || [];
      // 套件级失败（import / setup 阶段就挂了，没有用例级结果）
      if (tr.status === "failed" && !asserts.some((a) => a.status === "failed")) {
        bump(base + " :: <套件级失败>", noAnsi(tr.message || "(无 message)"));
      }
      for (const a of asserts) {
        const key = base + " :: " + a.fullName;
        const d = typeof a.duration === "number" ? a.duration : 0;
        const s = speed.get(key) || { max: 0, over3s: 0, n: 0 };
        s.max = Math.max(s.max, d);
        s.n += 1;
        if (d > 3000) s.over3s += 1;
        speed.set(key, s);
        if (a.status !== "failed") continue;
        const raw = noAnsi((a.failureMessages || []).join("\n---\n"));
        // vitest 超时没有真实抛出点：堆栈只指向用例定义行（STACK_TRACE_ERROR 占位），且没有 expect 位置
        const hint =
          /STACK_TRACE_ERROR/.test(raw) && !/AssertionError/.test(raw)
            ? "【疑似超时：堆栈只指向用例定义行，没有 expect 位置】"
            : "";
        bump(key, `${hint}[耗时 ${Math.round(d)}ms] ${raw}`);
      }
    }
  }

  console.log(
    `::notice title=压力汇总 ${os} ${label}::共 ${files.length} 份报告，解析 ${runs} 份（无法解析 ${unparsable}），` +
      `有失败的 ${badRuns} 次；累计用例 ${totalTests}，累计失败 ${totalFailed}；失败用例种类 ${byCase.size}`,
  );
  const top = [...speed.entries()]
    .sort((a, b) => b[1].max - a[1].max)
    .slice(0, 5)
    .map(([k, v]) => `${Math.round(v.max)}ms(>3s ${v.over3s}/${v.n}次) ${k.split(" :: ").slice(-1)[0].slice(0, 60)}`)
    .join(" ｜ ");
  console.log(`::notice title=最慢用例 ${os} ${label}::${esc(top || "(无数据)")}`);
  for (const [k, e] of [...byCase.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)) {
    console.log(`::error title=压力失败 ${os} ${label} x${e.n}::` + esc((k + "\n" + e.msg).slice(0, 1700)));
  }
};

for (const [label, files] of groups) {
  if (files.length) summarize(label, files);
}
if (!all.length) console.log(`::error title=压力汇总 ${os}::没有找到任何 stress-out/r-*.json`);
