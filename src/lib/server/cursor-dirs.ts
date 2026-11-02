/**
 * 全局 Cursor 配置目录候选（按优先级）
 *
 * 单独成模块的原因：`event-secret-redact` 要读 `~/.cursor/mcp.json` 做凭据脱敏，而它的依赖方向受限
 * （只依赖 data-root，不能引 cursor-config——后者带着 SDK 类型 / mcp-config 校验）。目录候选的
 * 计算两边必须一致，所以抽到这个只依赖 node:os / node:path 的叶子模块；`cursor-config` 再导出同名函数，
 * 对外 API 不变。
 */
import os from "node:os";
import path from "node:path";

/**
 * 全局 Cursor 配置目录候选（按优先级、取第一个能命中的）
 * - mac/linux/win 官方都是 home 下的 `.cursor/`（`os.homedir()` 自适配跨平台）
 * - win 旧版个别落在 `%APPDATA%/Cursor/`、加 fallback 兜底（官方文档以 home 为准）
 */
export const getGlobalCursorDirs = (): string[] => {
  const dirs: string[] = [];
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".cursor"));
  if (process.platform === "win32" && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, "Cursor"));
  }
  return dirs;
};
