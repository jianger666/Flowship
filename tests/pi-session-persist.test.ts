/**
 * pi 会话文件（`pi-sessions/*.jsonl`）落盘前脱敏（评审 c）。
 *
 * 背景：pi 的 AgentSession 每条 message_end 都 `sessionManager.appendMessage(message)`，SessionManager 把整条消息 JSON.stringify 追加进会话文件，
 * 不经过 Flowship 的任何脱敏——工具结果里的截图 base64、`desktop_type.text` 等明文入参会原样落在用户硬盘上，
 * 与「输入的文字只记长度进审计，绝不进日志」的承诺矛盾（events.jsonl 早就脱敏了，这里是漏网之处）。
 *
 * 钉死：
 * - 纯函数 `redactPiMessageForPersist`：assistant 的 toolCall 入参（desktop_type / desktop_key / browser_type）与 toolResult 的图片块被换掉；
 *   **不改入参对象**（那就是 agent-core state 里的那份，改了本轮模型就看不到图了）；没东西可换时返回同一引用；幂等；user 消息（含用户发的图）不动；
 * - **真实的 pi SessionManager**：create / open 两个入口写出的磁盘文件里没有明文、没有 base64；调用方手里的原消息仍完整；
 * - 对照：不包装的 SessionManager 会把明文和 base64 原样写盘——这条证明测试不是空转，pi 哪天改了写盘行为它会红；
 * - 脱敏本身抛错（第二轮评审 #9）：fail-closed——改写成占位骨架再落盘（磁盘上没有原文，哪怕异常信息里带着原文）、
 *   异常不抛进调用方（pi 的事件循环）、日志只记角色与异常类型、之后的消息照常脱敏、写出的文件 resume 得回来；
 * - 接线：src 里除了 pi-session-persist.ts 自己，没有人直接 `SessionManager.create(` / `.open(`（落盘的会话必须走脱敏工厂）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";

import { redactBrowserArgs } from "@/lib/server/browser/redact-args";
import {
  createPersistedPiSession,
  failClosedPiMessage,
  openPersistedPiSession,
  PI_PERSIST_REDACTION_FAILED_TEXT,
  redactOnPersist,
  redactPiMessageForPersist,
} from "@/lib/server/pi-session-persist";

// 默认透传真实实现；个别用例用 mockImplementationOnce 让它抛错，验证 fail-closed 路径（redact-args 是无依赖的轻模块，包一层不影响其它用例）
vi.mock("@/lib/server/browser/redact-args", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/browser/redact-args")>();
  return { ...actual, redactBrowserArgs: vi.fn(actual.redactBrowserArgs) };
});

const TMP = mkdtempSync(path.join(os.tmpdir(), "fe-pi-persist-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const root = path.resolve(import.meta.dirname, "..");
const newDir = (name: string): string => {
  const d = path.join(TMP, name);
  mkdirSync(d, { recursive: true });
  return d;
};

const SECRET = "hunter2-密码";
const SECRET_LEN = [...SECRET].length; // 按码点数，与 redact-args 的占位符口径一致
const SECRET2 = "second-secret-#2";
/** ≥ 2048 字符才会被当成截图（小于它按图标处理，见 image-redact） */
const B64 = "QUJD".repeat(1024);

const userMsg = (text = "帮我登录") => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistantCall = (name: string, args: Record<string, unknown>, id = "c1") => ({
  role: "assistant",
  content: [
    { type: "text", text: "好的" },
    { type: "toolCall", id, name, arguments: args },
  ],
  api: "openai-completions",
  provider: "p",
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 2,
});
const toolResult = (name: string, content: unknown[], id = "c1") => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content,
  isError: false,
  timestamp: 3,
});
const screenshotResult = () =>
  toolResult("desktop_screenshot", [
    { type: "text", text: "截图完成" },
    { type: "image", data: B64, mimeType: "image/jpeg" },
  ]);

type AnyMsg = { content: Array<Record<string, unknown>> } & Record<string, unknown>;

describe("redactPiMessageForPersist：纯函数", () => {
  it("assistant 的 desktop_type：text 换成「已隐藏 N 字符」、其它参数保留；入参对象一个字没动", () => {
    const msg = assistantCall("desktop_type", { text: SECRET, submit: true });
    const before = JSON.stringify(msg);
    const out = redactPiMessageForPersist(msg) as unknown as AnyMsg;
    expect(out).not.toBe(msg);
    expect(out.content[1]?.arguments).toEqual({ text: `[已隐藏 ${SECRET_LEN} 字符]`, submit: true });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // 入参（= agent-core state 里的那份）没被改
    expect(JSON.stringify(msg)).toBe(before);
    // 没动的块仍是同一引用（只拷贝了变动的路径）
    expect(out.content[0]).toBe(msg.content[0]);
  });

  it("desktop_key：会打出字符的按键被盖，组合键 / 功能键不动", () => {
    const typed = redactPiMessageForPersist(assistantCall("desktop_key", { keys: "a" })) as unknown as AnyMsg;
    expect(typed.content[1]?.arguments).toEqual({ keys: "[已隐藏 1 字符]" });

    for (const keys of ["Enter", "Cmd+C", "Ctrl+Shift+T"]) {
      const msg = assistantCall("desktop_key", { keys });
      expect(redactPiMessageForPersist(msg), keys).toBe(msg);
    }
  });

  it("browser_type.text 同样被盖；没有敏感入参的工具（bash / read / desktop_screenshot）原样返回同一引用", () => {
    const typed = redactPiMessageForPersist(assistantCall("browser_type", { ref: "e3", text: SECRET })) as unknown as AnyMsg;
    expect(typed.content[1]?.arguments).toEqual({ ref: "e3", text: `[已隐藏 ${SECRET_LEN} 字符]` });

    for (const [name, args] of [
      ["bash", { command: "ls -la" }],
      ["read", { path: "/tmp/a.txt" }],
      ["desktop_screenshot", {}],
    ] as const) {
      const msg = assistantCall(name, { ...args });
      expect(redactPiMessageForPersist(msg), name).toBe(msg);
    }
  });

  it("toolResult：图片块换成占位文字、文字块保留；原对象不被改", () => {
    const msg = screenshotResult();
    const before = JSON.stringify(msg);
    const out = redactPiMessageForPersist(msg) as unknown as AnyMsg;
    expect(out).not.toBe(msg);
    expect(JSON.stringify(out)).not.toContain(B64);
    expect(out.content[0]).toEqual({ type: "text", text: "截图完成" });
    expect(out.content[1]).toEqual({ type: "text", text: expect.stringMatching(/^\[图片 image\/jpeg · \d+KB 已省略\]$/) });
    expect(JSON.stringify(msg)).toBe(before);
  });

  it("toolResult：没有图片块 / 只有小图（图标）→ 同一引用", () => {
    const plain = toolResult("bash", [{ type: "text", text: "ok" }]);
    expect(redactPiMessageForPersist(plain)).toBe(plain);
    const icon = toolResult("read", [{ type: "image", data: "QUJD".repeat(10), mimeType: "image/png" }]);
    expect(redactPiMessageForPersist(icon)).toBe(icon);
  });

  it("user 消息（含用户自己发的大图）原样——resume 后模型还要看得到", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image", data: B64, mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    expect(redactPiMessageForPersist(msg)).toBe(msg);
  });

  it("幂等：已经脱敏过的消息再来一遍是同一引用；非对象不崩", () => {
    const once = redactPiMessageForPersist(assistantCall("desktop_type", { text: SECRET }));
    expect(redactPiMessageForPersist(once)).toBe(once);
    const shot = redactPiMessageForPersist(screenshotResult());
    expect(redactPiMessageForPersist(shot)).toBe(shot);
    for (const v of [null, undefined, 42, "text", [] as unknown[]]) {
      expect(redactPiMessageForPersist(v)).toBe(v);
    }
  });
});

describe("真实的 pi SessionManager：磁盘上没有明文 / base64", () => {
  const appendAll = (sm: SessionManager, msgs: unknown[]): void => {
    for (const m of msgs) sm.appendMessage(m as never);
  };

  it("create：会话文件里没有明文入参和截图 base64；调用方手里的原消息仍完整（本轮模型照样看得到图）", () => {
    const dir = newDir("create");
    const sm = createPersistedPiSession(TMP, dir);
    const call = assistantCall("desktop_type", { text: SECRET });
    const shot = screenshotResult();
    appendAll(sm, [userMsg(), call, shot]);

    const file = sm.getSessionFile();
    expect(file).toBeTruthy();
    const disk = readFileSync(file!, "utf8");
    expect(disk).not.toContain(SECRET);
    expect(disk).not.toContain(B64);
    expect(disk).toContain(`[已隐藏 ${SECRET_LEN} 字符]`);
    expect(disk).toMatch(/\[图片 image\/jpeg · \d+KB 已省略\]/);
    // 每一行仍是合法 JSON（落盘格式没被破坏）
    for (const line of disk.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();

    // 调用方（= agent-core 的 state）手里那份没被改
    expect((call.content[1] as unknown as { arguments: { text: string } }).arguments.text).toBe(SECRET);
    expect((shot.content[1] as { data: string }).data).toBe(B64);
  });

  it("open（续接）：能读回历史，之后追加的消息同样脱敏", () => {
    const dir = newDir("open");
    const first = createPersistedPiSession(TMP, dir);
    appendAll(first, [userMsg(), assistantCall("desktop_type", { text: SECRET }), screenshotResult()]);
    const file = first.getSessionFile()!;

    const resumed = openPersistedPiSession(file, dir, TMP);
    expect(resumed.buildSessionContext().messages).toHaveLength(3);
    appendAll(resumed, [assistantCall("desktop_type", { text: SECRET2 }, "c2"), screenshotResult()]);

    const disk = readFileSync(file, "utf8");
    expect(disk).not.toContain(SECRET);
    expect(disk).not.toContain(SECRET2);
    expect(disk).not.toContain(B64);
    expect(resumed.buildSessionContext().messages).toHaveLength(5);
  });

  it("redactOnPersist：原地包装并返回同一个实例；appendMessage 照常返回 entry id", () => {
    const sm = SessionManager.inMemory(TMP);
    const wrapped = redactOnPersist(sm);
    expect(wrapped).toBe(sm);
    const id = wrapped.appendMessage(userMsg() as never);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("对照：不包装的 SessionManager 会把明文和 base64 原样写进会话文件——这条红了 = pi 改了写盘行为，包装可以重新评估", () => {
    const dir = newDir("raw");
    const sm = SessionManager.create(TMP, dir);
    appendAll(sm, [userMsg(), assistantCall("desktop_type", { text: SECRET }), screenshotResult()]);
    const disk = readFileSync(sm.getSessionFile()!, "utf8");
    expect(disk).toContain(SECRET);
    expect(disk).toContain(B64);
  });
});

describe("failClosedPiMessage：脱敏出错时落盘的占位骨架（纯函数，自己不会抛）", () => {
  const richAssistant = () => {
    const m = assistantCall("desktop_type", { text: SECRET, submit: true }, "call-77") as Record<string, unknown>;
    (m.content as Array<Record<string, unknown>>)[0] = { type: "text", text: `我这就把 ${SECRET} 输进去` };
    (m.content as Array<Record<string, unknown>>).push({ type: "thinking", thinking: `密码是 ${SECRET}`, thinkingSignature: "sig" });
    m.usage = { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, totalTokens: 40, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
    return m;
  };

  it("assistant：toolCall 只留 id / name（resume 后能和 toolResult 配对），入参 / 文字 / thinking 一律不带；usage 与 stopReason 保留", () => {
    const msg = richAssistant();
    const before = JSON.stringify(msg);
    const out = failClosedPiMessage(msg) as unknown as AnyMsg;
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(out.role).toBe("assistant");
    expect(out.content[0]).toEqual({ type: "text", text: PI_PERSIST_REDACTION_FAILED_TEXT });
    const calls = out.content.filter((b) => b.type === "toolCall");
    expect(calls).toEqual([{ type: "toolCall", id: "call-77", name: "desktop_type", arguments: {} }]);
    expect(out.content.some((b) => b.type === "thinking")).toBe(false);
    expect(out).toMatchObject({
      api: "openai-completions",
      provider: "p",
      model: "m",
      stopReason: "toolUse",
      timestamp: 2,
      usage: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, totalTokens: 40, cost: { total: 10 } },
    });
    expect(JSON.stringify(msg), "入参对象不被改").toBe(before);
  });

  it("assistant：不合法的 stopReason / 缺 usage → 退成合法默认值（落盘格式仍完整）", () => {
    const m = assistantCall("bash", { command: "ls" }) as Record<string, unknown>;
    m.stopReason = "deferred"; // 带这个值需要 deferred 句柄，骨架里没有 → 不保留
    delete m.usage;
    const out = failClosedPiMessage(m) as unknown as Record<string, unknown>;
    expect(out.stopReason).toBe("stop");
    expect(out.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("toolResult：留 toolCallId / toolName / isError，内容（含截图和 details）一律换成占位", () => {
    const msg = {
      ...screenshotResult(),
      toolCallId: "call-77",
      isError: true,
      details: { raw: SECRET },
      content: [
        { type: "text", text: `屏幕上有 ${SECRET}` },
        { type: "image", data: B64, mimeType: "image/png" },
      ],
    };
    const out = failClosedPiMessage(msg) as unknown as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(B64);
    expect(out).toEqual({
      role: "toolResult",
      toolCallId: "call-77",
      toolName: "desktop_screenshot",
      content: [{ type: "text", text: PI_PERSIST_REDACTION_FAILED_TEXT }],
      isError: true,
      timestamp: 3,
    });
  });

  it("其它角色 / 非对象：一条只有占位文字的 user 消息（不带原消息的任何东西）", () => {
    for (const v of [userMsg(SECRET), { role: "custom", customType: "x", content: SECRET }, null, undefined, 42, "text", []]) {
      const out = failClosedPiMessage(v) as unknown as Record<string, unknown>;
      expect(out.role).toBe("user");
      expect(out.content).toEqual([{ type: "text", text: PI_PERSIST_REDACTION_FAILED_TEXT }]);
      expect(typeof out.timestamp).toBe("number");
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
  });

  it("连读属性都会抛的消息（getter / Proxy）：不抛，退成占位", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(`读属性就炸 ${SECRET}`);
        },
        ownKeys() {
          throw new Error("ownKeys 也炸");
        },
        has() {
          throw new Error("has 也炸");
        },
      },
    );
    let out: Record<string, unknown> | undefined;
    expect(() => {
      out = failClosedPiMessage(hostile) as unknown as Record<string, unknown>;
    }).not.toThrow();
    expect(out?.role).toBe("user");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("redactOnPersist：脱敏本身抛错 → fail-closed", () => {
  const warnText = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

  it("redactor 抛错：不抛进调用方；磁盘上没有原文（异常信息里带着原文也不进日志 / 文件）；骨架保留配对信息；之后的消息照常脱敏；文件 resume 得回来", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dir = newDir("fail-closed");
      const sm = createPersistedPiSession(TMP, dir);
      sm.appendMessage(userMsg() as never);

      // 下一次入参脱敏抛错——异常信息里故意带着明文（JSON.parse 的报错就会这样）
      vi.mocked(redactBrowserArgs).mockImplementationOnce(() => {
        throw new SyntaxError(`Unexpected token in "${SECRET}"`);
      });
      const poisoned = assistantCall("desktop_type", { text: SECRET }, "call-1");
      let id = "";
      expect(() => {
        id = sm.appendMessage(poisoned as never);
      }).not.toThrow();
      expect(id.length, "仍返回 entry id").toBeGreaterThan(0);

      // 配对的 toolResult、再来一条正常的 desktop_type（redactor 恢复正常 → 照常脱敏）
      sm.appendMessage(screenshotResult() as never);
      sm.appendMessage(assistantCall("desktop_type", { text: SECRET2 }, "call-2") as never);

      const file = sm.getSessionFile()!;
      const disk = readFileSync(file, "utf8");
      expect(disk).not.toContain(SECRET);
      expect(disk).not.toContain(SECRET2);
      expect(disk).not.toContain(B64);
      expect(disk).toContain(PI_PERSIST_REDACTION_FAILED_TEXT);
      expect(disk, "骨架保留 toolCall 的 id / name，resume 后还能配对").toMatch(/"id":"call-1","name":"desktop_type","arguments":\{\}/);
      expect(disk, "之后的消息走正常脱敏").toContain(`[已隐藏 ${[...SECRET2].length} 字符]`);
      for (const line of disk.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();

      // 日志：只有角色与异常类型，没有异常信息 / 内容
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warnText(warn);
      expect(logged).toContain("role=assistant");
      expect(logged).toContain("SyntaxError");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("Unexpected token");

      // 调用方手里的原消息没被改（本轮模型照样看得到）
      expect((poisoned.content[1] as unknown as { arguments: { text: string } }).arguments.text).toBe(SECRET);

      // 落盘的文件能 resume，且消息条数没丢
      const resumed = openPersistedPiSession(file, dir, TMP);
      expect(resumed.buildSessionContext().messages).toHaveLength(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("getter 会抛的 assistant 消息（真实的畸形对象，不靠 mock）：不抛、磁盘上没有它的内容", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sm = createPersistedPiSession(TMP, newDir("fail-closed-getter"));
      const poisoned = assistantCall("desktop_type", { text: SECRET }, "call-g");
      Object.defineProperty(poisoned.content[1], "arguments", {
        enumerable: true,
        get() {
          throw new Error(`boom ${SECRET}`);
        },
      });
      (poisoned.content[0] as { text: string }).text = `顺便说一句 ${SECRET}`;
      expect(() => sm.appendMessage(poisoned as never)).not.toThrow();
      const disk = readFileSync(sm.getSessionFile()!, "utf8");
      expect(disk).not.toContain(SECRET);
      expect(disk).toContain(PI_PERSIST_REDACTION_FAILED_TEXT);
      expect(warnText(warn)).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it("getter 会抛的 toolResult（图片块读 data 就炸）：不抛、磁盘上没有它旁边的文字", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sm = createPersistedPiSession(TMP, newDir("fail-closed-result"));
      sm.appendMessage(assistantCall("desktop_screenshot", {}, "call-s") as never);
      const hostileImage = { type: "image", mimeType: "image/png" };
      Object.defineProperty(hostileImage, "data", {
        enumerable: true,
        get() {
          throw new Error("读 data 就炸");
        },
      });
      const result = toolResult("desktop_screenshot", [{ type: "text", text: `屏幕上有 ${SECRET}` }, hostileImage], "call-s");
      expect(() => sm.appendMessage(result as never)).not.toThrow();
      const disk = readFileSync(sm.getSessionFile()!, "utf8");
      expect(disk).not.toContain(SECRET);
      expect(disk).toMatch(/"toolCallId":"call-s"/);
      expect(disk).toContain(PI_PERSIST_REDACTION_FAILED_TEXT);
      expect(warnText(warn)).toContain("role=toolResult");
    } finally {
      warn.mockRestore();
    }
  });

  it("没出错时不打日志、不改写（正常路径不受影响）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sm = createPersistedPiSession(TMP, newDir("fail-closed-normal"));
      sm.appendMessage(userMsg() as never);
      sm.appendMessage(assistantCall("desktop_type", { text: SECRET }) as never);
      const disk = readFileSync(sm.getSessionFile()!, "utf8");
      expect(disk).not.toContain(PI_PERSIST_REDACTION_FAILED_TEXT);
      expect(disk).toContain(`[已隐藏 ${SECRET_LEN} 字符]`);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("接线：落盘的 pi 会话都必须走脱敏工厂", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
    }
    return out;
  };
  const codeOf = (file: string): string =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("src 里除了 pi-session-persist.ts 自己，没有人直接 SessionManager.create( / .open(（inMemory 不落盘，不受限）", () => {
    const offenders = walk(path.join(root, "src"))
      .filter((f) => !f.endsWith(`${path.sep}pi-session-persist.ts`))
      .filter((f) => /SessionManager\.(create|open)\(/.test(codeOf(f)))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it("custom-agent-backend 的新建 / 续接两条路径都用了工厂", () => {
    const code = codeOf(path.join(root, "src/lib/server/custom-agent-backend.ts"));
    expect(code).toMatch(/createPersistedPiSession\(/);
    expect(code).toMatch(/openPersistedPiSession\(/);
  });
});
