/**
 * 桌面图标渲染脚本（v1.0.x logo「雷芯」）
 *
 * 用本机 Chrome headless 把 icon-template.html 截成三份位图：
 *   packaging/icon.png      1024×1024 满幅方图（mac、Tahoe 自动加圆角）
 *   packaging/icon-win.png  1024×1024 预圆角透明角（win 任务栏 / 桌面显示成圆角）
 *   public/logo.png          512×512 预圆角（通用资产）
 *
 * 跑法：node scripts/brand/render-icons.mjs
 * 改图形只改 icon-template.html（跟 brand-mark.tsx 同一套几何、两处同步改）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const tpl = path.join(here, "icon-template.html");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("找不到 Chrome/Chromium、无法渲染图标");
  process.exit(1);
}

const render = (mode, size, out) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "icon-render-"));
  const before = existsSync(out) ? statSync(out).mtimeMs : 0;
  try {
    execFileSync(chrome, [
      "--headless=new",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      // 透明底：预圆角图标四角要 alpha=0
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      "--hide-scrollbars",
      `file://${tpl}?mode=${mode}`,
    ], { stdio: "pipe", timeout: 15000 });
  } catch (err) {
    // headless=new 截完图偶尔不退进程（ETIMEDOUT）——文件已更新就算成功
    if (!(existsSync(out) && statSync(out).mtimeMs > before)) throw err;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const bytes = statSync(out).size;
  console.log(`✓ ${path.relative(root, out)} (${(bytes / 1024).toFixed(0)} KB)`);
};

render("mac", 1024, path.join(root, "packaging/icon.png"));
render("win", 1024, path.join(root, "packaging/icon-win.png"));
render("logo", 512, path.join(root, "public/logo.png"));
