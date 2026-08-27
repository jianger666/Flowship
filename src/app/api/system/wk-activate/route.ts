/**
 * GET/POST /api/system/wk-activate
 *
 * 启动表单「激活项目」：读本机 Hub 是否就绪 + Owner 候选 + 飞书姓名预填；
 * POST 则走 Delivery Hub 内部激活接口，成功返回 REQ-ID。
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/server/route-helpers";
import {
  readWkActivateContext,
  runWkActivate,
  WkActivateError,
} from "@/lib/server/wk-activate";
import {
  type WkActivateInput,
  validateWkActivateInput,
} from "@/lib/wk-activate";

export const runtime = "nodejs";

export const GET = async () => {
  try {
    return NextResponse.json(await readWkActivateContext());
  } catch (err) {
    console.error("[GET /api/system/wk-activate] failed", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const POST = async (req: Request) => {
  let body: Partial<WkActivateInput>;
  try {
    body = (await req.json()) as Partial<WkActivateInput>;
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }

  const input: WkActivateInput = {
    projectUrl: readString(body.projectUrl),
    projectName: readString(body.projectName),
    semanticCode: readString(body.semanticCode),
    businessLine: readString(body.businessLine),
    plannedOnlineDate: readString(body.plannedOnlineDate),
    techOwner: readString(body.techOwner),
    techOwnerName: readString(body.techOwnerName) || undefined,
  };
  const invalid = validateWkActivateInput(input);
  if (invalid) return errorResponse(invalid);

  try {
    return NextResponse.json(await runWkActivate(input));
  } catch (err) {
    if (err instanceof WkActivateError) {
      return errorResponse(err.message, err.status);
    }
    console.error("[POST /api/system/wk-activate] failed", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
};
