"use client";

/**
 * 升完版第一次打开：弹「本版更新」。设置页版本号旁也可再打开。
 * 无壳 / 开发版 0.0.0-dev 不弹。首次安装只记下当前版本、不打扰。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  WHATS_NEW_SEEN_KEY,
  collectWhatsNew,
  notesForCurrentVersion,
  shouldSkipAutoWhatsNew,
  type WhatsNewBlock,
} from "@/lib/whats-new";

type WhatsNewApi = {
  /** 设置页：打开当前版本说明（没有本版条目则退到最近一条） */
  openCurrent: () => void;
};

const WhatsNewContext = createContext<WhatsNewApi | null>(null);

export const useWhatsNew = (): WhatsNewApi => {
  const ctx = useContext(WhatsNewContext);
  if (!ctx) {
    return { openCurrent: () => {} };
  }
  return ctx;
};

const readSeen = (): string | null => {
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return null;
  }
};

const writeSeen = (version: string): void => {
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    /* 写不进去顶多多弹一次 */
  }
};

export const WhatsNewHost = ({ children }: { children: ReactNode }) => {
  // 弹窗要展示的版本块；null = 关
  const [blocks, setBlocks] = useState<WhatsNewBlock[] | null>(null);

  const openBlocks = useCallback((next: WhatsNewBlock[]) => {
    if (next.length === 0) return;
    setBlocks(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    // __appVersion 是壳在 did-finish-load 后异步注入的，挂载时可能还没到——
    // 之前只判一次，注晚了就永远错过（1.9.12 实盘：1.9.11→1.9.12 自动重启后没弹）。
    // 每 500ms 看一次，最多等 10s（注入紧跟页面加载，10s 是数倍冗余；
    // dev/非法版本等到就地跳过，超时也停——设置页可手动看，不丢内容）。
    const timer = setInterval(() => {
      tries += 1;
      const current = window.__appVersion;
      if (!current) {
        if (tries >= 20) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      if (shouldSkipAutoWhatsNew(current) || cancelled) return;
      const seen = readSeen();
      if (!seen) {
        // 首次（新装 / 本功能刚上线）：只记账，不弹历史
        writeSeen(current);
        return;
      }
      if (seen === current) return;
      const next = collectWhatsNew(seen, current);
      if (next.length > 0) {
        setBlocks(next);
      } else {
        writeSeen(current);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const openCurrent = useCallback(() => {
    const current = window.__appVersion;
    if (!current) return;
    openBlocks(notesForCurrentVersion(current));
  }, [openBlocks]);

  const api = useMemo(() => ({ openCurrent }), [openCurrent]);

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    const current = window.__appVersion;
    if (current && !shouldSkipAutoWhatsNew(current)) writeSeen(current);
    setBlocks(null);
  };

  const title =
    blocks && blocks.length === 1
      ? `v${blocks[0].version} 更新了什么`
      : "更新了什么";

  return (
    <WhatsNewContext.Provider value={api}>
      {children}
      <Dialog open={blocks !== null} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">
              这个版本对你有用的变化
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(blocks ?? []).map((block) => (
              <div key={block.version}>
                {blocks && blocks.length > 1 ? (
                  <div className="mb-1.5 text-xs text-muted-foreground">
                    v{block.version}
                  </div>
                ) : null}
                <ul className="list-disc space-y-1.5 pl-4 text-sm">
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => handleOpenChange(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WhatsNewContext.Provider>
  );
};
