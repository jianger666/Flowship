#!/usr/bin/env node
/**
 * 创建 / 查看「本机 test 包固定签名证书」（只在 macOS 上有意义）。
 *
 *   node scripts/electron-test-signing.mjs          等同 setup：已有就沿用，没有就创建（幂等）
 *   node scripts/electron-test-signing.mjs status   只看现在有没有，不改任何东西
 *
 * 原理、目录内容与取舍见 scripts/lib/electron-test-signing.mjs。
 * 证书一旦创建就别重建：换了证书，FlowshipTest 的系统授权（辅助功能 / 屏幕录制）和钥匙串里保存的开机密码都要重来一遍。
 */
import { ensureTestSigning, readTestSigning, resolveTestSigningDir } from "./lib/electron-test-signing.mjs";

const mode = process.argv[2] ?? "setup";

const main = async () => {
  if (process.platform !== "darwin") {
    console.error("[test-signing] 只有 macOS 需要这张证书（Windows 的 test 包没有这个问题）。");
    return 1;
  }
  if (mode !== "setup" && mode !== "status") {
    console.error(`[test-signing] 不认识的子命令：${mode}（可用：setup | status）`);
    return 1;
  }
  const dir = resolveTestSigningDir();
  if (mode === "status") {
    const signing = await readTestSigning({ dir });
    if (!signing) {
      console.log(`[test-signing] 还没有本机测试证书（目录 ${dir}）。运行 node scripts/electron-test-signing.mjs 创建。`);
      return 2;
    }
    console.log(`[test-signing] 已就绪：指纹 ${signing.identity}（目录 ${dir}）`);
    return 0;
  }
  const { created, signing } = await ensureTestSigning({ dir });
  console.log(
    created
      ? `[test-signing] 已创建本机测试证书：指纹 ${signing.identity}（目录 ${dir}）。之后打 test 包会自动用它签名。`
      : `[test-signing] 已有本机测试证书，沿用：指纹 ${signing.identity}（目录 ${dir}）。`,
  );
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[test-signing] 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
