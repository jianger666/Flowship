/**
 * POST /api/debug/scroll-probe
 *
 * 滚动抖动取证探针的服务端落盘口（2026-08-24 排查「事件流回滚后持续高频
 * 抖动」引入）。前端探针（lib/debug/scroll-probe.ts）检测到高频滚动后把
 * 逐帧样本批量 POST 过来，这里追加写到 <userData>/logs/scroll-probe.jsonl。
 *
 * 设计：
 * - **只追加、不阻塞**：写失败静默返回 ok:false——取证工具绝不能影响业务。
 * - **体积护栏**：单文件超 5MB 轮转成 .old（保留上一份），防长期开着开关撑爆盘。
 * - 日志随设置页「导出诊断包」自动带走（见 server/diagnostics.ts），用户无需
 *   自己找文件。
 *
 * Body: { label: string; samples: Array<{ t,st,sh,ch,src,stack? }> }
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { dataRoot } from "@/lib/server/data-root";

export const runtime = "nodejs";

const PROBE_LOG = path.join(dataRoot(), "..", "logs", "scroll-probe.jsonl");
/** 超过该体积轮转（5MB ≈ 几万条样本、够用好几天） */
const ROTATE_BYTES = 5 * 1024 * 1024;

interface ProbeSample {
  /** 客户端 epoch ms */
  t?: number;
  st?: number;
  sh?: number;
  ch?: number;
  src?: string;
  stack?: string;
}

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as {
      label?: unknown;
      samples?: unknown;
    };
    const label =
      typeof body.label === "string" ? body.label.slice(0, 64) : "unknown";
    if (!Array.isArray(body.samples) || body.samples.length === 0) {
      return NextResponse.json({ ok: false, error: "samples 必填" }, { status: 400 });
    }
    // 只收数字/短字符串字段、stack 截断——防脏数据 / 超大 payload 写坏日志
    const lines = (body.samples as ProbeSample[])
      .slice(0, 500)
      .map((s) =>
        JSON.stringify({
          srvT: Date.now(),
          label,
          t: typeof s.t === "number" ? s.t : undefined,
          st: typeof s.st === "number" ? Math.round(s.st) : undefined,
          sh: typeof s.sh === "number" ? s.sh : undefined,
          ch: typeof s.ch === "number" ? s.ch : undefined,
          src: s.src === "prog" || s.src === "native" ? s.src : "?",
          ...(typeof s.stack === "string"
            ? { stack: s.stack.slice(0, 800) }
            : {}),
        }),
      )
      .join("\n");

    await fs.mkdir(path.dirname(PROBE_LOG), { recursive: true });
    // 轮转：超限则把当前文件改名让位（保留一份旧的即可）
    try {
      const stat = await fs.stat(PROBE_LOG);
      if (stat.size > ROTATE_BYTES) {
        await fs.rename(PROBE_LOG, `${PROBE_LOG}.old`).catch(() => {});
      }
    } catch {
      /* 文件还不存在、正常 */
    }
    await fs.appendFile(PROBE_LOG, `${lines}\n`, "utf8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[scroll-probe] 落盘失败", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
