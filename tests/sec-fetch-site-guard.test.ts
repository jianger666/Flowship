/**
 * `/api/*` 的 Sec-Fetch-Site 守门（第三轮 review V10-05）。
 *
 * 为什么 Host / Origin 校验之外还要它：
 * - 本机另一个端口上的页面（被投毒的文档站 / 恶意本地页）用 `<img src="http://127.0.0.1:8676/api/local-image?...">`、
 *   `<script>`、`<link>` 这类 **no-cors 子资源请求** 打进来时，浏览器不带 `Origin` 头（GET 的 no-cors 请求没有），
 *   Host 又是合法的 loopback——现有校验全部放行。而 `Sec-Fetch-Site` 是浏览器强制设置、页面脚本改不掉的
 *   禁止头：本机另一端口的页面发来的是 `same-site`（端口不计入 site），别的域名是 `cross-site`。
 * - 本应用自己的页面（Electron 窗口 / `pnpm dev:web` 的 8676）打自己的 API 恒为 `same-origin`；
 *   用户手敲地址 / 书签 / Electron `loadURL` 的顶层导航是 `none`。
 * - 没带 Sec-Fetch-* 的请求（curl、Node fetch、hooks、飞书桥、测试、老浏览器）不是浏览器里的跨站请求，一律照旧放行。
 * - 例外只给 OAuth 回调：`GET /api/mcp-oauth/callback` 的顶层导航（`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`）——
 *   外部授权页 302 回来，浏览器标的就是 `cross-site` + navigate + document。其它路径一律拦（第四轮 Q4-02，改前 56/56 放行）。
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { isAllowedLocalRequest, isBlockedCrossSiteFetch } from "@/lib/local-request";
import { middleware } from "@/middleware";

describe("isBlockedCrossSiteFetch：主要头组合", () => {
  const blocked = (site: string | null, mode: string | null = null, dest: string | null = null) =>
    isBlockedCrossSiteFetch({ site, mode, dest });

  it("没带 Sec-Fetch-Site（curl / Node fetch / hooks / 飞书桥 / 老浏览器）→ 不拦", () => {
    expect(blocked(null)).toBe(false);
    expect(blocked("")).toBe(false);
    expect(isBlockedCrossSiteFetch(undefined)).toBe(false);
    expect(isBlockedCrossSiteFetch({})).toBe(false);
  });

  it("same-origin（自家页面 fetch / 子资源）与 none（用户手输 / 书签 / loadURL）→ 不拦", () => {
    expect(blocked("same-origin", "cors", "empty")).toBe(false);
    expect(blocked("same-origin", "no-cors", "image")).toBe(false);
    expect(blocked("none", "navigate", "document")).toBe(false);
  });

  it("cross-site / same-site 的子资源与 fetch → 拦（本机别的端口、别的域名的页面）", () => {
    expect(blocked("cross-site", "no-cors", "image")).toBe(true);
    expect(blocked("same-site", "no-cors", "image")).toBe(true);
    expect(blocked("same-site", "no-cors", "script")).toBe(true);
    expect(blocked("cross-site", "cors", "empty")).toBe(true);
    // 嵌 iframe 的导航也拦（Dest 是 iframe 不是 document）
    expect(blocked("cross-site", "navigate", "iframe")).toBe(true);
    expect(blocked("same-site", "navigate", "iframe")).toBe(true);
    expect(blocked("cross-site", "navigate", "embed")).toBe(true);
  });

  it("顶层导航例外只给 OAuth 回调（Q4-02 收窄）：别的路径 / 没传路径 / 非 GET 的跨站顶层导航一律拦", () => {
    const nav = (path: string | null, method: string | null = "GET", site = "cross-site") =>
      isBlockedCrossSiteFetch({ site, mode: "navigate", dest: "document", path, method });
    // 回调：放行（含尾斜杠、HEAD、不传 method 视为 GET）
    expect(nav("/api/mcp-oauth/callback")).toBe(false);
    expect(nav("/api/mcp-oauth/callback/")).toBe(false);
    expect(nav("/api/mcp-oauth/callback", "HEAD")).toBe(false);
    expect(nav("/api/mcp-oauth/callback", null)).toBe(false);
    expect(nav("/api/mcp-oauth/callback", "GET", "same-site")).toBe(false);
    // 其它 GET 路由：拦（改前 56/56 放行）
    expect(nav("/api/repo-branches")).toBe(true);
    expect(nav("/api/system/open-path")).toBe(true);
    expect(nav("/api/mcp-oauth/callback-evil")).toBe(true);
    expect(nav("/api/mcp-oauth/callback/../repo-branches")).toBe(true);
    // 回调但是 POST：拦
    expect(nav("/api/mcp-oauth/callback", "POST")).toBe(true);
    // 没传路径（老调用方）：不享受例外
    expect(blocked("cross-site", "navigate", "document")).toBe(true);
    // 只有 mode 或只有 dest 对上不算
    expect(isBlockedCrossSiteFetch({ site: "cross-site", mode: "navigate", dest: null, path: "/api/mcp-oauth/callback" })).toBe(true);
    expect(isBlockedCrossSiteFetch({ site: "cross-site", mode: null, dest: "document", path: "/api/mcp-oauth/callback" })).toBe(true);
    // none（用户手输 / 书签 / loadURL）与路径无关，始终放行
    expect(nav("/api/repo-branches", "GET", "none")).toBe(false);
  });

  it("大小写 / 空白不影响判定；不认识的值不拦（真实浏览器只会发上面四个值之一）", () => {
    expect(blocked(" Cross-Site ", "NO-CORS", "Image")).toBe(true);
    expect(blocked("SAME-ORIGIN")).toBe(false);
    expect(blocked("something-new")).toBe(false);
  });
});

describe("isAllowedLocalRequest 带上 fetch 元数据（原有 Host / Origin 语义不变）", () => {
  it("Host / Origin 合法但 Sec-Fetch-Site=same-site 的 no-cors 子资源 → 拒", () => {
    expect(
      isAllowedLocalRequest("127.0.0.1:8676", null, { site: "same-site", mode: "no-cors", dest: "image" }),
    ).toBe(false);
  });

  it("自家页面 same-origin → 放行；不传元数据 → 与以前完全一致", () => {
    expect(
      isAllowedLocalRequest("127.0.0.1:8676", "http://127.0.0.1:8676", {
        site: "same-origin",
        mode: "cors",
        dest: "empty",
      }),
    ).toBe(true);
    expect(isAllowedLocalRequest("127.0.0.1:8676", null)).toBe(true);
  });

  it("Host 非 loopback 照旧拒（与 fetch 元数据无关）", () => {
    expect(isAllowedLocalRequest("evil.example.com", null, { site: "same-origin" })).toBe(false);
  });
});

describe("middleware：真实请求对象走一遍", () => {
  const call = (headers: Record<string, string>) =>
    middleware(new NextRequest("http://127.0.0.1:8676/api/local-image?path=%2Ftmp%2Fa.png", { headers }));

  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("本机别的端口页面的 <img> 子资源（无 Origin、Sec-Fetch-Site: same-site）→ 403", async () => {
    const res = call({ host: "127.0.0.1:8676", "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("跨站");
  });

  it("别的域名页面的 fetch（cross-site）→ 403", () => {
    expect(
      call({ host: "127.0.0.1:8676", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }).status,
    ).toBe(403);
  });

  it("自家页面 same-origin / 无 Sec-Fetch 头（curl、hooks、飞书桥、测试）/ 顶层导航 → 放行", () => {
    expect(passed(call({ host: "127.0.0.1:8676", origin: "http://127.0.0.1:8676", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(passed(call({ host: "127.0.0.1:8676" }))).toBe(true);
    expect(passed(call({ host: "127.0.0.1:8676", "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }))).toBe(true);
  });

  it("OAuth 回调（外部授权页 302 回来的 cross-site 顶层导航）放行；同样的导航打别的 API → 403（Q4-02）", () => {
    const nav = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const callbackReq = middleware(
      new NextRequest("http://127.0.0.1:8676/api/mcp-oauth/callback?code=c&state=s", {
        headers: { host: "127.0.0.1:8676", ...nav },
      }),
    );
    expect(passed(callbackReq)).toBe(true);
    // e2e 里「别的站点顶层导航到 /api/repo-branches」曾 56/56 放行
    for (const url of [
      "http://127.0.0.1:8676/api/repo-branches?repoPath=%2Ftmp%2Fx",
      "http://127.0.0.1:8676/api/system/open-path",
      "http://127.0.0.1:8676/api/tasks",
    ]) {
      const res = middleware(new NextRequest(url, { headers: { host: "127.0.0.1:8676", ...nav } }));
      expect(res.status, url).toBe(403);
    }
    // 回调路径但是 POST 也拦
    expect(
      middleware(
        new NextRequest("http://127.0.0.1:8676/api/mcp-oauth/callback", {
          method: "POST",
          headers: { host: "127.0.0.1:8676", ...nav },
        }),
      ).status,
    ).toBe(403);
  });
});
