/**
 * 真机冒烟：建卡 → ask 按钮 → finalize（模拟 done 在 ask 后到达）
 * 默认 skip；由 scripts/smoke-feishu-card.mjs 设 FEISHU_BRIDGE_LIVE=1 触发。
 *
 * R1-1 / R1-Q2：验证按钮存活、header 等待态、streaming_mode=true 上 updateCardEntity 被接受。
 * 2026-07-19：另测思考区 batch update_element 可见 + 分区在正文前。
 */
import { describe, expect, it } from "vitest";

const LIVE = process.env.FEISHU_BRIDGE_LIVE === "1";
const OPEN_ID = "ou_965d86010f477fe5b3cca0e7e33665a2";

describe.skipIf(!LIVE)("feishu-bridge live smoke", () => {
  it(
    "ask + finalize：按钮存活、header 保持等待态（R1-1 / Q2）",
    async () => {
      const { createCardStream } = await import(
        "@/lib/server/feishu-bridge/card-stream"
      );
      const { getBotAppInfo, updateCardEntity } = await import(
        "@/lib/server/feishu-bridge/lark-api"
      );
      const { registerPendingAsk, clearPendingAsk } = await import(
        "@/lib/server/chat-pending"
      );

      const info = await getBotAppInfo();
      expect(info.appId).toBeTruthy();
      expect(info.ownerOpenId).toBe(OPEN_ID);

      const taskId = `smoke-ask-${Date.now()}`;
      registerPendingAsk(taskId, {
        askId: "smoke_ask",
        questions: [
          {
            id: "q1",
            question: "冒烟：选一个？",
            options: [
              { id: "yes", label: "是" },
              { id: "no", label: "否" },
            ],
            allowText: true,
          },
        ],
      });

      try {
        const stream = createCardStream(taskId, {
          title: "R1 ask+finalize 冒烟",
          openId: OPEN_ID,
        });

        await stream.start({
          echoText: "smoke：ask 后 done finalize（R1-1）",
        });
        const ids = stream.getIds();
        expect(ids.cardId, `start failCount=${stream.getFailCount()}`).toBeTruthy();
        expect(ids.messageId).toBeTruthy();

        stream.pushAnswer("请在下方选择：\n");
        await sleep(300);

        await stream.appendAskUser({
          askId: "smoke_ask",
          questions: [
            {
              id: "q1",
              question: "冒烟：选一个？",
              options: [
                { id: "yes", label: "是" },
                { id: "no", label: "否" },
              ],
            },
          ],
        });
        // appendAskUser 内对 streaming_mode=true 卡做了 updateCardEntity（R1-Q2）
        expect(stream.getFailCount()).toBe(0);

        // 模拟 done 在 ask 后到达；pending 未清 → 应保持等待态
        await stream.finalize({
          ok: true,
          durationMs: 1800,
          model: "gpt-5.5",
        });

        expect(stream.getFailCount()).toBe(0);
        console.log(
          "[smoke-feishu-card] ask+finalize ok",
          JSON.stringify({
            taskId,
            ...stream.getIds(),
            owner: info.ownerOpenId,
            note: "pending ask → orange 等待选择；按钮应仍在卡上；updateCardEntity 已被接受",
            // 供报告记录：lark-api updateCardEntity 无抛即飞书接受
            updateCardEntity: typeof updateCardEntity,
          }),
        );
      } finally {
        clearPendingAsk(taskId);
      }
    },
    60_000,
  );

  it(
    "思考区可见：pushProcess → batch update_element；位于正文前；正文打字机；finalize",
    async () => {
      const { createCardStream, buildStreamingCardJson } = await import(
        "@/lib/server/feishu-bridge/card-stream"
      );
      const { getBotAppInfo } = await import(
        "@/lib/server/feishu-bridge/lark-api"
      );

      const info = await getBotAppInfo();
      expect(info.ownerOpenId).toBe(OPEN_ID);

      // 分区契约（不依赖真机渲染）
      const order = (
        buildStreamingCardJson({
          title: "t",
          subtitle: "",
          template: "blue",
          quoteMd: "> q",
          processText: "p",
          answerText: "a",
        }).body as { elements: Array<{ element_id?: string }> }
      ).elements.map((e) => e.element_id);
      expect(order).toEqual([
        "md_quote",
        "panel_process",
        "md_answer",
        "main_divider",
        "md_footer",
      ]);

      const taskId = `smoke-process-${Date.now()}`;
      const stream = createCardStream(taskId, {
        title: "思考区可见冒烟",
        openId: OPEN_ID,
      });

      await stream.start({ echoText: "smoke：嵌套 panel 思考内容" });
      expect(
        stream.getIds().cardId,
        `start fail=${stream.getFailCount()}`,
      ).toBeTruthy();

      stream.pushProcess(
        "**思考 1** · completed\n先分析需求：卡片折叠面板要有内容。\n\n> `Shell` · completed\n> echo smoke-process-marker",
      );
      stream.pushAnswer("这是正文打字机第一段。");
      await sleep(350);
      stream.pushAnswer(
        "这是正文打字机第一段。\n续写第二段——若你看到逐字增长则 md_answer PUT 正常。",
      );
      await sleep(350);

      expect(stream.getFailCount()).toBe(0);

      await stream.finalize({
        ok: true,
        durationMs: 2400,
        model: "composer-2",
      });

      const report = {
        taskId,
        ...stream.getIds(),
        failCount: stream.getFailCount(),
        note:
          "展开「思考与工具」应见思考+Shell；思考面板在正文上方；正文打字机；绿卡已完成",
      };
      console.log(
        "[smoke-feishu-card] process-visible ok",
        JSON.stringify(report),
      );
      expect(stream.getFailCount()).toBe(0);
    },
    60_000,
  );
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
