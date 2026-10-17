/**
 * GET /api/tasks/[id]/subagent-runs?key=…|callId=…[&rev=N]
 *
 * 子代理详情面板的数据源：一次子代理调用的**任务书全文 + 子代理自己的工作过程**
 * （thinking / 工具调用 / 回复，形状同主事件流的 TaskEvent，前端复用同一套渲染）。
 *
 * 为什么要单独存、单独取：子代理的内部过程从来不进主事件流（主流里只有一张 `task` 卡片：
 * 被截到 2000 字的 args + 最终产出），所以得在子代理跑的时候就旁路记一份（`subagent-transcript`）。
 *
 * # 入参
 * - `key`：记录 key（`sa_…`）——聊天框上方「子代理在后台工作」条用，来自 SSE 的 `background_subagents` 帧
 * - `callId`：主事件流里 `task` 卡片的 callId——事件流卡片用（服务端按 callId 绑定查到记录）
 * - 两个都给时 `key` 优先
 * - `rev`：客户端手上快照的版本号。跟服务端当前一致**且记录还在运行** → 只回 `{ ok, unchanged: true, rev }`，
 *   不回整份过程（轮询的绝大多数请求都命中这个，省流量也省前端重渲染）；终态一律回整份
 *   （重启后合成的 interrupted 沿用旧 rev，不能被 unchanged 吞掉）
 *
 * # 错误语义
 * - id / key / callId 形状不对 → 400
 * - 查不到 → 404（卡片可能比记录早：功能上线前的历史卡片、或记录已被保留策略清掉；
 *   前端会退回只展示卡片自带的任务书 / 产出）
 *
 * 任何响应都 no-store：运行中的内容每秒都在变，缓存只会让面板看起来卡住。
 */

import { getSubagentRunSnapshot } from "@/lib/server/subagent-transcript";
import { errorResponse } from "@/lib/server/route-helpers";
import { isSubagentRunTerminal } from "@/lib/subagent-run";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const runtime = "nodejs";

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);

/** callId 在 SDK 里常带换行 / 冒号等（`call-…\nfc_…`），这里只限长、不限字符：落盘前服务端会消毒 */
const CALL_ID_MAX = 300;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

export const GET = async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isSafeId(id)) return errorResponse("invalid_task_id", 400);

  const url = new URL(req.url);
  const key = url.searchParams.get("key")?.trim() || undefined;
  const callId = url.searchParams.get("callId") || undefined;
  if (!key && !callId) return errorResponse("missing_key_or_call_id", 400);
  if (key && !/^sa_[0-9a-f]{6,32}$/.test(key)) {
    return errorResponse("invalid_key", 400);
  }
  if (callId && (callId.length > CALL_ID_MAX || !callId.trim())) {
    return errorResponse("invalid_call_id", 400);
  }

  const snapshot = await getSubagentRunSnapshot(id, {
    ...(key ? { key } : {}),
    ...(!key && callId ? { callId } : {}),
  });
  if (!snapshot) return json({ error: "not_found" }, 404);

  const revRaw = url.searchParams.get("rev");
  const rev = revRaw !== null && revRaw !== "" ? Number(revRaw) : NaN;
  // 只对「还在运行」的快照回 unchanged：终态快照一律回整份。
  // 原因：客户端只在手上快照是运行中时才会带 rev 来轮询；服务端若给出终态（含重启后从磁盘读出、
  // 把写着 running 的记录改判成 interrupted——这种合成的终态沿用磁盘上的旧 rev，很可能恰好等于
  // 客户端手上那份运行中快照的 rev），回 unchanged 就等于把终态吞了，面板会一直显示「运行中」。
  // 终态只会被取一次（客户端拿到就停轮询），整份回去不增加流量。
  if (
    Number.isFinite(rev) &&
    rev === snapshot.rev &&
    !isSubagentRunTerminal(snapshot.meta.status)
  ) {
    return json({ ok: true, unchanged: true, rev: snapshot.rev });
  }
  return json({ ok: true, run: snapshot });
};
