"use client";

/**
 * Action 管理页（V0.9、独立页 /actions）
 *
 * 内置 + 自定义 action 统一一个列表管理（ActionLayoutConfig）：拖拽排序 + 显隐开关、
 * 自定义的额外可编辑 / 删除（CustomActionEditor Dialog）+ 顶部「新建」。
 * 顺序 / 显隐影响任务详情「推进」菜单里 action 的排列。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
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
            <h1 className="text-lg font-semibold">Action 管理</h1>
            <p className="text-sm text-muted-foreground">
              拖拽调「推进」里的顺序、开关控显隐、自定义的可编辑 / 删除
            </p>
          </div>
          <Button onClick={handleNew}>
            <Plus />
            新建
          </Button>
        </div>
      </div>

      {/* 内置 + 自定义混排成一个列表统一管理：拖拽排序 + 显隐开关、自定义行额外可编辑 / 删除 */}
      {loading ? (
        <LoadingState variant="card" />
      ) : (
        <ActionLayoutConfig
          customActions={actions}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

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
