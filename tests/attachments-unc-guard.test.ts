/**
 * 附件路径校验：UNC / 网络共享不能走到 fs.stat（评审 P2：Windows 上 stat UNC 会主动连 SMB 并带 NTLM 凭据）。
 * isAbsolutePathLike 把 UNC 也算绝对路径，所以必须在 stat 之前再过一道 nonLocalPathReason。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const statSpy = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: { ...actual.promises, stat: statSpy },
  };
});

import { parseAndValidateAttachments } from "@/lib/server/route-helpers";

describe("parseAndValidateAttachments：UNC 在 stat 之前被拒", () => {
  for (const unc of [
    "\\\\attacker\\share\\a.png",
    "//attacker/share/a.png",
    "\\/attacker/share/a.png",
    "file:////attacker/share/a.png",
  ]) {
    it(`拒绝 ${unc}，且从未调用 fs.stat`, async () => {
      statSpy.mockClear();
      const r = await parseAndValidateAttachments([unc], 5);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errorResponse.status).toBe(400);
        const body = (await r.errorResponse.json()) as { error: string };
        expect(body.error).toContain("网络共享");
      }
      expect(statSpy).not.toHaveBeenCalled();
    });
  }

  it("本机绝对路径照常 stat 放行", async () => {
    statSpy.mockReset();
    statSpy.mockResolvedValue({ isDirectory: () => false, isFile: () => true, size: 12 });
    const p = path.resolve("/tmp/flowship-a.txt");
    const r = await parseAndValidateAttachments([p], 5);
    expect(r.ok).toBe(true);
    expect(statSpy).toHaveBeenCalledTimes(1);
  });
});

describe("advance 路由里的内联校验同样先过 nonLocalPathReason", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/app/api/tasks/[id]/advance/route.ts"),
    "utf8",
  );
  it("nonLocalPathReason 在 fs.stat 之前", () => {
    const guard = src.indexOf("nonLocalPathReason(trimmed)");
    const stat = src.indexOf("await fs.stat(abs)");
    expect(guard).toBeGreaterThan(0);
    expect(stat).toBeGreaterThan(guard);
  });
});
