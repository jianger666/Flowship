/**
 * 共享合并 hook（useMergeMr）的行为测试：取消确认 / 成功 / 已合并过 / 失败 / 双击 / 解锁（Q10-05 前端去重）。
 *
 * 仓里没有 jsdom：用 renderToStaticMarkup 渲染一个探针组件，把 hook 返回的 merge 取出来——服务端渲染里
 * useRef / useCallback 都可用；渲染结束后再调 merge()，里面的 setState 在服务端是空操作
 * （React 的服务端渲染器：组件已返回之后的更新 = no-op）。所以这里测的是「逻辑」：确认框弹几次、请求发几次、
 * 提示说什么、锁什么时候放；「转圈 / 按钮 disabled」这类渲染态仍只有源码契约（mr-inbox-messages.test.ts）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  mergeMr: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/hooks/use-dialog", () => ({
  useDialog: () => ({ confirm: h.confirm }),
}));
vi.mock("@/hooks/use-mr-inbox", () => ({
  useMrInbox: () => ({ mergeMr: h.mergeMr }),
}));
vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

import { useMergeMr, type MergeMrTarget } from "@/hooks/use-merge-mr";

/** 每次 mount = 一行（待测 MR 行 / 待回归行各自调一次 useMergeMr，互不共享闸） */
const mountHook = (): ((t: MergeMrTarget) => Promise<void>) => {
  const box: { merge?: (t: MergeMrTarget) => Promise<void> } = {};
  const Probe = () => {
    box.merge = useMergeMr().merge;
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  if (!box.merge) throw new Error("探针没拿到 merge");
  return box.merge;
};

const target: MergeMrTarget = {
  mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/7",
  title: "feat: 加个功能",
  sourceBranch: "feat",
  targetBranch: "test",
  headSha: "abc1234",
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * 真实时钟：ms 内没落定就失败并说清原因——比等 vitest 的 5 秒超时好：
 * vitest 的超时在 JSON / 部分 reporter 里只剩一个占位栈（Error: STACK_TRACE_ERROR），看不出是谁卡住了。
 */
const settled = async <T>(p: Promise<T>, what: string, ms = 4000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}：${ms}ms 内没有返回（在等不该等的东西：定时器 / 在途任务）`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, stuck]);
  } finally {
    clearTimeout(timer);
  }
};

beforeEach(() => {
  h.confirm.mockReset();
  h.mergeMr.mockReset();
  h.success.mockReset();
  h.error.mockReset();
  h.mergeMr.mockResolvedValue({ alreadyMerged: false });
});

describe("确认框", () => {
  it("内容：标题、「描述 = MR 标题（源分支 → 目标分支）」、确认按钮文字", async () => {
    h.confirm.mockResolvedValue(false);
    await mountHook()(target);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm).toHaveBeenCalledWith({
      title: "合并这个 MR？",
      description: "feat: 加个功能（feat → test）",
      confirmLabel: "合并",
    });
  });

  it("点了取消：不发合并请求、不弹任何提示", async () => {
    h.confirm.mockResolvedValue(false);
    await mountHook()(target);
    expect(h.mergeMr).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });
});

describe("发请求与提示", () => {
  it("确认后：带 mrUrl 与扫描那一刻的 headSha 发一次请求；成功说「MR 已合并」", async () => {
    h.confirm.mockResolvedValue(true);
    await mountHook()(target);
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
    expect(h.mergeMr).toHaveBeenCalledWith(target.mrUrl, "abc1234");
    expect(h.success).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith("MR 已合并");
    expect(h.error).not.toHaveBeenCalled();
  });

  it("没有 headSha（扫描时 GitLab 没给）：sha 参数就是 undefined，不是空串 / 字符串 undefined", async () => {
    h.confirm.mockResolvedValue(true);
    await mountHook()({ ...target, headSha: undefined });
    expect(h.mergeMr).toHaveBeenCalledWith(target.mrUrl, undefined);
  });

  it("已经合并过（双击 / 两个窗口 / 别人先合了）：换一句更准的话", async () => {
    h.confirm.mockResolvedValue(true);
    h.mergeMr.mockResolvedValue({ alreadyMerged: true });
    await mountHook()(target);
    expect(h.success).toHaveBeenCalledWith("该 MR 已经合并过了，已为你更新列表");
    expect(h.error).not.toHaveBeenCalled();
  });

  it("失败：toast.error「合并失败：原因」，不弹成功；抛的不是 Error 也转成字符串", async () => {
    h.confirm.mockResolvedValue(true);
    h.mergeMr.mockRejectedValueOnce(
      new Error("405 Method Not Allowed（有冲突，先解决冲突）"),
    );
    await mountHook()(target);
    expect(h.error).toHaveBeenCalledWith(
      "合并失败：405 Method Not Allowed（有冲突，先解决冲突）",
    );
    expect(h.success).not.toHaveBeenCalled();

    h.error.mockReset();
    h.mergeMr.mockRejectedValueOnce("网络挂了");
    await mountHook()(target);
    expect(h.error).toHaveBeenCalledWith("合并失败：网络挂了");
  });
});

describe("防重入（同一行）", () => {
  it("双击：确认框还开着时第二下被同步闸挡住——只弹一个确认框、只发一次请求", async () => {
    const dialog = deferred<boolean>();
    h.confirm.mockReturnValue(dialog.promise);
    const merge = mountHook();

    const first = merge(target);
    const second = merge(target); // 同步紧跟着的第二下（React 的 disabled 还没来得及生效）
    await settled(second, "被挡住的第二下点击（它不该等确认框）"); // 被挡住的那一下立刻返回，不等确认框
    expect(h.confirm).toHaveBeenCalledTimes(1);

    dialog.resolve(true);
    await first;
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledTimes(1);
  });

  it("请求进行中再点：同样被挡住（不会发第二个合并请求）", async () => {
    const request = deferred<{ alreadyMerged: boolean }>();
    h.confirm.mockResolvedValue(true);
    h.mergeMr.mockReturnValue(request.promise);
    const merge = mountHook();

    const first = merge(target);
    await vi.waitFor(() => expect(h.mergeMr).toHaveBeenCalledTimes(1));
    await settled(merge(target), "请求进行中的再点一下（它不该等请求）"); // 请求还没回来
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.mergeMr).toHaveBeenCalledTimes(1);

    request.resolve({ alreadyMerged: false });
    await first;
    expect(h.success).toHaveBeenCalledTimes(1);
  });

  it("每一行各有一把闸：一行的确认框开着，另一行照常能合并", async () => {
    const dialog = deferred<boolean>();
    h.confirm.mockReturnValueOnce(dialog.promise).mockResolvedValue(true);
    const rowA = mountHook();
    const rowB = mountHook();

    const a = rowA(target);
    await rowB({ ...target, mrUrl: "https://gitlab.example.com/g/r/-/merge_requests/8" });
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
    expect(h.mergeMr).toHaveBeenCalledWith(
      "https://gitlab.example.com/g/r/-/merge_requests/8",
      "abc1234",
    );

    dialog.resolve(false);
    await a;
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
  });
});

describe("解锁：每一种结束方式之后，下一次点击都要能再弹确认框", () => {
  it("取消之后", async () => {
    h.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const merge = mountHook();
    await merge(target);
    await merge(target);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
  });

  it("合并成功之后", async () => {
    h.confirm.mockResolvedValue(true);
    const merge = mountHook();
    await merge(target);
    await merge(target);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.mergeMr).toHaveBeenCalledTimes(2);
  });

  it("合并失败之后（用户要重试）", async () => {
    h.confirm.mockResolvedValue(true);
    h.mergeMr.mockRejectedValueOnce(new Error("boom"));
    const merge = mountHook();
    await merge(target);
    await merge(target);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.mergeMr).toHaveBeenCalledTimes(2);
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledTimes(1);
  });

  it("确认框本身抛错（比如组件被卸载）：merge 把错误往外抛，但锁照样放", async () => {
    h.confirm.mockRejectedValueOnce(new Error("dialog gone")).mockResolvedValueOnce(true);
    const merge = mountHook();
    await expect(merge(target)).rejects.toThrow("dialog gone");
    await merge(target);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.mergeMr).toHaveBeenCalledTimes(1);
  });
});
