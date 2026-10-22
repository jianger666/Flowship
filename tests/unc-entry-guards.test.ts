/**
 * UNC 触发链的「同族入口」收口（第三轮 review R12-01…05）。
 *
 * 上一轮只给 4 个读文件路由加了 UNC 守卫，但同一条「一行 markdown 渲染即触发」的链还有别的口子：
 * - 渲染层 `/api/*` 原样放行 → `![](/api/repo-branches?path=//attacker/share/repo)` 渲染成同源 GET；
 * - `repo-branches` / `repo-remote-meta` / `skills?repos=` 明文接受 UNC 路径当 cwd / stat 目标；
 * - `open-in-ide`、`reveal-in-folder`（posix 上不拦）口径不一致。
 * Windows 上对 UNC 做 stat / spawn cwd 会让系统连 SMB 并带 NTLM 凭据。这里没有 Windows 真机，
 * 靠「谁都不该把 UNC 形态的路径递给文件系统 / git / spawn」的行为断言（mock 掉下游，断言**从未被调用**）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLoadableImageSrc } from "@/lib/local-image-src";
import {
  UNC_REJECT_MESSAGE,
  nonLocalPathReason,
  NON_LOCAL_PATH_MESSAGE,
  fileUrlHostHint,
  firstNonLocalRepoPath,
} from "@/lib/unc-path";

const listRepoBranches = vi.hoisted(() => vi.fn(async () => ({ ok: true, branches: [] })));
vi.mock("@/lib/server/git-branches", () => ({ listRepoBranches }));

const deriveHostFromRepo = vi.hoisted(() => vi.fn(async () => "gitlab.example.com"));
const deriveProjectPathFromRepo = vi.hoisted(() => vi.fn(async () => "g/p"));
vi.mock("@/lib/server/submit-mr-guard", () => ({ deriveHostFromRepo, deriveProjectPathFromRepo }));

const listSkillsWithSource = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/server/app-skills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/app-skills")>();
  return { ...actual, listSkillsWithSource, listCursorGlobalSkills: vi.fn(async () => []) };
});

const openInIde = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/server/ide-tools", () => ({ openInIde }));

const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    on(ev: string, cb: (code: number) => void) {
      if (ev === "exit") setTimeout(() => cb(0), 0);
      return this;
    },
    unref() {},
  })),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const UNC_FORMS = [
  "//attacker.example/share/repo",
  "\\\\attacker.example\\share\\repo",
  "\\/attacker.example/share/repo",
  "\\\\?\\UNC\\attacker.example\\share\\repo",
];

describe("第五轮 P4：`file://Users/x/y.png`（少写一个斜杠）拒绝时给改写提示，仍然拒", () => {
  it("file://host/… 形态：仍按 UNC 拒（不放行），文案在 UNC 提示后追加三斜杠写法", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const why = nonLocalPathReason("file://Users/x/y.png", platform);
      expect(why, platform).toContain(UNC_REJECT_MESSAGE);
      expect(why, platform).toContain("file:///Users/x/y.png");
      expect(why, platform).toContain("三个斜杠");
    }
  });

  it("其它 UNC 形态 / 正常路径：文案不变（不加提示），file:///Users/x 正常放行", () => {
    for (const p of [...UNC_FORMS, "file:////attacker/share/x", "//attacker/share/x"]) {
      expect(nonLocalPathReason(p, "darwin"), p).toBe(UNC_REJECT_MESSAGE);
      expect(fileUrlHostHint(p), p).toBeNull();
    }
    expect(nonLocalPathReason("file:///Users/x/y.png", "darwin")).toBeNull();
    expect(nonLocalPathReason("file://localhost/Users/x/y.png", "darwin")).toBeNull();
    expect(fileUrlHostHint("file://")).toBeNull();
    expect(fileUrlHostHint("/Users/x")).toBeNull();
  });

  it("第六轮 P4：`file://host\\share`（反斜杠，Windows 习惯的 UNC 写法）不给「三斜杠」提示——那只会误导；仍按 UNC 拒", () => {
    for (const p of ["file://host\\share\\repo", "file://attacker.example\\share"]) {
      expect(fileUrlHostHint(p), p).toBeNull();
      for (const platform of ["darwin", "linux", "win32"]) {
        expect(nonLocalPathReason(p, platform), `${platform} ${p}`).toBe(UNC_REJECT_MESSAGE);
      }
    }
    // 没有分隔符 / 第一个分隔符是 `/` 的旧行为不变（第七轮 R7-4：第六轮的正则一度把没有分隔符的 `file://Users` 也改成了不给提示，已还原）
    expect(fileUrlHostHint("file://Users")).toContain("file:///Users");
    expect(fileUrlHostHint("file://Users/x\\y")).toContain("file:///Users/x");
  });

  it("仓库登记入口的 reason 也带这条提示；超长路径截断", () => {
    const hit = firstNonLocalRepoPath(["/Users/ok/repo", "file://Users/me/repo"], "darwin");
    expect(hit?.path).toBe("file://Users/me/repo");
    expect(hit?.reason).toContain("file:///Users/me/repo");
    const long = `file://${"a".repeat(500)}/x`;
    expect(fileUrlHostHint(long)!.length).toBeLessThan(260);
  });
});

describe("nonLocalPathReason：白名单守卫（平台参数可注入，mac 上就能测 Windows 语义）", () => {
  it("任何平台：UNC / 设备命名空间形态 → 拒（UNC 提示）", () => {
    for (const p of [...UNC_FORMS, "file:////attacker/share/x", "  //attacker/share/x"]) {
      expect(nonLocalPathReason(p, "darwin"), p).toBe(UNC_REJECT_MESSAGE);
      expect(nonLocalPathReason(p, "linux"), p).toBe(UNC_REJECT_MESSAGE);
      expect(nonLocalPathReason(p, "win32"), p).toBe(UNC_REJECT_MESSAGE);
    }
  });

  it("posix：正常绝对路径、盘符形态、相对路径都不在这里拦（各路由自己校验绝对路径）", () => {
    for (const p of ["/Users/me/repo", "/tmp/a b/c", "C:\\Users\\me", "relative/x", "~/code"]) {
      expect(nonLocalPathReason(p, "darwin"), p).toBeNull();
      expect(nonLocalPathReason(p, "linux"), p).toBeNull();
    }
  });

  it("Windows：只放行盘符绝对路径 `^[A-Za-z]:[\\\\/]`（以及 file:///C:/…）", () => {
    for (const p of ["C:\\Users\\me\\a.png", "c:/Users/me/a.png", "D:\\x", "file:///C:/Users/me/a.png"]) {
      expect(nonLocalPathReason(p, "win32"), p).toBeNull();
    }
  });

  it("Windows：NT 对象命名空间 `\\??\\UNC\\…`、无盘符的根相对路径、盘相对路径、`/C:/…` 一律拒——不去赌它们的解析语义", () => {
    for (const p of [
      "\\??\\UNC\\attacker\\share\\a.png",
      "\\Windows\\System32",
      "/Users/me/a.png",
      "/C:/Users/me/a.png",
      "C:relative",
      "relative\\x",
      "",
    ]) {
      expect(nonLocalPathReason(p, "win32"), p).toBe(NON_LOCAL_PATH_MESSAGE);
    }
  });

  it("默认平台参数 = 当前平台（没传也不抛）", () => {
    expect(nonLocalPathReason("//attacker/share/x")).toBe(UNC_REJECT_MESSAGE);
  });
});

describe("toLoadableImageSrc 只原样放行两类站内路径（R12-01）", () => {
  it("/api/local-image? 与 /api/tasks/<id>/uploads/<文件> 原样", () => {
    expect(toLoadableImageSrc("/api/local-image?path=%2Ftmp%2Fa.png")).toBe(
      "/api/local-image?path=%2Ftmp%2Fa.png",
    );
    expect(toLoadableImageSrc("/api/tasks/t_1700_ab/uploads/a%20b.png")).toBe(
      "/api/tasks/t_1700_ab/uploads/a%20b.png",
    );
  });

  it("其它 /api/* 同族 GET 入口不再原样放行：被当成本地路径改写成 local-image 通道（服务端 404），而不是真去打那个 API", () => {
    for (const evil of [
      "/api/repo-branches?path=%2F%2Fattacker.example%2Fshare%2Frepo&refresh=1",
      "/api/repo-remote-meta?path=%2F%2Fattacker.example%2Fshare%2Frepo",
      "/api/skills?repos=%5B%22%2F%2Fattacker%22%5D",
      "/api/system/read-local-file?path=%2F%2Fattacker%2Fx",
      "/api/tasks",
      "/_next/static/x.png",
      "/uploads/a.png",
    ]) {
      const out = toLoadableImageSrc(evil);
      expect(out, evil).not.toBe(evil);
      expect(out.startsWith("/api/local-image?path="), evil).toBe(true);
      expect(decodeURIComponent(out.slice("/api/local-image?path=".length)), evil).toBe(evil);
    }
  });

  it("uploads 前缀不能被 `..` 段拐到别的 API（浏览器会把 /uploads/../../x 归一成 /api/x）", () => {
    for (const evil of [
      "/api/tasks/t1/uploads/../../repo-branches?path=%2F%2Fattacker",
      "/api/tasks/t1/uploads/%2e%2e/%2e%2e/repo-branches",
      "/api/tasks/t1/uploads/./../../skills",
      "/api/tasks/../uploads/a.png",
      "/api/tasks/t1/uploads/a/b.png",
      "/api/tasks/t1/uploads/",
    ]) {
      expect(toLoadableImageSrc(evil), evil).not.toBe(evil);
    }
  });

  it("file:// 前缀不能借「站内前缀」的名义原样放行", () => {
    const out = toLoadableImageSrc("file:///api/local-image?path=x");
    expect(out.startsWith("/api/local-image?path=")).toBe(true);
    expect(decodeURIComponent(out.slice("/api/local-image?path=".length))).toBe("/api/local-image?path=x");
  });

  it("UNC 仍然是空串（R12-03 的占位由组件负责）", () => {
    expect(toLoadableImageSrc("//attacker/share/a.png")).toBe("");
  });

  it("R12-04：file:///C:/… 去掉多余的前导斜杠，得到 Windows 能加载的盘符路径", () => {
    expect(toLoadableImageSrc("file:///C:/Users/me/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("C:/Users/me/a.png")}`,
    );
    expect(toLoadableImageSrc("file:///d:\\x\\a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("d:\\x\\a.png")}`,
    );
    // posix 的 file:///Users/… 不受影响
    expect(toLoadableImageSrc("file:///Users/me/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("/Users/me/a.png")}`,
    );
  });
});

describe("同族 GET 路由：UNC 在碰 git / fs 之前就 400（R12-01）", () => {
  it("repo-branches", async () => {
    const { GET } = await import("@/app/api/repo-branches/route");
    for (const p of UNC_FORMS) {
      const res = await GET(new Request(`http://127.0.0.1/api/repo-branches?path=${encodeURIComponent(p)}&refresh=1`));
      expect(res.status, p).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/UNC/);
    }
    expect(listRepoBranches).not.toHaveBeenCalled();
    // 对照：正常本机路径照常走到 listRepoBranches
    const ok = await GET(new Request(`http://127.0.0.1/api/repo-branches?path=${encodeURIComponent("/Users/me/repo")}`));
    expect(ok.status).toBe(200);
    expect(listRepoBranches).toHaveBeenCalledTimes(1);
  });

  it("repo-remote-meta：path / paths 里任何一个是 UNC → 整个请求 400，一个仓都不探测", async () => {
    const { GET } = await import("@/app/api/repo-remote-meta/route");
    for (const url of [
      `?path=${encodeURIComponent(UNC_FORMS[0])}`,
      `?path=${encodeURIComponent("/Users/me/repo")}&paths=${encodeURIComponent(`/Users/me/b,${UNC_FORMS[1]}`)}`,
      `?paths=${encodeURIComponent(UNC_FORMS[2])}`,
    ]) {
      const res = await GET(new Request(`http://127.0.0.1/api/repo-remote-meta${url}`));
      expect(res.status, url).toBe(400);
    }
    expect(deriveHostFromRepo).not.toHaveBeenCalled();
    expect(deriveProjectPathFromRepo).not.toHaveBeenCalled();
    const ok = await GET(new Request(`http://127.0.0.1/api/repo-remote-meta?path=${encodeURIComponent("/Users/me/repo")}`));
    expect(ok.status).toBe(200);
    expect(deriveHostFromRepo).toHaveBeenCalledTimes(1);
  });

  it("skills?repos=：UNC 条目被丢掉（不 stat 它），其余照常；响应里列出被拒的条目", async () => {
    const { GET } = await import("@/app/api/skills/route");
    const repos = JSON.stringify([UNC_FORMS[0], "/Users/me/repo", UNC_FORMS[1]]);
    const res = await GET(new Request(`http://127.0.0.1/api/skills?repos=${encodeURIComponent(repos)}`));
    expect(res.status).toBe(200);
    expect(listSkillsWithSource).toHaveBeenCalledTimes(1);
    expect(listSkillsWithSource).toHaveBeenCalledWith({ repoPaths: ["/Users/me/repo"] });
    const body = (await res.json()) as { rejectedRepos?: string[] };
    expect(body.rejectedRepos).toEqual([UNC_FORMS[0], UNC_FORMS[1]]);
  });

  it("skills?repos=：没有 UNC 时响应不多出 rejectedRepos 字段", async () => {
    const { GET } = await import("@/app/api/skills/route");
    const res = await GET(
      new Request(`http://127.0.0.1/api/skills?repos=${encodeURIComponent(JSON.stringify(["/Users/me/repo"]))}`),
    );
    expect(Object.keys((await res.json()) as object)).not.toContain("rejectedRepos");
  });
});

describe("open-in-ide / reveal-in-folder：UNC 与 open-path 同口径拒绝（R12-02）", () => {
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("open-in-ide：UNC → 400 且从未调用 openInIde；正常路径照常", async () => {
    const { POST } = await import("@/app/api/system/open-in-ide/route");
    for (const p of UNC_FORMS) {
      const res = await POST(post("http://127.0.0.1/api/system/open-in-ide", { ide: "idea", path: p, line: 3 }));
      expect(res.status, p).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/UNC/);
    }
    expect(openInIde).not.toHaveBeenCalled();
    const ok = await POST(post("http://127.0.0.1/api/system/open-in-ide", { ide: "idea", path: "/Users/me/A.java" }));
    expect(ok.status).toBe(200);
    expect(openInIde).toHaveBeenCalledTimes(1);
  });

  it("reveal-in-folder：posix 上也拒 UNC 形态（口径平台无关），且从未 spawn", async () => {
    const { POST } = await import("@/app/api/system/reveal-in-folder/route");
    for (const p of UNC_FORMS) {
      const res = await POST(post("http://127.0.0.1/api/system/reveal-in-folder", { path: p }));
      expect(res.status, p).toBe(400);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("R12-03：UNC 不再被静默吞掉（接线契约；组件在 jsx:preserve 下没法直接 import）", () => {
  const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("MarkdownImage：src 是 UNC 形态时渲染占位文案，而不是 return null", () => {
    const s = src("src/components/ui/image-preview.tsx");
    const at = s.indexOf("export const MarkdownImage");
    const body = s.slice(at, at + 1600);
    expect(body).toContain("isUncLikePath(src)");
    expect(body).toContain("[图片：网络路径不支持预览]");
    // 占位在 `if (!url)` 分支里、先于 return null
    expect(body.indexOf("isUncLikePath(src)")).toBeLessThan(body.indexOf("return null"));
  });

  it("MarkdownLink：UNC 形态的图片链接走纯文本 span 分支，不再进可点的灯箱按钮", () => {
    const s = src("src/components/markdown-link.tsx");
    expect(s).toMatch(/LOCAL_IMAGE\.test\(href\)\s*&&\s*!isUncLikePath\(href\)/);
  });
});
