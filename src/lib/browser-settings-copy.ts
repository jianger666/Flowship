/**
 * 设置页「内置浏览器」卡的文案：每项 = 名称（label）+ 一句说明（hint）+ 补充说明（detail，设置行里名称后面的 ⓘ 气泡）。
 *
 * 为什么单独成一份纯数据：
 * - 补充说明在设置行里是悬停 / 聚焦才出的气泡（读屏另有一份常驻 sr-only 文本），可见文字里看不到它；「导出文件含明文凭据」「*.local 不在放行范围」
 *   「输入内容里的敏感格式仍会打码」这类**披露性**文案，以前靠正则从源码里抠 `hint="…"`，一重排就抠不到。
 *   现在契约测试直接 import 这份数据断言（见 tests/browser-r6-s3-net-hygiene.test.ts / browser-r6-s5-redact.test.ts），
 *   文案怎么拆 hint / detail 都行，测试钉的是事实还在不在。
 * - 卡片组件只管布局与接线，不再夹一堆长字符串。
 *
 * 写法约定（ui-conventions「设置类页面」）：hint 一句话，字数上限以 tests/settings-hint-brevity.test.ts 的 HINT_MAX / DETAIL_MAX 为准
 * （那个测试直接扫这份数据，超了会红），但要保住「风险 / 默认值」这类做决定必须看到的词；
 * 背景、边界、清理期限这些细节进 detail。⛔ 不要把教程塞回 hint——用户点名过「一大串一大串的字」。
 * 默认开的项（网络正文 / 本机证书）hint 里要写「默认开」；高级调试默认关（整组工具说明常驻 prompt，默认不挂才省 token），hint 写「默认关」。
 *
 * 顺序 = 卡片上的显示顺序，按「AI 能做什么 → AI 能看到什么 → 浏览器自身 → 清除」排：
 * 默认关、风险高的放最上面，破坏性的「清除」放最下面。
 *
 * 2026-11-24 评审（S-2 / S-8）逐条按代码核实后的修正，事实出处：
 * - 页面权限：开关一开，AI 的 browser_permissions grant 就能授予摄像头 / 麦克风（electron-app/browser/permission-policy.mjs 里只有屏幕共享 / USB 等
 *   NEVER 清单永远拒绝）；「只在用户明确要求时才授予」只写在工具说明里（tools-permissions.ts），是对 AI 的约定、不是代码硬闸；
 * - 页面脚本总闸：除 browser_evaluate 外，还是 browser_perf heap_snapshot、browser_network_rules 的可执行 mock（html / js / svg 等）、
 *   browser_debug 的 scope 与带 condition 断点共用的那道审批（都调 evaluate-approval.mjs 的 ensureEvaluateApproval）；
 * - 高级调试：关闭时进行中的会话也立即被拒（tools-e2.ts gateAdvancedTools 每次调用实时读设置）；开启时工具是会话创建时一次性挂上的，只有新会话才有；
 * - 本机证书：只有主框架的证书错误才会弹窗询问；子资源证书错误拒绝——除非这个 host 的这张证书（指纹）已被用户本会话放行（allow-host，不落盘），
 *   或属于开关管的本机信任（electron-app/browser/net-guard.mjs decideCertError：loopback → user-allowed → 主框架 ask → 子资源 deny；R20-13 订正，
 *   此前写成「一律直接拒绝」，漏了「已放行的除外」）；
 * - 脱敏都是正则规则（text-redact.mjs），尽力而为、不保证覆盖所有格式。
 */

export interface BrowserSettingCopy {
  readonly label: string;
  /** 一句说明：行内直接可见 */
  readonly hint: string;
  /** 补充说明：悬停 / 聚焦 ⓘ 才出（读屏常驻一份）。没有就不渲染 ⓘ */
  readonly detail?: string;
}

export const BROWSER_SETTING_COPY = {
  /** 允许 AI 在页面里执行 JS（browser_evaluate）。默认关 */
  evaluate: {
    label: "允许 AI 执行页面脚本",
    hint: "让 AI 直接在网页里运行 JavaScript，能力强、风险也高；默认关闭",
    detail:
      "关闭时，AI 执行脚本会先弹审批卡，由你选「仅本任务允许」「永久开启」或「拒绝」。同一道审批还管堆快照、可执行 mock、读运行时变量和带条件断点（browser_perf / browser_network_rules / browser_debug）。",
  },
  /** 增强包 E2（契约 §15）：允许 AI 读写登录态。默认关 */
  storage: {
    label: "允许 AI 读写登录态",
    hint: "开启后 AI 能看到 Cookie / 本地存储的明文，还能写入、删除、导出、导入登录状态",
    detail:
      "默认关闭时只能看到名字和属性，值只显示长度和前 4 位。导出的文件含明文凭据（Cookie / 令牌），保存在任务目录（权限 0600），14 天后自动清理；无痕标签的数据不允许导出。",
  },
  /** 允许 AI 授予 / 拒绝页面权限（含摄像头 / 麦克风）。默认关 */
  permissions: {
    label: "允许 AI 授予页面权限",
    hint: "开启后 AI 可替你对页面的权限请求点允许或拒绝：定位、通知、读剪贴板，含摄像头和麦克风",
    detail:
      "默认关闭，页面请求权限（含摄像头 / 麦克风）时由你在面板上决定。开启后 AI 也能替你授予摄像头 / 麦克风——工具说明要求它只在你明确要求时才授予，但这是对 AI 的约定、不是硬性拦截；屏幕共享和 USB 永远拒绝。",
  },
  /** 允许 AI 读取网络请求 / 响应体（已脱敏）。默认开 */
  networkBody: {
    label: "允许 AI 读取网络响应内容",
    hint: "默认开。开启后 AI 可查看请求和响应的正文；关闭后只能看到地址、状态和头部",
    detail: "正文里的令牌、密码等敏感内容按规则尽力隐去，不保证全部；接口数据敏感时可以关掉。",
  },
  /** 用户操作记录里带上输入的值（密码框永不记）。默认关 */
  recordInput: {
    label: "记录你输入的内容",
    hint: "开启后，你在浏览器里的输入会连同内容一起告诉 AI；默认只记「输入了几个字」",
    detail:
      "邮箱、令牌、卡号等敏感格式仍会自动打码（按规则尽力而为，不保证全部）。密码框的内容无论如何都不记录。",
  },
  /** 给 AI 注册「高级调试」工具组。默认关 */
  advancedTools: {
    label: "高级调试工具",
    hint: "默认关。给 AI 提供网络规则、性能分析、源码查看、断点调试、录制这组前端调试工具",
    // 「立即生效」只对「拒绝」成立：进行中的会话里这组工具的说明早已挂在提示词里，要到新开始的会话才会变短（R20-13 订正：旧句把两件事混成一句「立即生效」）
    detail: "关闭后，进行中的会话也会马上拒绝这组工具；但提示词里的工具说明要到新开始的会话才会变短。重新开启后，也只有新开始的会话才带上它们。",
  },
  /** 自动放行真正本机（localhost / *.localhost / 127.0.0.0/8 / ::1；R6-23：不含 *.local）的自签名证书。默认开 */
  loopbackCerts: {
    label: "自动放行本机的自签名证书",
    hint: "默认开。只对 localhost（含 *.localhost）、127.0.0.0/8 和 ::1 生效，用于本机开发站点",
    detail:
      "*.local（局域网设备名，可能是别人的机器）不在此列，仍会询问你；其它网站只有主页面的证书错误才会在面板上问你，页面里嵌的子资源（图片、接口等）证书错误会被拒绝，除非你已在面板上放行过该网站的这张证书（不落盘，重启后失效）。",
  },
  /** 单个任务同时打开的标签页上限（5–60，缺省 20） */
  maxTabs: {
    label: "标签页数量上限",
    hint: "单个任务最多同时打开几个标签页（5–60）",
    detail: "每个标签页是一个独立的渲染进程，设太大会吃内存。",
  },
  /** 清除内置浏览器的登录数据（破坏性、走统一确认框）。无桌面壳时按钮不可用、说明改成 unavailable */
  clearData: {
    label: "清除浏览器登录数据",
    hint: "清掉内置浏览器保存的 Cookie 与站点数据，所有网站需要重新登录",
    unavailable: "仅桌面端可用",
  },
} as const satisfies Record<string, BrowserSettingCopy | (Omit<BrowserSettingCopy, "detail"> & { unavailable: string })>;
