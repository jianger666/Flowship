/**
 * 自定义 action 的客户端 fetch 封装
 *
 * 列表页 / 编辑器 / 推进 dialog 共用、错误归一成 Error(message)（调用方 try/catch + toast）。
 */

import type { CustomActionDef, CustomActionInput } from "@/lib/types";

/** 可勾选的 skill（/api/skills 返回、只 name + description；调用方只列 enabled） */
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

/** 拉可用 skill（只返回 enabled=true、给主 skill 下拉 / 附加多选） */
export const fetchSkills = async (): Promise<SkillOption[]> => {
  const res = await fetch("/api/skills");
  const { skills } = await handleJson<{
    skills: Array<SkillOption & { enabled?: boolean }>;
  }>(res);
  return (skills ?? [])
    .filter((s) => s.enabled !== false)
    .map(({ name, description }) => ({ name, description }));
};
