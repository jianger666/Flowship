/**
 * mac 暂存下载前的磁盘预检（R14 B2-4 / Q15-01）：纯函数部分
 *
 * 改前 mac 没有任何空间预检：下到一半 ENOSPC，用户白等一趟、只看到一句 errno，而且错误被当成「会白下 dmg 的失败」计数。
 * 现在下载前先量 updates 目录所在盘（assertMacStageSpace）：不够就抛 StageNoSpaceError——
 *   A. 阈值与边界（口径同 Windows 的 checkUpdateTempSpace：向下取整到 MB、严格小于才拦、量不到放行）
 *   B. StageNoSpaceError：按类型判（不匹配文案 / code）、文案给人看（MB / GB、不含路径与 errno）
 *   C. 通知：点徽标 / 设置页检查更新弹专门文案、**不开发布页**（手动下载同样要这些空间）；后台触发的前 2 次静默
 *   D. 重试闸：不计入「会白下 dmg」的失败（它发生在下载之前、没花流量）；也不打断已有的连续计数；
 *      后台连续第 3 次仍会弹一次既有的「自动更新多次失败」框（正文带这句原因）——所以 C 组的「静默」只对前 2 次成立
 * main.js 里这段预检与下载失败后的复位怎么接线，见 mac-stage-download-failure.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  BYTES_PER_MB,
  MIN_MAC_STAGE_FREE_MB,
  StageNoSpaceError,
  assertMacStageSpace,
  isStageNoSpaceError,
} from "../electron-app/disk-space.mjs";
import {
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  buildGenericUpdateFailureNotice,
  buildVerifyRejectionNotice,
} from "../electron-app/update-manifest-verify.mjs";
import {
  STAGE_GIVE_UP_AFTER,
  buildRepeatedFailureNotice,
  isCostlyStageFailure,
  isPermanentVerifyFailure,
  nextCostlyFailureRecord,
  nextVerifyRetry,
  shouldGiveUpAutoStage,
  shouldPromptRepeatedFailure,
} from "../electron-app/update-verify-retry.mjs";

/** 字节级的假 statfs（bsize=1 → bavail 就是可用字节数），好测「差 1 字节」的边界 */
const statfsBytes = (bytes: number) => () => ({ bavail: bytes, bsize: 1 });
const MIN_BYTES = MIN_MAC_STAGE_FREE_MB * BYTES_PER_MB;
const catchSync = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const noSpace = (freeMB = 100, minMB = MIN_MAC_STAGE_FREE_MB) => new StageNoSpaceError({ freeMB, minMB });

describe("A. 阈值与边界", () => {
  it("阈值 = 600MB，且不小于「dmg ≈ 123MB（v1.9.37 release：arm64 118.4 / x64 122.4，取上界）+ 展开后的 .app ≈ 410MB」（两份同时在盘上；依据见 disk-space.mjs）", () => {
    expect(MIN_MAC_STAGE_FREE_MB).toBe(600);
    expect(MIN_MAC_STAGE_FREE_MB).toBeGreaterThanOrEqual(123 + 410);
  });

  it("差 1 字节到阈值 → 拦（抛 StageNoSpaceError）；恰好阈值 → 放；多 1MB → 放", () => {
    expect(catchSync(() => assertMacStageSpace("/u", statfsBytes(MIN_BYTES - 1)))).toBeInstanceOf(StageNoSpaceError);
    expect(assertMacStageSpace("/u", statfsBytes(MIN_BYTES))).toMatchObject({ enough: true, freeMB: MIN_MAC_STAGE_FREE_MB });
    expect(assertMacStageSpace("/u", statfsBytes(MIN_BYTES + BYTES_PER_MB)).enough).toBe(true);
  });

  it("向下取整到 MB：599.99MB 取 599 → 拦", () => {
    const err = catchSync(() => assertMacStageSpace("/u", statfsBytes(MIN_BYTES - 1))) as StageNoSpaceError;
    expect(err.freeMB).toBe(MIN_MAC_STAGE_FREE_MB - 1);
    expect(err.minMB).toBe(MIN_MAC_STAGE_FREE_MB);
  });

  it("空间为 0 → 拦（0 是「真的没空间」，不是「量不到」）", () => {
    expect(catchSync(() => assertMacStageSpace("/u", statfsBytes(0)))).toBeInstanceOf(StageNoSpaceError);
  });

  it("量不到（statfs 抛错 / 数值异常）→ 放行并给 freeMB=null，绝不因为量不准把人挡在更新之外", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(assertMacStageSpace("/u", boom)).toEqual({ enough: true, freeMB: null, minMB: MIN_MAC_STAGE_FREE_MB });
    expect(assertMacStageSpace("/u", () => ({ bavail: Number.NaN, bsize: 4096 })).enough).toBe(true);
    expect(assertMacStageSpace("/u", () => ({ bavail: -1, bsize: 4096 })).enough).toBe(true);
  });

  it("阈值可注入；量的是调用方给的目录", () => {
    expect(catchSync(() => assertMacStageSpace("/u", statfsBytes(2 * BYTES_PER_MB), 3))).toBeInstanceOf(StageNoSpaceError);
    expect(assertMacStageSpace("/u", statfsBytes(3 * BYTES_PER_MB), 3).enough).toBe(true);
    const seen: string[] = [];
    assertMacStageSpace("/Users/x/Library/Application Support/Flowship/updates", (d: string) => {
      seen.push(d);
      return { bavail: MIN_BYTES, bsize: 1 };
    });
    expect(seen).toEqual(["/Users/x/Library/Application Support/Flowship/updates"]);
  });
});

describe("B. StageNoSpaceError", () => {
  it("是 Error、有稳定的 name / code，并带着量到的数字", () => {
    const e = noSpace(123, 600);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("StageNoSpaceError");
    expect(e.code).toBe("STAGE_NO_SPACE");
    expect(e.freeMB).toBe(123);
    expect(e.minMB).toBe(600);
  });

  it("文案给人看：不足 1GB 用 MB、≥ 1GB 用 GB（一位小数）；说清剩多少、要多少、该怎么办", () => {
    expect(noSpace(123, 600).message).toBe("磁盘剩余空间不足（约 123 MB），暂存更新至少需要 600 MB。请清理磁盘后再试。");
    expect(noSpace(1536, 2048).message).toBe("磁盘剩余空间不足（约 1.5 GB），暂存更新至少需要 2.0 GB。请清理磁盘后再试。");
    expect(noSpace(0, 600).message).toContain("约 0 MB");
    // GB / MB 的边界（R14 B2-4a 审查 P3-2）：1023 MB 还是 MB，1024 MB 起是「1.0 GB」——`>=` 写成 `>` 会红
    const below = noSpace(1023, 1024).message;
    expect(below).toContain("约 1023 MB");
    expect(below).toContain("至少需要 1.0 GB");
    const above = noSpace(1024, 2048).message;
    expect(above).toContain("约 1.0 GB");
    expect(above).toContain("至少需要 2.0 GB");
  });

  it("面向用户：不出现路径 / errno", () => {
    expect(noSpace().message).not.toMatch(/ENOSPC|errno|\/|\\/);
  });

  it("isStageNoSpaceError 按类型判：同名文案的普通 Error / 带同 code 的普通对象 / 非 Error 值都不算", () => {
    expect(isStageNoSpaceError(noSpace())).toBe(true);
    expect(isStageNoSpaceError(new Error(noSpace().message))).toBe(false);
    expect(isStageNoSpaceError(Object.assign(new Error("x"), { code: "STAGE_NO_SPACE" }))).toBe(false);
    expect(isStageNoSpaceError({ code: "STAGE_NO_SPACE" })).toBe(false);
    expect(isStageNoSpaceError("磁盘剩余空间不足")).toBe(false);
    expect(isStageNoSpaceError(null)).toBe(false);
    expect(isStageNoSpaceError(undefined)).toBe(false);
    // 带同 name 的普通对象 / 伪造了 name + code 的 Error 也不算（instanceof，不是鸭子类型；R14 B2-4a 审查 P3-2）
    expect(isStageNoSpaceError({ name: "StageNoSpaceError", message: "x" })).toBe(false);
    expect(
      isStageNoSpaceError(Object.assign(new Error("x"), { name: "StageNoSpaceError", code: "STAGE_NO_SPACE" })),
    ).toBe(false);
  });
});

describe("C. 通知：专门文案、不开发布页；后台静默", () => {
  it("通用失败文案（点徽标 / 设置页检查更新取它）：弹框说明、不开发布页、不占 wasPrompted", () => {
    const err = noSpace(200);
    const n = buildGenericUpdateFailureNotice(err);
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(false);
    expect(n.markPrompted).toBe(false);
    expect(n.definitive).toBe(false);
    expect(n.manifestMissing).toBe(false);
    expect(n.title).toContain("磁盘空间不足");
    expect(n.reason).toBe(err.message);
    expect(n.body).toBe(err.message); // 不再追加「将打开下载页」——手动装同样要这些空间
    expect(n.stateError).toBe(err.message);
  });

  it("对照（回归）：其它失败照旧「自动更新失败 + 将打开下载页」", () => {
    const n = buildGenericUpdateFailureNotice(new Error("下载失败 HTTP 502"));
    expect(n.title).toBe("自动更新失败");
    expect(n.openReleasePage).toBe(true);
    expect(n.body).toContain("将打开下载页");
    // 同名文案的普通 Error 不会被误当成空间不足（按类型判）
    expect(buildGenericUpdateFailureNotice(new Error(noSpace().message)).openReleasePage).toBe(true);
  });

  it("后台触发（2h 轮询 / 启动检查，没人在等）：这一次静默——不弹框、不开发布页、不消耗 wasPrompted；页面状态里仍有这句原因（连续第 3 次另见 D 组）", () => {
    const err = noSpace(200);
    const n = buildVerifyRejectionNotice(err, { trigger: "background", alreadyPrompted: false });
    expect(n.showDialog).toBe(false);
    expect(n.openReleasePage).toBe(false);
    expect(n.markPrompted).toBe(false);
    expect(n.stateError).toContain("磁盘剩余空间不足");
  });
});

describe("D. 重试闸：下载之前就拦下的失败，不算「会白下 dmg」", () => {
  it("isCostlyStageFailure(空间不足) = false；也不是永久失败", () => {
    expect(isCostlyStageFailure(noSpace())).toBe(false);
    expect(isPermanentVerifyFailure(noSpace())).toBe(false);
  });

  it("nextCostlyFailureRecord 对它原样返回 prev：既不 +1 也不清零", () => {
    expect(nextCostlyFailureRecord(null, "9.9.9", noSpace())).toBeNull();
    const prev = { version: "9.9.9", count: 2 };
    expect(nextCostlyFailureRecord(prev, "9.9.9", noSpace())).toBe(prev);
  });

  it("连续空间不足再多次，也不会触发「放弃自动暂存」——用户腾出空间后，后台轮询仍会自动暂存", () => {
    let rec: { version: string; count: number } | null | undefined = null;
    for (let i = 0; i < STAGE_GIVE_UP_AFTER * 3; i += 1) rec = nextCostlyFailureRecord(rec, "9.9.9", noSpace());
    expect(shouldGiveUpAutoStage(rec, "9.9.9")).toBe(false);
  });

  it("对照（回归）：未归类的下载后失败累计 STAGE_GIVE_UP_AFTER 次 → 放弃；中间夹着空间不足不改变计数", () => {
    const real = new Error("dmg 下载不完整（10/20 字节）、已中止暂存");
    let rec: { version: string; count: number } | null | undefined = null;
    rec = nextCostlyFailureRecord(rec, "9.9.9", real);
    rec = nextCostlyFailureRecord(rec, "9.9.9", noSpace());
    rec = nextCostlyFailureRecord(rec, "9.9.9", real);
    expect(shouldGiveUpAutoStage(rec, "9.9.9")).toBe(false); // 2 次
    rec = nextCostlyFailureRecord(rec, "9.9.9", noSpace());
    rec = nextCostlyFailureRecord(rec, "9.9.9", real);
    expect(rec).toEqual({ version: "9.9.9", count: STAGE_GIVE_UP_AFTER });
    expect(shouldGiveUpAutoStage(rec, "9.9.9")).toBe(true);
  });

  it("后台连续第 3 次空间不足：弹一次既有的「自动更新多次失败」框、正文带这句原因（R14 B2-4a 审查 P3-3①：「静默」只对前 2 次成立）", () => {
    const version = "9.9.9";
    const err = noSpace(523);
    // main.js 对每次后台失败都登记时间退避（isCostlyStageFailure=false 只是不计入「放弃自动暂存」闸、不是不退避）
    let retry = nextVerifyRetry(null, version, 0);
    expect(shouldPromptRepeatedFailure(retry, version, null)).toBe(false); // 第 1 次：静默
    retry = nextVerifyRetry(retry, version, 1);
    expect(shouldPromptRepeatedFailure(retry, version, null)).toBe(false); // 第 2 次：静默
    retry = nextVerifyRetry(retry, version, 2);
    expect(shouldPromptRepeatedFailure(retry, version, null)).toBe(true); // 第 3 次：提示
    const notice = buildVerifyRejectionNotice(err, { trigger: "background", alreadyPrompted: false });
    expect(notice.showDialog).toBe(false); // 这一次本身仍然静默：弹的是下面那个独立的「多次失败」框
    const repeated = buildRepeatedFailureNotice({ version, failures: retry.failures, reason: notice.reason });
    expect(repeated.title).toBe("自动更新多次失败");
    expect(repeated.body).toContain("已连续失败 3 次");
    expect(repeated.body).toContain(err.message);
    expect(repeated.body).toContain("磁盘剩余空间不足（约 523 MB）");
    expect(repeated.body).toContain("可点更新徽标重试，或到发布页手动下载安装。");
    // 只弹一次：弹过之后同一版本不再提示
    expect(shouldPromptRepeatedFailure(retry, version, version)).toBe(false);
  });

  it("对照（回归）：Unavailable / Mismatch 的既有口径没被带歪", () => {
    expect(isCostlyStageFailure(new UpdateVerifyUnavailableError("503", "manifest-http"))).toBe(false);
    expect(isCostlyStageFailure(new UpdateVerifyUnavailableError("读盘失败", "local-io"))).toBe(true);
    expect(isCostlyStageFailure(new UpdateVerifyMismatchError("sha256 不符", "sha256"))).toBe(false);
    expect(isCostlyStageFailure(new Error("hdiutil 失败"))).toBe(true);
  });
});
