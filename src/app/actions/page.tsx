"use client";

/**
 * 自定义 Action 管理页（V0.9、独立页 /actions）
 *
 * 列表 + 新建 / 编辑（CustomActionEditor Dialog）+ 删除。
 * 把常用流程封装成 action、之后在任务详情「推进」菜单的「我的」组里像内置一样选。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyHint } from "@/components/ui/empty-hint";
import { useDialog } from "@/hooks/use-dialog";
import { CustomActionEditor } from "@/components/custom-actions/custom-action-editor";
import { ActionLayoutConfig } from "@/components/custom-actions/action-layout-config";
import {
  deleteCustomActionReq,
  fetchCustomActions,
} from "@/lib/custom-action-client";
import type { CustomActionDef } from "@/lib/types";

const ActionsPage = () => {
  const router = useRouter();
  const { confirm } = useDialog();
  // 自定义 action 列表
  const [actions, setActions] = useState<CustomActionDef[]>([]);
  // 列表加载中
  const [loading, setLoading] = useState(true);
  // 编辑器开关
  const [editorOpen, setEditorOpen] = useState(false);
  // 正在编辑的 action（null = 新建）
  const [editing, setEditing] = useState<CustomActionDef | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setActions(await fetchCustomActions());
    } catch (err) {
      toast.error(`加载失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 返回 = 回来路（首页 / 设置页都可能进）、无历史兜底回首页
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };

  const handleNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const handleEdit = (def: CustomActionDef) => {
    setEditing(def);
    setEditorOpen(true);
  };

  const handleDelete = async (def: CustomActionDef) => {
    const ok = await confirm({
      title: `删除「${def.label}」？`,
      description: "用它跑过的历史任务不受影响、但之后不能再新推进这个 action。",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteCustomActionReq(def.id);
      toast.success("已删除");
      setActions((prev) => prev.filter((a) => a.id !== def.id));
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    }
  };

  // 保存成功：合并进列表（新建追加到最前 / 编辑替换原位）
  const handleSaved = (def: CustomActionDef) => {
    setActions((prev) => {
      const idx = prev.findIndex((a) => a.id === def.id);
      if (idx === -1) return [def, ...prev];
      const next = [...prev];
      next[idx] = def;
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 px-2"
          onClick={handleBack}
        >
          <ArrowLeft />
          返回
        </Button>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">自定义 Action</h1>
            <p className="text-sm text-muted-foreground">
              把常用流程封装成 action、在任务里像内置一样推进
            </p>
          </div>
          <Button onClick={handleNew}>
            <Plus />
            新建
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingState variant="card" />
      ) : actions.length === 0 ? (
        <EmptyHint variant="dashed" size="lg" align="center">
          还没有自定义 action、点右上角「新建」封装一个
        </EmptyHint>
      ) : (
        <div className="grid gap-3">
          {actions.map((a) => (
            <Card
              key={a.id}
              className="flex-row items-start justify-between gap-3 p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.label}</div>
                {a.summary && (
                  <div className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                    {a.summary}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {a.skills && a.skills.length > 0 && (
                    <span>{a.skills.length} 个 skill</span>
                  )}
                  {a.checkCommands && a.checkCommands.length > 0 && (
                    <span>{a.checkCommands.length} 条 check</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleEdit(a)}
                  title="编辑"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleDelete(a)}
                  title="删除"
                >
                  <Trash2 />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* V0.9：推进面板布局——配「推进」弹窗里 action 的顺序 + 显隐 */}
      <div className="mt-8 border-t pt-6">
        <div className="mb-3">
          <h2 className="text-base font-semibold">推进面板布局</h2>
          <p className="text-sm text-muted-foreground">
            调「推进」里 action 的顺序和显隐、隐藏的收进「更多」
          </p>
        </div>
        <ActionLayoutConfig customActions={actions} />
      </div>

      <CustomActionEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        onSaved={handleSaved}
      />
    </div>
  );
};

export default ActionsPage;
