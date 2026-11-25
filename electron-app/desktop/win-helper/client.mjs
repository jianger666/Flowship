/**
 * Windows 解锁组件的命名管道客户端：读 pipe.txt 拿管道名 → 连上 → 发一行 → 收一行 → 关。
 *
 * 组件的协议就是一问一答，所以每个请求一条连接，没有长连接状态要维护。
 * 管道名每次组件启动都会换（随机），写在普通用户可读的 public\pipe.txt 里；读不到 / 格式不对 = 组件没在运行。
 * 谁能连上由组件那头的管道权限决定（只有安装时登记的那个 Windows 账户），连不上的错误区分成「没在运行」和「被拒绝」。
 *
 * 依赖（读文件 / 连管道）可注入，单测用假 socket；真实环境是 node:net 连 \\.\pipe\<名字>。
 * 请求内容（含开机密码）绝不进错误消息 / 日志。
 */
import fs from "node:fs";
import net from "node:net";

import { RESPONSE_CODES, encodeRequest, helperPaths, parseResponse } from "./protocol.mjs";

/** 普通请求（ping / status / set / clear / check）的超时 */
export const DEFAULT_TIMEOUT_MS = 8_000;
/** unlock 的超时：组件那头 typist 最长 40 秒、连接看门狗 90 秒，这里略长一点，让组件自己先给出结论 */
export const UNLOCK_TIMEOUT_MS = 100_000;

const PIPE_NAME_RE = /^FlowshipUnlock-[0-9a-f]{32}$/;
const MAX_RESPONSE_BYTES = 8192;

export class HelperClientError extends Error {
  /**
   * @param {"NOT_RUNNING" | "DENIED" | "BAD_RESPONSE" | "TIMEOUT" | "ABORTED" | "IO"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HelperClientError";
    this.code = code;
  }
}

/**
 * @typedef {{ ok: boolean, code: string, fields: Record<string, string> }} HelperResponse
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   readFile?: (file: string, encoding: "utf8") => Promise<string>,
 *   connect?: (pipePath: string) => import("node:net").Socket,
 * }} [deps]
 */
export const createHelperClient = (deps = {}) => {
  const { env = process.env, readFile = (file, encoding) => fs.promises.readFile(file, encoding), connect = (pipePath) => net.connect(pipePath) } = deps;
  const paths = helperPaths(env);

  const readPipeName = async () => {
    let raw;
    try {
      raw = await readFile(paths.pipeFile, "utf8");
    } catch {
      throw new HelperClientError("NOT_RUNNING", "解锁组件没有在运行（读不到它的管道名）");
    }
    const name = String(raw).trim();
    if (!PIPE_NAME_RE.test(name)) throw new HelperClientError("NOT_RUNNING", "解锁组件登记的管道名不合法，可能组件没有正常启动");
    return name;
  };

  /**
   * 发一条请求，等一条响应。
   * @param {string} verb
   * @param {Record<string, string>} [fields]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<HelperResponse>}
   */
  const request = async (verb, fields = {}, opts = {}) => {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
    // 先编码：动词 / 字段名写错是代码 bug，直接抛（不会带出字段值）
    const line = encodeRequest(verb, fields);
    if (signal?.aborted) throw new HelperClientError("ABORTED", "已取消");
    const name = await readPipeName();
    if (signal?.aborted) throw new HelperClientError("ABORTED", "已取消");

    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let received = Buffer.alloc(0);
      /** @type {import("node:net").Socket | null} */
      let socket = null;

      const onAbort = () => finish(new HelperClientError("ABORTED", "已取消"));
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          socket?.destroy();
        } catch {
          /* 已经关了 */
        }
        if (err) reject(err);
        else resolve(value);
      };

      timer = setTimeout(() => finish(new HelperClientError("TIMEOUT", `解锁组件超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        socket = connect(`\\\\.\\pipe\\${name}`);
      } catch {
        finish(new HelperClientError("NOT_RUNNING", "连不上解锁组件的管道"));
        return;
      }

      socket.on("connect", () => {
        try {
          socket?.write(line);
        } catch {
          finish(new HelperClientError("IO", "往解锁组件写请求时失败"));
        }
      });
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > MAX_RESPONSE_BYTES) {
          finish(new HelperClientError("BAD_RESPONSE", "解锁组件的回应太长，不像是它发的"));
          return;
        }
        const nl = received.indexOf(0x0a);
        if (nl < 0) return;
        const resp = parseResponse(received.subarray(0, nl).toString("utf8"));
        if (!resp) finish(new HelperClientError("BAD_RESPONSE", "解锁组件回了看不懂的东西（版本不一致？）"));
        else finish(null, resp);
      });
      socket.on("error", (err) => {
        const errCode = /** @type {NodeJS.ErrnoException} */ (err)?.code;
        if (errCode === "EACCES" || errCode === "EPERM") finish(new HelperClientError("DENIED", RESPONSE_CODES.DENIED));
        else if (errCode === "ENOENT" || errCode === "ECONNREFUSED" || errCode === "EPIPE") finish(new HelperClientError("NOT_RUNNING", "解锁组件没有在运行（连不上它的管道）"));
        else finish(new HelperClientError("IO", `和解锁组件通信出错（${String(errCode ?? "未知")}）`));
      });
      socket.on("close", () => finish(new HelperClientError("BAD_RESPONSE", "解锁组件没有回应就断开了连接")));
    });
  };

  return {
    request,
    ping: (opts) => request("ping", {}, opts),
    status: (opts) => request("status", {}, opts),
    paths,
  };
};
