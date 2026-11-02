/**
 * 事件脱敏值集合纳入 Cursor 全局 `~/.cursor/mcp.json` 的 MCP 凭据（第七轮 review #9）
 *
 * 缺口：运行时早已不读 `~/.cursor/mcp.json`（V0.13「MCP 独立化」），但 agent 在用户机器上照样能 `cat ~/.cursor/mcp.json`，
 * 里面的 `Authorization: Bearer …` / `env.*_TOKEN` 明文就进 events.jsonl 与 SSE / 飞书回流。
 * 口径：只读、复用 settings.mcpServers 的抽取函数（键名像凭据才收、长度 < 8 / `$VAR` 引用不收）。
 * 候选目录与 cursor-config 同源（`getGlobalCursorDirs`，见 cursor-dirs.ts）。
 *
 * 全程假凭据（运行时拼接）+ 临时 HOME / 数据目录，绝不碰真实配置。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 给 node:fs 的 readFileSync 套一层只记账的 spy（行为原样委托）：坏 / 超大的 mcp.json 不能被每个事件帧反复读
const readSpy = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    readSpy.calls.push(String(args[0]));
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import { getGlobalCursorDirs as getDirsFromConfig } from "@/lib/server/cursor-config";
import { getGlobalCursorDirs } from "@/lib/server/cursor-dirs";
import {
  REDACTED_MCP_SECRET,
  getEventRedactionSecrets,
  redactSecretsInText,
} from "@/lib/server/event-secret-redact";

const fake = (tag: string): string => ["fake", tag, "value", "0123456789"].join("-");

const CURSOR_BEARER = fake("cursor-bearer");
const CURSOR_ENV_TOKEN = fake("cursor-env-token");
const CURSOR_ROTATED = fake("cursor-bearer-rotated");

let root: string;
let home: string;
let dataDir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-redact-cursor-mcp-"));
  home = path.join(root, "home");
  dataDir = path.join(root, "data");
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const mcpJsonPath = (): string => path.join(home, ".cursor", "mcp.json");
const writeCursorMcp = (cfg: unknown): void => {
  writeFileSync(mcpJsonPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
};

describe("~/.cursor/mcp.json 的 MCP 凭据", () => {
  it("headers / env 里凭据类键名的值被抹（Bearer 整串与令牌本身都抹）", () => {
    writeCursorMcp({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/sse",
          headers: { Authorization: `Bearer ${CURSOR_BEARER}` },
        },
        local: { command: "node", args: ["server.js"], env: { SERVICE_TOKEN: CURSOR_ENV_TOKEN } },
      },
    });
    const text = [
      `Authorization: Bearer ${CURSOR_BEARER}`,
      `bare ${CURSOR_BEARER}`,
      `SERVICE_TOKEN=${CURSOR_ENV_TOKEN}`,
    ].join("\n");
    const out = redactSecretsInText(text);
    expect(out).not.toContain(CURSOR_BEARER);
    expect(out).not.toContain(CURSOR_ENV_TOKEN);
    expect(out).toContain(REDACTED_MCP_SECRET);
    // 没来自 config.json：集合里就是这两个来源（原值）
    const values = getEventRedactionSecrets().map((s) => s.value);
    expect(values).toContain(CURSOR_ENV_TOKEN);
  });

  it("不误伤：普通 env / 头、短值、环境变量引用不进集合", () => {
    writeCursorMcp({
      mcpServers: {
        s: {
          command: "node",
          env: { NODE_ENV: "production", API_TOKEN: "short", REF_TOKEN: "${MY_REAL_TOKEN}" },
          headers: { "Content-Type": "application/json" },
        },
      },
    });
    const text = "NODE_ENV=production application/json short ${MY_REAL_TOKEN}";
    expect(redactSecretsInText(text)).toBe(text);
    expect(getEventRedactionSecrets()).toEqual([]);
  });

  it("没有 mcp.json / 没有 mcpServers 键 / 根不是对象 / JSON 损坏：不抛、不收", () => {
    expect(getEventRedactionSecrets()).toEqual([]); // 文件不存在
    writeCursorMcp({ somethingElse: true });
    expect(getEventRedactionSecrets()).toEqual([]);
    writeFileSync(mcpJsonPath(), "[1,2,3]", "utf-8");
    expect(getEventRedactionSecrets()).toEqual([]);
    writeFileSync(mcpJsonPath(), "{ not json", "utf-8");
    expect(() => getEventRedactionSecrets()).not.toThrow();
  });

  it("文件被改写后新凭据立刻被抹；文件被删后不再抹（缓存按 stat 失效）", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER);

    writeCursorMcp({
      mcpServers: {
        r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_ROTATED}` } },
        extra: { env: { PAD: "x".repeat(40) } }, // 让文件大小变化，不依赖 mtime 精度
      },
    });
    expect(redactSecretsInText(CURSOR_ROTATED)).not.toContain(CURSOR_ROTATED);

    unlinkSync(mcpJsonPath());
    expect(redactSecretsInText(CURSOR_ROTATED)).toBe(CURSOR_ROTATED);
  });

  it("HOME 换了（用户 / 多实例 / 测试）：只认当前 HOME 下的 mcp.json，旧 HOME 的凭据不残留", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER);

    const home2 = path.join(root, "home2");
    mkdirSync(path.join(home2, ".cursor"), { recursive: true });
    process.env.HOME = home2;
    process.env.USERPROFILE = home2;
    expect(redactSecretsInText(CURSOR_BEARER)).toBe(CURSOR_BEARER);
  });

  it("热路径：mcp.json 没变时重复调用返回同一个数组引用（缓存生效）", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    const a = getEventRedactionSecrets();
    const b = getEventRedactionSecrets();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toBe(a);
  });

  it("与 config.json 里的同值只留一条（不重复）", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } }),
      "utf-8",
    );
    const values = getEventRedactionSecrets().map((s) => s.value);
    expect(values.filter((v) => v === CURSOR_BEARER).length).toBe(1);
  });
});

describe("坏 / 超大的 mcp.json（Cursor 自己的文件、非原子写）", () => {
  const mcpReads = (): number => readSpy.calls.filter((f) => f === mcpJsonPath()).length;

  it("解析失败：沿用上一次读成功的凭据，且文件不变时不再反复读 / 解析（只记一次指纹）", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER);

    writeFileSync(mcpJsonPath(), '{ "mcpServers": { half-written', "utf-8"); // 半写 / 手改坏
    readSpy.calls.length = 0;
    // 坏文件期间：旧凭据仍被抹（不能因为文件坏了就整体不脱敏）
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER);
    const readsAfterFirst = mcpReads();
    expect(readsAfterFirst).toBe(1);
    // 之后每个事件帧都不再读它
    for (let i = 0; i < 20; i++) redactSecretsInText(CURSOR_BEARER);
    expect(mcpReads()).toBe(readsAfterFirst);

    // 文件被写完整（stat 变了）→ 重读，新凭据生效
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_ROTATED}` } } } });
    expect(redactSecretsInText(CURSOR_ROTATED)).not.toContain(CURSOR_ROTATED);
    expect(mcpReads()).toBeGreaterThan(readsAfterFirst);
  });

  it("超过体积上限（4 MB）：不读、不解析，沿用上一次的值；一直不读", () => {
    writeCursorMcp({ mcpServers: { r: { url: "https://a.example.com", headers: { Authorization: `Bearer ${CURSOR_BEARER}` } } } });
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER);

    writeFileSync(mcpJsonPath(), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)); // 4MB+1 的空白
    readSpy.calls.length = 0;
    expect(redactSecretsInText(CURSOR_BEARER)).not.toContain(CURSOR_BEARER); // 旧凭据仍抹
    for (let i = 0; i < 10; i++) redactSecretsInText(CURSOR_BEARER);
    expect(mcpReads()).toBe(0);
  });

  it("一次都没读成功过 + 文件是坏的：与没配相同（空集合、不抛）", () => {
    writeFileSync(mcpJsonPath(), "{ not json", "utf-8");
    expect(getEventRedactionSecrets()).toEqual([]);
  });
});

describe("候选目录与 cursor-config 同源", () => {
  it("cursor-config 导出的 getGlobalCursorDirs 就是 cursor-dirs 那一份（不会各算各的）", () => {
    expect(getDirsFromConfig).toBe(getGlobalCursorDirs);
    expect(getGlobalCursorDirs()[0]).toBe(path.join(home, ".cursor"));
  });

  it("源码接线：事件脱敏从 cursor-dirs 取候选目录、读 mcp.json 走 collectMcpServerSecrets（口径同 settings.mcpServers）", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/server/event-secret-redact.ts"),
      "utf-8",
    );
    expect(src).toMatch(/from "\.\/cursor-dirs"/);
    expect(src).toMatch(/getGlobalCursorDirs\(\)\[index\]/);
    expect(src).toMatch(/path\.join\(dir, "mcp\.json"\)/);
    expect(src).toMatch(/collectMcpServerSecrets\(\(parsed as Record<string, unknown>\)\.mcpServers, out\)/);
    // 两个候选槽都进合并
    expect(src).toMatch(/\.\.\.cursorMcp0,\s*\.\.\.cursorMcp1,/);
  });
});
