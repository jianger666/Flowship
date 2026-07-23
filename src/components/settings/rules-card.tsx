"use client";

/**
 * Rules 卡片（v1.1.x Rules 独立化、能力页 Rules tab）
 *
 * 主路径 = 「一句话建规则」（纯文本、无 frontmatter）；所有启用中的规则每次
 * 全文常驻注入（「按需」档位已删）。编辑 = 纯文本改内容。
 * `~/.cursor/rules` 已彻底不参与（不导入也不注入、用户拍板脱离 Cursor）。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyHint } from "@/components/ui/empty-hint";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useDialog } from "@/hooks/use-dialog";
import { getSettings, initSettings, saveSettings } from "@/lib/local-store";
import { cn } from "@/lib/utils";

// 跟 /api/rules 返回对齐
interface RuleRow {
  name: string;
  enabled: boolean;
  absPath: string;
  /** 正文第一行；一句话规则列表主文字用它 */
  bodyPreview: string;
}

// 跟 server `isSafeRuleName` 对齐——客户端自动命名前本地校验
const SAFE_RULE_NAME_RE =
  /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5._-]{0,63}$/;

/**
 * 从一句话洗出合法文件名基底：
 * - 取前 ~12 个字符（按 Unicode code point）
 * - 空白 → `-`、非法字符（emoji 等）丢掉
 * - 空结果兜底 `rule`
 */
const slugifyRuleName = (text: string): string => {
  let raw = "";
  for (const ch of [...text.trim()]) {
    if ([...raw].length >= 12) break;
    if (/\s/u.test(ch)) {
      // 空白压成单个 `-`，避免连杠
      if (raw && !raw.endsWith("-")) raw += "-";
      continue;
    }
    if (/[a-zA-Z0-9\u4e00-\u9fa5._-]/u.test(ch)) raw += ch;
    // emoji / 符号等直接跳过
  }
  raw = raw.replace(/^-+|-+$/g, "").replace(/^[^a-zA-Z0-9\u4e00-\u9fa5]+/u, "");
  if (!raw) return "rule";
  const cps = [...raw];
  if (cps.length > 64) raw = cps.slice(0, 64).join("");
  return SAFE_RULE_NAME_RE.test(raw) ? raw : "rule";
};

/** 撞已有名时探 `-2` / `-3`…；后缀挤占总长时截基底（仍保 64 上限） */
const allocateRuleName = (base: string, existing: Set<string>): string => {
  if (!existing.has(base) && SAFE_RULE_NAME_RE.test(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const maxBaseLen = 64 - suffix.length;
    let truncated = [...base].slice(0, Math.max(1, maxBaseLen)).join("");
    truncated = truncated.replace(/-+$/g, "");
    // 截断后首字符仍须合法；否则退到短兜底再拼后缀
    if (!/^[a-zA-Z0-9\u4e00-\u9fa5]/u.test(truncated)) truncated = "rule";
    const candidate = `${truncated}${suffix}`;
    if (SAFE_RULE_NAME_RE.test(candidate) && !existing.has(candidate)) {
      return candidate;
    }
  }
  // 极端撞名：时间戳后缀（几乎不会走到）
  return `rule-${Date.now()}`.slice(0, 64);
};

/** 一句话 → 纯文本规则内容（结尾补换行） */
const buildQuickRuleMdc = (sentence: string): string => `${sentence.trim()}\n`;

export const RulesCard = () => {
  const { confirm } = useDialog();
  // 自管 rules（null = 还没加载完）
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  // 编辑 dialog：null 关；只编辑已有规则（进阶改 frontmatter 的通道）
  const [editing, setEditing] = useState<{ name: string; content: string } | null>(
    null,
  );
  // 请求飞行中（防双击）
  const [busy, setBusy] = useState(false);
  // 一句话新建输入草稿
  const [quickDraft, setQuickDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      const data = (await res.json()) as { rules?: RuleRow[] };
      setRules(data.rules ?? []);
    } catch (err) {
      toast.error(
        `读取 rules 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setRules([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openEdit = async (name: string) => {
    try {
      const res = await fetch(
        `/api/rules/content?name=${encodeURIComponent(name)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "读取失败");
        return;
      }
      setEditing({ name, content: data.content ?? "" });
    } catch (err) {
      toast.error(
        `读取失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: `删除规则「${name}」？`,
      destructive: true,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/rules?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "删除失败");
        return;
      }
      toast.success(`已删除「${name}」`);
      void refresh();
    } catch (err) {
      toast.error(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // 开关：本地即时切 + settings.disabledRules 落盘（注入时过滤）
  const handleToggle = async (name: string, enabled: boolean) => {
    setRules((prev) =>
      prev ? prev.map((r) => (r.name === name ? { ...r, enabled } : r)) : prev,
    );
    await initSettings();
    const s = getSettings();
    const cur = new Set(s.disabledRules ?? []);
    if (enabled) cur.delete(name);
    else cur.add(name);
    const ok = await saveSettings({ ...s, disabledRules: [...cur] });
    if (!ok) toast.error("开关保存失败、请重试");
  };

  // 一句话添加：自动命名 + 纯文本 .mdc → 现有 POST
  const handleQuickAdd = async () => {
    const sentence = quickDraft.trim();
    if (!sentence || busy) return;
    const existing = new Set((rules ?? []).map((r) => r.name));
    const name = allocateRuleName(slugifyRuleName(sentence), existing);
    const content = buildQuickRuleMdc(sentence);
    setBusy(true);
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(data?.error ?? "添加失败");
        return;
      }
      toast.success(`已添加「${name}」`);
      setQuickDraft("");
      void refresh();
    } catch (err) {
      toast.error(
        `添加失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>
          规则会常驻注入给 AI；尽量简短、复杂流程建议沉淀成 skill
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 主路径：输一句话就建规则（纯文本、常驻注入） */}
        <div className="flex items-center gap-2">
          <Input
            value={quickDraft}
            onChange={(e) => setQuickDraft(e.target.value)}
            placeholder="一句话规则，如：回复永远用中文"
            disabled={busy}
            className="min-w-0 flex-1"
            onKeyDown={(e) => {
              // 单行 Input：裸 Enter 提交（IME 选词中的 Enter 放过）
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void handleQuickAdd();
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void handleQuickAdd()}
            disabled={busy || !quickDraft.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            添加
          </Button>
        </div>

        {rules === null ? (
          <LoadingState variant="inline" />
        ) : rules.length === 0 ? (
          <EmptyHint>还没有自管规则——上面输入一句话即可添加</EmptyHint>
        ) : (
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {rules.map((r) => {
              // 主文字优先正文第一行；空正文退到文件名
              const primary = r.bodyPreview || r.name;
              return (
                <div key={r.name} className="flex items-center gap-2 px-3 py-2">
                  <div className={cn("min-w-0 flex-1", !r.enabled && "opacity-50")}>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm" title={primary}>
                        {primary}
                      </span>
                    </div>
                    <div
                      className="truncate text-[11px] text-muted-foreground"
                      title={r.absPath}
                    >
                      {r.name}
                    </div>
                  </div>
                  {/* 行操作：常驻文字按钮（与能力页 Skill/Action 统一） */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={() => void openEdit(r.name)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[12px] text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDelete(r.name)}
                  >
                    删除
                  </Button>
                  {/* 开关放行尾：操作按钮在前（跟 Skills / MCP 列表对齐） */}
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => void handleToggle(r.name, v)}
                    aria-label={`${r.enabled ? "禁用" : "启用"} ${r.name}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {editing && (
        <RuleEditDialog
          name={editing.name}
          initialContent={editing.content}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (content) => {
            setBusy(true);
            try {
              const res = await fetch("/api/rules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: editing.name, content }),
              });
              if (!res.ok) {
                const data = (await res.json().catch(() => null)) as {
                  error?: string;
                } | null;
                toast.error(data?.error ?? "保存失败");
                return;
              }
              toast.success(`已保存「${editing.name}」`);
              setEditing(null);
              void refresh();
            } catch (err) {
              toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Card>
  );
};

// ----------------- 编辑 dialog（纯文本改内容） -----------------

const RuleEditDialog = ({
  name,
  initialContent,
  busy,
  onClose,
  onSave,
}: {
  name: string;
  initialContent: string;
  busy: boolean;
  onClose: () => void;
  onSave: (content: string) => void | Promise<void>;
}) => {
  // 规则内容草稿
  const [content, setContent] = useState(initialContent);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑规则</DialogTitle>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          aria-label={`规则 ${name} 内容`}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void onSave(content)}
            disabled={busy || !content.trim()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
