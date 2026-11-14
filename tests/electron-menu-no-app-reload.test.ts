/**
 * 应用菜单不能带「重新加载 / 强制重新加载」（Flowship 自身禁止整页刷新）。
 *
 * 背景：内置浏览器是 WebContentsView，页面持有焦点时按键不经过主窗口的 before-input-event，
 * 若菜单里留着系统 viewMenu 的 Cmd+R / Cmd+Shift+R，按下就把整个 Flowship 主窗口刷掉
 * （用户要的是刷新浏览器页面）。浏览器页面的刷新由 browser/user-features 的 before-input-event 接管。
 *
 * main.js 无法在 vitest 里 import（顶层副作用），这里按源码文本钉住菜单模板：
 * 只切 `Menu.setApplicationMenu(` 到下一个语句边界，避免被文件里别处的 reload 字样干扰。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.join(process.cwd(), "electron-app", "main.js"), "utf-8");

const menuBlock = (): string => {
  const start = src.indexOf("Menu.setApplicationMenu(");
  expect(start, "找不到 mac 自定义应用菜单").toBeGreaterThan(-1);
  const end = src.indexOf("registerProtocolClient();", start);
  expect(end, "菜单块的结束锚点（registerProtocolClient）丢了").toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("mac 应用菜单：Flowship 自身禁刷新", () => {
  it("不用整套 viewMenu（它自带重新加载 / 强制重新加载）、也不挂任何 reload role / Cmd+R 加速键", () => {
    const block = menuBlock();
    expect(block).not.toMatch(/role:\s*["']viewMenu["']/);
    expect(block).not.toMatch(/role:\s*["'](reload|forceReload)["']/);
    expect(block).not.toMatch(/accelerator:\s*["'][^"']*\+(Shift\+)?R["']/i);
  });

  it("「显示」菜单仍保留开发者工具 / 缩放 / 全屏（只去掉刷新、不误伤其它）", () => {
    const block = menuBlock();
    expect(block).toContain('label: "显示"');
    for (const role of ["toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) {
      expect(block, role).toContain(`role: "${role}"`);
    }
    // 编辑 / 窗口菜单仍在（editMenu 丢了 Cmd+C/V 全失效）
    expect(block).toContain('role: "editMenu"');
    expect(block).toContain('role: "windowMenu"');
  });

  it("主窗口自己的 Cmd/Ctrl+R / F5 拦截仍在（焦点在 Flowship 页面时同样禁刷新）", () => {
    expect(src).toMatch(/const isReload = key === "f5" \|\| \(\(input\.meta \|\| input\.control\) && key === "r"\)/);
  });
});
