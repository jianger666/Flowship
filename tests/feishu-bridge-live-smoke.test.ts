/**
 * 真机冒烟：建卡 → 发给本人 → 流式 push（代码块 + 工具 timeline）→ finalize
 * 默认 skip；由 scripts/smoke-feishu-card.mjs 设 FEISHU_BRIDGE_LIVE=1 触发。
 */
import { describe, expect, it } from "vitest";

const LIVE = process.env.FEISHU_BRIDGE_LIVE === "1";
const OPEN_ID = "ou_965d86010f477fe5b3cca0e7e33665a2";

describe.skipIf(!LIVE)("feishu-bridge live smoke", () => {
  it(
    "Hermes 样式卡片：timeline + 代码块打字机 → finalize",
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
        title: "Hermes 样式冒烟",
        openId: OPEN_ID,
      });

      await stream.start({ echoText: "smoke：对齐 hermes-feishu-streaming-card" });
      const ids = stream.getIds();
      expect(ids.cardId, `start failCount=${stream.getFailCount()}`).toBeTruthy();
      expect(ids.messageId).toBeTruthy();

      // 过程区：思考 + 工具混排（Hermes timeline markdown）
      const process1 =
        "**思考 1** · completed\n先核对仓库脚本入口，再跑冒烟。\n\n" +
        "> `Shell` · running\n> pnpm typecheck";
      stream.pushProcess(process1);
      stream.setHeaderStatus("正在执行终端：pnpm typecheck", "blue");
      await sleep(300);

      const process2 =
        process1.replace("`Shell` · running", "`Shell` · completed") +
        "\n\n> `Read` · running\n> card-stream.ts";
      stream.pushProcess(process2);
      stream.setHeaderStatus("正在读取：card-stream.ts", "blue");

      // 正文：含代码块 + 表格边界样例（单 element 全量 PUT，不拆块）
      stream.pushAnswer("## 样式核对\n\n流式正文第一段。\n");
      await sleep(300);
      stream.pushAnswer(
        "## 样式核对\n\n流式正文第一段。\n\n```ts\nconst ok = true;\nconsole.log(ok);\n```\n",
      );
      await sleep(300);
      stream.pushAnswer(
        "## 样式核对\n\n流式正文第一段。\n\n```ts\nconst ok = true;\nconsole.log(ok);\n```\n\n| 项 | 状态 |\n| --- | --- |\n| header | 工具 subtitle |\n| timeline | 折叠面板 |\n",
      );
      await sleep(300);

      await stream.finalize({
        ok: true,
        durationMs: 2400,
        model: "gpt-5.5",
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
