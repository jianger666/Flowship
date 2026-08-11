/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
/**
 * ssh2 mock preload：`node --require <本文件> scripts/ssh-exec.mjs …`
 * 拦截 require('ssh2') 返回 fake，避免 CLI 走真实 ssh2。
 */
const Module = require("node:module");
const path = require("node:path");

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "ssh2") {
    return require(path.join(__dirname, "ssh2-fake.cjs"));
  }
  return origLoad.apply(this, arguments);
};
