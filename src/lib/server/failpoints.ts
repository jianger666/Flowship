/**
 * failpoint 测试基建（ownership-refactor-2026-07-18）：
 * 在启动/接管链路的关键 await 点插桩，矩阵测试按名注入「stop / 二次唤醒 / advance / 抛错」
 * 验证固定不变量（I1~I5）。生产路径未注册任何 hook、Map 查一次即返回、零开销。
 */

type FailpointFn = () => void | Promise<void>;

// 测试注册的插桩回调（key = 插桩点名、见 docs/ownership-refactor-2026-07-18.md 固定清单）
const hooks = new Map<string, FailpointFn>();

/** 链路代码在关键 await 点调用；未注册即秒过。注入的回调抛错 = 模拟该点异常 */
export const failpoint = async (name: string): Promise<void> => {
  const fn = hooks.get(name);
  if (fn) await fn();
};

/** 测试用：注入某插桩点的行为（挂起 / 触发 stop / 抛错…） */
export const setFailpoint = (name: string, fn: FailpointFn): void => {
  hooks.set(name, fn);
};

/** 测试用：清除单个插桩点 */
export const clearFailpoint = (name: string): void => {
  hooks.delete(name);
};

/** 测试用：afterEach 全清、防跨用例串扰 */
export const clearFailpoints = (): void => {
  hooks.clear();
};
