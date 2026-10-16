/**
 * config.json 同族文件（`.bak` / `.bak.shrink` / `.corrupt-<ts>` / `.tmp.*`）含明文的旧 API key / PAT
 * （`.bak.shrink` 里还有**已被清掉 / 轮换掉**的旧 key）——诊断导出不能把它们带进诊断包、
 * 存储页不能把它们列出来 / 算进占用。
 *
 * 行为测试：真实 exportDiagnostics / 真实 GET /api/system/storage，数据目录落临时目录，凭据全是假值。
 * 目前两处都不枚举数据目录（诊断只读固定的 config.json、存储页只枚举 tasks/ 与 worktrees/ 下的目录），
 * 本文件把「不会被带出 / 列出」钉成行为：日后谁加了「枚举数据目录」就会在这里红。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 不探测本机 IDE（慢且与本测试无关）
vi.mock("@/lib/server/ide-tools", () => ({
  listIdeToolsDetailed: vi.fn(async () => []),
}));

const ENV_KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;

// 每份文件一个独一无二的假凭据：出现在任何输出里就能精确知道是哪份泄漏的
const CONFIG_KEY = "sk-CONFIG-FAKE-SENTINEL-000001";
const FAMILY: Record<string, { secret: string; raw: (s: string) => string }> = {
  "config.json.bak": {
    secret: "sk-BAK-FAKE-SENTINEL-000002",
    raw: (s) => JSON.stringify({ apiKey: s, gitToken: "glpat-BAK-FAKE-000002", repos: [] }),
  },
  "config.json.bak.shrink": {
    secret: "sk-SHRINK-FAKE-SENTINEL-000003",
    raw: (s) => JSON.stringify({ apiKey: s, gitToken: "glpat-SHRINK-FAKE-000003", repos: [{ path: "/repo/old" }] }),
  },
  "config.json.corrupt-1760000000000": {
    secret: "sk-CORRUPT-FAKE-SENTINEL-000004",
    // 手改漏引号的损坏原文：不是合法 JSON，但里面有明文
    raw: (s) => `{"apiKey": ${s}, "gitToken": "glpat-CORRUPT-FAKE-000004"`,
  },
  "config.json.tmp.12345.abcdef": {
    secret: "sk-TMP-FAKE-SENTINEL-000005",
    raw: (s) => JSON.stringify({ apiKey: s, repos: [] }),
  },
};

let root: string;
let dataDir: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const writeFamilyFiles = (): void => {
  for (const [name, { secret, raw }] of Object.entries(FAMILY)) {
    // 填充到 ~64KB：若被算进存储占用 / 带进诊断包，一眼可见
    writeFileSync(path.join(dataDir, name), raw(secret) + " ".repeat(64 * 1024), "utf-8");
  }
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-bak-excl-"));
  dataDir = path.join(root, "data");
  mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  // 家目录指到临时目录：exportDiagnostics 首选写 ~/Downloads，绝不能写进真实下载目录
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ apiKey: CONFIG_KEY, gitToken: "glpat-CONFIG-FAKE-000001", repos: [] }),
    "utf-8",
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe("诊断导出不带 config.json 同族文件", () => {
  it("诊断包里没有 .bak / .bak.shrink / .corrupt-* / .tmp.* 的任何凭据，也没有 config.json 的 apiKey 明文（只有脱敏概要）", async () => {
    writeFamilyFiles();
    const { exportDiagnostics } = await import("@/lib/server/diagnostics");
    const target = await exportDiagnostics("0.0.0-test");
    // 回退写进数据目录（HOME 下没有 Downloads）、没落进真实家目录
    expect(target.startsWith(root)).toBe(true);
    const content = readFileSync(target, "utf8");

    // 不是空转：确实读了 config.json 并脱敏成概要（前 6 位 + 长度）
    expect(content).toContain(`apiKey: ${CONFIG_KEY.slice(0, 6)}…（长度 ${CONFIG_KEY.length}）`);
    expect(content).not.toContain(CONFIG_KEY);
    for (const [name, { secret }] of Object.entries(FAMILY)) {
      expect(content, `诊断包不应含 ${name} 的凭据`).not.toContain(secret);
    }
    for (const leak of ["glpat-BAK", "glpat-SHRINK", "glpat-CORRUPT", "/repo/old"]) {
      expect(content).not.toContain(leak);
    }
  });
});

describe("存储页不列出 / 不统计 config.json 同族文件", () => {
  it("GET /api/system/storage：有无同族文件，条目、总占用、响应文本都一样；响应里没有 config.json* 的名字和凭据", async () => {
    mkdirSync(path.join(dataDir, "tasks", "t-live"), { recursive: true });
    writeFileSync(
      path.join(dataDir, "tasks", "t-live", "meta.json"),
      JSON.stringify({ title: "live task", mode: "task", repoStatus: "developing", updatedAt: 1 }),
      "utf-8",
    );
    // DATA_DIR 在 task-fs-core 加载时按 FLOWSHIP_DATA_DIR 求值：env 设好之后再动态加载
    const { GET } = await import("@/app/api/system/storage/route");

    const before = await GET();
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      totalBytes: number;
      entries: Array<{ id: string }>;
      staleWorktrees: unknown[];
    };
    expect(beforeBody.entries.map((e) => e.id)).toEqual(["t-live"]);

    writeFamilyFiles();
    const after = await GET();
    expect(after.status).toBe(200);
    const afterText = await after.text();
    const afterBody = JSON.parse(afterText) as typeof beforeBody;

    expect(afterBody.entries.map((e) => e.id)).toEqual(["t-live"]);
    expect(afterBody.staleWorktrees).toEqual([]);
    // 4 个 64KB 的同族文件没有被算进占用
    expect(afterBody.totalBytes).toBe(beforeBody.totalBytes);
    expect(afterText).not.toContain("config.json");
    for (const { secret } of Object.values(FAMILY)) {
      expect(afterText).not.toContain(secret);
    }
  });
});
