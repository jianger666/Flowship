/**
 * kill-midtool e2e：GitLab mock 代理（响应前挂起 → 中途 abort → 放行 → 反查收敛）。
 *
 * 模拟「MR 建成瞬间 kill -9」：create POST 已到服务端（已建），客户端没收到响应。
 * 恢复时按 §5.1 表反查（GET source_branch=）→ 命中 → done，全程只 POST 一次。
 * 时机确定可重复，禁 sleep 掐点（用门控 promise + 服务端收到标记）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { buildWorkerIntentHandlers } from "../src/lib/server/worker-flip";

interface RecordedMR {
  source_branch: string;
  target_branch: string;
  title: string;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => resolve(s));
  });

describe("kill-midtool e2e（mock GitLab 代理）", () => {
  it("abort 在响应前 → 反查命中 → done，且只建一次", async () => {
    const mrs: RecordedMR[] = [];
    let postCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let receivedResolve!: () => void;
    const received = new Promise<void>((r) => { receivedResolve = r; });

    const server: Server = createServer(async (req, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST" && url.pathname.endsWith("/merge_requests")) {
        postCount += 1;
        const body = JSON.parse(await readBody(req)) as RecordedMR;
        // 服务端已建（crash 窗口的左侧），但响应前挂起。
        mrs.push(body);
        receivedResolve();
        await gate;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ web_url: "http://x/mr/1", iid: 1 }));
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/merge_requests")) {
        const sb = url.searchParams.get("source_branch");
        const hit = mrs.filter((m) => m.source_branch === sb);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(hit.map((m, i) => ({ web_url: "http://x/mr/1", iid: i + 1, source_branch: m.source_branch }))));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // 1. create POST 发出，服务端已建，客户端在响应前 abort（= kill -9）。
      const ctrl = new AbortController();
      const posting = fetch(`http://127.0.0.1:${port}/projects/g%2Fp/merge_requests`, {
        method: "POST",
        body: JSON.stringify({ source_branch: "feat", target_branch: "test", title: "t" }),
        signal: ctrl.signal,
      });
      await received;
      ctrl.abort();
      await expect(posting).rejects.toThrow();
      // 2. 放行服务端（它早已建好）。
      release();
      // 3. 恢复：handler 按 §5.1 反查 GET → 命中 → done，不再 POST。
      const handlers = buildWorkerIntentHandlers({
        payloadProvider: async () => ({
          projectPath: "g/p",
          sourceBranch: "feat",
          targetBranch: "test",
        }),
        findOpenMergeRequest: async ({ sourceBranch }) => {
          const res = await fetch(
            `http://127.0.0.1:${port}/projects/g%2Fp/merge_requests?source_branch=${sourceBranch}&state=opened`,
          );
          const list = (await res.json()) as unknown[];
          return { found: list.length > 0 };
        },
      });
      const out = await handlers["merge-request"]!({
        taskId: "t",
        actionId: "a",
        toolCallId: "c",
        kind: "merge-request",
        payloadHash: "h",
        status: "intent",
        idempotencyKey: "t:a:c",
        createdAt: 0,
        updatedAt: 0,
      });
      expect(out).toEqual({ verdict: "done" });
      expect(postCount).toBe(1);
    } finally {
      release();
      server.close();
    }
  });
});
