/**
 * 预览窗外壳 / 编辑器 / 图片与 SVG 查看器的源码接线契约
 *
 * 没有 jsdom / 浏览器：下面证明的是「这些保护还接在线上、没被改回去」，**不证明**真机行为
 * （Esc 能不能只关查找条、⌘S 在 Electron 里会不会被菜单吞、拖拽 / 缩放手感、CSS Highlight 绘制、编辑器光标位置都要肉眼过）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveLocalFileOpenTarget } from "@/lib/local-file-kind";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
/** 去掉块注释与行注释（`://` 不算）：「不许出现 X」类断言只看代码，注释里解释「为什么不能用 X」是正常的 */
const code0 = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PREVIEW_DIR = "src/components/preview";
const previewFiles = readdirSync(path.join(ROOT, PREVIEW_DIR)).filter((f) => /\.(ts|tsx)$/.test(f));

const provider = read("src/components/ui/local-file-preview.tsx");
const sheet = read("src/components/ui/sheet.tsx");
const body = read("src/components/ui/local-file-preview-body.tsx");
const code = read(`${PREVIEW_DIR}/code-viewer.tsx`);

describe("外壳（local-file-preview.tsx）", () => {
  it("关栏（Esc / 左上角 X）统一走 requestClose；有未保存修改先确认，取消则侧栏保持打开", () => {
    expect(provider).toMatch(/onOpenChange=\{\(next\) => \{\s*if \(!next\) requestClose\(\);/);
    const at = provider.indexOf("const requestClose = useCallback");
    const fn = provider.slice(at, provider.indexOf("}, []);", at));
    expect(fn).toContain("if (!dirtyRef.current)");
    expect(fn).toContain("confirmRef.current(");
    expect(fn).toContain("destructive: true");
    // 只有确认之后才 setOpen(false)（确认前不关）
    expect(fn.indexOf("if (ok)")).toBeLessThan(fn.lastIndexOf("setOpen(false)"));
  });

  it("从别处点开另一个文件时，有未保存修改要先确认（不能悄悄把草稿换掉）", () => {
    const at = provider.indexOf("const openPreview = useCallback");
    const fn = provider.slice(at, provider.indexOf("const previewContext", at));
    expect(fn).toContain("if (dirtyRef.current)");
    expect(fn).toContain("confirmRef.current(");
    expect(fn.indexOf("confirmRef.current(")).toBeLessThan(fn.indexOf("setOpen(true)"));
  });

  it("磁盘变化轮询：窗口开着 + 标签页可见 + 没有读取在途才查；没有未保存修改 → 静默刷新，有 → 只提示不替用户决定", () => {
    expect(provider).toContain("/api/system/local-file-stat?path=");
    const at = provider.indexOf("const tick = async");
    const fn = provider.slice(at, provider.indexOf("timer = window.setTimeout(() => void tick(), STAT_POLL_MS);", at));
    expect(fn).toContain('document.visibilityState === "visible"');
    expect(fn).toContain("!inflightRef.current");
    expect(fn).toMatch(/if \(dirtyRef\.current\) setStale\("changed"\);\s*else \{\s*setStale\(null\);\s*setReloadNonce/);
    expect(fn).toContain('setStale("missing")');
  });

  it("保存成功：text / mtime / size 在同一次 setPayload 里一起更新（只更新 mtime 会让编辑器把草稿回退成旧文本）", () => {
    const at = provider.indexOf("const handleSaved = useCallback");
    const fn = provider.slice(at, provider.indexOf("}, []);", at));
    expect(fn).toMatch(/setPayload\(\(p\) => \(p \? \{ \.\.\.p, text: r\.text, mtimeMs: r\.mtimeMs, size: r\.size/);
    // 之后再静默刷新衍生数据
    expect(fn).toContain("setReloadNonce");
  });

  it("同一文件的重新读取是静默的：只有换了文件才清空旧内容 / 显示加载中；静默失败保留旧内容", () => {
    expect(provider).toContain("const fresh = loadedPathRef.current !== absolutePath;");
    expect(provider).toMatch(/if \(fresh\) \{\s*setLoading\(true\);\s*setError\(null\);\s*setPayload\(null\);/);
    expect(provider).toMatch(/if \(fresh\) setError\(json\.error/);
  });

  it("xlsx 切换工作表：带 &sheet=N 重新请求", () => {
    expect(provider).toContain("`&sheet=${sheetIndex}`");
    expect(provider).toContain("onSelectSheet={handleSelectSheet}");
  });

  it("侧栏高度 = 视口高度（虚拟列表 / 编辑器要确定高度的容器）+ 标准 / 加宽两档（都不超视口）；正文区仍是 min-h-0 flex-1 且不横向溢出", () => {
    // 高度来自 SheetContent 基类的 inset-y-0；这里不能再手写 90vh 之类的居中弹窗高度
    expect(sheet).toContain("fixed inset-y-0 right-0");
    expect(provider).not.toContain("90vh");
    expect(provider).toContain("<SheetContent");
    expect(provider).toContain('"max-w-none gap-0 overflow-hidden bg-background p-0 text-foreground"');
    expect(provider).toContain('wide ? "w-[calc(100vw-6rem)]" : "w-[min(760px,70vw)]"');
    expect(provider).toContain("min-h-0 flex-1 overflow-x-hidden overflow-y-auto");
  });

  it("外壳是右侧非模态 Sheet（不再是居中 Dialog）：关闭键在左上，顶栏左侧给它让位", () => {
    expect(provider).toMatch(/<Sheet\s+open=\{open\}/);
    expect(provider).not.toMatch(/<Dialog\b|<DialogContent\b/);
    expect(provider).toContain("pr-3 pl-11");
    expect(provider).not.toContain("pr-12 pl-3");
    // 非模态 + 不因点外面而关（连点不同文件链接只是换内容）：这两条由 Sheet 基座保证，锁住别被改掉
    expect(sheet).toMatch(/\bmodal\s*=\s*false,/);
    expect(sheet).toMatch(/\bdisablePointerDismissal\s*=\s*true,/);
    // 关栏退场动画（SheetContent duration-200）跑完再清内容
    expect(provider).toContain("window.setTimeout(clearPreviewData, 260)");
  });

  it("右侧只有一条位：与代码改动面板 / 子代理抽屉共用 right-dock，后开的替换先开的（关闭走 requestClose，脏草稿仍会先确认）", () => {
    expect(provider).toContain('useRightDockSlot("file-preview", open, requestClose)');
    expect(provider.indexOf("const requestClose = useCallback")).toBeLessThan(
      provider.indexOf('useRightDockSlot("file-preview"'),
    );
  });

  it("音视频仍走全局播放器（未回退）", () => {
    expect(provider).toContain("detectMediaKind(target.absolute)");
    expect(provider).toContain("openMedia([{ path: target.absolute }])");
  });

  it("HTML 仍交给系统浏览器：无行号的 .html / .htm 打开目标是 browser，预览窗里没有 html 渲染分支", () => {
    expect(resolveLocalFileOpenTarget("/tmp/a.html")).toBe("browser");
    expect(resolveLocalFileOpenTarget("/tmp/a.htm")).toBe("browser");
    expect(body).not.toMatch(/case\s+["']html["']/);
    expect(body).not.toMatch(/srcDoc|srcdoc/);
  });
});

describe("编辑器（code-viewer.tsx）", () => {
  it("保存请求：POST JSON，带 expectedMtimeMs 做冲突检测，force 只在用户点「覆盖保存」时为 true", () => {
    expect(code).toContain('"/api/system/write-local-file"');
    expect(code).toContain('method: "POST"');
    expect(code).toContain('"Content-Type": "application/json"');
    // force 是函数参数原样透传（默认 false），不是写死的 true
    expect(code).toMatch(/expectedMtimeMs: baselineMtime,\s*force,\s*\}\),/);
    expect(code).toContain("async (force = false) =>");
    expect(code).toMatch(/onClick=\{\(\) => void save\(true\)\}/);
    // 其它所有保存入口都是 save() 不带 force
    expect(code.match(/save\(true\)/g)).toHaveLength(1);
  });

  it("409 冲突：进冲突条（覆盖保存 / 放弃我的修改并重新加载 / 稍后处理），不弹成功、不清草稿", () => {
    expect(code).toMatch(/else if \(res\.status === 409\) \{\s*setConflict\(/);
    expect(code).toContain("覆盖保存");
    expect(code).toContain("放弃我的修改并重新加载");
    expect(code).toContain("onClick={onRequestReload}");
  });

  it("⌘/Ctrl+S 只在编辑态保存、⌘/Ctrl+F 只在查看态打开查找（走全站 isModCombo：mac 只认 ⌘，不吞 Ctrl+F 光标键）", () => {
    expect(code).toMatch(/isModCombo\(e, "s"\) && mode === "edit"/);
    expect(code).toMatch(/isModCombo\(e, "f"\) && mode === "view"/);
    // 不再手写 metaKey || ctrlKey
    expect(code).not.toMatch(/e\.metaKey \|\| e\.ctrlKey/);
    // 提示文案按平台显示（⌘F / Ctrl+F），不写笼统的 ⌘/Ctrl
    expect(code).toContain('getModShortcutLabel(platform, "F")');
    expect(code).toContain("useShellPlatform()");
  });

  it("文档 / JSON 的查找快捷键同样走 isModCombo + 平台文案；FindBar 的 Enter 带 IME 判断", () => {
    for (const file of ["document-pane.tsx", "json-viewer.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), "src/components/preview", file), "utf8");
      expect(src, file).toContain('isModCombo(e, "f")');
      expect(src, file).toContain('getModShortcutLabel(platform, "F")');
      expect(src, file).not.toMatch(/e\.metaKey \|\| e\.ctrlKey/);
    }
    const ui = readFileSync(path.join(process.cwd(), "src/components/preview/preview-ui.tsx"), "utf8");
    expect(ui).toMatch(/if \(isImeComposing\(e\)\) return;\s*if \(e\.key === "Enter"\)/);
  });

  it("脏状态上报给外壳，并在卸载时复位（否则关窗后外壳永远以为有未保存修改）", () => {
    expect(code).toMatch(/useEffect\(\(\) => \{\s*onDirtyChange\(dirty\);\s*\}, \[dirty, onDirtyChange\]\);/);
    expect(code).toMatch(/useEffect\(\(\) => \(\) => onDirtyChange\(false\), \[onDirtyChange\]\);/);
  });

  it("放弃 / 退出编辑：有未保存修改先确认", () => {
    const revert = code.slice(code.indexOf("const revert = async"), code.indexOf("const finishEdit = async"));
    const finish = code.slice(code.indexOf("const finishEdit = async"), code.indexOf("const updateCaret"));
    for (const fn of [revert, finish]) {
      expect(fn).toContain("if (draft !== baseline)");
      expect(fn).toContain("await confirm(");
      expect(fn).toContain("destructive: true");
    }
  });

  it("不可编辑：只读徽标 + Tooltip 说明原因（不是静默置灰）", () => {
    expect(code).toContain("editBlockedReason ?? ");
    expect(code).toContain("只读");
  });

  it("保存时带回 BOM / 换行风格；混合换行不会被当成 CRLF 写回（只有 crlf 才写 crlf，其它一律 lf——且混合换行服务端本就不可编辑）", () => {
    expect(code).toContain('eol: eol === "crlf" ? "crlf" : "lf"');
    expect(code).toContain("bom,");
  });

  it("语法着色有上限（编辑态更低），超限回退成转义后的纯文本", () => {
    expect(code).toContain("HIGHLIGHT_MAX_CHARS");
    expect(code).toContain("EDIT_HIGHLIGHT_MAX_CHARS");
    expect(code).toContain(": escapeHtml(code)");
  });

  it("预览组件里不用原生 title=（hover 提示一律 Tooltip）", () => {
    for (const f of previewFiles) {
      expect(code0(`${PREVIEW_DIR}/${f}`), f).not.toMatch(/\stitle=/);
    }
  });
});

describe("图片 / SVG 安全前提", () => {
  const image = read(`${PREVIEW_DIR}/image-viewer.tsx`);
  const svg = read(`${PREVIEW_DIR}/svg-viewer.tsx`);

  it("滚轮缩放用原生非 passive 监听（React onWheel 是 passive 的，preventDefault 无效、页面会跟着滚），并在卸载时移除", () => {
    expect(image).toContain('addEventListener("wheel", onWheel, { passive: false })');
    expect(image).toContain('removeEventListener("wheel", onWheel)');
    expect(image).not.toContain("onWheel={");
  });

  it("<img> 的 src 只来自调用方 prop", () => {
    expect(image).toMatch(/<img\s+src=\{src\}/);
  });

  it("body 给图片查看器的 src 只会是服务端给的本地媒体路径（mediaPath）", () => {
    expect(body).toContain("withVersion(data.mediaPath, data.mtimeMs)");
    expect(body).not.toMatch(/<ImageViewer[^>]*src=\{(?!withVersion\(data\.mediaPath)/);
  });

  it("SVG 只经 blob URL 交给 <img>（不执行脚本、不加载外部资源）；绝不 inline / iframe / object / dangerouslySetInnerHTML", () => {
    expect(svg).toContain('type: "image/svg+xml"');
    expect(svg).toContain("URL.createObjectURL(");
    expect(svg).toContain("URL.revokeObjectURL(u)");
    expect(code0(`${PREVIEW_DIR}/svg-viewer.tsx`)).not.toMatch(/dangerouslySetInnerHTML|<iframe|<object|<embed/);
  });

  it("components/preview 下没有任何 dangerouslySetInnerHTML（docx 的净化后 HTML 只在 body 里、且先过 sanitizePreviewHtml）", () => {
    for (const f of previewFiles) {
      expect(code0(`${PREVIEW_DIR}/${f}`), f).not.toContain("dangerouslySetInnerHTML");
    }
    expect(body).toContain("sanitizePreviewHtml(data.html)");
    // body 里（去注释后）只有 docx 这一处
    expect(code0("src/components/ui/local-file-preview-body.tsx").match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
  });

  it("PDF 的 iframe 仍在 body 里、带 title（a11y），并随 mtime 重新加载", () => {
    expect(body).toMatch(/<iframe src=\{pdfUrl\} title=\{pathBasename\(data\.absolutePath\)\}/);
    expect(body).toContain("[pdfSource, pdfVersion]");
  });
});

describe("文档页内查找", () => {
  const find = read(`${PREVIEW_DIR}/use-doc-find.ts`);
  const ui = read(`${PREVIEW_DIR}/preview-ui.tsx`);

  it("高亮登记在全局 CSS.highlights 上：卸载时必须清掉，否则会残留到下一个文件", () => {
    expect(find).toContain("CSS.highlights.set(HIT");
    expect(find).toMatch(/useEffect\(\(\) => clearHighlights, \[\]\);/);
  });

  it("不支持 CSS Custom Highlight 的环境不显示查找入口（降级而不是报错）", () => {
    expect(find).toContain('"highlights" in CSS');
    expect(read(`${PREVIEW_DIR}/document-pane.tsx`)).toContain("find.supported &&");
  });

  it("查找条里按 Esc 只关查找条（阻止冒泡成关预览窗）", () => {
    expect(ui).toMatch(/e\.key === "Escape"\) \{[^}]*e\.stopPropagation\(\);[^}]*onClose\(\);/s);
  });

  it("globals.css 里有两档高亮样式", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain("::highlight(preview-find)");
    expect(css).toContain("::highlight(preview-find-active)");
  });
});

describe("body 分发表覆盖了所有可预览类型", () => {
  it("每个 viewer 都被 import 并在 switch 里用到", () => {
    for (const v of ["ArchiveViewer", "CodeViewer", "CsvViewer", "DocumentPane", "ImageViewer", "JsonViewer", "MarkdownViewer", "SlidesViewer", "SvgViewer", "TableViewer"]) {
      expect(body, v).toMatch(new RegExp(`import \\{[^}]*\\b${v}\\b[^}]*\\} from`));
      expect(body, v).toMatch(new RegExp(`<${v}\\b`));
    }
    for (const k of ["image", "pdf", "docx", "xlsx", "csv", "pptx", "archive", "svg", "markdown", "code", "text"]) {
      expect(body, k).toContain(`case "${k}":`);
    }
  });
});
