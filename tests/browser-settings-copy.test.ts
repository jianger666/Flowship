/**
 * 「内置浏览器」设置卡文案的契约（src/lib/browser-settings-copy.ts + src/components/settings/browser-card.tsx）。
 *
 * 背景（2026-11-24 用户：「浏览器那儿，一大串一大串的字去掉」）：这张卡以前每行一大段说明。现在每行 = 名称 + 一句 hint，
 * 补充说明进名称后面的 ⓘ（SettingRow 的 detail，悬停 / 聚焦才出）。披露性文案（导出含明文凭据、*.local 不放行……）
 * 没有删，只是挪进 detail——所以要钉三件事：
 *   ① hint 真的是一句话（不会又悄悄长回去）、detail 也不是另一面墙；
 *   ② 做决定必须看到的「风险 / 默认值」词留在行内 hint 里，没有全藏进气泡；
 *   ③ 卡片真的按这份数据渲染（label / hint 都在、顺序对、有 detail 的行有 ⓘ、开关的名称 / 说明接上了）。
 * 气泡内容本身（披露事实）由 browser-r6-s3-net-hygiene / browser-r6-s5-redact 两个老契约测试管。
 * SSR 渲染，没有 DOM：看不到真实视觉效果，那一步要在 Electron 里手点。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserSection } from "@/components/settings/browser-card";
import { DialogProvider } from "@/hooks/use-dialog";
import { BROWSER_SETTING_COPY } from "@/lib/browser-settings-copy";
import { certScopeKey, decideCertError } from "../electron-app/browser/net-guard.mjs";
import { DETAIL_MAX, HINT_MAX } from "./helpers/settings-copy-limits";

// hint / detail 的字数上限与 settings-hint-brevity.test.ts 共用同一份（tests/helpers/settings-copy-limits.ts，S-4）

const noop = () => undefined;
const html = renderToStaticMarkup(
  createElement(
    DialogProvider,
    null,
    createElement(BrowserSection, {
      evaluateEnabled: false,
      onEvaluateEnabledChange: noop,
      recordInputValues: false,
      onRecordInputValuesChange: noop,
      storageAccess: false,
      onStorageAccessChange: noop,
      pagePermissions: false,
      onPagePermissionsChange: noop,
      trustLoopbackCerts: true,
      onTrustLoopbackCertsChange: noop,
      networkBodyRead: true,
      onNetworkBodyReadChange: noop,
      advancedTools: true,
      onAdvancedToolsChange: noop,
      maxTabs: 20,
      onMaxTabsChange: noop,
    }),
  ),
);

type Entry = { key: string; label: string; hint: string; detail?: string };
const entries: Entry[] = Object.entries(BROWSER_SETTING_COPY).map(([key, v]) => ({
  key,
  label: v.label,
  hint: v.hint,
  detail: "detail" in v ? v.detail : undefined,
}));
const withDetail = entries.filter((e) => e.detail !== undefined);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** React SSR 的文本转义（& < > " '），detail 里若出现这些字符，HTML 里的样子和源数据不同 */
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("浏览器卡文案：一句话 hint + 气泡 detail", () => {
  it("取到了全部 9 项（别让下面的循环空转）", () => {
    expect(entries.map((e) => e.key)).toEqual([
      "evaluate",
      "storage",
      "permissions",
      "networkBody",
      "recordInput",
      "advancedTools",
      "loopbackCerts",
      "maxTabs",
      "clearData",
    ]);
  });

  for (const e of entries) {
    it(`${e.label}：hint 是一句话（≤ ${HINT_MAX} 字、不换行），detail（若有）不超过 ${DETAIL_MAX} 字`, () => {
      expect(e.hint.length, e.hint).toBeGreaterThan(0);
      expect(e.hint.length, e.hint).toBeLessThanOrEqual(HINT_MAX);
      expect(e.hint, "hint 里不要换行").not.toMatch(/[\r\n]/);
      if (e.detail !== undefined) {
        expect(e.detail.length, e.detail).toBeGreaterThan(0);
        expect(e.detail.length, e.detail).toBeLessThanOrEqual(DETAIL_MAX);
      }
    });
  }

  it("做决定必须看到的词留在行内 hint：默认关闭 / 风险 / 明文 / 默认只记…（没有全藏进 ⓘ）", () => {
    const hint = (k: keyof typeof BROWSER_SETTING_COPY) => BROWSER_SETTING_COPY[k].hint;
    expect(hint("evaluate")).toContain("风险");
    expect(hint("evaluate")).toContain("默认关闭");
    expect(hint("storage")).toContain("明文");
    expect(hint("storage")).toMatch(/写入|删除|导出|导入/);
    expect(hint("recordInput")).toContain("默认只记");
    expect(hint("loopbackCerts")).toContain("localhost");
    expect(hint("clearData")).toContain("重新登录");
  });

  // ── 2026-11-24 评审 S-2 / S-8：文案不能少说、说过头（事实出处见 browser-settings-copy.ts 头注释） ──
  const C = BROWSER_SETTING_COPY;

  it("S-2 页面权限：hint 点名摄像头和麦克风；detail 不再说「不会静默打开」，写明 AI 也能授予、明确要求才授予只是约定、屏幕共享 / USB 永远拒绝", () => {
    expect(C.permissions.hint).toContain("摄像头");
    expect(C.permissions.hint).toContain("麦克风");
    expect(C.permissions.detail).not.toContain("不会静默打开");
    expect(C.permissions.detail).toContain("AI 也能替你授予摄像头 / 麦克风");
    expect(C.permissions.detail).toContain("你明确要求");
    expect(C.permissions.detail).toContain("不是硬性拦截");
    expect(C.permissions.detail).toContain("屏幕共享和 USB 永远拒绝");
  });

  it("S-8c 默认开的两项（网络正文 / 本机证书）hint 里写「默认开」；默认关的项（含高级调试）不写，高级调试明写「默认关」", () => {
    for (const k of ["networkBody", "loopbackCerts"] as const) expect(C[k].hint, k).toContain("默认开");
    // 默认关的几项不能带「默认开」（含「默认开启」字样的子串也不行）
    for (const k of ["evaluate", "storage", "permissions", "recordInput", "advancedTools"] as const) expect(C[k].hint, k).not.toContain("默认开");
    // 高级调试默认关（整组工具说明常驻 prompt，默认不挂才省 token）：用户得主动打开，hint 必须说清「默认关」
    expect(C.advancedTools.hint).toContain("默认关");
  });

  it("S-8a / R20-13 高级调试：关闭时进行中的会话也马上被拒；省提示词要到新会话才生效、重新开启也只对新会话——两件事分开说，不再混成一句「立即生效」", () => {
    const d = C.advancedTools.detail;
    expect(d).toContain("进行中的会话也会马上拒绝");
    expect(d).toContain("新开始的会话才会变短");
    expect(d).toContain("也只有新开始的会话才带上它们");
    // 旧句把「省提示词」和「立即生效」写在一起（实际只有拒绝是实时的）
    expect(d).not.toContain("立即生效");
    expect(d).not.toContain("可以省一些提示词，");
    expect(d).not.toBe("关闭可以省一些提示词。对新开始的会话生效。");
  });

  it("S-8b / R20-13 本机证书：只有主页面的证书错误才询问；子资源被拒绝，但「已放行的除外」——不再写成「直接拒绝」", () => {
    const d = C.loopbackCerts.detail;
    expect(d).not.toContain("其它网站的证书错误同样要你在面板上确认");
    expect(d).toContain("只有主页面的证书错误才会在面板上问你");
    expect(d).toContain("子资源");
    expect(d).toContain("会被拒绝，除非你已在面板上放行过该网站的这张证书");
    expect(d).toContain("不落盘，重启后失效");
    expect(d).not.toContain("直接拒绝");
  });

  it("R20-13 文案 ↔ 代码（本机证书）：子资源证书错误默认 deny；该 host + 这张证书已被用户放行（allow-host）则 allow——「除非已放行」是真的，且不跨 partition / 指纹", () => {
    const base = { config: { trustLoopbackCerts: true }, isAppUrl: () => false, isMainFrame: false, fingerprint: "sha256/AAAA", partition: "persist:a" };
    const url = "https://dev.example.com:8443/app.js";
    const allowed = new Map([[certScopeKey("persist:a", "dev.example.com:8443"), new Set(["sha256/AAAA"])]]);
    // 没放行过：子资源 → deny（文案「会被拒绝」）；主框架 → ask（文案「才会在面板上问你」）
    expect(decideCertError({ ...base, url })).toMatchObject({ action: "deny", reason: "subresource" });
    expect(decideCertError({ ...base, url, isMainFrame: true })).toMatchObject({ action: "ask" });
    // 用户已放行这个 host 的这张证书：子资源也放行（文案「除非你已在面板上放行过该网站的这张证书」）
    expect(decideCertError({ ...base, url, allowedCerts: allowed })).toMatchObject({ action: "allow", reason: "user-allowed" });
    // 「这张证书」：换一张指纹不算；「不跨 partition」：无痕 / 别的档案里放行的不算
    expect(decideCertError({ ...base, url, allowedCerts: allowed, fingerprint: "sha256/BBBB" })).toMatchObject({ action: "deny" });
    expect(decideCertError({ ...base, url, allowedCerts: allowed, partition: "persist:b" })).toMatchObject({ action: "deny" });
    // 回环信任：开关开着时本机子资源也放行；开关关掉就回到 deny（文案里「本机」那几项由开关管）
    expect(decideCertError({ ...base, url: "https://localhost:3000/a.js" })).toMatchObject({ action: "allow", reason: "loopback" });
    expect(decideCertError({ ...base, url: "https://localhost:3000/a.js", config: { trustLoopbackCerts: false } })).toMatchObject({ action: "deny" });
  });

  it("S-8d 脱敏是规则尽力而为：网络正文 / 输入内容的说明都不再说「自动隐去 / 打码」的绝对话，写明不保证全部", () => {
    expect(C.networkBody.detail).not.toContain("会自动隐去");
    expect(C.networkBody.detail).toContain("尽力");
    expect(C.networkBody.detail).toContain("不保证全部");
    expect(C.recordInput.detail).toContain("尽力");
    expect(C.recordInput.detail).toContain("不保证全部");
    // browser-r6-s5-redact 钉的「仍会自动打码」「密码框…不记录」仍在
    expect(C.recordInput.detail).toContain("仍会自动打码");
    expect(C.recordInput.detail).toContain("密码框的内容无论如何都不记录");
  });

  it("S-8e 页面脚本总闸：detail 写全同一道审批管的几项（evaluate / 堆快照 / 可执行 mock / 运行时变量 / 带条件断点）及对应工具名", () => {
    const d = C.evaluate.detail;
    for (const word of ["仅本任务允许", "永久开启", "拒绝", "堆快照", "可执行 mock", "运行时变量", "带条件断点"]) {
      expect(d, word).toContain(word);
    }
    for (const tool of ["browser_perf", "browser_network_rules", "browser_debug"]) expect(d, tool).toContain(tool);
  });
});

describe("浏览器卡渲染：按数据出行", () => {
  it("每一项的名称和说明都渲染出来，顺序 = 数据顺序", () => {
    let last = -1;
    for (const e of entries) {
      const at = html.indexOf(e.label);
      expect(at, `${e.label} 没渲染出来`).toBeGreaterThan(-1);
      expect(at, `${e.label} 顺序不对`).toBeGreaterThan(last);
      last = at;
      // 「清除」行在 SSR 里是未挂载态（desktop=false）：说明显示「仅桌面端可用」，下面单独断言
      if (e.key !== "clearData") expect(html, `${e.label} 的说明没渲染`).toContain(e.hint);
    }
  });

  it("有 detail 的行有 ⓘ（读屏名字「<名称>：更多说明」）、没有 detail 的行没有", () => {
    for (const e of withDetail) expect(html, e.label).toContain(`aria-label="${e.label}：更多说明"`);
    expect(withDetail).toHaveLength(8);
    expect((html.match(/：更多说明"/g) ?? []).length).toBe(withDetail.length);
    // 气泡悬停才挂载；读屏另有一份常驻 sr-only 文本（S-3）。detail 在整页里只出现一次、且就在 sr-only 容器里——可见文字里没有它
    for (const e of withDetail) {
      const text = escHtml(e.detail!);
      expect(html.split(text).length - 1, `${e.label} 的 detail 应只出现一次（sr-only）`).toBe(1);
      const srId = new RegExp(`<span id="([^"]+)" class="sr-only">${esc(text)}</span>`).exec(html)?.[1];
      expect(srId, `${e.label} 的 detail 应在 sr-only 容器里`).toBeTruthy();
      // ⓘ 按钮用 aria-describedby 指向它
      const btn = new RegExp(`<button[^>]*aria-label="${esc(e.label)}：更多说明"[^>]*>`).exec(html)?.[0] ?? "";
      expect(btn, `${e.label} 的 ⓘ`).toContain(`aria-describedby="${srId}"`);
    }
  });

  it("清除行：桌面壳不在场（SSR / dev:web）时说明改成「仅桌面端可用」、按钮禁用", () => {
    const { clearData } = BROWSER_SETTING_COPY;
    expect(html).toContain(clearData.unavailable);
    expect(html).not.toContain(clearData.hint);
    // 属性 disabled（前面是空白、后面不是 `:`）——class 里的 `disabled:opacity-50` 变体不算
    expect(html).toMatch(/<button[^>]*\sdisabled(?=[=\s>])[^>]*>清除<\/button>/);
  });

  it("7 个开关：名称 / 说明都接上了（labelledby 指向行名称，describedby 指向行说明）", () => {
    const tags = [...html.matchAll(/<[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(7);
    const labels = new Set(entries.map((e) => e.label));
    const hints = new Set(entries.map((e) => e.hint));
    for (const tag of tags) {
      const labelledBy = /\saria-labelledby="([^"]+)"/.exec(tag)?.[1];
      const describedBy = /\saria-describedby="([^"]+)"/.exec(tag)?.[1];
      expect(labelledBy, tag).toBeTruthy();
      expect(describedBy, tag).toBeTruthy();
      const text = (id: string) => new RegExp(`id="${esc(id)}"[^>]*>([^<]*)<`).exec(html)?.[1];
      expect(labels.has(text(labelledBy!) ?? ""), `labelledby → ${text(labelledBy!)}`).toBe(true);
      expect(hints.has(text(describedBy!) ?? ""), `describedby → ${text(describedBy!)}`).toBe(true);
    }
  });
});
