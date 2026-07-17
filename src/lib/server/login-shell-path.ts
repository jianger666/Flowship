/**
 * mac GUI 启动的 PATH 补全（fix-path 同款思路、自实现 20 行不引包）
 *
 * # 背景（2026-07-16 用户实测 v1.1.15 预览 `yarn: command not found`）
 *
 * 从 Dock / Finder / 自更新重启拉起的 mac app 继承的是 launchd 的精简 PATH
 *（通常只有 /usr/bin:/bin:/usr/sbin:/sbin 加零星几项）——不含 homebrew / nvm /
 * pnpm / yarn 等用户目录。后果：预览 dev server（`yarn local`）exit 127、
 * SDK agent shell 也可能缺工具。而从终端 `open` 启动时继承终端完整 PATH、
 * 一切正常——同一功能「时好时坏」的根因就是启动方式不同。
 *
 * # 行为
 *
 * server 启动时跑一次用户默认登录 shell（`$SHELL -ilc`、marker 夹取 stdout 里的
 * $PATH）、与当前 PATH 合并（登录 shell 的在前、去重保序）写回 process.env.PATH。
 * 之后 spawn 的一切子进程（预览 / SDK agent / git 探测）都继承补全后的 PATH。
 *
 * - 仅 darwin 生效：Windows GUI 进程本来就继承完整用户环境变量（注册表 User env）、
 *   没有这个问题；linux 非交付形态不处理。
 * - 失败兜底：探测超时（5s）/ shell 报错 → 保持原 PATH、只 warn 不阻断启动。
 * - 顺序：instrumentation 先 injectFeishuCliPath（tools/bin 前置），再异步跑本函数合并
 *   login PATH；合并时用 pinnedPrefixes 把 tools/bin 重新置顶，避免被 login 段挤到后面。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getToolsBinDir } from "./feishu-cli";

const execFileAsync = promisify(execFile);

/** marker 夹取：rc 可能往 stdout 打杂音、只认最后一对 marker 之间的内容 */
export const extractPathFromShellOutput = (
  stdout: string,
  marker: string,
): string | null => {
  const parts = stdout.split(marker);
  if (parts.length < 3) return null;
  const value = parts[parts.length - 2];
  return value && value.trim().length > 0 ? value.trim() : null;
};

/**
 * 合并两串 PATH：login 的在前、当前的追加、去重保序、空段丢弃。
 * pinnedPrefixes：已出现在合并集合里的前缀重新置顶（审查修复：injectFeishuCliPath 只
 * 「存在即跳过」、不会重置顶，故不能靠 merge 后再调 inject；在 merge 里显式 pin）。
 */
export const mergePathStrings = (
  loginPath: string,
  currentPath: string,
  pinnedPrefixes: readonly string[] = [],
): string => {
  const segments = [...loginPath.split(":"), ...currentPath.split(":")];
  const merged: string[] = [];
  const seen = new Set<string>();
  // 先放仍出现在合并集合里的 pinned（保持调用方给定顺序）
  for (const p of pinnedPrefixes) {
    if (!p || seen.has(p) || !segments.includes(p)) continue;
    seen.add(p);
    merged.push(p);
  }
  for (const p of segments) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
  }
  return merged.join(":");
};

/** 探测预算：重 rc（nvm/omz）实测 3~4s、给足余量；超时保持原 PATH 不阻断启动 */
const PROBE_TIMEOUT_MS = 10_000;

export const mergeLoginShellPath = async (): Promise<void> => {
  if (process.platform !== "darwin") return;
  const shell = process.env.SHELL || "/bin/zsh";
  const marker = "__FE_AI_FLOW_PATH_MARKER__";
  try {
    // -ilc：interactive + login——.zprofile/.zshrc（nvm/homebrew 常写在这）都会被 source
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", `printf '%s' '${marker}'; printf '%s' "$PATH"; printf '%s' '${marker}'`],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
    );
    const loginPath = extractPathFromShellOutput(stdout, marker);
    if (!loginPath) {
      console.warn("[login-shell-path] 登录 shell 未返回 PATH、保持原值");
      return;
    }
    // tools/bin 必须置顶：否则 login PATH 里同名 lark-cli 会抢先于内置 CLI
    const toolsBin = getToolsBinDir();
    process.env.PATH = mergePathStrings(
      loginPath,
      process.env.PATH ?? "",
      [toolsBin],
    );
    console.log(
      `[login-shell-path] PATH 已合并登录 shell（${shell}）、共 ${process.env.PATH.split(":").length} 段`,
    );
  } catch (err) {
    console.warn(
      "[login-shell-path] 登录 shell PATH 探测失败（保持原值、不阻断启动）:",
      err instanceof Error ? err.message : err,
    );
  }
};
