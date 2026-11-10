/**
 * e2e 启动器（scripts/browser-e2e/run.mjs）的回归测试。
 *
 * 事故（2026-11-07）：无头 Electron e2e 脚本里有语法错误，Electron 弹了原生模态错误框并挂住等人点「好」，
 * 弹在用户屏幕上。启动器的第一道防线是 `node --check` 预检——语法错误只在终端报、根本不起 Electron。
 * 这里只测不依赖 Electron 的部分（预检、env 清洗、参数解析、「语法错误时不拉起 Electron」的端到端行为）；
 * bootstrap 兜住运行期异常 / dialog 的行为要真起 Electron，在 scripts/browser-e2e 里手动验证。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HOST_INJECTED_ENV_KEYS,
  checkSyntax,
  cleanEnv,
  parseArgs,
} from "../scripts/browser-e2e/launcher-lib.mjs";

const RUN = path.resolve(import.meta.dirname, "../scripts/browser-e2e/run.mjs");

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-e2e-launcher-test-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

/** 截图里那条语法错误的原样复现：表达式中间塞了 `console.log(...);` */
const BROKEN = `const send = async () => ({});
let id;
(async () => {
  id = (console.log("stage"); await send("x")).frameTree.frame.id;
})();
`;

describe("checkSyntax（启动 Electron 之前的语法预检）", () => {
  it("合法脚本放行", () => {
    expect(checkSyntax(write("ok.cjs", "const a = 1; module.exports = a;\n"))).toEqual({ ok: true });
  });

  it("截图里的语法错误被拦下，并带上行号与错误原文", () => {
    const r = checkSyntax(write("broken.cjs", BROKEN));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("SyntaxError");
    expect(r.message).toContain("broken.cjs:4");
  });

  it(".mjs 按 ESM 预检（顶层 await 合法）", () => {
    expect(checkSyntax(write("top.mjs", "await Promise.resolve(1);\n")).ok).toBe(true);
  });
});

describe("cleanEnv", () => {
  it("剔除宿主注入的变量、保留其它、不改入参", () => {
    // Next 的类型声明把 ProcessEnv.NODE_ENV 变成了必填，字面量对象凑不齐；这里只关心键的剔除，在调用边界断言一次
    const input: Record<string, string> = { KEEP: "1", PATH: "/usr/bin" };
    for (const k of HOST_INJECTED_ENV_KEYS) input[k] = "x";
    const out = cleanEnv(input as NodeJS.ProcessEnv);
    for (const k of HOST_INJECTED_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out.KEEP).toBe("1");
    expect(out.PATH).toBe("/usr/bin");
    expect(input.ELECTRON_RUN_AS_NODE).toBe("x");
  });

  it("名单覆盖 AGENTS.md 要求清洗的全部变量", () => {
    expect([...HOST_INJECTED_ENV_KEYS].sort()).toEqual(
      [
        "ELECTRON_RUN_AS_NODE",
        "FLOWSHIP_DATA_DIR",
        "FLOWSHIP_PORT",
        "PORT",
        "HOSTNAME",
        "__NEXT_PRIVATE_STANDALONE_CONFIG",
        "__NEXT_PRIVATE_ORIGIN",
        "NEXT_DEPLOYMENT_ID",
      ].sort(),
    );
  });
});

describe("parseArgs", () => {
  it("脚本 + 超时 + 透传参数", () => {
    expect(parseArgs(["a.cjs", "--timeout", "30", "--", "x", "--y"])).toEqual({
      script: "a.cjs",
      timeoutSec: 30,
      forward: ["x", "--y"],
    });
  });

  it("缺脚本 / 坏超时 / 未知 flag / 多余位置参数都报错，不悄悄吞掉", () => {
    expect(parseArgs([]).error).toContain("用法");
    expect(parseArgs(["a.cjs", "--timeout", "abc"]).error).toContain("--timeout");
    expect(parseArgs(["a.cjs", "--timeot", "3"]).error).toContain("未知参数");
    expect(parseArgs(["a.cjs", "b.cjs"]).error).toContain("多余的参数");
  });
});

describe("run.mjs 端到端（不依赖 Electron）", () => {
  it("语法错误：退出码 2、终端报错、秒退——Electron 若被拉起会挂在原生弹窗上、撑到超时", () => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [RUN, write("broken2.cjs", BROKEN), "--timeout", "60"], {
      encoding: "utf8",
      env: cleanEnv(),
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("语法错误");
    expect(r.stderr).toContain("未启动 Electron");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("脚本不存在：退出码 2", () => {
    const r = spawnSync(process.execPath, [RUN, path.join(dir, "nope.cjs")], {
      encoding: "utf8",
      env: cleanEnv(),
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("找不到脚本");
  });
});

describe("electron-bootstrap：e2e 不碰系统钥匙串（2026-11-07 反复弹「找不到 Electron Key 的钥匙串」）", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/browser-e2e/electron-bootstrap.cjs"), "utf8");

  it("加载目标脚本之前就设了 use-mock-keychain（app ready 之后再设就晚了）", () => {
    const sw = src.indexOf('appendSwitch("use-mock-keychain")');
    expect(sw).toBeGreaterThan(-1);
    expect(sw).toBeLessThan(src.indexOf("require(path.resolve(target))"));
    expect(sw).toBeLessThan(src.indexOf("whenReady") === -1 ? Infinity : src.indexOf("whenReady"));
  });

  it("linux 走 password-store=basic（不触发 libsecret / kwallet 弹窗）", () => {
    expect(src).toMatch(/platform === "linux"\)\s*app\.commandLine\.appendSwitch\("password-store", "basic"\)/);
  });
});
