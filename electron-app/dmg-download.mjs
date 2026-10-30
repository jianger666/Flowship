/**
 * 把 fetch 的响应体流式写到磁盘（R14 B2-4 / Q15-01）。只依赖 node:stream，无 electron 依赖，可被 vitest 直接单测。
 *
 * 为什么用 stream.pipeline 而不是手写的 `for await (chunk of body) { if (!ws.write(chunk)) await once(ws, "drain") }`：
 * 手写那一版对「写盘失败」有两个洞——
 *   1. 目的流没有 `error` 监听：磁盘满 / 权限被收 / 目录被删时 fs.WriteStream 异步 emit 'error'，没人接 → 主进程
 *      uncaughtException（弹 "A JavaScript error occurred in the main process"）；
 *   2. 流出错被销毁后 `ws.write()` 恒返回 false、'drain' 永不触发 → `await once("drain")` 永远挂住，
 *      调用方的 stagingPromise 永不 settle（单飞锁永不释放），页面徽标一直停在「下载中」直到重启 App。
 * pipeline 把「响应体 → 进度统计 → 目的流」串成一条链：任一端出错（写盘失败 / 网络断流 / 进度回调抛错）都会 reject，
 * 并销毁链上所有流（含目的流、取消响应体），背压也由它负责。
 *
 * 取消路径：目前没有（UI 没有取消按钮；退出 App = 进程终止，半截 dmg 由启动清扫兜底，见 main.js「启动清扫」）。
 * 将来要加取消按钮时，给 pipeline 传 `{ signal }` 即可，不用改下面的结构。
 */
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** fetch 的 `res.body` 是 Web ReadableStream（有 getReader）；测试替身常用 async generator。 */
const isWebStream = (body) => typeof body?.getReader === "function";

/** 响应体还没人读就要放弃时（例如目的流建不出来），别让连接挂着：尽力取消、吞掉清理本身的错误。 */
const cancelBody = async (body) => {
  try {
    if (typeof body?.cancel === "function") await body.cancel();
    else if (typeof body?.return === "function") await body.return();
  } catch {
    /* 清理尽力而为 */
  }
};

/**
 * @param {object} p
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>} p.body fetch 的 res.body（也接受 async iterable）
 * @param {string} p.dest 目标文件路径
 * @param {(dest: string) => import("node:stream").Writable} p.createWriteStream 可注入（主进程传 node:fs 的）
 * @param {(received: number) => void} [p.onProgress] 每收到一块之后调用，参数是**累计**字节数。
 *   它抛出的异常算下载失败（与改前 for-await 里抛出同语义）——进度回调该自己兜好展示层的异常。
 * @returns {Promise<number>} 实际写出的字节数（完整性校验——对比 content-length——由调用方做）
 */
export const streamResponseToFile = async ({ body, dest, createWriteStream, onProgress }) => {
  let ws;
  try {
    ws = createWriteStream(dest);
  } catch (err) {
    await cancelBody(body);
    throw err;
  }
  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      try {
        onProgress?.(received);
      } catch (err) {
        cb(err);
        return;
      }
      cb(null, chunk);
    },
  });
  const source = isWebStream(body) ? Readable.fromWeb(body) : Readable.from(body);
  await pipeline(source, counter, ws);
  return received;
};
