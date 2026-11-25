/**
 * Windows 解锁组件的命名管道客户端（electron-app/desktop/win-helper/client.mjs）——假 socket + 假 readFile + 虚拟定时器。
 *
 * 钉死的是「怎么把一问一答做对、出错时怎么分类」，每条都对应一个会让用户吃亏的后果：
 * - 管道名来自用户可读的 pipe.txt：格式严格校验，不合法就不连（不能被一个被篡改的文件指到别的管道上去）
 * - 错误分类：没在运行 / 被拒绝（不是登记的账户）/ 回应不对 / 超时 / 取消 / 通信出错——上层据此决定「有没有可能已经输入过密码」
 * - 请求里带着开机密码：任何失败路径的错误消息都不能带出请求内容
 * - 超时、取消、完成之后都要关掉 socket，晚到的数据不能再触发第二次结算
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEOUT_MS, HelperClientError, UNLOCK_TIMEOUT_MS, createHelperClient } from "../electron-app/desktop/win-helper/client.mjs";
import { RESPONSE_CODES } from "../electron-app/desktop/win-helper/protocol.mjs";

const PIPE_NAME = `FlowshipUnlock-${"0123456789abcdef".repeat(2)}`;
const SECRET = "TOP-SECRET-Passw0rd!";

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writeThrows: boolean;
  constructor(writeThrows = false) {
    super();
    this.writeThrows = writeThrows;
  }
  write(data: string | Buffer): boolean {
    if (this.writeThrows) throw new Error(`write failed for ${String(data)}`);
    this.written.push(String(data));
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

type FixtureOpts = { pipeFile?: string | Error; connectThrows?: boolean; writeThrows?: boolean };

const makeFixture = (opts: FixtureOpts = {}) => {
  const socket = new FakeSocket(opts.writeThrows);
  const connect = vi.fn((pipePath: string) => {
    void pipePath;
    if (opts.connectThrows) throw new Error(`connect failed ${SECRET}`);
    return socket;
  });
  const readFile = vi.fn(async (file: string) => {
    void file;
    if (opts.pipeFile instanceof Error) throw opts.pipeFile;
    return opts.pipeFile ?? `${PIPE_NAME}\r\n`;
  });
  const client = createHelperClient({ env: { ProgramData: "C:\\PD" }, readFile, connect: connect as never });
  return { socket, connect, readFile, client };
};

type Fixture = ReturnType<typeof makeFixture>;

/**
 * 发起请求并等到 socket 真的连上（readFile 是异步的）。
 * 返回 { done }：不能直接返回请求的 Promise——async 函数会「采纳」它，调用方就要一直等到请求结算（而结算要等测试之后 emit 事件）。
 */
const start = async (fx: Fixture, verb = "status", fields: Record<string, string> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
  const done = fx.client.request(verb, fields, opts);
  // 先挂上 catch，免得测试里晚一点才断言 reject 时被当成未处理的 rejection
  done.catch(() => {});
  await vi.waitFor(() => expect(fx.connect).toHaveBeenCalled());
  return { done };
};

const OK_STATUS = "FS1\tok\tcode=OK\tproto=1\tver=1\thas=1\tcool=0\tconsole=1\tclient=1\n";

afterEach(() => {
  vi.useRealTimers();
});

describe("一问一答", () => {
  it("连到 \\\\.\\pipe\\<管道名>，连上之后发 FS1 请求行，收到一行回应就结算并关掉 socket", async () => {
    const fx = makeFixture();
    const { done } = await start(fx, "status");
    expect(fx.connect).toHaveBeenCalledWith(`\\\\.\\pipe\\${PIPE_NAME}`);
    expect(fx.socket.written).toEqual([]); // 连上之前不写
    fx.socket.emit("connect");
    expect(fx.socket.written).toEqual(["FS1\tstatus\n"]);
    fx.socket.emit("data", Buffer.from(OK_STATUS));
    await expect(done).resolves.toEqual({ ok: true, code: "OK", fields: { proto: "1", ver: "1", has: "1", cool: "0", console: "1", client: "1" } });
    expect(fx.socket.destroyed).toBe(true);
  });

  it("读的是 ProgramData\\Flowship\\unlock\\public\\pipe.txt", async () => {
    const fx = makeFixture();
    const { done } = await start(fx);
    expect(fx.readFile).toHaveBeenCalledWith("C:\\PD\\Flowship\\unlock\\public\\pipe.txt", "utf8");
    fx.socket.emit("data", Buffer.from(OK_STATUS));
    await done;
  });

  it("回应分几块到达：攒够一整行才解析；一行之后多出来的内容忽略", async () => {
    const fx = makeFixture();
    const { done } = await start(fx, "ping");
    fx.socket.emit("connect");
    fx.socket.emit("data", Buffer.from("FS1\tok\tco"));
    fx.socket.emit("data", Buffer.from("de=PONG\tproto=1\tver=1"));
    expect(fx.socket.destroyed).toBe(false);
    fx.socket.emit("data", Buffer.from("\nGARBAGE-AFTER-NEWLINE"));
    await expect(done).resolves.toMatchObject({ ok: true, code: "PONG", fields: { proto: "1", ver: "1" } });
  });

  it("字段值（含开机密码）按百分号编码写出，请求只有一行", async () => {
    const fx = makeFixture();
    const { done } = await start(fx, "set", { pw: 'a b\t"c"\n' });
    fx.socket.emit("connect");
    expect(fx.socket.written).toEqual(["FS1\tset\tpw=a%20b%09%22c%22%0A\n"]);
    fx.socket.emit("data", Buffer.from("FS1\tok\tcode=OK\n"));
    await done;
  });

  it("组件回的失败（err）照样是正常的响应，不是异常", async () => {
    const fx = makeFixture();
    const { done } = await start(fx, "unlock");
    fx.socket.emit("data", Buffer.from("FS1\terr\tcode=COOLDOWN\tattempted=0\twait=300\n"));
    await expect(done).resolves.toEqual({ ok: false, code: "COOLDOWN", fields: { attempted: "0", wait: "300" } });
  });

  it("完成之后再来的 close / data / error 事件不会二次结算或抛错", async () => {
    const fx = makeFixture();
    const { done } = await start(fx, "ping");
    fx.socket.emit("data", Buffer.from("FS1\tok\tcode=PONG\tproto=1\tver=1\n"));
    await done;
    expect(() => {
      fx.socket.emit("close");
      fx.socket.emit("data", Buffer.from("FS1\terr\tcode=INTERNAL\n"));
      fx.socket.emit("error", Object.assign(new Error("late"), { code: "ECONNRESET" }));
    }).not.toThrow();
  });

  it("ping / status 便捷方法发对应的动词；暴露路径", async () => {
    const fx = makeFixture();
    const p = fx.client.ping();
    await vi.waitFor(() => expect(fx.connect).toHaveBeenCalledTimes(1));
    fx.socket.emit("connect");
    expect(fx.socket.written.at(-1)).toBe("FS1\tping\n");
    fx.socket.emit("data", Buffer.from("FS1\tok\tcode=PONG\tproto=1\tver=1\n"));
    await p;
    expect(fx.client.paths.pipeFile).toBe("C:\\PD\\Flowship\\unlock\\public\\pipe.txt");
    const s = makeFixture();
    const sp = s.client.status();
    await vi.waitFor(() => expect(s.connect).toHaveBeenCalledTimes(1));
    s.socket.emit("connect");
    expect(s.socket.written.at(-1)).toBe("FS1\tstatus\n");
    s.socket.emit("data", Buffer.from(OK_STATUS));
    await sp;
  });
});

describe("管道名：严格校验，不合法就不连", () => {
  const bad: Array<[string, string]> = [
    ["指向别的管道", "..\\..\\evil"],
    ["带路径分隔符的前缀", `x\\${PIPE_NAME}`],
    ["大写十六进制", `FlowshipUnlock-${"0123456789ABCDEF".repeat(2)}`],
    ["太短", "FlowshipUnlock-abc"],
    ["太长", `${PIPE_NAME}0`],
    ["前缀不对", `OtherPipe-${"0".repeat(32)}`],
    ["文件内容有第二行（注入另一个名字）", `${PIPE_NAME}\n\\\\.\\pipe\\evil`],
    ["空", ""],
    ["只有空白", "  \r\n "],
  ];
  for (const [label, content] of bad) {
    it(`${label}：NOT_RUNNING，且不尝试连接`, async () => {
      const fx = makeFixture({ pipeFile: content });
      await expect(fx.client.request("status")).rejects.toMatchObject({ name: "HelperClientError", code: "NOT_RUNNING" });
      expect(fx.connect).not.toHaveBeenCalled();
    });
  }

  for (const [label, content] of [
    ["前后有空白 / 换行", `  ${PIPE_NAME} \r\n`],
    ["开头带 BOM（有的编辑器 / 脚本会写）", `\uFEFF${PIPE_NAME}\n`],
  ] as const) {
    it(`合法名字，${label}：去掉空白后照常连`, async () => {
      const fx = makeFixture({ pipeFile: content });
      const { done } = await start(fx);
      expect(fx.connect).toHaveBeenCalledWith(`\\\\.\\pipe\\${PIPE_NAME}`);
      fx.socket.emit("data", Buffer.from(OK_STATUS));
      await done;
    });
  }

  it("读不到 pipe.txt（组件没装 / 没在运行）：NOT_RUNNING", async () => {
    const fx = makeFixture({ pipeFile: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
    await expect(fx.client.request("status")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    expect(fx.connect).not.toHaveBeenCalled();
  });
});

describe("错误分类", () => {
  /** 让 socket 以给定的 errno 出错 */
  const failWith = async (code: string | undefined) => {
    const fx = makeFixture();
    const { done } = await start(fx);
    fx.socket.emit("error", Object.assign(new Error(`socket error ${SECRET}`), code ? { code } : {}));
    return { fx, done };
  };

  it("EACCES / EPERM：DENIED（不是安装时登记的账户），文案就是 RESPONSE_CODES.DENIED", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const { done } = await failWith(code);
      await expect(done).rejects.toMatchObject({ code: "DENIED", message: RESPONSE_CODES.DENIED });
    }
  });

  it("ENOENT / ECONNREFUSED / EPIPE：NOT_RUNNING", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED", "EPIPE"]) {
      const { done } = await failWith(code);
      await expect(done).rejects.toMatchObject({ code: "NOT_RUNNING" });
    }
  });

  it("其它错误：IO，消息里只带错误码、不带原始消息", async () => {
    const { done } = await failWith("ECONNRESET");
    const err = (await done.then(
      () => null,
      (e: unknown) => e,
    )) as HelperClientError;
    expect(err).toBeInstanceOf(HelperClientError);
    expect(err.code).toBe("IO");
    expect(err.message).toContain("ECONNRESET");
    expect(err.message).not.toContain(SECRET);
    const { done: noCode } = await failWith(undefined);
    await expect(noCode).rejects.toMatchObject({ code: "IO", message: expect.stringContaining("未知") });
  });

  it("没收到回应就断开：BAD_RESPONSE", async () => {
    const fx = makeFixture();
    const { done } = await start(fx);
    fx.socket.emit("close");
    await expect(done).rejects.toMatchObject({ code: "BAD_RESPONSE", message: expect.stringContaining("断开") });
  });

  it("回应看不懂（不是 FS1 格式）：BAD_RESPONSE，并关掉 socket", async () => {
    const fx = makeFixture();
    const { done } = await start(fx);
    fx.socket.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
    await expect(done).rejects.toMatchObject({ code: "BAD_RESPONSE", message: expect.stringContaining("看不懂") });
    expect(fx.socket.destroyed).toBe(true);
  });

  it("回应超长（8KB 还没有换行）：BAD_RESPONSE，不继续攒", async () => {
    const fx = makeFixture();
    const { done } = await start(fx);
    fx.socket.emit("data", Buffer.alloc(9000, 0x61));
    await expect(done).rejects.toMatchObject({ code: "BAD_RESPONSE", message: expect.stringContaining("太长") });
  });

  it("connect 本身抛异常：NOT_RUNNING；写请求抛异常：IO", async () => {
    const a = makeFixture({ connectThrows: true });
    await expect(a.client.request("status")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    const b = makeFixture({ writeThrows: true });
    const { done } = await start(b, "set", { pw: SECRET });
    b.socket.emit("connect");
    await expect(done).rejects.toMatchObject({ code: "IO" });
  });

  it("任何失败路径的错误消息都不带请求内容（开机密码）", async () => {
    const messages: string[] = [];
    const collect = (e: unknown) => {
      messages.push(String((e as Error).message));
    };

    // 超时（虚拟定时器）
    vi.useFakeTimers();
    const t = makeFixture();
    const timedOut = t.client.request("set", { pw: SECRET }, { timeoutMs: 1000 }).catch(collect);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await timedOut;
    vi.useRealTimers();

    // socket 出错（被拒绝 / 其它）/ 断开 / 乱回应
    for (const code of ["EACCES", "EOTHER"]) {
      const fx = makeFixture();
      const { done } = await start(fx, "set", { pw: SECRET });
      fx.socket.emit("error", Object.assign(new Error(SECRET), { code }));
      await done.catch(collect);
    }
    {
      const fx = makeFixture();
      const { done } = await start(fx, "set", { pw: SECRET });
      fx.socket.emit("close");
      await done.catch(collect);
    }
    {
      const fx = makeFixture();
      const { done } = await start(fx, "set", { pw: SECRET });
      fx.socket.emit("data", Buffer.from(`garbage ${SECRET}\n`));
      await done.catch(collect);
    }
    // 写失败
    {
      const fx = makeFixture({ writeThrows: true });
      const { done } = await start(fx, "set", { pw: SECRET });
      fx.socket.emit("connect");
      await done.catch(collect);
    }
    // connect 抛 / pipe.txt 读不到
    await makeFixture({ connectThrows: true }).client.request("set", { pw: SECRET }).catch(collect);
    await makeFixture({ pipeFile: new Error(SECRET) }).client.request("set", { pw: SECRET }).catch(collect);

    expect(messages.length).toBe(8);
    for (const m of messages) expect(m).not.toContain(SECRET);
  });
});

describe("超时", () => {
  it("默认 8 秒；unlock 用更长的 100 秒（比组件的 90 秒连接看门狗还长一点，让组件先给出结论）", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
    expect(UNLOCK_TIMEOUT_MS).toBe(100_000);
  });

  it("到点 TIMEOUT：关掉 socket；之后晚到的回应不再结算", async () => {
    vi.useFakeTimers();
    const fx = makeFixture();
    const p = fx.client.request("status", {}, { timeoutMs: 5000 });
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("5 秒") });
    await vi.advanceTimersByTimeAsync(0);
    expect(fx.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fx.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fx.socket.destroyed).toBe(true);
    expect(() => fx.socket.emit("data", Buffer.from(OK_STATUS))).not.toThrow();
  });

  it("不传 timeoutMs 用默认值", async () => {
    vi.useFakeTimers();
    const fx = makeFixture();
    const p = fx.client.request("ping");
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(fx.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("按时完成就不会再触发超时、也不留定时器", async () => {
    vi.useFakeTimers();
    const fx = makeFixture();
    const p = fx.client.request("ping", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    fx.socket.emit("data", Buffer.from("FS1\tok\tcode=PONG\tproto=1\tver=1\n"));
    await expect(p).resolves.toMatchObject({ code: "PONG" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("取消（AbortSignal）", () => {
  it("请求之前就已取消：ABORTED，不读文件、不连接", async () => {
    const fx = makeFixture();
    const ac = new AbortController();
    ac.abort();
    await expect(fx.client.request("status", {}, { signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(fx.readFile).not.toHaveBeenCalled();
    expect(fx.connect).not.toHaveBeenCalled();
  });

  it("读 pipe.txt 期间取消：ABORTED，不连接", async () => {
    const ac = new AbortController();
    const connect = vi.fn(() => new FakeSocket());
    const readFile = vi.fn(async () => {
      ac.abort(); // 在读文件的过程中被取消
      return PIPE_NAME;
    });
    const client = createHelperClient({ env: {}, readFile, connect: connect as never });
    await expect(client.request("status", {}, { signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("等回应期间取消：ABORTED，关掉 socket，监听器被摘掉", async () => {
    const fx = makeFixture();
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const { done } = await start(fx, "status", {}, { signal: ac.signal });
    ac.abort();
    await expect(done).rejects.toMatchObject({ code: "ABORTED" });
    expect(fx.socket.destroyed).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("正常完成后也会摘掉 abort 监听器（不泄漏）", async () => {
    const fx = makeFixture();
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const { done } = await start(fx, "ping", {}, { signal: ac.signal });
    fx.socket.emit("data", Buffer.from("FS1\tok\tcode=PONG\tproto=1\tver=1\n"));
    await done;
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("参数错误是代码 bug：原样抛、不连接、不带字段值", () => {
  it("未知动词 / 非法字段名", async () => {
    const fx = makeFixture();
    await expect(fx.client.request("rm-rf")).rejects.toThrow(/未知的组件动词/);
    await expect(fx.client.request("set", { PW: SECRET })).rejects.toThrow(/非法的字段名/);
    expect(fx.readFile).not.toHaveBeenCalled();
    expect(fx.connect).not.toHaveBeenCalled();
    const err = await fx.client.request("set", { PW: SECRET }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SECRET);
  });
});
