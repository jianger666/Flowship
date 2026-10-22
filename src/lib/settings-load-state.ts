/**
 * 设置「是否已成功加载磁盘上的真实配置」的口径（review #16）
 *
 * 背景：设置页首次 GET /api/settings/full 瞬时失败（服务没就绪 / 网络抖动）时，local-store 的缓存只是
 * 默认值。以前这份默认值照样被当成「已就绪」渲染成一个无提示的空表单；用户改任一项，
 * 保存链会先重试一次加载、**成功后又用「以默认值为底构造的 next」整包 PUT**，
 * 磁盘上的 apiKey / gitToken / 仓库 / 公司环境密码 / MCP / provider 就被默认值覆盖了
 * （服务端只会在收缩时留一份 config.json.bak.shrink、写本身不拦）。
 *
 * 现在的规则（宁可拒写、不做合并）：没有成功加载过真实配置 → 任何整对象 PUT 都拒绝；
 * 设置页显示加载失败提示 + 「重试加载」，重试成功后才允许编辑。
 *
 * 纯逻辑（不依赖 React / DOM / fetch），便于在 node 环境单测。
 */

export interface SettingsLoadState {
  /** 最近一次 initSettings 是否成功把磁盘上的真实 config.json 灌进了缓存（local-store.isSettingsLoaded） */
  initSucceeded: boolean;
}

/**
 * 当前能不能把设置写盘。
 *
 * 为什么只看 initSucceeded：调用方构造 next 时用的是 getSettings()——init 成功前它只是默认值，
 * 在此基础上改一项再整包 PUT 等于用默认值覆盖磁盘。init 成功后缓存才是磁盘的真实镜像。
 */
export const canPersistSettings = (state: SettingsLoadState): boolean =>
  state.initSucceeded === true;

/** 拒写时的 toast 文案（use-settings 用；local-store 层的拒写只打日志） */
export const SETTINGS_NOT_LOADED_TOAST =
  "配置还没有从本机服务加载成功，已拒绝保存以免覆盖现有配置。请点页面上的「重试加载」";

export interface SettingsLoadFailureText {
  /** 横幅标题 */
  headline: string;
  /** 一句话说明原因 + 怎么办 */
  detail: string;
}

/**
 * 「加载失败但不是 config.json 不可读」（网络 / 服务没就绪 / 非 settings_unreadable 的 5xx）的横幅文案。
 * config.json 本身不可读的场景仍用 settings-unreadable.ts 的 describeSettingsUnreadable（有 .bak 恢复指引）。
 */
export const describeSettingsLoadFailure = (): SettingsLoadFailureText => ({
  headline: "配置没能从本机服务加载成功，设置已暂停保存",
  detail:
    "设置页没有拿到 config.json 里的真实配置（本机服务可能刚启动还没就绪、或暂时繁忙 / 连接中断）。" +
    "为避免把空白默认值写回、覆盖你已有的 API Key、GitLab Token、仓库、公司环境、MCP 和模型提供方配置，所有保存都已被拒绝，磁盘上的 config.json 没有被改动。" +
    "请点「重试加载」；如果反复失败，请检查应用是否正常运行，或重启应用后再进入设置页。",
});
