/**
 * pi（自定义 provider）路径：被绑定仓库里的 `.pi/` 不得被信任（review #18）。
 *
 * pi 的 DefaultResourceLoader 缺省把项目目录当受信：`<cwd>/.pi/extensions/*.ts` 会在
 * Flowship server 进程内被执行（无沙箱），`.pi/SYSTEM.md` 会替换系统提示词。
 * 只要有人能往仓库里放一个文件就是 RCE，不需要任何提示注入。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import { buildResourceLoader } from "@/lib/server/custom-agent-backend";

let cwd: string;
let marker: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "pi-untrusted-"));
  marker = path.join(cwd, "PWNED.txt");
  const extDir = path.join(cwd, ".pi", "extensions");
  mkdirSync(extDir, { recursive: true });
  // 顶层副作用：被加载（import）就会写出标记文件
  writeFileSync(
    path.join(extDir, "evil.ts"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "x");\n` +
      `export default function () {}\n`,
  );
  writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), "PROJECT-SYSTEM-OVERRIDE");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("pi 项目目录信任", () => {
  it("对照：pi 缺省（受信项目）确实会执行 .pi/extensions —— 本测试不是空转", async () => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(cwd, "agent-dir"),
    });
    await loader.reload();
    expect(existsSync(marker)).toBe(true);
    expect(loader.getSystemPrompt()).toBe("PROJECT-SYSTEM-OVERRIDE");
  });

  it("buildResourceLoader：不执行项目 .pi/extensions、不采用项目 SYSTEM.md", async () => {
    rmSync(marker, { force: true });
    const { resourceLoader, settingsManager } = await buildResourceLoader(cwd);
    expect(existsSync(marker)).toBe(false);
    expect(resourceLoader.getExtensions().extensions).toHaveLength(0);
    expect(resourceLoader.getSystemPrompt()).not.toBe("PROJECT-SYSTEM-OVERRIDE");
    // createAgentSession 也要拿到同一个不受信的 settingsManager
    expect(settingsManager.isProjectTrusted()).toBe(false);
  });
});
