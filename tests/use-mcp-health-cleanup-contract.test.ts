/**
 * useMcpHealth：关面板（active true→false）/ 卸载时，在途探测的结果被丢弃，
 * 它们 finally 里的「清 loading」也被代际守卫跳过——cleanup 必须自己清 loadingServers，
 * 否则残留旋转图标。代际本身的行为（快速重开不误伤新一代）见 generation-guard.test.ts。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/hooks/use-mcp-health.ts"),
  "utf8",
);

describe("useMcpHealth cleanup", () => {
  it("active 的 effect cleanup 里先作废当前代、再清空 loadingServers", () => {
    const start = src.indexOf("guard.next();");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("}, [active, refresh, guard]);", start));
    const cleanup = body.slice(body.indexOf("return () => {"));
    expect(cleanup).toContain("guard.invalidate();");
    expect(cleanup).toMatch(/setLoadingServers\(\(prev\) => \(prev\.size === 0 \? prev : new Set\(\)\)\);/);
    expect(cleanup.indexOf("guard.invalidate();")).toBeLessThan(
      cleanup.indexOf("setLoadingServers("),
    );
  });

  it("没有存活代（面板没开）时 probe 不探；结果落地与清 loading 都按代号丢弃过期的（收在 runGuardedTask 里）", () => {
    expect(src).toMatch(/await runGuardedTask\(guard,\s*\(\) => fetchMcpHealth\(servers\),/);
    // 行为（gen === 0 不启动 / 过期结果丢弃）见 generation-guard.test.ts 的 runGuardedTask 用例
    const lib = readFileSync(path.join(process.cwd(), "src/lib/cancel-slot.ts"), "utf8");
    expect(lib).toMatch(/if \(gen === 0\) return;/);
  });
});
