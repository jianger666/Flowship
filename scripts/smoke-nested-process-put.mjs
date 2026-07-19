#!/usr/bin/env node
/**
 * 实证：collapsible_panel 内嵌 md_process 的流式 PUT content
 * 是否被 CardKit 接受 / 实际渲染生效。
 *
 * 对照：顶层 md_answer 同 API 是否正常。
 * 再试：batch_update update_element 替换嵌套 md_process。
 *
 * 用法：node scripts/smoke-nested-process-put.mjs
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_ID = "ou_965d86010f477fe5b3cca0e7e33665a2";
const LARK =
  process.env.LARK_CLI ||
  path.join(
    os.homedir(),
    "Library/Application Support/fe-ai-flow/data/tools/bin/lark-cli",
  );

const run = (args) => {
  // 与 lark-api.runLark 一致：子命令在前，--as/--json 挂尾（前置会被当成全局未知子命令）
  const r = spawnSync(LARK, [...args, "--as", "bot", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const stdout = (r.stdout || "").trim();
  const stderr = (r.stderr || "").trim();
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    const s = stdout.indexOf("{");
    const e = stdout.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        json = JSON.parse(stdout.slice(s, e + 1));
      } catch {
        /* ignore */
      }
    }
  }
  return {
    status: r.status,
    error: r.error?.message,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 1000),
    json,
  };
};

const api = (method, endpoint, data) =>
  run([
    "api",
    method,
    endpoint,
    ...(data != null ? ["--data", JSON.stringify(data)] : []),
  ]);

const cardJson = {
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
    title: { tag: "plain_text", content: "嵌套 PUT 实证" },
    template: "blue",
  },
  body: {
    elements: [
      {
        tag: "markdown",
        element_id: "md_answer",
        content: "（正文占位）",
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
            content: "（思考占位-初始）",
            text_size: "small",
          },
        ],
      },
      { tag: "hr", element_id: "main_divider" },
      {
        tag: "markdown",
        element_id: "md_footer",
        content: "实证中",
        text_size: "x-small",
      },
    ],
  },
};

const report = [];
const log = (step, result) => {
  const code = result.json?.code ?? result.json?.StatusCode;
  const msg = result.json?.msg ?? result.json?.message;
  const entry = {
    step,
    exit: result.status,
    apiCode: code,
    apiMsg: msg,
    err: result.error,
    stderr: result.stderr || undefined,
    rawPreview: result.stdout.slice(0, 400),
  };
  report.push(entry);
  console.log(JSON.stringify(entry, null, 2));
};

console.log("[1] create card entity…");
const created = api("POST", "/open-apis/cardkit/v1/cards", {
  type: "card_json",
  data: JSON.stringify(cardJson),
});
log("createCard", created);
const cardId =
  created.json?.data?.card_id ||
  created.json?.card_id ||
  created.json?.data?.cardId;
if (!cardId) {
  console.error("no card_id, abort");
  process.exit(1);
}
console.log("card_id=", cardId);

console.log("[2] send to owner…");
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
log("sendCard", sent);

let seq = 1;

console.log("[3] PUT top-level md_answer content (对照)…");
const putAnswer = api(
  "PUT",
  `/open-apis/cardkit/v1/cards/${cardId}/elements/md_answer/content`,
  { content: "**正文已更新**（顶层流式 PUT 对照）", sequence: seq++ },
);
log("putAnswerContent", putAnswer);

console.log("[4] PUT nested md_process content（嫌疑点）…");
const putProcess = api(
  "PUT",
  `/open-apis/cardkit/v1/cards/${cardId}/elements/md_process/content`,
  {
    content:
      "> `Shell` · completed\n> 嵌套流式 PUT 若可见则说明 a 不成立\n> 第二行思考",
    sequence: seq++,
  },
);
log("putProcessContent", putProcess);

console.log("[5] batch_update update_element 替换 md_process…");
const batch = api("POST", `/open-apis/cardkit/v1/cards/${cardId}/batch_update`, {
  sequence: seq++,
  actions: JSON.stringify([
    {
      action: "update_element",
      params: {
        element_id: "md_process",
        element: {
          tag: "markdown",
          element_id: "md_process",
          content:
            "> `Shell` · completed\n> **batch update_element 替换**\n> 若只有这条可见而 PUT 不可见 → 确认 a",
          text_size: "small",
        },
      },
    },
  ]),
});
log("batchUpdateProcess", batch);

console.log("[6] finalize settings…");
const settings = api(
  "PATCH",
  `/open-apis/cardkit/v1/cards/${cardId}/settings`,
  {
    settings: JSON.stringify({
      config: { streaming_mode: false, update_multi: true },
    }),
    sequence: seq++,
  },
);
log("patchSettings", settings);

const outPath = path.join(root, "scripts/.smoke-nested-process-put-report.json");
await fs.writeFile(
  outPath,
  JSON.stringify({ cardId, openId: OPEN_ID, report }, null, 2),
);
console.log("\n报告已写", outPath);
console.log(
  "请在飞书看卡：若思考区仍是「思考占位-初始」→ PUT 无效；若变成 batch 文案 → update_element OK。",
);
