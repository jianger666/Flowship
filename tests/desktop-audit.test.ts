/**
 * 电脑操作审计日志（electron-app/desktop/audit.mjs）——用真实临时目录。
 *
 * 钉死的是隐私与稳健：
 * - 键白名单：`text` / `password` 这类字段就算被上游塞进条目也进不了文件；字符串截断；嵌套对象丢弃
 * - 每条是独立的一行合法 JSON，按天分文件；并发写不交错
 * - 超过保留天数的文件被清理，其它文件不动
 * - 写失败（目录不可写等）静默，不抛、不影响调用方
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuditLog, MAX_DAY_FILE_BYTES, sanitizeEntry } from "../electron-app/desktop/audit.mjs";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-desktop-audit-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readLines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("sanitizeEntry：键白名单", () => {
  it("text / password / 任意未知键都被丢弃", () => {
    const out = sanitizeEntry({ op: "desktop_type", chars: 12, text: "我的银行密码", password: "hunter2", secret: 1, token: "x", nested: { a: 1 } });
    expect(out).toEqual({ op: "desktop_type", chars: 12 });
    expect(JSON.stringify(out)).not.toContain("银行");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("白名单里的键：只留字符串 / 有限数字 / 布尔；对象、数组、NaN、函数丢弃；长字符串截断", () => {
    const out = sanitizeEntry({
      error: "x".repeat(500),
      x: 10,
      y: Number.NaN,
      ok: true,
      app: { name: "微信" },
      key: ["cmd", "c"],
      ms: () => 1,
    });
    expect(Object.keys(out).sort()).toEqual(["error", "ok", "x"]);
    expect((out.error as string).length).toBe(201);
  });

  it("非对象输入给空对象", () => {
    expect(sanitizeEntry(null)).toEqual({});
    expect(sanitizeEntry("x")).toEqual({});
  });
});

describe("写入", () => {
  it("一条一行合法 JSON，带时间戳，按天分文件，目录自动创建", async () => {
    const sub = path.join(dir, "nested", "audit");
    const t1 = new Date(2026, 10, 19, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 20, 9, 0, 0).getTime();
    let now = t1;
    const log = createAuditLog({ dir: sub, now: () => now });
    await log.write({ op: "desktop_click", taskId: "t1", x: 1, y: 2 });
    await log.write({ op: "desktop_key", key: "cmd+c" });
    now = t2;
    await log.write({ op: "desktop_scroll", dx: 0, dy: 3 });
    await log.flush();

    expect(fs.readdirSync(sub).sort()).toEqual(["2026-11-19.jsonl", "2026-11-20.jsonl"]);
    const day1 = readLines(path.join(sub, "2026-11-19.jsonl"));
    expect(day1).toEqual([
      { at: t1, op: "desktop_click", taskId: "t1", x: 1, y: 2 },
      { at: t1, op: "desktop_key", key: "cmd+c" },
    ]);
    expect(readLines(path.join(sub, "2026-11-20.jsonl"))).toEqual([{ at: t2, op: "desktop_scroll", dx: 0, dy: 3 }]);
  });

  it("并发写：行不交错、不丢", async () => {
    const log = createAuditLog({ dir });
    await Promise.all(Array.from({ length: 50 }, (_, i) => log.write({ op: "desktop_move", x: i, y: i })));
    const file = fs.readdirSync(dir)[0]!;
    const lines = readLines(path.join(dir, file));
    expect(lines).toHaveLength(50);
    expect(new Set(lines.map((l) => l.x)).size).toBe(50);
  });

  it("文件权限只给本人（0600）", async () => {
    const log = createAuditLog({ dir });
    await log.write({ op: "desktop_move" });
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("单天文件超过上限后不再追加（防异常循环写满磁盘）", async () => {
    const log = createAuditLog({ dir });
    await log.write({ op: "desktop_move" });
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.appendFileSync(file, "x".repeat(MAX_DAY_FILE_BYTES));
    const fresh = createAuditLog({ dir }); // 新实例：靠 stat 得知已超限
    await fresh.write({ op: "desktop_click", x: 9 });
    expect(fs.readFileSync(file, "utf8")).not.toContain('"x":9');
  });

  it("上限按字节算（一个汉字 3 字节）：已有大小 + 这一行的字节数超过上限就不写，哪怕按字符数还放得下（第三轮评审：以前拿字符数去比字节累计值）", async () => {
    const T = new Date(2026, 10, 19, 12, 0, 0).getTime();
    const entry = { op: "desktop_open_app", reason: "汉".repeat(150) };
    const line = `${JSON.stringify({ at: T, ...sanitizeEntry(entry) })}\n`;
    const bytes = Buffer.byteLength(line);
    expect(bytes).toBeGreaterThan(line.length + 200); // 前提：这一行里中文很多，字节数远大于字符数
    const make = (existingSize: number) => {
      const appendFile = vi.fn(async () => {});
      const fsImpl = {
        mkdir: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ size: existingSize })),
        appendFile,
        readdir: vi.fn(async () => []),
        unlink: vi.fn(async () => {}),
      };
      return { appendFile, log: createAuditLog({ dir: "/fake-audit", now: () => T, fsImpl: fsImpl as never }) };
    };
    // 已有 = 上限 − 字符数：按字符数算刚好放得下，按字节算差 ~600 字节 → 不写
    const tooFull = make(MAX_DAY_FILE_BYTES - line.length);
    await tooFull.log.write(entry);
    expect(tooFull.appendFile).not.toHaveBeenCalled();
    // 已有 = 上限 − 字节数：恰好放得下 → 写（边界不误伤）；写完累计值按字节增长，同一天再写一条就放不下了
    const exact = make(MAX_DAY_FILE_BYTES - bytes);
    await exact.log.write(entry);
    expect(exact.appendFile).toHaveBeenCalledTimes(1);
    await exact.log.write(entry);
    expect(exact.appendFile).toHaveBeenCalledTimes(1);
  });

  it("目录不可写：write 不抛、日志里留一句", async () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "我是个文件，不是目录");
    const logs: string[] = [];
    const log = createAuditLog({ dir: path.join(blocker, "sub"), log: (m: string) => logs.push(m) });
    await expect(log.write({ op: "desktop_move" })).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("清理", () => {
  it("只删超过保留天数的日志文件，其它文件不动", async () => {
    const now = new Date(2026, 10, 19, 12, 0, 0).getTime();
    const log = createAuditLog({ dir, now: () => now, retentionDays: 14 });
    const files = ["2026-11-04.jsonl", "2026-11-05.jsonl", "2026-10-01.jsonl", "2026-11-19.jsonl", "notes.txt", "2026-11-04.jsonl.bak"];
    for (const f of files) fs.writeFileSync(path.join(dir, f), "{}\n");
    await log.prune();
    // 11-19 往前 14 天 = 11-05：11-05 当天的保留（边界），11-04 和 10-01 删除；不是 .jsonl 结尾的不碰
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-11-04.jsonl.bak", "2026-11-05.jsonl", "2026-11-19.jsonl", "notes.txt"].sort());
  });

  it("目录不存在：prune 不抛", async () => {
    const log = createAuditLog({ dir: path.join(dir, "nope") });
    await expect(log.prune()).resolves.toBeUndefined();
  });
});
