/**
 * isWatchScript 单测（V0.8.19 防呆核心）
 *
 * 背景：自动检测把 package.json 的 `tsc` 脚本当 typecheck check、没识别它是 watch 模式——
 * 线上 cp-haomao 的 `"tsc": "node_modules/typescript/bin/tsc -w"` 被拉进来当 check、watch 永不
 * 退出、必撞满 timeout 被杀（三次 build 全 timed_out）。isWatchScript 在检测阶段就把 watch 脚本认出来。
 */
import { describe, expect, it } from "vitest";

import { isWatchScript } from "@/lib/server/repo-check-detect";

describe("isWatchScript", () => {
  it("命中 watch 模式（-w / --watch）", () => {
    expect(isWatchScript("tsc -w")).toBe(true);
    expect(isWatchScript("tsc --watch")).toBe(true);
    // 线上真实踩坑案例（cp-haomao）
    expect(isWatchScript("node_modules/typescript/bin/tsc -w")).toBe(true);
    expect(isWatchScript("vue-tsc --noEmit -w")).toBe(true);
    expect(isWatchScript("tsc -w --preserveWatchOutput")).toBe(true);
    // 引号包裹（concurrently 之类）：-w 后是引号也算词边界
    expect(isWatchScript('concurrently "tsc -w"')).toBe(true);
  });

  it("正常一次性命令不误判", () => {
    expect(isWatchScript("tsc --noEmit")).toBe(false);
    expect(isWatchScript("tsc")).toBe(false);
    expect(isWatchScript("vue-tsc --noEmit")).toBe(false);
    expect(isWatchScript("tsc -p tsconfig.json")).toBe(false);
    expect(isWatchScript("tsc --noEmitOnError")).toBe(false);
    // 含字母 w 的参数（.tsx 扩展名 / --no-watch）不该命中
    expect(isWatchScript("eslint . --ext .js,.jsx,.ts,.tsx")).toBe(false);
    expect(isWatchScript("tsc --no-watch")).toBe(false);
    expect(isWatchScript("")).toBe(false);
  });
});
