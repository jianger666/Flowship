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
const errorClassifyLib = read("lib", "error-classify.ts");

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
    // EventRowImpl 里 chat 分支的段落标题（用它当锚点最稳）
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
    // detail 与正文相同时不重复放一份（V3-03：判定移进 lib/error-classify.ts 的 buildErrorCardModel，
    // 卡片的 hasDetail 只认它算出的 diagnostic；行为见 tests/error-classify.test.ts）
    expect(errorCard).toContain("buildErrorCardModel(");
    expect(errorCard).toContain("model.diagnostic");
    expect(errorClassifyLib).toContain("det !== bodyTrim");
  });

  it("复制走 CopyButton 公共件、复制内容含原始诊断", () => {
    expect(errorCard).toContain("CopyButton");
    expect(errorCard).toContain("copyText");
    // 分隔标题随判定一起搬进了 lib（复制串由 buildErrorCardModel 拼）
    expect(errorClassifyLib).toContain("ERROR_DETAIL_HEADING");
  });

  it("重试只给当轮失败（isCurrentErrorCard = !mainRunActive && isLatestErrorEvent 把关）、能力由 Context 注入", () => {
    expect(errorCard).toContain("isCurrentErrorCard");
    expect(errorCard).toContain("resolveErrorRecovery");
    expect(errorCard).toContain("useStreamActions");
    expect(errorCard).toContain("onRetryLastMessage");
    // 推进 / action 失败的卡不带「重试」、改「重新推进」
    expect(errorCard).toContain("onReadvance");
    expect(errorCard).toContain("重新推进");
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

describe("飞书群机器人的回复：用户气泡里按 markdown 渲染", () => {
  const userBranch = rows.slice(rows.indexOf("const userMarkdown = isMarkdownUserReply(ev);"));

  it("判定只走 isMarkdownUserReply（与「机器人」徽标同一个口径），不在 rows 里再手写一份", () => {
    expect(rows).toContain("const userMarkdown = isMarkdownUserReply(ev);");
    expect(countOf(rows, "isMarkdownUserReply(")).toBe(1);
    // 没有「真人也走 markdown」的旁路：MarkdownText 的 displayText 只出现在 userMarkdown 分支里
    expect(userBranch).toMatch(/\{userMarkdown \? \(\s*(?:\/\/[^\n]*\n\s*)*<MarkdownText text=\{displayText\} baseDir=\{markdownBaseDir\} blockImages \/>\s*\) : \(\s*<SearchHighlightText ownerId=\{ev\.id\} field="body" text=\{displayText\} \/>/);
  });

  it("markdown 盒不带 whitespace-pre-wrap（否则块间换行再叠一层空行）；段内单个换行按换行显示", () => {
    const mdBox = /const USER_REPLY_MD_TEXT =\s*"([^"]+)"/.exec(rows)?.[1] ?? "";
    expect(mdBox, "找不到 USER_REPLY_MD_TEXT").not.toBe("");
    expect(mdBox).not.toContain("whitespace-pre-wrap");
    expect(mdBox).toContain("[&_p]:whitespace-pre-line");
    // 与纯文本盒同宽、同防长串撑破的几何
    expect(mdBox).toContain("w-full min-w-0 wrap-anywhere text-sm");
    // pre-line 只加在 p 上：li / blockquote 里块与块之间有 remark 插的 "\n" 文本节点，加了会多出空行
    expect(mdBox).not.toMatch(/\[&_li\]|\[&_\*\]|\[&_ul\]/);
  });

  it("不可信来源：机器人消息里的图片不加载（blockImages；远程图 = 追踪像素），槽位由 markdown-text 按开关切换", () => {
    expect(userBranch).toContain("<MarkdownText text={displayText} baseDir={markdownBaseDir} blockImages />");
    const md = readFileSync(path.join(srcDir, "components", "markdown-text.tsx"), "utf-8");
    expect(md).toContain("img: blockImages ? BlockedMarkdownImage : MarkdownImage,");
    expect(md).toContain("buildMarkdownComponents(linker, size, blockImages)");
    expect(md).toContain("blockImages = false,"); // 默认照常加载：AI 回复 / 产物栏不受影响
    // 占位组件自己不许渲染 img / picture / source：净化白名单放行 <source srcSet>，
    // 占位一旦渲染成 <img>（比如做懒加载占位），防护就静默失效
    const blocked = md.slice(md.indexOf("export const BlockedMarkdownImage"), md.indexOf("const buildMarkdownComponents"));
    expect(blocked).toContain("BlockedMarkdownImage");
    expect(blocked).not.toMatch(/<(img|picture|source|video|audio|iframe|object|embed)\b/i);
    expect(blocked).not.toMatch(/\bsrc\b|srcSet/i);
    // AI 回复那处 MarkdownText 不许带 blockImages（那是 AI 自己的输出、有图要显示）
    const assistantTag = /<MarkdownText\s+size=\{isLog[\s\S]*?\/>/.exec(rows)?.[0] ?? "";
    expect(assistantTag).not.toBe("");
    expect(assistantTag).not.toContain("blockImages");
  });

  it("气泡文本盒按 userMarkdown 二选一：markdown 用 USER_REPLY_MD_TEXT、其余仍是 USER_REPLY_TEXT", () => {
    expect(userBranch).toContain("userMarkdown ? USER_REPLY_MD_TEXT : USER_REPLY_TEXT");
  });

  it("折叠：markdown 里的块不吃 line-clamp，改限高 + 溢出隐藏；纯文本仍是 line-clamp-8", () => {
    const collapsed = /const USER_REPLY_MD_COLLAPSED =\s*"([^"]+)"/.exec(rows)?.[1] ?? "";
    expect(collapsed).toContain("max-h-48");
    expect(collapsed).toContain("overflow-hidden");
    expect(userBranch).toContain('userMarkdown ? USER_REPLY_MD_COLLAPSED : "line-clamp-8"');
  });

  it("重发 / 编辑仍用原 ev.text（只改展示，前缀是给 agent 的上下文）", () => {
    expect(rows).toContain("runResend(ev.text, ev)");
    expect(rows).toContain("setEditDraft(ev.text)");
  });
});

describe("hover 动作条：MessageActionBar 单一来源", () => {
  it("对话类消息块都用公共件（AI 回复 chat / log 共用一处渲染 + 用户消息一处）", () => {
    // 事件流 v2 之前是三处 JSX（chat AI / log AI / chat 用户）；task(log) 的 AI 回复并入 chat 的
    // 共用分支后只剩两处——覆盖的场景没少：log 的 AI 回复现在就是走 AI 那一处。
    expect(countOf(rows, "<MessageActionBar")).toBeGreaterThanOrEqual(2);
    // 回归闸：log 不许再长出自己的第二套对话行（旧 log 卡片里的写法）
    expect(rows).not.toContain("isAssistant && <MessageActionBar");
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

  it("动作条不受宿主（气泡）宽度挤压：短消息不会把「回退到这里」竖排", () => {
    // 回归：用户消息很短（如一两个字）时，absolute 的动作条可用宽度 = 气泡宽度 - right 偏移，
    // flex 子项被压窄、文字逐字换行、图标缩成小点。三处缺一不可：
    const bar = readFileSync(
      path.join(srcDir, "components", "ui", "message-action-bar.tsx"),
      "utf-8",
    );
    // 1) 容器取内容宽度（不吃宿主的可用宽度）
    expect(bar).toMatch(/absolute -top-3 right-2[^"]*\bw-max\b/);
    // 2) 按钮文字不换行 + 不被 flex 压缩
    expect(bar).toMatch(/"flex shrink-0[^"]*\bwhitespace-nowrap\b/);
    // 3) 图标不被压缩
    expect(bar).toContain("[&_svg]:shrink-0");
  });

  it("log 形态补上复制：chat / log 的 AI 回复走同一个分支、同一份 assistantActions", () => {
    // 共用分支的入口：chat 全进；log 只放 assistant / user 两种对话类事件进来
    expect(rows).toContain('if (variant === "chat" || isAssistant || isUser)');
    // 动作条只有一处在用 assistantActions——没有第二份拷贝（v2 之前 chat / log 各写一处、≥2）
    expect(countOf(rows, "actions={assistantActions}")).toBe(1);
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
