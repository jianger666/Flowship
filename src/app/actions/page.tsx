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
import { ArrowLeft, Copy, Loader2, Plus, Sparkles } from "lucide-react";
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
import { UploadToTeamLibraryButton } from "@/components/settings/skills-panel/upload-to-team-library";
import { InstallTeamActions } from "@/components/custom-actions/install-team-actions";
import { setPendingSlashSkill, fetchSkills as fetchSlashSkills } from "@/components/slash-skills";
import {
  deleteCustomActionReq,
  fetchAppSkillsDir,
  fetchCustomActions,
} from "@/lib/custom-action-client";
import { removeActionLayoutId } from "@/lib/action-layout";
import { getSettings, saveSettings } from "@/lib/local-store";
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
  // 本机全部 skill 名（含已关闭自管；给行内缺失判定；null = 未拉到、不判定防误报）
  const [knownSkills, setKnownSkills] = useState<Set<string> | null>(null);
  // 自管源 skill 名集合（配合 settings.disabledSkills 标「skill 已关闭」）
  const [appSkillNames, setAppSkillNames] = useState<Set<string> | null>(null);
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
  // Action 内子 tab：我的列表 / 共享市场（默认我的）
  const [actionSubTab, setActionSubTab] = useState<"mine" | "market">("mine");

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
    // createTask 成功但 sendChatReply 失败（409 等）时别只 toast——
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

      const convertResult = await sendChatReply(
        task.id,
        text,
        undefined,
        undefined,
        { apiKey: s.apiKey, model: s.defaultModel },
        [{ name: creator.name, absPath: creator.absPath }],
      );
      // send 后落盘失败——不可忽略提示
      if (convertResult.persistWarning) {
        toast.error(
          `消息已送达但记录保存失败：${convertResult.persistWarning}`,
        );
      }
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

  // skill 全集（含关闭的自管）+ 自管目录拉一次（目录给对话创建当 cwd）
  // 不用 fetchSkills（它只返 enabled）——关闭的自管要标「skill 已关闭」而不是「缺失」
  useEffect(() => {
    void fetch("/api/skills", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as {
          skills?: Array<{ name?: string; source?: string }>;
        };
        const all = new Set<string>();
        const app = new Set<string>();
        for (const s of body.skills ?? []) {
          if (typeof s.name !== "string" || !s.name) continue;
          all.add(s.name);
          if (s.source === "app") app.add(s.name);
        }
        setKnownSkills(all);
        setAppSkillNames(app);
      })
      .catch(() => {
        setKnownSkills(null);
        setAppSkillNames(null);
      });
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
    // 派生 team action：删除 = 卸载对应共享库 skill（DELETE route 转卸载语义）
    if (def.origin === "team") {
      const ok = await confirm({
        title: `卸载「${def.label}」？`,
        description: "推进面板将移除此按钮，可到 Skill tab 重新安装",
        destructive: true,
        confirmLabel: "卸载",
      });
      if (!ok) return;
      try {
        await deleteCustomActionReq(def.id);
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
        // 成功：列表行消失自表达，不 toast
      } catch (err) {
        toast.error(
          `卸载失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // 自建（app-skill / 1:1）：二选一——仅移除推进入口 / 连 skill 一起删
    const skillName = def.skill?.trim() || "";
    const isAppHosted = def.origin === "app-skill" || !!skillName;

    if (isAppHosted && skillName && !def.legacyPlaybook) {
      const result = await confirm({
        title: `删除「${def.label}」？`,
        description: "默认仅移除推进入口；勾选则连同 skill 一起删",
        checkboxLabel: `同时删除 skill「${skillName}」`,
        destructive: true,
        confirmLabel: "删除",
      });
      if (!result) return;
      try {
        await deleteCustomActionReq(def.id, {
          withSkill: result.checked,
        });
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
        // 成功：列表行消失自表达；连删 skill 也无额外成功 toast（失败才 toast）
      } catch (err) {
        toast.error(
          `删除失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // legacy：只删旧 ACTION.md 目录
    const ok = await confirm({
      title: `删除「${def.label}」？`,
      description: "旧格式定义将被删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteCustomActionReq(def.id);
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
      // 成功：列表行消失自表达，不 toast
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    }
  };

  // 本地导入 / 导出已下线（2026-07-22 用户拍板：分发统一走共享库、不再需要本地文件包搬运）；
  // 恢复的话看 git 历史（handleImport / handleExport + exportCustomActionReq / importCustomActionBundleReq）。

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
      {/* Action 内子 tab：我的 = 本机列表；共享市场 = 可安装的共享 action */}
      <div className="mb-4 flex items-center gap-1">
        <ChoiceButton
          shape="tab"
          selected={actionSubTab === "mine"}
          onClick={() => setActionSubTab("mine")}
        >
          我的
        </ChoiceButton>
        <ChoiceButton
          shape="tab"
          selected={actionSubTab === "market"}
          onClick={() => setActionSubTab("market")}
        >
          共享市场
        </ChoiceButton>
      </div>

      {actionSubTab === "mine" && (
        <>
          {/* 工具行：说明 + 上传 / 对话创建 / 新建 */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              自定义 action = 把某个 skill 挂到任务链上跑；拖拽调顺序、开关控显隐
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <UploadToTeamLibraryButton mode="action" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleAiCreate()}
                disabled={aiCreating}
                title="开个对话、AI 按你的描述生成 skill 并挂成 action"
              >
                {aiCreating ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Sparkles />
                )}
                对话创建
              </Button>
              <Button size="sm" onClick={handleNew}>
                <Plus />
                新建
              </Button>
            </div>
          </div>

          {loading ? (
            <LoadingState variant="card" />
          ) : (
            <ActionLayoutConfig
              customActions={actions}
              knownSkills={knownSkills}
              appSkillNames={appSkillNames}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onViewLegacy={setViewingLegacy}
              onConvertLegacy={(def) => void handleConvertLegacy(def)}
              convertingLegacyId={convertingLegacyId}
            />
          )}
        </>
      )}

      {actionSubTab === "market" && (
        <InstallTeamActions onInstalled={() => void load()} />
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
    <div className="mx-auto max-w-5xl px-6 py-8">
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
