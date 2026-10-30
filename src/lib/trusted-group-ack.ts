/**
 * 需求群「只绑可信内部群」的告知与一次性确认（第四轮 B4-4 / Q12b-05）
 *
 * 为什么要告知：群里任何能 @ 机器人的成员提问，机器人都会以任务属主的身份在本机起一个答疑 Agent——
 * 它跑在属主的机器上，工具并没有被禁掉，「只读 / 不许碰凭据」靠的是提示词约束（见 restricted-question.ts 头注释）。
 * 把机器人拉进有外部合作方 / 陌生人的群，等于把属主的凭据（PAT、apiKey、公司环境密码）交到那些人手里。
 * 代码里早就写明了这一点，但属主在绑群 / 建群的那一刻从来没被告知过。
 *
 * 做法（刻意轻量）：
 *  - 弹窗里常驻一行说明（手动绑定与自动创建两个模式都有）；
 *  - **第一次手动绑定**前多一次确认，确认过一次就记进 localStorage，以后不再打断
 *    （纯本地便利状态、按 origin 隔离，丢了就重新确认一次，不影响功能）。
 *
 * 纯函数 + 可注入的 storage（可在 node 里测，无 React 依赖），写法对齐 corrupt-task-dismiss。
 */

/** 常驻说明与确认弹窗共用的那句话（单测按字面断言，改文案要同步测试） */
export const TRUSTED_GROUP_NOTICE =
  "群里任何成员 @ 机器人，机器人都会以你的身份读取本机文件来答疑。只绑定都是可信同事的内部群。";

export const TRUSTED_GROUP_CONFIRM_TITLE = "这个群里都是可信的同事吗？";
export const TRUSTED_GROUP_CONFIRM_LABEL = "都是同事，继续绑定";

export const TRUSTED_GROUP_ACK_KEY = "flowship:requirement-group-trusted-ack";

export type AckStorage = Pick<Storage, "getItem" | "setItem">;

/** 浏览器的 localStorage；服务端渲染 / 存储被禁用（访问它本身就会抛）时回 null */
export const browserAckStorage = (): AckStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** 是否已经确认过（读不出 / 没有 storage 一律当没确认：宁可多问一次） */
export const hasTrustedGroupAck = (storage: AckStorage | null): boolean => {
  if (!storage) return false;
  try {
    return storage.getItem(TRUSTED_GROUP_ACK_KEY) === "1";
  } catch {
    return false;
  }
};

/** 记下「已确认」。写失败（隐私模式 / 配额）：只在本次会话生效，下次再问一次，不影响绑定本身 */
export const writeTrustedGroupAck = (storage: AckStorage | null): void => {
  if (!storage) return;
  try {
    storage.setItem(TRUSTED_GROUP_ACK_KEY, "1");
  } catch {
    // 忽略
  }
};
