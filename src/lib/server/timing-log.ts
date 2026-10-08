/**
 * 发送耗时取证的文件镜像（dev 终端 agent 够不着，落盘后直接读文件）。
 *
 * - chat-reply → `logs/chat-reply-timings.log`
 * - question   → `logs/question-timings.log`
 * 只记慢发送（调用方定阈值）；写失败永不影响主流程；超 512KB 只留尾部 300 行。
 */
import path from "node:path";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { dataRoot } from "./data-root";

export const appendTimingLog = (file: string, lines: string[]): void => {
  if (lines.length === 0) return;
  // 单测内不落盘：防 data/ 污染 + 并行 worker 互扰（vitest 置 NODE_ENV=test）。
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  void (async () => {
    try {
      const dir = path.join(dataRoot(), "logs");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, file);
      await appendFile(full, lines.join("\n") + "\n", "utf-8");
      const st = await stat(full).catch(() => null);
      if (st && st.size > 512 * 1024) {
        const content = await readFile(full, "utf-8").catch(() => "");
        await writeFile(
          full,
          content.split("\n").slice(-300).join("\n") + "\n",
          "utf-8",
        ).catch(() => {});
      }
    } catch (err) {
      // 写失败给声（review 意见）：吞了以后查“我发了怎么没日志”无从下手。
      // debug 级别——正常路径零噪音；主流程不受影响。
      console.debug(`[timing-log] 写入 ${file} 失败:`, err);
    }
  })();
};
