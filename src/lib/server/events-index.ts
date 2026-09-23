/**
 * events 索引化回读（v3.1 §6：真相源不砍，回读索引化）。
 *
 * - 终态：events 按 action 切段（`events-by-action/<actionId>.jsonl`）+ 常驻倒排索引；
 * - 兼容：存量整块 `events.jsonl` 通过本模块扫描建索引（actionId → 行号段），
 *   回读只 seek 命中段，不整份进上下文；
 * - backfill：`backfillActionSegments` 把整块按 actionId 拆成切段文件（一次性迁移）。
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const EVENTS_BY_ACTION_DIR = "events-by-action";

export type ActionEventIndex = Map<string, number[]>;

const actionIdOf = (line: string): string | null => {
  try {
    const o = JSON.parse(line) as { actionId?: unknown; payload?: { actionId?: unknown } };
    const a =
      (typeof o.actionId === "string" && o.actionId) ||
      (typeof o.payload?.actionId === "string" && o.payload.actionId) ||
      null;
    return a;
  } catch {
    return null;
  }
};

/** 扫描整块 events.jsonl 建索引（actionId → 行号列表，KB 级常驻；流式读，内存 O(行)）。 */
export const buildActionEventIndex = async (eventsFile: string): Promise<ActionEventIndex> => {
  const idx: ActionEventIndex = new Map();
  let input: fsSync.ReadStream;
  try {
    input = fsSync.createReadStream(eventsFile, { encoding: "utf-8" });
  } catch {
    return idx;
  }
  // createReadStream 不抛 ENOENT（open 是异步的）：用 stat 先判缺失。
  try {
    await fs.stat(eventsFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return idx;
    throw err;
  }
  let n = 0;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
      const a = actionIdOf(line);
      if (a) {
        const arr = idx.get(a) ?? [];
        arr.push(n);
        idx.set(a, arr);
      }
    }
    n += 1;
  }
  return idx;
};

/**
 * B5：回读优先走切段 `events-by-action/<actionId>.jsonl`（backfill 产物）；
 * 无切段才流式扫整块（只收命中行，不整份进上下文）。
 */
export const readActionEvents = async (
  eventsFile: string,
  actionId: string,
  index?: ActionEventIndex,
): Promise<string[]> => {
  // 1. 切段优先。
  const taskDir = path.dirname(eventsFile);
  const safe = actionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const segment = path.join(taskDir, EVENTS_BY_ACTION_DIR, `${safe}.jsonl`);
  try {
    const raw = await fs.readFile(segment, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length > 0) return lines;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // 无切段 → 回落流式扫整块。
  }
  // 2. 有索引：按行号取（小文件路径，索引由调用方常驻持有）。
  if (index) {
    const rows = index.get(actionId);
    if (!rows || rows.length === 0) return [];
    const want = new Set(rows);
    const out: string[] = [];
    try {
      await fs.stat(eventsFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let n = 0;
    const rl = readline.createInterface({
      input: fsSync.createReadStream(eventsFile, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (want.has(n) && line.trim()) out.push(line);
      n += 1;
    }
    return out;
  }
  // 3. 无索引：单遍流式过滤（内存 O(行)，不整份 readFile）。
  const out: string[] = [];
  try {
    await fs.stat(eventsFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rl = readline.createInterface({
    input: fsSync.createReadStream(eventsFile, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (actionIdOf(line) === actionId) out.push(line);
  }
  return out;
};

/** 一次性 backfill：整块按 actionId 拆成 `events-by-action/<actionId>.jsonl`。 */
export const backfillActionSegments = async (
  taskDir: string,
  eventsFileName = "events.jsonl",
): Promise<{ actions: number; files: string[] }> => {
  const eventsFile = path.join(taskDir, eventsFileName);
  let raw: string;
  try {
    raw = await fs.readFile(eventsFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { actions: 0, files: [] };
    throw err;
  }
  const buckets = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const a = actionIdOf(line) ?? "_no_action";
    const arr = buckets.get(a) ?? [];
    arr.push(line);
    buckets.set(a, arr);
  }
  const outDir = path.join(taskDir, EVENTS_BY_ACTION_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const [actionId, lines] of buckets) {
    const safe = actionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(outDir, `${safe}.jsonl`);
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf-8");
    files.push(file);
  }
  return { actions: buckets.size, files };
};
