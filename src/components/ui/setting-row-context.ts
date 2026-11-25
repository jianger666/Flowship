"use client";

import { createContext, useContext } from "react";

/**
 * SettingRow → 行内控件的无障碍接线（独立文件：避免 Switch ↔ SettingRow 循环引用，同 form-context）。
 *
 * 设置行左边的「名称 + 说明」和右边的开关没有 DOM 层面的关联，读屏软件只会念出「开关」。
 * SettingRow 把名称 / 说明节点的 id 放进这个 context，行里的 Switch 在**没有显式写** aria-label /
 * aria-labelledby 时自动借用（显式写了的优先，如「电脑操作」里的授权类开关）。
 */
export interface SettingRowA11y {
  /** 名称节点的 id。只指向名称文字本身，不含「更多说明」ⓘ 按钮——免得读屏把它也念进开关的名字 */
  labelId: string;
  /** 说明节点的 id；这一行没有 hint 时为 undefined（不指向不存在的节点） */
  hintId?: string;
}

export const SettingRowA11yContext = createContext<SettingRowA11y | null>(null);

/** 不在 SettingRow 里时返回 null（Switch 在表单 / 弹窗里单独用，行为不变） */
export const useSettingRowA11y = (): SettingRowA11y | null =>
  useContext(SettingRowA11yContext);
