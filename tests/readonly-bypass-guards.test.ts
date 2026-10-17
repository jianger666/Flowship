/**
 * 旁路只读守卫（review P0 的回归护栏）：read / grep / glob 的凭据文件拦截与目录钳制。
 *
 * 注：旁路已改 honor-system（提示词-only），本文件转为 isBypassBlockedReadPath / clampBypassBasePath 等纯函数 + def 的
 * 单元覆盖，当前旁路运行时不再接线。留着：哪天想收紧，接回去就行，不用重写。
 * 只读 shell 的白名单守卫（validateReadonlyShellCommand 那一整套）已在 v1.9.33 删除（没有调用方、期限已到），
 * 对应的坏人 / 好人用例随它一起删了；要恢复先看 pi-coding-tools.ts 里 READONLY_CUSTOM_TOOL_NAMES 上的说明。
 *
 * 钉两件事：
 * 1. 凭据文件读不到：read 读 company-env.json / config.json（数据目录）必须拒绝；
 *    grep / glob 基址钳在工作目录（含本任务目录）内。
 * 2. 好人场景不断：cwd 内 read/grep 照常放行。
 *
 * 策略：判定走纯函数（不 spawn、不碰网），拒绝判定额外走一遍 tool def execute，
 * 证明守卫真的挂在了旁路工具链上（不是只 export 了个没人调的函数）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-bypass-guards-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(CWD, { recursive: true });
await fs.mkdir(path.join(TMP_ROOT, "data", "tasks", "t1"), { recursive: true });
await fs.writeFile(
  path.join(TMP_ROOT, "data", "company-env.json"),
  JSON.stringify({ pg: [{ password: "secret" }] }),
);
await fs.writeFile(
  path.join(TMP_ROOT, "data", "config.json"),
  JSON.stringify({ provider: {} }),
);
await fs.writeFile(path.join(CWD, "hello.txt"), "hello bypass\n");
await fs.writeFile(path.join(CWD, "app.log"), "line1\nline2\n");

const { buildReadOnlyToolDefs, clampBypassBasePath, isBypassBlockedReadPath } = await import(
  "@/lib/server/pi-coding-tools"
);

const SENSITIVE_ABS = path.join(TMP_ROOT, "data", "company-env.json");
const CONFIG_ABS = path.join(TMP_ROOT, "data", "config.json");

describe("read / grep / glob：凭据文件拦、工作区放行", () => {
  it("isBypassBlockedReadPath：company-env.json 同名即拦，config.json 精确拦", () => {
    expect(isBypassBlockedReadPath(SENSITIVE_ABS)).toBe(true);
    expect(isBypassBlockedReadPath(CONFIG_ABS)).toBe(true);
    // 工作区同名项目文件不受影响（由钳制规则保护数据目录）
    expect(isBypassBlockedReadPath(path.join(CWD, "config.json"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "hello.txt"))).toBe(false);
  });

  it("isBypassBlockedReadPath：config.json 的备份（.bak / .corrupt-*）同样含明文凭据，一并拦", () => {
    const dataDir = path.dirname(CONFIG_ABS);
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.json.bak"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.json.corrupt-1789000000000"))).toBe(true);
    // 精确到数据目录根：不连坐名字相近的别的文件，也不连坐工作区里的同名文件
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.json.bak.txt"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.jsonx"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "config.json.bak"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "config.json.corrupt-1"))).toBe(false);
  });

  it("isBypassBlockedReadPath：收缩备份 .bak.shrink 与原子写临时文件 .tmp.* 也含凭据，一并拦", () => {
    const dataDir = path.dirname(CONFIG_ABS);
    for (const name of [
      "config.json.bak.shrink",
      "config.json.tmp.4242.abcdef",
      "config.json.bak.tmp.4242.abcdef",
      "config.json.bak.shrink.tmp.4242.abcdef",
    ]) {
      expect(isBypassBlockedReadPath(path.join(dataDir, name)), name).toBe(true);
    }
    // 不连坐：名字像但不是这一族的
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.json.shrink"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(dataDir, "config.json.tmpx"))).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "config.json.bak.shrink"))).toBe(false);
  });

  it("isBypassBlockedReadPath：数据目录环境变量带尾斜杠 / 含 `..` 段时，config.json 及备份仍被拦（回归）", () => {
    const dataDir = path.dirname(CONFIG_ABS);
    const prev = process.env.FLOWSHIP_DATA_DIR;
    try {
      for (const raw of [
        `${dataDir}${path.sep}`,
        path.join(dataDir, "sub", ".."),
        `${dataDir}${path.sep}${path.sep}`,
      ]) {
        process.env.FLOWSHIP_DATA_DIR = raw;
        for (const name of ["config.json", "config.json.bak", "config.json.bak.shrink"]) {
          expect(isBypassBlockedReadPath(path.join(dataDir, name)), `${raw} / ${name}`).toBe(true);
        }
        expect(isBypassBlockedReadPath(path.join(CWD, "config.json"))).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
      else process.env.FLOWSHIP_DATA_DIR = prev;
    }
  });

  it("clampBypassBasePath：数据目录根进不来，本任务目录和 cwd 放行", () => {
    expect(clampBypassBasePath(CWD, path.join(TMP_ROOT, "data"), "t1").ok).toBe(false);
    expect(clampBypassBasePath(CWD, ".", "t1").ok).toBe(true);
    expect(
      clampBypassBasePath(CWD, path.join(TMP_ROOT, "data", "tasks", "t1"), "t1").ok,
    ).toBe(true);
  });

  it("def 级 read：凭据文件拒绝、工作区文件放行、本任务目录放行、别处拒绝", async () => {
    const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
    const read = defs.find(
      (d) => (d as { name?: unknown }).name === "read",
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const blocked = await read.execute("call-1", { path: SENSITIVE_ABS });
    expect(blocked.content.map((c) => c.text).join("\n")).toContain("旁路只读");
    const allowed = await read.execute("call-1", {
      path: path.join(CWD, "hello.txt"),
    });
    expect(allowed.content.map((c) => c.text).join("\n")).toContain("hello bypass");
    // 本任务目录（事件日志 / 产出）可读
    await fs.writeFile(path.join(TMP_ROOT, "data", "tasks", "t1", "notes.txt"), "task notes\n");
    const ownTask = await read.execute("call-1", {
      path: path.join(TMP_ROOT, "data", "tasks", "t1", "notes.txt"),
    });
    expect(ownTask.content.map((c) => c.text).join("\n")).toContain("task notes");
    // 别的 task 的东西 + 系统文件一律拒（守卫先拦，不碰盘）
    const otherTask = await read.execute("call-1", {
      path: path.join(TMP_ROOT, "data", "tasks", "other", "secret.txt"),
    });
    expect(otherTask.content.map((c) => c.text).join("\n")).toContain("旁路只读");
    const etc = await read.execute("call-1", { path: "/etc/passwd" });
    expect(etc.content.map((c) => c.text).join("\n")).toContain("旁路只读");
  });

  it("def 级 grep：基址越界拒绝（不走到 rg，不碰网）", async () => {
    const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
    const grep = defs.find(
      (d) => (d as { name?: unknown }).name === "grep",
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    const blocked = await grep.execute("call-1", {
      pattern: "password",
      path: path.join(TMP_ROOT, "data"),
    });
    expect(blocked.content.map((c) => c.text).join("\n")).toContain("旁路只读");
  });
});
