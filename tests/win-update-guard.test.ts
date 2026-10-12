/** Windows 静默更新门禁（win-update-guard.mjs）的纯函数单测。 */
import { existsSync as nodeExistsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSpaceBlockedMessage,
  buildUpdateFailedMessage,
  buildWinUpdateAttempt,
  classifyWinUpdateAttempt,
  findInstallerAbort,
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

const abortLine = (version: string, freeMB: number, minMB = 800, ts = 1760000000) =>
  `[ts=${ts}] ABORT v${version} tempFreeMB=${freeMB} < ${minMB} old install untouched`;

describe("findInstallerAbort：从 installer.log 找目标版本的预检拦截记录", () => {
  it("命中目标版本的 ABORT → 剩余 / 阈值", () => {
    expect(findInstallerAbort(abortLine("1.9.31", 512), "1.9.31")).toEqual({
      freeMB: 512,
      minMB: 800,
    });
  });

  it("只认目标版本：别的版本的 ABORT、同版本的 init / done 行都不算", () => {
    const log = [
      "[ts=1] init v1.9.31 updated=1 instDrive=C: tempDrive=C: tempFreeMB=512",
      abortLine("1.9.30", 100),
      abortLine("1.9.311", 100), // 前缀相同但不是同一个版本
      "[ts=3] done v1.9.31 updated=1 marker=ok elapsedSec=40 instDrive=C:",
    ].join("\n");
    expect(findInstallerAbort(log, "1.9.31")).toBeNull();
  });

  it("同版本被拦过多次 → 取最后一条（最近一次的数字）", () => {
    const log = [abortLine("1.9.31", 300, 800, 1), abortLine("1.9.31", 700, 800, 2)].join("\r\n");
    expect(findInstallerAbort(log, "1.9.31")).toEqual({ freeMB: 700, minMB: 800 });
  });

  it("CRLF（安装器写 $\\r$\\n）与尾部多余空行都能解析", () => {
    expect(findInstallerAbort(`${abortLine("1.9.31", 5)}\r\n\r\n`, "1.9.31")).toEqual({
      freeMB: 5,
      minMB: 800,
    });
  });

  it("尾部截断的半行（只读日志最后 64KB）不会被误匹配：无论切在 `[ts=` 里还是切在时间戳之后", () => {
    const full = abortLine("1.9.31", 512);
    // 切掉行首 "["；切在时间戳数字中间；整段 `[ts=…]` 前缀都被切掉、只剩消息体
    for (const from of [1, 8, full.indexOf("ABORT")]) {
      expect(findInstallerAbort(full.slice(from), "1.9.31"), `从第 ${from} 个字符截断`).toBeNull();
    }
    // 对照：完整行仍然命中
    expect(findInstallerAbort(full, "1.9.31")).not.toBeNull();
  });

  it("日志为空 / 入参类型不对 / 版本为空 → null，不抛", () => {
    expect(findInstallerAbort("", "1.9.31")).toBeNull();
    expect(findInstallerAbort(undefined as unknown as string, "1.9.31")).toBeNull();
    expect(findInstallerAbort(abortLine("1.9.31", 1), "")).toBeNull();
    expect(findInstallerAbort(abortLine("1.9.31", 1), undefined as unknown as string)).toBeNull();
  });
});

describe("buildSpaceBlockedMessage：主进程预检拦下（App 还开着）", () => {
  it("说清剩余 / 需要多少、怎么办、没动任何东西；不引导去发布页", () => {
    const m = buildSpaceBlockedMessage({ freeMB: 512, minMB: 800 });
    expect(m.reason).toContain("512MB");
    expect(m.reason).toContain("800MB");
    expect(m.body).toContain(m.reason);
    expect(m.body).toContain("清理系统盘");
    expect(m.body).toContain("没有做任何改动");
    expect(m.body).not.toContain("发布页");
    expect(m.title).toContain("磁盘空间不足");
  });
});

describe("buildUpdateFailedMessage：墓碑核销判定「上次没装上」后的弹框", () => {
  const base = {
    wantVersion: "1.9.31",
    currentVersion: "1.9.30",
    tempFreeMB: null,
    minTempFreeMB: 800,
    installerLogPath: "C:\\Users\\me\\AppData\\Roaming\\fe-ai-flow\\logs\\installer.log",
  };

  it("有 ABORT 记录：点名空间不足、给安装器当时量到的数字、强调原安装没动；不再引导去发布页", () => {
    const m = buildUpdateFailedMessage({ ...base, abort: { freeMB: 512, minMB: 800 } });
    expect(m.title).toContain("磁盘空间不足");
    expect(m.body).toContain("512MB");
    expect(m.body).toContain("800MB");
    expect(m.body).toContain("v1.9.31");
    expect(m.body).toContain("v1.9.30");
    expect(m.body).toContain("原有安装没有被改动");
    expect(m.body).toContain(base.installerLogPath);
    expect(m.offerReleasePage).toBe(false);
  });

  it("没有 ABORT 记录：通用文案，但「清理系统盘」排在「手动下载安装包」前面（原先顺序反了）", () => {
    const m = buildUpdateFailedMessage({ ...base, abort: null });
    expect(m.title).toBe("上次更新没有装上");
    const clean = m.body.indexOf("清理系统盘");
    const manual = m.body.indexOf("手动下载安装包");
    expect(clean).toBeGreaterThanOrEqual(0);
    expect(manual).toBeGreaterThanOrEqual(0);
    expect(clean).toBeLessThan(manual);
    // 空间与杀软并列（两个最常见原因都得点到）
    expect(m.body).toContain("杀毒软件");
    expect(m.body).toContain("800MB");
    expect(m.body).toContain(base.installerLogPath);
    expect(m.offerReleasePage).toBe(true);
  });

  it("通用文案：现在量得到系统盘剩余就附上，量不到就不写（不编数字）", () => {
    expect(buildUpdateFailedMessage({ ...base, abort: null, tempFreeMB: 123 }).body).toContain(
      "现在约剩 123MB",
    );
    expect(buildUpdateFailedMessage({ ...base, abort: null, tempFreeMB: null }).body).not.toContain(
      "现在约剩",
    );
    // 0 是真实数字（盘满了）、不能被当成「没量到」
    expect(buildUpdateFailedMessage({ ...base, abort: null, tempFreeMB: 0 }).body).toContain(
      "现在约剩 0MB",
    );
  });
});
