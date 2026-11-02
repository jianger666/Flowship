/**
 * tool-outputs 全量落盘的凭据脱敏 + 权限（P1：落盘 / 读取接口曾绕过 event-secret-redact）。
 *
 * 背景：agent 跑 `printenv` / `cat config.json` / `curl -v` 的输出超过 8KB（UI 截断）或 32KB（模型预算截断）时，
 * 全量会落到 `tool-outputs/<callId>.txt`；以前只有事件行 / 推流脱敏，这份全量是明文、
 * `GET /api/tasks/[id]/tool-output/[callId]` 原样返回。现在：写盘前脱敏（并先脱敏再截预览）、
 * 目录 0700 / 文件 0600、GET 读出后再脱敏一次兜住老文件。
 *
 * 全程假凭据 + 临时数据目录。DATA_DIR 须在动态 import 前钉死（同 tool-output-spill.test.ts）。
 */
import { mkdtempSync, promises as fs, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// redactSecretsInText 默认透传真实实现；「脱敏本身抛错 → 不落明文」的用例用 mockImplementationOnce 让它抛
vi.mock("@/lib/server/event-secret-redact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/event-secret-redact")>();
  return { ...actual, redactSecretsInText: vi.fn(actual.redactSecretsInText) };
});

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tool-output-redact-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const GIT_TOKEN = "glpat-FAKE0123456789abcdefXYZ";
const API_KEY = "fake-api-key-for-tool-output-0001";
const GIT_PLACEHOLDER = "[REDACTED:gitToken]";
const API_PLACEHOLDER = "[REDACTED:apiKey]";

writeFileSync(
  path.join(TMP_ROOT, "config.json"),
  JSON.stringify({ gitToken: GIT_TOKEN, apiKey: API_KEY }),
  "utf-8",
);

const TASKS = [
  "task-redact-shell",
  "task-redact-edge",
  "task-redact-spill",
  "task-redact-ui",
  "task-redact-perm",
  "task-redact-chmod",
  "task-redact-legacy",
  "task-redact-big",
  "task-redact-throw",
  "task-redact-huge",
];

beforeAll(async () => {
  for (const id of TASKS) {
    await fs.mkdir(path.join(TMP_ROOT, "tasks", id), { recursive: true });
  }
});

const {
  persistTruncatedOutput,
  spillModelFullOutput,
  buildToolResultMeta,
  redactToolOutputText,
  TOOL_RESULT_OUTPUT_LIMIT,
  TOOL_OUTPUT_REDACT_MAX_CHARS,
} = await import("../src/lib/server/tool-result-persist");
const { redactSecretsInText } = await import("@/lib/server/event-secret-redact");
const { GET } = await import("../src/app/api/tasks/[id]/tool-output/[callId]/route");

const outFile = (taskId: string, callId: string): string =>
  path.join(TMP_ROOT, "tasks", taskId, "tool-outputs", `${callId}.txt`);
const isWin = process.platform === "win32";

/** 约 20KB 的 shell 输出：头 / 中 / 尾各埋一个凭据，行数固定 */
const buildLeakyOutput = (): { text: string; lines: number } => {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    if (i === 3) lines.push(`GITLAB_TOKEN=${GIT_TOKEN}`);
    else if (i === 200) lines.push(`apiKey: ${API_KEY}`);
    else if (i === 399) lines.push(`curl: Authorization: Bearer ${GIT_TOKEN}`);
    else lines.push(`line-${String(i).padStart(3, "0")} ${"p".repeat(40)}`);
  }
  return { text: lines.join("\n"), lines: lines.length };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistTruncatedOutput：先脱敏再截预览与落盘", () => {
  it("全量文件与 UI 预览都不含凭据，占位符在，行数不变", async () => {
    const { text, lines } = buildLeakyOutput();
    expect(Buffer.byteLength(text)).toBeGreaterThan(TOOL_RESULT_OUTPUT_LIMIT);

    const r = await persistTruncatedOutput(
      "task-redact-shell",
      "call_redact_shell",
      text,
      TOOL_RESULT_OUTPUT_LIMIT,
      "head-tail",
    );
    expect(r.truncated).toBe(true);
    expect(r.fullPath).toBe("tool-outputs/call_redact_shell.txt");

    const onDisk = await fs.readFile(outFile("task-redact-shell", "call_redact_shell"), "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN);
    expect(onDisk).not.toContain(API_KEY);
    expect(onDisk).toContain(`GITLAB_TOKEN=${GIT_PLACEHOLDER}`);
    expect(onDisk).toContain(`apiKey: ${API_PLACEHOLDER}`);
    expect(onDisk).toContain(`Bearer ${GIT_PLACEHOLDER}`);
    // 文本层脱敏只换凭据值：行数 / 其它内容原样（不破坏分页 / 行号）
    expect(onDisk.split("\n")).toHaveLength(lines);
    expect(onDisk).toContain("line-100 ");
    expect(onDisk).toBe(
      text.split(GIT_TOKEN).join(GIT_PLACEHOLDER).split(API_KEY).join(API_PLACEHOLDER),
    );

    // 预览（头 2KB + 尾 ~6KB）里的凭据同样被抹掉：头部第 3 行的 token 在预览范围内
    expect(r.output).not.toContain(GIT_TOKEN);
    expect(r.output).not.toContain(API_KEY);
    expect(r.output).toContain(`GITLAB_TOKEN=${GIT_PLACEHOLDER}`);
  });

  it("凭据恰好跨在预览截断点上：不留半截明文（先截再脱敏会漏）", async () => {
    // head 预览取前 2KB（SHELL_PREVIEW_HEAD_BYTES）：让 token 起点落在第 2020 字节，原文里切口正好把它劈成两半
    // （头部会带走 28 个字符的 token 前缀）；先脱敏的话占位符（19 字符）整个落在头部内
    const prefix = "a".repeat(2020);
    const text = `${prefix}${GIT_TOKEN}${"b".repeat(20 * 1024)}`;
    const r = await persistTruncatedOutput(
      "task-redact-edge",
      "call_redact_edge",
      text,
      TOOL_RESULT_OUTPUT_LIMIT,
      "head-tail",
    );
    expect(r.truncated).toBe(true);
    // 任何长度 ≥ 8 的 token 前缀都不该出现在预览里（半截 token = 部分泄漏）
    expect(r.output).not.toContain(GIT_TOKEN.slice(0, 10));
    expect(r.output).toContain(GIT_PLACEHOLDER);
    const onDisk = await fs.readFile(outFile("task-redact-edge", "call_redact_edge"), "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN.slice(0, 10));
  });

  it("没有凭据命中 → 全量文件与输入逐字节相同（不动已有截断 / 分块逻辑）", async () => {
    const text = `${"clean-line\n".repeat(3000)}end`;
    const r = await persistTruncatedOutput("task-redact-shell", "call_redact_clean", text);
    expect(r.truncated).toBe(true);
    expect(await fs.readFile(outFile("task-redact-shell", "call_redact_clean"), "utf-8")).toBe(text);
    // head 模式：预览是头部前缀
    expect(text.startsWith(r.output.split("…(truncated")[0]!)).toBe(true);
  });
});

describe("模型预算落盘（spillModelFullOutput）与 UI 复用", () => {
  it("spill 写盘前脱敏：盘上没有凭据", async () => {
    const full = `${"pad-line\n".repeat(5000)}GITLAB_TOKEN=${GIT_TOKEN}\n${"tail-line\n".repeat(5000)}`;
    const r = await spillModelFullOutput("task-redact-spill", "call_redact_spill", full);
    expect(r).not.toBeNull();
    const onDisk = await fs.readFile(r!.absPath, "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN);
    expect(onDisk).toContain(`GITLAB_TOKEN=${GIT_PLACEHOLDER}`);
    expect(onDisk.split("\n")).toHaveLength(full.split("\n").length);
  });

  it("buildToolResultMeta 走 Cursor 路径（无 spill、8~32KB）：落盘文件与 meta.output 都已脱敏", async () => {
    const { text } = buildLeakyOutput();
    const meta = await buildToolResultMeta({
      taskId: "task-redact-ui",
      callId: "call_redact_ui",
      rawName: "shell",
      args: {},
      result: { status: "success", value: { stdout: text, exitCode: 0 } },
      msgStatus: "completed",
    });
    expect(meta.truncated).toBe(true);
    expect(meta.fullPath).toBe("tool-outputs/call_redact_ui.txt");
    expect(meta.output).not.toContain(GIT_TOKEN);
    const onDisk = await fs.readFile(outFile("task-redact-ui", "call_redact_ui"), "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN);
    expect(onDisk).not.toContain(API_KEY);
  });
});

describe("文件权限：目录 0700 / 文件 0600", () => {
  it.skipIf(isWin)("新建目录 0700、全量文件 0600", async () => {
    const { text } = buildLeakyOutput();
    await persistTruncatedOutput("task-redact-perm", "call_redact_perm", text);
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-perm", "tool-outputs");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(outFile("task-redact-perm", "call_redact_perm")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)("老版本建的 0755 目录：下次写入时被收紧到 0700", async () => {
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-perm", "tool-outputs");
    await fs.chmod(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    await persistTruncatedOutput("task-redact-perm", "call_redact_perm_2", buildLeakyOutput().text);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("chmod 失败（Windows / 特殊文件系统）被吞：照常落盘、照常带 fullPath", async () => {
    vi.spyOn(fs, "chmod").mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
    );
    const r = await persistTruncatedOutput(
      "task-redact-chmod",
      "call_redact_chmod",
      buildLeakyOutput().text,
    );
    expect(r.truncated).toBe(true);
    expect(r.fullPath).toBe("tool-outputs/call_redact_chmod.txt");
    const onDisk = await fs.readFile(outFile("task-redact-chmod", "call_redact_chmod"), "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN);
  });
});

describe("GET tool-output：读出后再脱敏一次（兜住历史明文老文件）", () => {
  const get = (taskId: string, callId: string) =>
    GET(new Request("http://local/"), { params: Promise.resolve({ id: taskId, callId }) });

  it("改动前落盘的明文文件：接口返回的是脱敏版，行数不变", async () => {
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-legacy", "tool-outputs");
    await fs.mkdir(dir, { recursive: true });
    const legacy = `PATH=/usr/bin\nGITLAB_TOKEN=${GIT_TOKEN}\nOPENAI=${API_KEY}\nend\n`;
    await fs.writeFile(path.join(dir, "call_legacy.txt"), legacy, "utf-8");

    const res = await get("task-redact-legacy", "call_legacy");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(GIT_TOKEN);
    expect(body).not.toContain(API_KEY);
    expect(body).toBe(
      `PATH=/usr/bin\nGITLAB_TOKEN=${GIT_PLACEHOLDER}\nOPENAI=${API_PLACEHOLDER}\nend\n`,
    );
  });

  it("没有凭据的文件：原样返回（含末尾换行），不误伤", async () => {
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-legacy", "tool-outputs");
    const clean = "line1\nline2 带中文\n\nlast-without-secret\n";
    await fs.writeFile(path.join(dir, "call_clean.txt"), clean, "utf-8");
    const res = await get("task-redact-legacy", "call_clean");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(clean);
  });

  it("写盘后才出现的凭据（配置里后加的 key）也会在读取时被抹掉", async () => {
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-legacy", "tool-outputs");
    const lateKey = "fake-late-added-key-for-redact-0009";
    await fs.writeFile(path.join(dir, "call_late.txt"), `k=${lateKey}\n`, "utf-8");
    const before = await (await get("task-redact-legacy", "call_late")).text();
    expect(before).toContain(lateKey); // 配置里还没有它

    writeFileSync(
      path.join(TMP_ROOT, "config.json"),
      JSON.stringify({ gitToken: GIT_TOKEN, apiKey: API_KEY, customProviders: [{ apiKey: lateKey }] }),
      "utf-8",
    );
    const after = await (await get("task-redact-legacy", "call_late")).text();
    expect(after).not.toContain(lateKey);
    expect(after).toContain(API_PLACEHOLDER);
  });
});

describe("大文件：线性脱敏、不卡死", () => {
  it("4MB 输出（凭据散布头 / 尾）正常完成且全部抹掉", async () => {
    const chunk = `${"x".repeat(99)}\n`;
    const text = `GITLAB_TOKEN=${GIT_TOKEN}\n${chunk.repeat(42_000)}tail ${GIT_TOKEN}\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
    const r = await persistTruncatedOutput("task-redact-big", "call_redact_big", text, TOOL_RESULT_OUTPUT_LIMIT, "head-tail");
    expect(r.truncated).toBe(true);
    const onDisk = await fs.readFile(outFile("task-redact-big", "call_redact_big"), "utf-8");
    expect(onDisk).not.toContain(GIT_TOKEN);
    expect(onDisk.split("\n")).toHaveLength(text.split("\n").length);
    expect(r.output).not.toContain(GIT_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------
// P3：脱敏本身抛错 → 降级必须是「不落明文」；脱敏输入加上限（超出部分整体换成提示，不是明文）
// ---------------------------------------------------------------------------------------------

describe("脱敏抛错（P3）：fail-closed，绝不退回明文", () => {
  const boom = (): never => {
    throw new RangeError("Invalid string length（模拟脱敏阶段意外）");
  };

  it("persistTruncatedOutput：脱敏抛错 → 不抛、不落盘、不带 fullPath，output 是占位提示而不含原文", async () => {
    vi.mocked(redactSecretsInText).mockImplementationOnce(boom);
    const { text } = buildLeakyOutput();
    const r = await persistTruncatedOutput("task-redact-throw", "call_throw_persist", text, TOOL_RESULT_OUTPUT_LIMIT, "head-tail");

    expect(r.fullPath).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.output).toMatch(/脱敏/);
    expect(r.output).not.toContain(GIT_TOKEN);
    expect(r.output).not.toContain(API_KEY);
    expect(r.output).not.toContain("line-100"); // 连没有凭据的正文也不给：预览本身就是用原文切的
    await expect(fs.access(outFile("task-redact-throw", "call_throw_persist"))).rejects.toThrow();
  });

  it("buildToolResultMeta（emitToolResult 的入口）：脱敏抛错时仍返回 meta（不被外层 catch 吞成「事件丢了」），且无明文无落盘", async () => {
    vi.mocked(redactSecretsInText).mockImplementationOnce(boom);
    const { text } = buildLeakyOutput();
    const meta = await buildToolResultMeta({
      taskId: "task-redact-throw",
      callId: "call_throw_meta",
      rawName: "shell",
      args: {},
      result: { status: "success", value: { stdout: text, exitCode: 0 } },
      msgStatus: "completed",
    });
    expect(meta.callId).toBe("call_throw_meta");
    expect(meta.output).not.toContain(GIT_TOKEN);
    expect(meta.fullPath).toBeUndefined();
    await expect(fs.access(outFile("task-redact-throw", "call_throw_meta"))).rejects.toThrow();
  });

  it("spillModelFullOutput：脱敏抛错 → 返回 null（调用方降级 V1 后缀）、不落盘", async () => {
    vi.mocked(redactSecretsInText).mockImplementationOnce(boom);
    const r = await spillModelFullOutput("task-redact-throw", "call_throw_spill", buildLeakyOutput().text);
    expect(r).toBeNull();
    await expect(fs.access(outFile("task-redact-throw", "call_throw_spill"))).rejects.toThrow();
  });

  it("GET tool-output：读时脱敏抛错 → 500 redact_failed，响应体不含明文（不是 404，也不是原文）", async () => {
    const dir = path.join(TMP_ROOT, "tasks", "task-redact-throw", "tool-outputs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "call_throw_get.txt"), `GITLAB_TOKEN=${GIT_TOKEN}\n`, "utf-8");
    vi.mocked(redactSecretsInText).mockImplementationOnce(boom);
    const res = await GET(new Request("http://local/"), {
      params: Promise.resolve({ id: "task-redact-throw", callId: "call_throw_get" }),
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(GIT_TOKEN);
    expect(JSON.parse(body)).toEqual({ error: "redact_failed" });
  });

  it("对照：不抛时行为不变（mock 只在被点名的那一次生效）", async () => {
    const r = await persistTruncatedOutput("task-redact-throw", "call_throw_ok", buildLeakyOutput().text);
    expect(r.fullPath).toBe("tool-outputs/call_throw_ok.txt");
    expect(await fs.readFile(outFile("task-redact-throw", "call_throw_ok"), "utf-8")).not.toContain(GIT_TOKEN);
  });
});

describe("redactToolOutputText：输入上限（超出部分整体替换成提示，不是明文）", () => {
  const CAP = 1000;
  const frags = (tok: string): string[] => [tok.slice(0, 8), tok.slice(-8), tok.slice(4, 14)];

  it("不超限：与 redactSecretsInText 完全一致", () => {
    const text = `a ${GIT_TOKEN} b ${API_KEY} c`;
    expect(redactToolOutputText(text, CAP)).toBe(redactSecretsInText(text));
  });

  it("超限：头尾各留一窗口（脱敏后），中间换成提示；不含任何凭据片段", () => {
    const text = `HEAD-MARK ${GIT_TOKEN}\n${"m".repeat(5000)}\nTAIL-MARK ${API_KEY}`;
    const out = redactToolOutputText(text, CAP);
    expect(out.length).toBeLessThan(CAP + 400); // 窗口 + 提示，远小于原文
    expect(out).toContain("HEAD-MARK");
    expect(out).toContain("TAIL-MARK");
    expect(out).toContain(GIT_PLACEHOLDER);
    expect(out).toContain(API_PLACEHOLDER);
    expect(out).toMatch(/输出过大/);
    expect(out).toMatch(/已省略/);
    for (const f of [...frags(GIT_TOKEN), ...frags(API_KEY)]) expect(out).not.toContain(f);
  });

  it("凭据恰好跨在头窗口 / 尾窗口的切口上：扫过切口两侧每个偏移，均不留半截明文", () => {
    const half = CAP / 2;
    const total = 3000;
    const tailStart = total - half;
    const check = (tok: string, at: number): void => {
      const text = `${"p".repeat(at)}${tok}`.padEnd(total, "q");
      const out = redactToolOutputText(text, CAP);
      for (const f of frags(tok)) {
        expect(out, `at=${at} 残留片段 ${f}`).not.toContain(f);
      }
    };
    for (const tok of [GIT_TOKEN, API_KEY]) {
      for (let d = -(tok.length + 2); d <= 2; d++) {
        check(tok, half + d); // 头窗口切口 [half]
        check(tok, tailStart + d); // 尾窗口起点
      }
    }
  });

  it("没配任何凭据时不截断（无可脱敏、也不必为它丢数据）", async () => {
    // 临时把配置清空：redact 缓存按 stat 失效，下一次调用就读到「没配」
    const cfg = path.join(TMP_ROOT, "config.json");
    const saved = await fs.readFile(cfg, "utf-8");
    try {
      await fs.rm(cfg);
      const text = "z".repeat(CAP * 3);
      expect(redactToolOutputText(text, CAP)).toBe(text);
    } finally {
      await fs.writeFile(cfg, saved, "utf-8");
    }
  });
});

describe("超大输出（P3）：脱敏有界、耗时可控、不留明文", () => {
  it("约 40M 字符的 shell 输出：落盘文件受上限约束（头尾窗口 + 提示），耗时在宽松上限内，切口处凭据无残留", async () => {
    const half = TOOL_OUTPUT_REDACT_MAX_CHARS / 2;
    const total = 40 * 1024 * 1024;
    // 在头窗口切口、尾窗口起点两处各劈开一个 token，另在首尾各放一个完整 token
    const buf = Buffer.alloc(total, "x");
    buf.write("HEAD-MARK\n", 0);
    buf.write(`${GIT_TOKEN}\n`, 20);
    buf.write(GIT_TOKEN, half - 10); // 头窗口切口劈开
    buf.write(API_KEY, total - half - 10); // 尾窗口起点劈开
    buf.write(`\nTAIL-MARK ${GIT_TOKEN}\n`, total - 60);
    const text = buf.toString("latin1");
    expect(text.length).toBeGreaterThan(TOOL_OUTPUT_REDACT_MAX_CHARS);

    const t0 = performance.now();
    const r = await persistTruncatedOutput(
      "task-redact-huge",
      "call_huge",
      text,
      TOOL_RESULT_OUTPUT_LIMIT,
      "head-tail",
    );
    const elapsed = performance.now() - t0;
    // 脱敏 + 写盘 + 预览全程：本机实测几百毫秒量级；给 8s 余量只防「退化成不设上限的逐 token 全量处理」，不是性能基准
    expect(elapsed).toBeLessThan(8000);

    expect(r.truncated).toBe(true);
    expect(r.fullPath).toBe("tool-outputs/call_huge.txt");
    const onDisk = await fs.readFile(outFile("task-redact-huge", "call_huge"), "utf-8");
    expect(onDisk.length).toBeLessThanOrEqual(TOOL_OUTPUT_REDACT_MAX_CHARS + 1024);
    expect(onDisk).toMatch(/输出过大/);
    expect(onDisk).toContain("HEAD-MARK");
    expect(onDisk).toContain("TAIL-MARK");
    for (const secret of [GIT_TOKEN, API_KEY]) {
      expect(onDisk).not.toContain(secret);
      expect(onDisk).not.toContain(secret.slice(0, 8));
      expect(onDisk).not.toContain(secret.slice(-8));
    }
    expect(r.output).not.toContain(GIT_TOKEN);
    expect(r.output).toContain("TAIL-MARK");
  }, 30_000);
});
