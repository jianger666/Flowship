/**
 * mac 自动暂存验签失败后的重试策略（electron-app/update-verify-retry.mjs）——第五轮审查 F1-01
 *
 * 旧行为：`macVerifyFailedVersion` 对 Mismatch 与**所有** Unavailable 一视同仁地永久登记，
 * 一次瞬时 503 / 超时就让该版本在进程内不再自动暂存，2h 轮询「网络恢复后自愈」的价值被废掉。
 * 新策略：确定性失败（Mismatch / 没带 manifest）永久跳过；其余失败按时间退避（5 分钟起、翻倍、封顶 2 小时）。
 * 第七轮 P2-2：「其余」包含**未归类错误**（dmg 下载 502 / 不完整、hdiutil / ditto 失败……）——以前它们既不永久跳过也不退避，
 * 每次轮询都重下一遍 dmg；所以不再有单独的「暂时性」判定函数（isTransientVerifyFailure 已删），「不是永久」就是「要退避」。
 * 连续失败达到 REPEATED_FAILURE_PROMPT_AFTER 次时后台弹一次「多次失败」说明框（shouldPromptRepeatedFailure）。
 *
 * 这里测纯模块本身（分类 / 退避数值 / 时间判定 / 多次失败的判定与文案）；与 main.js 的接线（真实函数体 + 伪造时钟）
 * 在 tests/update-manifest-failure-kinds.test.ts 的 ③e / ③f。
 */
import { describe, expect, it } from "vitest";

import {
  UpdateVerifyManifestMissingError,
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
} from "../electron-app/update-manifest-verify.mjs";
import {
  REPEATED_FAILURE_PROMPT_AFTER,
  STAGE_GIVE_UP_AFTER,
  VERIFY_RETRY_BASE_MS,
  VERIFY_RETRY_MAX_MS,
  buildRepeatedFailureNotice,
  isCostlyStageFailure,
  isPermanentVerifyFailure,
  isVerifyRetryBlocked,
  nextCostlyFailureRecord,
  nextVerifyRetry,
  shouldGiveUpAutoStage,
  shouldPromptRepeatedFailure,
  verifyRetryDelayMs,
} from "../electron-app/update-verify-retry.mjs";

const MIN = 60_000;
const V = "9.9.9";

describe("常量", () => {
  it("首次退避 5 分钟、上限 2 小时（与 2h 轮询同量级）", () => {
    expect(VERIFY_RETRY_BASE_MS).toBe(5 * MIN);
    expect(VERIFY_RETRY_MAX_MS).toBe(120 * MIN);
    expect(VERIFY_RETRY_MAX_MS).toBeGreaterThan(VERIFY_RETRY_BASE_MS);
  });
});

describe("失败分类：只看错误类型、不看文案", () => {
  const mismatch = new UpdateVerifyMismatchError("x", "sha256");
  const missing = new UpdateVerifyManifestMissingError("没带清单", "manifest-missing");
  const unavailable = new UpdateVerifyUnavailableError("503", "manifest-http");

  it("确定不符 / 没带 manifest = 永久（重试不会好）", () => {
    expect(isPermanentVerifyFailure(mismatch)).toBe(true);
    expect(isPermanentVerifyFailure(missing)).toBe(true); // Unavailable 的子类，但 404 / 410 不会自愈
  });

  it("其余 Unavailable（5xx / 限流 / 超时 / 网络 / 正文不是清单 / 公钥 / 本地读文件）不是永久（走时间退避）", () => {
    for (const code of [
      "manifest-http",
      "manifest-network",
      "manifest-parse",
      "manifest-too-large",
      "manifest-invalid",
      "public-key",
      "local-io",
    ]) {
      const err = new UpdateVerifyUnavailableError("某个暂时性失败", code);
      expect(isPermanentVerifyFailure(err), code).toBe(false);
    }
    expect(isPermanentVerifyFailure(unavailable)).toBe(false);
  });

  // P2-2：以前这条断言「不登记任何记录」——isTransientVerifyFailure 对未归类错误也是 false，main.js 的 catch 于是
  // 对它们既不永久跳过也不退避，每次轮询都重下一遍 dmg。现在语义变了：它们**不是永久**（永久跳过是破坏性强的处置、
  // 宁可少登记），但**要退避**——main.js 的 catch 是 if（永久）/ else（其余一律 nextVerifyRetry），不再有第三种「什么都不记」。
  // 这里只能钉住纯函数这一半（不是永久）；「未归类错误真的登记了退避、第二次被跳过」由 ③e 的 P2-2 用例走真实函数体守。
  it("未归类的错误（dmg 下载 502 / 非常规安装位置）与非 Error 值都不是永久——它们归「其余」：由调用方登记时间退避、不登记永久跳过", () => {
    for (const v of [
      new Error("下载失败 HTTP 502"),
      new TypeError("t"),
      "string",
      null,
      undefined,
      { code: "sha256" },
      { name: "UpdateVerifyMismatchError" }, // 不能靠 name / 鸭子类型冒充
    ]) {
      expect(isPermanentVerifyFailure(v)).toBe(false);
    }
  });

  it("分类不被文案带偏：Unavailable 的文案里写「签名校验失败 / SHA-256」也仍不是永久", () => {
    const err = new UpdateVerifyUnavailableError("签名校验失败 SHA-256 不符（只是措辞撞车）", "manifest-http");
    expect(isPermanentVerifyFailure(err)).toBe(false);
  });
});

describe("连续失败 3 次的「多次失败」提示（P2-2）：判定与文案", () => {
  const NOW = 1_800_000_000_000;
  /** 同版本连续失败 n 次后的退避记录（用真实的 nextVerifyRetry 累计，不手写字段） */
  const afterFailures = (n: number, version = V) => {
    let r: ReturnType<typeof nextVerifyRetry> | null = null;
    for (let i = 0; i < n; i++) r = nextVerifyRetry(r, version, NOW + i);
    return r;
  };

  it("阈值是 3", () => {
    expect(REPEATED_FAILURE_PROMPT_AFTER).toBe(3);
  });

  it.each([
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [50, true],
  ])("该版本连续失败 %i 次、没弹过 → %s", (n, expected) => {
    expect(shouldPromptRepeatedFailure(afterFailures(n), V, null)).toBe(expected);
    expect(shouldPromptRepeatedFailure(afterFailures(n), V, undefined)).toBe(expected);
  });

  it("按版本去重：这个版本已经弹过（promptedVersion === version）就不再弹；弹过的是别的版本不影响", () => {
    const r = afterFailures(3);
    expect(shouldPromptRepeatedFailure(r, V, V)).toBe(false);
    expect(shouldPromptRepeatedFailure(r, V, "9.8.0")).toBe(true);
  });

  it("记录是别的版本的 / 没有记录：不弹（换版本计数清零——nextVerifyRetry 已保证，这里守判定本身）", () => {
    expect(shouldPromptRepeatedFailure(afterFailures(5, "9.10.0"), V, null)).toBe(false);
    expect(shouldPromptRepeatedFailure(null, V, null)).toBe(false);
    expect(shouldPromptRepeatedFailure(undefined, V, null)).toBe(false);
    // 旧版本攒了 5 次、换到新版本后第 1 次失败：计数从 1 重来
    const switched = nextVerifyRetry(afterFailures(5, "9.10.0"), V, NOW);
    expect(switched.failures).toBe(1);
    expect(shouldPromptRepeatedFailure(switched, V, null)).toBe(false);
  });

  it("文案：标题固定、正文带版本 / 次数 / 最近原因，并给「点更新徽标重试」与「手动下载」两个出路；不带开页字段", () => {
    const n = buildRepeatedFailureNotice({ version: V, failures: 3, reason: "下载失败 HTTP 502" });
    expect(n.title).toBe("自动更新多次失败");
    expect(n.body).toContain(`v${V}`);
    expect(n.body).toContain("连续失败 3 次");
    expect(n.body).toContain("下载失败 HTTP 502");
    expect(n.body).toContain("更新徽标");
    expect(n.body).toContain("手动下载");
    // 只提示、不开发布页：调用方没有可读的开页标志位
    expect(Object.keys(n).sort()).toEqual(["body", "title"]);
  });
});

// ---------- 第八轮 L2-01：「放弃自动暂存」闸的计数口径（纯函数这一半；与 main.js 的接线在 failure-kinds 的 ③e）----------
// 背景：退避只读 notBefore、不读 failures，对 2 小时轮询基本无效（见下面「轮询节奏」），所以「未归类失败」（dmg 下载 502 / 不完整、
// hdiutil / ditto 失败、找不到 .app……）每轮询一次就整包重下一遍 dmg。闸按 failures 的口径设：同一版本累计 ≥ 3 次（成功暂存 / 换版本才清零，不要求严格连续）就不再自动暂存。
// 只数「会白下 dmg 的失败」：Unavailable（清单 503 / 超时 / 网络…）在下载之前就败、只花几百字节，若也计入，3 次 503 就会停掉轮询、
// 废掉 F1-01「网络恢复后自愈」；永久失败另有 macVerifyFailedVersion。
describe("L2-01 isCostlyStageFailure / nextCostlyFailureRecord / shouldGiveUpAutoStage：闸只数「会白下 dmg 的失败」", () => {
  it("阈值复用「多次失败」提示框的 REPEATED_FAILURE_PROMPT_AFTER（同一个常量、不是另起一个数）", () => {
    expect(STAGE_GIVE_UP_AFTER).toBe(REPEATED_FAILURE_PROMPT_AFTER);
    expect(STAGE_GIVE_UP_AFTER).toBe(3);
  });

  it("未归类失败（dmg 下载 502 / 不完整 / hdiutil / ditto / 找不到 .app）与非 Error 值计入", () => {
    for (const v of [
      new Error("下载失败 HTTP 502"),
      new Error("dmg 下载不完整（1/2 字节）、已中止暂存"),
      new Error("Command failed: hdiutil attach"),
      new Error("Command failed: ditto ENOSPC"),
      new Error("dmg 里没找到 .app"),
      new TypeError("t"),
      "string",
      null,
      undefined,
      { name: "UpdateVerifyMismatchError" }, // 不能靠 name 冒充验签类
    ]) {
      expect(isCostlyStageFailure(v), String(v)).toBe(true);
    }
  });

  it("Unavailable（清单阶段：5xx / 限流 / 超时 / 网络 / 正文不是清单 / 过大 / 结构非法 / 公钥）不计入——它们在下载 dmg 之前就败了", () => {
    for (const code of [
      "manifest-http",
      "manifest-network",
      "manifest-parse",
      "manifest-too-large",
      "manifest-invalid",
      "public-key",
    ]) {
      expect(isCostlyStageFailure(new UpdateVerifyUnavailableError("某个暂时性失败", code)), code).toBe(false);
    }
  });

  it("例外：Unavailable 的 local-io（dmg 已下完才在本地读盘失败）计入——它花掉过一次整包下载（main.js verifyDownloadedUpdate 在下载之后才 stat / 算哈希）", () => {
    expect(isCostlyStageFailure(new UpdateVerifyUnavailableError("读取已下载的安装包失败：EBUSY", "local-io"))).toBe(true);
  });

  it("永久失败（确定不符 / 没带 manifest）不计入：它们走 macVerifyFailedVersion 永久跳过，不归这个闸管", () => {
    expect(isCostlyStageFailure(new UpdateVerifyMismatchError("sha", "sha256"))).toBe(false);
    expect(isCostlyStageFailure(new UpdateVerifyManifestMissingError("没带清单", "manifest-missing"))).toBe(false);
  });

  const costly = () => new Error("下载失败 HTTP 502");
  const cheap = () => new UpdateVerifyUnavailableError("503", "manifest-http");
  /** 对同一版本依次记录若干次失败（真实函数累计，不手写字段） */
  const record = (errs: Array<() => unknown>, version = V) => {
    let r: ReturnType<typeof nextCostlyFailureRecord> = null;
    for (const mk of errs) r = nextCostlyFailureRecord(r, version, mk());
    return r;
  };

  it("同版本累计：每次计入的失败 +1；记录里只有 { version, count }", () => {
    expect(record([costly])).toEqual({ version: V, count: 1 });
    expect(record([costly, costly])).toEqual({ version: V, count: 2 });
    expect(record([costly, costly, costly])).toEqual({ version: V, count: 3 });
  });

  it("不计入的失败：既不 +1 也不清零（原样返回上一份记录，包括 null）——503 穿插在中间不影响累计（是「累计 3 次」，不是严格连续）", () => {
    expect(nextCostlyFailureRecord(null, V, cheap())).toBeNull();
    const two = record([costly, costly]);
    expect(nextCostlyFailureRecord(two, V, cheap())).toBe(two); // 同一个对象
    expect(record([costly, cheap, costly, cheap, costly])).toEqual({ version: V, count: 3 });
  });

  it("第九轮复核的实测序列：2 次未归类 + 5 个 503 + 1 次未归类 → 就触发（所以文档 / 注释写「累计 3 次」、不是「连续 3 次」）", () => {
    const r = record([costly, costly, cheap, cheap, cheap, cheap, cheap, costly]);
    expect(r).toEqual({ version: V, count: 3 });
    expect(shouldGiveUpAutoStage(r, V)).toBe(true);
    // 对照：只有 2 次未归类、其后全是 503 → 不触发（503 不会把它推过线）
    expect(shouldGiveUpAutoStage(record([costly, costly, cheap, cheap, cheap, cheap, cheap]), V)).toBe(false);
  });

  it("换版本：旧版本的计数不带过来；换版本后遇到不计入的失败也不会把旧版本的记录算到新版本头上", () => {
    const old = record([costly, costly], "9.10.0");
    expect(nextCostlyFailureRecord(old, V, costly())).toEqual({ version: V, count: 1 });
    // 新版本的第一次失败是 503：记录仍是旧版本的（调用方只会拿 version 相等的记录去判），不会误算
    expect(shouldGiveUpAutoStage(nextCostlyFailureRecord(old, V, cheap()), V)).toBe(false);
  });

  it("不修改传入的旧记录（纯函数）", () => {
    const r1 = record([costly]);
    const snapshot = { ...r1 };
    nextCostlyFailureRecord(r1, V, costly());
    expect(r1).toEqual(snapshot);
  });

  it.each([
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [50, true],
  ])("该版本累计 %i 次计入的失败 → 放弃自动暂存=%s", (n, expected) => {
    expect(shouldGiveUpAutoStage(record(Array.from({ length: n }, () => costly)), V)).toBe(expected);
  });

  it("记录是别的版本的 / 没有记录：不放弃（换版本自动解除）", () => {
    expect(shouldGiveUpAutoStage(record([costly, costly, costly, costly], "9.10.0"), V)).toBe(false);
    expect(shouldGiveUpAutoStage(null, V)).toBe(false);
    expect(shouldGiveUpAutoStage(undefined, V)).toBe(false);
  });
});

describe("verifyRetryDelayMs：BASE × 2^(n-1)，封顶 MAX", () => {
  it.each([
    [1, 5 * MIN],
    [2, 10 * MIN],
    [3, 20 * MIN],
    [4, 40 * MIN],
    [5, 80 * MIN],
    [6, 120 * MIN], // 160 分钟被封顶到 2 小时
    [7, 120 * MIN],
    [50, 120 * MIN],
    [10_000, 120 * MIN], // 2 ** 9999 = Infinity，也要收敛到上限、不是 NaN / Infinity
  ])("第 %i 次失败 → %i ms", (n, expected) => {
    expect(verifyRetryDelayMs(n)).toBe(expected);
  });

  it.each([0, -3, Number.NaN, undefined, null, "abc", 1.9])("异常入参 %s 不炸、按第 1 次处理（1.9 向下取整为 1）", (n) => {
    expect(verifyRetryDelayMs(n as number)).toBe(5 * MIN);
  });
});

describe("nextVerifyRetry：同版本累计、换版本重置", () => {
  const NOW = 1_800_000_000_000;

  it("首次失败：failures=1，notBefore = now + 5 分钟", () => {
    expect(nextVerifyRetry(null, V, NOW)).toEqual({ version: V, failures: 1, notBefore: NOW + 5 * MIN });
    expect(nextVerifyRetry(undefined, V, NOW)).toEqual({ version: V, failures: 1, notBefore: NOW + 5 * MIN });
  });

  it("同版本连续失败：次数累计、退避翻倍；用的是「这次失败的时刻」重新起算", () => {
    const r1 = nextVerifyRetry(null, V, NOW);
    const r2 = nextVerifyRetry(r1, V, NOW + 6 * MIN);
    expect(r2).toEqual({ version: V, failures: 2, notBefore: NOW + 6 * MIN + 10 * MIN });
    const r3 = nextVerifyRetry(r2, V, NOW + 20 * MIN);
    expect(r3).toEqual({ version: V, failures: 3, notBefore: NOW + 20 * MIN + 20 * MIN });
  });

  it("换了版本：旧版本的失败次数不带过来（不拖累新版本）", () => {
    const old = nextVerifyRetry(nextVerifyRetry(null, V, NOW), V, NOW);
    expect(old.failures).toBe(2);
    expect(nextVerifyRetry(old, "9.10.0", NOW)).toEqual({
      version: "9.10.0",
      failures: 1,
      notBefore: NOW + 5 * MIN,
    });
  });

  it("不修改传入的旧记录（纯函数）", () => {
    const r1 = nextVerifyRetry(null, V, NOW);
    const snapshot = { ...r1 };
    nextVerifyRetry(r1, V, NOW + MIN);
    expect(r1).toEqual(snapshot);
  });
});

describe("isVerifyRetryBlocked：此刻是否还在退避期", () => {
  const NOW = 1_800_000_000_000;
  const retry = { version: V, failures: 1, notBefore: NOW + 5 * MIN };

  it("没有记录 / 别的版本的记录：不拦", () => {
    expect(isVerifyRetryBlocked(null, V, NOW)).toBe(false);
    expect(isVerifyRetryBlocked(undefined, V, NOW)).toBe(false);
    expect(isVerifyRetryBlocked(retry, "9.10.0", NOW)).toBe(false);
  });

  it("退避期内拦、到点（now === notBefore）起放行、过了更放行", () => {
    expect(isVerifyRetryBlocked(retry, V, NOW)).toBe(true);
    expect(isVerifyRetryBlocked(retry, V, NOW + 5 * MIN - 1)).toBe(true);
    expect(isVerifyRetryBlocked(retry, V, NOW + 5 * MIN)).toBe(false);
    expect(isVerifyRetryBlocked(retry, V, NOW + 60 * MIN)).toBe(false);
  });

  it("时钟被往回拨：剩余超过上限视为漂移、放行；恰好等于上限仍算合法退避", () => {
    const capped = { version: V, failures: 9, notBefore: NOW + VERIFY_RETRY_MAX_MS };
    expect(isVerifyRetryBlocked(capped, V, NOW)).toBe(true); // 剩余 = 上限，合法
    expect(isVerifyRetryBlocked(capped, V, NOW - 1)).toBe(false); // 剩余 > 上限，只可能是时钟回拨
    expect(isVerifyRetryBlocked(retry, V, NOW - 24 * 60 * MIN)).toBe(false);
  });
});

describe("轮询节奏：退避对 2h 轮询到底管不管用（第六轮 R6-5 实证；只做特征化、没有改代码）", () => {
  // 背景：以前的注释让人以为退避在保护 2h 轮询。实际：退避主要挡「非轮询触发」的自动暂存（设置页检查更新）。
  // 这里用真实的 nextVerifyRetry / isVerifyRetryBlocked 模拟「每 2h 一次轮询、每次都因暂时性失败而失败」，
  // 纯数值推演、不起定时器、不等待。
  // 轮询触发后，失败发生在 delta 毫秒之后（取版本号 / 取清单要耗时）；setInterval 自身有 lag 毫秒漂移。
  const POLL_MS = 2 * 60 * MIN; // main.js 的 UPDATE_POLL_MS
  /** 返回每一轮的结果：F = 这一轮真的去暂存了（并失败）；B = 这一轮被退避跳过 */
  const simulate = (delta: number, polls: number, lag = 5): string => {
    let retry: ReturnType<typeof nextVerifyRetry> | null = null;
    let out = "";
    for (let k = 0; k < polls; k++) {
      const tick = k * (POLL_MS + lag);
      if (isVerifyRetryBlocked(retry, V, tick)) {
        out += "B";
        continue;
      }
      retry = nextVerifyRetry(retry, V, tick + delta);
      out += "F";
    }
    return out;
  };

  it("纯轮询、失败紧跟触发（delta ≤ 10 分钟）时：前 5 次连续失败的退避（5/10/20/40/80 分钟）都短于轮询周期、下一轮照样放行——退避对轮询基本无效（不是「必然」，见下一条 L2-04）", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(verifyRetryDelayMs(n), `第 ${n} 次`).toBeLessThan(POLL_MS);
    }
    // 失败晚于轮询触发 0 / 半秒 / 30s 超时 / 10 分钟（后者是「先下完 dmg 才在本地读文件失败」的上界）：这几个取值下前 6 轮都放行
    for (const delta of [0, 500, 30_000, 10 * MIN]) {
      // 前 6 轮：第 1 轮无记录，第 2~6 轮分别紧跟第 1~5 次失败——全部都真的去暂存了
      expect(simulate(delta, 6).slice(0, 6), `delta=${delta}`).toBe("FFFFFF");
    }
  });

  // 第八轮 L2-04：上一条的旧标题写「必然放行」，说过头了。放行与否只取决于「最近一次失败发生的时刻 + 该次退避」是否 ≤ 下一次轮询到点的时刻；
  // 失败发生得晚（下载耗时长、或点徽标 / 设置页「检查更新」在两次轮询之间的任意时刻失败——这些失败同样累计、同样推后 notBefore）就会被挡。
  // 全部用真实的 nextVerifyRetry / isVerifyRetryBlocked 算，不手写 notBefore。
  describe("L2-04 退避挡不挡轮询：判据是「失败时刻 + 退避 ≤ 下一次轮询时刻」", () => {
    /** 同版本已连败 k-1 次（时刻远在过去、不影响）、第 k 次败在 tFail，返回此刻的记录 */
    const afterKthFailureAt = (k: number, tFail: number) => {
      let r: ReturnType<typeof nextVerifyRetry> | null = null;
      for (let i = 0; i < k - 1; i++) r = nextVerifyRetry(r, V, -10 * POLL_MS + i);
      return nextVerifyRetry(r, V, tFail);
    };

    it("实证反例（审查方 L2-04）：5 次失败、最后一次发生在 45 分钟时 → notBefore=125 分钟，120 分钟的轮询仍被挡", () => {
      // 前 4 次发生在 0 / 6 / 17 / 38 分钟（每次都已过上一次退避），第 5 次是用户点徽标 / 设置页检查更新在 45 分钟时失败
      let r: ReturnType<typeof nextVerifyRetry> | null = null;
      for (const m of [0, 6, 17, 38, 45]) r = nextVerifyRetry(r, V, m * MIN);
      expect(r).toEqual({ version: V, failures: 5, notBefore: 125 * MIN });
      expect(isVerifyRetryBlocked(r, V, POLL_MS)).toBe(true);
    });

    it.each([1, 2, 3, 4, 5])(
      "第 %i 次失败（退避 < 轮询周期）：失败时刻 ≤ 轮询时刻 − 退避 → 放行；晚 1 毫秒 → 被挡（即失败耗时 delta 超过 2h − 退避 就挡）",
      (k) => {
        const delay = verifyRetryDelayMs(k);
        expect(delay).toBeLessThan(POLL_MS);
        const latestPassing = POLL_MS - delay; // 此刻失败，notBefore 恰好 = 轮询时刻
        expect(isVerifyRetryBlocked(afterKthFailureAt(k, latestPassing), V, POLL_MS)).toBe(false);
        expect(isVerifyRetryBlocked(afterKthFailureAt(k, latestPassing + 1), V, POLL_MS)).toBe(true);
        // 对应的 delta 门槛：k=5 时只有 40 分钟（一次耗时超过 40 分钟的失败就能挡住下一轮轮询）
        if (k === 5) expect(latestPassing).toBe(40 * MIN);
      },
    );

    it("封顶后（第 6 次起退避 = 轮询周期）：失败只要晚于轮询触发哪怕 1 毫秒就挡下一轮；恰好同刻才放行", () => {
      for (const k of [6, 7, 20]) {
        expect(verifyRetryDelayMs(k)).toBe(POLL_MS);
        expect(isVerifyRetryBlocked(afterKthFailureAt(k, 0), V, POLL_MS), `k=${k} delta=0`).toBe(false);
        expect(isVerifyRetryBlocked(afterKthFailureAt(k, 1), V, POLL_MS), `k=${k} delta=1ms`).toBe(true);
      }
    });
  });

  it("已知局限（特征化、有意不改）：封顶后（连续失败 ≥ 6 次）退避 = 轮询周期，而失败晚于轮询触发 → 下一轮被跳过、轮询变成隔轮重试", () => {
    // 失败总发生在轮询触发之后（delta > lag）：notBefore = 触发 + delta + 120 分钟，比下一次触发晚「delta - lag」
    const pattern = simulate(500, 20);
    expect(pattern).toBe("FFFFFF" + "BF".repeat(7));
    // 若将来把上限调到轮询周期以下 / 给退避加抖动，这条应改成「每轮都放行」——那是一个独立的决策
    expect(verifyRetryDelayMs(6)).toBe(POLL_MS);
  });
});
