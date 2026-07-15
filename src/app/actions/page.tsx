"use client";

/**
 * 能力页（v1.0.x、用户拍板「skill / MCP / action 等能力集中一个页面配置」）
 *
 * 原 /actions 只管自定义 Action（V0.9）；现升级为「能力中心」、tab 切四块：
 *   - Action：推进动作（内置 + 自定义统一列表：拖拽排序 / 显隐 / 编辑 / 对话创建 / 导入导出）
 *   - Skill：技能（自管可增删改、可从 Cursor 导入、对话创建）
 *   - MCP：MCP servers（条目化管理 + 健康 / OAuth + 从 Cursor 导入）
 *   - Rules：规则
 * 设置页只留「设置」（凭据 / 模型 / 仓库 / 偏好 / 存储）、能力配置都在这。
 *
 * tab 状态走 ?tab=action|skills|mcp|rules（深链可用）。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, FileUp, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { useDialog } from "@/hooks/use-dialog";
import { useSettings } from "@/hooks/use-settings";
import { CustomActionEditor } from "@/components/custom-actions/custom-action-editor";
import { ActionLayoutConfig } from "@/components/custom-actions/action-layout-config";
import { McpCard } from "@/components/settings/mcp-card";
import { RulesCard } from "@/components/settings/rules-card";
import { SkillsCard } from "@/components/settings/skills-card";
import { setPendingSlashSkill, fetchSkills as fetchSlashSkills } from "@/components/slash-skills";
import {
  deleteCustomActionReq,
  exportCustomActionReq,
  fetchAppSkillsDir,
  fetchCustomActions,
  fetchSkills,
  importCustomActionBundleReq,
} from "@/lib/custom-action-client";
import { removeActionLayoutId } from "@/lib/action-layout";
import { getSettings, saveSettings } from "@/lib/local-store";
import { pickNativePaths } from "@/lib/native-picker";
import { createTask, sendChatReply } from "@/lib/task-store";
import type { CustomActionDef } from "@/lib/types";
import { saveDraft } from "@/lib/view-memory";

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
  // 自管 skills 目录（「对话创建」开对话当 cwd）
  const [appSkillsDir, setAppSkillsDir] = useState("");
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
  // 「对话创建」发起中（防双击）
  const [aiCreating, setAiCreating] = useState(false);
  // 正在转建的旧格式 action id（防双击；null = 无）
  const [convertingLegacyId, setConvertingLegacyId] = useState<string | null>(
    null,
  );
  // 正在查看原内容的旧格式 action（null = 关闭）
  const [viewingLegacy, setViewingLegacy] = useState<CustomActionDef | null>(
    null,
  );

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

  // 「对话创建」：cwd 锁自管 skills、自动挂 action-creator chip；
  // AI 先写纯方法论 SKILL.md，再调 create_custom_action 挂壳
  const handleAiCreate = async () => {
    const s = getSettings();
    if (!s.apiKey?.trim() || !s.defaultModel?.id?.trim()) {
      toast.error("先在设置页配好 API Key 和默认模型");
      return;
    }
    // action-creator 被关时 AI 拿不到创建规范、chip 也挂不上——提示而不是静默降级
    if (s.disabledSkills?.includes("action-creator")) {
      toast.error("action-creator skill 已被停用、先在 Skill tab 打开再用对话创建");
      return;
    }
    if (!appSkillsDir) {
      toast.error("skills 目录还没就绪、稍后重试");
      return;
    }
    setAiCreating(true);
    try {
      const task = await createTask({
        mode: "chat",
        title: "创建 action",
        repoPaths: [appSkillsDir],
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

  // 旧格式「转建新版」：同对话创建链路 + 自动提交首条（带 playbook 全文）；
  // 无 apiKey 时降级为建对话 + 草稿预填，不自动发
  const handleConvertLegacy = async (def: CustomActionDef) => {
    if (convertingLegacyId || !def.legacyPlaybook) return;
    const s = getSettings();
    if (s.disabledSkills?.includes("action-creator")) {
      toast.error("action-creator skill 已被停用、先在 Skill tab 打开再转建");
      return;
    }
    if (!appSkillsDir) {
      toast.error("skills 目录还没就绪、稍后重试");
      return;
    }

    const text = `把下面这个旧版自定义 action 转建成新版（skill + 挂载壳）。原 label：「${def.label}」。原 playbook 内容如下、提炼成纯方法论 skill（英文 kebab-case 目录名）并用 create_custom_action 挂壳（产出要求放 output 参数）：\n\n${def.legacyPlaybook}`;

    setConvertingLegacyId(def.id);
    // 终审 P3：createTask 成功但 sendChatReply 失败（409 等）时别只 toast——
    // 任务已建成、降级为草稿 + 导航过去让用户手动重发、不留孤儿空对话
    let createdTaskId: string | null = null;
    try {
      const task = await createTask({
        mode: "chat",
        title: `转建：${def.label}`,
        repoPaths: [appSkillsDir],
        model: s.defaultModel?.id?.trim() ? s.defaultModel : undefined,
        disabledMcpServers:
          s.disabledMcpServers && s.disabledMcpServers.length > 0
            ? s.disabledMcpServers
            : undefined,
      });
      createdTaskId = task.id;

      // 无 apiKey / 无默认模型 → 降级：草稿预填 + 挂 chip，用户配好后再发
      const canAutoSend =
        !!s.apiKey?.trim() && !!s.defaultModel?.id?.trim();
      if (!canAutoSend) {
        toast.error("先在设置页配好 API Key 和默认模型；已把转建说明写入草稿");
        saveDraft("reply", task.id, text);
        setPendingSlashSkill("action-creator");
        router.push(`/tasks/${task.id}`);
        return;
      }

      // 拉 action-creator absPath（slash-skills 模块缓存）；找不到则仍建对话 + 草稿
      const slashSkills = await fetchSlashSkills();
      const creator = slashSkills.find((x) => x.name === "action-creator");
      if (!creator) {
        toast.error("找不到 action-creator skill；已把转建说明写入草稿");
        saveDraft("reply", task.id, text);
        setPendingSlashSkill("action-creator");
        router.push(`/tasks/${task.id}`);
        return;
      }

      await sendChatReply(
        task.id,
        text,
        undefined,
        undefined,
        { apiKey: s.apiKey, model: s.defaultModel },
        [{ name: creator.name, absPath: creator.absPath }],
      );
      toast.success("已发起转建、AI 正在处理");
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (createdTaskId) {
        // 任务已建成、发送失败：草稿兜底 + 导航过去手动重发
        toast.error(`发送失败：${msg}；已把转建说明写入草稿、进对话后重发即可`);
        saveDraft("reply", createdTaskId, text);
        setPendingSlashSkill("action-creator");
        router.push(`/tasks/${createdTaskId}`);
      } else {
        toast.error(`转建失败：${msg}`);
      }
    } finally {
      setConvertingLegacyId(null);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // skill 集合 + 自管目录拉一次（目录给对话创建当 cwd）
  useEffect(() => {
    fetchSkills()
      .then((s) => setKnownSkills(new Set(s.map((x) => x.name))))
      .catch(() => setKnownSkills(null));
    fetchAppSkillsDir()
      .then(setAppSkillsDir)
      .catch(() => setAppSkillsDir(""));
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
    // skill 仅 app 源时可勾「同步删除」；内置 / 飞书不给勾（删不了）
    let syncSkillName: string | null = null;
    const skillName = def.skill?.trim();
    if (skillName) {
      try {
        const res = await fetch("/api/skills");
        if (res.ok) {
          const body = (await res.json()) as {
            skills?: Array<{ name: string; source: string }>;
          };
          const hit = (body.skills ?? []).find(
            (s) => s.name === skillName && s.source === "app",
          );
          if (hit) syncSkillName = hit.name;
        }
      } catch {
        // 拉 skills 失败不挡删 action、只是不出勾选
      }
    }

    let alsoDeleteSkill = false;
    if (syncSkillName) {
      const result = await confirm({
        title: `删除「${def.label}」？`,
        description:
          "用它跑过的历史任务不受影响、但之后不能再新推进这个 action。",
        destructive: true,
        checkboxLabel: `同时删除 skill「${syncSkillName}」`,
      });
      if (!result) return;
      alsoDeleteSkill = result.checked;
    } else {
      const ok = await confirm({
        title: `删除「${def.label}」？`,
        description:
          "用它跑过的历史任务不受影响、但之后不能再新推进这个 action。",
        destructive: true,
      });
      if (!ok) return;
    }

    try {
      await deleteCustomActionReq(def.id);
      // D10：同步清 actionLayout 里该 id 的 order/hidden 残留（不等拖拽时才 prune）
      const s = getSettings();
      const layout = s.actionLayout ?? { order: [], hidden: [] };
      const pruned = removeActionLayoutId(layout, def.id);
      if (
        pruned.order.length !== layout.order.length ||
        pruned.hidden.length !== layout.hidden.length
      ) {
        void saveSettings({ ...s, actionLayout: pruned });
      }
      setActions((prev) => prev.filter((a) => a.id !== def.id));

      if (alsoDeleteSkill && syncSkillName) {
        try {
          const delRes = await fetch(
            `/api/skills?name=${encodeURIComponent(syncSkillName)}`,
            { method: "DELETE" },
          );
          if (!delRes.ok) {
            let msg = `HTTP ${delRes.status}`;
            try {
              const body = (await delRes.json()) as { error?: string };
              if (body.error) msg = body.error;
            } catch {
              // ignore
            }
            toast.error(`action 已删，但删除 skill 失败：${msg}`);
            return;
          }
          toast.success("已删除 action 和 skill");
          return;
        } catch (err) {
          toast.error(
            `action 已删，但删除 skill 失败：${err instanceof Error ? err.message : err}`,
          );
          return;
        }
      }
      toast.success("已删除");
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    }
  };

  // 导出：原生 picker 选目标目录 → 拷主 skill 目录 + 写 .flowship-action.json
  const handleExport = async (def: CustomActionDef) => {
    if (transferring) return;
    const dirs = await pickNativePaths({
      mode: "folder",
      prompt: "选择导出目录",
    });
    if (!dirs?.[0]) return;
    setTransferring(true);
    try {
      const r = await exportCustomActionReq(def.id, dirs[0]);
      toast.success(`已导出到 ${r.skillDir}`);
    } catch (err) {
      toast.error(`导出失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTransferring(false);
    }
  };

  // 导入：原生 picker 选 skill 文件夹 → 拷进自管 skills → 有 .flowship-action.json 则挂壳
  const handleImport = async () => {
    if (transferring) return;
    const dirs = await pickNativePaths({
      mode: "folder",
      prompt: "选择要导入的 skill 文件夹（须含 SKILL.md）",
    });
    if (!dirs?.[0]) return;
    setTransferring(true);
    try {
      const r = await importCustomActionBundleReq(dirs[0]);
      if (r.action) {
        toast.success("已导入 skill 并挂成 action");
        void load();
      } else if (r.actionError) {
        toast.error(
          `已导入 skill「${r.skillName}」、挂壳失败：${r.actionError}`,
        );
      } else {
        toast.success("已导入 skill、未带挂载参数、可手动新建 action");
      }
      // 刷新 knownSkills、让行内 chips 立刻认新 skill
      fetchSkills()
        .then((s) => setKnownSkills(new Set(s.map((x) => x.name))))
        .catch(() => {});
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setTransferring(false);
    }
  };

  // 复制旧格式原内容（供用户拿去建 skill 后重新挂载）
  const handleCopyLegacy = async () => {
    if (!viewingLegacy?.legacyPlaybook) return;
    try {
      await navigator.clipboard.writeText(viewingLegacy.legacyPlaybook);
      toast.success("已复制");
    } catch (err) {
      toast.error(`复制失败：${err instanceof Error ? err.message : err}`);
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
    <div>
      {/* 面板工具行：说明 + 对话创建 / 导入 / 新建 */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          自定义 action = 把某个 skill 挂到任务链上跑；拖拽调顺序、开关控显隐
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleAiCreate()}
            disabled={aiCreating}
            title="开个对话、AI 按你的描述生成 skill 并挂成 action"
          >
            {aiCreating ? <Loader2 className="animate-spin" /> : <Sparkles />}
            对话创建
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleImport()}
            disabled={transferring}
            title="导入他人分享的 skill 包（可含 .flowship-action.json）"
          >
            {transferring ? <Loader2 className="animate-spin" /> : <FileUp />}
            导入
          </Button>
          <Button size="sm" onClick={handleNew}>
            <Plus />
            新建
          </Button>
        </div>
      </div>

      {/* 内置 + 自定义混排成一个列表统一管理：拖拽排序 + 显隐开关、自定义行额外可编辑 / 导出 / 删除 */}
      {loading ? (
        <LoadingState variant="card" />
      ) : (
        <ActionLayoutConfig
          customActions={actions}
          knownSkills={knownSkills}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onExport={(def) => void handleExport(def)}
          onViewLegacy={setViewingLegacy}
          onConvertLegacy={(def) => void handleConvertLegacy(def)}
          convertingLegacyId={convertingLegacyId}
        />
      )}

      <CustomActionEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        onSaved={handleSaved}
      />

      {/* 旧格式原内容查看（只读、纯展示——点外可关）；复制后自行建 skill 重新挂载 */}
      <Dialog
        open={!!viewingLegacy}
        onOpenChange={(o) => {
          if (!o) setViewingLegacy(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>「{viewingLegacy?.label}」原内容</DialogTitle>
            <DialogDescription>
              旧格式已停用——点「转建新版」让 AI 提炼，或复制后自行重建
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {viewingLegacy?.legacyPlaybook}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopyLegacy()}
            >
              <Copy />
              复制
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        {/* tab 行：切换能力面板 */}
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
