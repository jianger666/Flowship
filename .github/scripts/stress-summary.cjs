// 临时验证分支专用：汇总 stress-out/r-<组>-*.json（vitest JSON 报告）。
// 分三组统计：
//   a = 默认超时（5s，与日常门禁一致）；
//   b = 放宽到 60s（把「纯慢」和「真失败」分开看）；
//   c = 探针：全局超时压到 3s，专门找「吃全局超时、却在这台机器上要 3 秒以上」的用例（= 离 5s 默认线余量不足 40%）。
//       有显式 / 文件级超时的用例不受它影响，所以 c 组里的超时命中只是候选清单、不是缺陷；非超时的失败仍按真失败报。
// 每组输出：失败次数、按用例聚合的失败原文（带耗时）、最慢用例排行。结果用 ::notice / ::warning / ::error 注解（匿名可见）。
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "stress-out";
const os = process.env.RUNNER_OS || "?";
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const noAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^r-.*\.json$/.test(f)).sort() : [];
const A_LABEL = "A 组（默认 5s 超时）";
const C_LABEL = "C 组（探针：3s 全局超时）";
const groups = [
  [A_LABEL, all.filter((f) => /^r-a-/.test(f))],
  ["B 组（放宽 60s 超时）", all.filter((f) => /^r-b-/.test(f))],
  [C_LABEL, all.filter((f) => /^r-c-/.test(f))],
];
const other = all.filter((f) => !/^r-[abc]-/.test(f));
if (other.length) groups.push(["其它", other]);

// 「文件 › 用例名」短写：注解里要一眼看出用例属于哪个文件
const short = (k, n = 52) => {
  const [file, ...rest] = k.split(" :: ");
  return `${file.replace(/\.test\.ts$/, "")} › ${rest.join(" :: ").replace(/\s+/g, " ").slice(0, n)}`;
};
// 差分对拍有 16 个 seed、用例名只差一个数字：耗时排行里合并成一条（取各 seed 的最大值），免得挤掉别的用例。
// 失败聚合不合并（要能定位到具体哪个 seed）。
const norm = (k) => k.replace(/seed=\d+/g, "seed=*");
// vitest 超时没有真实抛出点：堆栈只指向用例定义行（STACK_TRACE_ERROR 占位），且没有 expect 位置
// （注意：JSON 报告里超时文案不含 "timed out"，不能靠关键字判断）
const looksLikeTimeout = (raw) => /STACK_TRACE_ERROR/.test(raw) && !/AssertionError/.test(raw);

const speedOf = {}; // 组名 -> 耗时聚合（c 组命中时回查 a 组的最大耗时）

const summarize = (label, files) => {
  const probe = label === C_LABEL;
  let runs = 0;
  let badRuns = 0;
  let unparsable = 0;
  let totalTests = 0;
  let totalFailed = 0;
  const byCase = new Map(); // 失败聚合：key -> { n, msg, timeout }
  const speed = new Map(); // 耗时聚合：norm(key) -> { max, over3s, n }
  speedOf[label] = speed;

  const bump = (key, msg, timeout) => {
    const e = byCase.get(key) || { n: 0, msg, timeout: true };
    e.n += 1;
    if (!timeout && e.timeout) {
      // 只要出现过一次非超时失败，就按真失败对待，并展示那一次的原文（而不是先前的超时占位堆栈）
      e.timeout = false;
      e.msg = msg;
    }
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
        bump(base + " :: <套件级失败>", noAnsi(tr.message || "(无 message)"), false);
      }
      for (const a of asserts) {
        const key = base + " :: " + a.fullName;
        const d = typeof a.duration === "number" ? a.duration : 0;
        const sk = norm(key);
        const s = speed.get(sk) || { max: 0, over3s: 0, n: 0 };
        s.max = Math.max(s.max, d);
        s.n += 1;
        if (d > 3000) s.over3s += 1;
        speed.set(sk, s);
        if (a.status !== "failed") continue;
        const raw = noAnsi((a.failureMessages || []).join("\n---\n"));
        const timeout = looksLikeTimeout(raw);
        const hint = timeout ? "【疑似超时：堆栈只指向用例定义行，没有 expect 位置】" : "";
        bump(key, `${hint}[耗时 ${Math.round(d)}ms] ${raw}`, timeout);
      }
    }
  }

  console.log(
    `::notice title=压力汇总 ${os} ${label}::共 ${files.length} 份报告，解析 ${runs} 份（无法解析 ${unparsable}），` +
      `有失败的 ${badRuns} 次；累计用例 ${totalTests}，累计失败 ${totalFailed}；失败用例种类 ${byCase.size}` +
      (probe ? "（探针组：超时命中不算缺陷，见「探针命中」）" : ""),
  );

  const ranked = [...byCase.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!probe) {
    const top = [...speed.entries()]
      .sort((a, b) => b[1].max - a[1].max)
      .slice(0, 10)
      .map(([k, v]) => `${Math.round(v.max)}ms(>3s ${v.over3s}/${v.n}次) ${short(k)}`)
      .join(" ｜ ");
    console.log(`::notice title=最慢用例 ${os} ${label}::${esc(top || "(无数据)")}`);
    for (const [k, e] of ranked.slice(0, 3)) {
      console.log(`::error title=压力失败 ${os} ${label} x${e.n}::` + esc((k + "\n" + e.msg).slice(0, 1700)));
    }
    return;
  }

  // 探针组：超时命中 = 「吃全局超时、且这台机器上要 3 秒以上」的候选；其余失败仍是真失败
  const aSpeed = speedOf[A_LABEL];
  const hits = ranked.filter(([, e]) => e.timeout);
  const real = ranked.filter(([, e]) => !e.timeout);
  const lines = hits.slice(0, 15).map(([k, e]) => {
    const a = aSpeed && aSpeed.get(norm(k));
    return `x${e.n}次 ｜ A 组最大耗时 ${a ? Math.round(a.max) + "ms" : "?"} ｜ ${short(k, 70)}`;
  });
  console.log(
    `::warning title=探针命中 ${os}（${hits.length} 种）::` +
      esc("说明：命中 0 种 = 吃全局超时的用例在这台机器上都不到 3 秒。\n" + (lines.join("\n") || "(无)")),
  );
  for (const [k, e] of real.slice(0, 3)) {
    console.log(`::error title=压力失败 ${os} ${label} x${e.n}::` + esc((k + "\n" + e.msg).slice(0, 1700)));
  }
};

for (const [label, files] of groups) {
  if (files.length) summarize(label, files);
}
if (!all.length) console.log(`::error title=压力汇总 ${os}::没有找到任何 stress-out/r-*.json`);
