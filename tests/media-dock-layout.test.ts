/**
 * 播放窗的控制区布局 / 全屏自动隐藏 / 已去掉的功能：SSR 渲染 + 源码接线契约。
 *
 * 没有 jsdom / 浏览器：真实的像素排布、全屏进出、鼠标静止后控件淡出这些都不在这里验证（靠手测）。
 * 这里锁住的是「窄窗口不再把控件挤出去的结构性手段还在」和「去掉的功能没有残留」。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupTabs, ShortcutHelp } from "@/components/media/media-dock-parts";
import { MediaSeekBar } from "@/components/media/media-seek-bar";
import { MediaTimelineRow } from "@/components/media/media-timeline-row";
import { MediaTransport, type TransportProps } from "@/components/media/media-transport";
import { INITIAL_MEDIA_STATE } from "@/components/media/use-media-element-state";
import { DOCK_MIN_W } from "@/lib/media/media-geometry";

const ROOT = path.resolve(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const transportProps = (over: Partial<TransportProps> = {}): TransportProps => ({
  kind: "video",
  state: { ...INITIAL_MEDIA_STATE, ready: true, duration: 120 },
  rate: 1,
  volume: 0.8,
  muted: false,
  loop: "off",
  groupSize: 1,
  hasCaptionTracks: false,
  captionsOn: false,
  pipSupported: true,
  isFullscreen: false,
  onCommand: () => {},
  onSetRate: () => {},
  onSetVolume: () => {},
  moreActions: [],
  ...over,
});

const renderTransport = (over: Partial<TransportProps> = {}): string =>
  renderToStaticMarkup(createElement(MediaTransport, transportProps(over)));

describe("控制区：窄窗口不把控件挤出去", () => {
  it("第一排只有传输 / 倍速 / 静音：时间文字和逐帧键不在这一排（以前就是它们把右侧挤出窗外）", () => {
    const html = renderTransport({ groupSize: 2 });
    for (const label of ["上一个", "后退 5 秒", "前进 5 秒", "下一个", "播放速度 1×", "静音"]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain("输入时间跳转");
  });

  it("音量滑块只在控制区够宽（@sm）时才出现，窄时 hidden，只留静音键", () => {
    const html = renderTransport();
    const slider = html.match(/<input[^>]*aria-label="音量"[^>]*>/)?.[0] ?? "";
    expect(slider).toContain("hidden");
    expect(slider).toContain("@sm:block");
  });

  it("dock 把控制区包在 @container 里（@sm 按控制区自己的宽度算，不是屏幕宽度）", () => {
    const dock = readSrc("src/components/media/media-player-dock.tsx");
    expect(dock).toMatch(/className="@container [^"]*"[\s\S]{0,200}<MediaTransport/);
  });

  it("逐帧 / 字幕 / 循环 / 画中画 / 全屏 / 更多在第二排；音频没有逐帧和全屏", () => {
    const video = renderTransport({ hasCaptionTracks: true });
    for (const label of ["上一帧", "下一帧", "打开字幕", "循环：关", "画中画", "全屏", "更多"]) {
      expect(video, label).toContain(`aria-label="${label}"`);
    }
    const audio = renderTransport({ kind: "audio" });
    expect(audio).not.toContain('aria-label="上一帧"');
    expect(audio).not.toContain('aria-label="全屏"');
    expect(audio).toContain('aria-label="更多"');
  });

  it("悬浮窗最窄 300px：第一排最坏情况（有对比组）的固定宽度加起来放得下", () => {
    // 中间一组 = 按钮 size-7 = 28px × 4（上一个 / 后退 / 前进 / 下一个）+ 播放键 size-8 = 32px + 4 个 gap-0.5 = 8px
    // 两侧栏等宽才能让中间真居中：每侧按较宽的那个算 = 倍速 ≤ 48px（静音键只有 28px）；
    // 控制区 = 窗宽 - 边框 2 - 内边距 16
    const centre = 28 * 4 + 32 + 4 * 2;
    const side = 48;
    expect(centre + 2 * side).toBeLessThanOrEqual(DOCK_MIN_W - 2 - 16);
  });

  it("第一排三栏对称：中间一组（上一个 / 后退 / 播放 / 前进 / 下一个）居中，倍速在左、音量在右", () => {
    const html = renderTransport({ groupSize: 2 });
    // 结构：两侧 1fr 等宽、中间 auto——中间不随两侧内容宽度偏移
    expect(html).toContain("grid-cols-[1fr_auto_1fr]");
    // 次序：倍速 → 上一个 → 后退 → 播放 → 前进 → 下一个 → 静音 → 音量
    const order = ["播放速度 1×", "上一个", "后退 5 秒", "播放", "前进 5 秒", "下一个", "静音", "音量"].map((label) =>
      html.indexOf(`aria-label="${label}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("不是对比组时中间只有 后退 / 播放 / 前进，仍然居中（没有上一个 / 下一个）", () => {
    const html = renderTransport({ groupSize: 1 });
    expect(html).toContain("grid-cols-[1fr_auto_1fr]");
    expect(html).not.toContain('aria-label="上一个"');
    expect(html).not.toContain('aria-label="下一个"');
    expect(html.indexOf('aria-label="后退 5 秒"')).toBeLessThan(html.indexOf('aria-label="播放"'));
    expect(html.indexOf('aria-label="播放"')).toBeLessThan(html.indexOf('aria-label="前进 5 秒"'));
  });

  it("时间放在进度条两端：已播 / 总时长，已播的宽度按总时长字数预留（数字跳动不推着进度条抖）", () => {
    const html = renderToStaticMarkup(
      createElement(
        MediaTimelineRow,
        {
          time: 123,
          duration: 5758,
          isVideo: true,
          fps: { value: 30, estimated: true },
          onGotoTime: () => {},
        } as never,
        // children 用位置参数传（react/no-children-prop）；props 里 children 必填的类型由 `as never` 绕过
        createElement("div", { "data-bar": "" }),
      ),
    );
    expect(html).toContain("2:03");
    expect(html).toContain("1:35:58");
    expect(html).toContain('aria-label="输入时间跳转"');
    // 1:35:58 = 7 个字符
    expect(html).toContain("calc(7ch + 4px)");
    // 进度条夹在两个时间中间
    expect(html.indexOf("2:03")).toBeLessThan(html.indexOf("data-bar"));
    expect(html.indexOf("data-bar")).toBeLessThan(html.indexOf("1:35:58"));
  });

  it("对比组标签平分一行并可横向滚动（窄窗里第 2 个不再被挤出边缘）", () => {
    const html = renderToStaticMarkup(
      createElement(GroupTabs, {
        items: [{ path: "/a/175.mp4" }, { path: "/a/180.mp4" }],
        index: 1,
        playingPath: null,
        onSelect: () => {},
      }),
    );
    expect(html).toContain("overflow-x-auto");
    expect(html.match(/grow basis-24/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
  });
});

describe("进度条不再画「缓冲」深色段（本地文件没有缓冲含义，看着像 bug）", () => {
  it("进度条只有底轨 + 已播，没有额外的深色段", () => {
    const html = renderToStaticMarkup(
      createElement(MediaSeekBar, { time: 10, duration: 100, onSeek: () => {} }),
    );
    expect(html).not.toContain("bg-muted-foreground/30");
    expect(html).toContain("bg-muted-foreground/25");
    expect(html).toContain("bg-primary");
  });

  it("源码里没有 buffered 状态 / 属性", () => {
    for (const f of [
      "src/components/media/media-seek-bar.tsx",
      "src/components/media/use-media-element-state.ts",
      "src/components/media/media-player-dock.tsx",
    ]) {
      expect(readSrc(f), f).not.toMatch(/buffered/);
    }
  });
});

describe("已经去掉的功能没有残留：A-B 循环 / 大窗", () => {
  const dirs = ["src/components/media", "src/lib/media"];
  const files = dirs.flatMap((d) =>
    readdirSync(path.join(ROOT, d))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `${d}/${f}`),
  );

  it("播放器相关源码里没有 A-B / theater 的标识符", () => {
    for (const f of files) {
      const src = readSrc(f);
      expect(src, f).not.toMatch(/theater|THEATER|\b(?:abIn|abOut|abClear)\b|AbRange|makeAb|abLoopJump|abSpan|EMPTY_AB|media-ab/);
    }
  });

  it("快捷键帮助里没有 A-B / 大窗那两行", () => {
    const html = renderToStaticMarkup(createElement(ShortcutHelp, { onClose: () => {} }));
    expect(html).not.toContain("A 点");
    expect(html).not.toContain("大窗");
    expect(html).toContain("全屏");
  });

  it("控制区没有 A / B / 大窗按钮", () => {
    const html = renderTransport({ isFullscreen: true });
    expect(html).not.toContain("设 A 点");
    expect(html).not.toContain("设 B 点");
    expect(html).not.toContain("大窗");
    expect(html).toContain('aria-label="退出全屏"');
  });
});

describe("全屏：画面铺满、控件叠在上面、鼠标静止后收起", () => {
  const dock = readSrc("src/components/media/media-player-dock.tsx");

  it("规则 / 计时都接上了：静止计时 hook + 可见性规则 + 阈值", () => {
    expect(dock).toContain("useIdleHide(isFullscreen, IDLE_HIDE_MS)");
    expect(dock).toContain("chromeVisible({");
    // 菜单展开 / 帮助 / 报错时不收
    expect(dock).toMatch(/pinned: menuOpen \|\| showHelp \|\| !!errorMessage/);
    expect(dock).toContain("onMenuOpenChange={setMenuOpen}");
  });

  it("全屏时顶栏 / 控制区绝对定位叠在画面上（没有白边），窗口模式用 contents 照旧排布", () => {
    expect(dock).toMatch(/isFullscreen \? "absolute inset-0" : "relative min-h-0 flex-1"/);
    expect(dock).toContain('"contents"');
    expect(dock).toContain("absolute inset-x-0 z-20");
    // 叠层里用深色主题的 token，白底变成半透明黑渐变
    expect(dock).toContain('"dark absolute inset-x-0');
    expect(dock).toContain("bg-linear-to-b");
    expect(dock).toContain("bg-linear-to-t");
  });

  it("收起时：淡出 + 不吃指针 + 隐藏鼠标指针", () => {
    expect(dock).toContain('chromeHidden && "pointer-events-none opacity-0"');
    expect(dock).toContain('chromeHidden && "cursor-none"');
  });

  it("鼠标移动 / 按键 / 点击都会唤醒；只认坐标变化的移动", () => {
    const hook = readSrc("src/components/media/use-idle-hide.ts");
    expect(hook).toContain('window.addEventListener("keydown", wake, true)');
    expect(hook).toContain('window.addEventListener("pointerdown", wake, true)');
    expect(hook).toContain("isRealPointerMove");
    expect(dock).toContain("onIdleMove(e)");
  });

  it("全屏时菜单 / 提示挂进全屏元素（挂在 <body> 上会被盖在全屏元素下面看不见）", () => {
    // Provider 的取值（只能是元素或 undefined，不能是 null）与 hook / Portal 的行为见 tests/popup-container.test.ts
    expect(dock).toContain("<PopupContainerProvider value={isFullscreen ? (rootEl ?? undefined) : undefined}>");
    // 点时间跳转会弹对话框（挂在 body 上）：全屏时先退出全屏
    expect(dock).toMatch(/document\.fullscreenElement\) await document\.exitFullscreen\(\)[\s\S]{0,80}prompt\(/);
  });
});
