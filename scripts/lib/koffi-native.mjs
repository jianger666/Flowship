/**
 * 打包时处理 koffi 的原生模块（「电脑操作」靠 koffi 调系统 API，没有它驱动加载不起来）。
 *
 * koffi 把各平台的 .node 拆成可选依赖包 `@koromix/koffi-<os>-<arch>`（里面是 `<os>_<arch>/koffi.node`），
 * pnpm 默认只装「当前机器」那一份。electron-builder 把 `.node` 自动放进 `app.asar.unpacked`，
 * 运行时 koffi 去兄弟目录 `@koromix/koffi-<平台>-<架构>` 里找。所以：
 *  - 本机 / 同架构打包：当前平台那份自然在，什么都不用做；
 *  - 交叉打包（CI 在 arm64 的 mac runner 上打 x64 的 dmg）：目标架构那份不在，装出来的 x64 包里没有原生模块——
 *    用户点「电脑操作」才发现驱动加载失败。electron-app/package.json 的 `pnpm.supportedArchitectures`
 *    让每台机器都装齐 darwin / win32 × arm64 / x64 四份，由这里只留目标平台那份、其余删掉（安装包不背 ~4MB 死重）。
 *
 * 目标平台那份不在时：strict=true（发版 CI：win / mac 都是）直接抛错、不带病发版；否则只告警（本机 test 包不拦）。
 *
 * 纯函数式、只碰传入的 resourcesDir，单测用临时目录夹具覆盖（tests/koffi-native-pack.test.ts）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** koffi 原生模块所在的 npm scope（@koromix/koffi-<os>-<arch>） */
export const KOFFI_NATIVE_SCOPE = "@koromix";
const PKG_PREFIX = "koffi-";

/** 目标平台那份 koffi.node 在 app.asar.unpacked 里的相对位置 */
export const koffiNativeRelPath = (platform, arch) =>
  path.join("node_modules", KOFFI_NATIVE_SCOPE, `${PKG_PREFIX}${platform}-${arch}`, `${platform}_${arch}`, "koffi.node");

const exists = async (p) => {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
};

/**
 * @param {object} p
 * @param {string} p.resourcesDir  安装包的 resources 目录（mac = <app>.app/Contents/Resources、win = <out>/resources）
 * @param {string} p.platform      "darwin" | "win32"（electron-builder 的 electronPlatformName）
 * @param {string} p.arch          "arm64" | "x64"（Arch[context.arch]）
 * @param {boolean} [p.strict]     目标那份缺失时抛错（默认只告警）
 * @param {{ log?: (m: string) => void, warn?: (m: string) => void }} [p.logger]
 * @returns {Promise<{ ok: boolean, nodeFile: string, pruned: string[] }>}
 */
export const prepareKoffiNative = async ({ resourcesDir, platform, arch, strict = false, logger = {} }) => {
  const log = logger.log ?? ((m) => console.log(m));
  const warn = logger.warn ?? ((m) => console.warn(m));
  const unpacked = path.join(resourcesDir, "app.asar.unpacked");
  const nodeFile = path.join(unpacked, koffiNativeRelPath(platform, arch));

  if (!(await exists(nodeFile))) {
    const msg =
      `koffi 原生模块缺失：${nodeFile}。「电脑操作」在 ${platform}-${arch} 上会加载失败。` +
      `检查 electron-app 的 pnpm install 是否装进了 ${KOFFI_NATIVE_SCOPE}/${PKG_PREFIX}${platform}-${arch}（package.json 的 pnpm.supportedArchitectures）`;
    if (strict) throw new Error(`afterPack：${msg}`);
    warn(`  • afterPack 告警：${msg}`);
    return { ok: false, nodeFile, pruned: [] };
  }

  // 只留目标平台那份；其余平台的包（交叉打包 / 装齐四份时才会有）整个删掉
  const scopeDir = path.join(unpacked, "node_modules", KOFFI_NATIVE_SCOPE);
  const keep = `${PKG_PREFIX}${platform}-${arch}`;
  const pruned = [];
  for (const name of await fs.readdir(scopeDir)) {
    if (!name.startsWith(PKG_PREFIX) || name === keep) continue;
    await fs.rm(path.join(scopeDir, name), { recursive: true, force: true });
    pruned.push(name);
  }
  log(`  • afterPack：koffi 原生模块就绪 ${platform}-${arch}${pruned.length ? `（已移除其它平台：${pruned.sort().join("、")}）` : ""}`);
  return { ok: true, nodeFile, pruned: pruned.sort() };
};
