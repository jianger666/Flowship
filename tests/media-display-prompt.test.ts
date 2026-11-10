/**
 * 「本地文件展示」提示词段（src/lib/server/media-display-prompt.ts）+ 平台 skill（skills/media-playback/SKILL.md）。
 *
 * R7-02 之后的分工：主提示词只留一句**通用核心规则**（完整绝对路径的行内代码；别只写文件名；别用 open / open -R 弹窗口），
 * 细节（时间段 / 成组 / 支持格式 / 反例）在 skill 里。R7-15 把范围从「音频 / 视频」放宽到「展示 / 交付给用户的本机文件」
 * （图片 / 文档 / 网页…也一样要写完整绝对路径），并用真 looksLikePath / resolveLocalFileAbsolute 钉住「为什么必须是绝对路径」。
 * 守这几件事：
 *   1. 主提示词：通用表述（不含「听 / 试听 / 下载 / 封面 / 截图」这类场景词）、有指向 skill 的一句、篇幅 ≤ 700 字节；
 *   2. skill：示例必须是真解析器认的——正例喂真实的 parseMediaRefToken / resolveMediaRef / extractMediaRefsFromMarkdown / MarkdownText（SSR）
 *      必须变成播放入口，反例必须不变；扩展名清单与 VIDEO_EXTS / AUDIO_EXTS 对账（谁改了解析规则 / 支持格式而没改 skill 会红）；
 *      「先给目录、再列一串文件名」的反例必须写清；
 *   3. 接线对：chat 起手 prompt（真调拼装函数）和任务 super prompt（真调 buildSuperPromptWithBudget，含预算字节、极小预算也不被裁）
 *      都带主提示词；skill 在 chat / task 的 skill 索引里可见、随包；群答疑只读 prompt / 其他 prompt 不带，
 *      且全仓只有两个文件引用这个 helper（新增引用方必须有人来改这条测试 = 有人 review）。
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
import {
  LocalFilePreviewContext,
  resolveLocalFileAbsolute,
} from "@/components/ui/local-file-preview-context";
import { AUDIO_EXTS, VIDEO_EXTS, detectMediaKind } from "@/lib/media/media-kind";
import {
  extractMediaRefsFromMarkdown,
  parseMediaRefToken,
  resolveMediaRef,
} from "@/lib/media/media-ref";
import { looksLikePath } from "@/lib/path-utils";
import { __buildChatInitialPromptForTest } from "@/lib/server/chat-runner";
import {
  MEDIA_DISPLAY_PROMPT_TITLE,
  MEDIA_DISPLAY_SKILL_NAME,
  mediaDisplayPromptSection,
} from "@/lib/server/media-display-prompt";
import { loadSkills, renderSkillsForPrompt, scanSkillsDir } from "@/lib/server/skills-loader";
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

/** 主提示词里「写成路径」的示例（不含命令 / skill 名 / `~/` 反例） */
const EXAMPLE_PATHS = ["/Users/xxx/out/final.mp4", "/Users/xxx/out/result.jpg"];

describe("主提示词：通用核心规则", () => {
  it("≤ 700 字节（UTF-8）：范围放宽后的上限；细节进 skill，别又塞回来", () => {
    const bytes = Buffer.byteLength(section, "utf-8");
    expect(bytes).toBeLessThanOrEqual(700);
    // 下限只是防「被掏空」：核心规则 + 反例 + 指向 skill 的一句至少这么多
    expect(bytes).toBeGreaterThan(250);
  });

  it("以固定标题开头（chat / task 注入位置的断言靠它定位）；标题是「本地文件展示」，不再只说音视频", () => {
    expect(section.startsWith(MEDIA_DISPLAY_PROMPT_TITLE)).toBe(true);
    expect(MEDIA_DISPLAY_PROMPT_TITLE).toContain("本地文件展示");
    expect(MEDIA_DISPLAY_PROMPT_TITLE).not.toContain("音视频");
  });

  it("范围：展示 / 交付给用户的本机文件（图片 / 音视频 / 文档 / 网页 / 导出文件），不只是音频 / 视频", () => {
    expect(section).toContain("向用户展示 / 交付本机文件");
    for (const kind of ["图片", "音视频", "文档", "网页", "导出文件"]) expect(section, kind).toContain(kind);
    // 不能退回「只管音频 / 视频」的老写法
    expect(section).not.toContain("音频 / 视频文件");
  });

  it("核心规则：完整绝对路径 + 行内代码 + 别只写文件名 + 别先给目录再列文件名 + 别 `~/` + 别用 open / open -R 弹窗口，并指向 skill", () => {
    expect(section).toContain("完整绝对路径");
    expect(section).toContain("行内代码");
    expect(section).toContain("不要只写文件名");
    expect(section).toContain("不要「先给目录、再列一串文件名」");
    expect(section).toContain("不要 `~/` 开头");
    expect(section).toContain("`open`");
    expect(section).toContain("`open -R`");
    expect(section).toContain(`skill \`${MEDIA_DISPLAY_SKILL_NAME}\``);
    expect(MEDIA_DISPLAY_SKILL_NAME).toBe("media-playback");
  });

  it("是通用表述：不针对任何场景 / 用词（不含「听 / 试听 / 下载 / 目录里 / 封面 / 截图」这类场景词）", () => {
    expect(section).not.toMatch(/听|试听|下载|目录里|成片放哪|给我|封面|截图/);
    // 也不把 skill 里的细节搬回来（时间段 / 成组 / 格式清单 / 反例清单）
    expect(section).not.toMatch(/#t=|数字键|H\.264|HEVC|mkv|围栏|http/);
  });

  it("行内代码示例：mp4 与 jpg 各一个；命令 / skill 名 / `~/` 是反例，不是路径", () => {
    const tokens = inlineCodeTokens(section);
    expect(new Set(tokens)).toEqual(
      new Set([...EXAMPLE_PATHS, "~/", "open", "open -R", MEDIA_DISPLAY_SKILL_NAME]),
    );
    // mp4 被真媒体解析器认、jpg 不是媒体
    const ref = parseMediaRefToken("/Users/xxx/out/final.mp4");
    expect(ref).not.toBeNull();
    expect(resolveMediaRef(ref!)?.absolute).toBe("/Users/xxx/out/final.mp4");
    expect(parseMediaRefToken("/Users/xxx/out/result.jpg")).toBeNull();
    for (const t of ["~/", "open", "open -R", MEDIA_DISPLAY_SKILL_NAME]) expect(parseMediaRefToken(t), t).toBeNull();
    const html = render("`/Users/xxx/out/final.mp4`");
    expect(html).toContain("<button");
    expect(html).toContain("lucide-play");
  });

  it("整段喂 extractMediaRefsFromMarkdown：只有 mp4 示例是媒体（jpg 走普通文件链接，不进媒体卡片）", () => {
    expect(extractMediaRefsFromMarkdown(section).map((r) => r.absolute)).toEqual(["/Users/xxx/out/final.mp4"]);
  });
});

// ---------------------------------------------------------------------------
// R7-15：为什么必须是「完整绝对路径」——示例喂真 looksLikePath / resolveLocalFileAbsolute，
// 反例（裸文件名 / 相对路径 / `~/`）钉住真实的解析行为：谁改了解析规则，这里会红
// ---------------------------------------------------------------------------

describe("R7-15：绝对路径是唯一可靠的写法（真 looksLikePath + resolveLocalFileAbsolute）", () => {
  const CWD = "/Users/me/task";

  it("主提示词里每个路径示例：looksLikePath 为真；解析出的绝对路径恰好等于原路径（有无 baseDir 都一样，不依赖任务 cwd）", () => {
    expect(EXAMPLE_PATHS.length).toBeGreaterThanOrEqual(2);
    for (const p of EXAMPLE_PATHS) {
      expect(looksLikePath(p), p).toBe(true);
      expect(resolveLocalFileAbsolute(p)?.absolute, p).toBe(p);
      expect(resolveLocalFileAbsolute(p, CWD)?.absolute, p).toBe(p);
    }
    // 且示例确实出现在主提示词的行内代码里（不是测试自己编的）
    for (const p of EXAMPLE_PATHS) expect(inlineCodeTokens(section), p).toContain(p);
  });

  /** 普通文件链接（LocalFileLink）要读 LocalFilePreviewContext：给一个什么都不做的桩 */
  const renderWithPreview = (md: string, baseDir?: string): string =>
    renderToStaticMarkup(
      createElement(
        LocalFilePreviewContext.Provider,
        { value: { open: () => {}, ide: "cursor" } },
        createElement(
          ImagePreviewProvider,
          null,
          createElement(MediaMessageScope, { text: md, baseDir } as never, createElement(MarkdownText, { text: md, baseDir })),
        ),
      ),
    );

  it("示例路径真渲染：mp4 是播放入口，jpg 变成可点的文件链接（不是普通 <code>）", () => {
    const mp4 = renderWithPreview("`/Users/xxx/out/final.mp4`", CWD);
    expect(mp4).toContain("lucide-play");
    const jpg = renderWithPreview("`/Users/xxx/out/result.jpg`", CWD);
    expect(jpg).not.toContain("<code");
    expect(jpg).not.toContain("lucide-play");
    expect(jpg).toContain("result.jpg");
    expect(jpg).toMatch(/<a[ >]|<button/);
  });

  it("含空格的绝对路径也成立（文档 / 带空格目录），不需要为它换写法", () => {
    const p = "/Users/xxx/My Docs/报告 终稿.pdf";
    expect(looksLikePath(p)).toBe(true);
    expect(resolveLocalFileAbsolute(p, CWD)?.absolute).toBe(p);
  });

  it("反例 1：裸文件名不是路径（没有目录信息）——渲染成普通 <code>，没有任何链接", () => {
    for (const name of ["封面_抖音_竖3x4.jpg", "封面_B站_横16x9.jpg", "马配跑-1440x2560.jpg"]) {
      expect(looksLikePath(name), name).toBe(false);
      const html = renderWithPreview(`\`${name}\``, CWD);
      expect(html, name).toContain("<code");
      expect(html, name).not.toMatch(/<a[ >]|<button/);
    }
  });

  it("反例 2：相对路径按任务 cwd 解析——文件若不在任务目录里就指错地方；没有 baseDir 时根本解析不了", () => {
    const rel = "out/封面_抖音_竖3x4.jpg";
    expect(looksLikePath(rel)).toBe(true);
    expect(resolveLocalFileAbsolute(rel)).toBeNull();
    expect(resolveLocalFileAbsolute(rel, CWD)?.absolute).toBe(`${CWD}/${rel}`);
    expect(resolveLocalFileAbsolute(rel, CWD)?.absolute).not.toBe(`/Users/xxx/marathon/${rel}`);
  });

  it("反例 3：`~/` 不展开——解析成 <任务 cwd>/~/…（指错地方），所以提示词明写「不要 ~/ 开头」", () => {
    const home = "~/Movies/封面.jpg";
    expect(looksLikePath(home)).toBe(true);
    expect(resolveLocalFileAbsolute(home, CWD)?.absolute).toBe(`${CWD}/~/Movies/封面.jpg`);
    expect(resolveLocalFileAbsolute(home, CWD)?.absolute).not.toBe("/Users/me/Movies/封面.jpg");
    expect(resolveLocalFileAbsolute(home)).toBeNull();
  });

  it("「先给目录、再列文件名」：目录不是文件、文件名不是路径——两头都点不开；每个文件都写完整路径才行", () => {
    expect(looksLikePath("/Users/xxx/marathon/")).toBe(false);
    expect(looksLikePath("封面_抖音_竖3x4.jpg")).toBe(false);
    for (const f of ["封面_抖音_竖3x4.jpg", "封面_抖音_横4x3.jpg"]) {
      const full = `/Users/xxx/marathon/${f}`;
      expect(looksLikePath(full), full).toBe(true);
      expect(resolveLocalFileAbsolute(full, CWD)?.absolute, full).toBe(full);
    }
  });
});

// ---------------------------------------------------------------------------
// skill：skills/media-playback/SKILL.md
// ---------------------------------------------------------------------------

const SKILL_REL = `skills/${MEDIA_DISPLAY_SKILL_NAME}/SKILL.md`;
const skillText = readSrc(SKILL_REL);
/** 去掉 front matter 的正文 */
const skillBody = skillText.replace(/^---\n[\s\S]*?\n---\n/, "");
/** 按「## 标题」取一节（到下一个同级 / 更高级标题为止；子标题 ### 属于本节） */
const skillSection = (heading: string): string => {
  const start = skillBody.indexOf(`\n## ${heading}`);
  expect(start, `缺少「## ${heading}」`).toBeGreaterThanOrEqual(0);
  const rest = skillBody.slice(start + 1);
  const next = rest.slice(3).search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next + 3);
};
/** 一节里的行内代码 token */
const tokensIn = (text: string): string[] => [...text.matchAll(/`([^`\n]{1,600})`/g)].map((m) => m[1]!);
/** 与整条链路同口径：「不会变成播放入口」= parse 不认，或认了但 resolve 拒绝（http 链接 / ~ 开头等） */
const isPlayable = (token: string, baseDir?: string): boolean => {
  const ref = parseMediaRefToken(token);
  return ref !== null && resolveMediaRef(ref, baseDir) !== null;
};

describe("skill：media-playback（细节都在这里）", () => {
  it("front matter：name 与主提示词指向的一致；description 是语义描述（做什么、什么时候读），不是关键词表", async () => {
    const entries = await scanSkillsDir(path.join(ROOT, "skills"));
    const entry = entries.find((e) => e.name === MEDIA_DISPLAY_SKILL_NAME);
    expect(entry, "skills-loader 扫不到 media-playback").toBeTruthy();
    expect(entry!.absPath).toBe(path.join(ROOT, SKILL_REL));
    expect(entry!.description.length).toBeGreaterThan(40);
    expect(entry!.description.length).toBeLessThan(400);
    expect(entry!.description).toContain("展示");
    // 不是「听 / 试听 / 下载」之类的关键词罗列
    expect(entry!.description).not.toMatch(/听|试听|下载/);
    expect(entry!.description).not.toMatch(/关键词|触发词/);
  });

  it("R7-15：skill 说明范围是「本机文件」，不是只管音视频（description + 开头一段都写了图片 / 文档 / 网页同样适用核心规则）", async () => {
    const entry = (await scanSkillsDir(path.join(ROOT, "skills"))).find((e) => e.name === MEDIA_DISPLAY_SKILL_NAME)!;
    expect(entry.description).toContain("本机文件");
    for (const kind of ["音视频", "图片", "文档", "网页"]) expect(entry.description, kind).toContain(kind);
    expect(skillBody).toMatch(/^\s*# 本地文件展示/);
    // 开头（核心规则之前）那一段：其它文件同样适用核心规则、只是没有播放器
    const intro = skillBody.slice(0, skillBody.indexOf("\n## 核心规则"));
    expect(intro).toContain("图片、文档、网页等其它文件**同样适用下面的核心规则**");
    expect(intro).toContain("完整绝对路径");
    expect(intro).toContain("没有播放器");
  });

  it("扩展名清单（标记块内）恰好是 VIDEO_EXTS ∪ AUDIO_EXTS——不手写成会漂移的清单，改了支持格式而没改 skill 会红", () => {
    const m = /<!-- media-exts:start -->\s*([\s\S]*?)\s*<!-- media-exts:end -->/.exec(skillText);
    expect(m, "缺少 media-exts 标记块").not.toBeNull();
    const listed = m![1]!.trim().split(/\s+/);
    expect(new Set(listed)).toEqual(new Set([...VIDEO_EXTS, ...AUDIO_EXTS]));
    expect(listed).toHaveLength(new Set(listed).size);
    for (const ext of listed) {
      expect(detectMediaKind(`/Users/xxx/a.${ext}`), ext).not.toBeNull();
      expect(isPlayable(`/Users/xxx/a.${ext}`), ext).toBe(true);
    }
  });

  it("格式说明：mkv / avi 不会变成播放器（真的不认）；HEVC 与 H.264 + AAC 的建议都写了", () => {
    const fmt = skillSection("支持的格式");
    expect(fmt).toContain("mkv / avi 不会变成播放器");
    expect(fmt).toContain("H.264 + AAC");
    expect(fmt).toContain("HEVC");
    for (const ext of ["mkv", "avi"]) expect(isPlayable(`/Users/xxx/a.${ext}`), ext).toBe(false);
  });

  it("「正确写法」一节里的行内代码示例全部是绝对路径、且被真解析器认（不依赖 baseDir）；时间段按说明解析", () => {
    const good = skillSection("正确写法");
    const tokens = tokensIn(good);
    expect(tokens.length).toBeGreaterThanOrEqual(6);
    // R7-15 收敛后：示例里不再有相对路径——全是绝对路径，有无 baseDir 都认
    expect(tokens.filter((x) => !x.startsWith("/"))).toEqual([]);
    for (const t of tokens) {
      expect(isPlayable(t), t).toBe(true);
      expect(isPlayable(t, "/Users/me/proj"), t).toBe(true);
    }
    // 时间段
    const range = resolveMediaRef(parseMediaRefToken("/Users/xxx/out/a.mp4#t=12.4,15")!);
    expect(range).toMatchObject({ absolute: "/Users/xxx/out/a.mp4", start: 12.4, end: 15 });
    const startOnly = resolveMediaRef(parseMediaRefToken("/Users/xxx/out/a.mp4#t=12.4")!);
    expect(startOnly?.start).toBe(12.4);
    expect(startOnly?.end).toBeUndefined();
    expect(tokens).toContain("/Users/xxx/out/a.mp4#t=12.4,15");
    expect(tokens).toContain("/Users/xxx/out/a.mp4#t=12.4");
  });

  it("「正确写法」里「每个文件各写完整路径」的多文件示例：三个文件都被提取（成组）", () => {
    const good = skillSection("正确写法");
    const refs = extractMediaRefsFromMarkdown(good, "/Users/me/proj").map((r) => r.absolute);
    for (const f of ["v1.mp3", "v2.mp3", "v3.mp3"]) expect(refs).toContain(`/Users/xxx/out/${f}`);
    expect(refs).toContain("/Users/xxx/out/final.mp4"); // 行内代码 + markdown 链接是同一个文件，只算一次
    // 示例全是绝对路径：传不传 baseDir 提取结果一样（没有任何一条是靠 baseDir 拼出来的）
    expect(extractMediaRefsFromMarkdown(good, undefined).map((r) => r.absolute).sort()).toEqual([...refs].sort());
  });

  it("相对路径：skill 写的是「一律写绝对路径、不要用相对路径」；断言直接问解析器（不依赖 skill 里某句话的示例）", () => {
    const good = skillSection("正确写法");
    expect(good).toContain("**一律写绝对路径**");
    expect(good).toContain("相对路径只有文件恰好在任务工作目录下才解析得对，不要用");
    // 不再有「相对路径也可以 / 必须带目录」这类放行说法
    expect(good).not.toContain("必须带目录");
    expect(good).not.toContain("拿不准就写绝对路径");
    // 解析器本身：没有 baseDir 解析不了；有 baseDir 就拼到任务目录下（「恰好在任务目录下才对」的由来）
    expect(isPlayable("out/final.mp4")).toBe(false);
    expect(isPlayable("out/final.mp4", "/Users/me/proj")).toBe(true);
    expect(resolveMediaRef(parseMediaRefToken("out/final.mp4")!, "/Users/me/proj")?.absolute).toBe("/Users/me/proj/out/final.mp4");
    // 文件不在任务目录里时，相对路径指错地方；绝对路径不受 baseDir 影响
    expect(resolveMediaRef(parseMediaRefToken("/Users/xxx/out/final.mp4")!, "/Users/me/proj")?.absolute).toBe("/Users/xxx/out/final.mp4");
  });

  it("markdown 链接示例 [成片](/Users/xxx/out/final.mp4) 真实渲染成播放入口；真 MarkdownText 渲染行内示例", () => {
    const good = skillSection("正确写法");
    const m = /\[([^\]]+)\]\((\/[^)\s]+)\)/.exec(good);
    expect(m).not.toBeNull();
    const html = render(`[${m![1]}](${m![2]})`);
    expect(html).toContain("<button");
    expect(html).toContain(m![1]!);
    for (const t of ["/Users/xxx/out/final.mp4", "/Users/xxx/out/a.mp4#t=12.4,15"]) {
      expect(render(`\`${t}\``), t).toContain("lucide-play");
    }
    expect(render("`/Users/xxx/out/a.mp4#t=12.4,15`")).toContain("00:12.4–00:15.0");
  });

  it("「常见错误」一节里的行内代码示例全部不是播放入口（点名的写法没有说假话）", () => {
    const bad = skillSection("常见错误");
    const tokens = tokensIn(bad);
    expect(tokens.length).toBeGreaterThanOrEqual(6);
    for (const t of tokens) expect(isPlayable(t, "/Users/me/proj"), t).toBe(false);
    // 点名的几种写法都在
    for (const needle of ["final.mp4", "~/Movies/a.mp4", "https://example.com/a.mp4", "#t=起,止"]) expect(tokens, needle).toContain(needle);
    // 目录 + 文件名清单：目录不是媒体、裸文件名都不认
    for (const t of ["/Users/xxx/out/", "v1.mp3", "v2.mp3"]) expect(tokens, t).toContain(t);
  });

  it("相对路径链接 [成片](out/final.mp4) 不会变成链接入口（skill 的反例属实）", () => {
    expect(skillSection("常见错误")).toContain("[成片](out/final.mp4)");
    const html = render("[成片](out/final.mp4)", "/Users/me/proj");
    expect(html).not.toMatch(/<button[^>]*>[^<]*成片/);
    expect(extractMediaRefsFromMarkdown("[成片](out/final.mp4)", undefined)).toEqual([]);
  });

  it("围栏代码块里的路径不提取、不渲染成入口；http(s) 的 .mp4 也不出入口（skill 的反例属实）", () => {
    const md = "```\n/Users/xxx/a.mp4\n```";
    expect(extractMediaRefsFromMarkdown(md)).toEqual([]);
    expect(render(md)).not.toContain("lucide-play");
    const url = "https://example.com/a.mp4";
    for (const base of [undefined, "/Users/me/proj"]) {
      expect(extractMediaRefsFromMarkdown(`\`${url}\``, base)).toEqual([]);
      expect(extractMediaRefsFromMarkdown(`[远程](${url})`, base)).toEqual([]);
      expect(render(`\`${url}\``, base)).not.toContain("lucide-play");
    }
  });

  it("「先给目录、再列一串文件名」的反例写清了：每个文件都要写完整路径（主规则里也有）", () => {
    const core = skillSection("核心规则");
    expect(core).toContain("完整绝对路径"); // 核心规则句本身（skill 开头段也写了一遍，这里单独钉）
    expect(core).toContain("每个文件都要写完整路径");
    expect(core).toContain("先给一个目录，再列一串文件名");
    expect(core).toContain("不要只写文件名");
    expect(core).toContain("`open` / `open -R`");
    expect(skillSection("常见错误")).toContain("先给目录、再列一串文件名");
  });

  it("成组对比 / 末尾媒体卡片的说明保留（原提示词里验证过的两句）", () => {
    const good = skillSection("正确写法");
    expect(good).toContain("同一条回复里的多个音视频自动成组");
    expect(good).toContain("数字键 1–9");
    expect(good).toContain("末尾会自动出媒体卡片");
  });
});

describe("skill 在 chat / task 的 skill 索引里可见、随包", () => {
  it("skills-loader 的内置目录扫得到（loadSkills 含 media-playback，且是平台内置源）", async () => {
    const all = await loadSkills();
    const hit = all.find((e) => e.name === MEDIA_DISPLAY_SKILL_NAME);
    expect(hit).toBeTruthy();
    expect(hit!.absPath).toBe(path.join(ROOT, SKILL_REL));
  });

  it("chat 起手 prompt 的 Skills 段里有它（名字 + 路径），且主提示词里指向它", async () => {
    const entry = (await scanSkillsDir(path.join(ROOT, "skills"))).find((e) => e.name === MEDIA_DISPLAY_SKILL_NAME)!;
    const p = __buildChatInitialPromptForTest(
      chatTaskFixture(),
      [entry],
      "（用户规则占位）",
      { text: "x" },
      "",
      "",
      "",
      "",
      false,
      { turns: [], truncated: false },
    );
    expect(p).toContain(`- **${MEDIA_DISPLAY_SKILL_NAME}**`);
    expect(p).toContain(`path: ${path.join(ROOT, SKILL_REL)}`);
    expect(p.indexOf(`- **${MEDIA_DISPLAY_SKILL_NAME}**`)).toBeLessThan(p.indexOf(MEDIA_DISPLAY_PROMPT_TITLE));
    expect(renderSkillsForPrompt([entry])).toContain(entry.description.replace(/\n/g, " "));
  });

  it("任务 super prompt 的 Skills 段里有它，且同一个 prompt 带着主提示词", async () => {
    const entry = (await scanSkillsDir(path.join(ROOT, "skills"))).find((e) => e.name === MEDIA_DISPLAY_SKILL_NAME)!;
    const task = { ...chatTaskFixture(), id: "t_media_prompt_task_skill", mode: "task" } as unknown as Task;
    const r = await buildSuperPromptWithBudget(
      task,
      [entry],
      {
        action: { id: "act_1", n: 1, type: "plan", status: "pending", userInstruction: "", artifactPath: "actions/1-plan.md", startedAt: null, endedAt: null } as never,
        userInstruction: "",
      },
      "",
      "",
      "",
      "",
    );
    expect(r.prompt).toContain(`- **${MEDIA_DISPLAY_SKILL_NAME}**`);
    expect(r.prompt).toContain(`path: ${path.join(ROOT, SKILL_REL)}`);
    expect(r.prompt).toContain(section);
  });

  it("随包：assemble-server 整目录拷贝 skills/（新目录不用单独登记）", () => {
    expect(readSrc("scripts/lib/assemble-server.mjs")).toMatch(/cp\(path\.join\(rootDir, "skills"\), path\.join\(destDir, "skills"\)\)/);
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
    // R7-15：例外覆盖「向用户展示 / 交付的本机文件」，不再只有音视频（种类必须出现在第 5 条里，不是全文别处凑数）
    const item5 = md.split("\n").find((l) => l.startsWith("5. "));
    expect(item5, "找不到 §3 第 5 条").toBeTruthy();
    expect(item5).toContain("例外：向用户展示 / 交付的本机文件");
    expect(md).not.toContain("例外：引用本机音视频文件");
    for (const kind of ["图片", "音视频", "文档", "网页"]) expect(item5, kind).toContain(kind);
    expect(item5).toContain("完整绝对路径");
    // 例外里把两条最常踩的写法点名（主提示词里也有，这里是第二道：任务模式的 _shared.md 不能只剩一句「写绝对路径」）
    expect(item5).toContain("不要只写文件名");
    expect(item5).toContain("不要 `~/` 开头");
    // 指向的标题名必须真的是主提示词的标题（改了标题没改这里会红）
    const m = /「(本地文件展示)」一节/.exec(item5!);
    expect(m, "第 5 条应指向「本地文件展示」一节").not.toBeNull();
    expect(MEDIA_DISPLAY_PROMPT_TITLE).toContain(m![1]!);
    expect(md).not.toContain("本地音视频展示");
  });

  it("R7-15：例外只管「给用户看的产物文件」——仓库代码引用 / action artifact 的写法没变（第 5 条仍是『不要写绝对路径』，第 1–4 条原样）", () => {
    const md = readSrc("prompts/_shared.md");
    const item5 = md.split("\n").find((l) => l.startsWith("5. "));
    expect(item5, "找不到 §3 第 5 条").toBeTruthy();
    expect(item5!.startsWith("5. **不要写绝对路径**")).toBe(true);
    expect(item5).toContain("这个例外**只管给用户看的产物文件**");
    expect(item5).toContain("仓库代码引用写法不变");
    // 第 1–4 条（仓库代码引用约定）
    expect(md).toContain("1. **从 agent cwd（即 `{{repoPath}}`）起算的相对路径**");
    expect(md).toContain("2. **已知行号就写**——`path:line` 或 `path:line-line` 格式");
    expect(md).toContain("4. **同一文件多次出现都写完整路径**");
    // 其它 prompt 里的「不写绝对路径」约定（只针对改动 / 关键参考字段的仓库文件引用）没被改成放开
    expect(readSrc("prompts/action-plan.md")).toContain("/ 不写绝对路径）");
    // artifact 路径约定（`_super.md`）没动：artifact 必须写绝对路径 {{actionArtifactsDir}}/<n>-<type>.md
    expect(readSrc("prompts/_super.md")).toContain("{{actionArtifactsDir}}/<n>-<type>.md");
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

  it("飞书群答疑只读 prompt（restricted-question / group-answer-context）既不引用也不含这一段", async () => {
    for (const rel of [
      "src/lib/server/restricted-question.ts",
      "src/lib/server/feishu-bridge/group-answer-context.ts",
    ]) {
      expect(readSrc(rel), rel).not.toContain("media-display-prompt");
      expect(readSrc(rel), rel).not.toContain("mediaDisplayPromptSection");
    }
    const { formatReplyRulesSection } = await import("@/lib/server/feishu-bridge/group-answer-context");
    const rules = formatReplyRulesSection({ requesterIsBot: false }).join("\n");
    expect(rules).not.toContain(MEDIA_DISPLAY_PROMPT_TITLE);
    expect(rules).not.toContain("本地文件展示");
    expect(rules).not.toContain("本地音视频展示");
  });
});
