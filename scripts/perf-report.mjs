#!/usr/bin/env node
/**
 * Flowship 性能报告 CLI：读结构化观测日志，按维度出分布与对比。
 *
 *   node scripts/perf-report.mjs                      # 默认读本机 Flowship 数据目录下的 logs
 *   node scripts/perf-report.mjs --since 7d           # 只看最近 7 天（也支持 24h / 90m / 2026-10-09）
 *   node scripts/perf-report.mjs --task t_xxx_yyy     # 只看某个任务（事件循环慢秒是进程级、不受此过滤）
 *   node scripts/perf-report.mjs --dir /path/to/logs  # 指定日志目录（如拷出来的、或测试实例的）
 *   node scripts/perf-report.mjs --json               # 机器可读（完整 report 对象）
 *
 * 逻辑全在 scripts/lib/perf-report.mjs（有单测）。
 */
import {
  buildReport,
  defaultLogsDir,
  loadLogs,
  parseSince,
  renderText,
} from "./lib/perf-report.mjs";

const USAGE = `用法：node scripts/perf-report.mjs [--dir <logs目录>] [--since 7d|24h|90m|日期] [--task <taskId>] [--min-samples N] [--json]`;

const parseArgs = (argv) => {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少参数值`);
      return v;
    };
    if (a === "--json") out.json = true;
    else if (a === "--dir") out.dir = next();
    else if (a === "--since") out.since = next();
    else if (a === "--task") out.task = next();
    else if (a === "--min-samples") out.minSamples = Number(next());
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
};

const main = async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const dir = args.dir ?? defaultLogsDir();
  let sinceMs;
  try {
    sinceMs = args.since ? parseSince(args.since) : undefined;
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const { input, parseErrors } = await loadLogs(dir);
  const total =
    input.run.length + input.ui.length + input.warmup.length + input.lag.length;
  if (total === 0) {
    console.error(`在 ${dir} 下没有读到任何观测日志（run-perf.jsonl / ui-perf.jsonl / warmup.jsonl / loop-lag.jsonl）。`);
    console.error("提示：观测日志从 v1.9.28 起才有；用 --dir 指向别处，或确认 App 已升级并发过消息。");
    process.exit(1);
  }
  const report = buildReport(input, {
    sinceMs,
    taskId: args.task,
    minSamples: Number.isFinite(args.minSamples) ? args.minSamples : undefined,
    parseErrors,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
