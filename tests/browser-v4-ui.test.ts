/**
 * V4 用户侧前端：纯逻辑（缩放标签 / 查找计数与按键 / 下载列表与「打开」白名单 / 对话框条 / 模拟标签）
 * + 组件 SSR 渲染（查找条 / 下载列表 / 下载按钮 / 对话框条）+ 面板接线与 UI 约定的源码契约。
 * 没有 window / window.__browser 的 SSR 环境下组件必须不抛错、缺省字段按「没有」处理。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserDialogBar } from "@/components/browser/browser-dialog-bar";
import { BrowserDownloads, DownloadList } from "@/components/browser/browser-downloads";
import { BrowserFindBar } from "@/components/browser/browser-find-bar";
import {
  OPENABLE_EXTENSIONS,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
  canOpenDownload,
  canRevealDownload,
  canZoomIn,
  canZoomOut,
  describeDialogBar,
  describeDownloadMeta,
  downloadPercent,
  emulationLabelOf,
  fileExtension,
  findKeyIntent,
  formatBytes,
  formatFindCount,
  formatZoomLabel,
  isFindShortcut,
  readDownloads,
  summarizeDownloads,
} from "@/components/browser/browser-user-logic";
import type { DialogInfo, DownloadInfo } from "@/lib/browser-bridge-types";
import {
  OPENABLE_EXTENSIONS as MAIN_OPENABLE,
  canOpenFile,
  zoomLevelToPercent,
} from "../electron-app/browser/user-features.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const dl = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({
  id: 1,
  fileName: "report.pdf",
  path: "/tmp/report.pdf",
  url: "https://example.com/report.pdf",
  state: "completed",
  receivedBytes: 2048,
  totalBytes: 2048,
  startedAt: 1000,
  ...over,
});

describe("缩放标签", () => {
  it("100 / 缺省 / 非法 → 不显示；其余显示百分比", () => {
    expect(formatZoomLabel(100)).toBeNull();
    expect(formatZoomLabel(undefined)).toBeNull();
    expect(formatZoomLabel(null)).toBeNull();
    expect(formatZoomLabel(Number.NaN)).toBeNull();
    expect(formatZoomLabel(0)).toBeNull();
    expect(formatZoomLabel(125)).toBe("125%");
    expect(formatZoomLabel(83)).toBe("83%");
    expect(formatZoomLabel(120.4)).toBe("120%");
  });

  it("到头禁用放大 / 缩小；端点百分比与主进程 1.2 ** level 口径一致", () => {
    expect(canZoomIn(ZOOM_PERCENT_MAX)).toBe(false);
    expect(canZoomIn(120)).toBe(true);
    expect(canZoomIn(undefined)).toBe(true);
    expect(canZoomOut(ZOOM_PERCENT_MIN)).toBe(false);
    expect(canZoomOut(100)).toBe(true);
    expect(canZoomOut(undefined)).toBe(true);
    expect(ZOOM_PERCENT_MAX).toBe(zoomLevelToPercent(5));
    expect(ZOOM_PERCENT_MIN).toBe(zoomLevelToPercent(-3));
  });
});

describe("查找条：计数与按键", () => {
  it("没输入词 → 空；输入了但还没进度 → 空（不闪无结果）；0 命中 → 无结果；其余 3/12", () => {
    expect(formatFindCount("", null)).toEqual({ kind: "idle", text: "" });
    expect(formatFindCount("   ", { activeMatchOrdinal: 1, matches: 5 })).toEqual({ kind: "idle", text: "" });
    expect(formatFindCount("abc", null)).toEqual({ kind: "searching", text: "" });
    expect(formatFindCount("abc", { activeMatchOrdinal: 0, matches: 0 })).toEqual({ kind: "none", text: "无结果" });
    expect(formatFindCount("abc", { activeMatchOrdinal: 3, matches: 12 })).toEqual({ kind: "found", text: "3/12" });
  });

  it("序号夹到 1…matches，脏值不炸", () => {
    expect(formatFindCount("a", { activeMatchOrdinal: 0, matches: 4 }).text).toBe("1/4");
    expect(formatFindCount("a", { activeMatchOrdinal: 99, matches: 4 }).text).toBe("4/4");
    expect(formatFindCount("a", { activeMatchOrdinal: Number.NaN, matches: 4 }).text).toBe("1/4");
  });

  it("Enter 下一个 / Shift+Enter 上一个 / Esc 关闭；输入法组字中的 Enter 不算", () => {
    expect(findKeyIntent({ key: "Enter" })).toBe("next");
    expect(findKeyIntent({ key: "Enter", shiftKey: true })).toBe("prev");
    expect(findKeyIntent({ key: "Escape" })).toBe("close");
    expect(findKeyIntent({ key: "Enter", isComposing: true })).toBeNull();
    // Safari / 旧内核：确认选词的那次 Enter 上 isComposing 已是 false，只有 keyCode 229 能识别
    expect(findKeyIntent({ key: "Enter", isComposing: false, keyCode: 229 })).toBeNull();
    expect(findKeyIntent({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBeNull();
    expect(findKeyIntent({ key: "Enter", shiftKey: true, nativeEvent: { isComposing: true } })).toBeNull();
    expect(findKeyIntent({ key: "Enter", keyCode: 13 })).toBe("next");
    expect(findKeyIntent({ key: "a" })).toBeNull();
  });

  it("Cmd/Ctrl+F：mac 认 Cmd、其它认 Ctrl；Shift / Alt / 两者同按不算", () => {
    expect(isFindShortcut({ key: "f", metaKey: true }, true)).toBe(true);
    expect(isFindShortcut({ key: "F", metaKey: true }, true)).toBe(true);
    expect(isFindShortcut({ key: "f", ctrlKey: true }, true)).toBe(false);
    expect(isFindShortcut({ key: "f", ctrlKey: true }, false)).toBe(true);
    expect(isFindShortcut({ key: "f", metaKey: true }, false)).toBe(false);
    expect(isFindShortcut({ key: "f", metaKey: true, shiftKey: true }, true)).toBe(false);
    expect(isFindShortcut({ key: "f", metaKey: true, altKey: true }, true)).toBe(false);
    expect(isFindShortcut({ key: "f", metaKey: true, ctrlKey: true }, true)).toBe(false);
    expect(isFindShortcut({ key: "g", metaKey: true }, true)).toBe(false);
  });
});

describe("下载：「打开」白名单 / 进度 / 摘要（R1-23）", () => {
  it("渲染端白名单与主进程 user-features.mjs 逐项一致（防两边漂移）", () => {
    expect([...OPENABLE_EXTENSIONS].sort()).toEqual([...MAIN_OPENABLE].sort());
    expect(OPENABLE_EXTENSIONS.size).toBe(MAIN_OPENABLE.size);
    // 约定的 19 项一个不少（R2-11：csv 已移出，Excel 公式注入）
    for (const e of "pdf png jpg jpeg gif webp txt json md log mp3 wav m4a mp4 webm mov docx xlsx pptx".split(" ")) {
      expect(OPENABLE_EXTENSIONS.has(e), e).toBe(true);
      expect(MAIN_OPENABLE.has(e), e).toBe(true);
    }
    // 绝不能进白名单的：可执行 / 脚本 / 带脚本的文档 / 压缩包 / 安装包 / 配置类
    for (const e of "exe msi bat cmd com scr ps1 sh command app dmg pkg jar vbs js lnk svg html htm xml docm xlsm zip iso msix appx chm py url reg csv tsv".split(" ")) {
      expect(OPENABLE_EXTENSIONS.has(e), e).toBe(false);
      expect(MAIN_OPENABLE.has(e), e).toBe(false);
    }
  });

  it("渲染端 canOpenDownload 与主进程 canOpenFile 对同一批文件名判定一致（含伪装名）", () => {
    for (const n of ["report.pdf", "A.PNG", "x.pdf.exe", "a.exe.", "README", ".bashrc", "file.", "pack.zip", "a.svg", "a.pdf:evil.exe", "a.exe:pdf", "n.docx", "m.MOV"]) {
      expect(canOpenDownload(dl({ fileName: n })), n).toBe(canOpenFile(n));
    }
  });

  it("canOpenDownload：完成 + 扩展名在白名单才给打开；canRevealDownload 只给完成的", () => {
    expect(canOpenDownload(dl())).toBe(true);
    expect(canOpenDownload(dl({ fileName: "setup.EXE" }))).toBe(false);
    expect(canOpenDownload(dl({ fileName: "a.pdf.sh" }))).toBe(false);
    expect(canOpenDownload(dl({ fileName: "a.exe." }))).toBe(false);
    expect(canOpenDownload(dl({ fileName: "README" }))).toBe(false);
    // 白名单之外：压缩包 / 带脚本的 svg、html / 原黑名单漏项
    for (const n of ["pack.zip", "pic.svg", "page.html", "macro.docm", "x.msix", "x.iso", "script.py", "weird.unknownext"]) {
      expect(canOpenDownload(dl({ fileName: n })), n).toBe(false);
      expect(canRevealDownload(dl({ fileName: n })), `${n} 仍可「在文件夹中显示」`).toBe(true);
    }
    for (const n of ["a.PDF", "b.jpeg", "c.m4a", "d.xlsx"]) expect(canOpenDownload(dl({ fileName: n })), n).toBe(true);
    expect(canOpenDownload(dl({ state: "progressing" }))).toBe(false);
    expect(canOpenDownload(dl({ state: "interrupted" }))).toBe(false);
    expect(canRevealDownload(dl())).toBe(true);
    expect(canRevealDownload(dl({ state: "progressing" }))).toBe(false);
    expect(canRevealDownload(dl({ state: "cancelled" }))).toBe(false);
    expect(fileExtension("a/b.c/d.TXT")).toBe("txt");
  });

  it("formatBytes / downloadPercent / describeDownloadMeta", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(undefined)).toBe("");
    expect(downloadPercent({ receivedBytes: 50, totalBytes: 200 })).toBe(25);
    expect(downloadPercent({ receivedBytes: 500, totalBytes: 200 })).toBe(100);
    expect(downloadPercent({ receivedBytes: 50, totalBytes: 0 })).toBeNull();
    expect(describeDownloadMeta(dl({ state: "progressing", receivedBytes: 1024, totalBytes: 4096 }))).toBe("下载中 · 25% · 1.0 KB");
    expect(describeDownloadMeta(dl({ state: "progressing", receivedBytes: 1024, totalBytes: 0 }))).toBe("下载中 · 1.0 KB");
    expect(describeDownloadMeta(dl())).toBe("已完成 · 2.0 KB");
    expect(describeDownloadMeta(dl({ state: "cancelled" }))).toBe("已取消");
    expect(describeDownloadMeta(dl({ state: "interrupted" }))).toBe("下载中断");
  });

  it("readDownloads：缺省 / 非数组 / 脏条目 → 空或过滤", () => {
    expect(readDownloads(undefined)).toEqual([]);
    expect(readDownloads(null)).toEqual([]);
    expect(readDownloads("x")).toEqual([]);
    expect(readDownloads([dl(), null, { id: "x" }, { id: 2 }, 5])).toEqual([dl()]);
  });

  it("summarizeDownloads：没有 → total 0；进行中合并进度；总大小未知 → percent null", () => {
    expect(summarizeDownloads([])).toEqual({ total: 0, active: 0, percent: null });
    expect(
      summarizeDownloads([
        dl({ id: 1, state: "progressing", receivedBytes: 50, totalBytes: 100 }),
        dl({ id: 2, state: "progressing", receivedBytes: 150, totalBytes: 300 }),
        dl({ id: 3 }),
      ]),
    ).toEqual({ total: 3, active: 2, percent: 50 });
    expect(summarizeDownloads([dl({ state: "progressing", receivedBytes: 10, totalBytes: 0 })])).toEqual({
      total: 1,
      active: 1,
      percent: null,
    });
  });
});

describe("对话框条 / 模拟标签：模型", () => {
  const d = (over: Partial<DialogInfo> = {}): DialogInfo => ({
    type: "confirm",
    message: "确定删除？",
    url: "https://e.com",
    since: 1,
    ...over,
  });

  it("没有对话框（缺省 / null）→ null", () => {
    expect(describeDialogBar(undefined)).toBeNull();
    expect(describeDialogBar(null)).toBeNull();
  });

  it("alert 只有「确定」；confirm 确定 / 取消；prompt 带输入框与默认值；beforeunload 是「离开 / 留在此页」", () => {
    expect(describeDialogBar(d({ type: "alert" }))).toMatchObject({ typeLabel: "提示框", showCancel: false, showInput: false, acceptLabel: "确定" });
    expect(describeDialogBar(d())).toMatchObject({ typeLabel: "确认框", showCancel: true, cancelLabel: "取消" });
    expect(describeDialogBar(d({ type: "prompt", defaultPrompt: "张三" }))).toMatchObject({ typeLabel: "输入框", showInput: true, defaultPrompt: "张三" });
    expect(describeDialogBar(d({ type: "beforeunload", message: "" }))).toMatchObject({
      typeLabel: "离开确认",
      acceptLabel: "离开",
      cancelLabel: "留在此页",
    });
    expect(describeDialogBar(d({ type: "beforeunload", message: "" }))!.message).not.toBe("");
  });

  it("未知类型按 alert 处理，不炸", () => {
    expect(describeDialogBar({ ...d(), type: "weird" as never })).toMatchObject({ typeLabel: "提示框", showCancel: false });
  });

  it("emulationLabelOf：缺省 / null / 空串 → null；有值 trim", () => {
    expect(emulationLabelOf(undefined)).toBeNull();
    expect(emulationLabelOf({})).toBeNull();
    expect(emulationLabelOf({ emulation: null })).toBeNull();
    expect(emulationLabelOf({ emulation: "  " })).toBeNull();
    expect(emulationLabelOf({ emulation: " iPhone 15 · 暗色 " })).toBe("iPhone 15 · 暗色");
  });
});

describe("组件 SSR 渲染（无 window）", () => {
  it("查找条：搜索区域 + 输入框 + 三个带 aria-label 的图标按钮；初始计数为空且上一个 / 下一个置灰", () => {
    const html = renderToStaticMarkup(createElement(BrowserFindBar, { taskId: "t1", onClose: () => {} }));
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="在页面中查找"');
    for (const label of ["上一个匹配", "下一个匹配", "关闭查找"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toMatch(/aria-label="上一个匹配"[^>]*disabled/);
    expect(html).not.toContain("无结果");
  });

  it("下载列表：空 → 「还没有下载」；有条目 → 文件名 / 状态 / 动作按钮按「打开」白名单出现", () => {
    expect(renderToStaticMarkup(createElement(DownloadList, { taskId: "t1", downloads: [] }))).toContain("还没有下载");
    const html = renderToStaticMarkup(
      createElement(DownloadList, {
        taskId: "t1",
        downloads: [
          dl({ id: 1, fileName: "report.pdf", startedAt: 1 }),
          dl({ id: 2, fileName: "setup.exe", startedAt: 2 }),
          dl({ id: 3, fileName: "big.zip", state: "progressing", receivedBytes: 1024, totalBytes: 4096, startedAt: 3 }),
          dl({ id: 4, fileName: "bad.bin", state: "interrupted", startedAt: 4 }),
        ],
      }),
    );
    expect(html).toContain("report.pdf");
    expect(html).toContain("已完成");
    expect(html).toContain("下载中 · 25%");
    expect(html).toContain("下载中断");
    // 白名单内的文件：显示 + 打开都有；其余类型（可执行等）：只有显示；进行中 / 失败：都没有
    expect(html).toContain('aria-label="在文件夹中显示 report.pdf"');
    expect(html).toContain('aria-label="打开 report.pdf"');
    expect(html).toContain('aria-label="在文件夹中显示 setup.exe"');
    expect(html).not.toContain('aria-label="打开 setup.exe"');
    expect(html).not.toContain("big.zip 在文件夹");
    expect(html).not.toContain('aria-label="在文件夹中显示 big.zip"');
    expect(html).not.toContain('aria-label="打开 big.zip"');
    expect(html).not.toContain('aria-label="在文件夹中显示 bad.bin"');
    // 进行中的行有进度条（读屏可达）
    expect(html).toContain('role="progressbar"');
    // 最新在上：bad.bin(4) 先于 report.pdf(1)
    expect(html.indexOf("bad.bin")).toBeLessThan(html.indexOf("report.pdf"));
  });

  it("下载按钮：没有下载（含缺省）时整个不渲染；有下载时渲染带 aria-label 的触发器；进行中带进度提示", () => {
    expect(renderToStaticMarkup(createElement(BrowserDownloads, { taskId: "t1", downloads: [] }))).toBe("");
    const done = renderToStaticMarkup(createElement(BrowserDownloads, { taskId: "t1", downloads: [dl()] }));
    expect(done).toContain('aria-label="下载（1）"');
    const busy = renderToStaticMarkup(
      createElement(BrowserDownloads, {
        taskId: "t1",
        downloads: [dl({ state: "progressing", receivedBytes: 50, totalBytes: 100 })],
      }),
    );
    expect(busy).toContain("1 个进行中，50%");
  });

  // R2-14 ⑤：总大小未知时以前画 animate-pulse 的「不确定」条（与「同屏只留一处主动效」冲突）；现在只在有确定百分比时画条
  describe("下载进度条：只在百分比已知时画（无 animate-pulse）", () => {
    const unknown = dl({ id: 7, fileName: "stream.bin", state: "progressing", receivedBytes: 2048, totalBytes: 0 });

    it("行内：总大小未知 → 没有进度条，但文案仍写着已接收大小", () => {
      const html = renderToStaticMarkup(createElement(DownloadList, { taskId: "t1", downloads: [unknown] }));
      expect(html).not.toContain('role="progressbar"');
      expect(html).toContain("下载中 · 2.0 KB");
      expect(html).not.toContain("animate-pulse");
    });

    it("行内：总大小已知 → 确定进度条（aria-valuenow + 宽度）", () => {
      const html = renderToStaticMarkup(
        createElement(DownloadList, {
          taskId: "t1",
          downloads: [dl({ id: 8, fileName: "big.zip", state: "progressing", receivedBytes: 1024, totalBytes: 4096 })],
        }),
      );
      expect(html).toContain('role="progressbar"');
      expect(html).toContain('aria-valuenow="25"');
      expect(html).toContain("width:25%");
    });

    it("触发按钮：全部总大小未知 → 没有合并进度条，但「N 个进行中」仍在 aria-label 里", () => {
      const html = renderToStaticMarkup(createElement(BrowserDownloads, { taskId: "t1", downloads: [unknown] }));
      expect(html).toContain('aria-label="下载（1 个进行中）"');
      expect(html).not.toContain("h-0.5");
      expect(html).not.toContain("animate-pulse");
    });

    it("触发按钮：有确定百分比 → 合并进度条按百分比画宽度", () => {
      const html = renderToStaticMarkup(
        createElement(BrowserDownloads, {
          taskId: "t1",
          downloads: [dl({ state: "progressing", receivedBytes: 30, totalBytes: 100 })],
        }),
      );
      expect(html).toContain("h-0.5");
      expect(html).toContain("width:30%");
    });

    it("触发按钮：没有进行中（只有已完成）→ 不画进度条", () => {
      const html = renderToStaticMarkup(createElement(BrowserDownloads, { taskId: "t1", downloads: [dl({ state: "completed" })] }));
      expect(html).not.toContain("h-0.5");
    });
  });

  it("对话框条：缺省 / null 什么都不画；confirm 有确定 + 取消；prompt 有输入框（带默认值）；不用会触发遮盖的 dialog role", () => {
    expect(renderToStaticMarkup(createElement(BrowserDialogBar, { taskId: "t1", dialog: undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(BrowserDialogBar, { taskId: "t1", dialog: null }))).toBe("");
    const confirm = renderToStaticMarkup(
      createElement(BrowserDialogBar, {
        taskId: "t1",
        dialog: { type: "confirm", message: "确定删除？", url: "https://e.com", since: 1 },
      }),
    );
    expect(confirm).toContain("确认框");
    expect(confirm).toContain("确定删除？");
    expect(confirm).toContain("确定");
    expect(confirm).toContain("取消");
    expect(confirm).not.toContain("<input");
    // role="dialog" / "alertdialog" 会被 use-overlay-cover 当常驻浮层、把整个视口遮成截图
    expect(confirm).not.toMatch(/role="(alert)?dialog"/);
    const prompt = renderToStaticMarkup(
      createElement(BrowserDialogBar, {
        taskId: "t1",
        dialog: { type: "prompt", message: "你叫什么？", defaultPrompt: "张三", url: "https://e.com", since: 2 },
      }),
    );
    expect(prompt).toContain("输入框");
    expect(prompt).toContain('value="张三"');
    const alert = renderToStaticMarkup(
      createElement(BrowserDialogBar, { taskId: "t1", dialog: { type: "alert", message: "保存成功", url: "u", since: 3 } }),
    );
    expect(alert).not.toContain("取消");
  });
});

describe("面板接线与 UI 约定（源码契约）", () => {
  const panel = read("src/components/browser/browser-panel.tsx");
  // R1-33：以前只手列 5 个文件，漏了 browser-panel.tsx / browser-viewport.tsx（手工 grep 无违规，但守卫没覆盖）。
  // 改成「src/components/browser/ 下全部 .tsx」按目录枚举，新增的 UI 文件自动纳入；再加上纯逻辑文件 browser-user-logic.ts
  const BROWSER_DIR = "src/components/browser";
  const ALL_TSX = readdirSync(path.join(ROOT, BROWSER_DIR))
    .filter((f) => f.endsWith(".tsx"))
    .sort()
    .map((f) => `${BROWSER_DIR}/${f}`);
  const NEW_FILES = [...ALL_TSX, `${BROWSER_DIR}/browser-user-logic.ts`];
  /**
   * 允许出现 <img> 的文件（各恰好 1 处，来源由 tests/markdown-remote-image-ssr.test.ts 的全仓入口护栏钉死）：
   * panel = favicon（只吃 safeFaviconSrc），viewport = 遮盖占位图（只吃主进程 setCovered 的 dataURL）。
   */
  const IMG_ALLOWED = new Set([`${BROWSER_DIR}/browser-panel.tsx`, `${BROWSER_DIR}/browser-viewport.tsx`]);

  it("守卫覆盖面：目录枚举确实包含 browser-panel.tsx / browser-viewport.tsx 与 V4 的 4 个新 UI 文件", () => {
    for (const f of [
      "browser-panel.tsx",
      "browser-viewport.tsx",
      "browser-find-bar.tsx",
      "browser-downloads.tsx",
      "browser-dialog-bar.tsx",
      "browser-icon-button.tsx",
    ]) {
      expect(NEW_FILES, f).toContain(`${BROWSER_DIR}/${f}`);
    }
    expect(NEW_FILES.length).toBeGreaterThanOrEqual(12);
  });

  it("面板接了：查找条 / 下载按钮 / 对话框条 / 缩放标签 / 模拟标签 / 更多菜单里的缩放、查找、开发者工具", () => {
    for (const k of [
      "<BrowserFindBar",
      "<BrowserDownloads",
      "<BrowserDialogBar",
      "formatZoomLabel(activeTab?.zoom)",
      "emulationLabelOf(activeTab)",
      "resetEmulation",
      "openDevTools",
      "onFindRequested",
      "isFindShortcut",
      'zoom?.(taskId, "reset")',
      'zoom?.(taskId, "in")',
      'zoom?.(taskId, "out")',
    ]) {
      expect(panel, k).toContain(k);
    }
    // 状态里的新字段一律按缺省处理
    expect(panel).toContain("readDownloads(state?.downloads)");
    expect(panel).toContain("state?.dialog");
  });

  // R2-14 ④：旧正则偏弱——`title={expr}`（表达式写法）、`ring-/fill-/from-…` 等调色板前缀、`lime|teal|cyan|pink|rose|purple…` 色名、
  // `bg-white / text-black`、`opacity-60` 整块透明、带 motion-reduce 的 animate-pulse 都漏。
  // 这里的规则与 tests/ui-convention-scan.test.ts 同口径（不能 import 测试文件：会把它的 describe 一并注册进来，所以复制一份；
  // 那边按 FIXED_FILES 扫、这边按目录枚举扫，互为双保险）。扫描前先剥注释：注释里解释旧写法是正常的
  const stripCode = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const PALETTES =
    "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
  const RAW_PALETTE = new RegExp(
    `\\b(?:bg|text|border(?:-[xytblrse])?|ring|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret)-(?:${PALETTES})-\\d{2,3}\\b`,
  );
  const RAW_WHITE_BLACK = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/;
  // 20~99 的中间 opacity；disabled / hover / focus 家族（失活与显隐）放过——与 ui-convention-scan 的 STATE_VARIANT 一致
  const STATE_VARIANT = /(?:^|:)(?:(?:peer|group|aria|data)-)?(?:disabled|hover|focus|focus-within|focus-visible)(?:\/[\w-]+)?:/;
  const midOpacity = (src: string) =>
    [...src.matchAll(/(?<![\w/-])((?:[\w/-]+:)*)opacity-(?:[2-9]\d)\b/g)]
      .filter((m) => !STATE_VARIANT.test(m[1] ?? ""))
      .map((m) => m[0]);

  it("规则自检：旧正则漏掉的写法现在都命中，语义 token 不误报（别让这条闸自己是摆设）", () => {
    for (const bad of [
      "<span title={tab.title}>", // 表达式写法
      '<button title="x">',
    ]) expect(bad, bad).toMatch(/\btitle=/);
    for (const c of ["bg-blue-500", "text-red-600", "ring-lime-500", "fill-teal-400", "from-pink-300", "border-l-rose-500", "bg-white", "text-black"]) {
      expect(RAW_PALETTE.test(c) || RAW_WHITE_BLACK.test(c), c).toBe(true);
    }
    for (const c of ["bg-info", "text-muted-foreground", "border-border", "bg-primary/70", "text-destructive"]) {
      expect(RAW_PALETTE.test(c) || RAW_WHITE_BLACK.test(c), c).toBe(false);
    }
    expect(midOpacity('"size-6 opacity-60"')).toEqual(["opacity-60"]);
    expect(midOpacity('"dark:opacity-60 md:opacity-70"')).toHaveLength(2);
    expect(midOpacity('"opacity-0 group-hover/tab:opacity-100 disabled:opacity-50 focus-visible:opacity-100"')).toEqual([]);
  });

  it("新 UI 不用原生 title=（含 title={expr}）/ 任何 animate-pulse / 小于 11px 的字号 / 文字叠 /20~/99 透明度 / 整块 opacity-20~99 / 裸调色板色 / 新增 img", () => {
    for (const rel of [...NEW_FILES, "src/components/settings/browser-card.tsx"]) {
      const src = stripCode(read(rel));
      expect(src, `${rel} 原生 title=`).not.toMatch(/\btitle=/);
      expect(src, `${rel} animate-pulse（含带 motion-reduce 的）`).not.toMatch(/\banimate-pulse\b/);
      expect(src, `${rel} 字号`).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
      expect(src, `${rel} 文字透明度`).not.toMatch(/\btext-[a-z-]+\/(?:[2-9]\d)\b/);
      expect(midOpacity(src), `${rel} 整块 opacity`).toEqual([]);
      expect(src, `${rel} 裸调色板色`).not.toMatch(RAW_PALETTE);
      expect(src, `${rel} bg-white / text-black`).not.toMatch(RAW_WHITE_BLACK);
      if (rel === "src/components/settings/browser-card.tsx") continue;
      if (IMG_ALLOWED.has(rel)) {
        expect(src.match(/<img\b/g), `${rel} <img> 恰好一处（多一处要过评审）`).toHaveLength(1);
      } else {
        expect(src, `${rel} 不新增 img`).not.toMatch(/<img\b/);
      }
    }
  });

  // R2-07（前端部分）：入口按钮的状态点实现早就改成静态，但注释还写「呼吸点 / pulse」——
  // 注释与实现不一致会让下一个人以为它在动、再把动画加回去。连同 store 里引用它的那句一起钉住（含注释，所以读原文不剥注释）
  it("入口按钮的 AI 状态点是静态的：实现没有动画类，注释 / 相关文案也不再说「呼吸 / pulse」", () => {
    for (const rel of ["src/components/browser/browser-toggle-button.tsx", "src/components/browser/browser-state-store.ts"]) {
      expect(read(rel), `${rel} 注释里还有「呼吸」`).not.toMatch(/呼吸|breath/i);
    }
    const toggle = read("src/components/browser/browser-toggle-button.tsx");
    expect(toggle).not.toMatch(/\banimate-/);
    const dot = toggle.slice(toggle.indexOf("aiActive && !asking"), toggle.indexOf("{asking && ("));
    expect(dot).toContain("size-1.5 rounded-full bg-primary");
    expect(dot).not.toMatch(/animate|transition|pulse/);
  });

  // R2-14 ⑤：页面加载条以前是 animate-pulse；现在是静态细线（不确定进度：无 aria-valuenow）
  it("面板加载条：静态 bg-info 细线 + progressbar 语义，不带任何动画类", () => {
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const i = code.indexOf('aria-label="页面加载中"');
    expect(i).toBeGreaterThan(-1);
    const block = code.slice(code.lastIndexOf("<div", i), code.indexOf("/>", i) + 2);
    expect(block).toContain('role="progressbar"');
    expect(block).toContain("bg-info");
    expect(block).not.toMatch(/animate-|aria-valuenow/);
  });

  // R1-15：面板里 Cmd/Ctrl+F 处理加 stopPropagation，app-shell 的全局 keydown 开头判 defaultPrevented，避免任务页双触发
  it("R1-15 ⌘/Ctrl+F：面板处理里 preventDefault + stopPropagation；app-shell 全局处理在 isModCombo 之后立刻 defaultPrevented 返回", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const p = strip(panel);
    const branch = p.slice(p.indexOf("isFindShortcut(e,"), p.indexOf("openFind();", p.indexOf("isFindShortcut(e,")));
    expect(branch).toContain("e.preventDefault()");
    expect(branch).toContain("e.stopPropagation()");

    const shell = strip(read("src/components/app-shell.tsx"));
    const fn = shell.slice(shell.indexOf("const onKeyDown = (e: KeyboardEvent) => {\n      if (!isModCombo(e, \"f\")) return;"));
    expect(fn.length).toBeGreaterThan(0);
    const iPrevented = fn.indexOf("if (e.defaultPrevented) return;");
    const iScope = fn.indexOf("resolvePaneSearchScope(");
    const iPrevent = fn.indexOf("e.preventDefault();");
    expect(iPrevented).toBeGreaterThan(-1);
    expect(iPrevented).toBeLessThan(iScope);
    expect(iPrevented).toBeLessThan(iPrevent);
  });


  it("纯图标按钮都经 BrowserIconButton（强制 aria-label + Tooltip），对话框条不用 dialog role", () => {
    const iconBtn = read("src/components/browser/browser-icon-button.tsx");
    expect(iconBtn).toContain("aria-label={label}");
    expect(iconBtn).toContain("<Tooltip");
    // 去掉注释再查：文件头注释里就写着「不能用 role="dialog"」
    const barCode = read("src/components/browser/browser-dialog-bar.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(barCode).not.toMatch(/role="(alert)?dialog"/);
  });

  it("下载弹层是 base-ui Popover（data-slot=popover-content，use-overlay-cover 的 HARD_OVERLAY_SELECTOR 能识别）", () => {
    expect(read("src/components/browser/browser-downloads.tsx")).toContain("PopoverContent");
    expect(read("src/components/ui/popover.tsx")).toContain('data-slot="popover-content"');
    expect(read("src/components/browser/overlay-cover-logic.ts")).toContain('[data-slot="popover-content"]');
  });

  it("查找条卸载时清掉页内高亮；findNext 沿用 Electron 原语义（新词 true、Enter 步进 false）", () => {
    const find = read("src/components/browser/browser-find-bar.tsx");
    expect(find).toContain("stopFind?.(taskId)");
    expect(find).toContain("runFind(text, { forward: true, findNext: true })");
    expect(find).toContain("{ forward, findNext: false }");
  });
});
