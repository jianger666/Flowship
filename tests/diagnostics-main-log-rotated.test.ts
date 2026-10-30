/**
 * 诊断包的 main.log 尾部与轮转（R14 B2-4b / Q15-03）：main.log 超过 20MB 会被 electron-app/shell-log.mjs 轮转成 main.log.1，
 * 刚轮转完新文件只有几行——读尾部时主文件不足 300KB 就要从 .1 的尾部补足到 300KB，否则诊断包恰好在「刚轮转完」缺最近的上下文。
 *   A. 没轮转过（没有 .1）→ 行为与以前完全一样
 *   B. 主文件不足 300KB + 有 .1 → .1 的尾部在前、主文件在后，补读量按**字节**算（总量恰好 300KB）
 *   C. 主文件已够 300KB → 不碰 .1
 *   D. 主文件不存在但 .1 在（轮转后还没重开就崩 / 重开失败）→ 读取失败说明 + .1 尾部
 *   E. .1 读不了（是个目录）→ 忽略，只给主文件
 *   F. 经 exportDiagnostics 落进诊断包
 * ⚠ 真实文件系统 + 临时目录；没有在真实 App 里导出过诊断包。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportDiagnostics, readMainLogTail } from "../src/lib/server/diagnostics";

const ENV_KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;
const TAIL = 300 * 1024;
const MARK_OLD = "----- 以下来自 main.log.1（轮转前的旧日志，补足最近的上下文） -----";
const MARK_NEW = "----- 以下来自 main.log（轮转后的新日志） -----";

let root: string;
let logsDir: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-diag-rot-"));
  logsDir = path.join(root, "logs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(path.join(root, "data"), { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FLOWSHIP_DATA_DIR = path.join(root, "data");
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

const mainLog = () => path.join(logsDir, "main.log");
const rotatedLog = () => path.join(logsDir, "main.log.1");
/** 每行 9 字节的 ASCII 旧日志（补读边界落在行首以外也不影响字节数断言） */
const oldLines = (n: number, last: string) => `${"OLD-LINE\n".repeat(n)}${last}\n`;

describe("A. 没轮转过", () => {
  it("没有 .1：返回主文件原文，不出现任何补读标记", async () => {
    writeFileSync(mainLog(), "[main] hello\n[main] world\n");
    const text = await readMainLogTail();
    expect(text).toBe("[main] hello\n[main] world\n");
    expect(text).not.toContain("main.log.1");
  });

  it(".1 存在但是空文件：当它不存在——不拼标记、返回主文件原样", async () => {
    writeFileSync(mainLog(), "[main] hello\n");
    writeFileSync(rotatedLog(), "");
    expect(await readMainLogTail()).toBe("[main] hello\n");
  });

  it("主文件和 .1 都没有：给出读取失败说明（dev 模式没有壳日志属正常）", async () => {
    const text = await readMainLogTail();
    expect(text).toContain("main.log 读取失败");
    expect(text).toContain("dev 模式没有壳日志属正常");
    expect(text).not.toContain("main.log.1");
  });
});

describe("B. 主文件不足 300KB + 有 .1：从 .1 的尾部补足", () => {
  it("顺序：旧标记 → .1 尾部 → 新标记 → 主文件；补读量 = 300KB − 主文件字节数（按字节，主文件含中文）", async () => {
    const main = "[壳] 轮转后的第一行\n[壳] 第二行\n";
    writeFileSync(mainLog(), main);
    writeFileSync(rotatedLog(), oldLines(60_000, "[old] LAST-BEFORE-ROTATE")); // ~540KB，远大于补读量
    const text = await readMainLogTail();

    expect(text.startsWith(`${MARK_OLD}\n`)).toBe(true);
    expect(text.endsWith(`\n${MARK_NEW}\n${main}`)).toBe(true);
    const olderPart = text.slice(`${MARK_OLD}\n`.length, text.length - `\n${MARK_NEW}\n${main}`.length);
    // .1 尾部的最后一行紧挨着新标记（轮转前最后发生的事、就是轮转后第一行的前一句）
    expect(olderPart.endsWith("[old] LAST-BEFORE-ROTATE")).toBe(true);
    // 补读 300KB − 主文件字节数；拼接时去掉了 .1 末尾的 1 个换行
    expect(Buffer.byteLength(olderPart)).toBe(TAIL - Buffer.byteLength(main) - 1);
    // 主文件的字符数 ≠ 字节数：若误按字符数算补读量，上面的精确字节断言会红
    expect(main.length).not.toBe(Buffer.byteLength(main));
  });

  it(".1 比补读量还短：整份 .1 都带上", async () => {
    writeFileSync(mainLog(), "[new] a\n");
    writeFileSync(rotatedLog(), "[old] 1\n[old] 2\n");
    const text = await readMainLogTail();
    expect(text).toBe([MARK_OLD, "[old] 1\n[old] 2", MARK_NEW, "[new] a\n"].join("\n"));
  });

  it("主文件是空的（刚轮转、还没写任何行）：.1 尾部 + 空的新日志", async () => {
    writeFileSync(mainLog(), "");
    writeFileSync(rotatedLog(), "[old] only\n");
    const text = await readMainLogTail();
    expect(text).toBe([MARK_OLD, "[old] only", MARK_NEW, ""].join("\n"));
  });

  it(".1 是中文日志：补读按字节、不会多读到三倍；切在字符中间也不抛", async () => {
    writeFileSync(mainLog(), "[new] a\n");
    writeFileSync(rotatedLog(), "壳日志一行\n".repeat(100_000)); // ~1.1MB 中文
    const text = await readMainLogTail();
    expect(text.startsWith(MARK_OLD)).toBe(true);
    const olderPart = text.slice(`${MARK_OLD}\n`.length, text.indexOf(`\n${MARK_NEW}\n`));
    const budget = TAIL - Buffer.byteLength("[new] a\n");
    // 切在多字节字符中间会被解码成替换字符（最多多 2 字节），所以给一点点余量；若按字符数当字节数，会读到约 3 倍
    expect(Buffer.byteLength(olderPart)).toBeLessThanOrEqual(budget + 2);
    expect(Buffer.byteLength(olderPart)).toBeGreaterThan(budget - 16);
  });
});

describe("C. 主文件已够 300KB：不碰 .1", () => {
  it("主文件 ≥ 300KB → 原样返回尾部 300KB，.1 的内容不出现", async () => {
    writeFileSync(mainLog(), `${"NEW-LINE\n".repeat(40_000)}[new] LAST\n`); // ~360KB
    writeFileSync(rotatedLog(), "SHOULD-NOT-APPEAR\n");
    const text = await readMainLogTail();
    expect(text).not.toContain("SHOULD-NOT-APPEAR");
    expect(text).not.toContain("main.log.1");
    expect(Buffer.byteLength(text)).toBe(TAIL);
    expect(text.endsWith("[new] LAST\n")).toBe(true);
  });

  it("主文件恰好 300KB：同样不碰 .1（边界）", async () => {
    writeFileSync(mainLog(), "x".repeat(TAIL));
    writeFileSync(rotatedLog(), "SHOULD-NOT-APPEAR\n");
    const text = await readMainLogTail();
    expect(text).not.toContain("SHOULD-NOT-APPEAR");
    expect(Buffer.byteLength(text)).toBe(TAIL);
  });
});

describe("D. 主文件不存在但 .1 在", () => {
  it("读取失败说明放在新标记下面，.1 尾部放在上面", async () => {
    writeFileSync(rotatedLog(), oldLines(10, "[old] LAST"));
    const text = await readMainLogTail();
    expect(text.startsWith(`${MARK_OLD}\n`)).toBe(true);
    expect(text).toContain("[old] LAST");
    const newAt = text.indexOf(MARK_NEW);
    expect(newAt).toBeGreaterThan(text.indexOf("[old] LAST"));
    expect(text.slice(newAt)).toContain("main.log 读取失败");
  });
});

describe("E. .1 读不了", () => {
  it(".1 是个目录：忽略，只给主文件（诊断导出不能因为旧日志坏了而失败）", async () => {
    writeFileSync(mainLog(), "[new] a\n");
    mkdirSync(rotatedLog());
    await expect(readMainLogTail()).resolves.toBe("[new] a\n");
  });
});

describe("F. 经 exportDiagnostics 落进诊断包", () => {
  it("main.log 尾部一节里 .1 在前、主文件在后", { timeout: 30_000 }, async () => {
    writeFileSync(mainLog(), "[new] after-rotate\n");
    writeFileSync(rotatedLog(), "[old] before-rotate\n");
    const target = await exportDiagnostics("1.9.38");
    const content = readFileSync(target, "utf8");
    const head = content.indexOf("===== main.log 尾部");
    expect(head).toBeGreaterThanOrEqual(0);
    const oldAt = content.indexOf("[old] before-rotate", head);
    const newAt = content.indexOf("[new] after-rotate", head);
    expect(oldAt).toBeGreaterThan(head);
    expect(newAt).toBeGreaterThan(oldAt);
    expect(target.startsWith(root)).toBe(true);
  });
});
