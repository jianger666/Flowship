/**
 * R14 B6-4 终审补的缺口：审查 AI 独立变异（组 K）里存活的那些——B6-4 自己的 100 个变异没点到的口径。
 *
 *  ① MarkdownImage：点开大图时交给灯箱的整份数据（src / alt / title）、悬浮提示取 title 还是 alt、`<img loading="lazy">`。
 *     B6-4 在 HANDOFF 里自己承认这两处没覆盖（SSR 看不到 Tooltip 内容；react-hook-stub 不支持 useContext，驱动不了 open）。
 *     这里用「只实现 useContext 的最小桩」直接跑组件函数体，取元素树上的处理器真调。
 *     （P9）外层已是链接 / 按钮时 MarkdownImage 退回改前的 `<img onClick>`（不套 button），那一路的点击数据同样要钉：
 *     桩按上下文对象识别「外层是链接」那个上下文，切换给它的值，两条分支各跑各的。
 *  ② ImagePreviewProvider：open(images, index) → 灯箱拿到的 images / index → 左右切（环形）→ 关闭。
 *     契约只钉了「灯箱有哪些 prop」，没钉每个 prop 的「值」：index 写死 0、只传第一张、onGo 接成关闭 / 空函数都过得去。
 *     这里用 helpers/react-hook-stub 的槽位桩让 Provider 的 state 真跑起来。
 *  ③ 公司环境卡的 7 个删除键：名字里的「第 N 项（环境）」必须取自「当前这一行」。
 *     原契约只钉了类型名，没钉实参——序号写死 0（每张卡都叫「第 1 项」）、环境实参换成别的字段都过得去。
 *     用 TypeScript AST：每个 removeInstanceLabel(kind, idx, env) 调用，idx 必须是外层 .map 回调的下标变量、
 *     env 必须是同一回调里那一行自己的 `.env`。附一个对合成源码的自检，防止扫描器空转。
 *
 * 本仓没有 jsdom：真机读屏读什么、灯箱里真点箭头，无法在 CI 验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import React, { type ComponentProps, type ReactElement } from "react";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  ImageLightbox,
  ImagePreviewProvider,
  InsideInteractive,
  MarkdownImage,
  type PreviewImage,
} from "@/components/ui/image-preview";

import { createHookHarness } from "./helpers/react-hook-stub";

type El = ReactElement<Record<string, unknown>>;

/** 把渲染出的元素树拍平成元素列表（深度优先）；跳过 null / false / 文本 */
const flatten = (node: unknown, out: El[] = []): El[] => {
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.push(el);
    flatten(el.props.children, out);
  }
  return out;
};

// ---------------------------------------------------------------------- ① MarkdownImage

type OpenFn = (images: PreviewImage[], index?: number) => void;

/**
 * 在「只实现了 useContext」的桩 dispatcher 下跑一次组件函数体（同 helpers/react-hook-stub 的做法：
 * 临时替换 React 内部 dispatcher 槽位，跑完还原）。预览上下文的默认值是 null（没 Provider 时 useImagePreview 会抛），
 * 这里给它 `{ open }`；「外层已是链接 / 按钮」的标记按 `inside` 给（默认 false = 按钮那一路，true = 退回的 `<img onClick>`）；
 * 其它上下文原样给自己的默认值。
 * 组件里用到别的 hook 会直接抛——到那时请连同这个桩一起更新。
 */
/**
 * 「外层已是链接 / 按钮」那个上下文对象（组件里没导出）：渲染一次 InsideInteractive，从它的 Provider 元素上取。
 * React 19 里 Provider 就是 context 本身；旧写法的 Provider._context 兜底。
 */
const insideInteractiveContext = (): unknown => {
  const provider = (InsideInteractive({ children: null }) as El).type as unknown as { _context?: unknown };
  return provider._context ?? provider;
};

const withPreviewContext = <T,>(open: OpenFn, body: () => T, inside = false): T => {
  const internals = (
    React as unknown as Record<string, { H: unknown } | undefined>
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!internals) {
    throw new Error("拿不到 React 内部 dispatcher，请更新本测试里的桩（同 tests/helpers/react-hook-stub.ts）");
  }
  const prev = internals.H;
  const insideCtx = insideInteractiveContext();
  internals.H = {
    useContext: (ctx: { _currentValue: unknown }) =>
      ctx === insideCtx ? inside : ctx._currentValue === null ? { open } : ctx._currentValue,
  };
  try {
    return body();
  } finally {
    internals.H = prev;
  }
};

const URL_A = "https://example.com/a.png";

const renderMarkdownImage = (props: ComponentProps<typeof MarkdownImage>) => {
  const open = vi.fn<OpenFn>();
  const rendered = withPreviewContext(open, () => MarkdownImage(props));
  if (!rendered) throw new Error("MarkdownImage 没渲染出元素");
  const root = rendered as El;
  const els = flatten(root);
  const button = els.find((e) => e.type === "button");
  const img = els.find((e) => e.type === "img");
  if (!button || !img) throw new Error("MarkdownImage 里应有 <button> 包着 <img>");
  return { open, root, button, img };
};

describe("MarkdownImage：点开大图 / 悬浮提示 / 懒加载（B6-4 自己承认没覆盖的两处 + loading）", () => {
  it("点击把「这一张图 + alt + title」整份交给灯箱（只传 src 灯箱里就没有说明文字；alt / title 对调就串了）", () => {
    const { open, button } = renderMarkdownImage({ src: URL_A, alt: "登录页截图", title: "登录页（v2）" });
    expect(open).not.toHaveBeenCalled(); // 渲染本身不开灯箱
    (button.props.onClick as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith([{ src: URL_A, alt: "登录页截图", title: "登录页（v2）" }]);
  });

  it("只有 alt、没有 title：alt 照样带过去，title 为空", () => {
    const { open, button } = renderMarkdownImage({ src: URL_A, alt: "只有 alt" });
    (button.props.onClick as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
    const arg = open.mock.calls[0]?.[0];
    expect(arg).toHaveLength(1);
    expect(arg?.[0]).toMatchObject({ src: URL_A, alt: "只有 alt" });
    expect(arg?.[0]?.title).toBeUndefined();
  });

  it("悬浮提示：有 title 用 title（优先），没有 title 退回 alt，两个都没有就不提示", () => {
    expect(renderMarkdownImage({ src: URL_A, alt: "A", title: "T" }).root.props.content).toBe("T");
    expect(renderMarkdownImage({ src: URL_A, alt: "A" }).root.props.content).toBe("A");
    expect(renderMarkdownImage({ src: URL_A, title: "T" }).root.props.content).toBe("T");
    expect(renderMarkdownImage({ src: URL_A }).root.props.content).toBeUndefined();
  });

  it("<img> 懒加载：长对话里的图不一次性全加载；src / alt 带上", () => {
    const { img } = renderMarkdownImage({ src: URL_A, alt: "登录页截图" });
    expect(img.props.loading).toBe("lazy");
    expect(img.props.src).toBe(URL_A);
    expect(img.props.alt).toBe("登录页截图");
  });
});

/** 外层已是链接 / 按钮（InsideInteractive）时的渲染：组件退回改前的 `<img onClick>`，不再套 button */
const renderInsideLink = (props: ComponentProps<typeof MarkdownImage>) => {
  const open = vi.fn<OpenFn>();
  const rendered = withPreviewContext(open, () => MarkdownImage(props), true);
  if (!rendered) throw new Error("MarkdownImage（外层是链接）没渲染出元素");
  const root = rendered as El;
  const els = flatten(root);
  return { open, root, img: els.find((e) => e.type === "img"), hasButton: els.some((e) => e.type === "button") };
};

describe("MarkdownImage 在链接 / 按钮里：退回改前的 <img onClick>，点击数据同样整份交给灯箱（P9：K1a / K2a）", () => {
  it("退回分支确实进了：只有 <img>、没有 <button>（桩没切过去，这条就红，不会悄悄把按钮那一路当成它测）", () => {
    const { img, hasButton } = renderInsideLink({ src: URL_A, alt: "徽章" });
    expect(hasButton).toBe(false);
    expect(img).toBeDefined();
    expect(typeof img?.props.onClick).toBe("function");
  });

  it("点击把「这一张图 + alt + title」整份交给灯箱（只传 src 灯箱里没有说明文字；alt / title 对调就串了）", () => {
    const { open, img } = renderInsideLink({ src: URL_A, alt: "二维码", title: "扫码加入（v2）" });
    expect(open).not.toHaveBeenCalled(); // 渲染本身不开灯箱
    (img?.props.onClick as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith([{ src: URL_A, alt: "二维码", title: "扫码加入（v2）" }]);
  });

  it("只有 alt、没有 title：alt 照样带过去，title 为空", () => {
    const { open, img } = renderInsideLink({ src: URL_A, alt: "只有 alt" });
    (img?.props.onClick as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
    const arg = open.mock.calls[0]?.[0];
    expect(arg).toHaveLength(1);
    expect(arg?.[0]).toMatchObject({ src: URL_A, alt: "只有 alt" });
    expect(arg?.[0]?.title).toBeUndefined();
  });

  it("悬浮提示与按钮那一路一致：有 title 用 title，没有退回 alt，两个都没有就不提示", () => {
    expect(renderInsideLink({ src: URL_A, alt: "A", title: "T" }).root.props.content).toBe("T");
    expect(renderInsideLink({ src: URL_A, alt: "A" }).root.props.content).toBe("A");
    expect(renderInsideLink({ src: URL_A, title: "T" }).root.props.content).toBe("T");
    expect(renderInsideLink({ src: URL_A }).root.props.content).toBeUndefined();
  });

  it("<img> 仍懒加载、带 src / alt", () => {
    const { img } = renderInsideLink({ src: URL_A, alt: "二维码" });
    expect(img?.props.loading).toBe("lazy");
    expect(img?.props.src).toBe(URL_A);
    expect(img?.props.alt).toBe("二维码");
  });
});

// ---------------------------------------------------------------------- ② Provider

describe("ImagePreviewProvider：open → 灯箱拿到的数据 → 左右切（环形）→ 关闭", () => {
  const THREE: PreviewImage[] = [
    { src: "/1.png", alt: "一" },
    { src: "/2.png", alt: "二" },
    { src: "/3.png", alt: "三" },
  ];

  /** 槽位桩里真跑 Provider：每次 render 返回当时的元素树（setState 只改槽位，要读新值得再 render 一次） */
  const setup = () => {
    const h = createHookHarness();
    const render = (): El => h.render(() => ImagePreviewProvider({ children: null })) as El;
    const { open } = render().props.value as { open: OpenFn };
    const lightbox = (): El | undefined => flatten(render()).find((e) => e.type === ImageLightbox);
    return { open, lightbox };
  };

  it("没打开时没有灯箱", () => {
    expect(setup().lightbox()).toBeUndefined();
  });

  it("open(图组, 第 N 张)：灯箱拿到整组图和同一个下标（不能写死 0、不能只传第一张）", () => {
    const { open, lightbox } = setup();
    open(THREE, 2);
    const box = lightbox();
    expect(box).toBeDefined();
    expect(box?.props.index).toBe(2);
    expect(box?.props.images).toEqual(THREE);
  });

  it("open 不传下标 = 从第一张开始", () => {
    const { open, lightbox } = setup();
    open(THREE);
    expect(lightbox()?.props.index).toBe(0);
    expect(lightbox()?.props.images).toEqual(THREE);
  });

  it("上一张 / 下一张：灯箱不关、下标真的动，首尾相接（接成关闭或空函数都会在这里露馅）", () => {
    const { open, lightbox } = setup();
    open(THREE, 1);
    const go = (delta: number) => (lightbox()?.props.onGo as (d: number) => void)(delta);

    go(1);
    expect(lightbox()?.props.index).toBe(2);
    go(1); // 末尾再往后 → 回到第一张
    expect(lightbox()?.props.index).toBe(0);
    go(-1); // 第一张再往前 → 回到最后一张
    expect(lightbox()?.props.index).toBe(2);
    go(-1);
    expect(lightbox()?.props.index).toBe(1);
    expect(lightbox()?.props.images).toEqual(THREE); // 切图不换图组
  });

  it("onClose：灯箱消失；之后可以再打开别的图组", () => {
    const { open, lightbox } = setup();
    open(THREE, 1);
    (lightbox()?.props.onClose as () => void)();
    expect(lightbox()).toBeUndefined();
    open([{ src: "/z.png" }]);
    expect(lightbox()?.props.images).toEqual([{ src: "/z.png" }]);
    expect(lightbox()?.props.index).toBe(0);
  });
});

// ---------------------------------------------------------------------- ③ 公司环境卡删除键

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const FILE = "components/settings/company-env-card.tsx";

interface Site {
  kind: string;
  /** 实际写的序号实参 */
  indexArg: string;
  /** 实际写的环境实参 */
  envArg: string;
  /** 外层 .map 回调里这一轮的下标变量名；找不到外层 .map 回调时为 null */
  expectedIndex: string | null;
  /** 外层 .map 回调里这一行的变量名 + ".env"；找不到时为 null */
  expectedEnv: string | null;
}

/** 扫出源码里所有 removeInstanceLabel("类型", 序号, 环境) 调用，连同「按理该写成什么」 */
const scanRemoveLabelSites = (text: string): Site[] => {
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];
  /** 最近的、带两个以上参数的 `.map(回调)` 回调（回调形如 (行, 下标) => …） */
  const mapCallbackOf = (n: ts.Node): ts.ArrowFunction | ts.FunctionExpression | undefined => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parameters.length >= 2) {
        const call = p.parent;
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "map") {
          return p;
        }
      }
    }
    return undefined;
  };
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "removeInstanceLabel" &&
      n.arguments.length === 3 &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      const cb = mapCallbackOf(n);
      sites.push({
        kind: n.arguments[0].text,
        indexArg: n.arguments[1].getText(sf),
        envArg: n.arguments[2].getText(sf),
        expectedIndex: cb ? cb.parameters[1].name.getText(sf) : null,
        expectedEnv: cb ? `${cb.parameters[0].name.getText(sf)}.env` : null,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
};

/** 不合格的调用点（序号不是这一轮的下标 / 环境不是这一行自己的 .env / 不在 .map 回调里） */
const badSites = (sites: Site[]): string[] =>
  sites
    .filter((s) => s.expectedIndex === null || s.indexArg !== s.expectedIndex || s.envArg !== s.expectedEnv)
    .map((s) => `${s.kind}：序号 ${s.indexArg}（应为 ${s.expectedIndex}）、环境 ${s.envArg}（应为 ${s.expectedEnv}）`);

describe("公司环境卡：7 个删除键的名字取自「当前这一行」的序号和环境（Q19-01）", () => {
  const sites = scanRemoveLabelSites(readFileSync(path.join(srcDir, FILE), "utf8"));

  it("扫描器自检：真实文件里恰有 7 处调用，类型名按源码顺序是 服务器 / PG / Redis / XXL-Job / Nacos / ELK / SLS", () => {
    expect(sites.map((s) => s.kind)).toEqual([
      "服务器",
      "PostgreSQL 实例",
      "Redis 实例",
      "XXL-Job 环境",
      "Nacos 集群",
      "ELK 实例",
      "SLS 实例",
    ]);
    // 每处都认出了外层 .map 回调（认不出就谈不上校验）
    for (const s of sites) {
      expect(s.expectedIndex, s.kind).not.toBeNull();
      expect(s.expectedEnv, s.kind).toMatch(/^\w+\.env$/);
    }
  });

  it("序号实参 = 外层 .map 的下标变量、环境实参 = 同一回调里这一行的 .env（序号写死 0 / 环境写空串或别的字段都不行）", () => {
    expect(badSites(sites)).toEqual([]);
  });

  it("扫描器不空转：对合成的坏源码，三种写错都认得出", () => {
    const wrap = (call: string) =>
      `const x = list.map((p, i) => <InstanceRowEnd removeLabel={${call}} />);`;
    expect(badSites(scanRemoveLabelSites(wrap('removeInstanceLabel("X", i, p.env)')))).toEqual([]);
    // 序号写死
    expect(badSites(scanRemoveLabelSites(wrap('removeInstanceLabel("X", 0, p.env)')))).toHaveLength(1);
    // 环境写成空串 / 别的字段
    expect(badSites(scanRemoveLabelSites(wrap('removeInstanceLabel("X", i, "")')))).toHaveLength(1);
    expect(badSites(scanRemoveLabelSites(wrap('removeInstanceLabel("X", i, p.namespaces.join(","))')))).toHaveLength(1);
    // 取了别的变量（外层还有别的下标）
    expect(
      badSites(
        scanRemoveLabelSites(
          `const x = a.map((p, i) => b.map((q, j) => <R removeLabel={removeInstanceLabel("X", i, q.env)} />));`,
        ),
      ),
    ).toHaveLength(1);
    // 不在 .map 回调里
    expect(badSites(scanRemoveLabelSites('const y = removeInstanceLabel("X", 1, e.env);'))).toHaveLength(1);
  });
});
