/** Windows NSIS 自动更新的进程清理契约。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const installer = read("packaging/installer.nsh");
const main = read("electron-app/main.js");

const macroBody = (name: string): string => {
  const match = installer.match(
    new RegExp(`!macro ${name}\\n([\\s\\S]*?)\\n!macroend`),
  );
  expect(match, `${name} 应存在`).not.toBeNull();
  return match?.[1] ?? "";
};

describe("Windows 自动更新安装器不会被 Flowship 自己杀掉", () => {
  it.each(["customInit", "customUnInit"])(
    "%s 的进程树清理只允许用于非更新路径",
    (name) => {
      const body = macroBody(name);
      const guard = body.indexOf("${ifNot} ${isUpdated}");
      const taskkill = body.indexOf('taskkill /F /T /IM "Flowship.exe"');
      const end = body.indexOf("${endIf}");

      expect(guard).toBeGreaterThanOrEqual(0);
      expect(taskkill).toBeGreaterThan(guard);
      expect(end).toBeGreaterThan(taskkill);
    },
  );

  it("仍以静默安装并强制拉起新版本，退出时按 server PID 精确清理", () => {
    expect(main).toContain("winAutoUpdater.quitAndInstall(true, true)");
    expect(main).toContain(
      'execFileSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"]',
    );
  });
});
