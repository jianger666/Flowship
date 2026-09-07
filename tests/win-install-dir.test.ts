/** Windows 自定义安装目录（E 盘含空格）静默更新保护的单测。 */
import { describe, expect, it, vi } from "vitest";
import {
  getWinShortPathSync,
  normalizeWinInstallDir,
  resolveWinInstallDirForUpdater,
} from "../electron-app/win-install-dir.mjs";

describe("normalizeWinInstallDir", () => {
  it("去首尾空白与成对引号", () => {
    expect(normalizeWinInstallDir('"E:\\My Apps\\Flowship"')).toBe("E:\\My Apps\\Flowship");
    expect(normalizeWinInstallDir("'E:\\My Apps\\Flowship'")).toBe("E:\\My Apps\\Flowship");
    expect(normalizeWinInstallDir("  E:\\Flowship  ")).toBe("E:\\Flowship");
  });

  it("去尾部分隔符、保留盘符根", () => {
    expect(normalizeWinInstallDir("E:\\Flowship\\")).toBe("E:\\Flowship");
    expect(normalizeWinInstallDir("E:\\Flowship/")).toBe("E:\\Flowship");
    expect(normalizeWinInstallDir("E:\\")).toBe("E:\\");
  });

  it("无空格路径原样返回", () => {
    expect(normalizeWinInstallDir("E:\\Flowship")).toBe("E:\\Flowship");
  });
});

describe("getWinShortPathSync", () => {
  it("无空格直接返回 null（不需要短路径）", () => {
    expect(getWinShortPathSync("E:\\Flowship", vi.fn())).toBeNull();
  });

  it("含空格时调 cmd 取短路径", () => {
    const execFn = vi.fn().mockReturnValue("E:\\PROGRA~1\\Flowship\r\n");
    expect(getWinShortPathSync("E:\\My Apps\\Flowship", execFn)).toBe(
      "E:\\PROGRA~1\\Flowship",
    );
    expect(execFn).toHaveBeenCalledOnce();
    expect(execFn.mock.calls[0][0]).toBe("cmd.exe");
  });

  it("短路径仍含空格/失败时返回 null", () => {
    expect(
      getWinShortPathSync("E:\\My Apps\\Flowship", vi.fn().mockReturnValue("E:\\My Apps\\Flowship\r\n")),
    ).toBeNull();
    expect(
      getWinShortPathSync(
        "E:\\My Apps\\Flowship",
        vi.fn().mockImplementation(() => {
          throw new Error("disabled");
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveWinInstallDirForUpdater", () => {
  it("非 win32 直接返回归一化长路径、不调 cmd（CI/单测不碰真 shell）", () => {
    const shortPathFn = vi.fn(() => {
      throw new Error("must not be called");
    });
    const r = resolveWinInstallDirForUpdater(
      "E:\\My Apps\\Flowship\\Flowship.exe",
      "darwin",
      shortPathFn,
    );
    expect(r.dir).toBe("E:\\My Apps\\Flowship");
    expect(r.viaShort).toBe(false);
    expect(shortPathFn).not.toHaveBeenCalled();
  });

  it("无空格目录直接用长路径", () => {
    const r = resolveWinInstallDirForUpdater("E:\\Flowship\\Flowship.exe", "win32", () => null);
    expect(r.dir).toBe("E:\\Flowship");
    expect(r.viaShort).toBe(false);
  });

  it("含空格且有短路径时用短路径（无空格、无需引号）", () => {
    const r = resolveWinInstallDirForUpdater(
      "E:\\My Apps\\Flowship\\Flowship.exe",
      "win32",
      () => "E:\\PROGRA~1\\Flowship",
    );
    expect(r.dir).toBe("E:\\PROGRA~1\\Flowship");
    expect(r.viaShort).toBe(true);
    expect(r.raw).toBe("E:\\My Apps\\Flowship");
  });

  it("含空格但短路径不可用时回落长路径（靠 installer.nsh 去引号兜底）", () => {
    const r = resolveWinInstallDirForUpdater(
      "E:\\My Apps\\Flowship\\Flowship.exe",
      "win32",
      () => null,
    );
    expect(r.dir).toBe("E:\\My Apps\\Flowship");
    expect(r.viaShort).toBe(false);
  });
});
