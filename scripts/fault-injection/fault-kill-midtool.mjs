#!/usr/bin/env node
/**
 * 故障注入 4/5：kill -9 于工具调用中间（对应 §5 WAL）。
 * 确定性时机：GitLab mock 代理在响应前挂起 → kill → 放行（不靠 sleep 掐点）。
 * 本脚本先断言恢复判定纯逻辑；端到端 mock 代理在意图执行器接线后补。
 */
import { decideIntentRecovery } from "../../src/lib/server/intent-log.ts";

const cases = [
  [decideIntentRecovery({ kind: "merge-request", verifiedAbsent: false }), "abandoned"],
  [decideIntentRecovery({ kind: "feishu-message", verifiedAbsent: true }), "abandoned"],
  [decideIntentRecovery({ kind: "git-push", verifiedAbsent: true }), "retry"],
];
for (const [got, want] of cases) {
  if (got !== want) {
    console.error(`[fault-kill] 期望 ${want}，实际 ${got}`);
    process.exit(1);
  }
}
console.log("[fault-kill] OK：反查收敛判定正确（e2e mock 待接线）");
