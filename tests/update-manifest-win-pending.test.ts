/**
 * F1-02：Windows 安装前验签门禁 verifyWinPendingInstaller 的「真调用」测试（第五轮审查）
 *
 * 背景：它是 quitAndInstall 之前的最后一道安全闸（R9-01），但全仓此前没有任何测试真调用过它——
 * windows-auto-update-contract.test.ts 只对 main.js 的源码字符串做顺序 grep，改个写法就能假绿、门禁被悄悄削弱也没人知道。
 * 现在把函数体机械抽成 electron-app/win-pending-verify.mjs（依赖注入、行为逐行不变），本文件对它真调用。
 *
 * 同一张用例表跑**两个被测主体**：
 * - 模块 verifyWinPendingInstallerWith（抽出来的实现）；
 * - main.js 里的 verifyWinPendingInstaller（从源码切出来、注入 stub 依赖后 new Function 执行——
 *   main.js 一 import electron 就没法直接测；它是薄包装，要证明它把「惰性取 winAutoUpdater 的待装文件 /
 *   sameWinPath / verifyDownloadedUpdate」接对了）。
 *
 * 覆盖：门禁顺序（前置门禁不过 = 不读库内部状态、不验签）、验签失败不放行（错误对象与类型原样透传）、
 * 取不到清单的分类（与真实 verifyDownloadedUpdate 函数体 + 真实 fetchUpdateManifest 端到端串起来）。
 *
 * 回退自检：把 win-pending-verify.mjs 里任一道门禁删掉 / 挪到验签之后，对应用例必须变红（见任务报告）。
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  UpdateVerifyManifestMissingError,
  UpdateVerifyMismatchError,
  UpdateVerifyUnavailableError,
  buildVerifyRejectionNotice,
  fetchUpdateManifest,
  findSignedManifestEntry,
  verifyManifestEntry,
} from "../electron-app/update-manifest-verify.mjs";
import { verifyWinPendingInstallerWith } from "../electron-app/win-pending-verify.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const mainSrc = readFileSync(path.join(ROOT, "electron-app/main.js"), "utf8");

const VERSION = "9.9.9";
const EXE = `fe-ai-flow-${VERSION}-win-x64.exe`;
const FILE = "C:\\Users\\a\\AppData\\Local\\fe-ai-flow-updater\\pending\\fe-ai-flow-9.9.9-win-x64.exe";
const goodPending = () => ({ version: VERSION, file: FILE, assetName: EXE });

// ---------- 从 main.js 切函数体（与 update-manifest-failure-kinds.test.ts 同款切法） ----------

const sliceMainFn = (name: string): string => {
  const start = mainSrc.indexOf(`const ${name} = `);
  expect(start, `main.js 里应有 const ${name} = …`).toBeGreaterThanOrEqual(0);
  const end = mainSrc.indexOf("\n};", start);
  expect(end).toBeGreaterThan(start);
  return mainSrc.slice(start, end + 3);
};

const instantiate = <T,>(name: string, deps: Record<string, unknown>, prelude: string, tail: string): T =>
  new Function(...Object.keys(deps), `${prelude}\n${sliceMainFn(name)}\n${tail}`)(
    ...Object.values(deps),
  ) as T;

/** 把多个函数切进同一个作用域（verifyDownloadedUpdate 依赖同文件里的 loadSignedManifest） */
const instantiateMany = <T,>(names: string[], deps: Record<string, unknown>, prelude: string, tail: string): T =>
  new Function(...Object.keys(deps), `${prelude}\n${names.map(sliceMainFn).join("\n")}\n${tail}`)(
    ...Object.values(deps),
  ) as T;

// ---------- 被测主体：同一张表驱动两个实现 ----------

interface Env {
  /** 库登记的待装文件（downloadedUpdateHelper.file）；任意类型，用来模拟「库内部结构变了」 */
  runFile: unknown;
  /** 模拟更新器还没初始化（winAutoUpdater = null） */
  noUpdater: boolean;
  /** 调用顺序记录：readRunFile / samePath / verify */
  calls: string[];
  verify: ReturnType<typeof vi.fn>;
  sameWinPath: (a: string, b: string) => boolean;
}
type Subject = (env: Env) => (pending: unknown) => Promise<void>;

const SUBJECTS: Array<[string, Subject]> = [
  [
    "模块 verifyWinPendingInstallerWith",
    (env) => (pending) =>
      verifyWinPendingInstallerWith(pending as never, {
        getRunFile: () => {
          env.calls.push("readRunFile");
          return env.noUpdater ? undefined : env.runFile;
        },
        sameWinPath: env.sameWinPath,
        verifyDownloadedUpdate: env.verify as never,
      }),
  ],
  [
    "main.js 里的 verifyWinPendingInstaller（切出真实函数体）",
    (env) => {
      // 属性用 getter：能记下「什么时候读的库内部状态」，验证前置门禁不过时根本不会去读
      const updater = env.noUpdater
        ? null
        : {
            downloadedUpdateHelper: {
              get file() {
                env.calls.push("readRunFile");
                return env.runFile;
              },
            },
          };
      return instantiate<(p: unknown) => Promise<void>>(
        "verifyWinPendingInstaller",
        {
          __updater: updater,
          sameWinPath: env.sameWinPath,
          verifyDownloadedUpdate: env.verify,
          // 抽取后 main.js 的包装会用它；抽取前原函数体不引用，多注入无碍
          verifyWinPendingInstallerWith,
        },
        "let winAutoUpdater = __updater;",
        "return verifyWinPendingInstaller;",
      );
    },
  ],
];

const makeEnv = (over: Partial<Pick<Env, "runFile" | "noUpdater">> = {}): Env => {
  const calls: string[] = [];
  return {
    runFile: FILE,
    noUpdater: false,
    ...over,
    calls,
    verify: vi.fn(async () => {
      calls.push("verify");
    }),
    // 与 main.js 的 sameWinPath 同口径（大小写不敏感），顺便记录是否被调用
    sameWinPath: (a, b) => {
      calls.push("samePath");
      return a.toLowerCase() === b.toLowerCase();
    },
  };
};

const catchAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期 reject 但没有");
};

describe.each(SUBJECTS)("F1-02 verifyWinPendingInstaller 真调用：%s", (_label, makeSubject) => {
  describe("门禁顺序：前置门禁不过就 throw，不读库内部状态、不验签（不取清单、不读盘）", () => {
    it.each<[string, unknown]>([
      ["null", null],
      ["undefined", undefined],
      ["空对象", {}],
      ["缺 file", { version: VERSION, assetName: EXE }],
      ["缺 assetName（latest.yml 里取不到 exe 名）", { version: VERSION, file: FILE }],
      ["file 为空串", { version: VERSION, file: "", assetName: EXE }],
      ["assetName 为空串", { version: VERSION, file: FILE, assetName: "" }],
    ])("待装登记不全（%s）→ 拒绝", async (_n, pending) => {
      const env = makeEnv();
      const err = await catchAsync(() => makeSubject(env)(pending));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("找不到已下载安装包的路径");
      expect((err as Error).message).toContain("已中止安装");
      expect(env.calls).toEqual([]);
      expect(env.verify).not.toHaveBeenCalled();
    });

    it.each<[string, unknown]>([
      ["缺失", undefined],
      ["null", null],
      ["空串", ""],
      ["两段", "1.2"],
      ["四段", "1.2.3.4"],
      ["v 前缀", "v1.2.3"],
      ["预发布后缀", "1.2.3-beta.1"],
      ["路径穿越（会被拼进 manifest 下载 URL）", "1.2.3/../../evil"],
      ["query 注入", "1.2.3?x=1"],
      ["尾部换行（$ 不放行末尾换行）", "1.2.3\n"],
      ["前导空格", " 1.2.3"],
      ["非数字段", "1.2.x"],
      ["数字类型", 123],
    ])("版本号形态异常（%s）→ 拒绝", async (_n, version) => {
      const env = makeEnv();
      const err = await catchAsync(() => makeSubject(env)({ ...goodPending(), version }));
      expect((err as Error).message).toContain("更新版本号格式异常");
      expect((err as Error).message).toContain("已中止安装");
      // 版本不合法就不该去读库内部状态、更不该验签
      expect(env.calls).toEqual([]);
      expect(env.verify).not.toHaveBeenCalled();
    });

    it("版本号异常的报错只带前 32 个字符（不把一串超长内容原样塞进弹框 / 日志）", async () => {
      const env = makeEnv();
      const err = await catchAsync(() =>
        makeSubject(env)({ ...goodPending(), version: "9".repeat(100) }),
      );
      expect((err as Error).message).toContain("9".repeat(32));
      expect((err as Error).message).not.toContain("9".repeat(33));
    });

    it("先判 file / assetName、再判版本：两样都坏时报的是前者", async () => {
      const env = makeEnv();
      const err = await catchAsync(() => makeSubject(env)({ version: "bad", file: "", assetName: EXE }));
      expect((err as Error).message).toContain("找不到已下载安装包的路径");
    });

    it("交叉校验在验签之前：库登记的待装文件与已验签文件对不上 → 拒绝，且不验签", async () => {
      const env = makeEnv({ runFile: "C:\\Users\\a\\AppData\\Local\\fe-ai-flow-updater\\pending\\other.exe" });
      const err = await catchAsync(() => makeSubject(env)(goodPending()));
      expect((err as Error).message).toContain("待安装的文件与已验签的文件不一致");
      expect(env.calls).toEqual(["readRunFile", "samePath"]);
      expect(env.verify).not.toHaveBeenCalled();
    });

    // K3-11：这条以前抛的是普通 Error → 被归成「未归类 = 暂时性」，弹框说「这不代表安装包有问题、已下载的安装包已保留」。
    // 但它恰恰说明待装文件被换了 / 被改了（库要装的那个文件 ≠ 我们验过的那个），是证据确凿的「确定不符」。
    it("K3-11：库登记与已验签文件不一致 → UpdateVerifyMismatchError(pending-file)（确定不符），不是暂时性；处置文案不说「不代表安装包有问题」", async () => {
      const env = makeEnv({ runFile: "C:\\Users\\a\\AppData\\Local\\fe-ai-flow-updater\\pending\\other.exe" });
      const err = await catchAsync(() => makeSubject(env)(goodPending()));
      expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
      expect((err as UpdateVerifyMismatchError).code).toBe("pending-file");
      // 文案不变（用户可见 / 既有断言依赖）
      expect((err as Error).message).toBe("待安装的文件与已验签的文件不一致、已中止安装");
      const notice = buildVerifyRejectionNotice(err);
      expect(notice.definitive).toBe(true); // 允许删缓存、给手动下载入口
      expect(notice.openReleasePage).toBe(true);
      expect(notice.body).not.toContain("不代表安装包有问题");
      expect(notice.body).not.toContain("检查网络");
    });

    it("全部门禁通过：严格按「读库登记 → 比路径 → 验签」的次序，验签是最后一步", async () => {
      const env = makeEnv();
      await expect(makeSubject(env)(goodPending())).resolves.toBeUndefined();
      expect(env.calls).toEqual(["readRunFile", "samePath", "verify"]);
    });

    it("路径比较走注入的 sameWinPath（Windows 大小写不敏感）：大小写不同的同一文件放行", async () => {
      const env = makeEnv({ runFile: FILE.toUpperCase() });
      await expect(makeSubject(env)(goodPending())).resolves.toBeUndefined();
      expect(env.verify).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Partial<Pick<Env, "runFile" | "noUpdater">>]>([
      ["库内部属性不存在（undefined）", { runFile: undefined }],
      ["库登记已清空（null）", { runFile: null }],
      ["库登记是空串", { runFile: "" }],
      ["库内部结构变了（不是字符串）", { runFile: 123 }],
      ["更新器还没初始化", { noUpdater: true }],
    ])("库的待装登记取不到（%s）：跳过交叉校验、不因库内部改名误拦合法更新，仍然验签", async (_n, over) => {
      const env = makeEnv(over);
      await expect(makeSubject(env)(goodPending())).resolves.toBeUndefined();
      // 没有 samePath：取不到就是取不到，不拿 undefined 去比
      expect(env.calls).not.toContain("samePath");
      expect(env.calls[env.calls.length - 1]).toBe("verify");
      expect(env.verify).toHaveBeenCalledTimes(1);
    });
  });

  describe("验签失败不放行：错误对象与类型原样透传（调用方按类型决定删缓存 / 开发布页）", () => {
    it("通过：恰好以 (version, file, assetName) 三个实参调用一次验签", async () => {
      const env = makeEnv();
      await makeSubject(env)(goodPending());
      expect(env.verify).toHaveBeenCalledTimes(1);
      expect(env.verify).toHaveBeenCalledWith(VERSION, FILE, EXE);
    });

    it.each<[string, () => unknown]>([
      ["确定不符 Mismatch", () => new UpdateVerifyMismatchError("安装包 SHA-256 校验失败、已中止替换", "sha256")],
      ["暂时无法校验 Unavailable", () => new UpdateVerifyUnavailableError("更新 manifest 下载失败 HTTP 503、已中止替换", "manifest-http")],
      ["没带 manifest", () => new UpdateVerifyManifestMissingError("没有附带更新校验清单（HTTP 404）、已中止替换")],
      ["未归类 Error", () => new Error("boom")],
      ["非 Error 值", () => "字符串错误"],
    ])("验签 reject（%s）→ 原样 reject 同一个值，不吞、不包装、不放行", async (_n, mk) => {
      const env = makeEnv();
      const thrown = mk();
      env.verify.mockImplementation(async () => {
        throw thrown;
      });
      await expect(makeSubject(env)(goodPending())).rejects.toBe(thrown);
      expect(env.verify).toHaveBeenCalledTimes(1);
    });

    it("验签实现同步抛（不是 async 函数）也变成 reject，不会从调用栈里漏出去", async () => {
      const env = makeEnv();
      const thrown = new UpdateVerifyMismatchError("签名校验失败", "signature");
      env.verify.mockImplementation(() => {
        throw thrown;
      });
      await expect(makeSubject(env)(goodPending())).rejects.toBe(thrown);
    });

    it("不会重试 / 重复验签：失败后调用方拿到的就是第一次的结果", async () => {
      const env = makeEnv();
      env.verify.mockRejectedValueOnce(new UpdateVerifyUnavailableError("503", "manifest-http"));
      const subject = makeSubject(env);
      await expect(subject(goodPending())).rejects.toBeInstanceOf(UpdateVerifyUnavailableError);
      expect(env.verify).toHaveBeenCalledTimes(1);
    });
  });
});

describe("F1-02 main.js 薄包装：惰性读 winAutoUpdater、把三个依赖原样接给模块", () => {
  const build = () => {
    const calls: string[] = [];
    const verify = vi.fn(async () => {
      calls.push("verify");
    });
    const h = instantiate<{
      fn: (p: unknown) => Promise<void>;
      setUpdater: (u: unknown) => void;
    }>(
      "verifyWinPendingInstaller",
      {
        sameWinPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
        verifyDownloadedUpdate: verify,
        verifyWinPendingInstallerWith,
      },
      "let winAutoUpdater = null;",
      "return { fn: verifyWinPendingInstaller, setUpdater: (u) => { winAutoUpdater = u; } };",
    );
    return { h, verify };
  };

  it("winAutoUpdater 是调用时才读的（更新器在应用启动之后才初始化、之后还会被换）：同一个包装，前后两次调用看到不同的库登记", async () => {
    const { h, verify } = build();
    // 此刻更新器未初始化：跳过交叉校验、通过
    await expect(h.fn(goodPending())).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(1);

    // 之后更新器初始化、库登记的待装文件换成别的 → 同一个包装必须能看到并拒绝
    h.setUpdater({ downloadedUpdateHelper: { file: "C:\\somewhere\\else.exe" } });
    await expect(h.fn(goodPending())).rejects.toThrow("待安装的文件与已验签的文件不一致");
    expect(verify).toHaveBeenCalledTimes(1);

    // 库登记对上了 → 放行
    h.setUpdater({ downloadedUpdateHelper: { file: FILE } });
    await expect(h.fn(goodPending())).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("接线：verifyDownloadedUpdate 收到的就是 pending 的三个字段（不是别的来源的版本 / 路径）", async () => {
    const { h, verify } = build();
    await h.fn({ version: "1.2.3", file: "D:\\x\\y.exe", assetName: "y.exe" });
    expect(verify).toHaveBeenCalledWith("1.2.3", "D:\\x\\y.exe", "y.exe");
  });
});

// ---------- 取不到清单的分类：真实门禁 + 真实 verifyDownloadedUpdate 函数体 + 真实 fetchUpdateManifest ----------

describe("F1-02 取不到清单的分类（门禁 → 真实 verifyDownloadedUpdate → buildVerifyRejectionNotice 端到端）", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const other = generateKeyPairSync("ed25519");
  const EXE_BYTES = "MZ-fake-exe-bytes-0123456789-abcdefghij";
  const sha256Of = (s: string): string => createHash("sha256").update(s).digest("hex");
  const FILES = [{ name: EXE, size: Buffer.byteLength(EXE_BYTES), sha256: sha256Of(EXE_BYTES) }];
  const signManifest = (key: KeyObject, files: unknown[]) => ({
    version: VERSION,
    files,
    signature: sign(null, Buffer.from(JSON.stringify({ version: VERSION, files }), "utf8"), key).toString("base64"),
  });
  const goodManifest = () => signManifest(privateKey, FILES.map((f) => ({ ...f })));

  const setup = (manifestResponse: () => Promise<Response>) => {
    const stat = vi.fn(async () => ({ size: Buffer.byteLength(EXE_BYTES) }));
    const sha256File = vi.fn(async () => sha256Of(EXE_BYTES));
    // verifyDownloadedUpdate 自己不取清单：F1-01 起它调同文件里的 loadSignedManifest（读公钥 + 取清单 + 三道廉价检查），
    // 两个函数要切进同一个作用域；Windows 路径不传 preloaded、行为与拆分前一致
    const verifyDownloadedUpdate = instantiateMany<(v: string, f: string, a: string) => Promise<void>>(
      ["loadSignedManifest", "verifyDownloadedUpdate"],
      {
        readFileSync: () => `${pubPem}\n`,
        UPDATE_MANIFEST_PUBLIC_KEY_PATH: "C:\\app\\update-manifest-public-key.pem",
        // 注入 stub fetch：其余（超时 / 分类 / 形态检查）走真实纯模块
        fetchUpdateManifest: (o: { url: string }) => fetchUpdateManifest({ ...o, fetchImpl: manifestResponse }),
        findSignedManifestEntry,
        verifyManifestEntry,
        UpdateVerifyUnavailableError,
        fs: { stat },
        sha256File,
        log: vi.fn(),
      },
      "",
      "return verifyDownloadedUpdate;",
    );
    const verifyPending = (pending: unknown) =>
      verifyWinPendingInstallerWith(pending as never, {
        getRunFile: () => FILE,
        sameWinPath: (a, b) => a.toLowerCase() === b.toLowerCase(),
        verifyDownloadedUpdate,
      });
    return { verifyPending, stat, sha256File };
  };

  const ok = (body: unknown, status = 200) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("清单齐全、签名对、size / sha256 对 → 放行", async () => {
    const s = setup(ok(goodManifest()));
    await expect(s.verifyPending(goodPending())).resolves.toBeUndefined();
    expect(s.stat).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Promise<Response>, string]>([
    ["HTTP 503（服务端抖动）", ok("x", 503), "manifest-http"],
    ["HTTP 429（限流）", ok("x", 429), "manifest-http"],
    ["断网", () => Promise.reject(new TypeError("fetch failed")), "manifest-network"],
    ["正文不是 JSON（强制门户）", ok("<html>login</html>"), "manifest-parse"],
    ["200 + {}（F1-04）", ok("{}"), "manifest-invalid"],
    ["200 + {message}（F1-04，GitHub 错误体）", ok({ message: "Not Found" }), "manifest-invalid"],
    ["200 + 缺 signature 的残缺清单（F1-04）", ok({ version: VERSION, files: FILES }), "manifest-invalid"],
  ])("取不到可用清单（%s）→ Unavailable：保留缓存、不开发布页、不读盘", async (_n, response, code) => {
    const s = setup(response);
    const err = await catchAsync(() => s.verifyPending(goodPending()));
    expect(err).toBeInstanceOf(UpdateVerifyUnavailableError);
    expect(err).not.toBeInstanceOf(UpdateVerifyManifestMissingError);
    expect((err as UpdateVerifyUnavailableError).code).toBe(code);
    expect(s.stat).not.toHaveBeenCalled();
    expect(s.sha256File).not.toHaveBeenCalled();
    const notice = buildVerifyRejectionNotice(err);
    expect(notice.definitive).toBe(false); // 不删 112MB 缓存
    expect(notice.openReleasePage).toBe(false); // 不把人往外赶
  });

  it.each([404, 410])("HTTP %i（release 没带 manifest）→ ManifestMissing：保留缓存，但给手动下载入口", async (status) => {
    const s = setup(ok("Not Found", status));
    const err = await catchAsync(() => s.verifyPending(goodPending()));
    expect(err).toBeInstanceOf(UpdateVerifyManifestMissingError);
    const notice = buildVerifyRejectionNotice(err);
    expect(notice.definitive).toBe(false);
    expect(notice.manifestMissing).toBe(true);
    expect(notice.openReleasePage).toBe(true);
  });

  it("形态完整的清单、签名验不过（别人私钥签的）→ Mismatch：只有这一类才删缓存 + 开发布页", async () => {
    const s = setup(ok(signManifest(other.privateKey, FILES.map((f) => ({ ...f })))));
    const err = await catchAsync(() => s.verifyPending(goodPending()));
    expect(err).toBeInstanceOf(UpdateVerifyMismatchError);
    expect((err as UpdateVerifyMismatchError).code).toBe("signature");
    const notice = buildVerifyRejectionNotice(err);
    expect(notice.definitive).toBe(true);
    expect(notice.openReleasePage).toBe(true);
    expect(s.stat).not.toHaveBeenCalled(); // 签名都不对，没必要算 SHA-256
  });

  it("清单里没有这个 exe 的条目（旧发版链形态）→ Mismatch(entry-missing)，不放行", async () => {
    const noExe = signManifest(privateKey, [{ name: "fe-ai-flow-9.9.9-mac-arm64.dmg", size: 1, sha256: "0".repeat(64) }]);
    const s = setup(ok(noExe));
    const err = await catchAsync(() => s.verifyPending(goodPending()));
    expect((err as UpdateVerifyMismatchError).code).toBe("entry-missing");
  });

  it("门禁前置于清单请求：版本号异常时连 manifest 都不会去取", async () => {
    const fetchSpy = vi.fn(ok(goodManifest()));
    const s = setup(fetchSpy);
    await expect(s.verifyPending({ ...goodPending(), version: "1.2.3/../x" })).rejects.toThrow("版本号格式异常");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
