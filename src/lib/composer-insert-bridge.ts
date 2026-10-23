/**
 * 「把一段文字塞进某个任务的输入框」的跨组件桥（模块级、无 React）。
 *
 * 为什么需要：「引用到对话」的发起方在代码改动面板（Sheet）里，而草稿住在
 * chat 的 EventStream / task 的 TaskTalkComposer 内部——互相拿不到对方的 setState。
 * 输入框组件挂载时按 taskId 注册一个接收函数，面板调 insertIntoComposer 投递即可。
 */

type Handler = (text: string) => void;

const handlers = new Map<string, Handler>();

/**
 * 注册某个任务输入框的接收函数；返回注销函数。
 * 同一任务重复注册以后注册的为准（组件重挂载 / 热更新）；注销只清自己那一份，不误伤后来者。
 */
export const registerComposerInsert = (taskId: string, handler: Handler): (() => void) => {
  handlers.set(taskId, handler);
  return () => {
    if (handlers.get(taskId) === handler) handlers.delete(taskId);
  };
};

/** 投递；返回是否有输入框接收（false = 当前没有可用的输入框，调用方给用户提示） */
export const insertIntoComposer = (taskId: string, text: string): boolean => {
  const handler = handlers.get(taskId);
  if (!handler) return false;
  handler(text);
  return true;
};

/**
 * 把片段接在草稿后面：草稿空 = 就是片段本身；否则隔一个空行。
 * 末尾留一个空行，光标落在引用之后、用户可以直接接着写问题。
 */
export const appendToDraft = (draft: string, snippet: string): string => {
  const s = snippet.replace(/\s+$/, "");
  if (!s) return draft;
  const base = draft.replace(/\s+$/, "");
  return base ? `${base}\n\n${s}\n\n` : `${s}\n\n`;
};
