/**
 * 防后台节流实验开关（electron-app/app-nap.mjs + main.js 接线契约）
 *
 * 钉死的语义：
 * - 默认关：没有任何配置时行为与原来完全一致（backgroundThrottling 保持 Electron 默认 true）
 * - 环境变量显式值优先于标记文件；拼写错误当作没设（不能因为手滑打成 "true" 就悄悄开启 / 关闭）
 * - main.js 接线：渲染进程节流开关 / powerSaveBlocker 只在开启时生效；状态传给 server 子进程供 A/B 对比
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_NAP_ENV,
  APP_NAP_MARKER,
  resolveAppNapMode,
} from "../electron-app/app-nap.mjs";

const main = readFileSync(
  path.resolve(import.meta.dirname, "..", "electron-app/main.js"),
  "utf8",
);

describe("resolveAppNapMode（纯函数）", () => {
  it("默认关：无环境变量、无标记文件", () => {
    expect(resolveAppNapMode({}, false)).toEqual({ enabled: false, source: "default" });
    expect(resolveAppNapMode(undefined, false)).toEqual({ enabled: false, source: "default" });
  });

  it("标记文件存在 → 开（source=marker）", () => {
    expect(resolveAppNapMode({}, true)).toEqual({ enabled: true, source: "marker" });
  });

  it("环境变量 =1 → 开（source=env），无标记也行", () => {
    expect(resolveAppNapMode({ [APP_NAP_ENV]: "1" }, false)).toEqual({ enabled: true, source: "env" });
  });

  it("环境变量 =0 强制关，压过标记文件", () => {
    expect(resolveAppNapMode({ [APP_NAP_ENV]: "0" }, true)).toEqual({ enabled: false, source: "env" });
  });

  it("首尾空白容忍", () => {
    expect(resolveAppNapMode({ [APP_NAP_ENV]: " 1 " }, false).enabled).toBe(true);
    expect(resolveAppNapMode({ [APP_NAP_ENV]: " 0\n" }, true).enabled).toBe(false);
  });

  it("拼写错误 / 其他值（true / yes / on / 2 / 空串）当作没设：看标记文件", () => {
    for (const bad of ["true", "yes", "on", "2", "", "enable"]) {
      expect(resolveAppNapMode({ [APP_NAP_ENV]: bad }, false), bad).toEqual({ enabled: false, source: "default" });
      expect(resolveAppNapMode({ [APP_NAP_ENV]: bad }, true), bad).toEqual({ enabled: true, source: "marker" });
    }
  });

  it("常量不被悄悄改名（文档 / 用户操作步骤依赖它们）", () => {
    expect(APP_NAP_ENV).toBe("FLOWSHIP_PREVENT_APP_NAP");
    expect(APP_NAP_MARKER).toBe("PREVENT_APP_NAP");
  });
});

describe("main.js 接线契约", () => {
  it("引入开关模块与 powerSaveBlocker", () => {
    expect(main).toContain('from "./app-nap.mjs"');
    expect(main).toMatch(/\bpowerSaveBlocker,/);
  });

  it("渲染进程节流开关由实验开关决定（默认关 = Electron 默认的 true）", () => {
    expect(main).toContain("backgroundThrottling: !getAppNapMode().enabled");
  });

  it("powerSaveBlocker 只在开启分支启动（关闭时早返回在前）、且用 prevent-app-suspension", () => {
    expect(main).toMatch(
      /if \(!mode\.enabled\) \{[\s\S]*?return;\s*\}[\s\S]*?powerSaveBlocker\.start\("prevent-app-suspension"\)/,
    );
    // 全文只有这一处 start——不会有别的路径绕过开关
    expect(main.match(/powerSaveBlocker\.start\(/g)).toHaveLength(1);
  });

  it("状态传给 server 子进程：版本 + 开关（run 汇总记录据此做 A/B 对比）", () => {
    expect(main).toContain("FLOWSHIP_APP_VERSION: app.getVersion()");
    expect(main).toContain('FLOWSHIP_PREVENT_APP_NAP: getAppNapMode().enabled ? "1" : "0"');
  });

  it("启动时调一次 applyAppNapGuard（会打日志说明开 / 关与来源）；退出时释放 blocker", () => {
    expect(main).toContain("applyAppNapGuard();");
    expect(main).toContain("防后台节流实验=");
    expect(main).toMatch(/before-quit[\s\S]{0,400}powerSaveBlocker\.stop\(appNapBlockerId\)/);
  });
});
