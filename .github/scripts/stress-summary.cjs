// 临时验证分支专用：汇总 stress-out/r-*.json（vitest JSON 报告），
// 按用例聚合失败次数，并输出每个失败用例的首条失败原文（::error 注解，匿名可见）。
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "stress-out";
const os = process.env.RUNNER_OS || "?";
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const noAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^r-.*\.json$/.test(f)).sort() : [];
let runs = 0;
let badRuns = 0;
let unparsable = 0;
let totalTests = 0;
let totalFailed = 0;
const byCase = new Map();

const bump = (key, msg) => {
  const e = byCase.get(key) || { n: 0, msg: noAnsi(msg) };
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
      bump(base + " :: <套件级失败>", tr.message || "(无 message)");
    }
    for (const a of asserts) {
      if (a.status !== "failed") continue;
      bump(base + " :: " + a.fullName, (a.failureMessages || []).join("\n---\n"));
    }
  }
}

console.log(
  `::notice title=压力复现汇总 ${os}::共 ${files.length} 份报告，解析 ${runs} 份（无法解析 ${unparsable}），` +
    `有失败的 ${badRuns} 次；累计用例 ${totalTests}，累计失败 ${totalFailed}；失败用例种类 ${byCase.size}`,
);

for (const [k, e] of [...byCase.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  console.log(`::error title=压力失败 ${os} x${e.n}::` + esc((k + "\n" + e.msg).slice(0, 1800)));
}
