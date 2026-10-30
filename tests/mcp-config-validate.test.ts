/**
 * MCP 条目形状校验（R14 B6-2 / Q6-04）。
 *
 * 台账原症状：单条 MCP 存成 `123`（或 `{"url":123}`）后，起 agent 前的 OAuth 注入抛 TypeError，
 * 新任务和新对话一起起不来——一条坏数据拖垮全部。读取层早已丢掉「值不是对象」的条目（B2-1），本批补：
 *   ① 形状不对的「对象条目」同样在读取层丢掉并留日志（读取层用例在 config-read-fallback.test.ts 末尾）；
 *   ② 保存入口（单条编辑 / 高级整体 JSON）当场拦住，说清哪个字段不对。
 * 口径见 validateMcpServerConfig 的注释：只拦会让运行时抛错 / 必然连不上的类型错误；
 * 「刻意放行」的写法在这里钉死，免得以后顺手收紧、把导入进来的合法配置误伤成「静默消失」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBulkMcpJson, validateMcpServerConfig } from "@/lib/mcp-config";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

/** 必须拦住的写法：[说明, 条目, 报错里必须点到的字段] */
const REJECTED: Array<[string, unknown, string]> = [
  ["数字（台账原症状：存 123）", 123, "对象"],
  ["null", null, "对象"],
  ["数组", [], "对象"],
  ["字符串", "x", "对象"],
  ["空对象：既没有 url 也没有 command", {}, "command"],
  ["只有 type:stdio、没有 command", { type: "stdio" }, "command"],
  ["url 是数字", { url: 123 }, "url"],
  ["url 是 null（含 url 键就按远程判）", { url: null }, "url"],
  // 上一条只带 url：就算误判成本地进程，报错里也有「url」字样（缺 url 或 command），区分不出来；
  // 带上合法 command 才看得出「含 url 键就按远程判、不降级成本地进程」
  ["url 是 null 且带了合法 command：仍按远程判，不降级成本地进程", { url: null, command: "npx" }, "url"],
  ["url 是对象", { url: {} }, "url"],
  ["url 是数组", { url: ["https://x"] }, "url"],
  ["url 是空串", { url: "" }, "url"],
  ["url 全是空白", { url: "   " }, "url"],
  ["默认模板没改就保存（type:http + 空 url）", { type: "http", url: "" }, "url"],
  ["headers 不是对象", { url: "https://x", headers: "a" }, "headers"],
  ["headers 是数组", { url: "https://x", headers: [] }, "headers"],
  ["auth 不是对象", { url: "https://x", auth: "a" }, "auth"],
  ["auth 缺 CLIENT_ID", { url: "https://x", auth: {} }, "CLIENT_ID"],
  ["auth.CLIENT_ID 不是字符串", { url: "https://x", auth: { CLIENT_ID: 1 } }, "CLIENT_ID"],
  ["command 是数字", { command: 1 }, "command"],
  ["command 是空串", { command: "" }, "command"],
  ["command 是 null", { command: null }, "command"],
  ["args 不是数组", { command: "x", args: "a" }, "args"],
  ["env 不是对象", { command: "x", env: "a" }, "env"],
  ["cwd 不是字符串", { command: "x", cwd: 1 }, "cwd"],
  ["type 不是字符串", { type: 1, command: "x" }, "type"],
];

/** 正常写法 */
const ACCEPTED: Array<[string, unknown]> = [
  ["stdio：只有 command", { command: "npx" }],
  ["stdio：带 args / env / cwd", { command: "npx", args: ["-y", "x"], env: { A: "1" }, cwd: "/tmp" }],
  ["stdio：显式 type", { type: "stdio", command: "x" }],
  ["http：只有 url", { url: "https://x" }],
  ["http：带 headers", { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }],
  ["sse：本地地址", { type: "sse", url: "http://localhost:1/sse" }],
  ["http：带 OAuth 配置", { url: "https://x", auth: { CLIENT_ID: "id", CLIENT_SECRET: "s", scopes: ["a"] } }],
];

/**
 * 刻意放行的写法：没有实证说它们会让运行时抛错，拦了就是误伤（读取层的误伤 = 条目静默消失）。
 * 把口径钉死，别以后顺手收紧。
 */
const DELIBERATELY_ALLOWED: Array<[string, unknown]> = [
  ["url 里是占位符，不校验语法", { url: "${env:MCP_URL}" }],
  ["url 不是合法 URL：只是这一条连不上（OAuth 探测对坏 url 有 try/catch）", { url: "not a url" }],
  ["非 http 协议不校验", { url: "ftp://x" }],
  ["type 取 Cursor 导入配置里的别名", { type: "streamable-http", url: "https://x" }],
  ["env 的值是数字", { command: "x", env: { PORT: 3000 } }],
  ["headers 的值是数字", { url: "https://x", headers: { "X-N": 1 } }],
  ["args 的元素是数字", { command: "x", args: ["--port", 3000] }],
  ["未知字段照放", { command: "x", disabled: true, timeout: 30 }],
  ["可选字段显式写 null = 没设置（改前就放行）", { command: "x", args: null, env: null, cwd: null }],
  ["远程条目的可选字段显式 null", { url: "https://x", headers: null, auth: null }],
  ["type 显式 null", { command: "x", type: null }],
  ["url 与 command 并存：按远程判（与运行时 `\"url\" in cfg` 同判据），不看 command", { url: "https://x", command: 1 }],
];

describe("validateMcpServerConfig", () => {
  it.each(REJECTED)("拒绝：%s", (_title, cfg, keyword) => {
    const reason = validateMcpServerConfig(cfg);
    expect(reason, "应该返回一句原因").not.toBeNull();
    expect(reason).toContain(keyword);
  });

  it.each(ACCEPTED)("放行：%s", (_title, cfg) => {
    expect(validateMcpServerConfig(cfg)).toBeNull();
  });

  it.each(DELIBERATELY_ALLOWED)("刻意放行：%s", (_title, cfg) => {
    expect(validateMcpServerConfig(cfg)).toBeNull();
  });

  it("报错文案是固定句子、不带用户填的值（读取层会把它写进日志）", () => {
    const secret = "LEAKME_9f3a";
    const bad: unknown[] = [
      { url: 123456789 },
      { command: "x", args: secret },
      { command: "x", env: secret },
      { url: "https://x", headers: secret },
      { url: "https://x", auth: secret },
      { command: "x", cwd: 424242 },
      { type: 987654, command: "x" },
    ];
    for (const cfg of bad) {
      const reason = validateMcpServerConfig(cfg) ?? "";
      expect(reason, `应该拒绝：${JSON.stringify(cfg)}`).not.toBe("");
      for (const value of ["123456789", secret, "424242", "987654"]) {
        expect(reason).not.toContain(value);
      }
    }
  });
});

const bulk = (servers: Record<string, unknown>) =>
  parseBulkMcpJson(JSON.stringify({ mcpServers: servers }));

describe("parseBulkMcpJson 接上形状校验（高级：整体 JSON）", () => {
  it("台账原症状：某条 url 是数字 → 拒绝，并点名是哪一条（改前 ok:true，存进去之后新任务就起不来）", () => {
    const r = bulk({ good: { command: "x" }, bad: { url: 123 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("「bad」");
      expect(r.error).toContain("url");
      expect(r.error).not.toContain("good");
    }
  });

  it("空对象 / 缺 command / 空 url 一律拒绝", () => {
    for (const cfg of [{}, { type: "stdio" }, { type: "http", url: "" }]) {
      expect(bulk({ a: cfg }).ok, JSON.stringify(cfg)).toBe(false);
    }
  });

  it("合法条目（含被刻意放行的写法）原样通过", () => {
    const servers = {
      local: { command: "npx", args: ["-y", "x"] },
      remote: { type: "http", url: "https://x/mcp", headers: { A: "b" } },
      placeholder: { url: "${env:MCP_URL}" },
    };
    expect(bulk(servers)).toEqual({ ok: true, servers });
  });

  it("保留名 / 空名的检查先于形状校验：报的是保留名，不是 url 不对", () => {
    const r = bulk({ flowshipChat: { url: 123 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("flowshipChat");
      expect(r.error).toContain("内置保留名");
    }
  });

  it("既有文案不变：server 不是对象仍然说「必须是对象」", () => {
    const r = bulk({ a: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("的配置必须是对象");
  });
});

describe("单条编辑 dialog 的保存接线（源码契约：没有 DOM 测试环境）", () => {
  const src = read("src/components/settings/mcp-card.tsx");
  const start = src.indexOf("const ServerEditDialog");
  const end = src.indexOf("// ----------------- 从 Cursor 导入");
  const dialog = src.slice(start, end);

  it("找得到 ServerEditDialog 这一段（锚点没丢，下面的断言才不是空转）", () => {
    expect(start, "找不到 const ServerEditDialog").toBeGreaterThan(-1);
    expect(end, "找不到「从 Cursor 导入」分隔注释").toBeGreaterThan(start);
  });

  it("handleSave：JSON.parse 之后、onSave 之前校验形状，不合格 toast 并 return", () => {
    const parse = dialog.indexOf("JSON.parse(configDraft)");
    const validate = dialog.indexOf("validateMcpServerConfig(cfg)");
    const save = dialog.indexOf("onSave(key, cfg, existingName)");
    expect(parse, "找不到 JSON.parse(configDraft)").toBeGreaterThan(-1);
    expect(validate, "handleSave 里没有 validateMcpServerConfig(cfg)").toBeGreaterThan(parse);
    expect(save, "onSave 应该在校验之后").toBeGreaterThan(validate);
    const guard = dialog.slice(validate, save);
    expect(guard).toContain("toast.error(");
    expect(guard).toContain("return;");
  });
});
