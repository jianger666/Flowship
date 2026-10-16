/**
 * 验签失败的「类型 → 处置」纯函数（electron-app/update-manifest-verify.mjs 的 buildVerifyRejectionNotice）
 * ——第六轮审查 R6-5：mac 更新失败的处置没和 Windows 对齐
 *
 * 旧行为：mac 的 runUpdateCheck 对**任何**暂存失败都弹「未通过完整性校验」+ 开发布页 + 用掉该版本唯一一次提示
 * （wasPrompted）；一次 503 就让用户看到误导性弹框。Windows 的 rejectUnverifiedWinUpdate 早就按类型分三路。
 *
 * 新约定：同一个纯函数同时服务两个平台，差别只在**触发方式**：
 * - trigger "user"（默认）：用户点了徽标触发的流程（Windows 全流程都是——autoDownload=false）。
 *   用户在等结果，所以三类都弹框；开发布页只给「确定不符」与「没带清单」；不走「每版本一次」的去重；
 * - trigger "background"：2h 轮询 / 启动检查触发的 mac 自动暂存，没人在等。
 *   暂时性失败不弹框、不开发布页、不消耗提示名额（交给 2h 轮询自愈）；
 *   确定不符 / 没带清单照旧弹框 + 开发布页 + 记提示，且同一版本只提示一次（alreadyPrompted 时全部静默）。
 *
 * 与 main.js 的真实接线（mac：runUpdateCheck 真实函数体；Windows：rejectUnverifiedWinUpdate 真实函数体）
 * 在 tests/update-manifest-failure-kinds.test.ts 的 ③b / ③e。
 */
import { describe, expect, it } from "vitest";

import {
  UpdateVerifyManifestMissingError,
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  buildGenericUpdateFailureNotice,
  buildVerifyRejectionNotice,
  isVerifyFailure,
} from "../electron-app/update-manifest-verify.mjs";

const mismatch = () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
const missing = () =>
  new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing");
const unavailable = () =>
  new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");

describe("trigger=background（mac 轮询自动暂存）：三类失败各一条处置", () => {
  const opts = { trigger: "background" as const, alreadyPrompted: false };

  it("确定不符：弹框 + 开发布页 + 记提示；标题 / 正文就是 notice 的", () => {
    const n = buildVerifyRejectionNotice(mismatch(), opts);
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(true);
    expect(n.markPrompted).toBe(true);
    expect(n.stateError).toBe("安装包 SHA-256 校验失败、已中止替换");
    expect(n.title).toBe("自动更新已中止");
    expect(n.body).toContain("SHA-256 校验失败");
    expect(n.body).toContain("手动下载");
    // 原有字段不丢（rejectUnverifiedWinUpdate 靠它们决定删缓存 / 登记保留）
    expect(n.definitive).toBe(true);
    expect(n.manifestMissing).toBe(false);
  });

  it("没带 manifest（404 / 410）：弹框 + 开发布页 + 记提示；文案说「暂不支持自动校验」而不是「检查网络」", () => {
    const n = buildVerifyRejectionNotice(missing(), opts);
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(true);
    expect(n.markPrompted).toBe(true);
    expect(n.stateError).toBe("该版本没有附带更新校验清单（HTTP 404）、已中止替换");
    expect(n.title).toBe("该版本暂不支持自动校验");
    expect(n.body).toContain("HTTP 404");
    expect(n.body).not.toContain("检查网络");
    expect(n.manifestMissing).toBe(true);
    expect(n.definitive).toBe(false);
  });

  it("暂时性失败：不弹框、不开发布页、不消耗提示名额；错误文案仍交给 updateState.error", () => {
    const n = buildVerifyRejectionNotice(unavailable(), opts);
    expect(n.showDialog).toBe(false);
    expect(n.openReleasePage).toBe(false);
    expect(n.markPrompted).toBe(false);
    expect(n.stateError).toBe("更新 manifest 下载失败 HTTP 503、已中止替换");
    expect(n.definitive).toBe(false);
    expect(n.manifestMissing).toBe(false);
  });

  it("未归类错误 / 非 Error 值与暂时性同口径（宁可少弹也不拿误导性文案吓人）", () => {
    for (const v of [new Error("下载失败 HTTP 502"), new TypeError("fetch failed"), "字符串错误", null, undefined]) {
      const n = buildVerifyRejectionNotice(v, opts);
      expect(n.showDialog, String(v)).toBe(false);
      expect(n.openReleasePage, String(v)).toBe(false);
      expect(n.markPrompted, String(v)).toBe(false);
    }
    expect(buildVerifyRejectionNotice("字符串错误", opts).stateError).toBe("字符串错误");
  });

  it("该版本已提示过：确定不符 / 没带清单也全部静默（不重复弹、不重复开页、不重复记）；错误文案照常给", () => {
    const alreadyPrompted = { trigger: "background" as const, alreadyPrompted: true };
    for (const err of [mismatch(), missing()]) {
      const n = buildVerifyRejectionNotice(err, alreadyPrompted);
      expect(n.showDialog, err.name).toBe(false);
      expect(n.openReleasePage, err.name).toBe(false);
      expect(n.markPrompted, err.name).toBe(false);
      expect(n.stateError, err.name).toBe(err.message);
    }
  });

  it("分流只看类型、不看文案：Unavailable 的文案写「SHA-256 校验失败」仍然静默；Mismatch 的文案平淡仍然弹", () => {
    const quietLooksScary = buildVerifyRejectionNotice(
      new UpdateVerifyUnavailableError("签名校验失败 SHA-256 不符（只是措辞撞车）", "manifest-http"),
      opts,
    );
    expect(quietLooksScary.showDialog).toBe(false);
    const loudLooksPlain = buildVerifyRejectionNotice(new UpdateVerifyMismatchError("随便一句话", "size"), opts);
    expect(loudLooksPlain.showDialog).toBe(true);
    expect(loudLooksPlain.openReleasePage).toBe(true);
  });
});

describe("trigger=user（Windows 点徽标后的验签；默认值）：处置与改造前完全一致", () => {
  const user = { trigger: "user" as const };

  it("确定不符：弹框 + 开发布页；不走去重（markPrompted=false）", () => {
    const n = buildVerifyRejectionNotice(mismatch(), user);
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(true);
    expect(n.markPrompted).toBe(false);
    expect(n.stateError).toBe(mismatch().message);
  });

  it("没带 manifest：弹框 + 开发布页；不走去重", () => {
    const n = buildVerifyRejectionNotice(missing(), user);
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(true);
    expect(n.markPrompted).toBe(false);
    expect(n.stateError).toBe(missing().message);
  });

  it("暂时性失败：仍然弹框（用户刚点了徽标、在等结果）但不开发布页；不走去重", () => {
    // fileState "kept" = Windows 的真实情形（缓存包保留在磁盘上）；mac 不保留 dmg，口径见下面 K3-06 的用例
    const n = buildVerifyRejectionNotice(unavailable(), { ...user, fileState: "kept" });
    expect(n.showDialog).toBe(true);
    expect(n.openReleasePage).toBe(false);
    expect(n.markPrompted).toBe(false);
    expect(n.title).toBe("暂时无法校验更新包");
    expect(n.body).toContain("保留");
    expect(n.stateError).toBe(unavailable().message);
  });

  it("alreadyPrompted 对用户显式触发的流程无效：点一次反馈一次、绝不静默吞掉", () => {
    for (const err of [mismatch(), missing(), unavailable()]) {
      const n = buildVerifyRejectionNotice(err, { trigger: "user", alreadyPrompted: true });
      expect(n.showDialog, err.name).toBe(true);
    }
  });

  it("不传 opts / 不认识的 trigger 都按 user 处理（保守：宁可多反馈也不吞错误）；与显式 user 结果一致", () => {
    for (const err of [mismatch(), missing(), unavailable()]) {
      const explicit = buildVerifyRejectionNotice(err, user);
      expect(buildVerifyRejectionNotice(err), err.name).toEqual(explicit);
      expect(
        buildVerifyRejectionNotice(err, { trigger: "bogus" as unknown as "user" }),
        err.name,
      ).toEqual(explicit);
      expect(buildVerifyRejectionNotice(err, {}), err.name).toEqual(explicit);
    }
  });
});

// ---------- 第七轮 K3-06：弹框正文要对得上「实际对已下载文件做了什么」 ----------
// 背景：以前 definitive 分支恒说「已取消自动安装并清除下载的文件」。但清单级 Mismatch（signature / version / entry-missing）
// 在 mac 上发生在**下载 dmg 之前**（loadSignedManifest 先于下载）——根本没有文件可清。
// 真实行为按平台不同：
//  - mac：清单级 → 没下载、没删；文件级（size / sha256）→ dmg 已下完、finally 里一定会删；暂时性失败 → dmg 同样不保留；
//  - Windows：update-downloaded 之后才验签，exe 已在缓存里——确定不符（含清单级）rejectUnverifiedWinUpdate 都会删；
//    暂时性失败保留缓存；删不掉 / 没有 file 时则没删。
// 所以文案由 code（说「哪一步没过」）+ opts.fileState（说「文件怎么样了」）决定：fileState 缺省按 mac 口径推，Windows 显式传真实结果。
describe("K3-06：确定不符的弹框正文按 code 区分，并与已下载文件的真实处置对得上", () => {
  const manifestLevel: Array<[string, string]> = [
    ["signature", "更新 manifest 签名校验失败、已中止替换"],
    ["version", "manifest 版本不符（9.9.8 ≠ 9.9.9）、已中止替换"],
    ["entry-missing", "manifest 里没有 fe-ai-flow-9.9.9-mac-arm64.dmg 的摘要、已中止替换"],
  ];
  const fileLevel: Array<[string, string]> = [
    ["size", "安装包大小不符（1 ≠ 2）、已中止替换"],
    ["sha256", "安装包 SHA-256 校验失败（内容被篡改 / 传输损坏）、已中止替换"],
    ["pending-file", "待安装的文件与已验签的文件不一致、已中止安装"],
  ];
  const triggers = [
    ["user", { trigger: "user" as const }],
    ["background", { trigger: "background" as const, alreadyPrompted: false }],
  ] as const;

  it.each(manifestLevel)(
    "清单级（%s）、默认（mac 口径：清单发生在下载之前）：不提「清除」——没有下载过任何文件；仍给手动下载入口",
    (code, message) => {
      for (const [label, opts] of triggers) {
        const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError(message, code), opts);
        expect(n.definitive, label).toBe(true);
        expect(n.title, label).toBe("自动更新已中止");
        expect(n.body, label).toContain(message);
        expect(n.body, label).toContain("更新校验清单"); // 说清「哪一步没过」：是清单、不是安装包
        expect(n.body, label).toContain("已取消自动安装");
        expect(n.body, label).not.toContain("清除");
        expect(n.body, label).not.toContain("下载的文件");
        expect(n.body, label).toContain("下载页");
        expect(n.openReleasePage, label).toBe(true);
      }
    },
  );

  it.each(fileLevel)(
    "文件级（%s）、默认：下载下来的安装包确实被清掉了 → 说「清除下载的文件」，并说清是安装包没通过校验",
    (code, message) => {
      for (const [label, opts] of triggers) {
        const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError(message, code), opts);
        expect(n.body, label).toContain(message);
        expect(n.body, label).toContain("安装包没有通过完整性校验");
        expect(n.body, label).toContain("已取消自动安装并清除下载的文件");
        expect(n.body, label).not.toContain("更新校验清单");
        expect(n.body, label).toContain("下载页");
      }
    },
  );

  it("Windows 显式传 fileState：清单级但 exe 已被 rejectUnverifiedWinUpdate 删掉（cleared）→ 要说「清除下载的文件」（文案由真实动作决定、不由 code 一刀切）", () => {
    for (const [code, message] of manifestLevel) {
      const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError(message, code), {
        trigger: "user",
        fileState: "cleared",
      });
      expect(n.body, code).toContain("更新校验清单"); // 哪一步没过仍由 code 决定
      expect(n.body, code).toContain("已取消自动安装并清除下载的文件"); // 文件怎么样了由 fileState 决定
    }
  });

  it("Windows 删缓存失败（被杀软占用）/ 没有 file：fileState 是 kept / none → 不得声称「已清除」", () => {
    for (const fileState of ["kept", "none"] as const) {
      for (const [code, message] of [...manifestLevel, ...fileLevel]) {
        const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError(message, code), {
          trigger: "user",
          fileState,
        });
        expect(n.body, `${code}/${fileState}`).toContain("已取消自动安装");
        expect(n.body, `${code}/${fileState}`).not.toContain("清除");
      }
    }
  });

  it("不认识的 fileState 当没传（按 code 推 mac 口径）——不会因拼写错误把文案带歪", () => {
    const err = () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
    const bogus = buildVerifyRejectionNotice(err(), { trigger: "user", fileState: "wat" as never });
    expect(bogus).toEqual(buildVerifyRejectionNotice(err(), { trigger: "user" }));
  });

  it("文案变化只动 body：处置标志位（definitive / openReleasePage / showDialog / markPrompted）与 code、fileState 无关", () => {
    for (const [code, message] of [...manifestLevel, ...fileLevel]) {
      for (const fileState of [undefined, "cleared", "kept", "none"] as const) {
        const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError(message, code), {
          trigger: "background",
          alreadyPrompted: false,
          fileState,
        });
        expect(n.definitive, `${code}/${fileState}`).toBe(true);
        expect(n.openReleasePage, `${code}/${fileState}`).toBe(true);
        expect(n.showDialog, `${code}/${fileState}`).toBe(true);
        expect(n.markPrompted, `${code}/${fileState}`).toBe(true);
      }
    }
  });

  it("暂时性 / 未归类失败的正文：只有 Windows 真的保留了缓存（fileState=kept）才说「已下载的安装包已保留」；mac 的 dmg 不保留、不能这么说", () => {
    for (const err of [unavailable(), new Error("下载失败 HTTP 502")]) {
      // mac 口径（缺省）：dmg 在 finally 里一定删、清单类失败时根本没下载——不得声称「已保留」
      const mac = buildVerifyRejectionNotice(err, { trigger: "user" });
      expect(mac.body).not.toContain("保留");
      expect(mac.body).toContain("请检查网络后在更新徽标上重试");
      // Windows：缓存包确实留在磁盘上（下次点徽标直接重验）
      const win = buildVerifyRejectionNotice(err, { trigger: "user", fileState: "kept" });
      expect(win.body).toContain("已下载的安装包已保留");
      // Windows 但没有 file 可保留
      const none = buildVerifyRejectionNotice(err, { trigger: "user", fileState: "none" });
      expect(none.body).not.toContain("保留");
    }
  });

  it("没带 manifest 的正文本来就不提缓存 / 清除（保持原样）", () => {
    for (const fileState of [undefined, "kept", "cleared", "none"] as const) {
      const n = buildVerifyRejectionNotice(missing(), { trigger: "user", fileState });
      expect(n.body).not.toContain("清除");
      expect(n.body).not.toContain("保留");
      expect(n.body).toContain("手动下载");
    }
  });
});

// ---------- 第七轮 K3-04：mac 点徽标（macSelfUpdate）要能区分「验签类」与「其余失败」 ----------
describe("isVerifyFailure：是不是「验签类」失败（确定不符 / 暂时无法校验，含没带清单）", () => {
  it("三类验签错误都是；未归类 Error / 非 Error 值 / 鸭子类型都不是", () => {
    expect(isVerifyFailure(mismatch())).toBe(true);
    expect(isVerifyFailure(unavailable())).toBe(true);
    expect(isVerifyFailure(missing())).toBe(true); // Unavailable 的子类
    for (const v of [
      new Error("下载失败 HTTP 502"),
      new Error("dmg 里没找到 .app"),
      new TypeError("t"),
      "string",
      null,
      undefined,
      { name: "UpdateVerifyMismatchError" }, // 不能靠 name 冒充
      { code: "sha256" },
    ]) {
      expect(isVerifyFailure(v), String(v)).toBe(false);
    }
  });
});

// ---------- 第八轮 L2-02：非验签类失败（ditto 磁盘满 / dmg 502 / hdiutil……）不能套「暂时无法校验更新包」----------
// 现状（本轮不改）：buildVerifyRejectionNotice 对非验签类错误仍给「暂时无法校验更新包 / 这不代表安装包有问题——请检查网络后…」——
// 这是 Windows 门禁里未归类错误（找不到文件名 / 版本号异常）的既有口径，上面 K3-06 的用例钉着它，Windows 不在 L2-02 范围内。
// mac 点徽标（macSelfUpdate）与设置页「检查更新」触发的暂存失败（handleMacStageFailure, trigger=user）对非验签类失败改用下面这个共用函数。
describe("L2-02 buildGenericUpdateFailureNotice：非验签类失败的通用提示（mac 点徽标与设置页检查更新共用，不再各抄一份文案）", () => {
  it("标题「自动更新失败」、正文 = 原因 + 「将打开下载页、请手动下载安装」，要开发布页（文案说了要打开、标志位就必须真的开）", () => {
    const n = buildGenericUpdateFailureNotice(new Error("Command failed: ditto ENOSPC"));
    expect(n.title).toBe("自动更新失败");
    expect(n.body).toBe("Command failed: ditto ENOSPC\n\n将打开下载页、请手动下载安装。");
    expect(n.openReleasePage).toBe(true);
    expect(n.showDialog).toBe(true);
  });

  it("不套验签文案：正文里没有「暂时无法校验」「不代表安装包有问题」「检查网络」", () => {
    const n = buildGenericUpdateFailureNotice(new Error("下载失败 HTTP 502"));
    expect(n.title).not.toContain("校验");
    expect(n.body).not.toContain("暂时无法校验");
    expect(n.body).not.toContain("不代表安装包有问题");
    expect(n.body).not.toContain("检查网络");
  });

  it("与 notice 同形：标志位齐全、不消耗「每版本一次」名额（markPrompted=false）、不是确定不符 / 没带清单；stateError / reason = 原因", () => {
    const n = buildGenericUpdateFailureNotice(new Error("dmg 里没找到 .app"));
    expect(n).toMatchObject({
      definitive: false,
      manifestMissing: false,
      markPrompted: false,
      stateError: "dmg 里没找到 .app",
      reason: "dmg 里没找到 .app",
    });
  });

  it("原因取法与 macSelfUpdate 原写法一致（`err?.message || err`）：非 Error 值、空 message 都不炸", () => {
    expect(buildGenericUpdateFailureNotice("字符串错误").body).toBe("字符串错误\n\n将打开下载页、请手动下载安装。");
    expect(buildGenericUpdateFailureNotice({ message: "带 message 的对象" }).reason).toBe("带 message 的对象");
    expect(buildGenericUpdateFailureNotice(null).reason).toBe("null");
    expect(buildGenericUpdateFailureNotice(undefined).reason).toBe("undefined");
    // 空 message：退回 String(err)（"Error"），不是空串——弹框正文不能只剩「将打开下载页」
    expect(buildGenericUpdateFailureNotice(new Error("")).reason).toBe("Error");
  });
});
