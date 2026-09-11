"use client";

/**
 * 任务页统一「跟 AI 说」输入条（V0.13.x 单一语义、事件流底部常驻）
 *
 * 客户端只有一条通道（submitTaskQuestion）、所有消息都是 [USER_MESSAGE]、
 * AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」
 * 上下文；会话断时服务端按 action 状态走唤醒 / 一次性临时 agent、客户端无感。
 *
 * v1.1.x 起视觉 / 交互统一走 <ConversationComposer>（chat 输入岛同一个组件）：贴图 / 附文件目录 /
 * `/` 唤起 skill / `@` 引用文件 / 顶边拖高；本文件只留业务态（发送通道 / 模型 / 禁用判定 /
 * 运行中停止键）。Cmd/Ctrl+J 聚焦。agent 正在跑时禁用发送、右侧换成 Composer 同款停止键；
 * 有未答提问时例外：输入条保持可发，回车顶掉这张卡（隐式跳过）。
 * 任务终态整条隐藏。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ConversationComposer } from "@/components/conversation-composer";
import { ComposerSessionProvider } from "@/components/composer-session";
import { buildInputHistory } from "@/lib/composer-history";
import { ModelSelect } from "@/components/ui/model-select";
import { useModels } from "@/hooks/use-models";
import { useRichInput } from "@/hooks/use-rich-input";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { getSettings } from "@/lib/local-store";
import {
  getModelCredsForProvider,
  hasModelCredsForProvider,
  resolveTaskProvider,
} from "@/lib/agent-provider";
import {
  modelSelectionKey,
  resolveSessionModel,
  talkForceModel,
} from "@/lib/task-model";
import { getPendingQuestionSend, submitTaskQuestion } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";
import {
  clearTalkOverride,
  loadTalkOverride,
  saveTalkOverride,
} from "@/lib/talk-model-override";

// 说话条手动选模型：粘住语义（用户选了 Gemini 就一直是 Gemini，直到用户再手动切、
// 切提供方、或推进链变了才跟上）。one-shot 问答不进 action 链、不改 action.agentModel，
// 所以不能像以前那样发完就重置回会话模型——否则每发一条都要重选一次。

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
  // 运行中停止：与顶栏共用同一 stopTask 通道（父组件持 confirm + stopping 锁）
  onStop?: () => void;
  // 停止请求飞行中——Composer 红方块键 disabled、防双击
  stopping?: boolean;
  // 父级锁存的 run 进行中状态（latch 到 done 才松、跨过 awaiting_ack 的流式窗口）
  runActive?: boolean;
}

export const TaskTalkComposer = ({
  task,
  onTaskUpdate,
  onStop,
  stopping = false,
  runActive = false,
}: Props) => {
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // 有未答提问时输入条保持可发（回车 = 隐式跳过这张卡），不要被 shell 阻塞画成停止键。
  const pendingAsk = findPendingAskEvent(task.events);
  const isRunning = runActive && !pendingAsk;
  const busy = submitting || isRunning;

  // 输入态整套（草稿 + skill + 图 + 路径附件 + 聚焦句柄）走公共 hook、跟 chat 输入岛同一份实现
  const rich = useRichInput({
    taskId: task.id,
    draft: { scope: "talk", id: task.id },
    maxImages: 6,
    disabled: busy,
  });

  // 展示模型：用户手动覆盖优先（粘住），否则跟当前推进实际在用的模型
  //（最近 action.agentModel → task.model）。action 链任何变化（新 action / 唤醒改模型，
  // 含同模型的新 action，上下文变了就跟新会话）或切提供方才清掉覆盖；
  // 单纯问答（one-shot，不改 actions、不改提供方）不清——不然每条都要重选。
  const [overrideModel, setOverrideModel] = useState<ModelSelection | null>(
    () => loadTalkOverride(task.id),
  );
  const sessionModel = resolveSessionModel(task) ?? { id: "" };
  const pickedModel = overrideModel ?? sessionModel;
  const handleModelChange = (next: ModelSelection): void => {
    // 选回跟会话一致 = 回到干净态（下次走会话复用）；否则记住覆盖
    if (
      !next.id.trim() ||
      modelSelectionKey(next) === modelSelectionKey(sessionModel)
    ) {
      setOverrideModel(null);
      saveTalkOverride(task.id, null);
    } else {
      setOverrideModel(next);
      saveTalkOverride(task.id, next);
    }
  };
  // 会话归属签名：action 链（currentActionId + 每个 action 的模型指纹）+ 提供方。
  // 单纯问答只加 events，签名不变；新推进 / 唤醒改模型 / 切提供方（清锚点）签名必变。
  // 拼之前按 n 排序：签名只跟内容有关、跟服务端返回顺序无关（防乱序误清覆盖）。
  // n 缺失按 0、同 n 按 id 二次比较——排序永不退化成输入顺序。
  const actionSig = useMemo(
    () =>
      `${task.provider ?? ""}|${task.sessionAgentId ?? ""}|${task.currentActionId ?? ""}|${[...task.actions]
        .sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(
          (a) =>
            `${a.id}:${a.n}:${modelSelectionKey(a.agentModel)}`,
        )
        .join(",")}`,
    [task.actions, task.currentActionId, task.provider, task.sessionAgentId],
  );
  const actionSigRef = useRef(actionSig);
  const taskIdRef = useRef(task.id);
  useEffect(() => {
    // 切任务：换载对应任务的覆盖
    if (taskIdRef.current !== task.id) {
      taskIdRef.current = task.id;
      actionSigRef.current = actionSig;
      setOverrideModel(loadTalkOverride(task.id));
      return;
    }
    // 同一任务里签名变了 = 推进换了 action / 唤醒改了模型 / 切了提供方，跟上新会话
    if (actionSigRef.current !== actionSig) {
      actionSigRef.current = actionSig;
      setOverrideModel(null);
      clearTalkOverride(task.id);
    }
  }, [task.id, actionSig]);
  const { models, fetchModels } = useModels();
  useEffect(() => {
    const s = getSettings();
    const providerId = resolveTaskProvider(task, s);
    if (hasModelCredsForProvider(s, providerId) && models.length === 0) {
      void fetchModels({
        ...getModelCredsForProvider(s, providerId),
        provider: providerId,
      });
    }
  }, [models.length, fetchModels, task]);

  // 切 task 时整条输入态换载对应任务的持久化（详情页在不同任务间导航时组件可能不重挂）。
  // restore() 读回正文草稿 + 图/路径快照：各任务的输入互不串（key 按 task 隔离），
  // 切走的任务的内容留在快照里、切回来还在；只有发送成功才真正清空（rich.reset）。
  const restoreDraft = rich.restore;
  useEffect(() => {
    restoreDraft();
  }, [task.id, restoreDraft]);

  // 跨挂载认领：在飞的发送不随卸载取消（fetch 继续跑、回调闭包留在旧实例）。
  // 回来后重新挂上回调：显示 submitting + 落 onTaskUpdate；草稿里还是原文
  // （用户没写新东西）才清输入框，否则留着用户新敲的字。
  const onTaskUpdateRef = useRef(onTaskUpdate);
  onTaskUpdateRef.current = onTaskUpdate;
  const valueRef = useRef(rich.value);
  valueRef.current = rich.value;
  const resetRef = useRef(rich.reset);
  resetRef.current = rich.reset;
  useEffect(() => {
    const pending = getPendingQuestionSend(task.id);
    if (!pending) return;
    setSubmitting(true);
    let alive = true;
    void pending.promise.then(
      (result) => {
        if (!alive) return;
        if (result.persistWarning) {
          toast.error(
            `消息已送达但记录保存失败：${result.persistWarning}`,
          );
        }
        onTaskUpdateRef.current(result.task);
        if (valueRef.current === pending.text) resetRef.current();
        // 粘住语义：不重置覆盖。action 链变了上面的 actionSig effect 会自己跟上。
      },
      (err: unknown) => {
        if (!alive) return;
        toast.error(err instanceof Error ? err.message : String(err));
      },
    ).finally(() => {
      if (alive) setSubmitting(false);
    });
    return () => {
      alive = false;
    };
    // 只在挂载 / 切任务时认领一次：在飞 promise 同一班次内引用稳定
  }, [task.id]);

  // Cmd/Ctrl+J 聚焦输入条（沿用原「再聊聊」快捷键、入口合一后指到这里）
  const focusInput = rich.focus;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      focusInput();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusInput]);

  // @ / ↑ 历史：task 模式也复用同一 ComposerSession
  const composerSession = useMemo(
    () => ({
      taskId: task.id,
      repoPaths: task.repoPaths,
      inputHistory: buildInputHistory(task.events),
    }),
    [task.id, task.repoPaths, task.events],
  );

  // 有未答提问 → placeholder 轻提示去答题卡；**不禁输入**（同事踩坑：网断 /
  // 会话死后答题卡变 isStale 引导「用底部输入条唤醒」，但这里曾把 awaitingAnswer
  // 绑进 disabled，和 isStale 对锁、只能重新推进）。
  // runStatus=error / action 停摆：提问已没人接，placeholder 也不再指路答题。
  const halted =
    task.runStatus === "error" ||
    task.actions.some(
      (a) =>
        a.id === task.currentActionId &&
        (a.status === "error" || a.status === "cancelled"),
    );
  // 跟详情页 awaitingAskAnswer 同口径：只有「还在等回复」才指路答题卡。
  // 24h 超时后卡已过期，findPendingAskEvent 变 null，别再写「可先答上方提问」。
  // 同一轮 curl 阻塞时 runStatus 仍是 running，不能再绑 awaiting_user。
  const awaitingAnswer = !halted && !!pendingAsk;

  const handleSubmit = async () => {
    if (!rich.hasContent || busy) return;
    // 跨挂载去重：上一条还在飞时拒掉（submitTaskQuestion 内有同款前置兜底、这里先给轻提示）
    if (getPendingQuestionSend(task.id)) {
      toast.error("上一条消息还在发送中、稍等它发完再发");
      return;
    }
    setSubmitting(true);
    try {
      // V0.13.x 统一消息通道（用户拍板「别这么多分支」）：全部走 question route、
      // AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」上下文。
      // skill 指引不拼进 text——独立字段传服务端，气泡只显示用户原文
      const { text, images, attachments, skillRefs } = rich.payload();
      const result = await submitTaskQuestion(
        task,
        text,
        images,
        talkForceModel(pickedModel, resolveSessionModel(task)),
        attachments,
        skillRefs,
      );
      // send 后落盘失败——不可忽略提示
      if (result.persistWarning) {
        toast.error(
          `消息已送达但记录保存失败：${result.persistWarning}`,
        );
      }
      onTaskUpdate(result.task);
      rich.reset();
      // 粘住语义：one-shot 问答不改 actions，覆盖留着下条继续用；
      // 唤醒改了 action 模型的，actionSig effect 会清覆盖跟上新会话。
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 终态没有可说的对象、整条隐藏
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return null;
  }

  return (
    <ComposerSessionProvider value={composerSession}>
      <div className="border-t px-3 py-2">
        <ConversationComposer
          {...rich.bind}
          editorKey={task.id}
          onSubmit={() => void handleSubmit()}
          placeholder={
            awaitingAnswer
              ? "可先答上方提问，也可在此继续说"
              : "想改、想问、贴图、/ 唤起 skill、@ 引用文件（⌘/Ctrl+J）"
          }
          disabled={busy}
          submitting={submitting}
          leading={
            <ModelSelect
              models={models}
              selection={pickedModel}
              onChange={handleModelChange}
              disabled={busy}
              variant="compact"
              emptyPlaceholder="选择模型"
              providerId={resolveTaskProvider(task, getSettings())}
              onOpenChange={(open) => {
                if (!open) return;
                const s = getSettings();
                const providerId = resolveTaskProvider(task, s);
                if (
                  hasModelCredsForProvider(s, providerId) &&
                  models.length === 0
                ) {
                  void fetchModels({
                    ...getModelCredsForProvider(s, providerId),
                    provider: providerId,
                  });
                }
              }}
            />
          }
          // 运行中：右侧动作组原地换成 spinner + 红停止键（Composer 同款、与 chat 对齐；无排队）
          running={isRunning}
          onStop={onStop}
          stopping={stopping}
        />
      </div>
    </ComposerSessionProvider>
  );
};
