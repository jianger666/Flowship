# Windows「慢 / shell 卡死」根因排查报告（2026-07-17）

> 目的：汇总 07-16 调研（`cursor-sdk-windows-performance-investigation-2026-07-16.md`）之后、07-17 拿到真实用户诊断包与任务导出后的**实证结论**，供后续 AI（GPT-5.6 等）讨论平台级优化方案。
> 结论置信度标注：【实锤】= 有日志/源码/复现三者之一以上直接证明；【推断】= 数据支持但未直接验证。

## 0. 原始证据位置（本机可直接读、复核结论从这里入手）

| 证据 | 路径 | 说明 |
|---|---|---|
| ① Windows 同事任务导出 | `/Users/chenlujiang/Downloads/t_1784014006729_jxw461/` | `events.jsonl` 1362 条事件（07-14~07-17 提缺陷任务全程）；`meta.json`；`workspace/` 残留中间文件（含乱码 `story.json`）；`actions/*.md` 产物 |
| ② 同机诊断包 | `/Users/chenlujiang/Downloads/Flowship诊断-20260717-110731.txt` | app v1.1.18、win32 x64；main.log 尾部 300KB（覆盖 07-13 起、含 v1.1.16 run-perf 埋点、`[agent-shell]` 与 `Can't find Bash` 关键行在 07-16T09:47 之后） |
| ③ mac 对照组 | `~/Library/Application Support/fe-ai-flow/logs/main.log` | 本机真实任务的 run-perf 埋点（shell/read/thinking gap 对照数据来源） |
| ④ SDK bundle 源码 | `<仓库>/node_modules/@cursor/sdk/dist/esm/357.js` | 搜 `Can't find Bash`（bash 查找 `Ue`）、`MSYSTEM`（选壳器 `vt`/`gt`）、`Dump-PowerShellState`（PowerShell 执行器）、`CURSOR_AGENT`（注入 env） |
| ⑤ 我们的修复 | `<仓库>/src/lib/server/agent-shell.ts` + `tests/agent-shell.test.ts` | v1.1.19 的 PATH 注入 + 自检回滚实现 |

注意：①② 含同事的仓库路径 / 需求内容 / 飞书链接，仅本机分析用、别外传原文件。

> **2026-07-17 复核修订**：本文档已经外部 AI（GPT-5.6）三轮复核并按意见修订置信度——事故根因（§2/§3）维持【实锤】；「两平台对比 → 平台定责」类结论（§4/§5）**降为【推断/观察】**（样本非受控 A/B、thinking gap 指标语义混合、mac 同样存在超大 turn）。代码侧三轮复核指出的 2 个 P1（跨 bundle 状态不共享、异步预检期间暴露临时环境）+ 1 个 P2（PATH 顺序边界）均已修复并通过复审（复核往来文档已删、结论落在本文档与 v1.1.20 实现）。修订处内联标注。

## 1. TL;DR

1. 【实锤】07-17 用户报的「shell 不可用、执行卡死」**不是** Windows 本身慢，是 **v1.1.18 我们自己的「Agent shell 用 Git Bash」开关引入的事故**：只写了 `SHELL` 没补 `PATH`，SDK 选壳器被说服、执行器却找不到 bash，每条 shell 抛 `Can't find Bash` 且无 `phase=done`。v1.1.19 已实现**候选修复**（PATH 注入 + 自检回滚）——真机验证前不称「已修好」。
2. 【推断·修订】两组**非受控**真实任务样本中，Windows 的 read/glob/grep 与 `thinking-completed` 事件间隔未见数量级恶化——可弱化「Windows 本地 IO / Defender 是主要瓶颈」的假设，但**不能排除**（模型/任务/文件集/网络全不同、且 Windows 样本处于事故期）。「Windows 特别慢」的体感构成：(a) 事故期 shell 全死后 agent 绕道重试【实锤】；(b) 大 turn token 消耗（见 §5 修订）【推断】；(c) PowerShell 执行器每条命令冷启动的固定成本（官方已认 bug）【实锤·架构】。
3. 【推断·修订】上下文累积是平台通用机制，但本次观察到的**头部触发器是特定 skill 的大输出契约 + Windows shell/编码试错**；「所有 action 同等严重」是过度外推，需先补「单条工具输出字节 + 每 model call token + action/skill 名」埋点找真实头部来源。
4. 修复方向按层拆成 L0-L5（见 §7），L0（真机验证 + 自检顺序修正）最高优先。

## 2. 时间线（同事机器、+0800）

| 时间 | 事件 | 证据 |
|---|---|---|
| 07-14 ~ 07-16 17:44 | shell 走 PowerShell 执行器，**慢但能用**（PowerShell 语法/编码坑靠 agent 现场绕） | events.jsonl action 1-13 全部正常完成 |
| 07-16 17:46 | app 自更新 v1.1.14 → **v1.1.18** 重启 | main.log `app 启动 version=1.1.18` |
| 07-16 17:47:56 | 同事拨开「Agent shell 用 Git Bash」 | main.log `[agent-shell] SHELL → Git Bash: C:\Program Files\Git\bin\bash.exe` |
| 07-16 17:48:47 | 下一个 action 第一条 shell：`phase=start` 后**永远没有 `phase=done`**，紧跟 `Error: Can't find Bash` | main.log perf-tool + server:err |
| 07-16 17:48 ~ 07-17 | shell 100% 死：`echo`、`pwd`、cmd.exe 包装、子代理内全一样；read/edit/glob/MCP 全程正常 | events.jsonl action 14/15 + main.log |

关键排除项：期间**没有** EDR 策略变化、Profile 没被写坏（此前两个候选假设均被诊断包证伪）——`Can't find Bash` 的错误行给了唯一且充分的解释。

## 3. 事故根因：SDK 选壳器与执行器是两套独立逻辑【实锤、bundle 源码】

`@cursor/sdk@1.0.23`（`dist/esm/357.js`）：

- **选壳器 `vt(hint)`**：`t = hint || process.env.SHELL || ""`；win32 下 `SHELL` 匹配 `/git.*bash\.exe$/i` 或 `/program.*git.*bin.*bash\.exe$/i` → 选 **Bash 执行器**。我们注入的 `C:\Program Files\Git\bin\bash.exe` 命中 ✅。
- **Bash 执行器的 bash 查找 `Ue(userTerminalHint)`**（win32 分支）：

```js
function Ue(e){
  if("win32"===process.platform){
    const t=/git.*bash/i;
    if(e&&t.test(e))return e;            // userTerminalHint（Agent.create 参数、Flowship 没传）
    const r=(0,o.Ef)("bash",[],t).cmd;   // 在 PATH 里 where bash、要求路径匹配 /git.*bash/i
    return t.test(r)?r:null;             // 找不到 → null
  }
  ...
}
// 调用处：const k=Ue(this.userTerminalHint); if(!k) throw new Error("Can't find Bash");
```

**它根本不读 `process.env.SHELL`**。装 Git for Windows 默认只把 `Git\cmd`（只有 git.exe）加进 PATH、`bash.exe` 在 `Git\bin` 不在 PATH → `Ue` 返回 null → 每条 shell 抛 `Can't find Bash`。该 throw 发生在 async generator 内、逃逸成 unhandledRejection（被 `instrumentation.ts` 全局兜底、进程不退）。【推断·修订】后续传播机制（promise 是否永不 settle、agent 等待哪个超时、如何拿到空结果）**日志只能证明「无 shell done + agent 数秒后继续 thinking」**，完整链路需最小复现或在 SDK 调用边界记 settle/timeout 才能实锤。

v1.1.19 **候选修复**（真机验证前不称已修好）：注入 `SHELL` 的同时把 `path.dirname(bash.exe)` 前置注入 `process.env.PATH`（选壳器、执行器两边都满足）；注入后跑 `bash -c "echo __shell_ok__"` 自检、失败回滚退回 PowerShell；卸载按记录的注入段精确移除。已知两个残余风险（复核 §三指出、待修）：① 自检只证明绝对路径可启动、没证明 SDK 经 PATH `where bash` 会解析到匹配 `/git.*bash/i` 的路径；② 当前顺序「先注入后自检」+ 启动 fire-and-forget 调用，存在「坏环境短暂暴露给此窗口内创建的 agent」的竞态——应改为「先自检、成功才注入」。

## 4. 两平台埋点对比（run-perf、真实任务、ms）【推断·非受控样本，复核修订】

Windows = 同事诊断包（事故期数据、shell 不可比）；mac = 本机 main.log。**两组样本的模型/任务/文件集/网络全不同、非 A/B**，只能弱化假设、不能排除瓶颈。p50/p90（附样本量）：

| 指标 | Windows | mac | 解读（修订后） |
|---|---|---|---|
| read | 338 / 1369（n=24） | 299 / 594（n=65） | 未见数量级恶化；不足以排除 Defender/EDR/任务差异 |
| glob | 517 / 2470（n=10） | 307 / 384（n=5） | 略慢、样本小 |
| grep | 651（n=2） | 302 / 671（n=31） | 样本过小、仅参考 |
| **thinking 间隔**（注意：埋点只记 `thinking-completed`，该值是「上一被记录事件 → thinking-completed」的**混合间隔**、含 thinking 本身时长，不是纯模型排队） | 6727 / 16636（n=30） | 7186 / 15910（n=118） | 分布相近、未见 Windows 数量级恶化；**不足以证明模型侧延迟与 OS 无关** |
| thinking duration | 1162 / 5071 | — | 正常 |
| shell | 事故期全死（n=0 done） | 2479 / 6462、max 26647（n=66） | mac 的 zsh 状态序列化固定成本也不小（每条 2.5s 起） |
| task 子代理 | 45348（n=2） | 53627 / 77280（n=15） | 两边都贵；Windows 样本是 shell 挂死后的绕道调用 |

工具调用未配对构成（修订：不能笼统说「差值≈卡死 shell 数」）：外层未完成 shell=15、read=4、glob=1、task=2；诊断包内 `Error: Can't find Bash` 错误行共 100 条（含子代理内部 shell 与重试，不与外层 perf-tool 一一对应）。

## 5. 大 turn token 与 Windows 编码泥潭

- **turn token【推断·修订】**：同事提缺陷 action 有 `turn-ended` usage `input 483993 / cacheRead 392160`。注意：① 这是**整轮 turn 的累计**（内含多次 model call + 多个 step），现有埋点没有记录单次 model call 的输入 token，**不能**据此断言「某次请求上下文已达 48 万」或「每个 step 都因此变慢」；② mac 对照组同样存在超大 turn（最大 `input 1287660 / cacheRead 1195975`）——大 turn 不是 Windows 特有，做平台归因前必须补两边对照。可确认的事实：skill 中间数据全量 read（story 全量 JSON 11.9KB、agent 只需要几百字节）、事故期绕道重试、编码试错轮次都在给上下文做无谓加法。
- **编码泥潭实物【实锤】**：同事 workspace 残留的 `story.json` 带 UTF-8 BOM + 正文 GBK mojibake（「曹侃线…」变「鏇瑰溅绾?」）+ 坏控制字符、去 BOM 后 `JSON.parse` 仍炸——PowerShell 重定向写文件的典型产物。agent 每次都要撞一遍才想起改用 Node `execFileSync`，这段试错每个任务重复发生。
- **坑不沉淀【实锤】**：agent 在事件流里两次系统性总结过坑清单（multi-select 必须 stringified、CLI 参数名与文档不一致、富文本图片 uuid 来源、创建后校验命令、Windows 禁 PowerShell 内联 JSON 等 7+ 条），但没有机制写回 SKILL.md，下个 fresh agent 重踩。
- **外推边界【复核修订】**：平台具备「工具输出留在会话里累积」的通用放大机制，但本次实物主要来自 meegle-submit-bug 场景；「所有 action 同等严重」不成立，需补「单条工具输出字节 + 每 model call token + action/skill 名」埋点找真实头部来源后再定 L3 阈值。

## 6. SDK 侧事实（复核 07-16 调研、仍成立）

- `@cursor/sdk@1.0.23` 仍是 npm latest（07-03 发布、07-17 复核）；PowerShell 执行器架构未变：每条命令冷启动 powershell + 临时 .ps1 + 状态 dump 文件、不带 `-NoProfile`、5s close 兜底。
- 官方已认 Windows agent shell 挂起 bug（forum 162350）——官方**没有背书 Git Bash**、且 Bash/Zsh 路线自身有函数表状态膨胀风险（forum 158535）。【修订】Git Bash 定性为「基于 SDK 结构值得优先验证的绕行候选」，是否优于 PowerShell 要等真机 A/B（成功率、p50/p90、长会话退化、rc 状态膨胀）。
- SDK 注入 `CURSOR_AGENT=1`（bundle 实锤）→ v1.1.16 的 PowerShell Profile 守卫、及 `COMPOSER_NO_INTERACTION` bash 守卫对 Git Bash 路线同样适用。

## 7. 平台级修复方向（待讨论优先级）

| 层 | 内容 | 状态 |
|---|---|---|
| L0 事故收尾 | ① 先修 v1.1.19 两个残余风险（自检改「先验后注」、apply 串行化防启动竞态）；② Windows 真机 SDK smoke（`where bash` 首个结果 = 目标 Git Bash → 建真实 agent 跑 echo → `phase=done status=success` → 连续多条验 cwd/env 状态恢复）；③ 同机同任务同模型 PowerShell vs Git Bash A/B | **最高优先、阻塞其它 Windows 结论** |
| L1 prompt 纪律 | `_super/_shared` 加 harness 约束：大输出先落文件再抽摘要、大文件禁盲 read；Windows 写文件用 edit/Node（UTF-8 无 BOM）、禁 PowerShell 重定向/内联 JSON | 待做、改动小 |
| L2 skill 规范 | 「三段式输出契约」（stdout 一行状态 + 全量落文件 + 几百字节 summary.json）写成规范；出厂预置 skill 示范；同事 meegle-submit-bug 按规范重写 | 待拿 skill 本体 |
| L3 预算可观测 | run-perf 已采 token 用量 → 单 turn input 超阈值（如 20 万）事件流提醒「上下文过大、建议交卷重开」 | 待做、数据现成 |
| L4 首包瘦身 | 91KB 首包：skills/rules 索引化按需读；续用会话只发短 directive | 单独立项、体量大 |
| L5 Windows 默认体验 | Git Bash 验证后引导默认开启；learn action 打通「agent 坑清单一键写回 skill」 | 依赖 L0 |

## 8. 给 GPT-5.6 的讨论题

1. L1 的 prompt 纪律怎么写才「硬」：模型对「先落文件再抽摘要」这类纪律的遵守率有限，是否需要配确定性检查（如后置检查扫 events 里单条工具输出体积、超限提示）？
2. L3 阈值定多少合理：cacheRead 占比高时（39/48 万）真实成本与延迟的关系？是否应按「非缓存 input」告警？
3. L4 skills 索引化的风险：agent 按需 read skill 的命中率 vs 现在全量注入的确定性，怎么设计 fallback？
4. SDK 侧还能不能更进一步：`LocalAgentOptions` 未暴露 shell 选择/userTerminalHint（07-16 调研 §7.4），是否值得给 Cursor 提 feature request（显式 shell 配置 + 工具输出 truncation 选项）？现有材料（两平台对比数据、Can't find Bash 复现链、requestId）已够提 issue。
5. mac shell 2.5s/条的 zsh 状态序列化成本（官方已认的函数表滚雪球风险）要不要也做会话内递增监控？

## 9. 本轮没做 / 明确不做

- 没动 PowerShell 执行器路线的深度优化（官方 bug、绕开为主）。
- 没自动改用户 PATH / Profile 之外的任何系统配置（自检失败宁可回退也不硬来）。
- Defender/EDR A/B（§4 数据显示本地 IO 不是主要瓶颈后优先级降低、暂不投入）。
