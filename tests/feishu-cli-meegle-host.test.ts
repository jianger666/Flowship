/**
 * meegleHost 校验（评审 P2：原样写进 meegle 全局配置、完全不校验；设置页根本不传这个字段）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeMeegleHost } from "@/lib/server/feishu-cli";

describe("normalizeMeegleHost", () => {
  it("缺省 / 空白 → 默认飞书项目域名", () => {
    expect(normalizeMeegleHost(undefined)).toBe("project.feishu.cn");
    expect(normalizeMeegleHost(null)).toBe("project.feishu.cn");
    expect(normalizeMeegleHost("")).toBe("project.feishu.cn");
    expect(normalizeMeegleHost("   ")).toBe("project.feishu.cn");
  });

  it("白名单域名放行（容忍空白、https:// 前缀、末尾 /、大小写）", () => {
    expect(normalizeMeegleHost("project.feishu.cn")).toBe("project.feishu.cn");
    expect(normalizeMeegleHost(" project.larksuite.com ")).toBe("project.larksuite.com");
    expect(normalizeMeegleHost("https://project.feishu.cn/")).toBe("project.feishu.cn");
    expect(normalizeMeegleHost("PROJECT.Feishu.CN")).toBe("project.feishu.cn");
    expect(normalizeMeegleHost("a.b.larkoffice.com")).toBe("a.b.larkoffice.com");
    expect(normalizeMeegleHost("www.meegle.com")).toBe("www.meegle.com");
  });

  it("别的域名 / 冒充后缀 / 带端口 路径 用户信息 / 选项形态 / 非字符串 → null", () => {
    for (const bad of [
      "evil.example",
      "feishu.cn.evil.example",
      "evilfeishu.cn", // 不是 .feishu.cn 子域
      "feishu.cn", // 没有子域（裸后缀）
      "project.feishu.cn:8443",
      "project.feishu.cn/path",
      "http://project.feishu.cn", // 只认 https
      "user@project.feishu.cn",
      "--config=/tmp/x",
      "-project.feishu.cn",
      "project.feishu.cn evil.example",
      "project.feishu.cn\nevil",
      "127.0.0.1",
    ]) {
      expect(normalizeMeegleHost(bad), bad).toBeNull();
    }
    expect(normalizeMeegleHost(123)).toBeNull();
    expect(normalizeMeegleHost({})).toBeNull();
  });
});

describe("startLogin 接线（源码）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/lib/server/feishu-cli.ts"),
    "utf8",
  );
  it("host 校验在登记登录状态之前；config set 只用校验后的值", () => {
    const start = src.indexOf("export const startLogin = async (");
    const body = src.slice(start, src.indexOf("\n};\n", start));
    expect(body.indexOf("normalizeMeegleHost(opts.meegleHost)")).toBeGreaterThan(0);
    expect(body.indexOf("normalizeMeegleHost(opts.meegleHost)")).toBeLessThan(body.indexOf("logins.set(tool, state)"));
    expect(body).toContain("const host = meegleHost ?? DEFAULT_MEEGLE_HOST;");
    expect(body).not.toContain("opts.meegleHost?.trim()");
  });
});
