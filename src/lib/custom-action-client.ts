/**
 * 自定义 action 的客户端 fetch 封装（V0.9）
 *
 * 列表页 / 编辑器 / 推进 dialog 共用、错误归一成 Error(message)（调用方 try/catch + toast）。
 * 不在组件里裸 fetch + JSON.parse + 错误拼接（对齐 task-store 的 handleJson 约定）。
 */

import type { CustomActionDef, CustomActionInput } from "@/lib/types";

/** 可勾选的 skill（/api/skills 返回、只 name + description） */
export interface SkillOption {
  name: string;
  description: string;
}

// 统一解析响应 + 抛错（res.ok 检查 + 取 error 字段拼消息）
const handleJson = async <T>(res: Response): Promise<T> => {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 无 body / 非 JSON、保持 null
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return body as T;
};

export const fetchCustomActions = async (): Promise<CustomActionDef[]> => {
  const res = await fetch("/api/custom-actions");
  const { actions } = await handleJson<{ actions: CustomActionDef[] }>(res);
  return actions;
};

/** 列表 + 存储目录路径（能力页用：目录给「AI 帮建」开对话当 cwd） */
export const fetchCustomActionsWithDir = async (): Promise<{
  actions: CustomActionDef[];
  dir: string;
}> => {
  const res = await fetch("/api/custom-actions");
  const { actions, customActionsDir } = await handleJson<{
    actions: CustomActionDef[];
    customActionsDir?: string;
  }>(res);
  return { actions, dir: customActionsDir ?? "" };
};

export const createCustomActionReq = async (
  input: CustomActionInput,
): Promise<CustomActionDef> => {
  const res = await fetch("/api/custom-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const { action } = await handleJson<{ action: CustomActionDef }>(res);
  return action;
};

export const updateCustomActionReq = async (
  id: string,
  patch: Partial<CustomActionInput>,
): Promise<CustomActionDef> => {
  const res = await fetch(`/api/custom-actions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const { action } = await handleJson<{ action: CustomActionDef }>(res);
  return action;
};

export const deleteCustomActionReq = async (id: string): Promise<void> => {
  const res = await fetch(`/api/custom-actions/${id}`, { method: "DELETE" });
  await handleJson<{ ok: true }>(res);
};

export const fetchSkills = async (): Promise<SkillOption[]> => {
  const res = await fetch("/api/skills");
  const { skills } = await handleJson<{ skills: SkillOption[] }>(res);
  return skills;
};

/** 导入结果（服务端逐文件处理、失败的带原因给 toast 汇总） */
export interface ImportActionsResult {
  imported: CustomActionDef[];
  failed: { path: string; reason: string }[];
}

export const importCustomActionsReq = async (
  dir: string,
): Promise<ImportActionsResult> => {
  const res = await fetch("/api/custom-actions/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return handleJson<ImportActionsResult>(res);
};

/** 导出结果（每个成功项带写入的文件绝对路径） */
export interface ExportActionsResult {
  exported: { id: string; file: string }[];
  failed: { id: string; reason: string }[];
}

export const exportCustomActionsReq = async (
  ids: string[],
  dir: string,
): Promise<ExportActionsResult> => {
  const res = await fetch("/api/custom-actions/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, dir }),
  });
  return handleJson<ExportActionsResult>(res);
};
