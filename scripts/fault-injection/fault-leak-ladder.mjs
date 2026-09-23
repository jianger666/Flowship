#!/usr/bin/env node
/** 故障注入 2/5：故意泄漏（对应 A1/A3）— 断言软→硬→兜底顺序且双限额生效。 */
import { classifyWorkerMemory, isRotationAllowed } from "../../src/lib/server/mem-governance.ts";

const GB = 1024 * 1024 * 1024;
const seq = [
  classifyWorkerMemory({ oldSpaceBytes: 0.5 * GB, rssBytes: 0.5 * GB }),
  classifyWorkerMemory({ oldSpaceBytes: 1.3 * GB, rssBytes: 1.0 * GB }),
  classifyWorkerMemory({ oldSpaceBytes: 1.6 * GB, rssBytes: 2.4 * GB }),
];
if (seq.join(",") !== "normal,soft,hard") {
  console.error(`[fault-leak] 阶梯顺序错误：${seq.join(",")}`);
  process.exit(1);
}
const denied = isRotationAllowed({ actionCount: 3, taskHourCount: 0, taskTotalCount: 0 });
if (denied.allowed) {
  console.error("[fault-leak] 第 4 次应降级");
  process.exit(1);
}
console.log("[fault-leak] OK：软→硬→兜底，双限额生效");
