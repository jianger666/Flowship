/**
 * isAllowedLocalRequest（CR-01）——API 守门 middleware 的 Host / Origin 校验纯函数。
 *
 * 回归点：非 loopback Host（局域网直连）/ 跨 origin（DNS rebinding 页面）必须拒绝、
 * 本机页面 + OAuth callback（顶层导航无 Origin）放行。
 */
import { describe, expect, it } from "vitest";

import { isAllowedLocalRequest } from "@/lib/local-request";

describe("isAllowedLocalRequest", () => {
  it("本机页面：loopback Host + loopback Origin → 放行", () => {
    expect(isAllowedLocalRequest("127.0.0.1:8876", "http://127.0.0.1:8876")).toBe(true);
    expect(isAllowedLocalRequest("localhost:8876", "http://localhost:8876")).toBe(true);
    expect(isAllowedLocalRequest("[::1]:8876", "http://[::1]:8876")).toBe(true);
  });

  it("OAuth callback 场景：loopback Host、无 Origin（顶层导航）→ 放行", () => {
    expect(isAllowedLocalRequest("localhost:8876", null)).toBe(true);
    expect(isAllowedLocalRequest("127.0.0.1:8876", "")).toBe(true);
  });

  it("局域网直连：Host 是本机局域网 IP → 拒绝", () => {
    expect(isAllowedLocalRequest("192.168.1.10:8876", null)).toBe(false);
    expect(isAllowedLocalRequest("10.0.0.5:8876", "http://10.0.0.5:8876")).toBe(false);
  });

  it("DNS rebinding：Host 带攻击者域名 → 拒绝", () => {
    expect(isAllowedLocalRequest("evil.example.com:8876", null)).toBe(false);
    expect(isAllowedLocalRequest("evil.example.com", "http://evil.example.com")).toBe(false);
  });

  it("跨 origin：Host 合法但 Origin 是外部站点 → 拒绝（CSRF 面）", () => {
    expect(isAllowedLocalRequest("127.0.0.1:8876", "https://evil.example.com")).toBe(false);
    expect(isAllowedLocalRequest("localhost:8876", "null")).toBe(false);
    expect(isAllowedLocalRequest("localhost:8876", "not-a-url")).toBe(false);
  });

  it("本机跨端口 CSRF：Origin 是 loopback 但端口 / 主机名与 Host 不同 → 拒绝（11 轮收紧）", () => {
    expect(isAllowedLocalRequest("127.0.0.1:8876", "http://127.0.0.1:3000")).toBe(false);
    expect(isAllowedLocalRequest("localhost:8876", "http://localhost:9999")).toBe(false);
    expect(isAllowedLocalRequest("127.0.0.1:8876", "http://localhost:8876")).toBe(false);
    expect(isAllowedLocalRequest("[::1]:8876", "http://[::1]:3000")).toBe(false);
  });

  it("Host 缺失 → 拒绝", () => {
    expect(isAllowedLocalRequest(null, null)).toBe(false);
    expect(isAllowedLocalRequest("", null)).toBe(false);
  });
});
