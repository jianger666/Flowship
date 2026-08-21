/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
/**
 * pg mock preload：`node --require <本文件> scripts/pg-exec.mjs …`
 * 拦截 require('pg') 返回 fake，避免 CLI 走真实网络。
 */
const Module = require("node:module");
const path = require("node:path");

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "pg") {
    return require(path.join(__dirname, "pg-fake.cjs"));
  }
  return origLoad.apply(this, arguments);
};
