#!/usr/bin/env node
/**
 * A/B 分卡实证嵌套 md_process 更新：
 * - 卡 A：仅流式 PUT /elements/md_process/content（嫌疑路径）
 * - 卡 B：仅 batch_update update_element 替换 md_process（候选修复）
 * 两卡初始内容均为「初始占位」，更新文案带明显 A/B 标记，肉眼可辨。
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_ID = "ou_965d86010f477fe5b3cca0e7e33665a2";
const LARK = path.join(
  os.homedir(),
  "Library/Application Support/fe-ai-flow/data/tools/bin/lark-cli",
);

const run = (args) => {
  const r = spawnSync(LARK, [...args, "--as", "bot", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const stdout = (r.stdout || "").trim();
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* ignore */
  }
  return { status: r.status, stdout: stdout.slice(0, 800), json, ok: json?.ok === true };
};

const api = (method, endpoint, data) =>
  run([
    "api",
    method,
    endpoint,
    ...(data != null ? ["--data", JSON.stringify(data)] : []),
  ]);

const buildCard = (title) => ({
  schema: "2.0",
  config: {
    streaming_mode: true,
    update_multi: true,
    streaming_config: {
      print_frequency_ms: { default: 70 },
      print_step: { default: 1 },
      print_strategy: "fast",
    },
  },
  header: {
    title: { tag: "plain_text", content: title },
    template: "blue",
  },
  body: {
    elements: [
      {
        tag: "markdown",
        element_id: "md_answer",
        content: "正文初始（不应被改）",
      },
      {
        tag: "collapsible_panel",
        element_id: "panel_process",
        expanded: true,
        header: {
          title: { tag: "plain_text", content: "思考与工具" },
          vertical_align: "center",
        },
        border: { color: "grey", corner_radius: "5px" },
        padding: "8px 8px 8px 8px",
        elements: [
          {
            tag: "markdown",
            element_id: "md_process",
            content: "初始占位——若仍见此文则更新未生效",
            text_size: "small",
          },
        ],
      },
      { tag: "hr", element_id: "main_divider" },
      {
        tag: "markdown",
        element_id: "md_footer",
        content: "A/B 实证",
        text_size: "x-small",
      },
    ],
  },
});

const createAndSend = (title) => {
  const created = api("POST", "/open-apis/cardkit/v1/cards", {
    type: "card_json",
    data: JSON.stringify(buildCard(title)),
  });
  const cardId = created.json?.data?.card_id;
  if (!cardId) throw new Error(`create fail: ${created.stdout}`);
  const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
  const sent = run([
    "im",
    "+messages-send",
    "--user-id",
    OPEN_ID,
    "--msg-type",
    "interactive",
    "--content",
    content,
  ]);
  return {
    cardId,
    messageId: sent.json?.data?.message_id,
    createOk: created.ok,
    sendOk: sent.ok,
  };
};

console.log("=== 卡 A：仅嵌套流式 PUT ===");
const cardA = createAndSend("A·嵌套流式PUT");
console.log(cardA);
const putA = api(
  "PUT",
  `/open-apis/cardkit/v1/cards/${cardA.cardId}/elements/md_process/content`,
  {
    content:
      "> **A-PUT-MARKER**\n> 若展开面板能看到本行 → 嵌套流式 PUT 有效\n> Shell · completed",
    sequence: 1,
  },
);
console.log("putA ok=", putA.ok, putA.stdout.slice(0, 200));

// 顶层对照：同卡改 md_answer，确认流式 PUT 对本卡可用
const putAnswer = api(
  "PUT",
  `/open-apis/cardkit/v1/cards/${cardA.cardId}/elements/md_answer/content`,
  { content: "**A-ANSWER-PUT-OK**（顶层对照）", sequence: 2 },
);
console.log("putAnswer ok=", putAnswer.ok);

console.log("\n=== 卡 B：仅 batch update_element ===");
const cardB = createAndSend("B·batch update_element");
console.log(cardB);
const batchB = api(
  "POST",
  `/open-apis/cardkit/v1/cards/${cardB.cardId}/batch_update`,
  {
    sequence: 1,
    actions: JSON.stringify([
      {
        action: "update_element",
        params: {
          element_id: "md_process",
          element: {
            tag: "markdown",
            element_id: "md_process",
            content:
              "> **B-BATCH-MARKER**\n> 若展开面板能看到本行 → update_element 有效\n> Shell · completed",
            text_size: "small",
          },
        },
      },
    ]),
  },
);
console.log("batchB ok=", batchB.ok, batchB.stdout.slice(0, 200));

// 关 streaming
for (const [label, id, seq] of [
  ["A", cardA.cardId, 3],
  ["B", cardB.cardId, 2],
]) {
  const p = api("PATCH", `/open-apis/cardkit/v1/cards/${id}/settings`, {
    settings: JSON.stringify({
      config: { streaming_mode: false, update_multi: true },
    }),
    sequence: seq,
  });
  console.log(`patch ${label} ok=`, p.ok);
}

console.log(`
判读（请在飞书展开两张卡的「思考与工具」）：
- 卡 A 正文应是 A-ANSWER-PUT-OK；思考区若仍是「初始占位」→ 嵌套 PUT 静默无效（真因 a）
- 卡 B 思考区若是 B-BATCH-MARKER → update_element 可用
cardA=${cardA.cardId} msg=${cardA.messageId}
cardB=${cardB.cardId} msg=${cardB.messageId}
`);
