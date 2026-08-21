/**
 * 事件流「消息级 UI」源码契约（2026-07-28 体验第二批）
 *
 * 三件事必须一起成立、少一件用户就回到原来的痛点：
 * 1. 错误独立成卡：不进工作过程组（分组行为由 tests/chat-turns.test.ts 覆盖）、
 *    两形态共用同一张 destructive 卡、渲染 runner 早就写好却从没读过的 `meta.detail`
 * 2. hover 动作条单一来源：chat AI 回复 / log AI 回复 / chat 用户消息三处共用
 *    MessageActionBar；log 形态补上「复制」（以前只有分享、日常任务连分享都没有 →
 *    task 详情页看方案时一个动作都没有）
 * 3. thinking 显示耗时：数据 mergeAdjacentThinking 一直在累加、渲染层从没读过
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），所以走源码契约；
 * 纯函数部分（分组 / 可重试判定 / 耗时格式化）由各自的单测覆盖。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const listSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
};

const rows = read("components", "tasks", "event-stream", "rows.tsx");
const errorCard = read("components", "tasks", "event-stream", "error-card.tsx");

describe("错误：独立平铺成 destructive 卡", () => {
  it("rows 把 error 分流到 ErrorCard、不再落到灰细行 processRow", () => {
    expect(rows).toContain('ev.kind === "error"');
    expect(rows).toContain("<ErrorCard");
  });

  it("回合内工具失败不进 ErrorCard（带 callId 的 error 直接丢掉）", () => {
    expect(rows).toContain("isInTurnToolErrorEvent");
  });

  it("错误分流在 chat / log 分叉之前——两形态共用同一张卡", () => {
    const errIdx = rows.indexOf('if (ev.kind === "error")');
    // EventRowImpl 里 chat 分支的段落标题（StreamingAssistantRow 也有个 variant 判断、
    // 不能用它当锚点）
    const chatIdx = rows.indexOf("// ---------- chat 形态");
    expect(errIdx).toBeGreaterThan(0);
    expect(chatIdx).toBeGreaterThan(0);
    expect(errIdx).toBeLessThan(chatIdx);
  });

  it("视觉是真的错误态（destructive 边框 + 底衬），不是 muted 细行", () => {
    expect(errorCard).toContain("border-destructive");
    expect(errorCard).toContain("bg-destructive/5");
    expect(errorCard).not.toContain("text-muted-foreground/70");
  });

  it("正文保留换行：多行结构（如 wk 门禁「结论 + 逐条明细」）不能被压成一团", () => {
    // 渲染 ev.text 的那个容器自己要带 whitespace-pre-wrap（下面 detail 的 <pre> 不算）
    expect(errorCard).toMatch(/whitespace-pre-wrap[^<>]*>\s*\{ev\.text\}/);
  });

  it("渲染 meta.detail：runner 存了原始诊断（sdk-error.ts），UI 得读", () => {
    expect(errorCard).toContain("ev.meta?.detail");
    expect(errorCard).toContain("查看详情");
    // detail 与正文相同时不重复放一份
    expect(errorCard).toContain("detail !== ev.text.trim()");
  });

  it("复制走 CopyButton 公共件、复制内容含原始诊断", () => {
    expect(errorCard).toContain("CopyButton");
    expect(errorCard).toContain("copyText");
    expect(errorCard).toContain("DETAIL_HEADING");
  });

  it("重试只给当轮失败（isLatestErrorEvent 把关）、能力由 Context 注入", () => {
    expect(errorCard).toContain("isLatestErrorEvent");
    expect(errorCard).toContain("useStreamActions");
    expect(errorCard).toContain("onRetryLastMessage");
    // agent 正在跑时这条错误已翻篇、不给重试
    expect(errorCard).toContain("!runActive");
  });

  it("server 侧仍在写 meta.detail——数据源没了这张卡就白做", () => {
    const chatRunner = read("lib", "server", "chat-runner.ts");
    const taskRunner = read("lib", "server", "task-runner.ts");
    expect(chatRunner).toContain("detail: failure.detail");
    expect(taskRunner).toContain("detail: failure.detail");
  });
});

describe("hover 动作条：MessageActionBar 单一来源", () => {
  it("三处消息块都用公共件（chat AI / log AI / chat 用户）", () => {
    expect(countOf(rows, "<MessageActionBar")).toBeGreaterThanOrEqual(3);
  });

  it("宿主容器都挂 MESSAGE_ACTION_HOST（hover 显形 + 定位靠它）", () => {
    expect(countOf(rows, "MESSAGE_ACTION_HOST")).toBeGreaterThanOrEqual(
      countOf(rows, "<MessageActionBar"),
    );
  });

  it("rows 不再自拼动作条 className——视觉契约只许住在公共件里", () => {
    const barClass = "overflow-hidden rounded-md border bg-background";
    expect(rows).not.toContain(barClass);

    const owner = path.join(
      srcDir,
      "components",
      "ui",
      "message-action-bar.tsx",
    );
    const offenders = listSourceFiles(srcDir).filter(
      (f) => f !== owner && readFileSync(f, "utf-8").includes(barClass),
    );
    expect(offenders.map((f) => path.relative(srcDir, f))).toEqual([]);
  });

  it("log 形态补上复制：chat / log 共用同一份 assistantActions", () => {
    expect(countOf(rows, "actions={assistantActions}")).toBeGreaterThanOrEqual(
      2,
    );
    const idx = rows.indexOf("const assistantActions");
    expect(idx).toBeGreaterThan(0);
    const body = rows.slice(idx, idx + 1200);
    expect(body).toContain('key: "copy"');
    expect(body).toContain('key: "share"');
  });

  it("log 形态的动作条不再被「能不能分享到群」按住", () => {
    // 以前是 `isAssistant && canShareToGroup && (<div …>)`——日常任务整条 hover 条不渲染
    expect(rows).not.toContain("isAssistant && canShareToGroup");
  });
});

describe("行动指引类 info（meta.notice）不被压成一行灰字", () => {
  // wk 门禁降级时会写「跳过了、去设置页配文档仓」这种带指引的 info——
  // 细线化 info 是 max-w-[70%] + truncate 的居中小字，指引整段看不见
  it("notice 走默认展开的可见形态、不落细线分支", () => {
    expect(rows).toContain('ev.meta?.notice === true');
    expect(rows).toContain(
      'if (ev.kind === "info" && !isAwaitingAck && !isNotice)',
    );
    expect(rows).toContain("|| isNotice");
  });

  it("数据源还在：wk 门禁的 info 事件带 notice 标", () => {
    const taskRunner = read("lib", "server", "task-runner.ts");
    expect(taskRunner).toContain("meta: { notice: true }");
  });
});

describe("thinking 耗时", () => {
  it("渲染层读 meta.durationMs、走共享格式化", () => {
    expect(rows).toContain("formatDurationPrecise");
    expect(rows).toContain("ev.meta?.durationMs");
  });

  it("数据源还在：mergeAdjacentThinking 累加 durationMs", () => {
    const merge = read("lib", "merge-thinking.ts");
    expect(merge).toContain("durationMs: lastDur + curDur");
  });

  it("工作过程组头改用共享耗时口径、不再自己写一份", () => {
    const workGroup = read(
      "components",
      "tasks",
      "event-stream",
      "work-group.tsx",
    );
    expect(workGroup).toContain("formatDurationCoarse");
    expect(workGroup).not.toContain("Math.floor(totalSec / 60)");
  });
});
