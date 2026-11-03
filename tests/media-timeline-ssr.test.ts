/**
 * 时间流里的音视频入口：真实 MarkdownText（Streamdown + 真实 rehype 链）SSR 渲染 + 接线契约。
 *
 * 没有 jsdom / 浏览器：点击后真正开播放器、封面加载、<video> 行为不在这里验证（靠手测）；
 * 这里锁住的是「哪些写法会变成播放入口、哪些不会」和「入口接到了哪里」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "@/components/markdown-text";
import { MediaMessageScope } from "@/components/media/media-message-scope";
import { ImagePreviewProvider } from "@/components/ui/image-preview";

const ROOT = path.resolve(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const render = (md: string, baseDir?: string): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      // children 用位置参数传（react/no-children-prop）；props 的 children 必填类型由 `as never` 绕过
      createElement(
        MediaMessageScope,
        { text: md, baseDir } as never,
        createElement(MarkdownText, { text: md, baseDir }),
      ),
    ),
  );

const renderStreaming = (md: string): string =>
  renderToStaticMarkup(
    createElement(
      ImagePreviewProvider,
      null,
      createElement(
        MediaMessageScope,
        { text: md, streaming: true } as never,
        createElement(MarkdownText, { text: md, streaming: true }),
      ),
    ),
  );

describe("行内代码里的音视频引用 → 播放入口", () => {
  it("带 #t= 区间：渲染成按钮，显示起止时间徽标，不是普通 <code>", () => {
    const html = render("看这段 `/Users/me/proj/out/preview_720p.mp4#t=12.4,15`");
    expect(html).toContain("00:12.4–00:15.0");
    expect(html).toContain("<button");
    expect(html).not.toMatch(/<code[^>]*>\/Users\/me\/proj\/out\/preview_720p\.mp4/);
  });

  it("只有时间点：徽标显示单个时间", () => {
    const html = render("`/Users/me/a.mp3#t=90`");
    expect(html).toContain("01:30.0");
  });

  it("不带时间的音频路径也是播放入口（不会被当成「文件预览」链接）", () => {
    const html = render("对比 `/Users/me/bpm-160.mp3` 和 `/Users/me/bpm-170.mp3`");
    expect(html).toContain("lucide-play");
    expect(html).not.toContain("在 Flowship 预览");
  });

  it("相对路径按 baseDir 解析", () => {
    const html = render("`out/final.mp4#t=5`", "/Users/me/proj");
    expect(html).toContain("00:05.0");
    expect(html).toContain("<button");
  });

  it("围栏代码块里的路径不变成播放入口", () => {
    const html = render("```\n/Users/me/a.mp4#t=1\n```");
    expect(html).not.toContain("00:01.0");
    expect(html).not.toContain("data-media-strip");
  });

  it("普通行内代码 / 非音视频路径不受影响", () => {
    const html = render("运行 `pnpm dev` 然后看 `src/app.ts`");
    expect(html).not.toContain("lucide-play");
  });
});

describe("markdown 链接指向本地音视频", () => {
  it("[文字](/abs/x.mp4#t=5) 变成播放入口", () => {
    const html = render("[预览片](/Users/me/out/preview.mp4#t=5)");
    expect(html).toContain("<button");
    expect(html).toContain("00:05.0");
    expect(html).toContain("预览片");
  });

  it("远程链接仍是普通外链（不当成本地媒体）", () => {
    const html = render("[官网](https://example.com/a.mp4)");
    expect(html).toContain('href="https://example.com/a.mp4"');
    expect(html).not.toContain("lucide-play");
  });
});

describe("消息末尾媒体条", () => {
  it("定稿后：每个去重后的文件一张卡片，多个文件提示可对比", () => {
    const md = "A 版 `/Users/me/a.mp3`，B 版 `/Users/me/b.mp3`，再看 `/Users/me/a.mp3#t=3`";
    const html = render(md);
    expect(html).toContain("data-media-strip");
    expect(html).toContain('aria-label="播放 a.mp3"');
    expect(html).toContain('aria-label="播放 b.mp3"');
    expect(html.match(/aria-label="播放 a\.mp3"/g)).toHaveLength(1);
    expect(html).toContain("2 个文件");
  });

  it("只有一个文件：有卡片，没有「对比」提示", () => {
    const html = render("`/Users/me/only.mp4`");
    expect(html).toContain("data-media-strip");
    expect(html).not.toContain("个文件，点开后可在播放器里");
  });

  it("流式输出中不出现媒体条（半截 markdown 不抖），行内入口照常", () => {
    const html = renderStreaming("`/Users/me/a.mp3` 和 `/Users/me/b.mp3`");
    expect(html).not.toContain("data-media-strip");
    expect(html).toContain("lucide-play");
  });

  it("没有音视频引用的消息：不多渲染任何东西", () => {
    const html = render("只是普通文字，提到 notes.md");
    expect(html).not.toContain("data-media-strip");
  });
});

describe("接线契约", () => {
  it("播放器宿主挂在根 Providers 里，懒加载且不 SSR", () => {
    const providers = readSrc("src/components/providers.tsx");
    expect(providers).toContain('import { MediaPlayerHost } from "@/components/media/media-player-host"');
    expect(providers).toContain("<MediaPlayerHost />");
    const host = readSrc("src/components/media/media-player-host.tsx");
    expect(host).toMatch(/dynamic\(/);
    expect(host).toContain("ssr: false");
    // 没有会话时什么都不挂
    expect(host).toContain("if (!snap.session) return null");
  });

  it("事件流 AI 回复正文被 MediaMessageScope 包住，且包装层不随 streaming 增减（否则定稿时 MarkdownText 会重挂）", () => {
    const rows = readSrc("src/components/tasks/event-stream/rows.tsx");
    expect(rows).toMatch(/<MediaMessageScope[^>]*streaming=\{streaming\}[\s\S]*?<MarkdownText/);
    const scope = readSrc("src/components/media/media-message-scope.tsx");
    // Provider 无条件渲染
    expect(scope).toMatch(/return \(\s*<MediaGroupContext\.Provider/);
    expect(scope).not.toMatch(/if \(refs\.length === 0\) return/);
  });

  it("行内代码的音视频判定在路径判定之前（#t= 里的冒号 / 数字不能被当成行号）", () => {
    const md = readSrc("src/components/markdown-text.tsx");
    const mediaAt = md.indexOf("parseMediaRefToken(text)");
    const pathAt = md.indexOf("looksLikePath(pathText)");
    expect(mediaAt).toBeGreaterThan(0);
    expect(pathAt).toBeGreaterThan(mediaAt);
  });

  it("文档预览入口对音视频改走播放器（产物栏 / 文件列表等所有 open() 调用方自动获得播放）", () => {
    const preview = readSrc("src/components/ui/local-file-preview.tsx");
    expect(preview).toContain("detectMediaKind(target.absolute)");
    expect(preview).toContain("openMedia([{ path: target.absolute }])");
  });

  it("播放器不往输入框塞东西（不再有截帧 / 引用到输入框的通道，composer 侧没有残留注册）", () => {
    expect(readSrc("src/components/tasks/task-talk-composer.tsx")).not.toContain("registerComposerImages");
    expect(readSrc("src/components/tasks/event-stream.tsx")).not.toContain("registerComposerImages");
    expect(readSrc("src/lib/composer-insert-bridge.ts")).not.toContain("attachImagesToComposer");
    expect(readSrc("src/components/media/media-player-dock.tsx")).not.toMatch(/composer-insert-bridge/);
  });
});
