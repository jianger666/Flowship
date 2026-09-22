/** 启动提速契约：重活搬出启动窗口 + 零成本就绪探针 + 分阶段耗时日志。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const main = read("electron-app/main.js");
const bootNode = read("src/instrumentation-node.ts");
const warmup = read("src/lib/server/boot-warmup.ts");
const readyz = read("src/app/api/readyz/route.ts");
const warmupRoute = read("src/app/api/boot-warmup/route.ts");

describe("就绪探针零成本（不再轮询首页）", () => {
  it("/api/readyz 纯静态、无业务 import", () => {
    expect(readyz).toContain("NextResponse.json({ ok: true })");
    expect(readyz).not.toContain("@/");
    expect(readyz).not.toContain("force-dynamic");
  });

  it("主进程轮询 readyz、就绪后触发预热并记耗时", () => {
    expect(main).toContain("/api/readyz");
    expect(main).toContain("/api/boot-warmup");
    expect(main).toContain("server 就绪、轮询耗时");
  });
});

describe("重活搬出启动窗口（就绪后预热）", () => {
  it.each([
    "login-shell-path",
    "migrate-username-templates",
    "custom-action-fs",
    "preset-actions",
    "agent-shell",
    "team-library",
    "models-dev-catalog",
  ])("instrumentation 不再拉 %s", (mod) => {
    expect(bootNode).not.toContain(mod);
  });

  it.each([
    "login-shell-path",
    "migrate-username-templates",
    "custom-action-fs",
    "preset-actions",
    "agent-shell",
    "team-library",
    "models-dev-catalog",
  ])("预热模块接管 %s（迁移链串行不断）", (mod) => {
    expect(warmup).toContain(mod);
  });

  it("安全项仍在启动链（PATH pin + 密钥权限 + 异常兜底）", () => {
    expect(bootNode).toContain("injectFeishuCliPath");
    expect(bootNode).toContain("hardenConfigFilePerms");
    expect(bootNode).toContain("unhandledRejection");
  });

  it("预热路由动态执行（禁预渲染）+ 单例防重入", () => {
    expect(warmupRoute).toContain('force-dynamic');
    expect(warmupRoute).toContain("runBootWarmup");
    expect(warmup).toContain("isStarted()");
    expect(warmup).toContain("__flowshipBootWarmupStartedV1__");
  });

  it("分阶段耗时进日志（下版拿 Windows 日志定位下一瓶颈）", () => {
    expect(bootNode).toContain("[boot] instrumentation uptime=");
    expect(warmup).toContain("[boot] warmup start uptime=");
    expect(warmup).toContain("[boot] warmup dispatched in");
  });
});
