/**
 * electron-builder afterPack hook（V0.7.0）
 *
 * 1. 把组好的 server 布局（dist/app-server）拷进安装包 resources/app-server。
 *    为什么不用 extraResources：builder 的 copier 硬排除 node_modules（显式 filter
 *    "**\/node_modules\/**" 也救不回、实测丢）、而 server 的依赖树全在 node_modules 里——
 *    afterPack 阶段自己 fs.cp 全量拷、绕开它的 file matcher。
 *    verbatimSymlinks：本地（pnpm isolated）布局里有相对 symlink、原样保留才能解析；
 *    CI 布局（hoisted）全实体、verbatim 无副作用。
 *
 * 2. mac：补一道完整 ad-hoc 签名（v0.7.10）。
 *    identity:null 是「跳过签名」、产物只剩 linker 级签名（Sealed Resources=none）、
 *    新 macOS + 浏览器下载（quarantine）评估直接「已损坏」死路（用户实测 0.7.9）。
 *    afterPack 时 app-server 已拷入、内容定型、此时 `codesign --force --deep -s -`
 *    整包封印 → Gatekeeper 给「无法验证开发者」、右键打开一次即可。
 *    彻底零确认 / mac 自动更新仍需 Apple 开发者证书、用户暂不买。
 *
 *    固定自签身份（可选）：设 FLOWSHIP_SIGN_IDENTITY（证书 SHA-1 指纹）后改用该证书整包签名。
 *    原因：ad-hoc 的身份绑代码哈希、每个版本都变，系统「辅助功能」等授权每次升级都失效；
 *    自签证书的指定要求是「identifier + 证书」、升级后不变、授权保留。
 *    环境变量：FLOWSHIP_SIGN_IDENTITY（指纹）/ FLOWSHIP_SIGN_KEYCHAIN（钥匙串路径、可选）/
 *    FLOWSHIP_REQUIRE_STABLE_SIGN=1（发版 CI 用：没配身份就直接失败、不退回 ad-hoc）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export default async (context) => {
  const src = path.join(process.cwd(), "dist", "app-server");
  // getResourcesDir：mac → <app>.app/Contents/Resources、win → <out>/resources
  const dest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "app-server",
  );
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`  • afterPack：server 布局已拷入 ${dest}`);

  if (context.electronPlatformName === "darwin") {
    // appOutDir 下找 .app（产物只有一个）
    const appName = (await fs.readdir(context.appOutDir)).find((n) =>
      n.endsWith(".app"),
    );
    if (!appName) throw new Error("afterPack：没找到 .app、无法 ad-hoc 签名");
    const appPath = path.join(context.appOutDir, appName);
    // 签名身份：配了 FLOWSHIP_SIGN_IDENTITY（自签证书的 SHA-1 指纹、公开信息）就用固定身份，
    // 没配退回 ad-hoc（本地 test 包 / 没证书的环境、行为与以前一致）。
    const identity = (process.env.FLOWSHIP_SIGN_IDENTITY || "").trim();
    // CI 临时钥匙串路径（可选）；不传就在默认钥匙串搜索列表里找
    const keychain = (process.env.FLOWSHIP_SIGN_KEYCHAIN || "").trim();
    if (!identity && process.env.FLOWSHIP_REQUIRE_STABLE_SIGN === "1") {
      // 发版 CI 置位：宁可红、也不悄悄发出 ad-hoc 版（那会让所有用户的系统授权白白再失效一次）
      throw new Error(
        "afterPack：发版要求固定签名身份、但没配 FLOWSHIP_SIGN_IDENTITY",
      );
    }
    // --deep 已被 Apple 标记弃用、但整包签名场景仍是社区标准做法且有效；
    // 不加 --options runtime（hardened runtime）：没有 Apple 公证、开了没收益；实验也是按不开验证的。
    // 自签身份不需要设为「受信任」就能签——所以不走 electron-builder 的 identity（它只认 find-identity -v 的有效身份）。
    // maxBuffer 调大：deep 签名输出可能较多
    await execFileP(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        identity || "-",
        ...(identity && keychain ? ["--keychain", keychain] : []),
        appPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    // 签完立即验、失败让 CI 红、不带病发版
    await execFileP("codesign", ["--verify", "--deep", "--strict", appPath]);
    if (identity) {
      // 再核对「指定要求」里确实是这张证书：系统辅助功能 / 麦克风等授权认的就是它，
      // 身份不对就在上传前红掉（输出可能在 stdout 或 stderr、合并判断）
      const { stdout, stderr } = await execFileP("codesign", [
        "-d",
        "-r-",
        appPath,
      ]);
      const want = `certificate root = H"${identity.toLowerCase()}"`;
      if (!`${stdout}\n${stderr}`.includes(want)) {
        throw new Error(
          `afterPack：签名身份不是预期证书（期望包含 ${want}）`,
        );
      }
    }
    console.log(
      `  • afterPack：mac ${identity ? "固定身份" : "ad-hoc"} 签名完成 ${appName}`,
    );
  }
};
