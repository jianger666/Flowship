"use client";

/**
 * 全局 confirm / prompt hook + Provider
 *
 * 设计动机：
 *   - 全站禁用 window.{alert, confirm, prompt}——原生弹窗在 dark 主题下白底白字、
 *     带浏览器 chrome 字样、跟 shadcn 风格违和、还会阻塞主线程
 *   - 替代方案：用 base-ui Dialog / AlertDialog 包一个 Promise API、调用方写起来跟
 *     window.confirm 一样顺手（await confirm({...})）、但弹的是 shadcn 风格 modal
 *
 * 使用：
 *   ```ts
 *   const { confirm, prompt } = useDialog();
 *   const ok = await confirm({ title: "删除？", description: "无法撤销", destructive: true });
 *   const name = await prompt({ title: "重命名", defaultValue: "untitled" });
 *   ```
 *
 * 注意：
 *   - 只允许单例：同时只展示一个 confirm 或一个 prompt（栈式不必、调用方自行 await 串行）
 *   - 不允许 Esc / backdrop dismiss、避免用户误关后业务逻辑卡住——必须显式 cancel / confirm
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Confirm 配置
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // 走 destructive 主题色（红）、适合「删除 / 覆盖」类操作
  destructive?: boolean;
}

// Prompt 配置
export interface PromptOptions {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // 内联校验：返非空字符串视为错误信息、提交按钮 disable
  validate?: (value: string) => string;
  // input 自动 trim 再返、默认 true
  trim?: boolean;
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export const useDialog = (): DialogContextValue => {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog 必须在 <DialogProvider> 内使用");
  }
  return ctx;
};

interface DialogProviderProps {
  children: ReactNode;
}

// confirm / prompt 内部 state、用 union 表示「当前弹什么」
type DialogState =
  | { kind: "none" }
  | {
      kind: "confirm";
      opts: ConfirmOptions;
      resolve: (v: boolean) => void;
    }
  | {
      kind: "prompt";
      opts: PromptOptions;
      resolve: (v: string | null) => void;
    };

export const DialogProvider = ({ children }: DialogProviderProps) => {
  // 当前打开的弹窗描述、resolve 留在 state 里、关闭时调用
  const [state, setState] = useState<DialogState>({ kind: "none" });

  // prompt input 受控值、单独 state 避免 update state 时丢 resolve 引用
  const [promptValue, setPromptValue] = useState("");

  // 卸载时 resolve 残留的 promise 避免泄漏（很罕见但保险）
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(
    () => () => {
      const cur = stateRef.current;
      if (cur.kind === "confirm") cur.resolve(false);
      if (cur.kind === "prompt") cur.resolve(null);
    },
    [],
  );

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: "confirm", opts, resolve });
    });
  }, []);

  const prompt = useCallback((opts: PromptOptions) => {
    setPromptValue(opts.defaultValue ?? "");
    return new Promise<string | null>((resolve) => {
      setState({ kind: "prompt", opts, resolve });
    });
  }, []);

  // 关 confirm：把结果 resolve 出去、清 state
  const closeConfirm = (result: boolean) => {
    if (state.kind !== "confirm") return;
    state.resolve(result);
    setState({ kind: "none" });
  };

  // 关 prompt：传 null 表示取消、传字符串表示提交
  const closePrompt = (result: string | null) => {
    if (state.kind !== "prompt") return;
    const final =
      result !== null && (state.opts.trim ?? true) ? result.trim() : result;
    state.resolve(final);
    setState({ kind: "none" });
  };

  // prompt 当前校验错误（空串 = 无错）
  const promptError =
    state.kind === "prompt"
      ? (state.opts.validate?.(promptValue) ?? "")
      : "";

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}

      {/* Confirm：基于 AlertDialog（不可 dismiss、必须显式选项） */}
      <AlertDialog
        open={state.kind === "confirm"}
        onOpenChange={(open) => {
          if (!open && state.kind === "confirm") closeConfirm(false);
        }}
      >
        {state.kind === "confirm" && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{state.opts.title}</AlertDialogTitle>
              {state.opts.description && (
                <AlertDialogDescription>
                  {state.opts.description}
                </AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => closeConfirm(false)}>
                {state.opts.cancelLabel ?? "取消"}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={state.opts.destructive ? "destructive" : "default"}
                onClick={() => closeConfirm(true)}
              >
                {state.opts.confirmLabel ?? "确认"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {/* Prompt：基于 Dialog + Input（带回车提交 / Esc 取消） */}
      <Dialog
        open={state.kind === "prompt"}
        onOpenChange={(open) => {
          if (!open && state.kind === "prompt") closePrompt(null);
        }}
      >
        {state.kind === "prompt" && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{state.opts.title}</DialogTitle>
              {state.opts.description && (
                <DialogDescription>{state.opts.description}</DialogDescription>
              )}
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Input
                autoFocus
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={state.opts.placeholder}
                aria-invalid={!!promptError}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !promptError) {
                    e.preventDefault();
                    closePrompt(promptValue);
                  }
                }}
              />
              {promptError && (
                <p className="text-xs text-destructive">{promptError}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => closePrompt(null)}>
                {state.opts.cancelLabel ?? "取消"}
              </Button>
              <Button
                onClick={() => closePrompt(promptValue)}
                disabled={!!promptError}
              >
                {state.opts.confirmLabel ?? "确认"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </DialogContext.Provider>
  );
};
