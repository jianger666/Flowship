/**
 * 「本地音视频展示」提示词段（src/lib/server/media-display-prompt.ts）。
 *
 * 守三件事：
 *   1. 说的和真实解析器 / 真实界面一致——段落里的每个行内代码示例、链接示例，都拿去喂真实的
 *      parseMediaRefToken / extractMediaRefsFromMarkdown / MarkdownText（SSR）：正例必须变成播放入口，
 *      反例必须不变。谁改了解析规则而没改提示词，这里红；
 *   2. 注入点接线对：chat 起手 prompt（真调拼装函数）和任务 super prompt（真调 buildSuperPromptWithBudget，
 *      含预算字节、极小预算也不被裁）都带这一段；群答疑只读 prompt / 其他 prompt 不带，
 *      且全仓只有两个文件引用这个 helper（新增引用方必须有人来改这条测试 = 有人 review）；
 *   3. 篇幅不膨胀：≤ 1200 字节（UTF-8）。
 *
 * 不在这里验证：模型看到这段后是否真的照写（需要真模型，靠手测）、真实界面点击后开播放器（没有 jsdom / 浏览器）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "@/components/markdown-text";
import { MediaMessageScope } from "@/components/media/media-message-scope";
import { ImagePreviewProvider } from "@/components/ui/image-preview";
import { AUDIO_EXTS, VIDEO_EXTS, detectMediaKind } from "@/lib/media/media-kind";
import {
  extractMediaRefsFromMarkdown,
  parseMediaRefToken,
  resolveMediaRef,
} from "@/lib/media/media-ref";
import { __buildChatInitialPromptForTest } from "@/lib/server/chat-runner";
import {
  MEDIA_DISPLAY_PROMPT_TITLE,
  mediaDisplayPromptSection,
} from "@/lib/server/media-display-prompt";
import { buildSuperPromptWithBudget } from "@/lib/server/task-prompts";
import { getTaskCwd } from "@/lib/server/task-worktrees";
import type { Task } from "@/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
const section = mediaDisplayPromptSection();

const render = (md: string, baseDir?: string): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      createElement(
        MediaMessageScope,
        { text: md, baseDir } as never,
        createElement(MarkdownText, { text: md, baseDir }),
      ),
    ),
  );

/** 段落里所有单反引号行内代码（与 media-ref 的 INLINE_CODE_RE 同口径） */
const inlineCodeTokens = (text: string): string[] =>
  [...text.matchAll(/`([^`\n]{1,600})`/g)].map((m) => m[1]!);

describe("篇幅", () => {
  it("≤ 1200 字节（UTF-8），防止这段提示词悄悄膨胀", () => {
    const bytes = Buffer.byteLength(section, "utf-8");
    expect(bytes).toBeLessThanOrEqual(1200);
    // 下限只是防「被掏空」：核心内容（写法 + 时间段 + 反例）至少这么多
    expect(bytes).toBeGreaterThan(600);
  });

  it("以固定标题开头（chat / task 注入位置的断言靠它定位）", () => {
    expect(section.startsWith(MEDIA_DISPLAY_PROMPT_TITLE)).toBe(true);
  });
});

describe("扩展名清单 = 真实支持的扩展名", () => {
  const supportLine = section.split("\n").find((l) => l.startsWith("- 支持："));

  it("「支持」那一行列出的扩展名恰好是 VIDEO_EXTS ∪ AUDIO_EXTS（插值而非手写，两边不漂移）", () => {
    expect(supportLine).toBeTruthy();
    const listed = supportLine!.slice("- 支持：".length).split("（")[0]!.trim().split(/\s+/);
    expect(new Set(listed)).toEqual(new Set([...VIDEO_EXTS, ...AUDIO_EXTS]));
    expect(listed).toHaveLength(new Set(listed).size);
  });

  it("列出的每个扩展名真实被识别为音视频；提示词点名「不会变成播放器」的 mkv / avi 真的不认", () => {
    for (const ext of [...VIDEO_EXTS, ...AUDIO_EXTS]) {
      expect(detectMediaKind(`/Users/xxx/a.${ext}`), ext).not.toBeNull();
      expect(parseMediaRefToken(`/Users/xxx/a.${ext}`), ext).not.toBeNull();
    }
    expect(supportLine).toContain("mkv / avi 不会变成播放器");
    for (const ext of ["mkv", "avi"]) {
      expect(parseMediaRefToken(`/Users/xxx/a.${ext}`), ext).toBeNull();
    }
  });
});

describe("示例与真实解析器对齐（行内代码）", () => {
  const POSITIVE = [
    "/Users/xxx/out/preview_720p.mp4",
    "/Users/xxx/a.mp4#t=12.4,15",
    "/Users/xxx/a.mp4#t=12.4",
  ];
  const NEGATIVE = ["a.mp4", "~/Movies/a.mp4", "#t=起,止"];

  it("段落里的行内代码示例恰好是这几个（新增 / 改示例必须同步改这条测试）", () => {
    expect(new Set(inlineCodeTokens(section))).toEqual(new Set([...POSITIVE, ...NEGATIVE]));
  });

  it("正例：parseMediaRefToken + resolveMediaRef 认得，时间片段按提示词说的解析（起点、止点）", () => {
    const [plain, range, startOnly] = POSITIVE.map((t) => {
      const ref = parseMediaRefToken(t);
      expect(ref, t).not.toBeNull();
      const resolved = resolveMediaRef(ref!);
      expect(resolved, t).not.toBeNull();
      return resolved!;
    });
    expect(plain!.absolute).toBe("/Users/xxx/out/preview_720p.mp4");
    expect(plain!.start).toBeUndefined();
    expect(range!.absolute).toBe("/Users/xxx/a.mp4");
    expect(range!.start).toBe(12.4);
    expect(range!.end).toBe(15);
    expect(startOnly!.start).toBe(12.4);
    expect(startOnly!.end).toBeUndefined();
  });

  it("反例：裸文件名 / ~ 开头 / 模板占位都不认（提示词叫模型别这么写）", () => {
    for (const t of NEGATIVE) expect(parseMediaRefToken(t), t).toBeNull();
  });

  it("相对路径：带目录的行内代码按 baseDir 解析成绝对路径（提示词说「按任务工作目录解析」）", () => {
    const ref = parseMediaRefToken("out/final.mp4#t=5");
    expect(ref).not.toBeNull();
    expect(resolveMediaRef(ref!, "/Users/me/proj")?.absolute).toBe("/Users/me/proj/out/final.mp4");
    expect(resolveMediaRef(ref!)).toBeNull();
  });

  it("真实 MarkdownText 渲染：每个正例都是播放入口（按钮），每个反例都是普通 <code>", () => {
    for (const t of POSITIVE) {
      const html = render(`\`${t}\``);
      expect(html, t).toContain("<button");
      expect(html, t).toContain("lucide-play");
    }
    for (const t of NEGATIVE) {
      const html = render(`\`${t}\``);
      expect(html, t).not.toContain("lucide-play");
      expect(html, t).not.toContain("data-media-strip");
    }
    // 时间片段徽标 = 提示词里「从起点播到止点」的入口侧证据
    expect(render(`\`${POSITIVE[1]}\``)).toContain("00:12.4–00:15.0");
    expect(render(`\`${POSITIVE[2]}\``)).toContain("00:12.4");
  });
});

describe("示例与真实解析器对齐（markdown 链接）", () => {
  it("段落里的链接示例 [成片](/Users/xxx/out/final.mp4) 真实渲染成播放入口", () => {
    const m = /\[([^\]]+)\]\((\/[^)\s]+)\)/.exec(section);
    expect(m).not.toBeNull();
    const html = render(`[${m![1]}](${m![2]})`);
    expect(html).toContain("<button");
    expect(html).toContain(m![1]!);
  });

  it("「链接只认绝对路径」：相对路径的链接不会变成链接入口（点击侧不带 baseDir）", () => {
    expect(section).toContain("链接只认绝对路径");
    const html = render("[成片](out/final.mp4)", "/Users/me/proj");
    // 链接本身不是播放按钮；文字仍在
    expect(html).not.toMatch(/<button[^>]*>[^<]*成片/);
  });
});

describe("示例与真实解析器对齐（整段喂 extractMediaRefsFromMarkdown）", () => {
  it("整段提示词里能提取出的音视频恰好是 3 个文件示例（同一个 a.mp4 只算一次，取第一次的区间）", () => {
    const refs = extractMediaRefsFromMarkdown(section);
    expect(refs.map((r) => r.absolute)).toEqual([
      "/Users/xxx/out/preview_720p.mp4",
      "/Users/xxx/out/final.mp4",
      "/Users/xxx/a.mp4",
    ]);
    const a = refs[2]!;
    expect(a.start).toBe(12.4);
    expect(a.end).toBe(15);
  });
});

describe("反例里点名的写法确实不会变成播放器（提示词没有说假话）", () => {
  it("围栏代码块里的路径不提取、不渲染成入口", () => {
    const md = "```\n/Users/xxx/a.mp4\n```";
    expect(extractMediaRefsFromMarkdown(md)).toEqual([]);
    expect(render(md)).not.toContain("lucide-play");
  });

  it("http(s) 的 .mp4（行内代码或链接）不是本地播放入口——parseMediaRefToken 单看字符串会放行，但 resolveMediaRef 拒绝，整条链路不出入口", () => {
    const url = "https://example.com/a.mp4";
    for (const base of [undefined, "/Users/me/proj"]) {
      const ref = parseMediaRefToken(url);
      expect(ref === null || resolveMediaRef(ref, base) === null).toBe(true);
      expect(extractMediaRefsFromMarkdown(`\`${url}\``, base)).toEqual([]);
      expect(extractMediaRefsFromMarkdown(`[远程](${url})`, base)).toEqual([]);
      expect(render(`\`${url}\``, base)).not.toContain("lucide-play");
      expect(render(`[远程](${url})`, base)).not.toContain("lucide-play");
    }
  });
});

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

const chatTaskFixture = (): Task =>
  ({
    id: "t_media_prompt_chat",
    title: "media prompt chat",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: 1,
    updatedAt: 1,
    events: [],
  }) as unknown as Task;

describe("chat 起手 prompt（真调 buildInitialPrompt）", () => {
  const build = (historyTurns = 0) =>
    __buildChatInitialPromptForTest(
      chatTaskFixture(),
      [],
      "（用户规则占位）",
      { text: "帮我看看这个视频" },
      "",
      "",
      "",
      "",
      false,
      {
        turns: Array.from({ length: historyTurns }, (_, i) => ({
          kind: i % 2 === 0 ? ("user_reply" as const) : ("assistant_message" as const),
          text: `历史 ${i}`,
        })),
        truncated: false,
      },
    );

  it("带这一段，且位置在 Skills 段之后、「任务 cwd」之前、用户消息之前", () => {
    const p = build();
    expect(p).toContain(section);
    const iSkills = p.indexOf("## Skills（Flowship 自带能力扩展）");
    const iMedia = p.indexOf(MEDIA_DISPLAY_PROMPT_TITLE);
    const iCwd = p.indexOf("## 任务 cwd");
    const iUser = p.indexOf("## 用户的第一条消息");
    expect(iSkills).toBeGreaterThanOrEqual(0);
    expect(iMedia).toBeGreaterThan(iSkills);
    expect(iCwd).toBeGreaterThan(iMedia);
    expect(iUser).toBeGreaterThan(iCwd);
    // 只注入一份
    expect(p.split(MEDIA_DISPLAY_PROMPT_TITLE)).toHaveLength(2);
  });

  it("会话重建 / 接续历史时（historyInject 非空）同样带这一段——buildInitialPrompt 是 chat 唯一的起手拼装点", () => {
    const p = build(2);
    expect(p).toContain(section);
    expect(p.split(MEDIA_DISPLAY_PROMPT_TITLE)).toHaveLength(2);
    expect(p).toContain("## 用户的新消息");
  });

  it("chat-runner 里只有一处调 buildInitialPrompt（没有第二个起手拼装点漏注入）", () => {
    const src = readSrc("src/lib/server/chat-runner.ts");
    const calls = src.match(/\bbuildInitialPrompt\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

describe("任务 super prompt（真调 buildSuperPromptWithBudget）", () => {
  const taskFixture = (): Task =>
    ({ ...chatTaskFixture(), id: "t_media_prompt_task", mode: "task" }) as unknown as Task;
  const firstAction = () => ({
    action: {
      id: "act_1",
      n: 1,
      type: "plan",
      status: "pending",
      userInstruction: "",
      artifactPath: "actions/1-plan.md",
      startedAt: null,
      endedAt: null,
    } as never,
    userInstruction: "",
  });
  const build = (budget?: number) =>
    buildSuperPromptWithBudget(taskFixture(), [], firstAction(), "", "", "", "", budget);

  it("sharedRules 末尾带这一段（整段原文，不是手抄的近似）", async () => {
    const r = await build();
    expect(r.prompt).toContain(section);
    expect(r.prompt.split(MEDIA_DISPLAY_PROMPT_TITLE)).toHaveLength(2);
  });

  it("字节精确计入 sharedRules（L1）预算统计：= 填充后的 _shared.md（去尾部空白）+ 两个换行 + 本段 + 结尾换行", async () => {
    const r = await build();
    const task = taskFixture();
    // 与 loadSharedPrompt 同口径填模板（_shared.md 只用 {{repoPath}} / {{taskId}}，protocol-signals 测试对账过）
    const filled = readSrc("prompts/_shared.md")
      .replaceAll("{{repoPath}}", getTaskCwd(task).trim())
      .replaceAll("{{taskId}}", task.id);
    expect(filled).not.toMatch(/\{\{\w+\}\}/);
    const expected = Buffer.byteLength(`${filled.replace(/\s+$/, "")}\n\n${section}\n`, "utf-8");
    expect(r.perSectionBytes["sharedRules"]).toBe(expected);
    // 总字节也确实包含它
    expect(r.totalBytes).toBeGreaterThan(expected);
  });

  it("预算极小时 L1 的 sharedRules 不被裁——这一段还在", async () => {
    const r = await build(1);
    expect(r.dropped.map((d) => d.name)).not.toContain("sharedRules");
    expect(r.prompt).toContain(section);
  });

  it("_shared.md 不手抄这一段，只在 §3 第 5 条加一句指向它的例外（防两处漂移）", () => {
    const md = readSrc("prompts/_shared.md");
    expect(md).not.toContain(MEDIA_DISPLAY_PROMPT_TITLE);
    expect(md).toContain("例外：引用本机音视频文件");
    expect(md).toContain("本地音视频展示");
  });
});

describe("不该注入的地方没注入", () => {
  it("全仓只有 chat-runner 与 task-prompts 引用这个 helper（新增引用方要来改这条测试）", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, "utf-8").includes("media-display-prompt")) {
          hits.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(hits.sort()).toEqual([
      "src/lib/server/chat-runner.ts",
      "src/lib/server/media-display-prompt.ts",
      "src/lib/server/task-prompts.ts",
    ]);
  });

  it("飞书群答疑只读 prompt（restricted-question / group-reply-protocol）既不引用也不含这一段", async () => {
    for (const rel of [
      "src/lib/server/restricted-question.ts",
      "src/lib/server/feishu-bridge/group-reply-protocol.ts",
    ]) {
      expect(readSrc(rel), rel).not.toContain("media-display-prompt");
      expect(readSrc(rel), rel).not.toContain("mediaDisplayPromptSection");
    }
    const { buildGroupReplyRules } = await import("@/lib/server/feishu-bridge/group-reply-protocol");
    const rules = buildGroupReplyRules({ requesterIsBot: false }).join("\n");
    expect(rules).not.toContain(MEDIA_DISPLAY_PROMPT_TITLE);
    expect(rules).not.toContain("本地音视频展示");
  });
});
