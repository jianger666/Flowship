/**
 * Windows 更新验签失败分流（N2-02）：确定不符才删缓存包，暂时拿不到清单一律保留
 *
 * 旧实现：验签任何一步 throw，`rejectUnverifiedWinUpdate` 都 `fs.rm` 掉 112MB 的已下载 exe——
 * 包括「manifest 下载超时 / 网络抖动 / HTTP 5xx」这类跟安装包本身毫无关系的短暂性失败，
 * 用户点一次徽标就白下一遍。修法：纯模块导出两类错误（按**类型**分流、不匹配文案）：
 * - UpdateVerifyMismatchError    确定不符（签名 / version / 条目缺失 / size / sha256）→ 删缓存 + 开发布页
 * - UpdateVerifyUnavailableError 暂时无法校验（没拿到清单 / 公钥读不了 / 本地读文件失败）→ 仍拒绝安装、保留缓存、
 *                                回 available 带错误，下次点徽标 electron-updater 复用缓存包重新验
 * 未归类的错误一律按「不删」处理（删文件是破坏性动作、只在有确凿证据时做）。
 *
 * 第四轮审查（M3）在此基础上追加三件事：
 * - M3-03：清单 404 / 410 = 该 release 没带 manifest（UpdateVerifyManifestMissingError，Unavailable 的子类）——
 *   保留缓存、仍拒绝安装（fail-closed），但弹「该版本暂不支持自动校验」并开发布页（降级手动下载）；
 *   5xx / 限流 / 超时 / 网络仍是「暂时无法校验」（不开发布页）；
 * - M3-05：点徽标时对「已保留的缓存」直接重验（不依赖 electron-updater 缓存命中时重发 update-downloaded），
 *   与 update-downloaded 事件共用 verifyAndMarkWinReady；
 * - M3-04：mac 同一版本验签失败后，2h 轮询 / 设置页检查更新不再自动重下 dmg，由用户点徽标重试。
 *
 * 分层测：① 纯模块的分类；② fetchUpdateManifest 的网络失败分类（stub fetch）；
 * ③ **真实执行 main.js 里的函数体**（rejectUnverifiedWinUpdate / verifyDownloadedUpdate / verifyAndMarkWinReady /
 * resumeRetainedWinInstaller / installUpdateNow / downloadAndStageMacUpdate / runUpdateCheck / manualCheckForUpdate）
 * （从源码切出来、注入 stub 依赖后 new Function 执行——main.js 一 import electron 就没法直接测，
 * 但这些函数只依赖注入得进来的东西，切出来跑比「grep 源码」可靠得多）。
 *
 * 回退自检（均已实测变红）：
 * - 把 main.js 里 `if (file && notice.definitive)` 的闸去掉 → ③b 的「保留缓存」用例红；
 * - 把 fetchUpdateManifest 里 HTTP / 网络失败改抛 Mismatch → ② 对应用例红；
 * - 把 404 / 410 判定关掉（归回 Unavailable）→ ② / ③c 的 manifest-missing 用例红；
 * - 去掉 installUpdateNow 里的 resumeRetainedWinInstaller 分支 → ③d 红；
 * - 去掉 runUpdateCheck / manualCheckForUpdate 里的 macVerifyFailedVersion 跳过 → ③e 红。
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UpdateVerifyManifestMissingError,
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  buildGenericUpdateFailureNotice,
  buildVerifyRejectionNotice,
  fetchUpdateManifest,
  findSignedManifestEntry,
  isDefinitiveVerifyFailure,
  isManifestMissingFailure,
  isVerifyFailure,
  verifyManifestEntry,
} from "../electron-app/update-manifest-verify.mjs";
import {
  buildRepeatedFailureNotice,
  isPermanentVerifyFailure,
  isVerifyRetryBlocked,
  nextCostlyFailureRecord,
  nextVerifyRetry,
  shouldGiveUpAutoStage,
  shouldPromptRepeatedFailure,
} from "../electron-app/update-verify-retry.mjs";
import { verifyWinPendingInstallerWith } from "../electron-app/win-pending-verify.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = "9.9.9";
const EXE = `fe-ai-flow-${VERSION}-win-x64.exe`;
const EXE_BYTES = "MZ-fake-exe-bytes-0123456789-abcdefghij";
const sha256Of = (s: string): string => createHash("sha256").update(s).digest("hex");

interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
}
const signManifest = (privateKey: KeyObject, version: string, files: ManifestFile[]) => ({
  version,
  files,
  signature: sign(null, Buffer.from(JSON.stringify({ version, files }), "utf8"), privateKey).toString(
    "base64",
  ),
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const FILES: ManifestFile[] = [
  { name: EXE, size: Buffer.byteLength(EXE_BYTES), sha256: sha256Of(EXE_BYTES) },
];
const goodManifest = () => signManifest(privateKey, VERSION, FILES.map((f) => ({ ...f })));

const catchErr = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛错但没有抛");
};
const catchAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛错但没有抛");
};

const verifyArgs = (over: Record<string, unknown> = {}) => ({
  manifest: goodManifest(),
  publicKeyPem: pubPem,
  version: VERSION,
  assetName: EXE,
  size: Buffer.byteLength(EXE_BYTES),
  sha256: sha256Of(EXE_BYTES),
  ...over,
});

describe("① 纯模块：判定失败的类型", () => {
  it("确定不符 → UpdateVerifyMismatchError（签名 / version / 条目缺失 / size / sha256 各带自己的 code）", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "签名被别人的私钥签",
        { manifest: signManifest(other.privateKey, VERSION, FILES.map((f) => ({ ...f }))) },
        "signature",
      ],
      ["签名为空", { manifest: { ...goodManifest(), signature: "" } }, "signature"],
      ["version 与签名内不同", { version: "9.9.10" }, "version"],
      ["manifest 里没有该条目", { assetName: "fe-ai-flow-9.9.9-win-arm64.exe" }, "entry-missing"],
      ["size 不符", { size: Buffer.byteLength(EXE_BYTES) + 1 }, "size"],
      ["sha256 不符", { sha256: "0".repeat(64) }, "sha256"],
    ];
    for (const [name, over, code] of cases) {
      const err = catchErr(() => verifyManifestEntry(verifyArgs(over)));
      expect(err, name).toBeInstanceOf(UpdateVerifyMismatchError);
      expect((err as UpdateVerifyMismatchError).code, name).toBe(code);
      expect(isDefinitiveVerifyFailure(err), name).toBe(true);
    }
  });

  it("findSignedManifestEntry（mac 先过的三道廉价检查）同样抛带类型的错", () => {
    const err = catchErr(() =>
      findSignedManifestEntry({
        manifest: goodManifest(),
        publicKeyPem: pubPem,
        version: VERSION,
        assetName: "nope.exe",
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((err as UpdateVerifyMismatchError).code).toBe("entry-missing");
  });

  it("拿到的根本不是 manifest（null / 字符串 / 数字）、壳内置公钥坏了 → UpdateVerifyUnavailableError（不能证明安装包有问题）", () => {
    for (const bad of [null, undefined, "string", 42]) {
      const err = catchErr(() => verifyManifestEntry(verifyArgs({ manifest: bad })));
      expect(err, String(bad)).toBeInstanceOf(UpdateVerifyUnavailableError);
      expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-invalid");
      expect(isDefinitiveVerifyFailure(err)).toBe(false);
    }
    const keyErr = catchErr(() => verifyManifestEntry(verifyArgs({ publicKeyPem: "not a pem" })));
    expect(keyErr).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((keyErr as UpdateVerifyUnavailableError).code).toBe("public-key");
  });

  // F1-04：200 + 任意 JSON 以前一路走到验签、签名对不上就抛 Mismatch，随后 rejectUnverifiedWinUpdate 删掉 112MB 缓存包
  // 并开发布页——但 `{}` / `{"message":"…"}` 这类正文只说明「这次没拿到清单」（代理错误页 / API 限流体 / 强制门户），
  // 与「取不到清单是暂时性」的口径矛盾。只有「形态完整的清单、签名验不过」才是确凿证据。
  const NON_MANIFEST_SHAPES: Array<[string, unknown]> = [
    ["空对象 {}", {}],
    ["GitHub / 代理的错误体 {message}", { message: "Not Found", documentation_url: "https://docs.github.com" }],
    ["限流体 {message, status}", { message: "API rate limit exceeded", status: "403" }],
    ["空数组 []", []],
    ["非空数组", [{ version: VERSION, files: [], signature: "abc" }]],
    ["缺 version", { files: [], signature: "abc" }],
    ["缺 files", { version: VERSION, signature: "abc" }],
    ["缺 signature", { version: VERSION, files: [] }],
    ["version 不是字符串", { version: 9, files: [], signature: "abc" }],
    ["version 为空串", { version: "", files: [], signature: "abc" }],
    ["files 不是数组（字符串）", { version: VERSION, files: "nope", signature: "abc" }],
    ["files 不是数组（对象）", { version: VERSION, files: {}, signature: "abc" }],
    ["signature 不是字符串", { version: VERSION, files: [], signature: 123 }],
    ["signature 为 null", { version: VERSION, files: [], signature: null }],
  ];

  it.each(NON_MANIFEST_SHAPES)(
    "F1-04：200 + 非清单形态（%s）→ UpdateVerifyUnavailableError(manifest-invalid)，不是 Mismatch、不允许删缓存",
    (_name, manifest) => {
      const full = catchErr(() => verifyManifestEntry(verifyArgs({ manifest })));
      const entry = catchErr(() =>
        findSignedManifestEntry({ manifest, publicKeyPem: pubPem, version: VERSION, assetName: EXE } as never),
      );
      for (const err of [full, entry]) {
        expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
        expect(err).not.toBeInstanceOf(UpdateVerifyMismatchError);
        expect(err).not.toBeInstanceOf(UpdateVerifyManifestMissingError); // 它没有 404 那种「重试不会好」的含义
        expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-invalid");
        expect(isDefinitiveVerifyFailure(err)).toBe(false);
        expect(isManifestMissingFailure(err)).toBe(false);
      }
    },
  );

  it("F1-04：形态完整的清单、签名验不过 → 仍是 Mismatch(signature)（确凿证据，才允许删缓存）", () => {
    const wellFormedButBad: Array<[string, unknown]> = [
      ["别人的私钥签名", signManifest(other.privateKey, VERSION, FILES.map((f) => ({ ...f })))],
      ["签名为空串", { ...goodManifest(), signature: "" }],
      ["签名是乱码", { ...goodManifest(), signature: "AAAA" }],
      ["files 被篡改（签名对不上）", { ...goodManifest(), files: [{ name: EXE, size: 1, sha256: "0".repeat(64) }] }],
      ["files 里是不合规的元素（形态仍完整、交给签名裁决）", { version: VERSION, files: [{}], signature: "abc" }],
      ["files 为空数组", { version: VERSION, files: [], signature: "abc" }],
    ];
    for (const [name, manifest] of wellFormedButBad) {
      const err = catchErr(() => verifyManifestEntry(verifyArgs({ manifest })));
      expect(err, name).toBeInstanceOf(UpdateVerifyMismatchError);
      expect((err as UpdateVerifyMismatchError).code, name).toBe("signature");
      expect(isDefinitiveVerifyFailure(err), name).toBe(true);
    }
  });

  it("F1-04：200 + 形态不像清单的 JSON（[] / {} / {message} / 缺或错类型的 version·files·signature）→ Unavailable(manifest-invalid)，不是 Mismatch", () => {
    // 为什么：强制门户 / 代理 / GitHub 的 JSON 错误体（{"message":"Not Found"}）也是 200 + 合法 JSON，
    // 以前只拦「非对象」，对象一律走到验签失败 → Mismatch → 删 112MB 缓存包 + 开发布页，
    // 与「取不到清单是暂时性」的口径矛盾；证明不了安装包有问题，就不能走破坏性分支
    const good = goodManifest();
    const without = (key: "version" | "files" | "signature") => {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      return copy;
    };
    const shapes: Array<[string, unknown]> = [
      ["空数组", []],
      ["数组里装着清单", [good]],
      ["空对象", {}],
      ["GitHub 错误体 {message}", { message: "Not Found", documentation_url: "https://docs.github.com" }],
      ["代理 / 门户 {error}", { error: "rate limited", retry_after: 60 }],
      ["缺 signature", without("signature")],
      ["缺 files", without("files")],
      ["缺 version", without("version")],
      ["version 是数字", { ...good, version: 9 }],
      ["version 是空串", { ...good, version: "" }],
      ["files 是对象", { ...good, files: {} }],
      ["files 是 null", { ...good, files: null }],
      ["signature 是 null", { ...good, signature: null }],
      ["signature 是数字", { ...good, signature: 1 }],
    ];
    for (const [name, manifest] of shapes) {
      const viaVerify = catchErr(() => verifyManifestEntry(verifyArgs({ manifest })));
      expect(viaVerify, `${name}（verifyManifestEntry）`).toBeInstanceOf(UpdateVerifyUnavailableError);
      expect((viaVerify as UpdateVerifyUnavailableError).code, name).toBe("manifest-invalid");
      expect(isDefinitiveVerifyFailure(viaVerify), name).toBe(false);
      expect(isManifestMissingFailure(viaVerify), name).toBe(false);

      // mac 先过三道廉价检查走的是另一个入口，必须同口径
      const viaFind = catchErr(() =>
        findSignedManifestEntry({ manifest, publicKeyPem: pubPem, version: VERSION, assetName: EXE }),
      );
      expect(viaFind, `${name}（findSignedManifestEntry）`).toBeInstanceOf(UpdateVerifyUnavailableError);
      expect((viaFind as UpdateVerifyUnavailableError).code, name).toBe("manifest-invalid");
    }
  });

  it("F1-04 反向：形态完整的清单（version 串 + files 数组 + signature 串）验不过签名才是 Mismatch——缩窄 Unavailable 不能放过真伪造", () => {
    const wellFormedButBadSignature: Array<[string, unknown]> = [
      ["别人私钥签的", signManifest(other.privateKey, VERSION, FILES.map((f) => ({ ...f })))],
      ["signature 是空串", { ...goodManifest(), signature: "" }],
      ["signature 不是合法 base64", { ...goodManifest(), signature: "!!!not-base64!!!" }],
      ["files 是空数组但签名对不上", { version: VERSION, files: [], signature: "AAAA" }],
      ["files 被改过", { ...goodManifest(), files: [{ ...FILES[0]!, size: FILES[0]!.size + 1 }] }],
    ];
    for (const [name, manifest] of wellFormedButBadSignature) {
      const err = catchErr(() => verifyManifestEntry(verifyArgs({ manifest })));
      expect(err, name).toBeInstanceOf(UpdateVerifyMismatchError);
      expect((err as UpdateVerifyMismatchError).code, name).toBe("signature");
      expect(isDefinitiveVerifyFailure(err), name).toBe(true);
    }
  });

  it("两个类都是 Error、互不为子类；只有 Mismatch 算「确定不符」，未归类的错误 / 非 Error 值一律不算", () => {
    const m = new UpdateVerifyMismatchError("x", "sha256");
    const u = new UpdateVerifyUnavailableError("y", "manifest-http");
    expect(m).toBeInstanceOf(Error);
    expect(u).toBeInstanceOf(Error);
    expect(u).not.toBeInstanceOf(UpdateVerifyMismatchError);
    expect(m).not.toBeInstanceOf(UpdateVerifyUnavailableError);
    expect(m.message).toBe("x");
    expect(isDefinitiveVerifyFailure(m)).toBe(true);
    for (const v of [u, new Error("boom"), new TypeError("t"), "string", null, undefined, { code: "sha256" }]) {
      expect(isDefinitiveVerifyFailure(v)).toBe(false);
    }
  });

  it("M3-03：「该 release 没带 manifest」是 Unavailable 的特例子类——缓存处置与暂时性失败完全一致（保留），只有它才额外开发布页", () => {
    const missing = new UpdateVerifyManifestMissingError("没带清单", "manifest-missing");
    // 子类关系的意义：任何只关心「删不删缓存」的调用方（含未来新增的）按 Unavailable 处理就天然是保守分支
    expect(missing).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(UpdateVerifyMismatchError);
    expect(missing.code).toBe("manifest-missing");
    expect(missing.name).toBe("UpdateVerifyManifestMissingError");
    expect(isDefinitiveVerifyFailure(missing)).toBe(false); // 绝不允许因为 404 删缓存
    expect(isManifestMissingFailure(missing)).toBe(true);
    // 普通 Unavailable / Mismatch / 未归类 / 非 Error 值都不算「没带 manifest」
    for (const v of [
      new UpdateVerifyUnavailableError("y", "manifest-http"),
      new UpdateVerifyMismatchError("x", "sha256"),
      new Error("boom"),
      "string",
      null,
      { code: "manifest-missing" },
    ]) {
      expect(isManifestMissingFailure(v)).toBe(false);
    }
  });

  it("文案不变（用户可见 / 既有断言依赖）：仍是中文、带「已中止替换」", () => {
    const err = catchErr(() => verifyManifestEntry(verifyArgs({ sha256: "0".repeat(64) })));
    expect((err as Error).message).toBe(
      "安装包 SHA-256 校验失败（内容被篡改 / 传输损坏）、已中止替换",
    );
  });
});

describe("② fetchUpdateManifest：404 / 410 = 没带 manifest，其余拿不到清单都是「暂时无法校验」", () => {
  const URL_ = `https://example.invalid/v${VERSION}/update-manifest.json`;
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("200 + 合法 JSON → 原样返回解析结果；带超时 signal 请求", async () => {
    const calls: Array<[string, { signal: AbortSignal }]> = [];
    const fetchImpl = vi.fn(async (...args: [string, { signal: AbortSignal }]) => {
      calls.push(args);
      return jsonResponse(goodManifest());
    });
    const m = await fetchUpdateManifest({ url: URL_, fetchImpl });
    expect(m).toEqual(goodManifest());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]![0]).toBe(URL_);
    expect(calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("网络错误（断网 / DNS / 连接被重置）→ Unavailable(manifest-network)，文案保持原样", async () => {
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-network");
    expect((err as Error).message).toBe("更新 manifest 下载失败：fetch failed、已中止替换");
    expect(isDefinitiveVerifyFailure(err)).toBe(false);
  });

  it("超时（signal 到点 abort）→ Unavailable，不会永远挂着", async () => {
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        timeoutMs: 20,
        fetchImpl: (_u: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_res, rej) => {
            init.signal.addEventListener("abort", () => rej(init.signal.reason));
          }),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-network");
  });

  it.each([403, 429, 500, 502, 503])(
    "HTTP %i（限流 / 服务端抖动）→ Unavailable(manifest-http)，不算「没带 manifest」",
    async (status) => {
      const err = await catchAsync(() =>
        fetchUpdateManifest({ url: URL_, fetchImpl: async () => jsonResponse("nope", status) }),
      );
      expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
      expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-http");
      expect((err as Error).message).toBe(`更新 manifest 下载失败 HTTP ${status}、已中止替换`);
      expect(isManifestMissingFailure(err)).toBe(false);
    },
  );

  it.each([404, 410])(
    "M3-03：HTTP %i = 这个 release 没带 manifest → UpdateVerifyManifestMissingError(manifest-missing)",
    async (status) => {
      const err = await catchAsync(() =>
        fetchUpdateManifest({ url: URL_, fetchImpl: async () => jsonResponse("Not Found", status) }),
      );
      expect(err).toBeInstanceOf(UpdateVerifyManifestMissingError);
      expect(err).toBeInstanceOf(UpdateVerifyUnavailableError); // 仍是「保留缓存」那一族
      expect((err as UpdateVerifyManifestMissingError).code).toBe("manifest-missing");
      expect(isManifestMissingFailure(err)).toBe(true);
      expect(isDefinitiveVerifyFailure(err)).toBe(false);
      // 文案要让人看得懂「是这个版本没带清单」、带上状态码便于排障；不能再是「下载失败」那句（那句会被读成网络问题）
      expect((err as Error).message).toContain(`HTTP ${status}`);
      expect((err as Error).message).toContain("没有附带");
      expect((err as Error).message).toContain("已中止替换");
      expect((err as Error).message).not.toContain("下载失败");
    },
  );

  it("200 但正文不是 JSON（强制门户 / 代理错误页）→ Unavailable(manifest-parse)", async () => {
    const err = await catchAsync(() =>
      fetchUpdateManifest({
        url: URL_,
        fetchImpl: async () => jsonResponse("<html>please login to the wifi</html>"),
      }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-parse");
    expect((err as Error).message).toMatch(/^更新 manifest JSON 解析失败：/);
  });

  it("读正文过程中断开（body 流报错）同样归 Unavailable", async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("socket hang up"));
        },
      }),
    );
    const err = await catchAsync(() =>
      fetchUpdateManifest({ url: URL_, fetchImpl: async () => broken }),
    );
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
  });
});

describe("③a buildVerifyRejectionNotice：给用户的提示按类型分", () => {
  it("确定不符：说清「已清除下载的文件、去发布页手动下」", () => {
    const n = buildVerifyRejectionNotice(new UpdateVerifyMismatchError("SHA 不符", "sha256"));
    expect(n.definitive).toBe(true);
    expect(n.reason).toBe("SHA 不符");
    expect(n.title).toBe("自动更新已中止");
    expect(n.body).toContain("SHA 不符");
    expect(n.body).toContain("清除下载的文件");
    expect(n.body).toContain("下载页");
    // 结构化标志：main.js 据此决定删缓存 / 开发布页，不再各自猜
    expect(n.openReleasePage).toBe(true);
    expect(n.manifestMissing).toBe(false);
  });

  it("M3-03 没带 manifest：说清「该版本暂不支持自动校验、请手动下载」并开发布页；不说清除、不说检查网络", () => {
    const n = buildVerifyRejectionNotice(
      new UpdateVerifyManifestMissingError(
        "该版本没有附带更新校验清单（HTTP 404）、已中止替换",
        "manifest-missing",
      ),
    );
    expect(n.manifestMissing).toBe(true);
    expect(n.definitive).toBe(false); // 不删缓存
    expect(n.openReleasePage).toBe(true); // 与暂时性失败的核心区别
    expect(n.title).toBe("该版本暂不支持自动校验");
    expect(n.body).toContain("HTTP 404");
    expect(n.body).toContain("手动下载");
    expect(n.body).toContain("下载页");
    // 区别于网络不通的「请检查网络后重试」——重试一万次也不会有清单
    expect(n.body).not.toContain("检查网络");
    expect(n.body).not.toContain("清除");
  });

  it("暂时无法校验：说清「安装包保留、检查网络后重试」，绝不说已清除", () => {
    // fileState "kept" = Windows 的真实情形（缓存包留在磁盘上）；mac 的 dmg 不保留、不说「已保留」（K3-06，见 update-verify-disposition）
    const n = buildVerifyRejectionNotice(
      new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
      { fileState: "kept" },
    );
    expect(n.definitive).toBe(false);
    expect(n.title).not.toBe("自动更新已中止");
    expect(n.body).toContain("HTTP 503");
    expect(n.body).toContain("保留");
    expect(n.body).toContain("重试");
    expect(n.body).not.toContain("清除");
    // 暂时性失败不开发布页（网络好了点徽标就能成）
    expect(n.openReleasePage).toBe(false);
    expect(n.manifestMissing).toBe(false);
  });

  it("未归类错误按「不删」处理", () => {
    // 样本别再用「待安装的文件与已验签的文件不一致」：它在 K3-11 起是带类型的 Mismatch(pending-file)，不再是未归类
    const n = buildVerifyRejectionNotice(new Error("dmg 下载不完整（10/20 字节）、已中止暂存"));
    expect(n.definitive).toBe(false);
    expect(n.reason).toContain("不完整");
    expect(n.body).not.toContain("清除");
    expect(n.openReleasePage).toBe(false);
    expect(buildVerifyRejectionNotice("字符串错误").reason).toBe("字符串错误");
  });
});

// ---------- ③ 真实执行 main.js 里的函数体 ----------

const mainSrc = readFileSync(path.join(ROOT, "electron-app/main.js"), "utf8");

/**
 * 从 main.js 切出 `const <name> = …`（async 或同步箭头函数）到首个行首 `};` 的源码
 * （与其它契约测试同款切法；mac 暂存的 downloadAndStageMacUpdate 是同步箭头、返回 promise）
 */
const sliceMainFn = (name: string, src: string = mainSrc): string => {
  // 只认行首的 `const <name> = `（不被注释 / 字符串里同名片段、或某个更长名字的子串带偏）
  const m = new RegExp(`^const ${name} = `, "m").exec(src);
  if (!m) throw new Error(`main.js 里应有行首的 const ${name} = …`);
  const start = m.index;
  const end = src.indexOf("\n};", start);
  expect(end).toBeGreaterThan(start);
  const text = src.slice(start, end + 3);
  // 自校验（第八轮「测试质量」）：这套切法按「首个行首 `};`」收尾，万一函数体里有字符串 / 模板的行首 `};`、
  // 就会切成半截——半截的括号不配对，编译一下就会抛 SyntaxError，别让它悄悄变成「切出来的是另一个东西」
  try {
    new Function(text);
  } catch (e) {
    throw new Error(`sliceMainFn(${name}) 切出来的不是完整语句（被行首 "};" 截断？）：${(e as Error).message}`);
  }
  return text;
};

/**
 * 从 main.js 取一条**模块级单行声明**（`let|const <name> = …;`）的原文——给 prelude 用，
 * 初值与 main.js 自己的声明完全同源、不再手抄；main.js 里没有（被删 / 改名）就直接抛错。
 */
const mainDecl = (name: string, src: string = mainSrc): string => {
  const m = new RegExp(`^(?:let|const) ${name} = [^\\n]*;$`, "m").exec(src);
  if (!m) throw new Error(`main.js 里应有行首单行声明 let|const ${name} = …;`);
  return m[0];
};
const mainDecls = (...names: string[]): string => names.map((n) => mainDecl(n)).join("\n");

/**
 * 脚手架作用域自检（第八轮「测试质量」：sloppy 模式下给「没声明的名字」赋值会悄悄变成全局、
 * 读它才 ReferenceError——所以以前删掉 main.js 里 `let repeatedFailurePromptedVersion` 测试仍然全绿，
 * 线上 catch 里却会 ReferenceError）。三个方向各卡一道：
 *  (a) prelude 里声明的每个名字，在 main.js 里必须真有一条行首（模块级）声明——手抄的 `let x = null` 不会在 main.js 删 / 改名后继续假装存在；
 *  (b) 被切出来的函数体里引用到的 main.js 模块级 `let` 名字，必须由 prelude / 注入依赖 / 同批切出的函数提供——
 *      main.js 新增一个状态变量、函数用了、脚手架没给，不会悄悄变成隐式全局；
 *  (c) 注入依赖（deps）的名字被切出的函数体引用时，必须是 main.js 的模块级绑定（行首声明或 import）或宿主全局——
 *      否则替身盖住「main.js 里这个依赖已被删 / 改名」：例如 `const wasPrompted` 改名后 handleMacStageFailure 仍调它、线上 ReferenceError，
 *      deps 里却还塞着同名替身、测试照绿（实测：在 lab 副本里把它改名，没有 (c) 时本文件 214 条仍全绿；加上 (c) 才变红）。
 * (b) 只管 `let`（可变状态才会出现「赋值悄悄成功」）；const 的读取漏了会 ReferenceError、走到那条路径就会红。
 * 模块级判定用「行首声明」——main.js 全部模块级声明都顶格写（函数体内一律缩进）。src 可传改过的源码以便单测本检查自身。
 */
const JS_IDENT = "[A-Za-z_$][\\w$]*";
const stripJsComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/[^\n]*/g, "$1");
/** main.js 的 import 绑定的本地名（`import { a, b as c } from` / `import x from` / `import * as ns from`；多行花括号也认） */
const importedNames = (src: string): string[] =>
  [...src.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];?/gm)].flatMap((m) => {
    const clause = m[1]!;
    const named = (/\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "")
      .split(",")
      .map((p) => p.trim().split(/\s+as\s+/).pop()!.trim());
    // 花括号之外：默认导入名 / `* as ns` 的 ns
    const outside = clause.replace(/\{[\s\S]*?\}/, " ").replace(/\*\s+as\s+/, " ").split(/[\s,]+/);
    return [...named, ...outside].filter(Boolean);
  });
/** 脚手架会注入、但在 main.js 里本来就是宿主全局（不是模块级绑定）的名字，(c) 不查它们 */
const HOST_GLOBALS = new Set([
  "process",
  "fetch",
  "Buffer",
  "URL",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "console",
  "globalThis",
]);
const checkHarnessScope = (
  names: string[],
  deps: Record<string, unknown>,
  prelude: string,
  src: string = mainSrc,
): void => {
  const collect = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map((m) => m[1]!);
  const mainLets = new Set(collect(new RegExp(`^let\\s+(${JS_IDENT})`, "gm"), src));
  const mainAll = new Set(
    collect(new RegExp(`^(?:let|const|var|(?:async\\s+)?function\\*?|class)\\s+(${JS_IDENT})`, "gm"), src),
  );
  const preludeNames = collect(new RegExp(`\\b(?:let|const|var)\\s+(${JS_IDENT})`, "g"), stripJsComments(prelude));
  const stale = preludeNames.filter((n) => !mainAll.has(n));
  if (stale.length > 0) {
    throw new Error(
      `脚手架 prelude 声明了 main.js 里没有（或已不是模块级）的名字：${stale.join(", ")}——手抄的声明已和 main.js 脱节`,
    );
  }
  const bodies = stripJsComments(names.map((n) => sliceMainFn(n, src)).join("\n"));
  const provided = new Set([...preludeNames, ...Object.keys(deps), ...names]);
  const unprovided = [...mainLets].filter(
    (l) => !provided.has(l) && new RegExp(`(?<![\\w$.])${l.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodies),
  );
  if (unprovided.length > 0) {
    throw new Error(
      `被切出的函数引用了 main.js 的模块级 let、但脚手架没提供：${unprovided.join(", ")}——` +
        "sloppy 模式下对它赋值会悄悄变成隐式全局、读它才 ReferenceError",
    );
  }
  // (c) 注入依赖：被引用的名字必须是 main.js 的模块级绑定（行首声明或 import）或宿主全局；见上方 (c) 的反例
  const mainBindings = new Set([...mainAll, ...importedNames(src)]);
  const orphanDeps = Object.keys(deps).filter(
    (d) =>
      !mainBindings.has(d) &&
      !HOST_GLOBALS.has(d) &&
      new RegExp(`(?<![\\w$.])${d.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodies),
  );
  if (orphanDeps.length > 0) {
    throw new Error(
      `被切出的函数引用了注入依赖 ${orphanDeps.join(", ")}，但 main.js 里没有同名的模块级绑定（声明 / import）——` +
        "替身掩盖了 main.js 里已被删 / 改名的依赖",
    );
  }
};

/** 在注入的依赖作用域里实例化切出来的函数（sloppy 模式 + 显式预声明可写变量） */
const instantiate = <T,>(
  name: string,
  deps: Record<string, unknown>,
  prelude = "",
  tail = `return ${name};`,
): T => {
  checkHarnessScope([name], deps, prelude);
  return new Function(...Object.keys(deps), `${prelude}\n${sliceMainFn(name)}\n${tail}`)(
    ...Object.values(deps),
  ) as T;
};

/**
 * 把多个函数切进**同一个**作用域（它们共享 prelude 里声明的模块级 let 变量，
 * 就像在 main.js 里一样）——端到端验证「A 函数写下的状态、B 函数读到」这类跨函数约定
 */
const instantiateMany = <T,>(
  names: string[],
  deps: Record<string, unknown>,
  prelude: string,
  tail: string,
): T => {
  checkHarnessScope(names, deps, prelude);
  return new Function(
    ...Object.keys(deps),
    `${prelude}\n${names.map((n) => sliceMainFn(n)).join("\n")}\n${tail}`,
  )(...Object.values(deps)) as T;
};

describe("③b main.js rejectUnverifiedWinUpdate：真实函数体、按错误类型分流", () => {
  const setup = () => {
    const deps = {
      log: vi.fn(),
      // stat 默认「文件在」：L2-06 起弹框前会 stat 一次核实缓存包还在（真实文件的场景见文件末尾的 L2-06 用例）
      fs: { rm: vi.fn(async () => undefined), stat: vi.fn(async () => ({ size: 1 })) },
      mainWindow: { setProgressBar: vi.fn() },
      setUpdateState: vi.fn(),
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      RELEASE_LATEST_URL: "https://example.invalid/releases/latest",
      buildVerifyRejectionNotice,
    };
    const { fn, getPending, getRetained } = instantiate<{
      fn: (a: {
        version: string;
        file?: string;
        assetName?: string | null;
        err: unknown;
        stage: string;
      }) => Promise<void>;
      getPending: () => unknown;
      getRetained: () => unknown;
    }>(
      "rejectUnverifiedWinUpdate",
      deps,
      'let winPendingInstaller = { file: "pending.exe" }; let winRetainedInstaller = null;',
      "return { fn: rejectUnverifiedWinUpdate, getPending: () => winPendingInstaller, getRetained: () => winRetainedInstaller };",
    );
    return { deps, run: fn, getPending, getRetained };
  };
  const FILE = "C:\\cache\\pending\\fe-ai-flow-9.9.9-win-x64.exe";

  it("确定不符（Mismatch）：删缓存包 → 回 available 带错误 → 弹一次框 + 开发布页", async () => {
    const { deps, run, getPending } = setup();
    await run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      stage: "下载完成后",
    });
    expect(deps.fs.rm).toHaveBeenCalledWith(FILE, { force: true });
    expect(deps.setUpdateState).toHaveBeenCalledWith({
      phase: "available",
      version: VERSION,
      percent: 0,
      error: "安装包 SHA-256 校验失败、已中止替换",
    });
    expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("自动更新已中止");
    expect(deps.shell.openExternal).toHaveBeenCalledWith("https://example.invalid/releases/latest");
    expect(getPending()).toBeNull();
    expect(deps.mainWindow.setProgressBar).toHaveBeenCalledWith(-1);
  });

  it.each([
    ["manifest 下载 HTTP 503", new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http")],
    ["网络超时", new UpdateVerifyUnavailableError("更新 manifest 下载失败：The operation was aborted due to timeout、已中止替换", "manifest-network")],
    ["正文不是 JSON", new UpdateVerifyUnavailableError("更新 manifest JSON 解析失败：Unexpected token <、已中止替换", "manifest-parse")],
    ["F1-04 200 但正文不是清单形态（{} / 错误体）", new UpdateVerifyUnavailableError("更新 manifest 结构非法、已中止替换", "manifest-invalid")],
    ["本地读安装包失败（杀软占用）", new UpdateVerifyUnavailableError("读取已下载的安装包失败：EBUSY、已中止替换", "local-io")],
    ["壳内置公钥缺失", new UpdateVerifyUnavailableError("更新验签公钥缺失、已中止替换", "public-key")],
    // 样本别用「待安装的文件与已验签的文件不一致」：K3-11 起它是 Mismatch(pending-file)，见下面专门的端到端用例
    ["未归类错误", new Error("找不到已下载安装包的路径或它在 release 上的文件名、已中止安装")],
  ])("暂时无法校验（%s）：仍拒绝安装，但**保留**缓存包、不开发布页，回 available 带错误", async (_name, err) => {
    const { deps, run, getPending } = setup();
    await run({ version: VERSION, file: FILE, err, stage: "安装前" });
    // 核心：112MB 的已下载包不能因为网络抖动被删
    expect(deps.fs.rm).not.toHaveBeenCalled();
    expect(deps.shell.openExternal).not.toHaveBeenCalled();
    // 仍然 fail-closed：待装登记清掉（不会被当成已验签）、回 available 带错误、弹一次框
    expect(getPending()).toBeNull();
    expect(deps.setUpdateState).toHaveBeenCalledTimes(1);
    expect(deps.setUpdateState.mock.calls[0]![0]).toMatchObject({
      phase: "available",
      version: VERSION,
      percent: 0,
      error: (err as Error).message,
    });
    expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(deps.dialog.showErrorBox.mock.calls[0]![1]).toContain("保留");
    expect(deps.dialog.showErrorBox.mock.calls[0]![1]).not.toContain("清除");
  });

  it("M3-03 没带 manifest：仍拒绝安装 + 保留缓存，但弹「该版本暂不支持自动校验」并开发布页（区别于网络不通）", async () => {
    const { deps, run, getPending } = setup();
    const err = new UpdateVerifyManifestMissingError(
      "该版本没有附带更新校验清单（HTTP 404）、已中止替换",
      "manifest-missing",
    );
    await run({ version: VERSION, file: FILE, assetName: EXE, err, stage: "下载完成后" });
    // 缓存便宜且安全：不删（用户手动装时可以直接复用 / 之后补发了清单点徽标就能成）
    expect(deps.fs.rm).not.toHaveBeenCalled();
    // fail-closed：待装登记清掉、回 available 带错误
    expect(getPending()).toBeNull();
    expect(deps.setUpdateState).toHaveBeenCalledTimes(1);
    expect(deps.setUpdateState.mock.calls[0]![0]).toMatchObject({
      phase: "available",
      version: VERSION,
      percent: 0,
      error: err.message,
    });
    // 与「暂时性失败」的核心区别：给手动下载入口（否则用户会永远卡在「请检查网络」）
    expect(deps.shell.openExternal).toHaveBeenCalledWith("https://example.invalid/releases/latest");
    expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("该版本暂不支持自动校验");
    expect(deps.dialog.showErrorBox.mock.calls[0]![1]).toContain("手动下载");
    expect(deps.dialog.showErrorBox.mock.calls[0]![1]).not.toContain("检查网络");
  });

  it("保留缓存时登记「可重验」记录 { version, file, assetName }；删缓存 / 缺 file / 缺 assetName 时不登记（后者交给 downloadUpdate 兜底）", async () => {
    const s = setup();
    const unavailable = new UpdateVerifyUnavailableError("503", "manifest-http");
    await s.run({ version: VERSION, file: FILE, assetName: EXE, err: unavailable, stage: "安装前" });
    expect(s.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });

    // 没带 manifest 同样要登记（它也是保留缓存的一族）
    const s2 = setup();
    await s2.run({
      version: VERSION,
      file: FILE,
      assetName: EXE,
      err: new UpdateVerifyManifestMissingError("没带", "manifest-missing"),
      stage: "安装前",
    });
    expect(s2.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });

    // 缺 assetName：重验必然复现「找不到文件名」——不登记，点徽标走 downloadUpdate 让 latest.yml 重新给一次
    const s3 = setup();
    await s3.run({ version: VERSION, file: FILE, assetName: null, err: unavailable, stage: "安装前" });
    expect(s3.getRetained()).toBeNull();
    // 缺 file：没东西可重验
    const s4 = setup();
    await s4.run({ version: VERSION, assetName: EXE, err: unavailable, stage: "安装前" });
    expect(s4.getRetained()).toBeNull();

    // 确定不符：包已删、记录必须一并清掉（否则点徽标会去重验一个不存在的文件）
    await s.run({
      version: VERSION,
      file: FILE,
      assetName: EXE,
      err: new UpdateVerifyMismatchError("sha256", "sha256"),
      stage: "安装前",
    });
    expect(s.getRetained()).toBeNull();
  });

  it("分流只看类型、不看文案：Unavailable 的文案里带「签名校验失败」「SHA-256」字样也不删；Mismatch 的文案里没有这些字样照删", async () => {
    const a = setup();
    await a.run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyUnavailableError("签名校验失败 SHA-256 不符（只是措辞撞车）", "manifest-http"),
      stage: "安装前",
    });
    expect(a.deps.fs.rm).not.toHaveBeenCalled();

    const b = setup();
    await b.run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyMismatchError("随便一句话", "size"),
      stage: "安装前",
    });
    expect(b.deps.fs.rm).toHaveBeenCalledTimes(1);
  });

  it("没有 file 时不碰磁盘；删不掉（被占用）不影响拒绝与提示", async () => {
    const a = setup();
    await a.run({
      version: VERSION,
      err: new UpdateVerifyMismatchError("x", "sha256"),
      stage: "安装前",
    });
    expect(a.deps.fs.rm).not.toHaveBeenCalled();
    expect(a.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);

    const b = setup();
    b.deps.fs.rm.mockRejectedValueOnce(new Error("EBUSY"));
    await b.run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyMismatchError("x", "sha256"),
      stage: "安装前",
    });
    expect(b.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(b.deps.setUpdateState).toHaveBeenCalledTimes(1);
  });

  it("K3-11 端到端：真实门禁抛出「待装文件与已验签文件不一致」→ 走「确定不符」处置：删缓存、不登记保留记录、弹「自动更新已中止」+ 开发布页", async () => {
    // 以前它是普通 Error → 被当暂时性：保留缓存、登记「可重验」、弹「这不代表安装包有问题」——
    // 而它恰恰说明库要装的文件 ≠ 我们验过的文件（被换 / 被改）
    const { deps, run, getRetained } = setup();
    const err = await catchAsync(() =>
      verifyWinPendingInstallerWith(
        { version: VERSION, file: FILE, assetName: EXE },
        {
          getRunFile: () => "C:\\cache\\pending\\other.exe",
          sameWinPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
          verifyDownloadedUpdate: async () => undefined,
        },
      ),
    );
    await run({ version: VERSION, file: FILE, assetName: EXE, err, stage: "安装前" });
    expect(deps.fs.rm).toHaveBeenCalledWith(FILE, { force: true });
    expect(getRetained()).toBeNull();
    expect(deps.shell.openExternal).toHaveBeenCalledWith("https://example.invalid/releases/latest");
    expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = deps.dialog.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe("自动更新已中止");
    expect(body).not.toContain("不代表安装包有问题");
  });

  // ---- K3-06：弹框正文要对得上 rejectUnverifiedWinUpdate 真实对缓存包做了什么 ----
  // Windows 与 mac 不同：update-downloaded 之后才验签、exe 已在缓存里，所以「清单级」确定不符（签名 / version / 条目缺失）
  // 在这里**也会删 exe**——不能照搬 mac 的「清单级不提清除」。文案由 rm 的真实结果决定（删掉才说「已清除」）。
  const bodyOf = (deps: { dialog: { showErrorBox: { mock: { calls: unknown[][] } } } }): string =>
    String(deps.dialog.showErrorBox.mock.calls[0]![1]);

  it.each([
    ["signature", "更新 manifest 签名校验失败、已中止替换"],
    ["version", "manifest 版本不符（9.9.8 ≠ 9.9.9）、已中止替换"],
    ["entry-missing", "manifest 里没有 fe-ai-flow-9.9.9-win-x64.exe 的摘要、已中止替换"],
    ["size", "安装包大小不符（1 ≠ 2）、已中止替换"],
    ["sha256", "安装包 SHA-256 校验失败、已中止替换"],
  ])("K3-06 Windows：确定不符（%s）且缓存包真的删掉了 → 正文说「清除下载的文件」（清单级也是——exe 此时已下载、确实被删）", async (code, message) => {
    const { deps, run } = setup();
    await run({ version: VERSION, file: FILE, err: new UpdateVerifyMismatchError(message, code), stage: "下载完成后" });
    expect(deps.fs.rm).toHaveBeenCalledWith(FILE, { force: true });
    expect(bodyOf(deps)).toContain("已取消自动安装并清除下载的文件");
  });

  it("K3-06 Windows：缓存包删不掉（被杀软占用）→ 正文不得声称「已清除」（文件还在磁盘上）；处置标志位照旧（仍开发布页）", async () => {
    const { deps, run } = setup();
    deps.fs.rm.mockRejectedValueOnce(new Error("EBUSY"));
    await run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      stage: "安装前",
    });
    expect(deps.fs.rm).toHaveBeenCalledTimes(1);
    expect(bodyOf(deps)).toContain("已取消自动安装");
    expect(bodyOf(deps)).not.toContain("清除");
    expect(deps.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("K3-06 Windows：确定不符但没有 file 可删 → 不得声称「已清除」", async () => {
    const { deps, run } = setup();
    await run({
      version: VERSION,
      err: new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      stage: "安装前",
    });
    expect(deps.fs.rm).not.toHaveBeenCalled();
    expect(bodyOf(deps)).not.toContain("清除");
  });

  it("K3-06 Windows：暂时性失败——有 file（缓存保留）才说「已保留」；没有 file 就不说", async () => {
    const withFile = setup();
    await withFile.run({
      version: VERSION,
      file: FILE,
      err: new UpdateVerifyUnavailableError("503", "manifest-http"),
      stage: "安装前",
    });
    expect(bodyOf(withFile.deps)).toContain("已下载的安装包已保留");

    const noFile = setup();
    await noFile.run({
      version: VERSION,
      err: new UpdateVerifyUnavailableError("503", "manifest-http"),
      stage: "安装前",
    });
    expect(bodyOf(noFile.deps)).not.toContain("保留");
  });

  // ---- 第八轮 L2-06：fileState="kept" 以前只看有没有 file 参数、不核实文件还在 ----
  // 杀软在验签失败到弹框之间把缓存 exe 删了（或根本已被清理）时，弹框仍写「已下载的安装包已保留」，是假话。
  // 现在弹框前 stat 一次：文件不存在（ENOENT / ENOTDIR）按「无文件」口径（none）；其余 stat 错误（EPERM / EBUSY 等）文件多半还在，
  // 保守仍按 kept。下面用真实临时文件走真实 fs（不 mock），另有 mock 的错误码分支。
  describe("L2-06 弹框前 stat 核实缓存包还在", () => {
    let tmp = "";
    const mkTmp = () => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "flowship-l2-06-"));
      return tmp;
    };
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = "";
    });

    /** 用真实 fs（rm / stat 都不 mock）实例化；返回 run 与 deps */
    const setupReal = () => {
      const deps = {
        log: vi.fn(),
        fs: fsp,
        mainWindow: { setProgressBar: vi.fn() },
        setUpdateState: vi.fn(),
        dialog: { showErrorBox: vi.fn() },
        shell: { openExternal: vi.fn(async () => undefined) },
        RELEASE_LATEST_URL: "https://example.invalid/releases/latest",
        buildVerifyRejectionNotice,
      };
      const run = instantiate<(a: Record<string, unknown>) => Promise<void>>(
        "rejectUnverifiedWinUpdate",
        deps,
        "let winPendingInstaller = null; let winRetainedInstaller = null;",
        "return rejectUnverifiedWinUpdate;",
      );
      return { deps, run };
    };
    const unavailable = () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");

    it("缓存包真的还在（真实临时文件）：暂时性失败说「已下载的安装包已保留」，文件不被动", async () => {
      const dir = mkTmp();
      const file = path.join(dir, EXE);
      writeFileSync(file, EXE_BYTES);
      const { deps, run } = setupReal();
      await run({ version: VERSION, file, assetName: EXE, err: unavailable(), stage: "安装前" });
      expect(bodyOf(deps)).toContain("已下载的安装包已保留");
      expect(existsSync(file)).toBe(true);
    });

    it("给了 file 但文件已不在（被杀软清掉；真实路径、文件根本不存在）：不得说「已保留」", async () => {
      const dir = mkTmp();
      const file = path.join(dir, EXE); // 从没创建 / 已被删
      const { deps, run } = setupReal();
      await run({ version: VERSION, file, assetName: EXE, err: unavailable(), stage: "安装前" });
      expect(bodyOf(deps)).not.toContain("保留");
      expect(bodyOf(deps)).toContain("HTTP 503"); // 其余文案照旧
      expect(deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    });

    it("没带清单（404）+ 文件已不在：正文本来就不提保留 / 清除，处置不变（开发布页）", async () => {
      const dir = mkTmp();
      const { deps, run } = setupReal();
      await run({
        version: VERSION,
        file: path.join(dir, EXE),
        assetName: EXE,
        err: new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing"),
        stage: "安装前",
      });
      expect(bodyOf(deps)).not.toContain("保留");
      expect(deps.shell.openExternal).toHaveBeenCalledTimes(1);
    });

    it("确定不符 + 缓存包在：rm 真的删掉 → 「清除下载的文件」，文件确实没了（stat 不影响已 cleared 的口径）", async () => {
      const dir = mkTmp();
      const file = path.join(dir, EXE);
      writeFileSync(file, EXE_BYTES);
      const { deps, run } = setupReal();
      await run({
        version: VERSION,
        file,
        assetName: EXE,
        err: new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
        stage: "安装前",
      });
      expect(bodyOf(deps)).toContain("已取消自动安装并清除下载的文件");
      expect(existsSync(file)).toBe(false);
    });

    it("确定不符 + rm 失败（被占用）且文件此刻也不在：既不说「清除」（不是我们删的）也不说「保留」", async () => {
      const dir = mkTmp();
      const deps = {
        log: vi.fn(),
        // rm 失败、stat 走真实 fs 且文件不存在
        fs: { rm: vi.fn(async () => Promise.reject(new Error("EBUSY"))), stat: fsp.stat },
        mainWindow: { setProgressBar: vi.fn() },
        setUpdateState: vi.fn(),
        dialog: { showErrorBox: vi.fn() },
        shell: { openExternal: vi.fn(async () => undefined) },
        RELEASE_LATEST_URL: "https://example.invalid/releases/latest",
        buildVerifyRejectionNotice,
      };
      const run = instantiate<(a: Record<string, unknown>) => Promise<void>>(
        "rejectUnverifiedWinUpdate",
        deps,
        "let winPendingInstaller = null; let winRetainedInstaller = null;",
        "return rejectUnverifiedWinUpdate;",
      );
      await run({
        version: VERSION,
        file: path.join(dir, EXE),
        assetName: EXE,
        err: new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
        stage: "安装前",
      });
      expect(bodyOf(deps)).toContain("已取消自动安装");
      expect(bodyOf(deps)).not.toContain("清除");
      expect(bodyOf(deps)).not.toContain("保留");
      expect(deps.shell.openExternal).toHaveBeenCalledTimes(1); // 处置标志位与文件去留无关
    });

    it.each([
      ["ENOENT", true],
      ["ENOTDIR", true],
      ["EPERM", false],
      ["EBUSY", false],
      ["EACCES", false],
    ])("stat 报 %s → 文件不在=%s（只有「不存在」类错误才改口径，权限 / 占用类文件多半还在、保守仍说已保留）", async (code, gone) => {
      const { deps, run } = setup();
      deps.fs.stat.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await run({ version: VERSION, file: "C:\\cache\\pending\\x.exe", err: unavailable(), stage: "安装前" });
      expect(deps.fs.stat).toHaveBeenCalledWith("C:\\cache\\pending\\x.exe");
      if (gone) expect(bodyOf(deps)).not.toContain("保留");
      else expect(bodyOf(deps)).toContain("已下载的安装包已保留");
    });

    it("没有 file 就不 stat（没东西可核实）", async () => {
      const { deps, run } = setup();
      await run({ version: VERSION, err: unavailable(), stage: "安装前" });
      expect(deps.fs.stat).not.toHaveBeenCalled();
    });
  });
});

describe("③c main.js verifyDownloadedUpdate：真实函数体 + 真实 Ed25519 签名，IO 失败按类型抛", () => {
  const FILE = "C:\\cache\\pending\\fe-ai-flow-9.9.9-win-x64.exe";

  const setup = (
    over: {
      manifestResponse?: () => Promise<Response>;
      readPublicKey?: () => string;
      stat?: () => Promise<{ size: number }>;
      sha256?: () => Promise<string>;
    } = {},
  ) => {
    const stat = vi.fn(over.stat ?? (async () => ({ size: Buffer.byteLength(EXE_BYTES) })));
    const sha256File = vi.fn(over.sha256 ?? (async () => sha256Of(EXE_BYTES)));
    const manifestResponse =
      over.manifestResponse ?? (async () => new Response(JSON.stringify(goodManifest())));
    const deps = {
      readFileSync: vi.fn(over.readPublicKey ?? (() => `${pubPem}\n`)),
      UPDATE_MANIFEST_PUBLIC_KEY_PATH: "C:\\app\\update-manifest-public-key.pem",
      // 注入 stub fetch：其余（超时 / 分类）走真实 fetchUpdateManifest
      fetchUpdateManifest: (o: { url: string }) =>
        fetchUpdateManifest({ ...o, fetchImpl: manifestResponse }),
      findSignedManifestEntry,
      verifyManifestEntry,
      UpdateVerifyUnavailableError,
      fs: { stat },
      sha256File,
      log: vi.fn(),
    };
    // F1-01：取清单 + 三道廉价检查拆成了 loadSignedManifest（mac 要在下载前先调）；
    // Windows 路径不传 preloaded，verifyDownloadedUpdate 仍在内部现取——行为与拆分前一致，下面全部用例照旧覆盖
    const run = instantiateMany<(v: string, f: string, a: string) => Promise<void>>(
      ["loadSignedManifest", "verifyDownloadedUpdate"],
      deps,
      "",
      "return verifyDownloadedUpdate;",
    );
    return { deps, stat, sha256File, run: () => run(VERSION, FILE, EXE) };
  };

  it("全部合法 → 通过", async () => {
    const s = setup();
    await expect(s.run()).resolves.toBeUndefined();
  });

  it.each([
    ["HTTP 503", () => Promise.resolve(new Response("x", { status: 503 })), "manifest-http"],
    ["HTTP 404（release 没带 manifest）", () => Promise.resolve(new Response("x", { status: 404 })), "manifest-missing"],
    ["HTTP 410", () => Promise.resolve(new Response("x", { status: 410 })), "manifest-missing"],
    ["断网", () => Promise.reject(new TypeError("fetch failed")), "manifest-network"],
    ["正文不是 JSON", () => Promise.resolve(new Response("<html/>")), "manifest-parse"],
    // F1-04：200 + 合法 JSON、但不是清单——同样是「没拿到可用清单」，不能落进 Mismatch（会删缓存 + 开发布页）
    ["200 + {}", () => Promise.resolve(new Response("{}")), "manifest-invalid"],
    ["200 + {message}（GitHub 错误体）", () => Promise.resolve(new Response('{"message":"Not Found"}')), "manifest-invalid"],
    ["200 + []", () => Promise.resolve(new Response("[]")), "manifest-invalid"],
    ["200 + null", () => Promise.resolve(new Response("null")), "manifest-invalid"],
    [
      "200 + 缺 signature 的残缺清单",
      () => Promise.resolve(new Response(JSON.stringify({ version: VERSION, files: FILES }))),
      "manifest-invalid",
    ],
  ])("manifest 拿不到（%s）→ Unavailable、且不会白算 SHA-256 / 读文件", async (_n, manifestResponse, code) => {
    const s = setup({ manifestResponse });
    const err = await catchAsync(s.run);
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((err as UpdateVerifyUnavailableError).code).toBe(code);
    expect(s.stat).not.toHaveBeenCalled();
    expect(s.sha256File).not.toHaveBeenCalled();
  });

  it.each([
    ["{}", {}],
    ["{message}（API 错误体）", { message: "Not Found", documentation_url: "https://docs.github.com" }],
    ["[]", []],
    ["缺 signature", { version: VERSION, files: [] }],
    ["缺 files", { version: VERSION, signature: "abc" }],
  ])(
    "F1-04：manifest 请求 200 但正文不是清单形态（%s）→ Unavailable(manifest-invalid)、不读盘；处置 = 保留缓存、不开发布页",
    async (_n, body) => {
      const s = setup({ manifestResponse: async () => new Response(JSON.stringify(body)) });
      const err = await catchAsync(s.run);
      expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
      expect(err).not.toBeInstanceOf(UpdateVerifyMismatchError);
      expect((err as UpdateVerifyUnavailableError).code).toBe("manifest-invalid");
      expect(s.stat).not.toHaveBeenCalled();
      expect(s.sha256File).not.toHaveBeenCalled();
      // 下游处置：与「取不到清单」同一族——不删缓存（definitive=false）、不往发布页赶
      const notice = buildVerifyRejectionNotice(err);
      expect(notice.definitive).toBe(false);
      expect(notice.openReleasePage).toBe(false);
      expect(notice.manifestMissing).toBe(false);
    },
  );

  it("壳内置公钥读不出 / 为空 → Unavailable(public-key)，文案保持", async () => {
    const missing = setup({
      readPublicKey: () => {
        throw new Error("ENOENT");
      },
    });
    const e1 = await catchAsync(missing.run);
    expect(e1).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((e1 as UpdateVerifyUnavailableError).code).toBe("public-key");
    expect((e1 as Error).message).toContain("更新验签公钥缺失");

    const empty = setup({ readPublicKey: () => "  \n" });
    const e2 = await catchAsync(empty.run);
    expect(e2).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((e2 as Error).message).toContain("更新验签公钥为空");
  });

  it("本地读安装包失败（stat / 流式哈希被占用或权限）→ Unavailable(local-io)，不是 Mismatch", async () => {
    const a = setup({
      stat: async () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      },
    });
    const e1 = await catchAsync(a.run);
    expect(e1).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((e1 as UpdateVerifyUnavailableError).code).toBe("local-io");

    const b = setup({
      sha256: async () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    const e2 = await catchAsync(b.run);
    expect(e2).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect((e2 as UpdateVerifyUnavailableError).code).toBe("local-io");
  });

  it("确定不符 → Mismatch：签名错 / 版本重放 / 条目缺失（都不读盘）、size / sha256 不符（读盘后）", async () => {
    // 签名错（别人签的）
    const forged = signManifest(other.privateKey, VERSION, FILES.map((f) => ({ ...f })));
    const s1 = setup({ manifestResponse: async () => new Response(JSON.stringify(forged)) });
    const e1 = await catchAsync(s1.run);
    expect(e1).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((e1 as UpdateVerifyMismatchError).code).toBe("signature");
    expect(s1.stat).not.toHaveBeenCalled();

    // 旧版本合法 manifest 重放
    const replay = signManifest(privateKey, "9.9.8", FILES.map((f) => ({ ...f })));
    const s2 = setup({ manifestResponse: async () => new Response(JSON.stringify(replay)) });
    expect(((await catchAsync(s2.run)) as UpdateVerifyMismatchError).code).toBe("version");

    // manifest 里没有 exe 条目（旧发版链形态）
    const noExe = signManifest(privateKey, VERSION, [
      { name: "fe-ai-flow-9.9.9-mac-arm64.dmg", size: 1, sha256: "0".repeat(64) },
    ]);
    const s3 = setup({ manifestResponse: async () => new Response(JSON.stringify(noExe)) });
    expect(((await catchAsync(s3.run)) as UpdateVerifyMismatchError).code).toBe("entry-missing");
    expect(s3.stat).not.toHaveBeenCalled();

    // size 不符 / sha256 不符
    const s4 = setup({ stat: async () => ({ size: Buffer.byteLength(EXE_BYTES) + 1 }) });
    expect(((await catchAsync(s4.run)) as UpdateVerifyMismatchError).code).toBe("size");
    const s5 = setup({ sha256: async () => "0".repeat(64) });
    expect(((await catchAsync(s5.run)) as UpdateVerifyMismatchError).code).toBe("sha256");
  });
});

describe("③d M3-05 点徽标复用「已保留的缓存」：不依赖 electron-updater 重发 update-downloaded（真实函数体端到端）", () => {
  // 背景：N2-02 保留缓存后，「下次点徽标重新验」原先全靠 electron-updater 缓存命中时重发 update-downloaded。
  // 读 electron-updater 6.8.9 源码确认会重发（AppUpdater.executeDownload → done(false)），但这是库的内部行为、
  // 不是它的公开契约；万一不重发，用户会被「保留了缓存、却永远进不了 ready」卡死。
  // 所以点徽标时若已知缓存路径，直接对该文件重跑验签——下面的 downloadUpdate stub **故意不 emit 任何事件**，
  // 模拟最坏情形：照样必须能走通。
  const FILE = "C:\\cache\\pending\\fe-ai-flow-9.9.9-win-x64.exe";
  const FNS = [
    "rejectUnverifiedWinUpdate",
    "verifyAndMarkWinReady",
    "resumeRetainedWinInstaller",
    "installUpdateNow",
  ];

  interface WinHarness {
    installUpdateNow: () => Promise<void>;
    verifyAndMarkWinReady: (a: {
      version: string;
      file?: string;
      assetName?: string | null;
      stage: string;
    }) => Promise<boolean>;
    rejectUnverifiedWinUpdate: (a: {
      version: string;
      file?: string;
      assetName?: string | null;
      err: unknown;
      stage: string;
    }) => Promise<void>;
    getState: () => { phase: string; version: string | null; percent: number; error: string | null };
    setState: (s: Record<string, unknown>) => void;
    setReadyVersion: (v: string | null) => void;
    getRetained: () => unknown;
    getPending: () => unknown;
  }

  const setup = (
    over: {
      verify?: (pending: unknown) => Promise<void>;
      stat?: () => Promise<unknown>;
      /** electron-updater downloadedUpdateHelper.file；undefined = 库内部结构取不到（helper 本身不存在） */
      helperFile?: string | null | undefined;
      noHelper?: boolean;
    } = {},
  ) => {
    const downloadUpdate = vi.fn(async () => [] as string[]);
    const winUpdater = {
      downloadUpdate,
      downloadedUpdateHelper: over.noHelper
        ? undefined
        : { file: "helperFile" in over ? over.helperFile : FILE },
    };
    const verify = vi.fn(over.verify ?? (async () => undefined));
    const deps = {
      log: vi.fn(),
      fs: {
        rm: vi.fn(async () => undefined),
        stat: vi.fn(over.stat ?? (async () => ({ size: 1 }))),
      },
      mainWindow: { setProgressBar: vi.fn() },
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      RELEASE_LATEST_URL: "https://example.invalid/releases/latest",
      buildVerifyRejectionNotice,
      verifyWinPendingInstaller: verify,
      sameWinPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      UPDATE_MODE: "install",
      macSelfUpdate: vi.fn(),
      runInstallWinUpdate: vi.fn(async () => undefined),
      ensureWinAutoUpdater: vi.fn(async () => winUpdater),
      winUpdater,
    };
    const h = instantiateMany<WinHarness>(
      FNS,
      deps,
      `let winPendingInstaller = null;
       let winRetainedInstaller = null;
       let winAutoUpdater = winUpdater;
       let winDownloadedVerifyTask = null;
       let quitting = false;
       let installInFlight = false;
       let updateReadyVersion = "${VERSION}";
       let updateState = { phase: "available", version: "${VERSION}", percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      `return {
         installUpdateNow, verifyAndMarkWinReady, rejectUnverifiedWinUpdate,
         getState: () => updateState,
         setState: (s) => { updateState = { ...updateState, ...s }; },
         setReadyVersion: (v) => { updateReadyVersion = v; },
         getRetained: () => winRetainedInstaller,
         getPending: () => winPendingInstaller,
       };`,
    );
    /** 模拟「第一次验签因 err 失败」：登记保留记录并回 available；然后清掉这一步产生的调用痕迹 */
    const seedFailure = async (err: unknown) => {
      await h.rejectUnverifiedWinUpdate({
        version: VERSION,
        file: FILE,
        assetName: EXE,
        err,
        stage: "下载完成后",
      });
      deps.dialog.showErrorBox.mockClear();
      deps.shell.openExternal.mockClear();
      deps.fs.rm.mockClear();
      deps.mainWindow.setProgressBar.mockClear();
    };
    return { h, deps, verify, downloadUpdate, seedFailure };
  };

  const unavailable = () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
  const missing = () =>
    new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing");

  it("暂时性失败后点徽标：直接对保留的文件重验，通过 → ready → 安装；一次 downloadUpdate 都不调（不依赖事件重发）", async () => {
    const s = setup();
    await s.seedFailure(unavailable());
    expect(s.h.getState().phase).toBe("available");
    expect(s.h.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });

    await s.h.installUpdateNow();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.verify.mock.calls[0]![0]).toEqual({ version: VERSION, file: FILE, assetName: EXE });
    expect(s.downloadUpdate).not.toHaveBeenCalled();
    expect(s.deps.runInstallWinUpdate).toHaveBeenCalledTimes(1);
    expect(s.deps.runInstallWinUpdate).toHaveBeenCalledWith(VERSION);
    expect(s.h.getState()).toMatchObject({ phase: "ready", version: VERSION, percent: 100, error: null });
    // 通过后：待装登记接管、保留记录用完即清；全程不弹框
    expect(s.h.getPending()).toEqual({ version: VERSION, file: FILE, assetName: EXE });
    expect(s.h.getRetained()).toBeNull();
    expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("重验仍是暂时性失败：按原分流处置——保留缓存、弹一次框、不开发布页、不安装、不下载；记录继续保留", async () => {
    const s = setup({
      verify: async () => {
        throw unavailable();
      },
    });
    await s.seedFailure(unavailable());
    await s.h.installUpdateNow();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.downloadUpdate).not.toHaveBeenCalled();
    expect(s.deps.runInstallWinUpdate).not.toHaveBeenCalled();
    expect(s.deps.fs.rm).not.toHaveBeenCalled();
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("暂时无法校验更新包");
    expect(s.h.getState().phase).toBe("available");
    expect(s.h.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });

    // 网络好了：再点一次就能成（记录没丢）
    s.verify.mockImplementation(async () => undefined);
    await s.h.installUpdateNow();
    expect(s.deps.runInstallWinUpdate).toHaveBeenCalledTimes(1);
    expect(s.downloadUpdate).not.toHaveBeenCalled();
  });

  it("重验转为确定不符：删缓存 + 开发布页 + 清记录；再点徽标就走 downloadUpdate 重新下", async () => {
    const s = setup({
      verify: async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      },
    });
    await s.seedFailure(unavailable());
    await s.h.installUpdateNow();

    expect(s.deps.fs.rm).toHaveBeenCalledWith(FILE, { force: true });
    expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("自动更新已中止");
    expect(s.h.getRetained()).toBeNull();
    expect(s.downloadUpdate).not.toHaveBeenCalled();
    expect(s.deps.runInstallWinUpdate).not.toHaveBeenCalled();

    await s.h.installUpdateNow(); // 记录已清、包已删 → 回落到下载
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("M3-03：没带 manifest 保留缓存后点徽标，重验仍 404 → 再次给出「手动下载」入口（不会卡在无反馈的重试里）", async () => {
    const s = setup({
      verify: async () => {
        throw missing();
      },
    });
    await s.seedFailure(missing());
    await s.h.installUpdateNow();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.deps.fs.rm).not.toHaveBeenCalled(); // 缓存仍保留
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("该版本暂不支持自动校验");
    expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(s.deps.runInstallWinUpdate).not.toHaveBeenCalled(); // fail-closed：没 manifest 绝不安装
    expect(s.h.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });
  });

  it("缓存文件已经不在了：不重验、清记录，回落到 downloadUpdate", async () => {
    const s = setup({
      stat: async () => {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });
    await s.seedFailure(unavailable());
    await s.h.installUpdateNow();

    expect(s.verify).not.toHaveBeenCalled();
    expect(s.h.getRetained()).toBeNull();
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it.each([
    ["库当前登记的待装文件换成了别的路径", { helperFile: "C:\\cache\\pending\\other-9.9.9.exe" }],
    ["库的待装登记已被清空（helper.file = null）", { helperFile: null }],
  ])("%s：重验它没意义（quitAndInstall 装的是库登记的那个）→ 回落 downloadUpdate", async (_n, over) => {
    const s = setup(over);
    await s.seedFailure(unavailable());
    await s.h.installUpdateNow();

    expect(s.verify).not.toHaveBeenCalled();
    expect(s.h.getRetained()).toBeNull();
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("库内部结构取不到（downloadedUpdateHelper 不存在）：不因此误拦，照常重验", async () => {
    const s = setup({ noHelper: true });
    await s.seedFailure(unavailable());
    await s.h.installUpdateNow();

    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.downloadUpdate).not.toHaveBeenCalled();
    expect(s.deps.runInstallWinUpdate).toHaveBeenCalledTimes(1);
  });

  it("保留的是旧版本的包、之后轮询发现了更新的版本：丢弃记录，按新版本走下载", async () => {
    const s = setup();
    await s.seedFailure(unavailable());
    s.h.setReadyVersion("9.9.10");
    s.h.setState({ version: "9.9.10" });
    await s.h.installUpdateNow();

    expect(s.verify).not.toHaveBeenCalled();
    expect(s.h.getRetained()).toBeNull();
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("没有保留记录（正常首次点徽标）：行为不变，直接 downloadUpdate；不去 stat / 重验", async () => {
    const s = setup();
    await s.h.installUpdateNow();

    expect(s.deps.fs.stat).not.toHaveBeenCalled();
    expect(s.verify).not.toHaveBeenCalled();
    expect(s.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("重验期间（验签是异步的）再点徽标：被 installInFlight 锁住、不会并发出第二次重验", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({ verify: () => gate });
    await s.seedFailure(unavailable());

    const first = s.h.installUpdateNow();
    await Promise.resolve();
    await s.h.installUpdateNow(); // 第二次点：直接忽略
    expect(s.verify).toHaveBeenCalledTimes(1);
    // 验签期间 phase 保持 downloading（沿用既有「验签中」语义：UI 不可点、轮询也不会打断）
    expect(s.h.getState().phase).toBe("downloading");

    release();
    await first;
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.deps.runInstallWinUpdate).toHaveBeenCalledTimes(1);
  });

  describe("verifyAndMarkWinReady（update-downloaded 事件与点徽标重验共用的「验签通过 → ready」）", () => {
    it("通过：登记待装、清保留记录；只在 phase 仍是 downloading 时置 ready", async () => {
      const s = setup();
      s.h.setState({ phase: "downloading", percent: 100 });
      await expect(
        s.h.verifyAndMarkWinReady({ version: VERSION, file: FILE, assetName: EXE, stage: "下载完成后" }),
      ).resolves.toBe(true);
      expect(s.h.getState()).toMatchObject({ phase: "ready", version: VERSION, percent: 100, error: null });
      expect(s.h.getPending()).toEqual({ version: VERSION, file: FILE, assetName: EXE });
    });

    it("通过但验签期间 phase 被别处打回 available（如 error 事件）：不凭空冒出 ready", async () => {
      const s = setup();
      s.h.setState({ phase: "available", error: "某个 error 事件" });
      await expect(
        s.h.verifyAndMarkWinReady({ version: VERSION, file: FILE, assetName: EXE, stage: "下载完成后" }),
      ).resolves.toBe(true);
      expect(s.h.getState().phase).toBe("available");
    });

    it("失败：走统一拒绝处置（带 assetName 以便登记保留记录），返回 false、绝不进 ready", async () => {
      const s = setup({
        verify: async () => {
          throw unavailable();
        },
      });
      s.h.setState({ phase: "downloading", percent: 100 });
      await expect(
        s.h.verifyAndMarkWinReady({ version: VERSION, file: FILE, assetName: EXE, stage: "下载完成后" }),
      ).resolves.toBe(false);
      expect(s.h.getState().phase).toBe("available");
      expect(s.h.getPending()).toBeNull();
      expect(s.h.getRetained()).toEqual({ version: VERSION, file: FILE, assetName: EXE });
      expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    });
  });
});

describe("③e M3-04 / F1-01 mac：同一版本验签失败后，定时 / 手动检查不再自动重下 dmg（确定性失败永久跳过、暂时性失败按时间退避）", () => {
  // 背景：mac 的 dmg（100MB+）在 downloadAndStageMacUpdateInner 的 finally 里一定会删。
  // 清单持续取不到 / 验不过时，runUpdateCheck 每 2 小时都会「重下一遍 dmg → 验签失败 → 又删」。
  // 修法：记住验签失败的版本（macVerifyFailedVersion），自动路径跳过；用户点徽标（macSelfUpdate）才重试。
  // F1-01：只对确定性失败（Mismatch / 没带 manifest）永久登记；暂时性失败（Unavailable）改成按时间退避，
  // 否则一次瞬时 503 / 超时就让该版本在整个进程生命周期内不再自动暂存。
  const V = "9.9.9";
  const FNS = [
    "isNewer",
    "downloadAndStageMacUpdate",
    "claimStageErrorDialog",
    "handleMacStageFailure",
    "runUpdateCheck",
    "manualCheckForUpdate",
  ];

  interface MacHarness {
    runUpdateCheck: () => Promise<void>;
    manualCheckForUpdate: () => Promise<{ status: string }>;
    downloadAndStageMacUpdate: (v: string) => Promise<unknown>;
    getState: () => { phase: string; version: string | null; error: string | null };
    getFailed: () => string | null;
    getRetry: () => { version: string; failures: number; notBefore: number } | null;
    /** 第八轮 L2-01：「放弃自动暂存」闸登记的版本（null = 没登记）与「会白下 dmg 的失败」计数记录 */
    getGiveUp: () => string | null;
    getCostly: () => { version: string; count: number } | null;
    /** 模拟「用户点了徽标、macSelfUpdate 持有 installInFlight 锁」 */
    setInstallInFlight: (v: boolean) => void;
  }

  const setup = (
    innerImpl: () => Promise<unknown>,
    latest: () => string = () => V,
    /** 覆盖注入项（如换成替身 buildVerifyRejectionNotice，验证壳只读标志位） */
    overDeps: Record<string, unknown> = {},
  ) => {
    const inner = vi.fn(innerImpl);
    const prompted = new Set<string>();
    const deps = {
      log: vi.fn(),
      app: { getVersion: () => "1.0.0", isPackaged: true },
      IS_TEST: false,
      process: { platform: "darwin" },
      UPDATE_MODE: "download",
      fetchLatestVersion: vi.fn(async () => latest()),
      ensureWinAutoUpdater: vi.fn(),
      downloadAndStageMacUpdateInner: inner,
      wasPrompted: vi.fn(async (v: string) => prompted.has(v)),
      markPrompted: vi.fn(async (v: string) => {
        prompted.add(v);
      }),
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      RELEASE_LATEST_URL: "https://example.invalid/releases/latest",
      UpdateVerifyMismatchError,
      UpdateVerifyUnavailableError,
      // 第六轮 R6-5：mac 暂存失败的处置与 Windows 共用同一个纯函数（真实模块、不 mock）
      buildVerifyRejectionNotice,
      // F1-01：失败分类 / 退避判定用真实模块（不 mock），时间靠 vi.useFakeTimers 伪造 Date
      isPermanentVerifyFailure,
      isVerifyRetryBlocked,
      nextVerifyRetry,
      // 第七轮 P2-2：同一版本连续失败 ≥ 3 次的「多次失败」说明框（纯函数、真实模块，不 mock）
      shouldPromptRepeatedFailure,
      buildRepeatedFailureNotice,
      // 第八轮 L2-01：「放弃自动暂存」闸（只数会白下 dmg 的失败；纯函数、真实模块，不 mock）
      nextCostlyFailureRecord,
      shouldGiveUpAutoStage,
      // 第八轮 L2-02：非验签类失败（user 触发）走通用提示，与 macSelfUpdate 共用同一个函数
      isVerifyFailure,
      buildGenericUpdateFailureNotice,
      ...overDeps,
    };
    const h = instantiateMany<MacHarness>(
      FNS,
      deps,
      // 模块级状态声明原文取自 main.js（mainDecls：初值同源、不手抄；main.js 里删 / 改名就在这里直接抛错）；
      // updateState / setUpdateState 是替身（真实版会广播给窗口），checkHarnessScope 另校验它们在 main.js 里确有同名声明
      `${mainDecls(
        "stagingPromise",
        "installInFlight",
        "updateReadyVersion",
        "macVerifyFailedVersion",
        "macVerifyRetry",
        "macCostlyFailures",
        "macStageGiveUpVersion",
        "repeatedFailurePromptedVersion",
        "dialoguedStageErrors",
      )}
       let updateState = { phase: "idle", version: null, percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      `return {
         runUpdateCheck, manualCheckForUpdate, downloadAndStageMacUpdate,
         getState: () => updateState,
         getFailed: () => macVerifyFailedVersion,
         getRetry: () => macVerifyRetry,
         getGiveUp: () => macStageGiveUpVersion,
         getCostly: () => macCostlyFailures,
         setInstallInFlight: (v) => { installInFlight = v; },
       };`,
    );
    return { h, deps, inner, prompted };
  };

  /** manualCheckForUpdate 里暂存是 `void promise.catch()`：让出几轮微任务 / 宏任务等它落定 */
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  // 确定性失败：重试不会好 → 本进程内永久跳过（macVerifyFailedVersion）。
  // F1-01：不再含「暂时性（Unavailable）」——它只退避、见下面 F1-01 的用例
  const verifyFailures: Array<[string, () => Error]> = [
    ["确定不符（sha256）", () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256")],
    ["没带 manifest（404）", () => new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing")],
  ];

  it.each(verifyFailures)(
    "确定性验签失败（%s）：首轮下载一次 + 提示一次；之后每轮轮询都不再重下同一版本（永久跳过）",
    async (_n, mk) => {
      const s = setup(async () => {
        throw mk();
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(s.h.getFailed()).toBe(V);
      expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);

      // 之后「每 2 小时一轮」：依旧提示徽标可点、但绝不再碰 dmg
      await s.h.runUpdateCheck();
      await s.h.runUpdateCheck();
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      // 徽标仍亮（用户点它就是显式重试），错误原因仍在
      expect(s.h.getState()).toMatchObject({ phase: "available", version: V });
      expect(s.h.getState().error).toBe(mk().message);
      // 跳过要留日志（排障时能看出「为什么这一轮没下」）
      expect(s.deps.log.mock.calls.some((c) => String(c[0]).includes("跳过自动暂存"))).toBe(true);
    },
  );

  it("用户点徽标（downloadAndStageMacUpdate）仍会重试；失败再记、成功后清除、之后自动轮询恢复（确定性失败）", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
    });
    await s.h.runUpdateCheck();
    expect(s.inner).toHaveBeenCalledTimes(1);

    // 用户点徽标：不受 failedVersion 约束、真的重下一次，且仍然失败
    await expect(s.h.downloadAndStageMacUpdate(V)).rejects.toBeInstanceOf(UpdateVerifyMismatchError);
    expect(s.inner).toHaveBeenCalledTimes(2);
    expect(s.h.getFailed()).toBe(V);

    // 这次网络好了、用户再点：成功暂存 → 清掉 failedVersion
    s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
    await expect(s.h.downloadAndStageMacUpdate(V)).resolves.toMatchObject({ version: V });
    expect(s.inner).toHaveBeenCalledTimes(3);
    expect(s.h.getFailed()).toBeNull();

    // 之后的自动轮询恢复正常（不会被陈旧的失败记录永久拦住）
    await s.h.runUpdateCheck();
    expect(s.inner).toHaveBeenCalledTimes(4);
  });

  it("F1-01：暂时性失败下用户点徽标同样不受退避约束、失败累计退避次数；成功暂存清掉退避记录、自动轮询恢复", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("503", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(s.h.getRetry()).toMatchObject({ version: V, failures: 1 });

      // 退避期内用户点徽标：显式重试照样真下一次；仍失败 → 累计到第 2 次（退避翻倍）
      advance(1 * MIN);
      await expect(s.h.downloadAndStageMacUpdate(V)).rejects.toBeInstanceOf(UpdateVerifyUnavailableError);
      expect(s.inner).toHaveBeenCalledTimes(2);
      expect(s.h.getRetry()).toMatchObject({ version: V, failures: 2 });
      expect(s.h.getFailed()).toBeNull();

      // 这次网络好了、用户再点：成功暂存 → 退避记录清掉
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await expect(s.h.downloadAndStageMacUpdate(V)).resolves.toMatchObject({ version: V });
      expect(s.h.getRetry()).toBeNull();

      // 退避期本该还没过，但记录已清：自动轮询立即恢复（不会被陈旧记录拦住）
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(4);
    }));

  // ---- F1-01：Unavailable 只退避、不永久跳过（第五轮审查：一次瞬时 503 / 超时就让该版本在进程内永久不再自动暂存）----
  const MIN = 60_000;
  /** 只伪造 Date（不碰 setTimeout，flush 要用真实的）；advance 把时钟往后拨 */
  const withClock = async (fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
      await fn((ms) => vi.setSystemTime(Date.now() + ms));
    } finally {
      vi.useRealTimers();
    }
  };

  it("F1-01：暂时性失败（Unavailable）按时间退避——5 分钟内不重下、到点后允许再试、再败退避加倍；不登记「永久跳过」", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(s.h.getFailed()).toBeNull(); // 一次瞬时失败不能让该版本在本进程内永久被跳过

      advance(4 * MIN);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1); // 仍在首次退避期（5 分钟）内
      expect(s.deps.log.mock.calls.some((c) => String(c[0]).includes("跳过自动暂存"))).toBe(true);

      advance(2 * MIN); // 累计 6 分钟 > 5 分钟
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(2); // 到点允许再试

      // 第二次仍失败：退避翻倍到 10 分钟
      advance(9 * MIN);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(2);
      advance(2 * MIN); // 累计 11 分钟 > 10 分钟
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
    }));

  it("F1-01：设置页「检查更新」同样遵守退避；退避过后恢复自动暂存，成功后清退避记录", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("503", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);

      advance(1 * MIN);
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(1); // 退避期内不重下

      advance(5 * MIN);
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(2); // 到点：手动检查也允许重试，这次成功
      expect(s.h.getFailed()).toBeNull();

      // 成功后记录已清：下一轮自动检查不再受旧退避约束
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
    }));

  it("新版本出现不被旧版本的失败拦住：failedVersion 是版本级的", async () => {
    let latest = V;
    const s = setup(
      async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      },
      () => latest,
    );
    await s.h.runUpdateCheck();
    await s.h.runUpdateCheck();
    expect(s.inner).toHaveBeenCalledTimes(1);

    latest = "9.10.0";
    await s.h.runUpdateCheck();
    expect(s.inner).toHaveBeenCalledTimes(2);
    expect(s.h.getFailed()).toBe("9.10.0");
  });

  it("F1-01：退避记录同样是版本级的——旧版本退避中，新版本立即放行，且从第 1 次重新累计", () =>
    withClock(async () => {
      let latest = V;
      const s = setup(
        async () => {
          throw new UpdateVerifyUnavailableError("503", "manifest-http");
        },
        () => latest,
      );
      await s.h.runUpdateCheck();
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1); // 旧版本退避中

      latest = "9.10.0";
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(2); // 新版本不被拦
      expect(s.h.getRetry()).toMatchObject({ version: "9.10.0", failures: 1 });
    }));

  it("F1-01：系统时钟被往回拨时不会把自动更新卡死（剩余退避超过上限视为时钟漂移、放行）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("503", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);

      advance(-24 * 60 * MIN); // 时钟回拨一天：notBefore - now ≈ 24h + 5min，远超 2h 上限
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(2);
    }));

  // ---- 第七轮 P2-2：未归类错误（dmg 下载 502 / 不完整 / hdiutil / ditto / 找不到 .app）也要退避 ----
  // 旧行为：catch 里只登记「永久」与「暂时（Unavailable）」两类，未归类错误既不登记也不弹框——
  // 每次轮询、每次设置页「检查更新」都走完「清单 → 下载 100MB+ → 失败 → 删除」，用户毫不知情（mac 的 UI 不展示 updateState.error）。
  // 新行为：任何非永久失败都登记时间退避；同一版本连续失败 ≥ 3 次弹一次「多次失败」说明框（见下面）。
  // 如实说明（同 update-verify-retry.mjs 文件头）：退避只挡非轮询触发的自动暂存，对 2h 轮询前 5 次失败无效——
  // 所以下面「第二次被跳过」的用例是连续调用（模拟设置页反复点 / 启动检查紧跟其后），不是在说「轮询被挡住」。
  const unclassifiedFailures: Array<[string, () => Error]> = [
    ["dmg 下载 HTTP 502", () => new Error("下载失败 HTTP 502")],
    ["dmg 下载不完整", () => new Error("dmg 下载不完整（1/2 字节）、已中止暂存")],
    ["hdiutil attach 失败", () => new Error("Command failed: hdiutil attach")],
    ["ditto 失败（磁盘满）", () => new Error("Command failed: ditto ENOSPC")],
    ["dmg 里没找到 .app", () => new Error("dmg 里没找到 .app")],
  ];

  it.each(unclassifiedFailures)(
    "P2-2 未归类失败（%s）：首次就登记退避——连续两次 runUpdateCheck，第二次被退避跳过、inner 只调 1 次；不登记永久跳过；到点放行、成功后清零",
    (_n, mk) =>
      withClock(async (advance) => {
        const s = setup(async () => {
          throw mk();
        });
        await s.h.runUpdateCheck();
        expect(s.inner).toHaveBeenCalledTimes(1);
        expect(s.h.getRetry()).toMatchObject({ version: V, failures: 1 });
        expect(s.h.getFailed()).toBeNull(); // 不是永久：dmg 502 / 磁盘满这类可能自愈

        await s.h.runUpdateCheck(); // 紧跟着的第二次：被退避挡住，不再「下载 100MB+ → 失败 → 删除」
        expect(s.inner).toHaveBeenCalledTimes(1);
        expect(s.deps.log.mock.calls.some((c) => String(c[0]).includes("退避中"))).toBe(true);

        advance(6 * MIN); // 过了首次退避（5 分钟）：放行；再败则退避翻倍
        await s.h.runUpdateCheck();
        expect(s.inner).toHaveBeenCalledTimes(2);
        expect(s.h.getRetry()).toMatchObject({ version: V, failures: 2 });

        // 自愈：到点后这次成功 → 退避记录清零、徽标 ready、error 清空
        advance(11 * MIN);
        s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
        await s.h.runUpdateCheck();
        expect(s.inner).toHaveBeenCalledTimes(3);
        expect(s.h.getRetry()).toBeNull();
        expect(s.h.getState()).toMatchObject({ phase: "ready", error: null });
      }),
  );

  it("P2-2 设置页「检查更新」同样遵守未归类失败的退避：不再反复下 dmg", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      advance(1 * MIN);
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(1); // 退避期内没有再下
      advance(5 * MIN);
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(2); // 到点放行
    }));

  const dialogsOf = (s: { deps: { dialog: { showErrorBox: { mock: { calls: unknown[][] } } } } }) =>
    s.deps.dialog.showErrorBox.mock.calls as unknown as Array<[string, string]>;

  it("P2-2 同一版本连续失败 3 次：弹一次「自动更新多次失败」说明框（不开发布页、不消耗 wasPrompted）；前两次静默，之后继续失败也不再弹", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck(); // 第 1 次
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次
      expect(s.inner).toHaveBeenCalledTimes(2);
      expect(dialogsOf(s)).toHaveLength(0); // 前两次静默

      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(dialogsOf(s)).toHaveLength(1);
      const [title, body] = dialogsOf(s)[0]!;
      expect(title).toBe("自动更新多次失败");
      expect(body).toContain("下载失败 HTTP 502"); // 最近一次的原因
      expect(body).toContain("更新徽标");
      expect(body).toContain("手动下载");
      expect(s.deps.shell.openExternal).not.toHaveBeenCalled(); // 只提示、不把人往发布页赶
      expect(s.deps.markPrompted).not.toHaveBeenCalled(); // 不消耗「每版本一次」的 wasPrompted 名额
      expect(s.prompted.has(V)).toBe(false);

      // 第八轮 L2-01：第 3 次计入的失败同时登记了「放弃自动暂存」——之后的轮询（即使退避早过期）不再下 dmg、也就不会再失败、再弹框
      advance(21 * MIN);
      await s.h.runUpdateCheck(); // 第 4 次轮询：被闸挡住
      advance(41 * MIN);
      await s.h.runUpdateCheck(); // 第 5 次轮询：同上
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(dialogsOf(s)).toHaveLength(1);
    }));

  it("P2-2 「多次失败」框每个版本（进程内）只弹一次：失败次数继续涨时不再弹（后几次用 Unavailable 让失败继续发生——它不计入 L2-01 的闸，轮询仍会去试）", () =>
    withClock(async (advance) => {
      const seq: Array<() => Error> = [
        () => new Error("下载失败 HTTP 502"),
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
      ];
      let i = 0;
      const s = setup(async () => {
        throw seq[i++]!();
      });
      for (const wait of [0, 6 * MIN, 11 * MIN]) {
        advance(wait);
        await s.h.runUpdateCheck(); // 第 1~3 次（failures 累计含 Unavailable）
      }
      expect(dialogsOf(s)).toHaveLength(1); // 第 3 次弹「多次失败」
      advance(21 * MIN);
      await s.h.runUpdateCheck(); // 第 4 次
      advance(41 * MIN);
      await s.h.runUpdateCheck(); // 第 5 次
      expect(s.inner).toHaveBeenCalledTimes(5);
      expect(s.h.getRetry()).toMatchObject({ failures: 5 });
      expect(dialogsOf(s)).toHaveLength(1); // 每个版本（进程内）只弹一次
      expect(s.h.getGiveUp()).toBeNull(); // 闸只数会白下 dmg 的失败：这里只有第 1 次计入
    }));

  it("P2-2 暂时性（Unavailable）与未归类失败混着也一起累计：503 → 502 → 503 的第 3 次弹框", () =>
    withClock(async (advance) => {
      const seq = [
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
        () => new Error("下载失败 HTTP 502"),
        () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
      ];
      let i = 0;
      const s = setup(async () => {
        throw seq[i++]!();
      });
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      expect(dialogsOf(s)).toHaveLength(0);
      advance(11 * MIN);
      await s.h.runUpdateCheck();
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新多次失败");
    }));

  it("P2-2 反例钉死：「多次失败」提示不占用 wasPrompted——之后同一版本真出现「确定不符」仍弹框 + 开发布页 + 记提示（若占用名额，这里会被 alreadyPrompted 静默、安全告警丢失）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
      });
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      advance(11 * MIN);
      await s.h.runUpdateCheck();
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新多次失败");
      expect(s.deps.markPrompted).not.toHaveBeenCalled();

      // 第 4 次：这回清单拿到了、SHA-256 对不上
      advance(21 * MIN);
      s.inner.mockImplementationOnce(async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(4);
      expect(dialogsOf(s)).toHaveLength(2);
      expect(dialogsOf(s)[1]![0]).toBe("自动更新已中止");
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
      expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
      expect(s.deps.markPrompted).toHaveBeenCalledWith(V);
    }));

  it("P2-2 第 3 次失败恰好是确定不符：只弹确定不符那一个框（它自己就是反馈），不再额外弹「多次失败」", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      advance(11 * MIN);
      s.inner.mockImplementationOnce(async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新已中止");
    }));

  it("P2-2 失败计数按版本、换版本清零：旧版本弹过不影响新版本，新版本从第 1 次重新累计，满 3 次再弹一次", () =>
    withClock(async (advance) => {
      let latest = V;
      const s = setup(
        async () => {
          throw new Error("下载失败 HTTP 502");
        },
        () => latest,
      );
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      advance(11 * MIN);
      await s.h.runUpdateCheck();
      expect(dialogsOf(s)).toHaveLength(1); // V 的第 3 次

      latest = "9.10.0";
      await s.h.runUpdateCheck(); // 新版本第 1 次：退避记录是旧版本的、不拦它
      expect(s.h.getRetry()).toMatchObject({ version: "9.10.0", failures: 1 });
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次
      expect(dialogsOf(s)).toHaveLength(1);
      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次
      expect(dialogsOf(s)).toHaveLength(2);
      expect(dialogsOf(s)[1]![1]).toContain("9.10.0");
    }));

  it("P2-2 成功暂存清零「连续失败」：失败 2 次 → 成功 → 再失败 2 次不弹框，满 3 次才弹", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      expect(s.h.getRetry()).toMatchObject({ failures: 2 });

      advance(11 * MIN);
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await s.h.runUpdateCheck(); // 成功
      expect(s.h.getRetry()).toBeNull();

      // 暂存丢了、又失败：计数从 1 开始
      await s.h.runUpdateCheck(); // 第 1 次（新一轮）
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次
      expect(dialogsOf(s)).toHaveLength(0);
      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次
      expect(dialogsOf(s)).toHaveLength(1);
    }));

  it("P2-2 成功暂存也清掉「已弹过多次失败」标记：弹过一次 → 成功 → 同一版本重新连续失败 3 次，会再弹一次（连续失败从头算）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck(); // 第 1 次
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次
      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次 → 弹
      expect(dialogsOf(s)).toHaveLength(1);

      advance(21 * MIN); // 第 3 次之后退避 20 分钟
      expect(s.h.getGiveUp()).toBe(V); // L2-01：此刻后台轮询已被闸挡住，要靠用户手动检查发起这次尝试
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await s.h.manualCheckForUpdate(); // 成功：失败记录、闸与「已弹过」标记一并清掉
      await flush();
      expect(s.h.getRetry()).toBeNull();
      expect(s.h.getGiveUp()).toBeNull();

      // 暂存丢了、同一版本又连续失败 3 次：这是新的一轮故障，应当再说明一次
      await s.h.runUpdateCheck(); // 新一轮第 1 次
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次
      expect(dialogsOf(s)).toHaveLength(1);
      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次
      expect(dialogsOf(s)).toHaveLength(2);
      expect(dialogsOf(s)[1]![0]).toBe("自动更新多次失败");
    }));

  it("P2-2 用户点徽标（downloadAndStageMacUpdate）的失败也计入连续失败次数——计数与退避记录同源", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck(); // 第 1 次
      advance(1 * MIN);
      await expect(s.h.downloadAndStageMacUpdate(V)).rejects.toThrow("502"); // 点徽标：第 2 次（不受退避约束）
      expect(s.h.getRetry()).toMatchObject({ failures: 2 });
      advance(11 * MIN);
      await s.h.runUpdateCheck(); // 第 3 次：后台触发 → 弹「多次失败」
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新多次失败");
    }));

  // ---- 第八轮 L2-01：按 failures 设闸——未归类失败连续 3 次后，后台轮询不再自动暂存（不再每 2 小时整包重下 dmg）----
  // 背景：退避只读 notBefore、不读 failures，而前 5 次失败的退避都短于轮询周期（update-verify-retry.test.ts「轮询节奏」），
  // 所以 2 小时轮询对未归类失败（dmg 502 / 不完整 / hdiutil / ditto / 找不到 .app）每轮都放行、每轮整包重下。
  // 闸：同一版本「会白下 dmg 的失败」（未归类 + local-io）连续 ≥ 3 次 → 登记 macStageGiveUpVersion；runUpdateCheck 遇到它跳过自动暂存、只记日志。
  // 解除：换版本 / 成功暂存 / 用户手动检查或点徽标发起一次尝试（失败则重新登记）/ 重启（内存变量）。
  // 计数口径：不分触发方式（后台 / 设置页检查更新 / 点徽标的失败都计）；Unavailable（清单阶段，下载之前就败）既不计入也不清零。
  const HOUR = 60 * MIN;
  const armGate = async (
    s: ReturnType<typeof setup>,
    advance: (ms: number) => void,
  ): Promise<void> => {
    // 三次后台轮询、每次都过了上一次的退避（5 / 10 分钟）
    for (const wait of [0, 6 * MIN, 11 * MIN]) {
      advance(wait);
      await s.h.runUpdateCheck();
    }
    expect(s.inner).toHaveBeenCalledTimes(3);
  };
  const gateLogged = (s: { deps: { log: { mock: { calls: unknown[][] } } } }) =>
    s.deps.log.mock.calls.some((c) => String(c[0]).includes("放弃自动暂存"));

  it("L2-01 同一版本连续三次未归类失败后：第 4 次后台 runUpdateCheck 不再调用 inner（实际暂存）——即使退避早已过期；只记一行日志", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await armGate(s, advance);
      expect(s.h.getGiveUp()).toBe(V);
      expect(s.h.getCostly()).toEqual({ version: V, count: 3 });

      advance(24 * HOUR); // 退避（第 3 次后 20 分钟）早已过期——证明挡住轮询的是闸、不是退避
      expect(isVerifyRetryBlocked(s.h.getRetry(), V, Date.now())).toBe(false);
      await s.h.runUpdateCheck(); // 第 4 次
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(gateLogged(s)).toBe(true);
      advance(2 * HOUR);
      await s.h.runUpdateCheck(); // 之后每 2 小时一轮，都不再碰 dmg
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
      // 徽标仍亮、错误原因仍在（用户点徽标就是显式重试）
      expect(s.h.getState()).toMatchObject({ phase: "available", version: V, error: "下载失败 HTTP 502" });
      // 闸不是永久登记：没有写 macVerifyFailedVersion
      expect(s.h.getFailed()).toBeNull();
    }));

  it("L2-01 只失败 2 次时闸未登记：第 3 次轮询（退避过后）照常去试（阈值是 3、不是 2）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      advance(0);
      await s.h.runUpdateCheck();
      advance(6 * MIN);
      await s.h.runUpdateCheck();
      expect(s.h.getGiveUp()).toBeNull();
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
    }));

  it("L2-01 手动检查仍会调用 inner（退避过后）；成功暂存后闸解除、后台轮询恢复", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await armGate(s, advance);
      advance(HOUR);
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      const r = await s.h.manualCheckForUpdate();
      await flush();
      expect(r.status).toBe("available");
      expect(s.inner).toHaveBeenCalledTimes(4); // 手动检查不看闸
      expect(s.h.getGiveUp()).toBeNull(); // 成功暂存：闸解除
      expect(s.h.getCostly()).toBeNull();
      expect(s.h.getState()).toMatchObject({ phase: "ready", error: null });

      // 之后后台轮询恢复（暂存丢了再失败时从头计）
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(5);
      expect(s.h.getCostly()).toEqual({ version: V, count: 1 });
    }));

  it("L2-01 手动检查那次尝试失败：闸保持登记（不会借此多放后台 3 次）；后台轮询继续被挡", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await armGate(s, advance);
      advance(HOUR);
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(4); // 手动那次真的去试了
      expect(s.h.getCostly()).toEqual({ version: V, count: 4 });
      expect(s.h.getGiveUp()).toBe(V);
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(4);
    }));

  it("L2-01 用户点徽标（downloadAndStageMacUpdate）不看闸、成功后闸解除；失败则继续计数", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await armGate(s, advance);
      await expect(s.h.downloadAndStageMacUpdate(V)).rejects.toThrow("502"); // 不受闸与退避约束
      expect(s.inner).toHaveBeenCalledTimes(4);
      expect(s.h.getCostly()).toEqual({ version: V, count: 4 });
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await expect(s.h.downloadAndStageMacUpdate(V)).resolves.toMatchObject({ version: V });
      expect(s.h.getGiveUp()).toBeNull();
      expect(s.h.getCostly()).toBeNull();
      advance(HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(6);
    }));

  it("L2-01 换版本解除：旧版本被闸挡住后新版本立即放行，且从第 1 次重新计", () =>
    withClock(async (advance) => {
      let latest = V;
      const s = setup(
        async () => {
          throw new Error("下载失败 HTTP 502");
        },
        () => latest,
      );
      await armGate(s, advance);
      advance(HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3); // 旧版本被挡

      latest = "9.10.0";
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(4); // 新版本不被旧版本的闸拦住
      expect(s.h.getCostly()).toEqual({ version: "9.10.0", count: 1 });
      expect(s.h.getGiveUp()).toBe(V); // 旧登记还在、但只按版本相等判断，不影响新版本
    }));

  it("L2-01 反例钉死：Unavailable（清单 503）不计入闸——连续 6 次 503 的轮询每次都去试（F1-01 自愈不被废掉），网络恢复后成功", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
      });
      for (let i = 0; i < 6; i++) {
        advance(2 * HOUR); // 每轮都过了退避（封顶 2 小时的边界由 +2h 之外的失败耗时决定，这里不计耗时）
        await s.h.runUpdateCheck();
      }
      expect(s.inner).toHaveBeenCalledTimes(6);
      expect(s.h.getGiveUp()).toBeNull();
      expect(s.h.getCostly()).toBeNull();

      advance(2 * HOUR);
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await s.h.runUpdateCheck(); // 网络恢复：自愈
      expect(s.h.getState()).toMatchObject({ phase: "ready", error: null });
    }));

  it("L2-01 Unavailable 穿插在中间既不计数也不清零：502 → 503 → 502 → 503 → 502 的第 3 次计入失败登记闸", () =>
    withClock(async (advance) => {
      const seq: Array<() => Error> = [
        () => new Error("下载失败 HTTP 502"),
        () => new UpdateVerifyUnavailableError("503", "manifest-http"),
        () => new Error("下载失败 HTTP 502"),
        () => new UpdateVerifyUnavailableError("503", "manifest-http"),
        () => new Error("下载失败 HTTP 502"),
      ];
      let i = 0;
      const s = setup(async () => {
        throw seq[i++]!();
      });
      for (let n = 0; n < 5; n++) {
        advance(2 * HOUR);
        await s.h.runUpdateCheck();
        if (n < 4) expect(s.h.getGiveUp(), `第 ${n + 1} 次后`).toBeNull();
      }
      expect(s.inner).toHaveBeenCalledTimes(5);
      expect(s.h.getCostly()).toEqual({ version: V, count: 3 });
      expect(s.h.getGiveUp()).toBe(V);
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(5);
    }));

  it("L2-01 永久失败（确定不符 / 没带清单）不进闸的计数：它们走 macVerifyFailedVersion 永久跳过", async () => {
    for (const mk of [
      () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      () => new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing"),
    ]) {
      const s = setup(async () => {
        throw mk();
      });
      await s.h.runUpdateCheck();
      expect(s.h.getFailed()).toBe(V);
      expect(s.h.getCostly()).toBeNull();
      expect(s.h.getGiveUp()).toBeNull();
    }
  });

  it("L2-01 local-io（Unavailable，但 dmg 已下完才读盘失败）计入闸：3 次后轮询不再重下", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("读取已下载的安装包失败：EBUSY、已中止替换", "local-io");
      });
      for (let n = 0; n < 3; n++) {
        advance(2 * HOUR);
        await s.h.runUpdateCheck();
      }
      expect(s.h.getGiveUp()).toBe(V);
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
    }));

  it("L2-01 失败计数不分触发方式：后台 1 次 + 点徽标 1 次 + 设置页检查更新 1 次 → 闸登记，之后轮询被挡", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck(); // 后台第 1 次
      await expect(s.h.downloadAndStageMacUpdate(V)).rejects.toThrow("502"); // 点徽标第 2 次（不受退避约束）
      advance(HOUR);
      await s.h.manualCheckForUpdate(); // 设置页检查更新第 3 次
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(s.h.getGiveUp()).toBe(V);
      advance(2 * HOUR);
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(3);
    }));

  it("L2-01 闸与「多次失败」提示框同一个阈值：第 3 次计入失败既登记闸、也弹一次提示（提示文案说的「点更新徽标重试」正是此后唯一的重试入口）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await armGate(s, advance);
      expect(s.h.getGiveUp()).toBe(V);
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新多次失败");
      expect(dialogsOf(s)[0]![1]).toContain("更新徽标");
    }));

  // ---- 第七轮 K3-05：谁登记、谁弹框（把真实口径钉成特征化测试，HANDOFF 据此订正）----
  it("K3-05 登记与是否弹框无关：该版本此前已提示过（wasPrompted）时，确定不符照样登记 macVerifyFailedVersion、只是不再弹框", async () => {
    // HANDOFF 第六轮写的「macVerifyFailedVersion 只在真的弹了框时登记」不属实：
    // 登记在 downloadAndStageMacUpdate 的 catch 里，对任何永久失败、任何触发方式、不管弹没弹框一律登记
    const s = setup(async () => {
      throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
    });
    s.prompted.add(V);
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(s.h.getFailed()).toBe(V);
  });

  it.each([
    [
      "确定不符",
      () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      "自动更新已中止",
      true,
    ],
    [
      "没带 manifest（404）",
      () => new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing"),
      "该版本暂不支持自动校验",
      true,
    ],
  ])(
    "K3-05 设置页「检查更新」触发的暂存：%s 不再被吞——弹框 + 开发布页（trigger=user）；不消耗 wasPrompted；之后后台轮询因已登记而跳过、不重复弹",
    async (_n, mk, expectedTitle, opensPage) => {
      const s = setup(async () => {
        throw mk();
      });
      const r = await s.h.manualCheckForUpdate();
      await flush();
      expect(r.status).toBe("available"); // 手动检查的结果照常先返回「有新版」
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe(expectedTitle);
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(opensPage ? 1 : 0);
      expect(s.deps.markPrompted).not.toHaveBeenCalled(); // 用户触发的反馈不走「每版本一次」的名额
      expect(s.h.getFailed()).toBe(V);

      // 之后的后台轮询：已登记永久跳过——不重下、也不会再弹第二次
      await s.h.runUpdateCheck();
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(dialogsOf(s)).toHaveLength(1);
    },
  );

  it("K3-05 设置页「检查更新」触发的暂存：暂时性失败（503）弹「暂时无法校验更新包」说明、不开发布页；mac 不说「已保留」", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
    });
    await s.h.manualCheckForUpdate();
    await flush();
    expect(dialogsOf(s)).toHaveLength(1);
    expect(dialogsOf(s)[0]![0]).toBe("暂时无法校验更新包");
    expect(dialogsOf(s)[0]![1]).toContain("HTTP 503");
    expect(dialogsOf(s)[0]![1]).not.toContain("保留");
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
    expect(s.deps.markPrompted).not.toHaveBeenCalled();
    expect(s.h.getFailed()).toBeNull();
    expect(s.h.getRetry()).toMatchObject({ failures: 1 });
  });

  // 第八轮 L2-02：以前这条断言「未归类失败也有反馈、且不开发布页」——反馈是有，但文案是验签口径的「暂时无法校验更新包 /
  // 这不代表安装包有问题——请检查网络后…」，对「磁盘满」「dmg 里没找到 .app」这类失败是误导（用户去检查网络也没用）。
  // 现在与 macSelfUpdate（点徽标）的通用分支共用 buildGenericUpdateFailureNotice：同一套标题 / 正文、文案说「将打开下载页」就真的开页。
  it.each([
    ["ditto 磁盘满", "Command failed: ditto ENOSPC"],
    ["dmg 下载 HTTP 502", "下载失败 HTTP 502"],
    ["hdiutil attach 失败", "Command failed: hdiutil attach"],
    ["dmg 里没找到 .app", "dmg 里没找到 .app"],
  ])(
    "K3-05 / L2-02 设置页「检查更新」触发的暂存：非验签类失败（%s）有反馈，且用通用提示（与点徽标同一套标题 / 正文、同样开发布页），不套「暂时无法校验更新包」",
    async (_n, message) => {
      const s = setup(async () => {
        throw new Error(message);
      });
      await s.h.manualCheckForUpdate();
      await flush();
      expect(dialogsOf(s)).toHaveLength(1);
      const [title, body] = dialogsOf(s)[0]!;
      const expected = buildGenericUpdateFailureNotice(new Error(message));
      expect([title, body]).toEqual([expected.title, expected.body]); // 共用同一个函数的产物，不是各抄一份
      expect(title).toBe("自动更新失败");
      expect(body).toContain(message);
      expect(body).toContain("将打开下载页、请手动下载安装");
      expect(body).not.toContain("暂时无法校验");
      expect(body).not.toContain("不代表安装包有问题");
      expect(body).not.toContain("检查网络");
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
      expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
      expect(s.deps.markPrompted).not.toHaveBeenCalled(); // 用户触发的反馈不走「每版本一次」的名额
    },
  );

  it("L2-02 范围：只有 user 触发的非验签类失败走通用提示；验签类（503 / 确定不符 / 没带清单）仍用验签文案；后台触发的非验签类失败仍静默（R6-5 / P2-2）", async () => {
    // 验签类 + user：验签文案（已有用例覆盖标题；这里钉「不是通用文案」）
    const verify = setup(async () => {
      throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
    });
    await verify.h.manualCheckForUpdate();
    await flush();
    expect(dialogsOf(verify)[0]![0]).toBe("暂时无法校验更新包");
    expect(verify.deps.shell.openExternal).not.toHaveBeenCalled();

    // 非验签类 + background：静默、不开页
    const bg = setup(async () => {
      throw new Error("Command failed: ditto ENOSPC");
    });
    await bg.h.runUpdateCheck();
    expect(dialogsOf(bg)).toHaveLength(0);
    expect(bg.deps.shell.openExternal).not.toHaveBeenCalled();
  });

  it("K3-05 设置页「检查更新」被退避 / 永久登记挡住时没有发起暂存、也就没有弹框（只有真失败才反馈）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.runUpdateCheck(); // 后台第 1 次失败：静默
      advance(1 * MIN);
      await s.h.manualCheckForUpdate(); // 退避期内：不发起
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(dialogsOf(s)).toHaveLength(0);
    }));

  it("K3-05 手动检查路径的失败不触发「多次失败」框（它每次失败本来就有自己的反馈、不叠第二个框）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      for (const wait of [0, 6 * MIN, 11 * MIN]) {
        advance(wait);
        await s.h.manualCheckForUpdate();
        await flush();
      }
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(dialogsOf(s)).toHaveLength(3); // 每次失败各一个用户触发的反馈框
      expect(dialogsOf(s).some(([t]) => t === "自动更新多次失败")).toBe(false);
    }));

  it("K3-05 用户点徽标期间（installInFlight）合流到同一次暂存的失败：这里不再弹，由 macSelfUpdate 统一反馈（避免同一次失败弹两个框）；登记照常", async () => {
    let reject: (e: unknown) => void = () => undefined;
    const gate = new Promise<never>((_res, rej) => {
      reject = rej;
    });
    const s = setup(() => gate);
    await s.h.manualCheckForUpdate(); // 手动检查发起暂存、先返回 available
    s.h.setInstallInFlight(true); // 此刻用户点了徽标，macSelfUpdate 合流并持锁
    reject(new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"));
    await flush();
    expect(dialogsOf(s)).toHaveLength(0);
    expect(s.h.getFailed()).toBe(V); // 登记与谁弹框无关
  });

  // ---- 第八轮 L2-03：轮询暂存在途时用户点「检查更新」——同一次失败不能弹两个框、开两次发布页 ----
  // downloadAndStageMacUpdate 单飞：后台轮询（runUpdateCheck）与设置页检查更新（manualCheckForUpdate）合流到同一个 promise，
  // 失败时两边各拿到**同一个 Error 对象**、各跑一遍 handleMacStageFailure（trigger 一个 background、一个 user）。
  // 修法：WeakSet<Error> 记「这个错误对象已经弹过框」，后来的 handler 跳过弹框 / 开页。只跳过「弹框」，其余照常：
  // 后台那边对暂时性 / 未归类失败本来就静默——那种情形用户的 handler 没有被跳过、仍弹自己的反馈（用户点了按钮、在等结果）。
  const deferred = () => {
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<never>((_res, rej) => {
      reject = rej;
    });
    return { promise, reject };
  };
  /** 暂存在途时用户点检查更新：first 决定谁先发起（也就是谁的 handler 先挂上这个 promise） */
  const overlap = async (
    s: ReturnType<typeof setup>,
    gate: ReturnType<typeof deferred>,
    err: unknown,
    first: "poll" | "manual",
  ): Promise<void> => {
    const callsBefore = s.inner.mock.calls.length; // 调用方可能已经跑过几轮失败（累计次数场景）
    let poll: Promise<void>;
    if (first === "poll") {
      poll = s.h.runUpdateCheck();
      await flush(); // 轮询已走到 downloadAndStageMacUpdate、暂存在途
      await s.h.manualCheckForUpdate(); // 用户此刻点「检查更新」：合流到同一次暂存
    } else {
      await s.h.manualCheckForUpdate();
      await flush();
      poll = s.h.runUpdateCheck();
    }
    await flush();
    expect(s.inner).toHaveBeenCalledTimes(callsBefore + 1); // 前提：确实合流成一次暂存、没有第二次下载
    gate.reject(err);
    await poll;
    await flush();
  };

  it.each(["poll", "manual"] as const)(
    "L2-03 永久类（确定不符）：两个 handler 处理同一个 Error，只弹 1 次框、只开 1 次发布页（先发起的是 %s）",
    async (first) => {
      const gate = deferred();
      const s = setup(() => gate.promise);
      await overlap(s, gate, new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"), first);
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新已中止");
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
      expect(s.h.getFailed()).toBe(V); // 登记照常（与谁弹框无关）
    },
  );

  it.each(["poll", "manual"] as const)(
    "L2-03 没带清单（404）同理：只弹 1 次、只开 1 次发布页（先发起的是 %s）",
    async (first) => {
      const gate = deferred();
      const s = setup(() => gate.promise);
      await overlap(
        s,
        gate,
        new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing"),
        first,
      );
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("该版本暂不支持自动校验");
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["poll", "manual"] as const)(
    "L2-03 反馈不丢：暂时性失败（503）后台本来静默，用户那次手动检查仍要弹自己的反馈（恰好 1 个框、不开发布页）（先发起的是 %s）",
    async (first) => {
      const gate = deferred();
      const s = setup(() => gate.promise);
      await overlap(
        s,
        gate,
        new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http"),
        first,
      );
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("暂时无法校验更新包");
      expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it.each(["poll", "manual"] as const)(
    "L2-03 反馈不丢：非验签类失败（ditto 磁盘满）后台静默，用户手动检查弹通用提示 + 开 1 次发布页（先发起的是 %s）",
    async (first) => {
      const gate = deferred();
      const s = setup(() => gate.promise);
      await overlap(s, gate, new Error("Command failed: ditto ENOSPC"), first);
      expect(dialogsOf(s)).toHaveLength(1);
      expect(dialogsOf(s)[0]![0]).toBe("自动更新失败");
      expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
    },
  );

  it("L2-03 第 3 次失败恰好是这次合流：后台的「多次失败」框与用户的反馈框也只弹 1 个（不是同一次失败连弹两个）", () =>
    withClock(async (advance) => {
      let n = 0;
      const gate = deferred();
      const s = setup(() => {
        n += 1;
        if (n <= 2) return Promise.reject(new Error("下载失败 HTTP 502"));
        return gate.promise; // 第 3 次：在途、等测试放行
      });
      await s.h.runUpdateCheck(); // 第 1 次（后台、静默）
      advance(6 * MIN);
      await s.h.runUpdateCheck(); // 第 2 次（后台、静默）
      expect(dialogsOf(s)).toHaveLength(0);
      advance(11 * MIN);
      await overlap(s, gate, new Error("下载失败 HTTP 502"), "poll"); // 第 3 次：与手动检查合流
      expect(s.inner).toHaveBeenCalledTimes(3);
      expect(dialogsOf(s)).toHaveLength(1);
    }));

  it("L2-03 不同的 Error 对象互不影响：两次独立的手动检查失败各弹各的（去重只认同一个错误对象）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new Error("下载失败 HTTP 502");
      });
      await s.h.manualCheckForUpdate();
      await flush();
      advance(6 * MIN);
      await s.h.manualCheckForUpdate();
      await flush();
      expect(s.inner).toHaveBeenCalledTimes(2);
      expect(dialogsOf(s)).toHaveLength(2);
    }));

  it("L2-03 抛出的不是对象（字符串）：WeakSet 放不进去也不能炸——照常反馈、不去重、不留未处理的 rejection", async () => {
    const gate = deferred();
    const s = setup(() => gate.promise);
    await overlap(s, gate, "boom", "poll");
    expect(dialogsOf(s)).toHaveLength(1); // 后台对非验签类静默 + 用户反馈 1 个
    expect(dialogsOf(s)[0]![1]).toContain("boom");
    expect(s.deps.log.mock.calls.some((c) => String(c[0]).includes("反馈出错"))).toBe(false);
  });

  // ---- K3-06（mac 侧）：清单级确定不符发生在下载之前，正文不能说「已清除下载的文件」----
  it.each([
    ["signature", "更新 manifest 签名校验失败、已中止替换"],
    ["version", "manifest 版本不符（9.9.8 ≠ 9.9.9）、已中止替换"],
    ["entry-missing", "manifest 里没有 fe-ai-flow-9.9.9-mac-arm64.dmg 的摘要、已中止替换"],
  ])("K3-06 mac 后台：清单级确定不符（%s）弹框的正文不提「清除」（没有下载过 dmg）；仍弹框 + 开发布页", async (code, message) => {
    const s = setup(async () => {
      throw new UpdateVerifyMismatchError(message, code);
    });
    await s.h.runUpdateCheck();
    expect(dialogsOf(s)).toHaveLength(1);
    const [title, body] = dialogsOf(s)[0]!;
    expect(title).toBe("自动更新已中止");
    expect(body).toContain(message);
    expect(body).toContain("更新校验清单");
    expect(body).not.toContain("清除");
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    expect(s.deps.markPrompted).toHaveBeenCalledWith(V);
  });

  it("设置页「检查更新」触发的后台暂存同样遵守（否则反复点按钮 = 反复下 dmg 再静默失败；确定性失败）", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
    });
    await s.h.runUpdateCheck();
    expect(s.inner).toHaveBeenCalledTimes(1);

    const r = await s.h.manualCheckForUpdate();
    await flush();
    expect(r.status).toBe("available"); // 结果照常告诉用户有新版
    expect(s.inner).toHaveBeenCalledTimes(1); // 但没有再下 dmg
  });

  it("M3-03 同口径：mac 上没带 manifest（404）→ 弹「该版本暂不支持自动校验」+ 开发布页（不是「未通过完整性校验」）", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyManifestMissingError(
        "该版本没有附带更新校验清单（HTTP 404）、已中止替换",
        "manifest-missing",
      );
    });
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("该版本暂不支持自动校验");
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![1]).toContain("HTTP 404");
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![1]).toContain("手动下载");
    expect(s.deps.dialog.showErrorBox.mock.calls[0]![1]).not.toContain("未通过完整性校验");
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith("https://example.invalid/releases/latest");
  });

  // ---- 第六轮 R6-5：mac 暂存失败的处置与 Windows 对齐（按失败类型分三路、复用 buildVerifyRejectionNotice）----
  // 旧行为：runUpdateCheck 对 mac 的**任何**暂存失败都弹「未通过完整性校验」+ 开发布页 + 用掉该版本唯一一次提示——
  // 一次 503 就让用户看到误导性弹框（包根本没被改），之后真出了「确定不符」也不会再提示。
  // 新行为：确定不符 / 没带清单 = 弹框 + 开发布页 + 记 wasPrompted（文案取 notice.title / notice.body）；
  // 暂时性失败 = 不弹框、不开发布页、不消耗 wasPrompted，错误文案写进 updateState.error，由 2h 轮询自愈。
  const RELEASE = "https://example.invalid/releases/latest";

  it("R6-5 确定不符：弹框（标题 / 正文取 notice：自动更新已中止 + 已清除下载的文件）+ 开发布页 + 记 wasPrompted", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
    });
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = s.deps.dialog.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe("自动更新已中止");
    expect(body).toContain("SHA-256 校验失败");
    expect(body).toContain("清除下载的文件"); // mac 的 dmg 在 finally 里确实会删，文案属实
    expect(body).toContain("手动下载");
    expect(s.deps.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    expect(s.deps.markPrompted).toHaveBeenCalledTimes(1);
    expect(s.deps.markPrompted).toHaveBeenCalledWith(V);
    expect(s.h.getState()).toMatchObject({
      phase: "available",
      version: V,
      error: "安装包 SHA-256 校验失败、已中止替换",
    });
  });

  it.each([
    ["manifest 下载 HTTP 503", () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http")],
    ["网络超时", () => new UpdateVerifyUnavailableError("更新 manifest 下载失败：The operation was aborted due to timeout、已中止替换", "manifest-network")],
    ["200 却不是清单形态", () => new UpdateVerifyUnavailableError("更新 manifest 结构非法、已中止替换", "manifest-invalid")],
    ["本地读 dmg 失败", () => new UpdateVerifyUnavailableError("读取已下载的安装包失败：EBUSY、已中止替换", "local-io")],
    ["未归类错误（dmg 下载 HTTP 502，与 Windows 同口径归暂时性）", () => new Error("下载失败 HTTP 502")],
  ])(
    "R6-5 暂时性失败（%s）：不弹框、不开发布页、不消耗 wasPrompted；错误文案进 updateState.error、徽标仍亮",
    async (_n, mk) => {
      const s = setup(async () => {
        throw mk();
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1); // 确实走了失败路径
      expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
      expect(s.deps.markPrompted).not.toHaveBeenCalled();
      expect(s.prompted.has(V)).toBe(false);
      // 用户在徽标上看到的是「新版本 vX」（available），错误原因留在状态里供 UI / 排障取用
      expect(s.h.getState()).toMatchObject({ phase: "available", version: V, error: mk().message });
      // 静默 ≠ 无痕：要留日志，排障时能看出「为什么没弹框」
      expect(s.deps.log.mock.calls.some((c) => String(c[0]).includes(mk().message))).toBe(true);
    },
  );

  it("R6-5 暂时性失败不消耗提示名额：之后同一版本真出现「确定不符」时仍然弹框 + 开发布页（以前一次 503 就把唯一一次提示用掉了）", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();

      // 退避期（5 分钟）过后的下一轮：这回清单拿到了、但 SHA-256 对不上
      advance(6 * MIN);
      s.inner.mockImplementationOnce(async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      });
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(2);
      expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
      expect(s.deps.dialog.showErrorBox.mock.calls[0]![0]).toBe("自动更新已中止");
      expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
      expect(s.deps.markPrompted).toHaveBeenCalledWith(V);
    }));

  it("R6-5 暂时性失败后的自愈与重试：到点轮询成功 → ready 且 error 清空、从头到尾没弹过框；点徽标（显式重试）同样可成功", () =>
    withClock(async (advance) => {
      const s = setup(async () => {
        throw new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
      });
      await s.h.runUpdateCheck();
      expect(s.h.getState()).toMatchObject({ phase: "available", error: expect.stringContaining("503") });

      // 网络恢复、退避过后的轮询：自愈
      advance(6 * MIN);
      s.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await s.h.runUpdateCheck();
      expect(s.h.getState()).toMatchObject({ phase: "ready", version: V, percent: 100, error: null });
      expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(s.deps.shell.openExternal).not.toHaveBeenCalled();

      // 另一条路径：失败后用户在退避期内直接点徽标（downloadAndStageMacUpdate 不受退避约束）
      const t = setup(async () => {
        throw new UpdateVerifyUnavailableError("503", "manifest-http");
      });
      await t.h.runUpdateCheck();
      t.inner.mockImplementationOnce(async () => ({ version: V, appPath: "/tmp/staged.app" }));
      await expect(t.h.downloadAndStageMacUpdate(V)).resolves.toMatchObject({ version: V });
      expect(t.h.getState()).toMatchObject({ phase: "ready", error: null });
      expect(t.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    }));

  it("R6-5 没带 manifest（404）：弹框用 notice 文案（该版本暂不支持自动校验）+ 开发布页 + 记 wasPrompted", async () => {
    const s = setup(async () => {
      throw new UpdateVerifyManifestMissingError(
        "该版本没有附带更新校验清单（HTTP 404）、已中止替换",
        "manifest-missing",
      );
    });
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = s.deps.dialog.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe("该版本暂不支持自动校验");
    expect(body).toContain("HTTP 404");
    expect(body).toContain("手动下载");
    expect(body).not.toContain("检查网络"); // 重试一万次也不会有清单，别让人去「检查网络」
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    expect(s.deps.markPrompted).toHaveBeenCalledWith(V);
  });

  it("R6-5 该版本已提示过（wasPrompted）：确定不符 / 没带清单也不重复弹框、不重复开发布页、不重复记（保留每版本只提示一次）", async () => {
    for (const mk of [
      () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256"),
      () => new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing"),
    ]) {
      const s = setup(async () => {
        throw mk();
      });
      s.prompted.add(V); // 比如上次启动时已经弹过一次
      await s.h.runUpdateCheck();
      expect(s.inner).toHaveBeenCalledTimes(1);
      expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
      expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
      expect(s.deps.markPrompted).not.toHaveBeenCalled();
      // 徽标上的错误原因照常更新
      expect(s.h.getState()).toMatchObject({ phase: "available", error: mk().message });
    }
  });

  it("R6-5 新版本不被旧版本的提示名额拦住：wasPrompted 是版本级的", async () => {
    let latest = V;
    const s = setup(
      async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      },
      () => latest,
    );
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    latest = "9.10.0";
    await s.h.runUpdateCheck();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(2);
    expect(s.deps.markPrompted).toHaveBeenLastCalledWith("9.10.0");
  });
});

describe("③f F1-01：mac 暂存「先取清单、再下 dmg」（真实执行 downloadAndStageMacUpdateInner 的函数体）", () => {
  // 背景：M3-04 的根因是先下 112MB 的 dmg、后取清单——清单取不到 / 验不过时 dmg 白下一遍（还要在 finally 里删掉）。
  // 清单只有几百字节，挪到下载之前后：取不到就根本不下；取到了随后复用、不重复请求。
  // 最终裁决没变：下载完仍用「实测 size / SHA-256」对清单做 verifyManifestEntry。
  const MAC_V = "9.9.9";
  const DMG = `fe-ai-flow-${MAC_V}-mac-arm64.dmg`;
  const DMG_BYTES = "fake-dmg-bytes-0123456789";
  const dmgEntry = (): ManifestFile => ({
    name: DMG,
    size: Buffer.byteLength(DMG_BYTES),
    sha256: sha256Of(DMG_BYTES),
  });
  const macManifest = () => signManifest(privateKey, MAC_V, [dmgEntry()]);
  const FNS = ["loadSignedManifest", "verifyDownloadedUpdate", "downloadAndStageMacUpdateInner"];

  const setup = (
    manifestResponse: () => Promise<Response> = async () => new Response(JSON.stringify(macManifest())),
    over: { dmgSha256?: string } = {},
  ) => {
    const events: string[] = [];
    const fetchManifest = vi.fn(async (o: { url: string }) => {
      events.push("manifest");
      return fetchUpdateManifest({ ...o, fetchImpl: manifestResponse });
    });
    // 形参只用来让 mock.calls 带上 [string] 的类型
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const dmgFetch = vi.fn(async (_url: string) => {
      events.push("dmg");
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from(DMG_BYTES);
        })(),
        headers: { get: () => String(Buffer.byteLength(DMG_BYTES)) },
      };
    });
    const deps = {
      readStagedMeta: vi.fn(async () => null),
      existsSync: vi.fn(() => false),
      clearStagedUpdate: vi.fn(async () => undefined),
      process: { arch: "arm64" },
      runningAppPath: () => "/Applications/Flowship.app",
      updatesDirPath: () => "/tmp/flowship-updates",
      path,
      mkdirSync: vi.fn(),
      log: vi.fn(),
      setUpdateState: vi.fn(),
      fetch: dmgFetch,
      mainWindow: { setProgressBar: vi.fn() },
      createWriteStream: vi.fn(() => ({
        write: () => true,
        once: () => undefined,
        end: (cb: (e?: Error) => void) => cb(),
      })),
      fs: {
        rm: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ size: Buffer.byteLength(DMG_BYTES) })),
      },
      execFileStrict: vi.fn(async () => undefined),
      execFileP: vi.fn(async () => undefined),
      readdirSync: vi.fn(() => ["Flowship.app"]),
      writeStagedMeta: vi.fn(async () => undefined),
      // verifyDownloadedUpdate 的依赖（真实验签函数 + 注入 IO）
      readFileSync: vi.fn(() => `${pubPem}\n`),
      UPDATE_MANIFEST_PUBLIC_KEY_PATH: "/app/update-manifest-public-key.pem",
      fetchUpdateManifest: fetchManifest,
      findSignedManifestEntry,
      verifyManifestEntry,
      UpdateVerifyUnavailableError,
      sha256File: vi.fn(async () => over.dmgSha256 ?? sha256Of(DMG_BYTES)),
    };
    const run = instantiateMany<(v: string) => Promise<unknown>>(
      FNS,
      deps,
      "",
      "return downloadAndStageMacUpdateInner;",
    );
    return { deps, run: () => run(MAC_V), events, fetchManifest, dmgFetch };
  };

  it("清单与安装包都正常：先取清单、再下 dmg；清单只请求一次（下载后复用、不重复请求）；暂存成功", async () => {
    const s = setup();
    await expect(s.run()).resolves.toMatchObject({ version: MAC_V });
    expect(s.events).toEqual(["manifest", "dmg"]);
    expect(s.fetchManifest).toHaveBeenCalledTimes(1);
    expect(s.fetchManifest.mock.calls[0]![0].url).toBe(
      `https://github.com/jianger666/Flowship/releases/download/v${MAC_V}/update-manifest.json`,
    );
    expect(s.deps.sha256File).toHaveBeenCalledTimes(1); // 下载后仍实测 SHA-256
    expect(s.deps.writeStagedMeta).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP 503（限流 / 抖动）", () => Promise.resolve(new Response("x", { status: 503 })), UpdateVerifyUnavailableError, "manifest-http"],
    ["断网", () => Promise.reject(new TypeError("fetch failed")), UpdateVerifyUnavailableError, "manifest-network"],
    ["HTTP 404（该 release 没带清单）", () => Promise.resolve(new Response("x", { status: 404 })), UpdateVerifyManifestMissingError, "manifest-missing"],
    ["200 但正文是 {}（F1-04）", () => Promise.resolve(new Response("{}")), UpdateVerifyUnavailableError, "manifest-invalid"],
    [
      "清单签名不对（别人签的）",
      () => Promise.resolve(new Response(JSON.stringify(signManifest(other.privateKey, MAC_V, [dmgEntry()])))),
      UpdateVerifyMismatchError,
      "signature",
    ],
    [
      "清单里没有这个 dmg 的条目",
      () => Promise.resolve(new Response(JSON.stringify(signManifest(privateKey, MAC_V, [{ name: "other.dmg", size: 1, sha256: "0".repeat(64) }])))),
      UpdateVerifyMismatchError,
      "entry-missing",
    ],
  ])(
    "清单取不到 / 验不过（%s）：直接抛对应类型的错，一个字节的 dmg 都不下载、不落盘",
    async (_n, manifestResponse, ErrType, code) => {
      const s = setup(manifestResponse);
      const err = await catchAsync(s.run);
      expect(err).toBeInstanceOf(ErrType);
      expect((err as { code: string }).code).toBe(code);
      expect(s.dmgFetch).not.toHaveBeenCalled();
      expect(s.deps.createWriteStream).not.toHaveBeenCalled();
      expect(s.deps.sha256File).not.toHaveBeenCalled();
      expect(s.deps.execFileStrict).not.toHaveBeenCalled(); // 没 attach / ditto
      expect(s.deps.writeStagedMeta).not.toHaveBeenCalled();
    },
  );

  it("最终裁决没变：清单预检通过、但下载下来的 dmg 实测 SHA-256 与清单不符 → 仍是 Mismatch(sha256)、不 attach", async () => {
    const s = setup(undefined, { dmgSha256: "0".repeat(64) });
    const err = await catchAsync(s.run);
    expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((err as UpdateVerifyMismatchError).code).toBe("sha256");
    expect(s.events).toEqual(["manifest", "dmg"]);
    expect(s.deps.execFileStrict).not.toHaveBeenCalled();
    expect(s.deps.writeStagedMeta).not.toHaveBeenCalled();
  });
});

describe("③g K3-04 mac 点徽标（macSelfUpdate 真实函数体）：验签类失败与 Windows 对齐，其余保持通用弹框", () => {
  // 背景：macSelfUpdate 的 catch 对**任何**失败都弹「自动更新失败 … 将打开下载页」并开发布页——
  // 暂时性失败（一次 503）也把用户往发布页赶，而 Windows（rejectUnverifiedWinUpdate）对暂时性失败是「弹框说明、不开页」。
  // 修法：验签类错误取 buildVerifyRejectionNotice(err, {trigger:"user"}) 的标题 / 正文 / 是否开页；其余（下载 502、hdiutil、ditto、
  // 套用失败……）不是「校验」问题、保持通用弹框。
  const V = "9.9.9";
  const RELEASE = "https://example.invalid/releases/latest";

  const setup = (over: { stage?: () => Promise<unknown>; apply?: () => Promise<unknown> } = {}) => {
    const deps = {
      log: vi.fn(),
      downloadAndStageMacUpdate: vi.fn(over.stage ?? (async () => ({ version: V, appPath: "/tmp/staged.app" }))),
      applyStagedUpdate: vi.fn(over.apply ?? (async () => undefined)),
      readStagedMeta: vi.fn(async () => null),
      existsSync: vi.fn(() => false),
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      mainWindow: { setProgressBar: vi.fn() },
      RELEASE_LATEST_URL: RELEASE,
      buildVerifyRejectionNotice,
      isVerifyFailure,
      // 第八轮 L2-02：非验签类失败的通用提示（与设置页检查更新的 handleMacStageFailure 共用同一个函数）
      buildGenericUpdateFailureNotice,
    };
    const h = instantiate<{ run: (v: string) => Promise<void>; getState: () => { phase: string; error: string | null } }>(
      "macSelfUpdate",
      deps,
      `let updateState = { phase: "available", version: "${V}", percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      "return { run: macSelfUpdate, getState: () => updateState };",
    );
    return { deps, run: () => h.run(V), getState: h.getState };
  };
  const dialogOf = (deps: { dialog: { showErrorBox: { mock: { calls: unknown[][] } } } }) =>
    deps.dialog.showErrorBox.mock.calls[0] as [string, string];

  it("成功路径不受影响：暂存 → installing → 套用并 relaunch，不弹框、不开页", async () => {
    const s = setup();
    await s.run();
    expect(s.deps.applyStagedUpdate).toHaveBeenCalledWith({ relaunch: true });
    expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
  });

  it("暂时性验签失败（manifest 503）：弹「暂时无法校验更新包」说明、**不开发布页**（与 Windows 一致），回 available 带错误", async () => {
    const err = new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http");
    const s = setup({
      stage: async () => {
        throw err;
      },
    });
    await s.run();
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = dialogOf(s.deps);
    expect(title).toBe("暂时无法校验更新包");
    expect(body).toContain("HTTP 503");
    expect(body).toContain("请检查网络后在更新徽标上重试");
    expect(body).not.toContain("将打开下载页");
    expect(body).not.toContain("保留"); // mac 的 dmg 不保留，不能说「已保留」
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
    expect(s.getState()).toMatchObject({ phase: "available", error: err.message });
    expect(s.deps.applyStagedUpdate).not.toHaveBeenCalled();
  });

  it("确定不符：弹「自动更新已中止」+ 开发布页；文件级（sha256）说「清除下载的文件」，清单级（signature）不说", async () => {
    const sha = setup({
      stage: async () => {
        throw new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256");
      },
    });
    await sha.run();
    const [t1, b1] = dialogOf(sha.deps);
    expect(t1).toBe("自动更新已中止");
    expect(b1).toContain("已取消自动安装并清除下载的文件");
    expect(sha.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);

    const sig = setup({
      stage: async () => {
        throw new UpdateVerifyMismatchError("更新 manifest 签名校验失败、已中止替换", "signature");
      },
    });
    await sig.run();
    const [t2, b2] = dialogOf(sig.deps);
    expect(t2).toBe("自动更新已中止");
    expect(b2).not.toContain("清除"); // 清单级发生在下载之前、没有文件可清（K3-06）
    expect(sig.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
  });

  it("没带 manifest（404）：弹「该版本暂不支持自动校验」+ 开发布页", async () => {
    const s = setup({
      stage: async () => {
        throw new UpdateVerifyManifestMissingError("该版本没有附带更新校验清单（HTTP 404）、已中止替换", "manifest-missing");
      },
    });
    await s.run();
    expect(dialogOf(s.deps)[0]).toBe("该版本暂不支持自动校验");
    expect(dialogOf(s.deps)[1]).not.toContain("检查网络");
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
  });

  it.each([
    ["dmg 下载 HTTP 502", "下载失败 HTTP 502"],
    ["dmg 下载不完整", "dmg 下载不完整（1/2 字节）、已中止暂存"],
    ["hdiutil attach 失败", "Command failed: hdiutil attach"],
    ["dmg 里没找到 .app", "dmg 里没找到 .app"],
  ])("非验签类失败（%s）：保持通用的「自动更新失败」+ 将打开下载页 + 开发布页（行为不变）", async (_n, message) => {
    const s = setup({
      stage: async () => {
        throw new Error(message);
      },
    });
    await s.run();
    const [title, body] = dialogOf(s.deps);
    expect(title).toBe("自动更新失败");
    expect(body).toContain(message);
    expect(body).toContain("将打开下载页、请手动下载安装");
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    // 第八轮 L2-02：与设置页「检查更新」共用同一个函数的产物（文案只有一份）
    const shared = buildGenericUpdateFailureNotice(new Error(message));
    expect([title, body]).toEqual([shared.title, shared.body]);
  });

  it("L2-02 通用分支取自共用函数 buildGenericUpdateFailureNotice（替身验证：标题 / 正文 / 是否开页都跟着替身走，不是壳里另抄一份）", async () => {
    const spy = vi.fn(() => ({
      definitive: false,
      manifestMissing: false,
      showDialog: true,
      openReleasePage: false, // 替身说「不开页」：壳必须照做
      markPrompted: false,
      stateError: "替身",
      reason: "替身",
      title: "替身标题",
      body: "替身正文",
    }));
    const s = setup({
      stage: async () => {
        throw new Error("Command failed: ditto ENOSPC");
      },
    });
    const h = instantiate<{ run: (v: string) => Promise<void> }>(
      "macSelfUpdate",
      { ...s.deps, buildGenericUpdateFailureNotice: spy },
      `let updateState = { phase: "available", version: "${V}", percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      "return { run: macSelfUpdate };",
    );
    await h.run(V);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: "Command failed: ditto ENOSPC" }));
    expect(s.deps.dialog.showErrorBox).toHaveBeenCalledWith("替身标题", "替身正文");
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
  });

  it("套用阶段失败（暂存成功、applyStagedUpdate 抛错）不是验签问题：通用弹框 + 开发布页；暂存仍有效则回 ready（点徽标重试秒装）", async () => {
    const s = setup({
      apply: async () => {
        throw new Error("暂存包丢失（/tmp/staged.app）");
      },
    });
    s.deps.readStagedMeta.mockResolvedValue({ version: V, appPath: "/tmp/staged.app" } as never);
    s.deps.existsSync.mockReturnValue(true);
    await s.run();
    expect(dialogOf(s.deps)[0]).toBe("自动更新失败");
    expect(s.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    expect(s.getState().phase).toBe("ready");
  });

  it("只读 notice 的标志位、不自己猜类型：notice 说「不弹框 / 不开页」就不弹、不开（作用域里没有 isDefinitiveVerifyFailure / isManifestMissingFailure 也能跑完）", async () => {
    // 替身 builder 对 Mismatch 返回「安静」的处置——若壳里自己按类型决定开页，这里会露馅；
    // 若壳里引用了 isDefinitiveVerifyFailure 等未注入的名字，new Function 作用域里会 ReferenceError
    const quiet = vi.fn(() => ({
      definitive: false,
      manifestMissing: false,
      showDialog: false,
      openReleasePage: false,
      markPrompted: false,
      stateError: "x",
      reason: "x",
      title: "T",
      body: "B",
    }));
    const s = setup({
      stage: async () => {
        throw new UpdateVerifyMismatchError("sha", "sha256");
      },
    });
    const h = instantiate<{ run: (v: string) => Promise<void> }>(
      "macSelfUpdate",
      { ...s.deps, buildVerifyRejectionNotice: quiet },
      `let updateState = { phase: "available", version: "${V}", percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      "return { run: macSelfUpdate };",
    );
    await h.run(V);
    expect(quiet).toHaveBeenCalledWith(expect.any(UpdateVerifyMismatchError), { trigger: "user" });
    expect(s.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(s.deps.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("③h 壳只读 notice 的标志位、不自己猜失败类型（行为测试，取代以前对整份 main.js 的 not.toMatch）", () => {
  // 约束：Windows 的 rejectUnverifiedWinUpdate、mac 的 handleMacStageFailure / macSelfUpdate 处置失败时，
  // 「弹不弹框 / 开不开发布页 / 删不删缓存」只能来自 buildVerifyRejectionNotice 的返回标志位，壳里不能再各写一份类型判断。
  // 以前这条用「整份 main.js 里不得出现 isManifestMissingFailure|isDefinitiveVerifyFailure」守——那是源码形态契约：
  // 注释里一提这两个名字就误红，换个写法（比如 instanceof）又绕得过去。
  // 现在走行为：用**替身 builder**，对「按类型本该弹框 / 开页 / 删缓存」的错误返回相反的标志位；
  // 壳若自己按类型判断，处置就会和标志位不一致；壳若引用了没注入的 isDefinitiveVerifyFailure 等名字，
  // new Function 作用域里会直接 ReferenceError。两个方向各一条。
  const V = "9.9.9";
  const RELEASE = "https://example.invalid/releases/latest";
  const FILE = "C:\\cache\\pending\\fe-ai-flow-9.9.9-win-x64.exe";
  const notice = (over: Record<string, unknown>) => ({
    definitive: false,
    manifestMissing: false,
    showDialog: false,
    openReleasePage: false,
    markPrompted: false,
    stateError: "替身错误文案",
    reason: "替身原因",
    title: "替身标题",
    body: "替身正文",
    ...over,
  });
  const QUIET = notice({});
  const LOUD = notice({ definitive: true, showDialog: true, openReleasePage: true, markPrompted: true });

  const winSetup = (builder: ReturnType<typeof vi.fn>) => {
    const deps = {
      log: vi.fn(),
      fs: { rm: vi.fn(async () => undefined) },
      mainWindow: { setProgressBar: vi.fn() },
      setUpdateState: vi.fn(),
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      RELEASE_LATEST_URL: RELEASE,
      buildVerifyRejectionNotice: builder,
    };
    const run = instantiate<(a: Record<string, unknown>) => Promise<void>>(
      "rejectUnverifiedWinUpdate",
      deps,
      "let winPendingInstaller = null; let winRetainedInstaller = null;",
      "return rejectUnverifiedWinUpdate;",
    );
    return { deps, run };
  };

  it("Windows rejectUnverifiedWinUpdate：对 Mismatch 但 notice 说「安静 / 不删」→ 不删缓存、不弹框、不开页；对 Unavailable 但 notice 说「删 / 弹 / 开页」→ 照做", async () => {
    const quiet = winSetup(vi.fn(() => QUIET));
    await quiet.run({
      version: V,
      file: FILE,
      assetName: "x.exe",
      err: new UpdateVerifyMismatchError("sha", "sha256"),
      stage: "安装前",
    });
    expect(quiet.deps.fs.rm).not.toHaveBeenCalled();
    expect(quiet.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(quiet.deps.shell.openExternal).not.toHaveBeenCalled();

    const loud = winSetup(vi.fn(() => LOUD));
    await loud.run({
      version: V,
      file: FILE,
      assetName: "x.exe",
      err: new UpdateVerifyUnavailableError("503", "manifest-http"),
      stage: "安装前",
    });
    expect(loud.deps.fs.rm).toHaveBeenCalledWith(FILE, { force: true });
    expect(loud.deps.dialog.showErrorBox).toHaveBeenCalledWith("替身标题", "替身正文");
    expect(loud.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
  });

  it("mac 后台 handleMacStageFailure（经 runUpdateCheck 真实路径）：notice 说安静就不弹 / 不开页 / 不记提示；说响就照做", async () => {
    const quiet = vi.fn(() => QUIET);
    const a = macSetup(async () => {
      throw new UpdateVerifyMismatchError("sha", "sha256");
    }, quiet);
    await a.h.runUpdateCheck();
    expect(quiet).toHaveBeenCalledWith(expect.any(UpdateVerifyMismatchError), { trigger: "background", alreadyPrompted: false });
    expect(a.deps.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(a.deps.shell.openExternal).not.toHaveBeenCalled();
    expect(a.deps.markPrompted).not.toHaveBeenCalled();

    const loud = vi.fn(() => LOUD);
    const b = macSetup(async () => {
      throw new UpdateVerifyUnavailableError("503", "manifest-http");
    }, loud);
    await b.h.runUpdateCheck();
    expect(b.deps.dialog.showErrorBox).toHaveBeenCalledWith("替身标题", "替身正文");
    expect(b.deps.shell.openExternal).toHaveBeenCalledWith(RELEASE);
    expect(b.deps.markPrompted).toHaveBeenCalledWith(V);
  });

  // 复用 ③e 的 mac 函数体切法，但换替身 builder；不引入 isDefinitiveVerifyFailure / isManifestMissingFailure / isTransientVerifyFailure
  const macSetup = (inner: () => Promise<unknown>, builder: ReturnType<typeof vi.fn>) => {
    const prompted = new Set<string>();
    const deps = {
      log: vi.fn(),
      app: { getVersion: () => "1.0.0", isPackaged: true },
      IS_TEST: false,
      process: { platform: "darwin" },
      UPDATE_MODE: "download",
      fetchLatestVersion: vi.fn(async () => V),
      ensureWinAutoUpdater: vi.fn(),
      downloadAndStageMacUpdateInner: vi.fn(inner),
      wasPrompted: vi.fn(async (v: string) => prompted.has(v)),
      markPrompted: vi.fn(async (v: string) => {
        prompted.add(v);
      }),
      dialog: { showErrorBox: vi.fn() },
      shell: { openExternal: vi.fn(async () => undefined) },
      RELEASE_LATEST_URL: RELEASE,
      buildVerifyRejectionNotice: builder,
      isPermanentVerifyFailure,
      isVerifyRetryBlocked,
      nextVerifyRetry,
      shouldPromptRepeatedFailure,
      buildRepeatedFailureNotice,
      nextCostlyFailureRecord,
      shouldGiveUpAutoStage,
      isVerifyFailure,
      buildGenericUpdateFailureNotice,
    };
    const h = instantiateMany<{ runUpdateCheck: () => Promise<void> }>(
      ["isNewer", "downloadAndStageMacUpdate", "claimStageErrorDialog", "handleMacStageFailure", "runUpdateCheck"],
      deps,
      `${mainDecls(
        "stagingPromise",
        "installInFlight",
        "updateReadyVersion",
        "macVerifyFailedVersion",
        "macVerifyRetry",
        "repeatedFailurePromptedVersion",
        "macCostlyFailures",
        "macStageGiveUpVersion",
        "dialoguedStageErrors",
      )}
       let updateState = { phase: "idle", version: null, percent: 0, error: null };
       const setUpdateState = (patch) => { updateState = { ...updateState, ...patch }; };`,
      "return { runUpdateCheck };",
    );
    return { h, deps };
  };
});

// ---------- ③i 脚手架自检（第八轮「测试质量」）----------
// 上面所有「真实函数体」用例都靠 new Function 把 main.js 的函数切出来跑；脚手架（prelude / 注入依赖）一旦和 main.js 脱节，
// sloppy 模式不会报错：给没声明的名字赋值会悄悄变成隐式全局。以前的具体漏洞：删掉 main.js 里的
// `let repeatedFailurePromptedVersion`，测试照绿（prelude 手抄着它），线上 catch / 弹框路径里却会 ReferenceError。
// 这里用改过的 main.js 源码（src 参数）直接验证自检本身会红，而不是只信「现在是绿的」。
describe("③i 脚手架作用域自检：prelude / 切出的函数与 main.js 模块级声明脱节时必须红", () => {
  const FN_NAMES = ["claimStageErrorDialog", "handleMacStageFailure"];
  const depsStub = { log: () => undefined, wasPrompted: () => undefined };
  // 与 ③e 同口径的 prelude 子集：模块级状态取自 main.js 原文
  const realPrelude = (src: string = mainSrc) =>
    [
      mainDecl("installInFlight", src),
      mainDecl("macVerifyRetry", src),
      mainDecl("repeatedFailurePromptedVersion", src),
      mainDecl("dialoguedStageErrors", src),
    ].join("\n");
  const without = (src: string, name: string) => src.replace(new RegExp(`^let ${name} = [^\\n]*;\\n`, "m"), "");

  it("真实 main.js + 真实 prelude：不抛（基线，防自检本身误伤）", () => {
    expect(() => checkHarnessScope(FN_NAMES, depsStub, realPrelude())).not.toThrow();
  });

  it("真实 main.js 的 mac 模块级状态都能被 mainDecl 取到（含第八轮新增的闸 / 去重集合）", () => {
    for (const n of [
      "stagingPromise",
      "installInFlight",
      "updateReadyVersion",
      "macVerifyFailedVersion",
      "macVerifyRetry",
      "macCostlyFailures",
      "macStageGiveUpVersion",
      "repeatedFailurePromptedVersion",
      "dialoguedStageErrors",
    ]) {
      expect(mainDecl(n), n).toContain(n);
    }
  });

  it("(a) main.js 删掉 `let repeatedFailurePromptedVersion`、prelude 仍手抄着它 → 抛（原先这里是绿的）", () => {
    const doctored = without(mainSrc, "repeatedFailurePromptedVersion");
    expect(doctored).not.toBe(mainSrc); // 改动确实生效
    const handCopied = `${realPrelude()}\nlet repeatedFailurePromptedVersion = null;`;
    expect(() => checkHarnessScope(FN_NAMES, depsStub, handCopied, doctored)).toThrow(
      /repeatedFailurePromptedVersion[\s\S]*脱节/,
    );
  });

  it("(a') 同样的改动下，prelude 改取 main.js 原文（mainDecl）时：取不到就直接抛、不会悄悄用旧值", () => {
    const doctored = without(mainSrc, "repeatedFailurePromptedVersion");
    expect(() => mainDecl("repeatedFailurePromptedVersion", doctored)).toThrow(/repeatedFailurePromptedVersion/);
  });

  it("(b) main.js 新增了模块级 let、被切出的函数用了、脚手架没提供 → 抛（否则赋值会悄悄变成隐式全局）", () => {
    const doctored =
      mainSrc.replace(
        "const handleMacStageFailure = async (err, version, trigger) => {",
        (m) => `${m}\n  brandNewState = (brandNewState || 0) + 1;`,
      ) + "\nlet brandNewState = null;\n";
    expect(doctored).toContain("brandNewState = (brandNewState");
    expect(() => checkHarnessScope(FN_NAMES, depsStub, realPrelude(doctored), doctored)).toThrow(
      /brandNewState[\s\S]*隐式全局/,
    );
    // 提供了（prelude 声明 / 注入依赖）就不抛
    expect(() =>
      checkHarnessScope(FN_NAMES, depsStub, `${realPrelude(doctored)}\nlet brandNewState = null;`, doctored),
    ).not.toThrow();
    expect(() => checkHarnessScope(FN_NAMES, { ...depsStub, brandNewState: 0 }, realPrelude(doctored), doctored)).not.toThrow();
  });

  it("(b') 只在注释里提到的 main.js 模块级 let 名字不算引用（不误报）", () => {
    const doctored =
      mainSrc.replace(
        "const handleMacStageFailure = async (err, version, trigger) => {",
        (m) => `${m}\n  // 备忘：brandNewState 以后可能用得上\n  /* brandNewState */`,
      ) + "\nlet brandNewState = null;\n";
    expect(() => checkHarnessScope(FN_NAMES, depsStub, realPrelude(doctored), doctored)).not.toThrow();
  });

  it("(c) main.js 把 `const wasPrompted` 改名、deps 里仍注入同名替身、被切出的函数仍引用它 → 抛（没有 (c) 时这里整份测试照绿、线上会 ReferenceError）", () => {
    const doctored = mainSrc.replace(/^const wasPrompted = /m, "const wasPromptedRenamed = ");
    expect(doctored).not.toBe(mainSrc); // 改动确实生效
    expect(sliceMainFn("handleMacStageFailure", doctored)).toContain("wasPrompted(version)"); // 函数体仍在调旧名
    expect(() => checkHarnessScope(FN_NAMES, depsStub, realPrelude(doctored), doctored)).toThrow(
      /wasPrompted[\s\S]*替身掩盖/,
    );
  });

  it("(c) main.js 的 import 里去掉了 `dialog`、deps 里仍注入替身、函数体仍引用 → 抛；import 绑定（含 `x as y` 的本地名、默认导入、命名空间）都算「有声明」", () => {
    const doctored = mainSrc.replace("  dialog,\n  ipcMain,", "  ipcMain,");
    expect(doctored).not.toBe(mainSrc);
    const deps = { ...depsStub, dialog: { showErrorBox: () => undefined } };
    expect(() => checkHarnessScope(FN_NAMES, deps, realPrelude(doctored), doctored)).toThrow(/dialog[\s\S]*替身掩盖/);
    // 没动 import 的真实 main.js：dialog 是 electron 的命名导入，不抛
    expect(() => checkHarnessScope(FN_NAMES, deps, realPrelude())).not.toThrow();
    // importedNames 的解析口径
    expect(
      importedNames(
        [
          'import net from "node:net";',
          'import * as ns from "x";',
          'import { promises as fs, mkdirSync } from "node:fs";',
          'import {\n  a,\n  b as c,\n} from "y";',
          'import d, { e } from "z";',
          "const notImport = 1;",
        ].join("\n"),
      ).sort(),
    ).toEqual(["a", "c", "d", "e", "fs", "mkdirSync", "net", "ns"]);
  });

  it("(c) 宿主全局（process 等）不要求 main.js 里有模块级绑定；其余没声明的注入名才报；声明 / import 之后不报", () => {
    const tiny = (extra: string) => ["const target = () => {", "  return process.platform + helper();", "};", extra, ""].join("\n");
    const deps = { process: { platform: "darwin" }, helper: () => "x" };
    const run = (src: string) => checkHarnessScope(["target"], deps, "", src);
    expect(() => run(tiny(""))).toThrow(/注入依赖 helper，/); // 只点名 helper、不点 process
    expect(() => run(tiny("const helper = () => 1;"))).not.toThrow();
    expect(() => run(`import { helper } from "./h.mjs";\n${tiny("")}`)).not.toThrow();
    expect(() => run(`import { other as helper } from "./h.mjs";\n${tiny("")}`)).not.toThrow();
  });

  it("(c') 注入依赖名只在注释里出现不算引用（不误报）；deps 里多塞没人用的替身也不报", () => {
    const src = ["const target = () => {", "  // 备忘：unusedHelper 以后可能用得上", "  return 1;", "};", ""].join("\n");
    expect(() => checkHarnessScope(["target"], { unusedHelper: () => 1, neverReferenced: 2 }, "", src)).not.toThrow();
  });

  it("sliceMainFn 自校验：函数体里有字符串 / 模板的行首 `};` 被切成半截 → 抛、不悄悄返回半截源码", () => {
    const tricky = ["const tricky = () => {", "  const s = `", "};", "`;", "  return s;", "};", ""].join("\n");
    expect(() => sliceMainFn("tricky", tricky)).toThrow(/不是完整语句/);
    // 正常函数照常切出
    const fine = ["const fine = () => {", "  return 1;", "};", "const after = 2;", ""].join("\n");
    expect(sliceMainFn("fine", fine)).toBe("const fine = () => {\n  return 1;\n};");
  });

  it("sliceMainFn 只认行首声明：注释 / 字符串里同名的片段、或更长名字的子串，都不会被当成起点", () => {
    const src = [
      "// const target = 假的（注释里的）",
      "const targetExtra = () => {",
      "  return 'wrong';",
      "};",
      "const target = () => {",
      "  return 'right';",
      "};",
      "",
    ].join("\n");
    expect(sliceMainFn("target", src)).toContain("'right'");
    expect(() => sliceMainFn("nope", src)).toThrow(/应有行首的 const nope/);
  });
});

describe("main.js 接线契约（补充：函数体之外的约束）", () => {
  const rejFn = sliceMainFn("rejectUnverifiedWinUpdate");
  const verifyFn = sliceMainFn("verifyDownloadedUpdate");
  const loadFn = sliceMainFn("loadSignedManifest");

  it("分流不依赖错误文案：处置函数 / 验签 IO 里没有对 message 做字符串匹配", () => {
    for (const [name, src] of [
      ["rejectUnverifiedWinUpdate", rejFn],
      ["verifyDownloadedUpdate", verifyFn],
      ["loadSignedManifest", loadFn],
    ] as const) {
      // 注释里讲 rationale 允许、只查代码行
      const code = src
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
      expect(code, name).not.toMatch(/\.message\.(?:includes|match|startsWith|endsWith|indexOf|search)\(/);
      expect(code, name).not.toMatch(/\/[^/\n]+\/\.test\((?:reason|err|String\(err)/);
    }
  });

  it("删缓存只发生在「确定不符」分支里（fs.rm 被 notice.definitive 守着）", () => {
    expect(rejFn.match(/fs\.rm\(/g)).toHaveLength(1);
    // 去掉注释行后，闸与 rm 之间只隔着 `{ try {`——不会有别的分支把 rm 挪到闸外
    const code = rejFn
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).toMatch(
      /if \(file && notice\.definitive\) \{\s*try \{\s*await fs\.rm\(file, \{ force: true \}\)/,
    );
  });

  it("main.js 从纯模块引入新导出（分流用的类 / 函数不在壳里自己造）", () => {
    expect(mainSrc).toMatch(/UpdateVerifyUnavailableError,/);
    // 「壳里不再自己写一份类型判断（isManifestMissingFailure / isDefinitiveVerifyFailure），两个平台的处置只读 notice 的标志位」
    // 这条约束以前是对**整份 main.js** 的 not.toMatch（第七轮起撤掉：与「不新增 grep 契约」不符，且注释里提到这两个名字就会误红）；
    // 现在由 ③h 的行为测试守：真实函数体 + 替身 buildVerifyRejectionNotice，作用域里不提供这两个名字、处置完全跟着标志位走。
    // F1-01：失败登记的分类判定来自 update-verify-retry.mjs（壳里不再自己 instanceof Mismatch / Unavailable 拼）
    expect(mainSrc).toMatch(/isPermanentVerifyFailure,/);
    expect(mainSrc).toMatch(/isVerifyRetryBlocked,/);
    expect(mainSrc).toMatch(/nextVerifyRetry,/);
    expect(mainSrc).toContain('from "./update-verify-retry.mjs"');
    expect(mainSrc).toContain("buildVerifyRejectionNotice");
    expect(mainSrc).toContain("fetchUpdateManifest");
    expect(mainSrc).not.toMatch(/class UpdateVerify/);
  });

  it("M3-05：点徽标先尝试复用保留缓存（resume）→ 再走 ready 分支 → 最后才 downloadUpdate；resume 只经共用函数进 ready", () => {
    const fn = sliceMainFn("installUpdateNow");
    const resume = fn.indexOf("await resumeRetainedWinInstaller(updateReadyVersion)");
    const readyBranch = fn.indexOf('updateState.phase === "ready"');
    const download = fn.indexOf("await updater.downloadUpdate()");
    const busy = fn.indexOf('updateState.phase === "downloading" || updateState.phase === "installing"');
    for (const [name, i] of Object.entries({ resume, readyBranch, download, busy })) {
      expect(i, `installUpdateNow 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(busy).toBeLessThan(resume); // 下载 / 安装中的点击先被忽略
    expect(resume).toBeLessThan(readyBranch); // 重验通过 → phase=ready → 直接走既有的「已下载、直接安装」分支
    expect(readyBranch).toBeLessThan(download);
    // 被拒绝（已按分流处置过）就不要再往下走去下载
    expect(fn).toMatch(/if \(resumed === "rejected"\) return;/);

    // 共用同一段「验签通过 → ready」：事件处理与 resume 都调 verifyAndMarkWinReady，自己不再各写一份验签
    expect(mainSrc.match(/const verifyAndMarkWinReady = /g)).toHaveLength(1);
    const evStart = mainSrc.indexOf('winAutoUpdater.on("update-downloaded"');
    const evHandler = mainSrc.slice(evStart, mainSrc.indexOf('winAutoUpdater.on("error"', evStart));
    const resumeFn = sliceMainFn("resumeRetainedWinInstaller");
    for (const [name, src] of [
      ["update-downloaded 事件处理", evHandler],
      ["resumeRetainedWinInstaller", resumeFn],
    ] as const) {
      expect(src, name).toContain("verifyAndMarkWinReady(");
      expect(src, name).not.toContain("verifyWinPendingInstaller(");
    }
    // resume 不能自己登记待装 / 置 ready（绕过验签 = 没有 manifest 也能装）。
    // 把待装清成 null 是 fail-closed 方向（重验前先撤销旧登记），允许；赋任何非 null 值都不行
    const resumeCode = resumeFn
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(resumeCode).not.toMatch(/winPendingInstaller\s*=\s*(?![\s]|null\b)/);
    expect(resumeCode).not.toContain('phase: "ready"');
    // 共用函数里：先验签、后置 ready（fail-closed 的次序）
    const markFn = sliceMainFn("verifyAndMarkWinReady");
    expect(markFn.indexOf("await verifyWinPendingInstaller(pending)")).toBeGreaterThanOrEqual(0);
    expect(markFn.indexOf("await verifyWinPendingInstaller(pending)")).toBeLessThan(
      markFn.indexOf('phase: "ready"'),
    );
  });

  it("M3-04：runUpdateCheck 里「同版本已验签失败」的跳过判定先于 downloadAndStageMacUpdate；失败记录只在验签类错误时写、成功才清", () => {
    const check = sliceMainFn("runUpdateCheck");
    const skip = check.indexOf("macVerifyFailedVersion === latest");
    const stage = check.indexOf("await downloadAndStageMacUpdate(latest)");
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(stage).toBeGreaterThan(skip);

    const manual = sliceMainFn("manualCheckForUpdate");
    expect(manual.indexOf("macVerifyFailedVersion === latest")).toBeGreaterThanOrEqual(0);
    expect(manual.indexOf("macVerifyFailedVersion === latest")).toBeLessThan(
      manual.indexOf("downloadAndStageMacUpdate(latest)"),
    );

    // 用户点徽标的路径（macSelfUpdate）不看 failedVersion：重试由用户点击触发
    expect(sliceMainFn("macSelfUpdate")).not.toContain("macVerifyFailedVersion");

    const wrap = sliceMainFn("downloadAndStageMacUpdate");
    // F1-01：永久跳过只登记确定性失败（Mismatch / 没带 manifest）——
    // 「永久登记」绝不能再挂在 Unavailable 上（一次瞬时 503 就永久跳过 = 废掉 2h 轮询的自愈）。
    // 其余失败（含未归类错误）一律登退避记录（P2-2）：这半句以前也有一条 `else if (isTransient…)` 的正则，
    // 第七轮撤掉了——「未归类错误也登记退避」由 ③e 的 P2-2 用例走真实函数体守，不再靠源码形态
    expect(wrap).toMatch(/if \(isPermanentVerifyFailure\(err\)\) \{\s*macVerifyFailedVersion = version;/);
    expect(wrap).not.toMatch(/instanceof UpdateVerifyUnavailableError/);
    expect(wrap).toContain("macVerifyFailedVersion = null");
    expect(wrap).toContain("macVerifyRetry = null");

    // 退避判定同样先于暂存、且用户点徽标的路径不看它
    expect(check.indexOf("isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())")).toBeGreaterThanOrEqual(0);
    expect(check.indexOf("isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())")).toBeLessThan(stage);
    expect(manual.indexOf("isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())")).toBeGreaterThanOrEqual(0);
    expect(manual.indexOf("isVerifyRetryBlocked(macVerifyRetry, latest, Date.now())")).toBeLessThan(
      manual.indexOf("downloadAndStageMacUpdate(latest)"),
    );
    expect(sliceMainFn("macSelfUpdate")).not.toContain("macVerifyRetry");
  });

  it("F1-01：mac 暂存里清单请求先于 dmg 下载；下载后的最终裁决复用同一份清单上下文", () => {
    const fn = sliceMainFn("downloadAndStageMacUpdateInner");
    const manifest = fn.indexOf("await loadSignedManifest(version, assetName)");
    const download = fn.indexOf("await fetch(dmgUrl)");
    const verify = fn.indexOf("await verifyDownloadedUpdate(version, dmgPath, assetName, manifestCtx)");
    for (const [name, i] of Object.entries({ manifest, download, verify })) {
      expect(i, `downloadAndStageMacUpdateInner 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(manifest).toBeLessThan(download);
    expect(download).toBeLessThan(verify);
    // 预取在 try 之外：这时还没碰磁盘 / 挂载点，抛出不需要走 finally 的清理
    expect(manifest).toBeLessThan(fn.indexOf("try {"));
    // Windows 路径不传 preloaded：electron-updater 下完才进验签，仍在 verifyDownloadedUpdate 内部现取清单
    expect(sliceMainFn("verifyWinPendingInstaller")).not.toContain("loadSignedManifest");
    expect(verifyFn).toContain("preloaded ?? (await loadSignedManifest(version, assetName))");
  });
});
