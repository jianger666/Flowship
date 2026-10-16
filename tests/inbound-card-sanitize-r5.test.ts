/**
 * 第五轮 review（G1-06 / G1-07）：入向卡片净化的缺口回归。
 * 既有用例在 tests/inbound-card-sanitize.test.ts，这里只放第五轮新增。
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeInboundCardText,
  stripAgentPanels,
  unwrapCardShell,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";

describe("G1-06 · `▶ ` 开头的普通行不是折叠面板头", () => {
  it("报告复现：两行 ▶ 要点列表（没有 ▲）整段保留", () => {
    const t = "请看下面两点\n▶ 第一点：先拉依赖\n▶ 第二点：再跑测试";
    expect(stripAgentPanels(t)).toBe(t);
    expect(sanitizeInboundCardText(t)).toBe(t);
  });

  it("▼ 开头的普通小结行同样保留", () => {
    const t = "结论如下\n▼ 小结：本次改动只影响解析层\n后面还有一段";
    expect(stripAgentPanels(t)).toBe(t);
  });

  it("标题只是碰巧以「思考」开头的普通句子 / 普通 emoji 要点，不当面板头", () => {
    for (const t of [
      "说明\n▶ 思考一下方案再动手",
      "说明\n▶ ✅ 已完成第一步\n▶ ✅ 已完成第二步",
      "说明\n▶ 工具执行器的配置在 config 里",
    ]) {
      expect(stripAgentPanels(t), t).toBe(t);
    }
  });

  it("真面板头（没有 ▲，流式截断）仍从面板头剥到文末：思考 / 工具执行各种写法", () => {
    for (const head of [
      "▶ 💭 思考了 0.3s",
      "▶ 💭 思考中",
      "▼ 🛠️ 工具执行 · 1 步",
      "▶ 思考",
      "▶ 思考了 2.3s",
      "▶ 工具执行 · 2 步",
      "▶ Thinking",
    ]) {
      expect(stripAgentPanels(`正文\n${head}\n    内部推理 a\n    内部推理 b`), head).toBe("正文");
    }
  });

  it("有配对 ▲ 的面板：不论头长什么样都照旧剥（既有行为）", () => {
    expect(stripAgentPanels("a\n▶ x\n  内容\n▲\nb")).toBe("a\nb");
  });

  it("普通 ▶ 要点 + 后面一个真面板：只剥真面板，要点与面板之间的正文保留", () => {
    const t = [
      "前言",
      "▶ 要点 A",
      "▶ 要点 B",
      "结论文字",
      "▶ 💭 思考了 1s",
      "  内部推理",
      "▲",
      "尾巴",
    ].join("\n");
    expect(stripAgentPanels(t)).toBe(
      ["前言", "▶ 要点 A", "▶ 要点 B", "结论文字", "尾巴"].join("\n"),
    );
  });

  it("<card> 外壳里的普通 ▶ 行经过完整净化链路也保留", () => {
    const raw = "<card>\n请看下面两点\n▶ 第一点\n▶ 第二点\n</card>";
    expect(sanitizeInboundCardText(raw)).toBe("请看下面两点\n▶ 第一点\n▶ 第二点");
  });
});

describe("G1-07 · 病态输入不得二次型膨胀", () => {
  // 阈值是「慢出几个数量级」而不是性能基准：线性实现在 20 万字符上是个位数毫秒，
  // 二次型实现在同样输入上是数秒到数十秒；这里给 1.5 秒余量，慢机器 / 高负载也不会误报
  const BUDGET_MS = 1500;
  const timed = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  // 实测（修之前）：20 万空格 ≈ 70 秒；6 万空格 ≈ 6 秒，已经远超预算、又不至于让「回退自检」跑太久
  it("长空白串（无 </card>）不会让 unwrapCardShell 变慢", () => {
    const evil = `${" ".repeat(60_000)}x`;
    expect(timed(() => unwrapCardShell(evil))).toBeLessThan(BUDGET_MS);
    expect(unwrapCardShell(evil)).toBe(evil);
  });

  it("长空白串夹在 </card> 前仍能正确拆壳", () => {
    expect(unwrapCardShell("<card>\n正文\n   \n\t </card>  \n")).toBe("正文");
    expect(unwrapCardShell(`<card>${" ".repeat(50_000)}正文${" ".repeat(50_000)}</card>`)).toBe(
      "正文",
    );
  });

  it("只有 </card> 前后的空白才被吃；没有 </card> 结尾时末尾空白原样保留", () => {
    expect(unwrapCardShell("<card>正文  \n")).toBe("正文  \n");
    expect(unwrapCardShell("正文 </card> 后面还有字")).toBe("正文 </card> 后面还有字");
  });

  it("线性化后与旧正则 /\\s*<\\/card>\\s*$/ 语义逐例一致（固定种子随机小输入对拍）", () => {
    const OLD_OPEN = /^\s*<card(\s[^>]*)?>\s*/;
    const OLD_CLOSE = /\s*<\/card>\s*$/;
    const old = (t: string) => t.replace(OLD_OPEN, "").replace(OLD_CLOSE, "");
    const pieces = [
      "<card>", "</card>", "<card id=1>", " ", "\n", "\t", "\u00a0", "\ufeff", "正文", "x",
      "</card ", "<", ">",
    ];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let n = 0; n < 2000; n++) {
      let s = "";
      const len = Math.floor(rand() * 9);
      for (let k = 0; k < len; k++) s += pieces[Math.floor(rand() * pieces.length)];
      expect(unwrapCardShell(s), JSON.stringify(s)).toBe(old(s));
    }
  });

  it("完整净化链路在 5～20 万字符的病态输入上有界", () => {
    for (const evil of [
      " ".repeat(60_000) + "x",
      "\n".repeat(200_000) + "x",
      "▶ 💭 ".repeat(40_000),
      "<at user_id=\"a\">".repeat(15_000),
      "@".repeat(200_000),
      "@a(".repeat(60_000),
    ]) {
      expect(timed(() => sanitizeInboundCardText(evil))).toBeLessThan(BUDGET_MS);
    }
  });
});
