/**
 * R14 Q11b-07：工具名归一化——server / tool 名里的 `:` 与 `%` 转义，避免碰撞。
 *
 * 改前 `mcp:${server}:${inner}` 不转义分隔符：server `a:b` + tool `c` 与 server `a` + tool `b:c`
 * 都是 `mcp:a:b:c`（server 名是用户在能力页自己起的、可以带 `:`），事件流配对 / 埋点聚合 / 按名过滤
 * 会把两个不同的工具当成同一个。改后只转 `:` → `%3A`、`%` → `%25`（单射），其余字符原样。
 */
import { describe, expect, it } from "vitest";

import { isFlowshipOwnToolName } from "@/lib/server/tool-result-persist";
import { escapeToolNamePart, normalizeToolName } from "@/lib/server/normalize-tool-name";

const mcp = (server?: string, toolName?: string) =>
  normalizeToolName({
    type: "mcp",
    args: { ...(server !== undefined ? { providerIdentifier: server } : {}), ...(toolName !== undefined ? { toolName } : {}) },
  });

/** 与 escapeToolNamePart 互逆的解码（只认 %25 / %3A 两种） */
const unescapePart = (s: string): string => s.replace(/%(25|3A)/g, (_m, c: string) => (c === "25" ? "%" : ":"));

describe("escapeToolNamePart", () => {
  it("只转义 `%` 与 `:`", () => {
    expect(escapeToolNamePart("a:b")).toBe("a%3Ab");
    expect(escapeToolNamePart("100%")).toBe("100%25");
    expect(escapeToolNamePart("a%3Ab")).toBe("a%253Ab"); // 字面量 %3A 不会被当成已转义的冒号
    expect(escapeToolNamePart("")).toBe("");
  });

  it("每个 `%`、每个 `:` 都转（不是只转第一个）：`%:` 与 `%%3A` 不会撞成同一个", () => {
    expect(escapeToolNamePart("a%b%c")).toBe("a%25b%25c");
    expect(escapeToolNamePart("a:b:c")).toBe("a%3Ab%3Ac");
    expect(escapeToolNamePart("%:")).toBe("%25%3A");
    expect(escapeToolNamePart("%%3A")).toBe("%25%253A");
    expect(escapeToolNamePart("%:")).not.toBe(escapeToolNamePart("%%3A"));
  });

  it("其余字符原样（CJK / 空格 / 连字符 / 点 / 下划线 / emoji 不会变成一串 %E5…）", () => {
    for (const s of ["飞书", "my server", "a-b_c.d", "tool😀", "GitHub", "a/b", "a?b#c"]) {
      expect(escapeToolNamePart(s)).toBe(s);
    }
  });
});

describe("normalizeToolName", () => {
  it("非 MCP 工具：type / name 原样，都没有 → unknown（对照，没改）", () => {
    expect(normalizeToolName({ type: "shell" })).toBe("shell");
    expect(normalizeToolName({ name: "read" })).toBe("read");
    expect(normalizeToolName({})).toBe("unknown");
  });

  it("没有 `:` / `%` 的 MCP 名：输出与改前完全一致（含 CJK / 空格 / 连字符）", () => {
    expect(mcp("github", "create_issue")).toBe("mcp:github:create_issue");
    expect(mcp("my-server.v2", "do.it")).toBe("mcp:my-server.v2:do.it");
    expect(mcp("飞书", "发消息")).toBe("mcp:飞书:发消息");
    expect(mcp("my server", "a b")).toBe("mcp:my server:a b");
  });

  it("残缺入参：缺 server / 缺 tool / 都缺（对照，占位符沿用）", () => {
    expect(mcp(undefined, "t")).toBe("mcp:?:t");
    expect(mcp("s", undefined)).toBe("mcp:s:?");
    expect(mcp()).toBe("mcp");
    expect(mcp("", "t")).toBe("mcp:?:t");
  });

  it("碰撞：server `a:b` + tool `c` 与 server `a` + tool `b:c` 现在是两个不同的名字（改前都是 mcp:a:b:c）", () => {
    const x = mcp("a:b", "c");
    const y = mcp("a", "b:c");
    expect(x).toBe("mcp:a%3Ab:c");
    expect(y).toBe("mcp:a:b%3Ac");
    expect(x).not.toBe(y);
  });

  it("缺 server / 缺 tool 的占位写法里，另一半的 `:` 同样转义", () => {
    expect(mcp(undefined, "b:c")).toBe("mcp:?:b%3Ac");
    expect(mcp("a:b", undefined)).toBe("mcp:a%3Ab:?");
  });

  it("单射 + 可还原：小字母表（a : % 3 A）上长度 ≤ 3 的所有 (server, tool) 组合，归一化名互不相同，且 `mcp:S:T` 按冒号拆开能还原", () => {
    const alphabet = ["a", ":", "%", "3", "A"];
    const strings: string[] = [];
    const build = (prefix: string, left: number) => {
      if (prefix) strings.push(prefix);
      if (left === 0) return;
      for (const c of alphabet) build(prefix + c, left - 1);
    };
    build("", 3);
    expect(strings.length).toBe(155);

    // 2.4 万对组合：循环里不调 expect（每对 5 次 expect 在 16 个 yes 抢 CPU 时要 6–11 秒，
    // 超过默认 5 秒超时），改成把违例收进数组、循环后各断言一次——判别力不变，开销小一个数量级。
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    const roundTripFailures: string[] = [];
    for (const server of strings) {
      for (const tool of strings) {
        const name = mcp(server, tool);
        const key = JSON.stringify([server, tool]);
        const prev = seen.get(name);
        if (prev !== undefined) collisions.push(`${name} 同时是 ${prev} 与 ${key}`);
        seen.set(name, key);
        // 归一化名里只剩两个分隔冒号：能拆成 mcp / server / tool 三段，各段解码后等于原值
        const parts = name.split(":");
        if (
          parts.length !== 3 ||
          parts[0] !== "mcp" ||
          unescapePart(parts[1]!) !== server ||
          unescapePart(parts[2]!) !== tool
        ) {
          roundTripFailures.push(`${key} → ${name}`);
        }
      }
    }
    expect(collisions.slice(0, 5)).toEqual([]);
    expect(roundTripFailures.slice(0, 5)).toEqual([]);
    expect(seen.size).toBe(155 * 155);
  }, 30_000);

  it("自有工具识别不受影响：`mcp:custom-user-tools:schedule` 仍是自有工具，带冒号的第三方 server 不会被误认", () => {
    expect(isFlowshipOwnToolName(mcp("custom-user-tools", "schedule"))).toBe(true);
    expect(isFlowshipOwnToolName(mcp("flowshipChat", "ask_user"))).toBe(true);
    // 第三方 server 名恰好长得像「保留名 + 自有工具名」：转义后不再等于保留写法
    expect(isFlowshipOwnToolName(mcp("custom-user-tools:schedule", "x"))).toBe(false);
    expect(isFlowshipOwnToolName(mcp("custom-user-tools", "schedule:x"))).toBe(false);
    expect(isFlowshipOwnToolName(mcp("third-party", "schedule"))).toBe(false);
  });
});
