/**
 * 打包时的 koffi 原生模块（scripts/lib/koffi-native.mjs + scripts/electron-after-pack.mjs 的接线）。
 *
 * 背景：「电脑操作」靠 koffi 调系统 API，koffi 的 .node 按平台拆成可选包 `@koromix/koffi-<os>-<arch>`，
 * pnpm 默认只装当前机器那份。CI 在 arm64 的 mac runner 上交叉打 x64 的 dmg 时，目标架构那份不在 →
 * 装出来的 Intel Mac 安装包里没有原生模块，用户点「电脑操作」才发现驱动加载失败。
 * 修法 = electron-app 用 pnpm.supportedArchitectures 装齐四份，打包时只留目标平台那份（其余删掉、缺了就报错）。
 *
 * 这里覆盖：留哪份 / 删哪份 / 缺了怎么办（strict 抛错、非 strict 只告警且不乱删）/ 路径与真 koffi 的包布局对账 /
 * afterPack 的接线（win 路径端到端、mac 路径用假 codesign 验「先整理 koffi、再整包签名」的顺序与 strict 条件）。
 *
 * 不在这里验证：真的 electron-builder 打包（本机 `electron-builder --dir` 手验过：asar.unpacked 里有 koffi.node、
 * 打包后的 app 里 koffi 能 load 并真调 getpid）；CI 上 pnpm 实际装齐四份（靠 package.json 配置 + 本机 frozen-lockfile 手验）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASSET_FILES } from "../electron-app/desktop/win-helper/protocol.mjs";
import { KOFFI_NATIVE_SCOPE, koffiNativeRelPath, prepareKoffiNative } from "../scripts/lib/koffi-native.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_ASSET_NAMES: string[] = Object.values(ASSET_FILES);

const tmpDirs: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "koffi-pack-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  // 环境变量的 stub 也在这里统一还原：用例里断言先失败时，不能把「发版 CI 标记」之类漏给后面的用例
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const writeFile = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** 造 app.asar.unpacked 下若干平台的 koffi 原生包（和 electron-builder 自动 unpack 出来的形状一致） */
const installNativePkgs = (resourcesDir: string, platforms: string[], extra: { withoutNode?: string[] } = {}): void => {
  for (const plat of platforms) {
    const base = path.join(resourcesDir, "app.asar.unpacked", "node_modules", KOFFI_NATIVE_SCOPE, `koffi-${plat}`);
    writeFile(path.join(base, "package.json"), JSON.stringify({ name: `@koromix/koffi-${plat}`, version: "3.3.8" }));
    writeFile(path.join(base, "index.js"), "module.exports = {};");
    if (!extra.withoutNode?.includes(plat)) writeFile(path.join(base, plat.replace("-", "_"), "koffi.node"), `native:${plat}`);
  }
};

const present = (resourcesDir: string): string[] => {
  const scope = path.join(resourcesDir, "app.asar.unpacked", "node_modules", KOFFI_NATIVE_SCOPE);
  return fs.existsSync(scope) ? fs.readdirSync(scope).sort() : [];
};

const noopLogger = () => ({ log: vi.fn(), warn: vi.fn() });

describe("prepareKoffiNative：只留目标平台那份", () => {
  const ALL = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];

  it("装齐四份、目标是 mac arm64 → 留 darwin-arm64（含 koffi.node），其余三份整个删掉", async () => {
    const res = mkTmp();
    installNativePkgs(res, ALL);
    const logger = noopLogger();
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", strict: true, logger });
    expect(r.ok).toBe(true);
    expect(r.pruned).toEqual(["koffi-darwin-x64", "koffi-win32-arm64", "koffi-win32-x64"]);
    expect(present(res)).toEqual(["koffi-darwin-arm64"]);
    expect(fs.readFileSync(r.nodeFile, "utf8")).toBe("native:darwin-arm64");
    expect(fs.existsSync(path.join(res, "app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/package.json"))).toBe(true);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0]![0])).toContain("darwin-arm64");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("交叉打包：目标是 mac x64 → 留 darwin-x64、删掉 runner 自己的 darwin-arm64（这正是 Intel 包缺原生模块的那个场景）", async () => {
    const res = mkTmp();
    installNativePkgs(res, ALL);
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "x64", strict: true, logger: noopLogger() });
    expect(r.ok).toBe(true);
    expect(present(res)).toEqual(["koffi-darwin-x64"]);
    expect(fs.readFileSync(r.nodeFile, "utf8")).toBe("native:darwin-x64");
  });

  it("Windows x64 → 留 win32-x64", async () => {
    const res = mkTmp();
    installNativePkgs(res, ALL);
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "win32", arch: "x64", logger: noopLogger() });
    expect(r.ok).toBe(true);
    expect(present(res)).toEqual(["koffi-win32-x64"]);
  });

  it("只装了目标那一份（同架构本机打包）→ 什么都不删、日志不提「已移除」", async () => {
    const res = mkTmp();
    installNativePkgs(res, ["darwin-arm64"]);
    const logger = noopLogger();
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", strict: true, logger });
    expect(r.ok).toBe(true);
    expect(r.pruned).toEqual([]);
    expect(present(res)).toEqual(["koffi-darwin-arm64"]);
    expect(String(logger.log.mock.calls[0]![0])).not.toContain("已移除");
  });

  it("scope 目录里不是 koffi- 开头的包不碰（只清其它平台的 koffi 原生包）", async () => {
    const res = mkTmp();
    installNativePkgs(res, ["darwin-arm64", "win32-x64"]);
    writeFile(path.join(res, "app.asar.unpacked/node_modules/@koromix/other-thing/index.js"), "x");
    await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", logger: noopLogger() });
    expect(present(res)).toEqual(["koffi-darwin-arm64", "other-thing"]);
  });

  it("幂等：连着跑两次结果一致、第二次没有东西可删", async () => {
    const res = mkTmp();
    installNativePkgs(res, ALL);
    await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", logger: noopLogger() });
    const again = await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", logger: noopLogger() });
    expect(again.ok).toBe(true);
    expect(again.pruned).toEqual([]);
    expect(present(res)).toEqual(["koffi-darwin-arm64"]);
  });
});

describe("prepareKoffiNative：目标那份缺失", () => {
  it("strict：抛错，信息里有平台-架构、期望路径和怎么修；一个文件都不删", async () => {
    const res = mkTmp();
    installNativePkgs(res, ["darwin-arm64", "win32-x64"]); // 目标是 x64，但 x64 没装
    await expect(prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "x64", strict: true, logger: noopLogger() })).rejects.toThrow(
      /koffi 原生模块缺失.*darwin-x64.*koffi\.node.*supportedArchitectures/s,
    );
    expect(present(res)).toEqual(["koffi-darwin-arm64", "koffi-win32-x64"]);
  });

  it("非 strict：只告警（不抛），返回 ok=false，且不删别的平台的包（目标都没有时删了更难排查）", async () => {
    const res = mkTmp();
    installNativePkgs(res, ["darwin-arm64"]);
    const logger = noopLogger();
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "win32", arch: "x64", logger });
    expect(r.ok).toBe(false);
    expect(r.pruned).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![0])).toContain("win32-x64");
    expect(logger.log).not.toHaveBeenCalled();
    expect(present(res)).toEqual(["koffi-darwin-arm64"]);
  });

  it("包目录在但没有 koffi.node（只剩 package.json / index.js）也算缺失", async () => {
    const res = mkTmp();
    installNativePkgs(res, ["darwin-arm64"], { withoutNode: ["darwin-arm64"] });
    await expect(prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", strict: true, logger: noopLogger() })).rejects.toThrow(/缺失/);
  });

  it("koffi.node 是个目录而不是文件，也算缺失", async () => {
    const res = mkTmp();
    fs.mkdirSync(path.join(res, "app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node"), { recursive: true });
    await expect(prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", strict: true, logger: noopLogger() })).rejects.toThrow(/缺失/);
  });

  it("整个 app.asar.unpacked 都没有（asar 里的 .node 没被 unpack）：strict 抛错 / 非 strict 告警，都不因 readdir 崩", async () => {
    const res = mkTmp();
    await expect(prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", strict: true, logger: noopLogger() })).rejects.toThrow(/缺失/);
    const logger = noopLogger();
    const r = await prepareKoffiNative({ resourcesDir: res, platform: "darwin", arch: "arm64", logger });
    expect(r.ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("路径布局与真 koffi 的包对账", () => {
  it("koffiNativeRelPath 的形状 = koffi 官方原生包的真实目录（本机装的这份 koffi.node 就在这个相对位置）", () => {
    const plat = `${process.platform}-${process.arch}`;
    if (!["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].includes(plat)) return;
    // 两个包的 package.json 都没在 exports 里导出，所以解析入口文件（都在包根目录）再取目录
    const req = createRequire(import.meta.url);
    const koffiRoot = path.dirname(req.resolve("koffi"));
    const nativeEntry = createRequire(path.join(koffiRoot, "noop.js")).resolve(`@koromix/koffi-${plat}`);
    const real = path.join(path.dirname(nativeEntry), `${process.platform}_${process.arch}`, "koffi.node");
    expect(fs.existsSync(real), `真 koffi 包里没有 ${real}`).toBe(true);
    // 相对位置：node_modules/@koromix/koffi-<平台>-<架构>/<平台>_<架构>/koffi.node
    expect(koffiNativeRelPath(process.platform, process.arch).split(path.sep)).toEqual([
      "node_modules",
      "@koromix",
      `koffi-${plat}`,
      `${process.platform}_${process.arch}`,
      "koffi.node",
    ]);
    expect(real.endsWith(path.join(`koffi-${plat}`, `${process.platform}_${process.arch}`, "koffi.node"))).toBe(true);
  });

  /**
   * electron-app 里装下来的 koffi（pnpm.supportedArchitectures 让它带齐四份平台包）。上面那条只能核对「本机平台」那份；
   * Windows 的路径公式（afterPack 对 win32 缺失也是严格失败，全靠这个公式认文件）要对着真的 win32 包核对——这里就是。
   * electron-app 没装依赖（别的开发机 / 精简 CI）就跳过。
   */
  const electronAppKoffiRoot = ((): string | null => {
    // 只认 electron-app 自己名下装的 koffi。不能用 require.resolve("koffi")：解析不到时它会向上回落到仓库根里装的那份——
    // 门禁（ci.yml）只在根目录 install，根里只有 runner 本机平台（linux-x64）的原生包，会被误判成「electron-app 装了依赖」，
    // 四个目标平台一份都解析不到、下面的断言就红（v1.9.57 首发的 verify 就是这么红的）。
    try {
      return fs.realpathSync(path.join(REPO_ROOT, "electron-app", "node_modules", "koffi"));
    } catch {
      return null;
    }
  })();

  it.skipIf(electronAppKoffiRoot === null)(
    "四个目标平台（mac / win × arm64 / x64）：electron-app 里装下来的真原生包，布局都和 koffiNativeRelPath 的公式一致（含 win32）",
    () => {
      const nativeReq = createRequire(path.join(electronAppKoffiRoot!, "noop.js"));
      const checked: string[] = [];
      for (const plat of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
        let entry: string;
        try {
          entry = nativeReq.resolve(`@koromix/koffi-${plat}`);
        } catch {
          continue; // 这台机器没装这一份
        }
        const [osName, arch] = plat.split("-") as [string, string];
        const real = path.join(path.dirname(entry), `${osName}_${arch}`, "koffi.node");
        expect(fs.existsSync(real), `真包里没有 ${real}`).toBe(true);
        expect(real.endsWith(koffiNativeRelPath(osName, arch)), `${plat}：真包路径 ${real} 对不上公式`).toBe(true);
        checked.push(plat);
      }
      expect(checked.length, "electron-app 里一份 koffi 原生包都没有：先在 electron-app 目录 pnpm install").toBeGreaterThan(0);
    },
  );

  it("electron-app/package.json 用 pnpm.supportedArchitectures 装齐 mac / win × arm64 / x64（交叉打包 x64 的前提）", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "electron-app", "package.json"), "utf8"));
    const sa = pkg.pnpm?.supportedArchitectures;
    expect(sa?.os, "缺 pnpm.supportedArchitectures.os").toEqual(expect.arrayContaining(["darwin", "win32"]));
    expect(sa?.cpu, "缺 pnpm.supportedArchitectures.cpu").toEqual(expect.arrayContaining(["arm64", "x64"]));
    expect(pkg.dependencies?.koffi, "koffi 必须钉死版本（原生包与它同版本）").toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("afterPack 接线", () => {
  const makeServerLayout = (cwd: string): void => {
    writeFile(path.join(cwd, "dist", "app-server", "server.js"), "// server");
  };

  const HELPER_ASSETS_REL = path.join("electron-app", "desktop", "win-helper", "assets");

  /**
   * win32 的 afterPack 还会把 Windows 解锁组件的三个资源文件（源码 + 安装 / 卸载脚本）拷进 resources/win-helper/，
   * 并按 protocol.mjs 里登记的哈希校验。这里的「假仓库」要带上真实的资源文件（哈希才对得上登记值）。
   */
  const makeHelperAssets = (cwd: string): void => {
    const dest = path.join(cwd, HELPER_ASSETS_REL);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of HELPER_ASSET_NAMES) fs.copyFileSync(path.join(REPO_ROOT, HELPER_ASSETS_REL, name), path.join(dest, name));
  };

  const makeContext = (outDir: string, platform: "darwin" | "win32", arch: number, appFolder = "Flowship.app") => {
    const resourcesDir = platform === "darwin" ? path.join(outDir, appFolder, "Contents", "Resources") : path.join(outDir, "resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    if (platform === "darwin") fs.mkdirSync(path.join(outDir, appFolder), { recursive: true });
    return {
      resourcesDir,
      context: {
        appOutDir: outDir,
        electronPlatformName: platform,
        arch,
        packager: { getResourcesDir: () => resourcesDir },
      },
    };
  };

  const ALL = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
  const ARCH = { x64: 1, arm64: 3 } as const;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("win32：拷入 server 布局 + 只留 win32-x64（不跑 codesign）+ 解锁组件资源拷进 resources/win-helper", async () => {
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    makeHelperAssets(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    const { resourcesDir, context } = makeContext(out, "win32", ARCH.x64);
    installNativePkgs(resourcesDir, ALL);
    await afterPack(context);
    expect(fs.existsSync(path.join(resourcesDir, "app-server", "server.js"))).toBe(true);
    expect(present(resourcesDir)).toEqual(["koffi-win32-x64"]);
    // PowerShell 读不了 asar：资源必须以普通文件落在 resources/win-helper，且和仓库里的逐字节一致
    const helperDir = path.join(resourcesDir, "win-helper");
    expect(fs.readdirSync(helperDir).sort()).toEqual([...HELPER_ASSET_NAMES].sort());
    for (const name of HELPER_ASSET_NAMES) {
      expect(fs.readFileSync(path.join(helperDir, name)).equals(fs.readFileSync(path.join(REPO_ROOT, HELPER_ASSETS_REL, name))), name).toBe(true);
    }
  });

  it("win32 + 发版 CI 标记：目标原生包缺失 → afterPack 抛错并点名 win32-x64（和 mac 一样严：装出连驱动都加载不起来的 Windows 包，比发版当场红更糟）；一个包都不删、没走到拷解锁组件那步", async () => {
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "1");
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    makeHelperAssets(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    const { resourcesDir, context } = makeContext(out, "win32", ARCH.x64);
    installNativePkgs(resourcesDir, ["darwin-arm64"]); // 只有别的平台那份
    await expect(afterPack(context)).rejects.toThrow(/koffi 原生模块缺失.*win32-x64.*koffi\.node/s);
    expect(present(resourcesDir)).toEqual(["koffi-darwin-arm64"]);
    expect(fs.existsSync(path.join(resourcesDir, "win-helper"))).toBe(false);
  });

  it("win32 本机包（没有发版 CI 标记）：目标原生包缺失只告警、其余步骤照常跑完（本地打 Windows 包不被拦）", async () => {
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    makeHelperAssets(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    const { resourcesDir, context } = makeContext(out, "win32", ARCH.x64);
    installNativePkgs(resourcesDir, ["darwin-arm64"]);
    await expect(afterPack(context)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("win32-x64"));
    expect(present(resourcesDir)).toEqual(["koffi-darwin-arm64"]); // 目标都没有时不乱删
    expect(fs.readdirSync(path.join(resourcesDir, "win-helper")).sort()).toEqual([...HELPER_ASSET_NAMES].sort());
  });

  it("win32：仓库里缺解锁组件资源 → afterPack 抛错并报出缺哪个（和 koffi 缺失「只告警」不同：这是我们自己的文件，缺了就是提交遗漏）", async () => {
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    makeHelperAssets(cwd);
    fs.rmSync(path.join(cwd, HELPER_ASSETS_REL, ASSET_FILES.install));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    const { resourcesDir, context } = makeContext(out, "win32", ARCH.x64);
    installNativePkgs(resourcesDir, ALL);
    await expect(afterPack(context)).rejects.toThrow(ASSET_FILES.install);
  });

  /** 假 child_process：记录每次 codesign 调用，并在「第一次 codesign」时快照 koffi 原生包的状态 */
  const mockCodesign = (resourcesDir: string) => {
    const calls: string[][] = [];
    let atFirstSign: string[] | null = null;
    vi.doMock("node:child_process", async (orig) => {
      const real = await orig<typeof import("node:child_process")>();
      const execFile = ((cmd: string, args: string[], _opts: unknown, cb?: (e: Error | null, out?: { stdout: string; stderr: string }) => void) => {
        const done = typeof _opts === "function" ? (_opts as typeof cb)! : cb!;
        calls.push([cmd, ...args]);
        if (atFirstSign === null && args.includes("--sign")) atFirstSign = present(resourcesDir);
        done(null, { stdout: "", stderr: "" });
      }) as unknown as typeof real.execFile;
      return { ...real, default: { ...real, execFile }, execFile };
    });
    return { calls, atFirstSign: () => atFirstSign };
  };

  it("darwin x64（交叉打包）：先整理 koffi（只剩 darwin-x64），再整包签名——签名封印的是整理后的内容", async () => {
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", "");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { resourcesDir, context } = makeContext(out, "darwin", ARCH.x64);
    installNativePkgs(resourcesDir, ALL);
    const spy = mockCodesign(resourcesDir);
    vi.resetModules();
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    await afterPack(context);
    expect(spy.atFirstSign()).toEqual(["koffi-darwin-x64"]);
    expect(present(resourcesDir)).toEqual(["koffi-darwin-x64"]);
    // Windows 解锁组件的资源只属于 Windows 包：mac 包里不该有（也不要求仓库里有，这个假仓库就没造）
    expect(fs.existsSync(path.join(resourcesDir, "win-helper"))).toBe(false);
    // 签名 + 校验都确实调用过（接线没把原有的签名流程弄丢）
    expect(spy.calls.some((c) => c[0] === "codesign" && c.includes("--sign") && c.includes("-"))).toBe(true);
    expect(spy.calls.some((c) => c[0] === "codesign" && c.includes("--verify"))).toBe(true);
  });

  it("darwin + 发版 CI 标记：目标原生包缺失 → afterPack 抛错（交叉打包少装一份就当场红，不发出坏的 Intel 包），且没走到签名", async () => {
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", "566f6cac5a06f6cca21f6cb23039e370a007137d");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "1");
    const { resourcesDir, context } = makeContext(out, "darwin", ARCH.x64);
    installNativePkgs(resourcesDir, ["darwin-arm64"]); // 只有 runner 自己的架构
    const spy = mockCodesign(resourcesDir);
    vi.resetModules();
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    await expect(afterPack(context)).rejects.toThrow(/koffi 原生模块缺失.*darwin-x64/s);
    expect(spy.calls).toEqual([]);
  });

  it("darwin 本机 test 包（没有发版 CI 标记）：目标原生包缺失只告警、照常签名（本地 electron:dist:test 不被拦）", async () => {
    const cwd = mkTmp();
    const out = mkTmp();
    makeServerLayout(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.stubEnv("FLOWSHIP_SIGN_IDENTITY", "");
    vi.stubEnv("FLOWSHIP_REQUIRE_STABLE_SIGN", "");
    const { resourcesDir, context } = makeContext(out, "darwin", ARCH.arm64);
    installNativePkgs(resourcesDir, ["win32-x64"]);
    const spy = mockCodesign(resourcesDir);
    vi.resetModules();
    const { default: afterPack } = await import("../scripts/electron-after-pack.mjs");
    await expect(afterPack(context)).resolves.toBeUndefined();
    expect(spy.calls.some((c) => c[0] === "codesign" && c.includes("--sign"))).toBe(true);
  });
});
