/**
 * isAppUserDataPath：认「桌面包 userData 目录」——测试进程 / 临时脚本绝不能碰的真实数据。
 * 纯字符串判断，所以全部用假路径、各平台形状都能在任何机器上测。
 */
import { describe, expect, it } from "vitest";

import { isAppUserDataPath } from "@/lib/server/app-data-dir";

describe("isAppUserDataPath · 认得出的桌面包目录", () => {
  it.each([
    // macOS：正式包 / test 包
    "/Users/me/Library/Application Support/fe-ai-flow/data",
    "/Users/me/Library/Application Support/fe-ai-flow-test/data",
    // Windows：正反斜杠都认
    "C:\\Users\\me\\AppData\\Roaming\\fe-ai-flow\\data",
    "C:/Users/me/AppData/Roaming/fe-ai-flow/data",
    // Linux
    "/home/me/.config/fe-ai-flow/data",
  ])("%s", (p) => {
    expect(isAppUserDataPath(p)).toBe(true);
  });

  it("目录本身、其下任意子路径都算（tasks / logs / config.json 都在 userData 里）", () => {
    const root = "/Users/me/Library/Application Support/fe-ai-flow";
    expect(isAppUserDataPath(root)).toBe(true);
    expect(isAppUserDataPath(`${root}/data/tasks/t_1/meta.json`)).toBe(true);
    expect(isAppUserDataPath(`${root}/logs/main.log`)).toBe(true);
  });

  it("大小写不敏感、多余分隔符 / 末尾斜杠不影响（mac / Windows 文件系统默认不分大小写）", () => {
    expect(
      isAppUserDataPath("/users/me/library/application support/FE-AI-FLOW/data/"),
    ).toBe(true);
    expect(
      isAppUserDataPath("/Users/me//Library///Application Support/fe-ai-flow/data"),
    ).toBe(true);
  });
});

describe("isAppUserDataPath · 不能误伤的路径", () => {
  it("仓库被克隆成 fe-ai-flow 目录：cwd/data 回落路径长得像、但不在 appData 下 → 不算", () => {
    expect(isAppUserDataPath("/Users/me/work/fe-ai-flow/data")).toBe(false);
    expect(isAppUserDataPath("/Users/me/fe-ai-flow-test/data")).toBe(false);
  });

  it("临时目录 / 别的应用 / 名字只是前缀相同 → 不算", () => {
    expect(isAppUserDataPath("/tmp/flowship-vitest-data-abc/data")).toBe(false);
    expect(
      isAppUserDataPath("/var/folders/xx/T/flowship-vitest-data-abc"),
    ).toBe(false);
    expect(
      isAppUserDataPath("/Users/me/Library/Application Support/other-app/data"),
    ).toBe(false);
    expect(
      isAppUserDataPath("/Users/me/Library/Application Support/fe-ai-flow-backup/data"),
    ).toBe(false);
    expect(
      isAppUserDataPath("/Users/me/Library/Application Support/my-fe-ai-flow/data"),
    ).toBe(false);
  });

  it("appData 根与目录名不相邻 → 不算（中间隔了别的目录）", () => {
    expect(
      isAppUserDataPath("/Users/me/Library/Application Support/x/fe-ai-flow/data"),
    ).toBe(false);
  });

  it("空值 / 相对路径 → 不算（防护层认不出就放行，不抛错）", () => {
    expect(isAppUserDataPath(undefined)).toBe(false);
    expect(isAppUserDataPath(null)).toBe(false);
    expect(isAppUserDataPath("")).toBe(false);
    expect(isAppUserDataPath("data")).toBe(false);
    expect(isAppUserDataPath("fe-ai-flow/data")).toBe(false);
  });
});
