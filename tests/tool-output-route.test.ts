/**
 * GET /api/tasks/[id]/tool-output/[callId]
 *
 * 回归：SDK 子代理 callId 含换行（`call-…\nfc_…`）时，必须先 sanitize 再读盘，
 * 不能对原始 callId 做 isSafeId 误 400。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tool-output-route-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const { sanitizeCallIdForPath } = await import(
  "../src/lib/server/tool-result-persist"
);
const { GET } = await import(
  "../src/app/api/tasks/[id]/tool-output/[callId]/route"
);

const TASK_ID = "t_tool_output_route_1";

const writeFullOutput = async (callId: string, body: string) => {
  const safe = sanitizeCallIdForPath(callId);
  const dir = path.join(TMP_ROOT, "tasks", TASK_ID, "tool-outputs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safe}.txt`), body, "utf-8");
  return safe;
};

beforeEach(async () => {
  await fs.rm(path.join(TMP_ROOT, "tasks"), { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(path.join(TMP_ROOT, "tasks"), { recursive: true, force: true });
});

describe("GET tool-output", () => {
  it("子代理 callId 含换行 → 200 读到全量", async () => {
    const callId =
      "call-2db24248-f3ac-4b60-898b-341cc901ac7a-5\nfc_cfbdbf80-a56a-9c71-a13b-eb5c6f722724_5";
    const body = "FULL_OUTPUT_NEWLINE_CALLID\n" + "x".repeat(100);
    const safe = await writeFullOutput(callId, body);
    // 落盘文件名把 \n 换成 _
    expect(safe).toBe(
      "call-2db24248-f3ac-4b60-898b-341cc901ac7a-5_fc_cfbdbf80-a56a-9c71-a13b-eb5c6f722724_5",
    );

    const res = await GET(new Request("http://local/"), {
      params: Promise.resolve({ id: TASK_ID, callId }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("已消毒的 callId（fullPath basename）→ 200", async () => {
    const raw =
      "call-aaa\nfc_bbb";
    const body = "via-sanitized-id";
    const safe = await writeFullOutput(raw, body);

    const res = await GET(new Request("http://local/"), {
      params: Promise.resolve({ id: TASK_ID, callId: safe }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("文件不存在 → 404 not_found（供前端降级文案）", async () => {
    const res = await GET(new Request("http://local/"), {
      params: Promise.resolve({
        id: TASK_ID,
        callId: "call_missing_no_file",
      }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_found");
  });

  it("空 callId → 400", async () => {
    const res = await GET(new Request("http://local/"), {
      params: Promise.resolve({ id: TASK_ID, callId: "   " }),
    });
    expect(res.status).toBe(400);
  });
});
