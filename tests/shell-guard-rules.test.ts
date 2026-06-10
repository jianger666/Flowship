/**
 * shell-guard 策略引擎单测（安全关键：拦截规则改坏 = 高危命令直通业务仓）
 *
 * 矩阵原则：每条规则至少 1 个「必拦」+ 1 个「必放」（防误伤）用例。
 */
import { describe, expect, it } from "vitest";

import { evaluateShellCommand } from "@/lib/server/shell-guard-rules";

const deny = (cmd: string, ruleName: string) => {
  const v = evaluateShellCommand(cmd);
  expect(v.verdict, `应拦截：${cmd}`).toBe("deny");
  expect(v.reason).toContain(`[shell-guard:${ruleName}]`);
};

const allow = (cmd: string) => {
  expect(evaluateShellCommand(cmd).verdict, `应放行：${cmd}`).toBe("allow");
};

describe("evaluateShellCommand", () => {
  it("空命令放行", () => {
    allow("");
    allow("   ");
  });

  it("auto-fix：拦 --fix / --write、不误伤 --fixture", () => {
    deny("pnpm eslint src --fix", "auto-fix");
    deny("ng lint --fix=true", "auto-fix");
    deny("prettier --write .", "auto-fix");
    allow("pnpm eslint src");
    allow("pnpm test --fixture=basic"); // 词边界：--fixture 不是 --fix
    allow("tsc --noEmit");
  });

  it("force-push：拦 -f / --force / --force-with-lease、豁免 __conflict 分支", () => {
    deny("git push -f origin feature/x", "force-push");
    deny("git push origin feature/x --force", "force-push");
    deny("git -C /repo push --force-with-lease origin x", "force-push");
    allow("git push origin feature/x");
    // ship 智能解冲突的一次性分支是唯一豁免
    allow("git push -f origin feature/x__conflict");
  });

  it("git-reset-hard：拦 reset --hard、放行 soft / 普通 reset", () => {
    deny("git reset --hard HEAD~1", "git-reset-hard");
    deny("git -C /repo reset --hard origin/test", "git-reset-hard");
    allow("git reset --soft HEAD~1");
    allow("git reset HEAD file.ts");
  });

  it("git-rebase：一律拦", () => {
    deny("git rebase origin/test", "git-rebase");
    deny("git -C /repo rebase -i HEAD~3", "git-rebase");
    allow("git merge origin/test");
  });

  it("git-clean：拦带 -f 的 clean", () => {
    deny("git clean -fd", "git-clean");
    deny("git clean -xdf", "git-clean");
    allow("git clean -n"); // dry-run 放行
  });

  it("dev-server：拦 dev / start / serve、放行一次性命令", () => {
    deny("pnpm dev", "dev-server");
    deny("npm run dev", "dev-server");
    deny("yarn start", "dev-server");
    allow("pnpm build");
    allow("pnpm typecheck");
    // 串联命令里藏 dev 也拦
    deny("pnpm install && pnpm dev", "dev-server");
  });

  it("watch-mode：拦 --watch / tail -f", () => {
    deny("vitest --watch", "watch-mode");
    deny("tail -f /var/log/app.log", "watch-mode");
    allow("vitest run");
    allow("tail -n 100 app.log");
  });

  it("global-install：拦 -g / --global", () => {
    deny("npm install -g typescript", "global-install");
    deny("pnpm add --global eslint", "global-install");
    allow("pnpm add -D vitest");
    allow("npm install");
  });
});
