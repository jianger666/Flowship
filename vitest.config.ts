/**
 * vitest 配置（V0.6.27 测试基建 0 → 1）
 *
 * 定位：只测「安全关键纯函数」+「prompt / 协议一致性」、不追覆盖率、不测 UI / route。
 * 测试文件统一放 tests/、不跟 src 混放（src 是 Next.js 编译范围）。
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 默认满核并发下 Git 真实 IO / 计时测试会随机超时（T6），固定 maxWorkers 保证门禁可重复
    maxWorkers: 4,
  },
});
