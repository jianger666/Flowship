/**
 * R2-13 ①：favicon 判定的「渲染端 ↔ 主进程」口径一致性。
 *
 * 渲染端（`src/components/browser/browser-status.ts` 的 `isSafeFaviconUrl` / `isNonPublicHostname`）不能 import
 * `electron-app/*.mjs`（打包边界），只能手写一份镜像；这里用**动态 `import()`** 直接加载主进程的真实实现
 * （`electron-app/browser/url-policy.mjs`，不是读源码、不是复制函数体），把同一张边界向量表同时喂给两端：
 *  - 每条向量先有一个**人工标注的 expected**（防「两边同时错成一样」），主进程必须等于它；
 *  - 渲染端必须等于主进程（口径一致），唯一例外是下面 RENDERER_STRICTER 里**有意**更严的几条——
 *    它们被精确钉死（主进程放行、渲染端拒绝），主进程哪天补上了，这里会红、提醒同步删掉例外；
 *  - 无论哪条，都断言「渲染端放行 ⇒ 主进程放行」：渲染端永远不能比主进程更松。
 */
import { describe, expect, it } from "vitest";

import {
  FAVICON_MAX_LENGTH,
  isNonPublicHostname,
  isSafeFaviconUrl,
  safeFaviconSrc,
} from "@/components/browser/browser-status";

interface MainUrlPolicy {
  isSafeFaviconUrl: (url: unknown, opts?: { isAppUrl?: (url: string) => boolean }) => boolean;
  isNonPublicHostname: (hostname: string) => boolean;
}
const main = (await import("../electron-app/browser/url-policy.mjs")) as unknown as MainUrlPolicy;

const APP_ORIGIN = "https://flow.example.com";
const mainIsAppUrl = (href: string): boolean => {
  try {
    return new URL(href).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};
const mainVerdict = (url: unknown): boolean => main.isSafeFaviconUrl(url, { isAppUrl: mainIsAppUrl });
const rendererVerdict = (url: unknown): boolean => isSafeFaviconUrl(url, APP_ORIGIN);

const dataUrlOfLength = (n: number, mime = "image/png"): string => {
  const head = `data:${mime};base64,`;
  return head + "A".repeat(Math.max(0, n - head.length));
};
const httpsUrlOfLength = (n: number): string => {
  const head = "https://example.com/";
  return head + "a".repeat(Math.max(0, n - head.length));
};

interface Vector {
  label: string;
  url: unknown;
  /** 人工标注的「该不该放行」（主进程的结论） */
  expected: boolean;
}

/** reviewer 点名的各类边界（R2-13 ①），外加既有的回环 / 私网 / 协议 / data 清单 */
const VECTORS: Vector[] = [
  // ── 应放行：普通公网 https / 位图 data ──
  { label: "普通域名", url: "https://example.com/favicon.ico", expected: true },
  { label: "带端口的域名", url: "https://example.com:8443/favicon.ico", expected: true },
  { label: "公网 IPv4", url: "https://8.8.8.8/f.ico", expected: true },
  { label: "localhost 只是子串的域名", url: "https://notlocalhost.com/f.ico", expected: true },
  { label: "172.15 / 172.32 不在私网段", url: "https://172.15.0.1/f.ico", expected: true },
  { label: "172.32", url: "https://172.32.0.1/f.ico", expected: true },
  { label: "223.255.255.255（224 以下）", url: "https://223.255.255.255/f.ico", expected: true },
  { label: "192.1.0.1（192.0/16 以外）", url: "https://192.1.0.1/f.ico", expected: true },
  { label: "大写协议 HTTPS:", url: "HTTPS://example.com/f.ico", expected: true },
  { label: "大写主机名", url: "https://EXAMPLE.com/f.ico", expected: true },
  { label: "IDN（规整成 punycode 后是公网域）", url: "https://例え.jp/f.ico", expected: true },
  { label: "punycode 写法", url: "https://xn--r8jz45g.jp/f.ico", expected: true },
  { label: "单个末尾点的公网域", url: "https://example.com./f.ico", expected: true },
  { label: "前后空白（new URL 会剥）", url: " https://example.com/f.ico ", expected: true },
  { label: "data:png", url: "data:image/png;base64,AAAA", expected: true },
  { label: "data:大写 DATA: + 大写 mime", url: "DATA:image/PNG;base64,AAAA", expected: true },
  { label: "data:jpeg / gif / webp / x-icon", url: "data:image/x-icon;base64,AAAA", expected: true },
  { label: "data:vnd.microsoft.icon（.ico 的标准 mime）", url: "data:image/vnd.microsoft.icon;base64,AAAA", expected: true },
  { label: "https 恰好 16000 字符", url: httpsUrlOfLength(FAVICON_MAX_LENGTH), expected: true },
  { label: "data: 恰好 16000 字符", url: dataUrlOfLength(FAVICON_MAX_LENGTH), expected: true },

  // ── 应拒绝：协议 / 长度 / data 类型 ──
  { label: "http 一律不放", url: "http://example.com/f.ico", expected: false },
  { label: "javascript:", url: "javascript:alert(1)", expected: false },
  { label: "file:", url: "file:///etc/passwd", expected: false },
  { label: "协议相对（解析不了）", url: "//example.com/f.ico", expected: false },
  { label: "解析不了", url: "https://", expected: false },
  { label: "主机名带空格", url: "https://exa mple.com/f.ico", expected: false },
  { label: "非字符串 undefined", url: undefined, expected: false },
  { label: "非字符串 数字", url: 42, expected: false },
  { label: "空串", url: "", expected: false },
  { label: "https 16001 字符（超长）", url: httpsUrlOfLength(FAVICON_MAX_LENGTH + 1), expected: false },
  { label: "data: 16001 字符（超长）", url: dataUrlOfLength(FAVICON_MAX_LENGTH + 1), expected: false },
  { label: "data:svg 不放（可带脚本 / 外链）", url: "data:image/svg+xml;base64,AAAA", expected: false },
  { label: "data:svg 明文", url: "data:image/svg+xml,<svg onload=alert(1)>", expected: false },
  { label: "data:text/html", url: "data:text/html;base64,AAAA", expected: false },
  { label: "data: mime 只是前缀 image/pngx", url: "data:image/pngx;base64,AAAA", expected: false },
  { label: "data: 前导空白（主进程不 trim → 不算 data → 协议被拒）", url: " data:image/png;base64,AAAA", expected: false },
  { label: "带 userinfo", url: "https://user:pw@example.com/f.ico", expected: false },
  { label: "只有 user 的 userinfo", url: "https://user@example.com/f.ico", expected: false },

  // ── 应拒绝：回环 / 私网 / 链路本地 / CGNAT ──
  { label: "localhost", url: "https://localhost/f.ico", expected: false },
  { label: "LOCALHOST 大写", url: "https://LOCALHOST/f.ico", expected: false },
  { label: "localhost 尾点", url: "https://localhost./f.ico", expected: false },
  { label: "*.localhost", url: "https://a.localhost/f.ico", expected: false },
  { label: "127.0.0.1", url: "https://127.0.0.1/f.ico", expected: false },
  { label: "127.1 简写（WHATWG 规整成 127.0.0.1）", url: "https://127.1/f.ico", expected: false },
  { label: "127.0.1 简写", url: "https://127.0.1/f.ico", expected: false },
  { label: "0x7f.1 十六进制", url: "https://0x7f.1/f.ico", expected: false },
  { label: "十进制整数 IP", url: "https://2130706433/f.ico", expected: false },
  { label: "八进制 0177.0.0.1", url: "https://0177.0.0.1/f.ico", expected: false },
  { label: "0.0.0.0", url: "https://0.0.0.0/f.ico", expected: false },
  { label: "10.x", url: "https://10.0.0.5/f.ico", expected: false },
  { label: "172.16", url: "https://172.16.0.1/f.ico", expected: false },
  { label: "172.31.255.255", url: "https://172.31.255.255/f.ico", expected: false },
  { label: "192.168.x", url: "https://192.168.1.1/f.ico", expected: false },
  { label: "169.254.169.254（云元数据）", url: "https://169.254.169.254/latest/meta-data", expected: false },
  { label: "CGNAT 100.64.0.1", url: "https://100.64.0.1/f.ico", expected: false },
  { label: "CGNAT 100.127.255.255", url: "https://100.127.255.255/f.ico", expected: false },
  { label: "[::1]", url: "https://[::1]/f.ico", expected: false },
  { label: "[::ffff:7f00:1]（IPv4 映射）", url: "https://[::ffff:7f00:1]/f.ico", expected: false },
  { label: "IPv6 链路本地", url: "https://[fe80::1]/f.ico", expected: false },
  { label: "IPv6 唯一本地 fc00::/7", url: "https://[fd12:3456::1]/f.ico", expected: false },

  // ── 应拒绝：R2-13 ① 点名的「渲染端原先漏掉」的几类 ──
  { label: "单标签主机 intranet", url: "https://intranet/f.ico", expected: false },
  { label: "单标签主机 router", url: "https://router/favicon.ico", expected: false },
  { label: "单标签 + 端口", url: "https://nas:5001/f.ico", expected: false },
  { label: "单标签 + 单个尾点", url: "https://intranet./f.ico", expected: false },
  { label: "IDN 单标签（punycode 后无点）", url: "https://内网/f.ico", expected: false },
  { label: ".internal", url: "https://a.internal/f.ico", expected: false },
  { label: ".lan", url: "https://a.lan/f.ico", expected: false },
  { label: ".corp", url: "https://a.corp/f.ico", expected: false },
  { label: ".home", url: "https://a.home/f.ico", expected: false },
  { label: ".intranet", url: "https://a.intranet/f.ico", expected: false },
  { label: ".private", url: "https://a.private/f.ico", expected: false },
  { label: ".local（mDNS）", url: "https://printer.local/f.ico", expected: false },
  { label: "192.0.0.5（192.0.0.0/24 协议分配段）", url: "https://192.0.0.5/f.ico", expected: false },
  { label: "192.0.2.1（192.0.2.0/24 文档段）", url: "https://192.0.2.1/f.ico", expected: false },
  { label: "224.0.0.1（组播）", url: "https://224.0.0.1/f.ico", expected: false },
  { label: "239.255.255.250（组播上沿）", url: "https://239.255.255.250/f.ico", expected: false },
  { label: "240.0.0.1（保留）", url: "https://240.0.0.1/f.ico", expected: false },
  { label: "255.255.255.255（广播）", url: "https://255.255.255.255/f.ico", expected: false },

  // ── 应拒绝：与应用同 origin ──
  { label: "与应用同 origin", url: `${APP_ORIGIN}/api/x`, expected: false },
];

/**
 * 渲染端**有意**比主进程更严的向量：主进程放行、渲染端拒绝（精确钉死，见文件头）。
 * 对应 browser-status.ts 注释里的两处：公网 IPv6 字面量一律不放；主机名剥全部末尾点再判（主进程只剥一个）。
 */
const RENDERER_STRICTER: Vector[] = [
  { label: "公网 IPv6 字面量", url: "https://[2001:4860:4860::8888]/f.ico", expected: true },
  { label: "单标签 + 两个尾点（主进程只剥一个，会放过）", url: "https://intranet../f.ico", expected: true },
  { label: ".internal + 两个尾点", url: "https://a.internal../f.ico", expected: true },
  { label: ".lan + 两个尾点", url: "https://a.lan../f.ico", expected: true },
];

describe("favicon 判定：渲染端与主进程口径一致（R2-13 ①）", () => {
  it("向量表确实覆盖 reviewer 点名的各类（防有人删掉难的向量）", () => {
    const urls = VECTORS.map((v) => String(v.url));
    const has = (re: RegExp) => urls.some((u) => re.test(u));
    expect(has(/\/\/127\.1\//)).toBe(true); // 127.1 简写
    expect(has(/^HTTPS:/)).toBe(true); // 大写协议
    expect(has(/例え|xn--/)).toBe(true); // IDN
    expect(has(/^https:\/\/intranet\//)).toBe(true); // 单标签
    for (const suffix of ["internal", "lan", "corp"]) expect(has(new RegExp(`\\.${suffix}/`)), suffix).toBe(true);
    expect(has(/\/\/192\.0\.0\./)).toBe(true);
    expect(has(/\/\/(?:22[4-9]|2[3-5]\d)\./)).toBe(true); // ≥ 224
    expect(urls.some((u) => u.length === FAVICON_MAX_LENGTH + 1 && u.startsWith("data:"))).toBe(true); // 超长 data:
    expect(VECTORS.length).toBeGreaterThanOrEqual(75);
  });

  it.each(VECTORS.map((v) => [v.label, v] as const))("两端结论一致：%s", (_label, v) => {
    const m = mainVerdict(v.url);
    const r = rendererVerdict(v.url);
    expect(m, `主进程对 ${String(v.url).slice(0, 80)} 的结论应等于人工标注`).toBe(v.expected);
    expect(r, `渲染端对 ${String(v.url).slice(0, 80)} 的结论应与主进程一致`).toBe(m);
  });

  it("渲染端有意更严的几条：主进程放行、渲染端拒绝（精确钉死）", () => {
    for (const v of RENDERER_STRICTER) {
      expect(mainVerdict(v.url), `主进程：${v.label}`).toBe(true);
      expect(rendererVerdict(v.url), `渲染端：${v.label}`).toBe(false);
    }
  });

  it("渲染端永远不比主进程更松：对全部向量，渲染端放行 ⇒ 主进程放行", () => {
    for (const v of [...VECTORS, ...RENDERER_STRICTER]) {
      if (rendererVerdict(v.url)) expect(mainVerdict(v.url), String(v.url).slice(0, 80)).toBe(true);
    }
  });

  it("IPv4 全地址空间扫描：第一段 0..255 × 关键第二段，两端逐点一致（私网 / CGNAT / 192.0 / 组播边界不会漂）", () => {
    const seconds = [0, 1, 2, 15, 16, 31, 32, 63, 64, 100, 127, 128, 167, 168, 169, 170, 253, 254, 255];
    const diffs: string[] = [];
    for (let a = 0; a <= 255; a++) {
      for (const b of seconds) {
        const url = `https://${a}.${b}.3.4/f.ico`;
        if (mainVerdict(url) !== rendererVerdict(url)) diffs.push(`${a}.${b}.3.4`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it("isNonPublicHostname 与主进程逐项一致（非 IPv6、非多尾点的主机名）", () => {
    const hosts = [
      "example.com",
      "a.b.example.co.uk",
      "localhost",
      "LOCALHOST",
      "a.localhost",
      "intranet",
      "router",
      "a.internal",
      "a.lan",
      "a.corp",
      "a.local",
      "a.home",
      "a.intranet",
      "a.private",
      "127.0.0.1",
      "10.1.2.3",
      "192.0.0.1",
      "192.0.2.9",
      "192.1.2.3",
      "224.0.0.1",
      "8.8.8.8",
      "xn--r8jz45g.jp",
      "intranet.",
      "example.com.",
      "",
    ];
    for (const h of hosts) expect(isNonPublicHostname(h), `host=${JSON.stringify(h)}`).toBe(main.isNonPublicHostname(h));
  });

  it("safeFaviconSrc：放行时返回 WHATWG 规整后的 href（实际被加载的就是它）；data: 原样；拒绝返回 null", () => {
    expect(safeFaviconSrc("HTTPS://EXAMPLE.com/F.ico", APP_ORIGIN)).toBe("https://example.com/F.ico");
    expect(safeFaviconSrc(" https://example.com/f.ico ", APP_ORIGIN)).toBe("https://example.com/f.ico");
    expect(safeFaviconSrc("DATA:image/PNG;base64,AAAA", APP_ORIGIN)).toBe("DATA:image/PNG;base64,AAAA");
    expect(safeFaviconSrc("https://intranet/f.ico", APP_ORIGIN)).toBeNull();
    expect(safeFaviconSrc(dataUrlOfLength(FAVICON_MAX_LENGTH + 1), APP_ORIGIN)).toBeNull();
    expect(safeFaviconSrc(undefined, APP_ORIGIN)).toBeNull();
    expect(safeFaviconSrc(null, APP_ORIGIN)).toBeNull();
  });
});
