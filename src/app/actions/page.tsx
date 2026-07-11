"use client";

/**
 * 能力页（v1.0.x、用户拍板「skill / MCP / action 等能力集中一个页面配置」）
 *
 * 原 /actions 只管自定义 Action（V0.9）；现升级为「能力中心」、tab 切三块：
 *   - Action：推进动作（内置 + 自定义统一列表：拖拽排序 / 显隐 / 编辑 / 导入导出）
 *   - Skill：技能（自管可增删改、可从 Cursor 导入、AI 帮建）
 *   - MCP：MCP servers（条目化管理 + 健康 / OAuth + 从 Cursor 导入）
 * 设置页只留「设置」（凭据 / 模型 / 仓库 / 偏好 / 存储）、能力配置都在这。
 *
 * tab 状态走 ?tab=action|skills|mcp（深链可用：settingsUrl("mcp") 等旧跳转已重定向到这）。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileDown, FileUp, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { useSettings } from "@/hooks/use-settings";
import { CustomActionEditor } from "@/components/custom-actions/custom-action-editor";
import { ActionLayoutConfig } from "@/components/custom-actions/action-layout-config";
import { ExportActionsDialog } from "@/components/custom-actions/export-actions-dialog";
import { McpCard } from "@/components/settings/mcp-card";
import { RulesCard } from "@/components/settings/rules-card";
import { SkillsCard } from "@/components/settings/skills-card";
import {
  deleteCustomActionReq,
  exportCustomActionsReq,
  fetchCustomActionsWithDir,
  fetchSkills,
  importCustomActionsReq,
} from "@/lib/custom-action-client";
import { setPendingSlashSkill } from "@/components/slash-skills";
import { getSettings } from "@/lib/local-store";
import { pickNativePaths } from "@/lib/native-picker";
import { createTask } from "@/lib/task-store";
import type { CustomActionDef } from "@/lib/types";

// 四个能力 tab（key 同时是 ?tab= 的取值）
type CapTab = "action" | "skills" | "mcp" | "rules";

const CAP_TABS: Array<{ key: CapTab; label: string }> = [
  { key: "action", label: "Action" },
  { key: "skills", label: "Skill" },
  { key: "mcp", label: "MCP" },
  { key: "rules", label: "Rules" },
];

const isCapTab = (v: string | null): v is CapTab =>
  v === "action" || v === "skills" || v === "mcp" || v === "rules";

/** Action 管理面板（原 /actions 页主体、整体搬进 tab） */
const ActionsPanel = () => {
  const { confirm } = useDialog();
  const router = useRouter();
  // 自定义 action 列表
  const [actions, setActions] = useState<CustomActionDef[]>([]);
  // 存储目录绝对路径（「AI 帮建」开对话当 cwd、server 返回）
  const [actionsDir, setActionsDir] = useState("");
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
  // 「AI 帮建」发起中（防双击）
  const [aiCreating, setAiCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { actions: list, dir } = await fetchCustomActionsWithDir();
      setActions(list);
      setActionsDir(dir);
    } catch (err) {
      toast.error(`加载失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 「AI 帮建」（v1.1.x、对齐 skill 的对话创建）：开一个 cwd 锁在 custom-actions
  // 目录的对话、自动挂 action-creator 的 / chip、用户说需求 AI 直接写 ACTION.md
  const handleAiCreate = async () => {
    const s = getSettings();
    if (!s.apiKey?.trim() || !s.defaultModel?.id?.trim()) {
      toast.error("先在设置页配好 API Key 和默认模型");
      return;
    }
    if (!actionsDir) {
      toast.error("存储目录还没就绪、稍后重试");
      return;
    }
    setAiCreating(true);
    try {
      const task = await createTask({
        mode: "chat",
        title: "创建 action",
        repoPaths: [actionsDir],
        model: s.defaultModel,
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      setPendingSlashSkill("action-creator");
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      toast.error(
        `发起失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAiCreating(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // skill 集合拉一次（失败保持 null、行内不标缺失、不打扰主流程）
  useEffect(() => {
    fetchSkills()
      .then((s) => setKnownSkills(new Set(s.map((x) => x.name))))
      .catch(() => setKnownSkills(null));
  }, []);

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
    <div>
      {/* 面板工具行：说明 + 导入 / 导出 / 新建 */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          拖拽调「推进」里的顺序、开关控显隐、自定义的可编辑 / 删除
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* AI 帮建（v1.1.x）：开对话挂 action-creator chip、说需求直接生成 ACTION.md */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleAiCreate()}
            disabled={aiCreating}
            title="开个对话、AI 按你的描述生成 action"
          >
            {aiCreating ? <Loader2 className="animate-spin" /> : <Sparkles />}
            AI 帮建
          </Button>
          {/* 导入 / 导出（v0.9.14 团队点对点共享）：定义就是 md 文件、飞书传文件即可 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleImport()}
            disabled={transferring}
          >
            {transferring ? <Loader2 className="animate-spin" /> : <FileUp />}
            导入
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExportDialogOpen(true)}
            disabled={transferring || actions.length === 0}
            title={actions.length === 0 ? "还没有自定义 action" : "勾选导出自定义 action"}
          >
            {transferring ? <Loader2 className="animate-spin" /> : <FileDown />}
            导出
          </Button>
          <Button size="sm" onClick={handleNew}>
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

/** MCP 面板：McpCard + useSettings 落盘链路（跟原设置页同一套 hook） */
const McpPanel = () => {
  const { settings, loaded, update, saveFieldValue } = useSettings();
  if (!loaded) return <LoadingState variant="card" />;
  return (
    <McpCard
      appServers={settings.mcpServers ?? {}}
      onAppServersChange={(next) => update("mcpServers", next)}
      onAppServersCommit={(next) => saveFieldValue("mcpServers", next)}
      disabledServers={settings.disabledMcpServers ?? []}
      onChange={(next) => saveFieldValue("disabledMcpServers", next)}
    />
  );
};

const CapabilitiesPage = () => {
  const router = useRouter();
  // 当前 tab（?tab= 初始化、切换时 replaceState 同步 URL、深链 / 刷新不丢）
  const [tab, setTab] = useState<CapTab>("action");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isCapTab(t)) setTab(t);
  }, []);

  const switchTab = (t: CapTab) => {
    setTab(t);
    window.history.replaceState(null, "", `/actions?tab=${t}`);
  };

  // 返回 = 回来路（首页 / 设置页都可能进）、无历史兜底回首页
  const handleBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
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
        <h1 className="text-lg font-semibold">能力</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          AI 干活用的四类能力：推进动作（Action）、技能（Skill）、外部工具（MCP）、规则（Rules）
        </p>
        {/* tab 行：切换三块能力面板 */}
        <div className="mt-4 flex items-center gap-1 border-b pb-2">
          {CAP_TABS.map((t) => (
            <ChoiceButton
              key={t.key}
              shape="tab"
              selected={tab === t.key}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
            </ChoiceButton>
          ))}
        </div>
      </div>

      {tab === "action" && <ActionsPanel />}
      {tab === "skills" && <SkillsCard />}
      {tab === "mcp" && <McpPanel />}
      {tab === "rules" && <RulesCard />}
    </div>
  );
};

export default CapabilitiesPage;
