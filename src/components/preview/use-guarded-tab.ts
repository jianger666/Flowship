"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

/**
 * 「预览 / 源码」这类页签：源码页签里有未保存的编辑时不允许切走（切走会卸载编辑器、草稿就丢了）。
 * 脏状态由 CodeViewer 经 onDirtyChange 上报，这里转发给外壳，同时自己记一份来拦页签切换。
 */
export const useGuardedTab = <T extends string>(
  initial: T,
  onDirtyChange: (dirty: boolean) => void,
): { tab: T; switchTab: (next: T) => void; handleDirty: (dirty: boolean) => void } => {
  const [tab, setTab] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);

  const handleDirty = useCallback(
    (d: boolean) => {
      setDirty(d);
      onDirtyChange(d);
    },
    [onDirtyChange],
  );

  const switchTab = useCallback(
    (next: T) => {
      if (dirty) {
        toast.info("有未保存的修改，请先保存或放弃再切换视图");
        return;
      }
      setTab(next);
    },
    [dirty],
  );

  return { tab, switchTab, handleDirty };
};
