/**
 * 给用户看的版本说明（不是 HANDOFF / CHANGELOG）。
 *
 * 发版时给「即将打的 tag」加一条，最多 3～5 句人话：用户能感知的变化。
 * 内部重构 / 修并发 / 改文件名不要写进来。
 * 草稿必须先给用户过目，同意后再 tag（说「发版」不等于同意文案）。
 *
 * 首次安装只记当前版本、不弹；从旧版升上来才弹 (lastSeen, current] 区间内的条目。
 */

export type WhatsNewBlock = {
  version: string;
  items: string[];
};

/**
 * 用户可见更新说明。key = 三段版本号（无 v 前缀）。
 * 下一条应对齐即将打的 tag；当前已发 1.9.7。
 */
export const WHATS_NEW: Record<string, string[]> = {
  "1.9.2": [
    "对话里点停止后再发，会接着刚才那轮，不用从头来",
    "自定义模型会自动识别接口协议",
    "技能可以来自多个目录，同名只保留一份",
  ],
  "1.9.4": [
    "启动需求时可勾「激活项目」，填编码和 Owner 后直接在交付中心开需求",
    "Windows 点「新版本」确认一次就会下载并重启安装，关掉应用也不会偷偷装",
    "更新后第一次打开会看到本版改了什么，设置页版本号旁也能再看",
    "没说过话的空对话会接着用，不会越点越多",
    "对话底部能直接看到当前思考档，不会被长模型名挡住",
  ],
  "1.9.5": [
    "长对话压缩时会显示「正在压缩上下文」，压完还能继续回",
    "提问后模型会在同一轮等你的答案，不用另开一轮",
    "隔夜或恢复失败后开的新对话会带上最近几轮，不用从头讲",
    "仓库和环境的分支只认列表里的选项，不会手填出奇怪值",
  ],
  "1.9.6": [
    "提测完成后会在需求群里 @ 测试，飞书会推提及",
    "需求群里问机器人，回复里的粗体、代码和列表能正常显示",
    "编辑任务可以取消已经绑上的仓库",
    "环境配置可以填阿里云日志服务 SLS",
    "测试任务切分支失败会自动清干净，不会留下半截改动",
  ],
  "1.9.7": [
    "给飞书机器人发 `/chats`，会出对话遥控器：换对话、新对话、换模型、搜，管的都是电脑上那些聊天",
    "提测通知一次最多挂 10 个 MR 按钮，超的在正文里也能复制到",
    "超长对话会自动换新会话续上（事件流里一条灰线），越聊越稳",
    "提测会在需求群 @ 对应测试，飞书直接推提醒",
  ],
  "1.9.8": [
    "超长、复杂对话更稳：提示词分级裁剪＋工具回包限额＋内存峰值优化，不容易聊着聊着崩了",
    "切换任务再回来，正在发的提问会接着显示发送中，不会丢也不会重复发",
  ],
  "1.9.9": [
    "胖任务推进不再崩：启动时自动清理无用会话缓存，越用越稳",
    "同一任务聊太长会自动换新会话续上（一条灰线提示），历史照样能翻",
    "内存吃紧时推进会提示稍后重试，不会整个应用崩掉重开",
  ],
};

export const WHATS_NEW_SEEN_KEY = "flowship.whatsNewSeen";

/** 最多一次弹窗展示几个版本，避免很久没升的人刷一长串 */
const MAX_BLOCKS = 3;

/** 三段数字比较：a 比 b 新返回正数 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
};

export const isVersionNewer = (a: string, b: string): boolean =>
  compareVersions(a, b) > 0;

const isUsableVersion = (v: string): boolean => {
  if (!v || v.includes("dev")) return false;
  return /^\d+\.\d+\.\d+$/.test(v);
};

/** after（不含）到 through（含）之间、有文案的版本，按旧→新，截断到 MAX_BLOCKS */
export const collectWhatsNew = (
  after: string | null,
  through: string,
): WhatsNewBlock[] => {
  if (!isUsableVersion(through)) return [];
  const versions = Object.keys(WHATS_NEW).sort(compareVersions);
  const picked = versions.filter((v) => {
    if (compareVersions(v, through) > 0) return false;
    if (after && isUsableVersion(after) && compareVersions(v, after) <= 0) {
      return false;
    }
    return true;
  });
  return picked.slice(-MAX_BLOCKS).map((version) => ({
    version,
    items: WHATS_NEW[version] ?? [],
  }));
};

/** 设置页「本版更新」：优先当前版本，没有则退到不超过当前的最近一条 */
export const notesForCurrentVersion = (
  current: string,
): WhatsNewBlock[] => {
  if (!isUsableVersion(current)) return [];
  const items = WHATS_NEW[current];
  if (items && items.length > 0) return [{ version: current, items }];
  const older = Object.keys(WHATS_NEW)
    .filter((v) => compareVersions(v, current) <= 0)
    .sort(compareVersions)
    .at(-1);
  if (!older) return [];
  return [{ version: older, items: WHATS_NEW[older] ?? [] }];
};

export const shouldSkipAutoWhatsNew = (current: string): boolean =>
  !isUsableVersion(current);

export const hasWhatsNewFor = (version: string): boolean =>
  Boolean(WHATS_NEW[version]?.length);
