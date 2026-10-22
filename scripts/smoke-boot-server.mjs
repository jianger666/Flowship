#!/usr/bin/env node
/**
 * 发版冒烟：把组好的 server 布局（dist/app-server）真启动一次，起不来 / 首页渲不出 / 静态资源缺失就红。
 *
 * 为什么要有：发版链原先没有任何一步把打出来的 server 真跑一下（`finalize` 还会自动转正 draft），
 * 仓库自己记过多起「只在打包产物里复现」的事故——单测 / typecheck / `next build` 全绿，
 * 装上才发现 server 起不来（缺依赖、standalone 没带 `.next/static`、平台包缺失…）。
 * 本脚本和壳判定就绪走同一条路径（`/api/readyz`），再多验两件壳之后立刻会碰的事：
 *   1. `/`（首页 SSR）能 200 且是 HTML；
 *   2. 首页 HTML 引用的 `/_next/static/*` 资源能 200（standalone 最常漏拷的就是它）。
 *
 * 用法：
 *   node scripts/smoke-boot-server.mjs --server-dir dist/app-server
 *   node scripts/smoke-boot-server.mjs --server-dir <dir> [--node <node 可执行文件>] [--run-as-node] [--timeout-ms 90000]
 *
 * 做法与 scripts/gen-boot-manifest.mjs 同源：临时数据目录 + 随机端口 + 清洗环境（不继承宿主注入的
 * PORT / FLOWSHIP_DATA_DIR / __NEXT_PRIVATE_* 等，见 AGENTS.md「agent shell 环境坑」）。
 * 只用 Node 内置模块，可跨平台跑；成功 exit 0、任一检查失败 exit 1（stderr 带 server 输出尾部）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { extractStaticAssetUrls } from "./lib/boot-manifest.mjs";

/** 最多抽查几个静态资源（首页通常引用几十个，抽前几个足以发现「整个目录没拷」） */
const MAX_ASSET_CHECKS = 5;

const parseArgs = (argv) => {
  const args = { timeoutMs: 90_000, runAsNode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server-dir") args.serverDir = argv[++i];
    else if (a === "--node") args.node = argv[++i];
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (a === "--run-as-node") args.runAsNode = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (!args.serverDir) throw new Error("缺少 --server-dir");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms 必须是正数");
  }
  return args;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const serverDir = path.resolve(args.serverDir);
  if (!existsSync(path.join(serverDir, "server.js"))) {
    throw new Error(`没找到 ${path.join(serverDir, "server.js")}`);
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "flowship-smoke-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: tmp,
    USERPROFILE: tmp,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(args.runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    FLOWSHIP_DATA_DIR: path.join(tmp, "data"),
  };

  const child = spawn(args.node ?? process.execPath, ["server.js"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputTail = "";
  const keepTail = (d) => {
    outputTail = (outputTail + d.toString()).slice(-3000);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const cleanup = () => {
    if (!exited) child.kill();
    rmSync(tmp, { recursive: true, force: true });
  };

  const fail = (msg) => {
    const err = new Error(msg);
    err.outputTail = outputTail;
    return err;
  };

  try {
    // 1) 就绪：和壳的 waitForReady 同一个探针
    const deadline = Date.now() + args.timeoutMs;
    let ready = false;
    while (Date.now() < deadline && !exited) {
      try {
        const r = await get(`${base}/api/readyz`, 2000);
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(300);
    }
    if (!ready) {
      throw fail(
        exited
          ? `server 启动后提前退出（exit code=${exitCode}）`
          : `server 在 ${args.timeoutMs}ms 内没就绪（/api/readyz 一直不是 200）`,
      );
    }

    // 2) 首页 SSR
    const home = await get(`${base}/`, 60_000);
    if (home.status !== 200) {
      throw fail(`GET / 返回 ${home.status}（期望 200）`);
    }
    if (!/<html[\s>]/i.test(home.body)) {
      throw fail("GET / 的响应不是 HTML（没有 <html>）");
    }

    // 3) 静态资源（standalone 最常漏拷 .next/static）
    const assets = extractStaticAssetUrls(home.body, MAX_ASSET_CHECKS);
    if (assets.length === 0) {
      throw fail("首页 HTML 里没找到任何 /_next/static 资源引用（构建产物异常？）");
    }
    for (const url of assets) {
      const r = await get(`${base}${url}`, 15_000);
      if (r.status !== 200) {
        throw fail(`静态资源 ${url} 返回 ${r.status}（期望 200；standalone 是否漏拷 .next/static？）`);
      }
    }

    console.log(
      `smoke-boot-server：OK（readyz 200、首页 200、静态资源 ${assets.length} 个均 200）@ ${serverDir}`,
    );
  } finally {
    cleanup();
  }
};

main().catch((err) => {
  console.error(`smoke-boot-server 失败：${err?.message ?? err}`);
  if (err?.outputTail) {
    console.error(`--- server 输出尾部 ---\n${err.outputTail}\n--- end ---`);
  }
  process.exit(1);
});
