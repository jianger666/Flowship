/**
 * 定时任务的前端请求封装（会话内定时条 / 管理页共用）。
 * 服务端路由见 `src/app/api/schedules` 与 `src/app/api/tasks/[id]/schedules`。
 */
import type {
  ScheduleListItem,
  ScheduleRecord,
  ScheduleUserAction,
} from "@/lib/schedule";

export type ScheduleAction = ScheduleUserAction;

const readError = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* 不是 JSON */
  }
  return `HTTP ${res.status}`;
};

export const fetchTaskSchedules = async (
  taskId: string,
  signal?: AbortSignal,
): Promise<ScheduleRecord[]> => {
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/schedules`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { schedules?: ScheduleRecord[] };
  return Array.isArray(body.schedules) ? body.schedules : [];
};

export const fetchAllSchedules = async (signal?: AbortSignal): Promise<ScheduleListItem[]> => {
  const res = await fetch("/api/schedules", { cache: "no-store", signal });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { schedules?: ScheduleListItem[] };
  return Array.isArray(body.schedules) ? body.schedules : [];
};

/** `fire` 的结果：delivered = 已送进会话；retry = 会话这会儿接不了，之后自动送达；failed = 送不进 */
export type ScheduleFireOutcome = "delivered" | "retry" | "failed";

export const runScheduleAction = async (
  taskId: string,
  scheduleId: string,
  action: ScheduleAction,
): Promise<{ schedule: ScheduleRecord; outcome?: ScheduleFireOutcome }> => {
  const res = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { schedule: ScheduleRecord; outcome?: ScheduleFireOutcome };
};
