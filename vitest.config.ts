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
    // 每个测试文件 import 被测模块之前先隔离环境：剔除宿主注入变量、FLOWSHIP_DATA_DIR 指向临时目录。
    // agent shell 会继承正式数据目录，没有这一步，任何测试一 import task-fs 就可能触发惰性的
    // boot-recovery 去改正式数据（2026-10-09 事故，见 tests/helpers/hermetic-env.ts）
    setupFiles: ["./tests/setup/hermetic-env.ts"],
    // 默认满核并发下 Git 真实 IO / 计时测试会随机超时（T6），固定 maxWorkers 保证门禁可重复
    maxWorkers: 4,
  },
});
