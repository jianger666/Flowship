#!/usr/bin/env node
/** 故障注入 1/5：大 transcript ×10（对应 A1/A2）— 断言双 guard 触发且不超硬顶。 */
import { classifyWorkerMemory } from "../../src/lib/server/mem-governance.ts";

const GB = 1024 * 1024 * 1024;
const level = classifyWorkerMemory({ oldSpaceBytes: 1.6 * GB, heapRatio: 0.85, rssBytes: 2.4 * GB });
if (level !== "hard") {
  console.error(`[fault-x10] 期望 hard，实际 ${level}`);
  process.exit(1);
}
console.log("[fault-x10] OK：×10 负载命中硬线");
