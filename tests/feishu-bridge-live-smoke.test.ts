/**
 * 真机冒烟：建卡 → ask 按钮 → finalize（模拟 done 在 ask 后到达）
 * 默认 skip；由 scripts/smoke-feishu-card.mjs 设 FEISHU_BRIDGE_LIVE=1 触发。
 *
 * R1-1 / R1-Q2：验证按钮存活、header 等待态、streaming_mode=true 上 updateCardEntity 被接受。
 * 2026-07-19：另测思考区 batch update_element 可见 + 分区在正文前。
 */
import { describe, expect, it } from "vitest";

const LIVE = process.env.FEISHU_BRIDGE_LIVE === "1";
/** cli_aac269da35399cf9（test 实例）应用 owner；发卡前 getBotAppInfo 再核一次 */
const OPEN_ID = "ou_40832fc8084baf7cb7730a443c70aec2";

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

describe.skipIf(!LIVE)("Hermes 三卡验收", () => {
  it(
    "①纯思考 ②带工具 ③ask：全流程发卡",
    async () => {
      const { createCardStream } = await import(
        "@/lib/server/feishu-bridge/card-stream"
      );
      const { getBotAppInfo } = await import(
        "@/lib/server/feishu-bridge/lark-api"
      );
      const { registerPendingAsk, clearPendingAsk } = await import(
        "@/lib/server/chat-pending"
      );

      const info = await getBotAppInfo();
      expect(info.appId).toBeTruthy();
      expect(info.ownerOpenId).toBe(OPEN_ID);

      const report: Array<{
        kind: string;
        taskId: string;
        cardId?: string;
        messageId?: string;
        failCount: number;
        note: string;
      }> = [];

      // ① 纯思考轮：短间隔逼节流窗内 finalize（复现 P0）
      {
        const taskId = `smoke-pure-think-${Date.now()}`;
        const stream = createCardStream(taskId, {
          title: "①纯思考轮验收",
          openId: OPEN_ID,
        });
        await stream.start({ echoText: "hello啊" });
        expect(stream.getIds().cardId, `pure start fail=${stream.getFailCount()}`).toBeTruthy();

        const thinking =
          "**思考 1** · completed\n用户在 Flowship Chat 任务中问候。我将用中文自然回复…";
        stream.pushProcess(thinking);
        await sleep(80);
        stream.pushAnswer("你好啊！有什么我可以帮你的吗？");
        await sleep(80);
        await stream.finalize({
          ok: true,
          durationMs: 1600,
          model: "composer-2",
        });
        report.push({
          kind: "pure-think",
          taskId,
          ...stream.getIds(),
          failCount: stream.getFailCount(),
          note: "展开「思考与工具 · 0 次」应见思考正文",
        });
        expect(stream.getFailCount()).toBe(0);
      }

      // ② 带工具轮
      {
        const taskId = `smoke-with-tool-${Date.now()}`;
        const stream = createCardStream(taskId, {
          title: "②带工具轮验收",
          openId: OPEN_ID,
        });
        await stream.start({ echoText: "跑一下 lint" });
        stream.pushProcess("**思考 1** · completed\n先检查仓库脚本。");
        await sleep(200);
        stream.setHeaderStatus("正在执行终端：pnpm lint");
        stream.pushProcess(
          "**思考 1** · completed\n先检查仓库脚本。\n\n> `Shell` · running\n> pnpm lint",
        );
        await sleep(250);
        stream.pushProcess(
          "**思考 1** · completed\n先检查仓库脚本。\n\n> `Shell` · completed\n> pnpm lint",
        );
        stream.pushAnswer("lint 已通过，没有新增问题。");
        await sleep(300);
        await stream.finalize({
          ok: true,
          durationMs: 4200,
          model: "gpt-5.5",
        });
        report.push({
          kind: "with-tool",
          taskId,
          ...stream.getIds(),
          failCount: stream.getFailCount(),
          note: "展开应见思考 + Shell",
        });
        expect(stream.getFailCount()).toBe(0);
      }

      // ③ ask 按钮卡
      {
        const taskId = `smoke-ask-hermes-${Date.now()}`;
        registerPendingAsk(taskId, {
          askId: "smoke_ask",
          questions: [
            {
              id: "q1",
              question: "要继续吗？",
              options: [
                { id: "yes", label: "继续" },
                { id: "no", label: "停" },
              ],
              allowText: true,
            },
          ],
        });
        try {
          const stream = createCardStream(taskId, {
            title: "③ask 按钮验收",
            openId: OPEN_ID,
          });
          await stream.start({ echoText: "问你一件事" });
          stream.pushAnswer("请选择：");
          await sleep(250);
          await stream.appendAskUser({
            askId: "smoke_ask",
            questions: [
              {
                id: "q1",
                question: "要继续吗？",
                options: [
                  { id: "yes", label: "继续" },
                  { id: "no", label: "停" },
                ],
              },
            ],
          });
          await stream.finalize({
            ok: true,
            durationMs: 2000,
            model: "composer-2",
          });
          report.push({
            kind: "ask",
            taskId,
            ...stream.getIds(),
            failCount: stream.getFailCount(),
            note: "orange + 按钮；subtitle 空",
          });
          expect(stream.getFailCount()).toBe(0);
        } finally {
          clearPendingAsk(taskId);
        }
      }

      const failTotal = report.reduce((n, r) => n + r.failCount, 0);
      console.log(
        "[smoke-hermes-roundtrip]",
        JSON.stringify({ owner: info.ownerOpenId, failTotal, cards: report }, null, 2),
      );
      expect(failTotal).toBe(0);
    },
    120_000,
  );
});
