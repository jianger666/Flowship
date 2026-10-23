/**
 * next.config.mjs 的 CSP 下发契约（回退自检）。
 *
 * 为什么要这个测试：CSP 现在只是 **Report-Only 观察期**——我们没法在浏览器 / Electron 里验证
 * enforce 之后 Next 内联脚本、HMR、mermaid / katex / streamdown 是否照常工作。
 * 有人「顺手」把 header 名改成 `Content-Security-Policy` 就会在没验证的情况下直接 enforce、
 * 可能整页白屏，所以这里钉死：只能有 Report-Only 版本，且关键指令不能丢。
 *
 * 直接 import 配置并调 `headers()`——它是 build 时求值的纯函数，不需要起 Next。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

const loadRules = async (): Promise<HeaderRule[]> => {
  const mod = await import("../next.config.mjs");
  const cfg = mod.default;
  expect(typeof cfg.headers).toBe("function");
  return (await cfg.headers!()) as HeaderRule[];
};

const REPORT_ONLY = "content-security-policy-report-only";

const policyOf = async (): Promise<string> => {
  const rules = await loadRules();
  const hit = rules
    .flatMap((r) => r.headers)
    .find((h) => h.key.toLowerCase() === REPORT_ONLY);
  expect(hit, "必须下发 Content-Security-Policy-Report-Only").toBeDefined();
  return hit!.value;
};

/** "a 'self'; b x y" → { a: ["'self'"], b: ["x","y"] } */
const parsePolicy = (policy: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config.mjs headers()：CSP 只下发 Report-Only", () => {
  it("对所有路由（/:path*）下发 Content-Security-Policy-Report-Only", async () => {
    const rules = await loadRules();
    const rule = rules.find((r) =>
      r.headers.some((h) => h.key.toLowerCase() === REPORT_ONLY),
    );
    expect(rule?.source).toBe("/:path*");
  });

  it("绝不下发 enforcing 的 Content-Security-Policy（防止没验证就被误改成强制）", async () => {
    const rules = await loadRules();
    const keys = rules.flatMap((r) => r.headers.map((h) => h.key.toLowerCase()));
    expect(keys).toContain(REPORT_ONLY);
    expect(keys).not.toContain("content-security-policy");
  });

  it("dev / 生产两种环境都满足上面两条", async () => {
    for (const env of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      const keys = (await loadRules()).flatMap((r) => r.headers.map((h) => h.key.toLowerCase()));
      expect(keys).toContain(REPORT_ONLY);
      expect(keys).not.toContain("content-security-policy");
    }
  });
});

describe("防点击劫持：X-Frame-Options（Report-Only 的 frame-ancestors 只上报、不拦）", () => {
  it("对所有路由下发 X-Frame-Options: SAMEORIGIN", async () => {
    const rules = await loadRules();
    const rule = rules.find((r) =>
      r.headers.some((h) => h.key.toLowerCase() === "x-frame-options"),
    );
    expect(rule?.source).toBe("/:path*");
    const hit = rule!.headers.find((h) => h.key.toLowerCase() === "x-frame-options");
    expect(hit?.value).toBe("SAMEORIGIN");
  });

  it("dev / 生产都下发", async () => {
    for (const env of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      const keys = (await loadRules()).flatMap((r) => r.headers.map((h) => h.key.toLowerCase()));
      expect(keys).toContain("x-frame-options");
    }
  });
});

describe("策略内容：关键指令不能丢", () => {
  it("含 object-src 'none' / base-uri 'self' / frame-ancestors 'self' / report-uri /api/csp-report", async () => {
    const policy = await policyOf();
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("report-uri /api/csp-report");
  });

  it("report-uri 指向的路由文件真实存在（防改名漂移）", () => {
    const route = path.resolve(import.meta.dirname, "../src/app/api/csp-report/route.ts");
    expect(fs.existsSync(route)).toBe(true);
  });

  it("default-src 兜底同源；script-src 不放行任何远程 / data: / blob: 来源", async () => {
    const dirs = parsePolicy(await policyOf());
    expect(dirs["default-src"]).toEqual(["'self'"]);
    const script = dirs["script-src"] ?? [];
    expect(script).toContain("'self'");
    for (const bad of ["*", "http:", "https:", "data:", "blob:"]) {
      expect(script).not.toContain(bad);
    }
  });

  it("没有 upgrade-insecure-requests / block-all-mixed-content（页面是 http://127.0.0.1，会让子资源全挂）", async () => {
    const policy = await policyOf();
    expect(policy).not.toContain("upgrade-insecure-requests");
    expect(policy).not.toContain("block-all-mixed-content");
  });

  it("策略是单行 header 值，且不含 `:path`（带路由参数的 source 会对 header 值做 :param 替换）", async () => {
    const policy = await policyOf();
    expect(policy).not.toMatch(/[\r\n]/);
    // Next 对带参数的 source（/:path*）会在应答时对 header 值跑 compileNonPath，
    // 值里出现 `:path` 会被当成路由参数替换、悄悄改坏策略
    expect(policy).not.toContain(":path");
  });
});

describe("dev / 生产差异：只有 dev 才放行 eval 与 HMR WebSocket", () => {
  it("dev：script-src 带 'unsafe-eval'、connect-src 带 ws://127.0.0.1:* / ws://localhost:*", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const dirs = parsePolicy(await policyOf());
    expect(dirs["script-src"]).toContain("'unsafe-eval'");
    expect(dirs["connect-src"]).toContain("ws://127.0.0.1:*");
    expect(dirs["connect-src"]).toContain("ws://localhost:*");
  });

  it("生产：不带 'unsafe-eval' 与任何 ws:（让生产 Report-Only 能暴露真实的 eval / WebSocket 使用）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const dirs = parsePolicy(await policyOf());
    expect(dirs["script-src"]).not.toContain("'unsafe-eval'");
    expect(dirs["connect-src"]).toContain("'self'");
    expect((dirs["connect-src"] ?? []).some((v) => v.startsWith("ws"))).toBe(false);
  });

  it("两种环境都保留 'unsafe-inline'（Next 内联脚本 / 内联样式，enforce 前再收敛）", async () => {
    for (const env of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      const dirs = parsePolicy(await policyOf());
      expect(dirs["script-src"]).toContain("'unsafe-inline'");
      expect(dirs["style-src"]).toContain("'unsafe-inline'");
    }
  });
});
