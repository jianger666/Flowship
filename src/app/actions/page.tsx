"use client";

/**
 * Action 管理页（V0.9、独立页 /actions）
 *
 * 内置 + 自定义 action 统一一个列表管理（ActionLayoutConfig）：拖拽排序 + 显隐开关、
 * 自定义的额外可编辑 / 删除（CustomActionEditor Dialog）+ 顶部「导入 / 导出 / 新建」。
 * 顺序 / 显隐影响任务详情「推进」菜单里 action 的排列。
 * 导入 / 导出（v0.9.14）：都以文件夹为单位（用户拍板「批量就用文件夹的形式」）——导出选目录平铺写 md、
 * 导入选同一个文件夹扫第一层 md、飞书传文件夹（压缩包）即可团队共享。
 * 导出入口只有顶部一个（先弹勾选 ExportActionsDialog、默认全选）——不做行内单个导出（用户拍板、少一处入口）。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileDown, FileUp, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { CustomActionEditor } from "@/components/custom-actions/custom-action-editor";
import { ActionLayoutConfig } from "@/components/custom-actions/action-layout-config";
import { ExportActionsDialog } from "@/components/custom-actions/export-actions-dialog";
import {
  deleteCustomActionReq,
  exportCustomActionsReq,
  fetchCustomActions,
  fetchSkills,
  importCustomActionsReq,
} from "@/lib/custom-action-client";
import { pickNativePaths } from "@/lib/native-picker";
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
  // 本机可用 skill 名集合（给行内 chips 判定缺失；null = 未拉到、不判定防误报）
  const [knownSkills, setKnownSkills] = useState<Set<string> | null>(null);
  // 导入 / 导出进行中（防双击连开两个原生对话框）
  const [transferring, setTransferring] = useState(false);
  // 导出勾选弹窗开关（导出唯一入口：顶部按钮 → 勾选弹窗 → 目录 picker）
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

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

  // skill 集合拉一次（失败保持 null、行内不标缺失、不打扰主流程）
  useEffect(() => {
    fetchSkills()
      .then((s) => setKnownSkills(new Set(s.map((x) => x.name))))
      .catch(() => setKnownSkills(null));
  }, []);

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

  // 导入：原生 picker 选文件夹 → server 扫目录第一层 md 逐个解析入库（id 重新生成）→ 刷新列表
  const handleImport = async () => {
    if (transferring) return;
    const dirs = await pickNativePaths({
      mode: "folder",
      prompt: "选择存放 action 定义（md）的文件夹",
    });
    if (!dirs?.[0]) return;
    setTransferring(true);
    try {
      const r = await importCustomActionsReq(dirs[0]);
      if (r.imported.length > 0) {
        toast.success(`已导入 ${r.imported.length} 个 action`);
        void load();
      }
      if (r.failed.length > 0) {
        toast.error(
          `${r.failed.length} 个文件导入失败：${r.failed[0]!.reason}${r.failed.length > 1 ? " 等" : ""}`,
        );
      }
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTransferring(false);
    }
  };

  // 导出：选目录、每个 action 写一个 <label>.md（对方拿到直接导入）
  const handleExport = async (ids: string[]) => {
    if (transferring || ids.length === 0) return;
    const dirs = await pickNativePaths({
      mode: "folder",
      prompt: "选择导出目录",
    });
    if (!dirs?.[0]) return;
    setTransferring(true);
    try {
      const r = await exportCustomActionsReq(ids, dirs[0]);
      if (r.exported.length > 0) {
        toast.success(`已导出 ${r.exported.length} 个到 ${dirs[0]}`);
      }
      if (r.failed.length > 0) {
        toast.error(`导出失败 ${r.failed.length} 个：${r.failed[0]!.reason}`);
      }
    } catch (err) {
      toast.error(`导出失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTransferring(false);
    }
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
          <div className="flex items-center gap-2">
            {/* 导入 / 导出（v0.9.14 团队点对点共享）：定义就是 md 文件、飞书传文件即可 */}
            <Button
              variant="outline"
              onClick={() => void handleImport()}
              disabled={transferring}
            >
              {transferring ? <Loader2 className="animate-spin" /> : <FileUp />}
              导入
            </Button>
            <Button
              variant="outline"
              onClick={() => setExportDialogOpen(true)}
              disabled={transferring || actions.length === 0}
              title={actions.length === 0 ? "还没有自定义 action" : "勾选导出自定义 action"}
            >
              {transferring ? <Loader2 className="animate-spin" /> : <FileDown />}
              导出
            </Button>
            <Button onClick={handleNew}>
              <Plus />
              新建
            </Button>
          </div>
        </div>
      </div>

      {/* 内置 + 自定义混排成一个列表统一管理：拖拽排序 + 显隐开关、自定义行额外可编辑 / 删除 */}
      {loading ? (
        <LoadingState variant="card" />
      ) : (
        <ActionLayoutConfig
          customActions={actions}
          knownSkills={knownSkills}
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

      {/* 导出勾选弹窗：确认后走 handleExport（目录 picker + 请求） */}
      <ExportActionsDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        actions={actions}
        onConfirm={(ids) => void handleExport(ids)}
      />
    </div>
  );
};

export default ActionsPage;
