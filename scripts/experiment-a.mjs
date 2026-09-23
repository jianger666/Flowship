#!/usr/bin/env node
/**
 * 实验 A：dispose 三级真实性 + SDK 压缩的堆效应 + RSS/主进程曲线（v3.1 §9）。
 * 用法：node scripts/experiment-a.mjs [--json]
 */
import { readFile } from "node:fs/promises";
import v8 from "node:v8";

let sdkVersion = "unknown";
try {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf-8");
  sdkVersion = JSON.parse(raw).dependencies?.["@cursor/sdk"] ?? "unknown";
} catch {
  /* ignore */
}

const heap = v8.getHeapStatistics();
const limit = heap.heap_size_limit || 0;
const used = heap.used_heap_size || 0;
const rss = process.memoryUsage().rss || 0;

const result = {
  sdkVersion,
  heap: {
    usedMB: Math.round(used / 1048576),
    limitMB: Math.round(limit / 1048576),
    ratio: limit > 0 ? used / limit : 0,
  },
  rssMB: Math.round(rss / 1048576),
  dispose: {
    agent: "pending-sdk",
    executor: "pending-sdk",
    store: "pending-sdk",
  },
  constants: {
    note: "§3 常数待本实验校准：old-space 1.2/1.5G、比例 60/80%、RSS 2.0/2.3G 为初值",
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[experiment-a] sdk=${result.sdkVersion}`);
  console.log(
    `[experiment-a] heap=${result.heap.usedMB}MB/${result.heap.limitMB}MB ratio=${result.heap.ratio.toFixed(3)} rss=${result.rssMB}MB`,
  );
  console.log("[experiment-a] dispose: pending-sdk（SDK 接入后填 dominator）");
}
