/**
 * lark-api：Windows 命令行长度预检 + execFile 失败 message 瘦身（R14 B4-3 · Q12a-05 / Q12a-06）
 *
 * Q12a-06：Windows `CreateProcess` 命令行上限 32767 字符，lark-cli 的 `--data` 带整卡 / 整段正文，长轮必然超限——
 *   `spawn ENAMETOOLONG` 不是瞬时错误、永不自愈，每次 flush 都败。macOS / Linux 的 ARG_MAX ≈ 1 MB 测不出，
 *   所以这里用 `__setLarkPlatformForTest("win32")` 伪装平台：超限就地拒绝（不 spawn、不重试、不排队），带 `ARGV_TOO_LONG` 码。
 *   估算按 Windows 引用规则（libuv `quote_cmd_arg`）算——整卡 JSON 里引号很多，转义能把长度放大到 2~4 倍，
 *   直接拿 `args.join(" ").length` 估会漏。
 * Q12a-05：Node `execFile` 失败的 message 是 `Command failed: <整条命令行>\n<stderr>`，命令行里有整个请求体——
 *   `normalizeLarkError` 只取 stderr 末行；不能去解析 message 本体（命令行里的裸换行会把正文当成 stderr）。
 *
 * 全程假 exec、不起真子进程、不联网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  __setLarkPlatformForTest,
  __setLarkRetryBaseForTest,
  estimateWindowsCommandLength,
  larkApi,
  LARK_WIN_CMDLINE_SOFT_LIMIT,
  normalizeLarkError,
  runLark,
} from "@/lib/server/feishu-bridge/lark-api";
import { isTransientLarkError, LarkApiError } from "@/lib/server/feishu-bridge/types";

const OK = { stdout: JSON.stringify({ ok: true, data: { fine: true } }), stderr: "" };

beforeEach(() => {
  __setLarkRetryBaseForTest(0);
});

afterEach(() => {
  __setLarkExecForTest(null);
  __setLarkPlatformForTest(null);
  __setLarkRetryBaseForTest(null);
  __resetLarkBinCacheForTest();
});

/** libuv `quote_cmd_arg` 的参照实现（从后往前、真的拼出字符串）——与被测的「只数长度」写法结构不同，互相印证 */
const referenceQuote = (arg: string): string => {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let quoteHit = true;
  let rev = "";
  for (let i = arg.length - 1; i >= 0; i -= 1) {
    const ch = arg[i]!;
    rev += ch;
    if (quoteHit && ch === "\\") {
      rev += "\\";
    } else if (ch === '"') {
      quoteHit = true;
      rev += "\\";
    } else {
      quoteHit = false;
    }
  }
  out += [...rev].reverse().join("") + '"';
  return out;
};

describe("estimateWindowsCommandLength：按 Windows 引用规则估命令行长度", () => {
  const BIN = 260; // 给 lark-cli 二进制路径预留的字符数（MAX_PATH）

  it("没有参数 = 只有二进制路径余量", () => {
    expect(estimateWindowsCommandLength([])).toBe(BIN);
  });

  it("普通参数：每个 = 自身长度 + 1 个分隔空格", () => {
    expect(estimateWindowsCommandLength(["api", "GET", "/x"])).toBe(BIN + 4 + 4 + 3);
  });

  it("含空格的参数要加引号：+2", () => {
    expect(estimateWindowsCommandLength(["a b"])).toBe(BIN + 1 + 5);
  });

  it("空字符串参数写成 \"\"：2 个字符", () => {
    expect(estimateWindowsCommandLength([""])).toBe(BIN + 1 + 2);
  });

  it("含引号的参数：整体加引号 + 每个引号前加一个反斜杠（{\"a\":1} → \"{\\\"a\\\":1}\" 共 11）", () => {
    expect(estimateWindowsCommandLength(['{"a":1}'])).toBe(BIN + 1 + 11);
  });

  it("引号前的反斜杠要翻倍：a\\\"b → \"a\\\\\\\"b\" 共 8", () => {
    expect(estimateWindowsCommandLength(['a\\"b'])).toBe(BIN + 1 + 8);
  });

  it("结尾的反斜杠翻倍（引号会跟在它后面）：含空格的 a b\\ → 7", () => {
    expect(estimateWindowsCommandLength(["a b\\"])).toBe(BIN + 1 + 7);
  });

  it("不挨着引号的反斜杠保持单个：a\\b c → 7", () => {
    expect(estimateWindowsCommandLength(["a\\b c"])).toBe(BIN + 1 + 7);
  });

  it("只有换行没有空格 / 制表符 / 引号：libuv 不加引号", () => {
    expect(estimateWindowsCommandLength(["a\nb"])).toBe(BIN + 1 + 3);
  });

  it("制表符触发加引号", () => {
    expect(estimateWindowsCommandLength(["a\tb"])).toBe(BIN + 1 + 5);
  });

  it("与参照实现逐例对拍：随机字符串（含引号 / 反斜杠 / 空格 / 制表符 / 换行 / 中文 / 星号平面字符）长度完全一致", () => {
    const alphabet = ["a", "b", " ", "\t", '"', "\\", "\n", "字", "é", "😀"];
    let seed = 20261025;
    const rnd = (): number => {
      // 简单的线性同余：固定种子，结果可复现
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let n = 0; n < 600; n += 1) {
      const len = Math.floor(rnd() * 14);
      let s = "";
      for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rnd() * alphabet.length)]!;
      expect(estimateWindowsCommandLength([s]) - BIN - 1, JSON.stringify(s)).toBe(
        referenceQuote(s).length,
      );
    }
  });

  it("整卡 JSON 里引号很多：估算值远大于 args.join(' ').length（这正是不能直接拿 join 长度估的原因）", () => {
    const data = JSON.stringify({ card: { type: "card_json", data: JSON.stringify({ k: '"'.repeat(5000) }) } });
    const naive = ["api", "PUT", "/x", "--data", data].join(" ").length;
    const est = estimateWindowsCommandLength(["api", "PUT", "/x", "--data", data]);
    expect(est).toBeGreaterThan(naive * 1.5);
  });

  it("常量：软上限 30_000（Windows 上限 32767，余量留给二进制路径与估算误差）", () => {
    expect(LARK_WIN_CMDLINE_SOFT_LIMIT).toBe(30_000);
  });
});

describe("runLark / larkApi：win32 命令行超长就地拒绝", () => {
  const countingExec = () => {
    const exec = vi.fn(async () => OK);
    __setLarkExecForTest(exec as never);
    return exec;
  };

  it("win32 + 超长 → 抛 ARGV_TOO_LONG，不 spawn、不重试", async () => {
    const exec = countingExec();
    __setLarkPlatformForTest("win32");
    const err = await larkApi("PUT", "/open-apis/cardkit/v1/cards/c1", {
      data: { content: "字".repeat(40_000) },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LarkApiError);
    expect(err).toMatchObject({ name: "LarkApiError", code: "ARGV_TOO_LONG" });
    expect((err as LarkApiError).message).toContain("命令行过长");
    expect((err as LarkApiError).api).toBe("api PUT /open-apis/cardkit/v1/cards/c1");
    expect(exec).not.toHaveBeenCalled();
  });

  it("预检不是传输瞬时错误：isTransientLarkError 不认它（永不重试）", async () => {
    countingExec();
    __setLarkPlatformForTest("win32");
    const err = await larkApi("GET", "/open-apis/x", { params: { q: "字".repeat(40_000) } }).catch(
      (e: unknown) => e,
    );
    expect(isTransientLarkError(err)).toBe(false);
  });

  it("win32 + 正常大小 → 照常执行", async () => {
    const exec = countingExec();
    __setLarkPlatformForTest("win32");
    await expect(
      larkApi("PUT", "/open-apis/cardkit/v1/cards/c1", { data: { content: "字".repeat(2000) } }),
    ).resolves.toMatchObject({ data: { fine: true } });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("同样的超长内容在非 win32（darwin / linux）不拦：ARG_MAX ≈ 1 MB，不受影响", async () => {
    for (const p of ["darwin", "linux"] as const) {
      const exec = countingExec();
      __setLarkPlatformForTest(p);
      await expect(
        larkApi("PUT", "/open-apis/cardkit/v1/cards/c1", { data: { content: "字".repeat(40_000) } }),
      ).resolves.toBeTruthy();
      expect(exec).toHaveBeenCalledTimes(1);
    }
  });

  it("引号密集的内容：join 长度只有 ~16k、按 Windows 引用规则估是 ~32k → 仍然被拦（拿 join 长度估会漏）", async () => {
    const exec = countingExec();
    __setLarkPlatformForTest("win32");
    const data = { content: '"'.repeat(8000) };
    const joined = ["api", "PUT", "/x", "--data", JSON.stringify(data)].join(" ").length;
    expect(joined).toBeLessThan(LARK_WIN_CMDLINE_SOFT_LIMIT); // 朴素估算会放行
    await expect(larkApi("PUT", "/x", { data })).rejects.toMatchObject({ code: "ARGV_TOO_LONG" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("边界：估算值恰好 = 软上限放行，多 1 个字符就拒", async () => {
    const exec = countingExec();
    __setLarkPlatformForTest("win32");
    const argsFor = (n: number): string[] => ["api", "POST", "/x", "--data", "a".repeat(n)];
    // runLark 会补上 --as bot --json
    const full = (n: number): string[] => [...argsFor(n), "--as", "bot", "--json"];
    const fixed = estimateWindowsCommandLength(full(1)); // data 为 1 个字符时的总长
    const nMax = LARK_WIN_CMDLINE_SOFT_LIMIT - fixed + 1;
    expect(estimateWindowsCommandLength(full(nMax))).toBe(LARK_WIN_CMDLINE_SOFT_LIMIT);
    await expect(runLark(argsFor(nMax))).resolves.toBeTruthy();
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(runLark(argsFor(nMax + 1))).rejects.toMatchObject({ code: "ARGV_TOO_LONG" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("预检在入队之前：单飞队列里有个卡住的调用时，超长请求也立刻失败，不陪排队", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setLarkExecForTest((async () => {
      await gate;
      return OK;
    }) as never);
    __setLarkPlatformForTest("win32");
    const blocker = runLark(["api", "GET", "/slow"]); // 占住队列
    const t0 = Date.now();
    await expect(runLark(["api", "POST", "/x", "--data", "a".repeat(40_000)])).rejects.toMatchObject({
      code: "ARGV_TOO_LONG",
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    release();
    await expect(blocker).resolves.toBeTruthy();
  });

  it("runLark 重构（参数组装挪到入队之前）后行为不变：调用方自带 --as 就不重复追加，--json 仍补上且只有一个", async () => {
    const exec = countingExec();
    await runLark(["api", "GET", "/x", "--as", "user"]);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toEqual(["api", "GET", "/x", "--as", "user", "--json"]);

    await runLark(["auth", "status"], { as: "none" });
    const args2 = (exec.mock.calls[1] as unknown as [string, string[]])[1];
    expect(args2).toEqual(["auth", "status", "--json"]);

    await runLark(["api", "GET", "/y"]);
    const args3 = (exec.mock.calls[2] as unknown as [string, string[]])[1];
    expect(args3).toEqual(["api", "GET", "/y", "--as", "bot", "--json"]);
  });

  it("调用方自带 --format：不再补 --json（用户已经指定了输出格式）", async () => {
    const exec = countingExec();
    await runLark(["api", "GET", "/x", "--format", "json"]);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toEqual(["api", "GET", "/x", "--format", "json", "--as", "bot"]);
    expect(args).not.toContain("--json");
  });

  it("不改调用方传进来的数组：补 --as / --json 只发生在副本上", async () => {
    countingExec(); // 装上假 exec（不装会真的去 spawn lark-cli）
    const input = ["api", "GET", "/x"];
    await runLark(input);
    expect(input).toEqual(["api", "GET", "/x"]);
  });
});

describe("normalizeLarkError：execFile 失败的 message 里不带整条命令行", () => {
  const API = "api PUT /open-apis/cardkit/v1/cards/:id";
  const argv = (text: string): string =>
    `Command failed: /Users/x/lark-cli api PUT /open-apis/cardkit/v1/cards/c1 --data {"content":"${text}"}`;
  const execErr = (message: string, stderr?: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), stderr === undefined ? {} : { stderr, stdout: "" }, extra);

  it("只取 stderr 最后一条有内容的行；命令行（本机路径 / 请求体）一个字都不进 message", () => {
    const err = normalizeLarkError(
      execErr(`${argv("任务正文SECRET")}\nError: ignored first line\nError: connect ECONNRESET\n`, "warn: x\nError: connect ECONNRESET\n\n"),
      undefined,
      API,
    );
    expect(err.message).toBe("Error: connect ECONNRESET");
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("--data");
    expect(err.message).not.toContain("/Users/x");
    expect(err.api).toBe(API);
  });

  it("stderr 是空的：退回「lark-cli 调用失败（命令标签）」，没有命令标签就是「lark-cli 调用失败」", () => {
    expect(normalizeLarkError(execErr(argv("x"), ""), undefined, API).message).toBe(
      `lark-cli 调用失败（${API}）`,
    );
    expect(normalizeLarkError(execErr(argv("x"), "  \n \n")).message).toBe("lark-cli 调用失败");
  });

  it("错误对象上根本没有 stderr：不去解析 message 本体（命令行里的裸换行会把正文当成 stderr）", () => {
    const msg = `Command failed: lark-cli im +messages-send --text 第一行\n第二行SECRET\n第三行SECRET`;
    const err = normalizeLarkError(execErr(msg), undefined, "im +messages-send");
    expect(err.message).toBe("lark-cli 调用失败（im +messages-send）");
    expect(err.message).not.toContain("SECRET");
  });

  it("stderr 末行很长：限到 300 字、折叠空白", () => {
    const err = normalizeLarkError(execErr(argv("x"), `Error: ${"很长 ".repeat(500)}`), undefined, API);
    expect(err.message.length).toBeLessThanOrEqual(300);
    expect(err.message.endsWith("…")).toBe(true);
    expect(err.message).not.toMatch(/\s{2,}/);
  });

  it("stderr 末行 ≤ 300 字原样保留：100 字、恰好 300 字都不截；301 字截成 300 字（末位是 …）", () => {
    const line100 = `Error: ${"x".repeat(93)}`;
    const line300 = `Error: ${"y".repeat(293)}`;
    const line301 = `Error: ${"z".repeat(294)}`;
    expect(line100).toHaveLength(100);
    expect(line300).toHaveLength(300);
    expect(line301).toHaveLength(301);
    expect(normalizeLarkError(execErr(argv("x"), `${line100}\n`), undefined, API).message).toBe(line100);
    expect(normalizeLarkError(execErr(argv("x"), `${line300}\n`), undefined, API).message).toBe(line300);
    const clipped = normalizeLarkError(execErr(argv("x"), `${line301}\n`), undefined, API).message;
    expect(clipped).toHaveLength(300);
    expect(clipped).toBe(`${line301.slice(0, 299)}…`);
  });

  it("stderr 末行是纯空白（Windows 的 \\r\\n\\r\\n 收尾 / 全空格行 / 制表符行）：跳过它，取上一条有内容的行", () => {
    expect(normalizeLarkError(execErr(argv("x"), "Error: boom\r\n\r\n"), undefined, API).message).toBe("Error: boom");
    expect(normalizeLarkError(execErr(argv("x"), "Error: boom\n   \n\t\n"), undefined, API).message).toBe("Error: boom");
  });

  it("stderr 全是空白：退回「lark-cli 调用失败（命令标签）」——不是空串被兜底成没有标签的版本", () => {
    expect(normalizeLarkError(execErr(argv("x"), "  \n \r\n"), undefined, API).message).toBe(
      `lark-cli 调用失败（${API}）`,
    );
  });

  it("stderr 末行里的连续空白 / 制表符折叠成一个空格", () => {
    const err = normalizeLarkError(execErr(argv("x"), "Error:    spaced\t\tout   here\n"), undefined, API);
    expect(err.message).toBe("Error: spaced out here");
  });

  it("不是 `Command failed:` 开头的 message 原样保留（spawn ENOENT / 只有 Command failed 一句）", () => {
    expect(normalizeLarkError(execErr("spawn lark-cli ENOENT", "")).message).toBe("spawn lark-cli ENOENT");
    expect(normalizeLarkError(execErr("Command failed", "boom")).message).toBe("Command failed");
  });

  it("原始 stdout / stderr 仍挂在 raw 上（传输瞬时判据要看）", () => {
    const err = normalizeLarkError(execErr(argv("x"), "Error: socket hang up\n"), undefined, API);
    expect(err.raw).toMatchObject({ stderr: "Error: socket hang up\n" });
    expect(isTransientLarkError(err)).toBe(true);
  });

  it("stdout 里是 ok:false 的 JSON 但没带 message：用 stderr 摘要，错误码照留", () => {
    const err = normalizeLarkError(
      execErr(argv("x"), "Error: upstream said no\n", {
        stdout: JSON.stringify({ ok: false, error: { code: 99991400 } }),
      }),
      undefined,
      API,
    );
    expect(err.message).toBe("Error: upstream said no");
    expect(err.code).toBe(99991400);
  });

  it("stdout 里有 JSON message 时仍以它为准（摘要只是兜底）", () => {
    const err = normalizeLarkError(
      execErr(argv("x"), "Error: noise\n", {
        stdout: JSON.stringify({ ok: false, error: { message: "Access denied", code: 99991672 } }),
      }),
    );
    expect(err.message).toBe("Access denied");
  });

  it("回归：命令行里恰好有 network / timeout 的正文，不再把业务失败判成「传输瞬时」", () => {
    const err = normalizeLarkError(
      execErr(argv("请检查 network timeout 配置"), "Error: permission denied\n"),
      undefined,
      API,
    );
    expect(err.message).toBe("Error: permission denied");
    expect(isTransientLarkError(err)).toBe(false);
  });

  it("超时（killed）分支不受影响", () => {
    const err = normalizeLarkError(
      Object.assign(new Error(argv("x")), { killed: true, stderr: "", stdout: "" }),
      undefined,
      API,
      8000,
    );
    expect(err.message).toBe("lark-cli 超时（8000ms）");
  });

  it("端到端：runLark 抛出的错误 message 干净；幂等 GET 的瞬时失败照样重试", async () => {
    let calls = 0;
    __setLarkExecForTest((async () => {
      calls += 1;
      if (calls === 1) throw execErr(argv("任务正文SECRET"), "Error: connect ECONNRESET\n");
      return OK;
    }) as never);
    await expect(runLark(["api", "GET", "/open-apis/x"])).resolves.toBeTruthy();
    expect(calls).toBe(2);

    calls = 0;
    __setLarkExecForTest((async () => {
      calls += 1;
      throw execErr(argv("任务正文SECRET"), "Error: Access denied\n");
    }) as never);
    const err = (await runLark(["api", "PUT", "/open-apis/x", "--data", "{}"]).catch(
      (e: unknown) => e,
    )) as LarkApiError;
    expect(calls).toBe(1);
    expect(err.message).toBe("Error: Access denied");
    expect(err.message).not.toContain("SECRET");
  });
});
