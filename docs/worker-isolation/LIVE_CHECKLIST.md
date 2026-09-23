# Worker 隔离真机联调清单（只列清单，不执行）

> 前置：`pnpm dev:web` 起 8676 热更（别碰 8876 正式包）。flag 默认关，先看关的行为零变化，再开 flag 对比。

## 0. 开关

- 关：`FLOWSHIP_WORKER_ISOLATION` 缺省——现行为逐字节不变，boot recovery 末尾钩子直接返回
- 开：`FLOWSHIP_WORKER_ISOLATION=1 pnpm dev:web`——恢复走合并扫描（无 deps 时只扫不执行）

## 1. 实验 B 真机项

- [ ] worker 内 agent 跑 `printenv PATH`，确认 shim 目录在首位（定 (c) 生死）
- [ ] `disallowedTools: ["shell"]` 建 agent → shell 调用应被拒（禁用兜底可用性）
- [ ] `Agent.resume` 同 agentId 发新 send：记录 runId 是否续用、事件 seq 是否重置（只影响派发策略，不影响去重正确性）

## 2. 实验 A 真机项

- [ ] force GC + 三次 heap 快照：agent/executor/store 三级释放结论 + 残留 dominator
- [ ] summary 触发前后堆曲线；SDK 搬 worker 后主进程 44h 等价负载曲线（应水平）
- [ ] 按曲线校准 §3 常数表 + `RESERVE`（`MAX_WORKERS` 公式输入）

## 3. 翻转链路

- [ ] 开 flag 跑长任务：软线 → 等收尾重启（零损失）；硬线 → 工具间隙截断 + 切段续接（只丢尾部）
- [ ] kill -9 worker 于 MR 建成瞬间 → 恢复后 `findOpenMR` 命中、无双建（e2e 单测已覆盖逻辑，真机覆盖端到端）
- [ ] 双杀（worker+主进程）→ WAL 完整恢复、坏 checkpoint 回退上一个
- [ ] 连续硬接力 3 次 → 第 4 次降级提示；单 task 每小时超 6 次 → 降级
- [ ] 灰线续接体验盲测：续接后完成质量 vs 连续跑不劣化

## 4. 44h 等价压测

- [ ] 跑法：合成负载（token 回放 + 工具循环）加速等价 44h，断言 `TOTAL_RSS_LIMIT` 内锯齿无单调增长
- [ ] N+1 workspace：maxWorkers 排队 + 空闲 LRU 逐出实测
