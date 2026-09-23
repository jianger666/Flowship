#!/usr/bin/env node
/** 故障注入 5/5：双杀 worker+主进程（对应 §5 + 持久化）— 断言 WAL 落盘可恢复。 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FLOWSHIP_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "fault-doublekill-")).then((d) => d);
const { appendIntent, loadIntents, pendingIntents } = await import("../../src/lib/server/intent-log.ts");

await appendIntent({ taskId: "t1", actionId: "a1", toolCallId: "c1", kind: "git-push", payloadHash: "h" });
// 模拟双杀：进程内存全丢，只剩磁盘文件；重新 load 应完整恢复。
const all = await loadIntents("t1");
const pending = await pendingIntents("t1");
if (all.length !== 1 || pending.length !== 1) {
  console.error(`[fault-doublekill] 恢复失败 all=${all.length} pending=${pending.length}`);
  process.exit(1);
}
console.log("[fault-doublekill] OK：双杀后 WAL 完整恢复");
