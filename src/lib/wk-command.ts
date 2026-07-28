/**
 * wk:* 指令映射（团队 wk-harness 规范）
 *
 * Flowship 里的「团队 · wk 流程」action 是九个官方指令的壳：共享库
 * `skills/common/wk-<x>/` → 派生 action（origin=team、skill=`wk-<x>`）。
 * 本模块只负责一件事：**把 action 定义映射成官方指令名**，供门禁拼参数用。
 *
 * 判定复用 `action-layout.isWkFlowShell`（推进面板分组同一套逻辑）、
 * 再要求 skill 名能落到九个指令里——`wk-harness` / `wk-fe-harness` /
 * `wk-java-testing` 这类同前缀的知识库 skill 不是指令、不会被误判。
 *
 * 表本身对齐 `wk-harness/scripts/gates/runner.py` 的 COMMANDS / COMMAND_SCOPE
 * 与 `references/command-contract.md`「无 hook fallback preflight」段。
 */

import { isWkFlowShell } from "./action-layout";
import type { CustomActionDef } from "./types";

/** 九个官方 wk:* 指令（= runner.py 的 COMMANDS） */
export const WK_COMMANDS = [
  "wk:prd-review",
  "wk:biz-analyze",
  "wk:biz-confirm",
  "wk:change-propose",
  "wk:change-confirm",
  "wk:repo-design",
  "wk:repo-execute",
  "wk:repo-review",
  "wk:biz-verify",
] as const;

export type WkCommand = (typeof WK_COMMANDS)[number];

const WK_COMMAND_SET = new Set<string>(WK_COMMANDS);

/** 指令作用域（= wk-delivery-sync.py 的 COMMAND_SCOPE），决定产物落业务级还是仓库级 */
const WK_COMMAND_SCOPE: Record<WkCommand, "business" | "repo"> = {
  "wk:prd-review": "business",
  "wk:biz-analyze": "business",
  "wk:biz-confirm": "business",
  "wk:change-propose": "business",
  "wk:change-confirm": "business",
  "wk:repo-design": "repo",
  "wk:repo-execute": "repo",
  "wk:repo-review": "repo",
  "wk:biz-verify": "business",
};

/**
 * preflight 要带 `--biz-path` 的指令（= runner.check_command_gate 里读 biz_root 的那批）。
 * `wk:prd-review` 不校验任何路径、`wk:repo-review` 只看仓库级。
 */
const NEEDS_BIZ_PATH = new Set<WkCommand>([
  "wk:biz-analyze",
  "wk:biz-confirm",
  "wk:change-propose",
  "wk:change-confirm",
  "wk:repo-design",
  "wk:repo-execute",
  "wk:biz-verify",
]);

/** preflight 要带 `--repo-path` 的指令（= runner.check_command_gate 里读 repo_root 的那批） */
const NEEDS_REPO_PATH = new Set<WkCommand>(["wk:repo-execute", "wk:repo-review"]);

export const isWkCommand = (v: string): v is WkCommand => WK_COMMAND_SET.has(v);

/**
 * skill 名 → 指令名：`wk-repo-design` → `wk:repo-design`。
 * 不在九个指令内（`wk-harness` 等知识库 skill）返回 null。
 */
export const wkCommandForSkill = (
  skill: string | undefined,
): WkCommand | null => {
  const name = (skill ?? "").trim();
  if (!name.startsWith("wk-")) return null;
  const candidate = `wk:${name.slice(3)}`;
  return isWkCommand(candidate) ? candidate : null;
};

/**
 * 自定义 action 定义 → 指令名（推进 / 后置门禁的唯一判定入口）。
 * 非 wk 流程壳、或壳的 skill 不是九个指令之一 → null（门禁完全不介入）。
 */
export const wkCommandForAction = (
  def: Pick<CustomActionDef, "skill" | "order"> | undefined | null,
): WkCommand | null => {
  if (!def || !isWkFlowShell(def)) return null;
  return wkCommandForSkill(def.skill);
};

/** 指令 → 后置门禁的 stage 名（`wk:repo-design` → `repo-design`） */
export const wkStageOf = (command: WkCommand): string => command.slice(3);

/** 指令产物落在业务级目录还是仓库级目录 */
export const wkScopeOf = (command: WkCommand): "business" | "repo" =>
  WK_COMMAND_SCOPE[command];

export const wkNeedsBizPath = (command: WkCommand): boolean =>
  NEEDS_BIZ_PATH.has(command);

export const wkNeedsRepoPath = (command: WkCommand): boolean =>
  NEEDS_REPO_PATH.has(command);
