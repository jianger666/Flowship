/**
 * 地址栏记忆 UI：
 * - SSR 渲染（输入框的 ARIA / 属性、联想行的各种形态）——下拉本体在 Portal 里服务端是空的，所以行（SuggestionRow）单独导出来渲染；
 *   键盘 / 鼠标 / 焦点的真实交互在 Electron 真机里验（scripts/browser-e2e/r13-panel-layout.cjs 的联想用例）；
 * - 源码契约：只有「地址栏里敲 / 联想里选」的导航才会记（remember: true 只出现一处）、搜索词与老壳不记、聊天链接 / 收藏项 / 预览入口不记；
 *   「更多」菜单里有清除入口；地址栏 <form> 的结构没被破坏（星标定位参照）；
 *   记忆刻意**不是 AI 工具**：AI 侧 / 主进程 / prompts / skills 里不出现它的模块与接口。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AddressInput, SuggestionRow } from "@/components/browser/address-input";
import { Autocomplete, AutocompleteList } from "@/components/ui/autocomplete";
import type { AddressSuggestion } from "@/lib/browser-history";

const noop = () => {};

const sug = (over: Partial<AddressSuggestion> = {}): AddressSuggestion => ({
  url: "https://example.com/docs/",
  title: "示例文档",
  historyId: "h-1",
  bookmarked: false,
  ...over,
});

/** 行必须在 Autocomplete 上下文里才能渲染（base-ui 的 Item 要读 Root 的 context）；不带 Portal / Popup，服务端能直接出 HTML */
const renderRow = (s: AddressSuggestion) =>
  renderToStaticMarkup(
    createElement(
      Autocomplete,
      { items: [s.url], mode: "none", open: true },
      createElement(AutocompleteList, null, createElement(SuggestionRow, { suggestion: s, onPick: noop, onRemove: noop })),
    ),
  );

describe("SuggestionRow", () => {
  it("历史项：标题、去协议的地址、历史图标；带「×」按钮（引用标题的 aria-label）", () => {
    const html = renderRow(sug());
    expect(html).toContain("示例文档");
    expect(html).toContain(">example.com/docs<"); // displayBookmarkUrl：去协议、去末尾斜杠
    expect(html).toContain('aria-label="从联想中删除「示例文档」"');
    expect(html).not.toContain("fill-warning");
    expect(html).not.toContain("已收藏");
  });

  it("收藏项：星形填色 + 读屏提示「已收藏」", () => {
    const html = renderRow(sug({ bookmarked: true }));
    expect(html).toContain("fill-warning");
    expect(html).toContain("已收藏：");
  });

  it("只在收藏里（不是历史）：没有「×」——从联想里删不掉收藏，删除收藏在收藏夹里做", () => {
    const html = renderRow(sug({ historyId: null, bookmarked: true }));
    expect(html).not.toContain("从联想中删除");
    expect(html).not.toContain("<button");
  });

  it("「×」：type=button、不进 Tab 序、平时不可见、该行高亮（悬停 / 键盘选中）时才露出——且不能用 display:none 摘掉", () => {
    const html = renderRow(sug());
    const btn = html.match(/<button\b[^>]*>/)?.[0] ?? "";
    expect(btn).toContain('type="button"');
    expect(btn).toContain('tabindex="-1"');
    expect(btn).toMatch(/class="[^"]*\binvisible\b/);
    expect(btn).toContain("group-data-[highlighted]:visible");
    expect(btn).not.toMatch(/\bhidden\b/);
  });

  it("页面标题是页面可控的文字：按纯文本转义，绝不出现可执行的标签 / 属性（行内与 aria-label 都一样）", () => {
    const evil = `<img src=x onerror=alert(1)>"><script>alert(2)</script>`;
    const html = renderRow(sug({ title: evil }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toMatch(/aria-label="从联想中删除「&lt;img/);
  });

  it("标题为空：行内退回显示地址，不留空行", () => {
    const html = renderRow(sug({ title: "" }));
    expect(html).toContain(">https://example.com/docs/<"); // 标题位
    expect(html).toContain(">example.com/docs<"); // 地址位
  });

  it("行是 role=option（base-ui 的 Item），listbox 带名字", () => {
    const html = renderRow(sug());
    expect(html).toContain('role="option"');
    expect(html).toContain('role="listbox"');
  });
});

describe("AddressInput（服务端渲染）", () => {
  const render = (over: Partial<Parameters<typeof AddressInput>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(AddressInput, {
        value: "https://example.com/",
        onTextChange: noop,
        onFocus: noop,
        onBlur: noop,
        onEscape: noop,
        suggestions: [],
        onPick: noop,
        onRemove: noop,
        anchorRef: { current: null },
        placeholder: "输入网址或搜索词",
        className: "h-7 text-xs",
        ...over,
      }),
    );

  it("输入框：aria-label=地址栏、占位提示、值、关掉拼写检查与浏览器自带的自动补全（避免两个下拉叠在一起）", () => {
    const html = render();
    expect(html).toContain('aria-label="地址栏"');
    expect(html).toContain('placeholder="输入网址或搜索词"');
    expect(html).toContain('value="https://example.com/"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("h-7 text-xs");
  });

  it("是 combobox（读屏能报「有联想」）", () => {
    expect(render()).toContain('role="combobox"');
  });

  it("带一个隐藏的默认提交按钮：Enter 提交表单的前提——base-ui 在 Root 旁塞了隐藏文本框，表单里有两个文本框，浏览器「只有一个文本框才靠 Enter 隐式提交」的规则会失效（真机 r13-29 验 Enter 真能提交）", () => {
    const html = render();
    const btn = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(btn).toContain("hidden");
    expect(btn).toContain('aria-hidden="true"');
    expect(btn).toContain('tabindex="-1"');
    // 只有这一个按钮（联想行里的「×」在 Portal 里，不在输入框这一层）
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("有联想时服务端也不渲染下拉本体（Portal 水合后才有）：不造成水合不一致", () => {
    const html = render({ suggestions: [sug()] });
    expect(html).not.toContain("示例文档");
    expect(html).toContain('aria-label="地址栏"');
  });
});

// ───────────── 源码契约 ─────────────
describe("接线（源码契约）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  // 剥注释（块注释 + 行注释，保留 URL 里的 ://）；本文件只断言代码结构
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const panel = () => strip(read("src/components/browser/browser-panel.tsx"));

  it("只有「地址栏里敲 / 联想里选」才记：remember: true 全文件只出现一处（submitAddress），其余导航入口（聊天链接 / 预览 / 收藏项）默认不记", () => {
    const src = panel();
    expect(src.match(/remember:\s*true/g)).toHaveLength(1);
    expect(src).toMatch(/const submitAddress = \(text: string\) => \{[\s\S]*?navigate\(text, \{ remember: true \}\);/);
    // 回车提交与点联想都走 submitAddress
    expect(src).toMatch(/onSubmitAddress = \(e: FormEvent<HTMLFormElement>\) => \{[\s\S]*?submitAddress\(draft\);/);
    expect(src).toMatch(/pickSuggestion = \(s: AddressSuggestion\) => submitAddress\(s\.url\)/);
    // navigate 默认 remember=false；收藏项 / 聊天链接那几处调用不带第二个参数
    expect(src).toMatch(/\(raw: string, \{ remember = false \}: \{ remember\?: boolean \} = \{\}\)/);
    expect(src).toMatch(/else navigate\(url\);/);
    expect(src).toMatch(/else navigate\(nav\.url\);/);
  });

  it("记录的前提：主进程接受了、是网址（不是搜索词）、回了解析后的地址（老壳不回 → 不记）", () => {
    const src = panel();
    expect(src).toMatch(/if \(remember && res\.kind === "url" && typeof res\.url === "string"\) \{\s*beginTypedVisit\(/);
    // 登记的是主进程解析后的地址、提交那一刻的活动标签（不是之后才推送到的状态）
    expect(src).toMatch(/const before = findActiveTab\(stateRef\.current\);[\s\S]*?const res = await bridge\.navigate\(taskId, input\);/);
    expect(src).toMatch(/beginTypedVisit\(\{ url: res\.url, tabId: before\?\.id \?\? null, startUrl: before\?\.url \?\? "", startedAt \}\)/);
    // 被拒绝 / 失败的导航不登记
    expect(src).toMatch(/if \(!res\.ok\) \{\s*toast\.error\([^;]*\);\s*return;\s*\}/);
  });

  it("联想按「聚焦时刻」排序，渲染里不调 Date.now()（react-hooks 纯度 + SSR 一致）", () => {
    const src = panel();
    expect(src).toMatch(/setFocusedAt\(Date\.now\(\)\)/);
    expect(src).toMatch(/now: focusedAt,/);
    // Date.now() 只出现在事件 / 回调里：doNavigate 的 startedAt 与聚焦处理，不在组件渲染体里
    expect(src.match(/Date\.now\(\)/g)).toHaveLength(2);
  });

  it("联想与排序用的是收藏夹 + 记忆；选中 → 打开；× → 删记忆（失败有提示）", () => {
    const src = panel();
    expect(src).toMatch(/history: history\.history,\s*bookmarks: bookmarkApi\.bookmarks,/);
    expect(src).toMatch(/history\.remove\(s\.historyId\)\.catch\(\(err\) => toast\.error\(`删除失败：\$\{historyErrorText\(err\)\}`\)\)/);
    expect(src).toMatch(/if \(s\.historyId === null\) return;/);
  });

  it("地址栏：AddressInput 在 <form onSubmit={onSubmitAddress}> 里（Enter 照旧走表单提交），下拉锚在整条工具栏上", () => {
    const src = panel();
    const start = src.indexOf("<form onSubmit={onSubmitAddress}");
    expect(start).toBeGreaterThan(0);
    const form = src.slice(start, src.indexOf("</form>", start));
    expect(form).toContain("<AddressInput");
    expect(form).toMatch(/anchorRef=\{toolbarRef\}/);
    expect(src.match(/<AddressInput\b/g)).toHaveLength(1);
    expect(src).toMatch(/<div\s+ref=\{toolbarRef\}\s+data-slot="browser-toolbar"/);
  });

  it("每次聚焦拉一次最新记忆（别的窗口 / 任务可能改过）；失败不弹提示", () => {
    const src = panel();
    expect(src).toMatch(/void history\.reload\(\);/);
  });

  it("「更多」菜单里有「清除浏览历史」，在「清除登录数据」之前、走确认流程（不是直接清）", () => {
    const src = panel();
    const history = src.indexOf("清除浏览历史");
    const login = src.indexOf("清除登录数据");
    expect(history).toBeGreaterThan(0);
    expect(login).toBeGreaterThan(history);
    expect(src).toMatch(/<DropdownMenuItem onClick=\{\(\) => void clearHistory\(\)\}>/);
    expect(src).toMatch(/await runClearHistory\(\{\s*confirm,\s*clear: history\.clear,/);
  });

  it("记录靠 useTypedVisitRecorder：喂标签状态与 history.record；面板里没有第二处记录入口", () => {
    const src = panel();
    expect(src).toMatch(/useTypedVisitRecorder\(\{ tabs: state\?\.tabs, record: history\.record \}\)/);
    expect(src.match(/history\.record\b/g)).toHaveLength(1);
  });

  it("记忆的 UI 模块只请求记忆接口：不碰 window.__browser 桥、不开窗口、不渲染 HTML、不直接导航", () => {
    const files = [
      "history-flow.ts",
      "history-store.ts",
      "use-history.ts",
      "typed-visit.ts",
      "typed-visit-recorder.ts",
      "use-typed-visit-recorder.ts",
      "address-input.tsx",
    ].map((f) => [f, strip(read(`src/components/browser/${f}`))] as const);
    for (const [name, src] of files) {
      expect(src, `${name} 不应碰桥`).not.toMatch(/window\.__browser|__browser/);
      expect(src, `${name} 不应开窗口`).not.toMatch(/window\.open\b/);
      expect(src, `${name} 不应渲染 HTML`).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
      expect(src, `${name} 不应直接发起导航`).not.toMatch(/location\.(href|assign|replace)\s*=|\bwindow\.location\b/);
    }
    const store = files.find(([n]) => n === "history-store.ts")![1];
    expect(store.match(/doFetch\(/g)?.length, "store 里每个请求都应带着 HISTORY_API").toBeGreaterThan(0);
    for (const m of store.matchAll(/doFetch\(([^,)]*)/g)) expect(m[1], m[0]).toMatch(/HISTORY_API/);
  });

  it("纯逻辑模块（flow / typed-visit / recorder 执行体）不依赖 React / window / sonner，可在 node 里测", () => {
    for (const f of ["history-flow.ts", "typed-visit.ts", "typed-visit-recorder.ts"]) {
      const src = strip(read(`src/components/browser/${f}`));
      expect(src, f).not.toMatch(/from "react"|from "sonner"|\bwindow\b|document\./);
    }
  });

  it("联想的 Esc 约定：下拉开着时第一下只收下拉并拦住冒泡，再按才退出编辑", () => {
    const src = strip(read("src/components/browser/address-input.tsx"));
    expect(src).toMatch(/if \(open\) \{\s*e\.stopPropagation\(\);\s*setDismissed\(true\);\s*return;\s*\}\s*onEscape\(e\.currentTarget\);/);
  });

  it("输入框的值始终由调用方说了算：只认用户亲自敲 / 贴出来的变化（input-change），选中项 / Esc 清空等请求一律忽略", () => {
    const src = strip(read("src/components/browser/address-input.tsx"));
    expect(src).toMatch(/if \(details\.reason !== "input-change"\) return;/);
    expect(src).toContain('mode="none"');
  });

  it("不做行内补全（与输入法组词冲突）：没有 autoHighlight / inline 补全接线", () => {
    const src = strip(read("src/components/browser/address-input.tsx"));
    expect(src).not.toMatch(/autoHighlight|inline/);
  });

  it("记忆刻意不是 AI 工具：AI 侧 / 主进程 / prompts / skills 里不出现它的模块与接口（服务端只有它自己的存储模块与接口）", () => {
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
      });
    // 用标识符 / 路径特征匹配，不用中文词：主进程注释里会写「地址栏记忆」来解释 loadFailed 与 navigate 返回值的用途
    const markers = /browser-history|browserHistory|history-store|api\/browser\/history|typed-visit|HISTORY_FILE|recordHistoryVisit/;
    const offenders: string[] = [];
    for (const dir of ["electron-app", "prompts", "skills", "src/lib/server/browser"]) {
      for (const rel of walk(dir)) {
        if (!/\.(mjs|cjs|js|ts|tsx|md)$/.test(rel)) continue;
        if (markers.test(readFileSync(path.join(root, rel), "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    // 服务端其余代码：只有存储模块自己 + 它的接口
    const serverHits = walk("src/lib/server")
      .filter((rel) => /\.(ts|tsx)$/.test(rel))
      .filter((rel) => markers.test(readFileSync(path.join(root, rel), "utf8")));
    expect(serverHits).toEqual(["src/lib/server/browser-history.ts"]);
  });

  it("主进程只多了两个「信号」：navigate 回 {url, kind}、TabInfo 带 loadFailed；这两处都不包含记忆逻辑，AI 工具的标签输出也不带 loadFailed", () => {
    const tab = strip(read("electron-app/browser/tab.mjs"));
    expect(tab).toMatch(/\.\.\.\(this\.lastLoadError \? \{ loadFailed: true \} : \{\}\)/);
    const index = strip(read("electron-app/browser/index.mjs"));
    expect(index).toMatch(/return \{ ok: true, url: r\.url, kind: r\.kind \};/);
    const tools = strip(read("src/lib/server/browser/tools.ts"));
    expect(tools).not.toContain("loadFailed");
  });
});
