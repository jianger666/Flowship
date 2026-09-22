/** Windows 静默更新门禁（win-update-guard.mjs）的纯函数单测。 */
import { existsSync as nodeExistsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildWinUpdateAttempt,
  classifyWinUpdateAttempt,
  hasSilentUpdateMarker,
  SILENT_UPDATE_OK_MARKER,
  silentUpdateMarkerPath,
  WIN_UPDATE_ATTEMPT_FILE,
} from "../electron-app/win-update-guard.mjs";

// main.js 同款三段式版本比较（单测本地复刻、只锁语义）
const isNewer = (a: string, b: string): boolean => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

describe("win-update-guard 标记门禁", () => {
  it("标记路径落在安装目录里", () => {
    expect(silentUpdateMarkerPath("E:\\Flowship")).toBe(
      path.join("E:\\Flowship", SILENT_UPDATE_OK_MARKER),
    );
    expect(WIN_UPDATE_ATTEMPT_FILE).toBe("win-update-attempt.json");
  });

  it("有标记才敢静默；无标记/IO 异常/非法入参一律不敢（fail-closed）", () => {
    expect(hasSilentUpdateMarker("E:\\Flowship", () => true)).toBe(true);
    expect(hasSilentUpdateMarker("E:\\Flowship", () => false)).toBe(false);
    expect(
      hasSilentUpdateMarker("E:\\Flowship", () => {
        throw new Error("EACCES");
      }),
    ).toBe(false);
    // undefined 入参：拼出 "undefined/..." 野路径，真 fs 下必不存在 → false
    expect(
      hasSilentUpdateMarker(undefined, (p) => p === silentUpdateMarkerPath("E:\\Flowship")),
    ).toBe(false);
  });

  it("真 fs  smoke：模块可被主进程直接用", () => {
    expect(typeof nodeExistsSync).toBe("function");
  });
});

describe("win-update-guard 墓碑核销", () => {
  it("无墓碑/损坏一律 none、不打扰启动", () => {
    expect(classifyWinUpdateAttempt(null, "1.9.16", isNewer)).toBe("none");
    expect(classifyWinUpdateAttempt(undefined, "1.9.16", isNewer)).toBe("none");
    expect(classifyWinUpdateAttempt({ version: "" }, "1.9.16", isNewer)).toBe("none");
    expect(classifyWinUpdateAttempt({ nope: 1 }, "1.9.16", isNewer)).toBe("none");
  });

  it("当前已到目标版本 = success（相等或更新，如手动装了更新的）", () => {
    expect(
      classifyWinUpdateAttempt(
        buildWinUpdateAttempt("1.9.16"),
        "1.9.16",
        isNewer,
      ),
    ).toBe("success");
    expect(
      classifyWinUpdateAttempt(
        buildWinUpdateAttempt("1.9.16"),
        "1.9.17",
        isNewer,
      ),
    ).toBe("success");
  });

  it("目标仍新于当前 = failed（死半路，必须弹框请手动装）", () => {
    expect(
      classifyWinUpdateAttempt(
        buildWinUpdateAttempt("1.9.16"),
        "1.9.15",
        isNewer,
      ),
    ).toBe("failed");
  });
});
