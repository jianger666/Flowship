/**
 * R1 评审（renderer 侧、需要主 agent 接线的条目）的回归契约。
 *
 * 仓库没有 jsdom：use-overlay-cover 的 effect 清理函数是内联闭包，无法做行为级测试，
 * 这里用「去注释后的源码契约」钉住关键形状（与 electron-browser-wiring 同一思路）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** 去掉块注释与整行 // 注释（行尾注释里的代码样字符串不该参与断言） */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("R1-13 渲染端：use-overlay-cover 卸载清理必须无条件恢复视图", () => {
  const src = stripComments(read("src/components/browser/use-overlay-cover.ts"));
  // effect 清理函数体：从 disposed = true 起到 return { covered ... } 之前
  const cleanup = src.slice(src.indexOf("disposed = true;"), src.indexOf("return { covered, coverImage, reevaluate }"));

  it("清理里有 setCovered(taskId, false)", () => {
    expect(cleanup).toContain("bridge.setCovered(taskId, false)");
  });

  it("不再以 coveredNow 为前提（在途的 setCovered(true) 此时 coveredNow 仍是 false，漏发 false 会让视图永久被藏）", () => {
    expect(cleanup).not.toMatch(/if\s*\(\s*coveredNow\s*\)[^;{]*setCovered\(taskId,\s*false\)/);
    // 清理函数里的 setCovered(false) 前面不应出现任何 if 条件（同一语句内）
    const idx = cleanup.indexOf("bridge.setCovered(taskId, false)");
    const stmtStart = cleanup.lastIndexOf(";", idx);
    expect(cleanup.slice(stmtStart + 1, idx)).not.toMatch(/\bif\b/);
  });

  it("发送失败不外抛（卸载路径上不能产生未处理的 rejection）", () => {
    expect(cleanup).toMatch(/setCovered\(taskId,\s*false\)\)\.catch\(/);
  });
});
