#!/usr/bin/env node
/** 故障注入 3/5：seq 重置 + 假死双跑（对应 A3 + §7）— 断言去重无重复、fencing 拒旧写。 */
import {
  buildEventDedupKeyWithEpoch,
  isWriteFenced,
} from "../../src/lib/server/mem-governance.ts";
import { EventDedupRegistry } from "../../src/lib/server/worker-ipc.ts";

const reg = new EventDedupRegistry(100);
// SDK seq 重置场景：主进程改派 localSeq，epoch 区分新旧 worker。
const e1 = { agentId: "ag", runId: "r1", epoch: 5, localSeq: 7 };
const e2 = { agentId: "ag", runId: "r1", epoch: 5, localSeq: 7 };
const e3 = { agentId: "ag", runId: "r1", epoch: 6, localSeq: 7 };
if (reg.check(e1) !== false || reg.check(e2) !== true || reg.check(e3) !== false) {
  console.error("[fault-seq] 去重语义错误");
  process.exit(1);
}
if (!isWriteFenced({ writeEpoch: 5, currentEpoch: 6 })) {
  console.error("[fault-seq] 旧 epoch 写应被 fence");
  process.exit(1);
}
void buildEventDedupKeyWithEpoch;
console.log("[fault-seq] OK：无重复消费，旧写被拒");
