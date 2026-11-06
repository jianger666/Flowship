/**
 * 飞书卡片宽度：我们发的每一张卡都要显式设 `config.width_mode = "fill"`（自适应、撑满窗口）。
 *
 * 背景（2026-11-06）：卡片 2.0 的 config 里没设 `width_mode` 时飞书按默认 `default` 渲染——
 * 宽度不超过约 600px、不随窗口撑开（`compact` 约 400px）。用户拍板「改成自适应」。
 *
 * 两层守护：
 * 1. 行为：用真实 builder 造卡，断言 config 带 `width_mode: "fill"`（且 `update_multi: true` 没丢）；
 * 2. 源码契约：新增一个卡片 builder 时，漏掉 width_mode 会在这里红——
 *    - 只有 `card-config.ts` 可以出现 `update_multi` 字面量（别处一律 `...CARD_BASE_CONFIG`）；
 *    - 凡含 `schema: "2.0"` 的 src 文件都必须引用 CARD_BASE_CONFIG；
 *    - 更新 settings 的 PATCH（开 / 关 streaming_mode）也要带它（防「整份替换」时宽度回弹）。
 *
 * 全部是纯函数 / 源码扫描，不调飞书、不读写真实数据。真实飞书里的渲染宽度本机无法验证。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-card-width-${Date.now()}`,
  "data",
);

const { CARD_BASE_CONFIG, CARD_WIDTH_MODE } = await import(
  "@/lib/server/feishu-bridge/card-config"
);
const { buildMarkdownCardJson } = await import("@/lib/server/feishu-bridge/lark-api");
const { buildStreamingCardJson } = await import("@/lib/server/feishu-bridge/card-stream");
const { buildGroupAskCardJson } = await import("@/lib/server/feishu-bridge/group-ask-card");
const { buildGroupAdvanceCardJson } = await import(
  "@/lib/server/feishu-bridge/group-advance-card"
);
const { buildCleanupCardJson, buildCleanupCardEndedAllJson, buildHelpPanelCardJson } =
  await import("@/lib/server/feishu-bridge/control-cards");
const {
  buildAllModelsCard,
  buildChatListCard,
  buildChatsPanelCard,
  buildModelCard,
  buildRepoListCard,
} = await import("@/lib/server/feishu-bridge/chats-panel");
const { buildShareCardJson } = await import("@/lib/server/feishu-group");

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

const configOf = (card: Record<string, unknown>): Record<string, unknown> =>
  card.config as Record<string, unknown>;

const expectFillWidth = (card: Record<string, unknown>) => {
  expect(card.schema).toBe("2.0");
  const config = configOf(card);
  expect(config.width_mode).toBe("fill");
  expect(config.update_multi).toBe(true);
};

describe("公共 config 常量", () => {
  it("宽度模式 = fill（自适应），update_multi = true", () => {
    expect(CARD_WIDTH_MODE).toBe("fill");
    expect(CARD_BASE_CONFIG).toEqual({ update_multi: true, width_mode: "fill" });
  });
});

describe("真实 builder 造出来的卡片都是 fill 宽度", () => {
  it("普通文字卡（群回执 / 答疑正文）：保留 summary", () => {
    const card = buildMarkdownCardJson("已开始跑「需求评审」");
    expectFillWidth(card);
    expect(configOf(card).summary).toEqual({ content: "已开始跑「需求评审」" });
  });

  it("流式卡：流式开 / 关两种形态都带，且 streaming_mode / summary / streaming_config 不受影响", () => {
    const base = {
      title: "回复",
      subtitle: "",
      template: "blue" as const,
      processText: "",
      answerText: "你好",
      footerText: "",
    };
    const streaming = buildStreamingCardJson(base);
    expectFillWidth(streaming);
    expect(configOf(streaming).streaming_mode).toBe(true);
    expect(configOf(streaming).streaming_config).toBeDefined();
    expect(configOf(streaming).summary).toBeDefined();

    const finalCard = buildStreamingCardJson({ ...base, template: "green", streamingMode: false });
    expectFillWidth(finalCard);
    expect(configOf(finalCard).streaming_mode).toBe(false);
    expect(configOf(finalCard).streaming_config).toBeUndefined();
  });

  it("群答题卡 / 推进选择卡", () => {
    expectFillWidth(
      buildGroupAskCardJson({
        requirementName: "需求",
        taskId: "t1",
        chatId: "oc_x",
        askId: "ask1",
        questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }] }],
        senderName: "张三",
      } as never),
    );
    expectFillWidth(
      buildGroupAdvanceCardJson({
        requirementName: "需求",
        taskId: "t1",
        chatId: "oc_x",
        pickId: "p1",
        groups: [],
        senderName: "张三",
      }),
    );
  });

  it("分享卡（三种 kind）", () => {
    for (const kind of ["artifact", "message", "question"] as const) {
      expectFillWidth(
        buildShareCardJson({
          requirementName: "需求",
          kind,
          content: "内容",
          senderName: "张三",
        }),
      );
    }
  });

  it("控制卡：清理卡 / 清理卡终态 / 控制面板", () => {
    expectFillWidth(buildCleanupCardJson([{ id: "t1", title: "对话", runStatus: "idle" }], "t1"));
    expectFillWidth(buildCleanupCardEndedAllJson(2));
    expectFillWidth(buildHelpPanelCardJson("/new — 开新对话"));
  });

  it("会话遥控器：主卡 / 对话列表 / 仓库列表 / 模型 / 全量模型", () => {
    expectFillWidth(buildChatsPanelCard(null, 0));
    expectFillWidth(
      buildChatsPanelCard({ id: "t1", title: "t", repoTail: "r", modelId: "m" }, 1),
    );
    expectFillWidth(buildChatListCard({ rows: [], page: 1, totalPages: 1, total: 0 }));
    expectFillWidth(buildRepoListCard({ repos: [], page: 1, totalPages: 1, purpose: "switch" }));
    expectFillWidth(
      buildAllModelsCard({
        models: [{ id: "m1", display: "模型一" }],
        page: 1,
        totalPages: 1,
        total: 1,
        currentModelId: "m1",
        ctx: { taskId: "t1" },
      }),
    );
    expectFillWidth(
      buildModelCard({
        currentModelId: "m1",
        providerLabel: "提供方",
        quick: [],
        ctx: { taskId: "t1" },
      }),
    );
  });
});

describe("源码契约：新增卡片漏设宽度会红", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const files = walk(SRC).map((file) => ({
    rel: path.relative(ROOT, file),
    text: readFileSync(file, "utf-8"),
  }));
  const CONFIG_FILE = "src/lib/server/feishu-bridge/card-config.ts";

  it("只有 card-config.ts 里出现 update_multi 字面量（别处一律展开 CARD_BASE_CONFIG）", () => {
    const offenders = files
      .filter((f) => f.rel !== CONFIG_FILE && /update_multi\s*:/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("凡写了 schema: \"2.0\" 的文件都引用 CARD_BASE_CONFIG（且至少有这几个已知的卡片出口）", () => {
    const cardFiles = files.filter((f) => /schema:\s*"2\.0"/.test(f.text));
    expect(cardFiles.map((f) => path.basename(f.rel)).sort()).toEqual(
      [
        "card-stream.ts",
        "chats-panel.ts",
        "control-cards.ts",
        "feishu-group.ts",
        "group-advance-card.ts",
        "group-ask-card.ts",
        "lark-api.ts",
        "probe.ts",
      ].sort(),
    );
    for (const f of cardFiles) {
      expect(f.text, f.rel).toContain("CARD_BASE_CONFIG");
      expect(f.text, f.rel).toContain("card-config");
    }
  });

  it("card-config.ts 本身：fill + update_multi，没有别的宽度值", () => {
    const text = readFileSync(path.join(ROOT, CONFIG_FILE), "utf-8");
    expect(text).toMatch(/CARD_WIDTH_MODE = "fill" as const/);
    expect(text).not.toMatch(/width_mode:\s*"(default|compact)"/);
  });

  it("更新 settings 的 PATCH（开 / 关 streaming_mode）也带公共 config：共 3 处", () => {
    const stream = files.find((f) => f.rel.endsWith("feishu-bridge/card-stream.ts"))!;
    const patches = stream.text.match(
      /\{ config: \{ streaming_mode: (?:true|false), \.\.\.CARD_BASE_CONFIG \} \}/g,
    );
    expect(patches).toHaveLength(3);
    // 没有漏网的：每个 patchCardSettings( 调用后的 settings 实参都是上面这种写法
    expect(stream.text.match(/patchCardSettings\(/g)).toHaveLength(3);
  });
});
