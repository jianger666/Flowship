/**
 * 真机冒烟：建卡 → 发给本人 → 流式 push 三次 → finalize
 * 默认 skip；由 scripts/smoke-feishu-card.mjs 设 FEISHU_BRIDGE_LIVE=1 触发。
 */
import { describe, expect, it } from "vitest";

const LIVE = process.env.FEISHU_BRIDGE_LIVE === "1";
const OPEN_ID = "ou_965d86010f477fe5b3cca0e7e33665a2";

describe.skipIf(!LIVE)("feishu-bridge live smoke", () => {
  it(
    "createCardStream 端到端打字机",
    async () => {
      const { createCardStream } = await import(
        "@/lib/server/feishu-bridge/card-stream"
      );
      const { getBotAppInfo } = await import(
        "@/lib/server/feishu-bridge/lark-api"
      );

      const info = await getBotAppInfo();
      expect(info.appId).toBeTruthy();
      expect(info.ownerOpenId).toBe(OPEN_ID);

      const taskId = `smoke-${Date.now()}`;
      const stream = createCardStream(taskId, {
        title: "S1 冒烟",
        openId: OPEN_ID,
      });

      await stream.start({ echoText: "smoke ping" });
      const ids = stream.getIds();
      expect(ids.cardId, `start failCount=${stream.getFailCount()}`).toBeTruthy();
      expect(ids.messageId).toBeTruthy();

      // 三次递增 push，间隔 >250ms 让节流各刷一次（打字机可见）
      stream.pushAnswer("第一行：建卡成功\n");
      await sleep(300);
      stream.pushAnswer("第一行：建卡成功\n第二行：流式更新中…\n");
      await sleep(300);
      stream.pushAnswer(
        "第一行：建卡成功\n第二行：流式更新中…\n第三行：准备 finalize ✅\n",
      );
      await sleep(300);

      await stream.finalize({
        ok: true,
        durationMs: 900,
        model: "smoke",
      });

      expect(stream.getFailCount()).toBe(0);
      console.log(
        "[smoke-feishu-card] ok",
        JSON.stringify({ taskId, ...stream.getIds(), owner: info.ownerOpenId }),
      );
    },
    60_000,
  );
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
