/**
 * 事件流「行视图状态」存档：模块级、有上限的 LRU（纯函数，可单测，不依赖 React / DOM）
 *
 * 解决什么（第二轮 review V2-05）：事件流是 Virtuoso 虚拟列表，`VIEWPORT_OVERSCAN = { top: 0, bottom: 1500 }`
 * 让行一离开视口上沿就卸载。工具块 manualCollapsed / outputOpen / diffCollapsed / fullText、待办卡、
 * 动词组、思考 / info 行、工作过程组的「钉住展开」原来全是组件内 useState——用户点开看完、往上滚一屏再滚回来，
 * 全部回到默认；点过「加载完整输出」的 fullText 丢了还要再请求一次。
 *
 * 做法（小步版，不做大重构）：这些状态改读写这里。只存「用户真动过的」值（组件没调 setter 就不占内存），
 * 重挂时由 `useRowViewState`（src/hooks/use-row-view-state.ts）在首帧从这里还原。
 *
 * 内存有限、切任务不泄漏：
 *  - 条数上限 + 总字节上限（fullText 可能几百 KB），超了按 LRU 淘汰最久没读写过的；
 *  - 单条超过单条上限的值（特大 fullText）不存——组件仍在内存里持有它，只是卸载后不保留、重挂会再请求一次；
 *  - key 带 taskId，`clearTask` 可整任务清理；即便没人调，全局上限也保证总量有界。
 *
 * 只存原始值（boolean / number / string / null）：字节估算简单、不会误把对象引用（连带整份事件）长期抓在手里。
 */

export type RowViewValue = boolean | number | string | null;

export interface RowViewStateLimits {
  /** 最多多少条 */
  maxEntries: number;
  /** 总字节上限（估算：字符串按 UTF-16 每字符 2 字节，加 key 与每条固定开销） */
  maxBytes: number;
  /** 单条上限：超过的值直接不存 */
  maxEntryBytes: number;
}

/** 默认：几百条、几 MB 封顶——一次点开的展开态极小，只有 fullText 会占体积 */
export const DEFAULT_ROW_VIEW_STATE_LIMITS: RowViewStateLimits = {
  maxEntries: 600,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
};

/** key 分隔符：ASCII Unit Separator，事件 id / 字段名 / taskId 里不会出现 */
const SEP = "\u001f";

/**
 * 给 key 追加作用域：「同一个任务里还有另一套行 id」的场景用（子代理详情抽屉：每份记录的行 id
 * 都是 sr_1、sr_2…，不隔离就和主流 / 别的子代理串状态）。追加在最后，所以 taskId 前缀不变、
 * `clearTask` 照样能清到。空作用域 = 原 key。
 */
export const withRowViewStateScope = (key: string, scope?: string): string =>
  scope ? `${key}${SEP}@${scope}` : key;

/** 构造存档 key：taskId + 行 id（事件 / 工具块 / 组 id）+ 字段名（+ 可选作用域） */
export const rowViewStateKey = (
  taskId: string,
  rowId: string,
  field: string,
  scope?: string,
): string =>
  withRowViewStateScope(`${taskId}${SEP}${rowId}${SEP}${field}`, scope);

/** 估算占用字节（只用于上限判断，不求精确） */
const estimateBytes = (key: string, value: RowViewValue): number => {
  const payload = typeof value === "string" ? value.length * 2 : 8;
  // 每条 Map 项的固定开销按 64 字节估
  return key.length * 2 + payload + 64;
};

export interface RowViewStateStore {
  has(key: string): boolean;
  /** 读（顺手续命）；没存过 → undefined（存的值不会是 undefined） */
  get(key: string): RowViewValue | undefined;
  /**
   * 写（顺手续命）。`undefined` = 删除。
   * 返回 false = 没存下（单条超上限）；此时同 key 的旧值也被清掉，免得重挂时旧值「复活」。
   */
  set(key: string, value: RowViewValue | undefined): boolean;
  delete(key: string): void;
  /** 清掉某个任务的全部条目（含抽屉作用域的），返回清了多少条 */
  clearTask(taskId: string): number;
  clear(): void;
  readonly size: number;
  readonly bytes: number;
}

export const createRowViewStateStore = (
  limits: RowViewStateLimits = DEFAULT_ROW_VIEW_STATE_LIMITS,
): RowViewStateStore => {
  // Map 的迭代序 = 插入序：每次读写先 delete 再 set 就把条目挪到末尾，首项永远是最久没用的
  const map = new Map<string, { value: RowViewValue; bytes: number }>();
  let totalBytes = 0;

  const remove = (key: string): void => {
    const hit = map.get(key);
    if (!hit) return;
    totalBytes -= hit.bytes;
    map.delete(key);
  };

  const evict = (): void => {
    while (
      (map.size > limits.maxEntries || totalBytes > limits.maxBytes) &&
      map.size > 0
    ) {
      const oldest = map.keys().next().value as string;
      remove(oldest);
    }
  };

  return {
    has: (key) => map.has(key),
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      remove(key);
      if (value === undefined) return true;
      const bytes = estimateBytes(key, value);
      if (bytes > limits.maxEntryBytes || bytes > limits.maxBytes) return false;
      map.set(key, { value, bytes });
      totalBytes += bytes;
      evict();
      return true;
    },
    delete: remove,
    clearTask(taskId) {
      const prefix = `${taskId}${SEP}`;
      let n = 0;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          remove(key);
          n++;
        }
      }
      return n;
    },
    clear() {
      map.clear();
      totalBytes = 0;
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return totalBytes;
    },
  };
};

/** 进程内唯一的存档（浏览器里一个标签页一份；服务端渲染不会写入——没有用户交互） */
export const rowViewStateStore: RowViewStateStore = createRowViewStateStore();
