/**
 * shell 工具回包的「状态行」+ 超预算保留头尾（R14 Q11-04）
 *
 * 改前：`（exit code N）` 挂在回包**末尾**，而进模型前的预算截断对所有工具都只留头部——
 * 构建 / 测试命令输出超过 32KB 时，尾部的报错和退出码一起被砍，失败被模型当成成功；
 * 被信号杀死的命令（exitCode 为 null，比如 OOM 的 SIGKILL）连这行都没有，回包只剩 partial 输出。
 * 改后：状态行写在回包开头（退出码非 0 / 被信号终止 / 输出收集被截），超预算时 shell 保留「开头 8KB + 结尾」。
 *
 * 上半是 `formatShellStatusNote` 纯函数；下半是真 shell 工具（`buildCodingToolDefs` 里包好预算的那个）
 * + 真子进程，POSIX 才跑（Windows 靠 Git Bash，用例里的命令是 bash 语法）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCodingToolDefs,
  formatShellStatusNote,
} from "../src/lib/server/pi-coding-tools";

describe("formatShellStatusNote（纯函数）", () => {
  it("退出码 0 且没丢输出 → 空串（成功的命令不加噪声）", () => {
    expect(formatShellStatusNote({ exitCode: 0 })).toBe("");
    expect(formatShellStatusNote({ exitCode: 0, collectDropped: false })).toBe("");
  });

  it("退出码非 0 → （exit code N）", () => {
    expect(formatShellStatusNote({ exitCode: 2 })).toBe("（exit code 2）");
    expect(formatShellStatusNote({ exitCode: 137 })).toBe("（exit code 137）");
    // 负退出码（有的平台 / 包装层会给负数）同样要写出来，不能因为 `> 0` 判断被吞掉
    expect(formatShellStatusNote({ exitCode: -1 })).toBe("（exit code -1）");
  });

  it("exitCode 为 null（被信号终止）→ 明说没拿到退出码，不是静默当成功", () => {
    expect(formatShellStatusNote({ exitCode: null })).toBe(
      "（进程被信号终止，未取得退出码）",
    );
  });

  it("exitCode 为 undefined（执行后端没给）→ 不编造状态（沿用改前「没有就不写」）", () => {
    expect(formatShellStatusNote({ exitCode: undefined })).toBe("");
  });

  it("输出收集被截 → 说清楚「结尾不是真结尾」（点名 10MB 上限）", () => {
    const note = formatShellStatusNote({ exitCode: 0, collectDropped: true });
    expect(note).toBe("（输出超过 10MB 收集上限，其后的内容没有收集）");
  });

  it("退出码 + 收集被截 → 合并成同一行（用「；」隔开），不拆成两行", () => {
    const note = formatShellStatusNote({ exitCode: 1, collectDropped: true });
    expect(note).toBe("（exit code 1；输出超过 10MB 收集上限，其后的内容没有收集）");
    expect(note).not.toContain("\n");
  });

  it("信号终止 + 收集被截 → 同样合并成一行", () => {
    const note = formatShellStatusNote({ exitCode: null, collectDropped: true });
    expect(note.startsWith("（进程被信号终止，未取得退出码；")).toBe(true);
    expect(note).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// 真 shell 工具（包好预算的那个）
// ---------------------------------------------------------------------------

type ShellResult = {
  content: Array<{ type: string; text: string }>;
  details?: { exitCode?: number };
};
type ToolLike = {
  name?: unknown;
  execute: (...a: unknown[]) => Promise<ShellResult>;
};

const posix = process.platform !== "win32";
const cwd = mkdtempSync(path.join(os.tmpdir(), "fe-shell-status-"));
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const shell = buildCodingToolDefs(cwd, (async () => "") as never).find(
  (d) => (d as { name?: unknown }).name === "shell",
) as unknown as ToolLike;

const run = async (command: string, timeout?: number) => {
  const r = await shell.execute("call-1", { command, timeout });
  return {
    text: r.content.map((c) => c.text).join("\n"),
    details: r.details,
  };
};

// 冷启动（首次 spawn bash + 转译依赖）可能超默认 5s；长输出用例要生成 / 搬运几十 KB ~ 11MB
describe.skipIf(!posix)("shell 工具回包：状态行在开头（真子进程）", { timeout: 60_000 }, () => {
  it("成功 + 有输出 → 原样、没有状态行", async () => {
    const r = await run("printf 'hello'");
    expect(r.text).toBe("hello");
    expect(r.details?.exitCode).toBe(0);
  });

  it("成功 + 无输出 → (无输出)，没有状态行", async () => {
    const r = await run("true");
    expect(r.text).toBe("(无输出)");
    expect(r.details?.exitCode).toBe(0);
  });

  it("失败 + 有输出 → 第一行是（exit code N），输出紧随其后（改前：挂在末尾）", async () => {
    const r = await run("echo oops; exit 3");
    expect(r.text).toBe("（exit code 3）\noops");
    expect(r.details?.exitCode).toBe(3);
  });

  it("失败 + 无输出 → （exit code N）+ (无输出)", async () => {
    const r = await run("exit 4");
    expect(r.text).toBe("（exit code 4）\n(无输出)");
    expect(r.details?.exitCode).toBe(4);
  });

  it("被信号杀死（kill -9 $$）→ 明说被信号终止、partial 输出保留；details.exitCode 仍是 -1（改前：回包只有 partial）", async () => {
    const r = await run("echo partial; kill -9 $$");
    expect(r.text).toBe("（进程被信号终止，未取得退出码）\npartial");
    expect(r.details?.exitCode).toBe(-1);
  });

  it("超时路径不变：提示在最前、已产生的输出在后（对照，本批没动这条路径）", async () => {
    const r = await run("echo before-sleep; sleep 5", 1);
    expect(r.text).toMatch(/^命令超时被终止（1000ms）/);
    expect(r.text).toContain("before-sleep");
  });

  it("输出远超预算 + 失败：开头是状态行、结尾的报错还在、中间被省略（改前：只留前 32KB，报错与退出码一起丢）", async () => {
    const r = await run(
      "seq 1 4000 | sed 's/^/progress line number /'; echo 'FATAL: boom at the very end' >&2; exit 2",
    );
    // 状态行：第一行
    expect(r.text.startsWith("（exit code 2）\n")).toBe(true);
    // 开头的进度行还在、结尾的报错还在
    expect(r.text).toContain("progress line number 1\n");
    expect(r.text).toContain("FATAL: boom at the very end");
    // 中间被省略，并且说清楚是头 + 尾
    expect(r.text).toMatch(/…\(省略 \d+ 字符\)…/);
    expect(r.text).toContain("模型输入已截断");
    expect(r.text).toContain("本次只给开头 8.0KB + 结尾");
    // 中间的某一行确实不在
    expect(r.text).not.toContain("progress line number 2000\n");
    // 总长受控：主体 ≤ 32KB，再加指引后缀（挂在配额之外、几百字节）
    expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(32 * 1024 + 512);
    expect(r.details?.exitCode).toBe(2);
  });

  it("输出远超预算 + 成功：没有状态行，但结尾（最后一行）仍在", async () => {
    const r = await run("seq 1 4000 | sed 's/^/progress line number /'");
    expect(r.text.startsWith("progress line number 1\n")).toBe(true);
    expect(r.text).toContain("progress line number 4000");
    expect(r.text).not.toContain("exit code");
    expect(r.text).toContain("本次只给开头 8.0KB + 结尾");
    expect(r.details?.exitCode).toBe(0);
  });

  it("输出超过 10MB 收集上限：第一行说明后面没收集（退出码 0 时只有这一句）", async () => {
    const r = await run("head -c 11000000 /dev/zero | tr '\\0' 'x'; echo");
    expect(r.text.startsWith("（输出超过 10MB 收集上限，其后的内容没有收集）\n")).toBe(true);
    expect(r.text).toMatch(/原文 10\.\dMB/);
    expect(r.text).toContain("本次只给开头 8.0KB + 结尾");
    expect(r.details?.exitCode).toBe(0);
  });

  it("输出超过 10MB + 失败：退出码与收集提示合并在同一个状态行里", async () => {
    const r = await run("head -c 11000000 /dev/zero | tr '\\0' 'x'; exit 5");
    expect(
      r.text.startsWith("（exit code 5；输出超过 10MB 收集上限，其后的内容没有收集）\n"),
    ).toBe(true);
    expect(r.details?.exitCode).toBe(5);
  });
});
