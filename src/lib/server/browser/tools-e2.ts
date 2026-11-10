/**
 * 增强包 E2 的工具装配（契约 §15.1）：各切片的工具模块在这里登记。
 *
 * - core：始终注册（storage / permissions / touch / clipboard），能力闸门在 handler 与主进程里按设置再拦；
 * - advanced：「高级调试」组（network_rules / perf / sources / debug / record），由设置 `browserAdvancedTools` 一个开关控制；
 *   工具描述每轮都进 prompt，所以高级组允许整组关掉省 token。
 */
import type { FlowshipToolDef } from "../flowship-tools";
import type { BrowserToolKit } from "./tools";
import { createClipboardTools } from "./tools-clipboard";
import { createDebugTools } from "./tools-debug";
import { createNetRulesTools } from "./tools-net-rules";
import { createPermissionsTools } from "./tools-permissions";
import { createPerfTools } from "./tools-perf";
import { createRecordTools } from "./tools-record";
import { createSourcesTools } from "./tools-sources";
import { createStorageTools } from "./tools-storage";
import { createTouchTools } from "./tools-touch";

/** 高级组被关时的拒绝文案（R6-21）：说清原因与出路，避免模型反复重试 / 绕路 */
export const ADVANCED_TOOLS_OFF_TEXT =
  "「高级调试」工具组已被用户在设置里关闭（设置 → 内置浏览器 → 高级调试工具），browser_network_rules / browser_perf / browser_sources / browser_debug / browser_record 暂时都不能用。" +
  "请不要重试，改用 browser_snapshot / browser_network / browser_console 等基础工具；确有必要请 ask_user 请用户重新打开该开关。";

/**
 * 高级组每个工具的 handler 入口**实时**读设置（R6-21）：工具表在会话创建时一次性建好，之后用户关掉开关，进行中的会话仍握着这些工具——
 * 和「evaluate 调用时判断」的口径不一致。只有显式 `true` 才放行（读不到 / 脏值 → 拒绝：fail-closed）。
 * 主进程不需要独立再判：高级组不是安全边界而是省 token 的装配开关，危险能力（evaluate / 堆快照 / 可执行 mock）在主进程各有自己的闸门。
 */
export const gateAdvancedTools = (kit: BrowserToolKit, tools: FlowshipToolDef[]): FlowshipToolDef[] =>
  tools.map((t) => ({
    ...t,
    handler: async (args, token, ctx) => {
      let on = false;
      try {
        on = kit.getSettings().advancedTools === true;
      } catch {
        on = false;
      }
      return on ? t.handler(args, token, ctx) : kit.errorOut(ADVANCED_TOOLS_OFF_TEXT);
    },
  }));

export const getE2Tools = (kit: BrowserToolKit, opts: { advanced: boolean }): FlowshipToolDef[] => [
  ...createPermissionsTools(kit),
  ...createStorageTools(kit),
  ...createTouchTools(kit),
  ...createClipboardTools(kit),
  ...(opts.advanced
    ? gateAdvancedTools(kit, [
        ...createNetRulesTools(kit),
        ...createPerfTools(kit),
        ...createSourcesTools(kit),
        ...createDebugTools(kit),
        ...createRecordTools(kit),
      ])
    : []),
];
