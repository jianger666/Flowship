#!/usr/bin/env node
/**
 * 实验 B：恢复语义 + 四档拦截点（v3.1 §9，② 开工放行门）。
 * 用法：node scripts/experiment-b.mjs [--json]
 * 输出：transcript/工具历史/seq 语义占位 + 四档判定输入清单 + SDK 版本锁定。
 * CI 门：`@cursor/sdk` 升级后必须重跑本脚本，红灯阻塞发版（A3 持续化）。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let sdkVersion = "unknown";
try {
  sdkVersion = require("../package.json").dependencies?.["@cursor/sdk"] ?? "unknown";
} catch {
  /* ignore */
}

let sdkResolved = "unresolved";
try {
  sdkResolved = require.resolve("@cursor/sdk");
} catch {
  /* ignore */
}

const result = {
  sdkVersion,
  sdkResolved,
  recovery: {
    transcriptHash: "pending-sdk",
    toolHistoryDiff: "pending-sdk",
    seqSemantics: "pending-sdk (resume 是续 run 还是新 run、seq 是否重置)",
  },
  intercept: {
    // 判定输入（SDK 接入后逐项填 true/false，decideInterceptTier 定路线）：
    hasHook: "pending-sdk",
    hasToolOverride: "pending-sdk",
    pathInjectionEffective: "pending-sdk (SDK 的 bash 是否继承 worker PATH)",
  },
  gate: "CI: package.json 中 @cursor/sdk 变更即重跑本脚本",
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[experiment-b] sdk=${result.sdkVersion} resolved=${result.sdkResolved}`);
  console.log("[experiment-b] recovery: pending-sdk（transcript hash / seq 自检待接入）");
  console.log("[experiment-b] intercept: hasHook/hasToolOverride/pathInjectionEffective 待填");
}
