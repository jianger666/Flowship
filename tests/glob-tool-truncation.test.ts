/**
 * pi `glob` 工具：超过 500 条不再静默截断（R14 Q11-08）
 *
 * 改前：`files.slice(0, 500)`——glob 的遍历序不稳定，被截掉的是「碰巧最后遍历到的」那些，
 * 回包里又没有任何提示（「最多 500 条」只写在工具描述里）。模型据此很容易误判「没有某个文件」。
 * 改后：先排序（默认 UTF-16 码元序，与区域设置无关，两次调用结果一致）再取前 500，
 * 超出时末尾追加「共 N 条，仅列前 500 条」；`details.count` 记总数（`listed` 记实际列出的条数）；
 * `signal` 往下传（停止任务时不白扫大仓）。
 *
 * 上半是 `formatGlobResult` 纯函数；下半是真 glob 工具 + 临时目录里真建的文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCodingToolDefs,
  formatGlobResult,
  GLOB_MAX_RESULTS,
} from "../src/lib/server/pi-coding-tools";

describe("formatGlobResult（纯函数）", () => {
  const names = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);

  it("上限常量是 500（与工具描述一致）", () => {
    expect(GLOB_MAX_RESULTS).toBe(500);
  });

  it("没有匹配 → (无匹配文件)，total / listed 都是 0", () => {
    expect(formatGlobResult([])).toEqual({ text: "(无匹配文件)", total: 0, listed: 0 });
  });

  it("少于上限：排序后全列，没有提示", () => {
    const r = formatGlobResult(["b.ts", "a.ts", "c/d.ts"]);
    expect(r.text).toBe("a.ts\nb.ts\nc/d.ts");
    expect(r.total).toBe(3);
    expect(r.listed).toBe(3);
  });

  it("恰好 500 条：全列，没有提示（边界）", () => {
    const r = formatGlobResult(names(500));
    expect(r.text.split("\n")).toHaveLength(500);
    expect(r.text).not.toContain("共 ");
    expect(r.total).toBe(500);
    expect(r.listed).toBe(500);
  });

  it("501 条：列前 500 条 + 最后一行提示总数（边界）", () => {
    const r = formatGlobResult(names(501));
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(501);
    expect(lines[499]).toBe("f0499.ts");
    expect(lines[500]).toBe("…（共 501 条，仅列前 500 条；缩小 pattern 或指定 path）");
    expect(r.total).toBe(501);
    expect(r.listed).toBe(500);
  });

  it("被截的是排序之后靠后的那部分，与输入顺序无关（输入倒序也列最前面 500 个）", () => {
    const r = formatGlobResult(names(1200).reverse());
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("f0000.ts");
    expect(lines[499]).toBe("f0499.ts");
    expect(lines[500]).toContain("共 1200 条");
    expect(r.text).not.toContain("f0500.ts");
  });

  it("排序是码元序、与区域设置无关（大写在小写前）", () => {
    expect(formatGlobResult(["b", "B", "a"]).text).toBe("B\na\nb");
  });

  it("不改动传入的数组", () => {
    const input = ["b.ts", "a.ts"];
    formatGlobResult(input);
    expect(input).toEqual(["b.ts", "a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// 真 glob 工具
// ---------------------------------------------------------------------------

type GlobResult = {
  content: Array<{ type: string; text: string }>;
  details?: { count?: number; listed?: number };
};
type ToolLike = {
  name?: unknown;
  execute: (...a: unknown[]) => Promise<GlobResult>;
};

const root = mkdtempSync(path.join(os.tmpdir(), "fe-glob-trunc-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const globTool = buildCodingToolDefs(root, (async () => "") as never).find(
  (d) => (d as { name?: unknown }).name === "glob",
) as unknown as ToolLike;

const runGlob = async (params: Record<string, unknown>, signal?: AbortSignal) => {
  const r = await globTool.execute("call-1", params, signal);
  return { text: r.content.map((c) => c.text).join("\n"), details: r.details };
};

/** 在 sub 目录下建 n 个文件；创建顺序按步长 7 打乱（n 不是 7 的倍数时是一个排列）——创建序不该影响结果 */
const makeFiles = (sub: string, n: number): string => {
  if (n % 7 === 0) throw new Error("n 不能是 7 的倍数（步长 7 会重复）");
  const dir = path.join(root, sub);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const k = (i * 7) % n;
    writeFileSync(path.join(dir, `f${String(k).padStart(4, "0")}.ts`), "");
  }
  return dir;
};

describe("glob 工具回包（真文件系统）", { timeout: 60_000 }, () => {
  it("1200 个文件：前 500 个按字典序、最后一行写明共 1200 条；details.count 是总数（改前：500 条、无提示、count=500）", async () => {
    makeFiles("many", 1200);
    const r = await runGlob({ pattern: "*.ts", path: "many" });
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(501);
    expect(lines[0]).toBe("f0000.ts");
    expect(lines[499]).toBe("f0499.ts");
    expect(lines[500]).toBe("…（共 1200 条，仅列前 500 条；缩小 pattern 或指定 path）");
    expect(r.details).toEqual({ count: 1200, listed: 500 });
  });

  it("同一个目录连调两次，回包逐字相同（改前：被截的部分取决于遍历序）", async () => {
    const a = await runGlob({ pattern: "*.ts", path: "many" });
    const b = await runGlob({ pattern: "*.ts", path: "many" });
    expect(b.text).toBe(a.text);
  });

  it("缩小 pattern 后不再提示：提示里的建议是可执行的", async () => {
    const r = await runGlob({ pattern: "f0[0-4]*.ts", path: "many" });
    expect(r.text.split("\n")).toHaveLength(500);
    expect(r.text).not.toContain("共 ");
    expect(r.details).toEqual({ count: 500, listed: 500 });
  });

  it("没超上限（3 个文件）：全列、没有提示，count = listed = 3", async () => {
    makeFiles("few", 3);
    const r = await runGlob({ pattern: "*.ts", path: "few" });
    expect(r.text).toBe("f0000.ts\nf0001.ts\nf0002.ts");
    expect(r.details).toEqual({ count: 3, listed: 3 });
  });

  it("没有匹配 → (无匹配文件)，count = 0", async () => {
    const r = await runGlob({ pattern: "*.nope", path: "few" });
    expect(r.text).toBe("(无匹配文件)");
    expect(r.details).toEqual({ count: 0, listed: 0 });
  });

  it("pattern 为空 → 原来的提示（本批没动）", async () => {
    const r = await runGlob({ pattern: "  " });
    expect(r.text).toBe("pattern 不能为空");
  });

  it("signal 已 abort → 不继续扫，回包是 glob 失败（改前不传 signal：被停的任务还会把整个目录扫完）", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runGlob({ pattern: "**/*", path: "many" }, ac.signal);
    expect(r.text).toMatch(/^glob 失败：/);
    expect(r.details).toBeUndefined();
  });

  it("signal 没 abort → 与不传时结果一致（对照）", async () => {
    const ac = new AbortController();
    const withSignal = await runGlob({ pattern: "*.ts", path: "few" }, ac.signal);
    const without = await runGlob({ pattern: "*.ts", path: "few" });
    expect(withSignal.text).toBe(without.text);
  });
});
