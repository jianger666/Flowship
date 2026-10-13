/**
 * 启动文件录制器（`node --require` 预加载，仅 scripts/gen-boot-manifest.mjs 使用，绝不进运行时）。
 *
 * 作用：server 冷启动期间读了哪些文件，按首次访问顺序记下来，供壳在 Windows 首次启动时并行预读。
 * 两路来源互补：
 *   1. 打补丁拦截 fs 的「按路径打开 / 读取」入口（readFileSync / openSync / readFile / open / createReadStream、
 *      以及 fs.promises.readFile / open）——覆盖 JSON、静态资源、CJS 模块（Node 的 CJS 加载器走的就是 fs.readFileSync）；
 *   2. 退出 / 定时落盘时合并 `require('module')._cache` 的键——兜住被早期捕获了 fs 引用而漏掉的 CJS 模块。
 * 已知覆盖不到：原生 ESM loader 内部捕获的读取（本项目 server 启动期不走它）。漏记只是少预读几个文件，无副作用。
 *
 * 落盘走「定时 + exit」而不是信号：Windows 上 child.kill() 是 TerminateProcess、不会触发任何处理函数。
 * 用的是补丁前保存下来的原始 writeFileSync，不会把自己的写入录进去。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const Module = require("node:module");

const out = process.env.FLOWSHIP_BOOT_TRACE_OUT;
if (out) {
  const originalWriteFileSync = fs.writeFileSync;
  const seen = new Map();
  let dirty = false;

  const record = (p) => {
    let s = null;
    if (typeof p === "string") s = p;
    else if (p instanceof URL) s = p.protocol === "file:" ? fileURLToPath(p) : null;
    else if (Buffer.isBuffer(p)) s = p.toString();
    if (!s) return;
    if (!path.isAbsolute(s)) s = path.resolve(s);
    if (!seen.has(s)) {
      seen.set(s, seen.size);
      dirty = true;
    }
  };

  const wrap = (target, name) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function patched(p, ...rest) {
      try {
        record(p);
      } catch {
        // 录制失败绝不影响被录制的进程
      }
      return original.call(this, p, ...rest);
    };
  };

  for (const name of ["readFileSync", "openSync", "readFile", "open", "createReadStream"]) {
    wrap(fs, name);
  }
  for (const name of ["readFile", "open"]) wrap(fs.promises, name);

  const flush = () => {
    try {
      const files = [...seen.keys()];
      const known = new Set(files);
      for (const key of Object.keys(Module._cache)) {
        if (!known.has(key)) files.push(key);
      }
      originalWriteFileSync(out, JSON.stringify({ files }));
      dirty = false;
    } catch {
      // 落盘失败下一轮再试
    }
  };

  const timer = setInterval(() => {
    if (dirty) flush();
  }, 300);
  timer.unref();
  process.on("exit", flush);
}
