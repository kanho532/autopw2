# AutoPW v2.1 MCP-First 分阶段实施与里程碑方案

> 方案版本：2.1  
> 规格基线：AutoPW v2.1-rc5-mcp-first  
> 日期：2026-08-05  
> 产品主形态：Codex 本地 MCP 插件  
> 核心目标：以 MCP Tool 为唯一主要公共入口，通过持久 Control Plane、Durable Worker 和受管 Run Storage，分阶段完成可解释、可恢复、可门禁的自主 Web 质量审查系统。

---

## 一、实施定位

### 1.1 MCP 是主产品，不是包装层

项目的主要验收路径固定为：

```text
Codex / MCP Host
→ AutoPW MCP Tool
→ MCP Control Plane
→ Persistent Operation Registry
→ Durable Worker
→ Managed Run
→ Playwright
→ Audit / Report / Gate
→ MCP Status / Result Query
```

以下路径不能作为主要里程碑验收依据：

```text
直接调用内部 Core API
直接运行 Playwright 脚本
只通过 CLI 跑通审查
绕开 MCP Control Plane 创建 Run
```

CLI 仅承担安装、诊断、人工恢复和离线维护；Core API 仅是 Server/Worker 内部实现边界。

### 1.2 每个阶段必须交付 MCP 可演示纵切面

阶段完成不能以“类、接口或模块已经编写”为准。每个阶段都必须提供可由 MCP Host 发起的演示或验证，并能通过自动测试重复执行。

例如，最小审查纵切面必须经过：

```text
run_audit
→ accepted + run_handle
→ get_run_status
→ Worker 推进 Run
→ get_run_result
```

即使阶段内暂时使用固定 Discovery、固定 Plan 或 Fixture Planner，也不得绕过 MCP Tool 和持久 Operation。

### 1.3 里程碑必须二元可判定

每个里程碑只能是：

```text
PASSED
FAILED
```

不接受“基本完成”“大部分可用”“只差少量优化”。所有必选验收条件均通过后，里程碑才能标记为 PASSED。

### 1.4 公共协议优先于内部实现

以下内容一经对应里程碑冻结，不得在后续阶段随意破坏：

- MCP Tool 名称；
- Tool 输入与返回联合类型；
- Error Envelope；
- `client_request_id` 幂等语义；
- Run Handle 与 Workspace 授权语义；
- Run Phase、Run Status、Audit Status、Gate；
- 持久 JSON Schema；
- Logical Case 与 Execution Instance 的区分。

确需破坏兼容时，必须提升 Schema 或 Tool Contract 版本并提供迁移测试。

### 1.5 模型能力后接入

在以下能力稳定之前，不接入真实模型 Provider：

- MCP accepted/poll/result 协议；
- Operation Registry；
- Managed Run Storage；
- 确定性 Compiler；
- Playwright 执行；
- Evidence；
- Completion Audit；
- Gate。

真实 Planner 只替换 Candidate 选择步骤，不能成为状态机、执行或门禁正确性的前提。

### 1.6 安全授权由宿主决定

Workspace、Trust Mode、Auth Scope、Config Source 和资源预算均由 MCP Host Context 或安装策略注入。Agent、项目 Profile、页面内容和 Planner 均不得扩大授权。

实施中必须始终遵守：

```text
有效权限 = Host Context ∩ Server Policy ∩ Tool Request ∩ Profile Safety
```

Tool Request 和 Profile 只能收紧权限，不能放宽。

### 1.7 长任务独立于 MCP 会话

`run_audit` 返回 accepted 后：

- MCP transport 断开不取消 Run；
- Codex 会话关闭不删除 Run；
- MCP Server 重启后仍可查询 Operation；
- Worker 崩溃后 Run 可依据 lease 与 checkpoint 接管；
- 只有合法 `cancel_run` 才触发受控取消。

---

## 二、阶段总览

| 阶段 | 核心目标 | 主要 MCP 能力 | 里程碑 |
|---|---|---|---|
| Phase 0 | 冻结 MCP Tool、Host Contract、Schema 与威胁模型 | Tool Schema 静态验证 | M0：MCP Contract Frozen |
| Phase 1 | 建立 MCP Control Plane、Operation Registry 和持久句柄 | 工具注册、accepted、幂等、status fixture | M1：Persistent Control Plane |
| Phase 2 | 通过 MCP 跑通无模型的真实最小审查闭环 | `run_audit`、`get_run_status`、`get_run_result` | M2：MCP Audit Vertical Slice |
| Phase 3 | 完成覆盖预览、真实 Discovery、Derivation 和执行实例规划 | `derive_coverage`、`explain_run` 初版 | M3：Coverage Intelligence Ready |
| Phase 4 | 安全接入受约束 Planner 与 PlanTemplate Cache | Planner 驱动审查、失败可解释 | M4：Planner Safely Integrated |
| Phase 5 | 完成 Durable Worker、恢复、取消、清理和重启接管 | `resume_run`、`cancel_run`、`cleanup_run` | M5：Durable Operations |
| Phase 6 | 完成 Host Trust、untrusted PR、Adapter 沙箱和生产只读 | 安全拒绝、授权隔离 | M6：Security Boundary Enforced |
| Phase 7 | 完成 Agent 体验、分页、Artifact、诊断和 CI 适配 | 完整公共 MCP 工具面 | M7：Agent Workflow Complete |
| Phase 8 | 完成性能、全浏览器矩阵、长稳、兼容性和正式发布 | MCP-first v2.1 Final | M8：v2.1 MCP-First Released |

主依赖链：

```text
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8
```

允许并行的辅助工作：

```text
文档与 Demo App：Phase 0 后持续进行
Schema 测试生成器：Phase 0–1
Threat Model：Phase 0–6 持续更新
性能基准脚手架：Phase 2 后可提前建设
跨平台 CI：Phase 2 后可提前建设
```

任何阶段不得绕过主依赖链直接作为可发布功能合入。

---

# Phase 0：MCP 契约、Schema 与工程边界冻结

## 0.1 目标

把 MCP-first 规格转换成可以由实现、测试和插件宿主共同消费的正式契约。该阶段不执行浏览器审查，但必须消除所有需要实现团队自行猜测的公共语义。

## 0.2 实施范围

### A. MCP Tool Contract

冻结以下公共工具：

```text
derive_coverage
run_audit
get_operation_status
get_operation_result
get_run_status
get_run_result
resume_run
cancel_run
cleanup_run
explain_run
```

每个工具必须定义：

- Tool description；
- JSON Schema 输入；
- 成功返回联合类型；
- `kind=error` Error Envelope；
- 是否创建 Operation；
- 是否需要 `client_request_id`；
- 授权检查；
- 幂等语义；
- 返回大小上限；
- 可重试条件；
- 示例正例与负例。

### B. Host Context Contract

冻结：

```ts
McpHostContext
WorkspaceAuthorization
HostContextSnapshot
AuthScope
ResourceBudget
ConfigSource
```

必须明确：

- workspace ID 如何映射到 realpath；
- project subpath 如何规范化；
- trusted 与 untrusted_pr 如何决定；
- Profile 从 base、fixed、head 或 approved overlay 哪个版本读取；
- Agent 参数如何与宿主权限求交；
- Session-bound 和 installation-bound 的差异；
- Run 句柄跨会话查询规则；
- retention policy 的 Host 上限、Profile 只收紧覆盖与 tombstone 查询语义；
- full matrix 的 Host 硬预算和 Profile 软预算求交规则；
- lease 安全倍数、grace、clock skew 与连续 stale 确认规则。

### C. Schema Bundle

至少提供 Draft 2020-12 Schema：

```text
mcp-tool-common-request
mcp-error-envelope
mcp-operation
mcp-run-handle
mcp-status-view
mcp-result-view
profile
coverage-policy
route-map
scenario-contract
normalized-request
host-context-snapshot
input-versions
run-state
operation-record
retention-policy
artifact-tombstone
target-result
seed-result
discovery
derivation
planner-input
planner-output
plan-template
plan
mapping-audit
execution-manifest
execution-result
event
checkpoint
evidence-manifest
issues
terminalization
finalization-result
completion-audit
gate-draft
results
failure
cleanup-result
```

### D. 状态与结果契约

冻结：

- Operation Status；
- Run Phase；
- Run Status；
- Audit Status；
- Gate；
- Execution Status；
- Terminalization Reason；
- Fatal Failure 分类；
- 固定 Gate 优先级；
- P0 Coverage 公式；
- Logical Case 与 Execution Instance 对账规则。

### E. Threat Model 与 ADR

至少形成：

- ADR-001：MCP 是唯一主要公共入口；
- ADR-002：为什么采用 accepted + polling；
- ADR-003：Operation 与 Run 分离；
- ADR-004：为什么不使用哈希链；
- ADR-005：Logical Case 与 Execution Instance；
- ADR-006：Planner 只选择 Candidate ID；
- ADR-007：Host Trust Context 不可由仓库提权；
- ADR-008：恢复仅保证 at-least-once；
- ADR-009：质量 Gate 与 Fatal Failure 分离；
- ADR-010：CLI 仅为维护面；
- ADR-011：Discovery 与纯 Derivation 的性能预算分离；
- ADR-012：Lease TTL、Heartbeat、Grace 与接管确认的安全倍数；
- ADR-013：Full 矩阵实例预算与禁止静默裁剪；
- ADR-014：Retention Policy、Tombstone 与磁盘高水位行为；
- ADR-015：M0 冻结是受 ADR 治理的可实施基线，而非永久禁止修改。

Threat Model 至少覆盖：

- 恶意 MCP Tool 参数；
- 工作区越权；
- 恶意 Profile；
- 恶意 PR；
- 页面提示注入；
- Adapter 任意代码；
- 浏览器网络越界；
- Planner 输出攻击；
- Evidence 数据泄漏；
- Handle 猜测；
- 重放与幂等冲突；
- Server/Worker 重启中的状态损坏；
- heartbeat 抖动导致活跃 Worker 被误接管；
- full 矩阵乘性增长导致资源耗尽；
- Operation/Run/Evidence 长期增长与磁盘配额耗尽；
- 清理过程崩溃、重复执行或误删未过期 Gate 事实。

### F. 冻结与变更治理

M0 冻结的是可以实施和验证的契约基线，不代表后续实证永远不能修订。Phase 1–8 若发现基线不可实施，必须：

1. 新建 ADR，描述触发证据、兼容性影响和替代方案；
2. 提升受影响 Tool/Data Schema 或规格候选版本；
3. 更新 golden contract、迁移规则和已知限制；
4. 重跑所有受影响的 `verify:mN`，不能只验证当前阶段；
5. 禁止实现通过私有行为静默偏离冻结契约。

## 0.3 工程目录基线

建议目录：

```text
packages/
  mcp-server/
  mcp-contracts/
  control-plane/
  worker/
  core/
  schemas/
  run-storage/
  operation-registry/
  discovery/
  derivation/
  planner/
  compiler/
  execution-fixture/
  execution/
  audit/
  reporting/
  gate/
  security/
  maintenance-cli/

apps/
  demo-target/
  mcp-host-harness/

tests/
  contract/
  unit/
  integration/
  invariants/
  mcp-e2e/
  browser-e2e/
  security/
  fault-injection/
  performance/

fixtures/
  host-contexts/
  profiles/
  policies/
  contracts/
  discoveries/
  planner-outputs/
  run-states/
```

## 0.4 交付物

- MCP-first Final Draft；
- Tool Schema Bundle；
- 持久 Data Schema Bundle；
- Schema 生成的 TypeScript 类型；
- MCP Host Harness 空壳；
- 正例、负例和兼容性 Fixture；
- ADR 集合；
- Threat Model v1；
- `npm run verify:m0`。

## 0.5 必须通过的验证

1. 所有 Tool 示例通过 Tool Schema；
2. 所有持久 JSON 示例通过对应 Schema；
3. 所有 Schema 引用可解析；
4. 同一个 enum 在文档、Schema 和生成类型中一致；
5. 每个 Tool 的错误路径均有示例；
6. 每个持久文件均有唯一 Schema；
7. workspace/path/ID 长度和格式限制已固化；
8. 状态转换表无未定义转换；
9. Agent 不得通过 Tool 参数提升 trust/auth/network 权限；
10. CLI 不出现在主要用户工作流或主要验收路径中。

## 0.6 里程碑 M0：MCP Contract Frozen

全部满足才通过：

- `npm run verify:m0` 返回 0；
- Tool Contract 获得实现与插件宿主评审确认；
- Schema Bundle 无 unresolved reference；
- Threat Model 覆盖所有主要信任边界；
- 不存在需要 tool handler 自行猜测的异步、授权、幂等或错误语义；
- 所有后续 Phase 可只依据已冻结契约实施。

## 0.7 本阶段明确不做

- 不启动 Playwright；
- 不实现真实 Worker；
- 不调用 Planner；
- 不实现真实 Discovery；
- 不提供完整 CLI 审查命令。

---

# Phase 1：MCP Control Plane 与持久 Operation

## 1.1 目标

证明 MCP Server 可以安全接收工具请求、持久化 Operation、返回稳定句柄，并在 Server 重启后继续查询，而不依赖浏览器和业务编排。

## 1.2 实施范围

### A. MCP Server 基础

实现：

- Server 启动与工具注册；
- Tool Schema 运行时校验；
- `server_info` 内部能力握手；
- 安全启动检查；
- 结构化日志；
- 响应大小限制；
- 最小轮询间隔。

### B. Workspace Resolver

实现：

- 从 Host Context 查找 `workspace_id`；
- realpath 解析；
- `project_subpath` 越界阻断；
- symlink/junction/UNC/大小写处理；
- trust/auth/config source 快照；
- Host Context Digest。

### C. Operation Registry

实现：

- Operation 原子创建；
- `client_request_id` 唯一索引；
- 同 ID 同参数返回原 Operation；
- 同 ID 不同参数返回 `IDEMPOTENCY_CONFLICT`；
- Operation 状态更新 CAS；
- Server 启动时重建索引；
- `retention-policy.json` 解析、快照与 Schema 校验；
- Operation、Run Handle 和幂等记录的 TTL 索引；
- Artifact tombstone 与 `RESULT_EXPIRED` 查询语义；
- high/low watermark 容量状态；
- 只删除过期对象的 Fixture Sweeper。

### D. Queue 与 Worker Skeleton

实现：

- ACCEPTED → QUEUED/RUNNING 的任务模型；
- installation/workspace/global 并发预算；
- Fixture Worker；
- 可注入任务完成、失败和取消；
- status 聚合视图。

### E. MCP Fixture Tools

提供 Fixture 版本：

- `run_audit`：创建 Operation 和 Fixture Run；
- `get_operation_status` / `get_operation_result`：查询 Fixture Preview/运维 Operation；
- `get_run_status`：只读查询；
- `get_run_result`：返回 not_ready 或 Fixture Result；
- `cancel_run`：设置 Cancel Request；
- `derive_coverage`：Fixture Preview Operation。

## 1.3 交付物

- `packages/mcp-server`；
- `packages/control-plane`；
- `packages/operation-registry`；
- Host Context Resolver；
- Fixture Worker；
- MCP Host Harness；
- Operation Inspector 测试工具；
- Retention Policy Resolver 与 Fixture Sweeper；
- `npm run verify:m1`。

## 1.4 关键测试

### 幂等

- 相同 `client_request_id` 并发调用 20 次，只产生一个 Operation；
- Server 重启后重复调用仍返回原 Operation；
- 同 ID 不同参数被拒绝。

### 授权

- 未授权 workspace 被拒；
- `project_subpath=../../` 被拒；
- symlink 指向 workspace 外被拒；
- Agent 指定 trusted 不能提升 untrusted_pr；
- Agent 指定未批准 auth scope 被拒。

### 持久性

- accepted 返回前 Operation 已落盘；
- accepted 后立即杀死 Server，重启仍可查询；
- Operation 不依赖 Session 内存；
- transport 断开不取消 Operation。

### 背压与 Retention

- 超出并发预算时排队或返回受控资源错误；
- 不产生重复 Worker；
- 大响应被分页或截断；
- 幂等记录 TTL 不短于对应 Operation/Run 可查询期；
- high watermark 且没有过期对象可清理时拒绝新 Run；
- sweeper 不删除未过期的 results/failure/Gate 事实；
- Artifact 删除后保留 tombstone，并返回 `RESULT_EXPIRED`。

## 1.5 里程碑 M1：Persistent Control Plane

全部满足才通过：

- MCP Host Harness 可调用 Fixture `run_audit`；
- Server 返回 accepted 和稳定 Operation/Run Handle；
- `get_run_status` 可在新 MCP Session 中查询；
- 重启 Server 后 Operation 仍存在；
- 幂等、授权和背压测试全部通过；
- tool handler 内不存在长任务浏览器逻辑；
- Retention Fixture Sweeper、配额拒绝和 tombstone 查询测试全部通过；
- `npm run verify:m1` 返回 0。

## 1.6 本阶段明确不做

- 不执行真实 Playwright；
- 不生成真实 Gate；
- 不做真实 Discovery；
- 不接入 Planner；
- 不实现完整恢复。

---

# Phase 2：MCP 最小真实审查纵切面

## 2.1 目标

首次通过 MCP 完成一个真实、受管、可查询的浏览器审查闭环。该阶段使用固定 Discovery 和固定 Plan，以隔离覆盖推导和模型复杂性。

## 2.2 最小闭环

```text
run_audit
→ accepted
→ get_run_status 轮询
→ Worker 领取 Run
→ 固定 Logical Cases
→ 确定性 Compiler
→ Chromium 执行
→ Evidence Manifest
→ Completion Audit
→ Report
→ Gate
→ get_run_status
→ get_run_result
```

## 2.3 实施范围

### A. Managed Run Storage

实现：

- Run Directory 创建；
- request/host context/input versions 快照；
- `run_state.json` 原子写；
- state version/CAS；
- events JSONL；
- lease/heartbeat 基础；
- Artifact 路径锚定；
- Schema-on-write 和 Schema-on-read。

### B. 固定计划

使用版本化 Fixture：

- 2–4 个 Logical Case；
- 仅 Chromium；
- 单 viewport；
- normal 与 required_field；
- 一个通过、一个产品失败、一个 Console Error 场景；
- 固定 Candidate 和 coverage binding。

### C. Deterministic Compiler

实现：

- Frozen Plan → Playwright Suite；
- 只允许 execution fixture import；
- 禁止 node:*、child_process、动态 require；
- 自动注入 case/step/coverage 标记；
- Mapping Audit。

### D. Execution

实现：

- BrowserContext 隔离；
- screenshot、console、network；
- execution manifest；
- execution result；
- checkpoint；
- 测试失败不阻止其他测试启动。

### E. Audit、Report 与 Gate

实现：

- Logical Case 集合对账；
- Execution Instance 集合对账；
- failure evidence 检查；
- PRODUCT_DEFECT 分类；
- COMPLETE/INCOMPLETE；
- `results.json`；
- `report.md` 和最小 HTML 报告；
- MCP Result View。

## 2.4 Demo Target

Demo App 至少包含：

- 正常导航/表单成功；
- required_field 错误；
- 可切换产品缺陷；
- 可切换 JS Console Error；
- 稳定 `data-testid`；
- 固定 Seed 数据；
- 可由测试安全启动和关闭。

## 2.5 交付物

- Run Storage；
- Worker v1；
- Compiler v1；
- Execution Fixture；
- Playwright Runner；
- Evidence Collector；
- Audit/Gate v1；
- MCP E2E Harness；
- Demo Target；
- `npm run verify:m2`。

## 2.6 关键验收场景

1. `run_audit` 在同步预算内返回 accepted；
2. MCP Client 断开后 Run 继续；
3. 新 Session 可查询进度；
4. Product Defect 对应 COMPLETE + fail；
5. 未执行 Case 对应 INCOMPLETE + incomplete；
6. 每个失败均有规定证据；
7. 首个 Case 失败不阻止其他 Case；
8. `results.json` 与 MCP 返回 Gate 一致；
9. 生成测试含禁止 import 时被拒；
10. MCP tool handler 不直接推进 Run Phase。

## 2.7 里程碑 M2：MCP Audit Vertical Slice

全部满足才通过：

- 仅通过 MCP Host Harness 可启动、查询并取得真实审查结果；
- 关闭 Client 不影响 Run；
- 至少完成 pass、fail、incomplete 三种真实结果；
- Logical Case 与 Execution Instance 对账正确；
- Evidence 和 Report 可访问；
- 所有 Phase 转换和 Gate 不变量通过；
- `npm run verify:m2` 返回 0。

## 2.8 本阶段明确不做

- 不做真实 Discovery；
- 不接入 Diff；
- 不调用真实 Planner；
- 不做跨浏览器矩阵；
- 不支持 untrusted PR。

---

# Phase 3：Coverage Preview、Discovery 与 Derivation

## 3.1 目标

让 Agent 能在执行前通过 `derive_coverage` 看见“测什么、为什么测、哪些无法安全测试”，并让正式 Run 使用同一套 Discovery 和 Derivation 规则。

## 3.2 实施范围

### A. Preview Operation

实现：

- `derive_coverage` start/wait；
- Preview Registry；
- Preview Lease；
- `get_operation_status` / `get_operation_result` 查询闭环；
- CDD Draft；
- 长输出截断与 Artifact 引用；
- Preview 不创建 Gate。

### B. Discovery

实现：

- route crawl 限制；
- Page、Control、Locator Candidate；
- Route/Action/Input/Expectation/Endpoint Candidate；
- Validation Text；
- API Observation；
- scenario-level observation；
- objective blocker；
- allowed origin/network guard；
- 原始页面内容标记为 untrusted；
- 分阶段计时：`preflight_ms`、`discovery_wall_ms`、`serialization_ms`；
- Discovery page/depth/route/timeout budget 与明确超限结果。

### C. Derivation Engine

实现：

- feature × scenario 矩阵；
- effective tier 先计算后裁剪；
- P0/P1/P2；
- PLANNED/BLOCKED/NOT_APPLICABLE/TIER_SKIPPED；
- weak validation；
- mandatory capability；
- CDD Draft；
- 纯推导计时 `derivation_cpu_ms`，基准输入必须是已通过 Schema 校验的 `discovery.json`；
- Derivation 性能测试不得包含浏览器和页面等待。

### D. Diff Analyzer

实现：

- base/head 文件变化；
- route-map glob；
- rename/delete；
- new feature 判定；
- propagate；
- empty diff → NOOP；
- mandatory capability 与收窄范围的关系。

### E. Execution Instance Planner

实现：

- effective tier → batch；
- browser/viewport/locale/auth scope；
- stable `execution_id`；
- full matrix 展开；
- 创建 Run 前计算 `projected_execution_instances`；
- Host `maxExecutionInstancesPerRun` 与 Profile `matrix_budget.max_execution_instances` 求最小有效预算；
- 超限返回 `MATRIX_BUDGET_EXCEEDED` 和分维度投影，不创建 Run；
- full 禁止静默裁剪、抽样、pairwise 或自动降档；
- Case 与 Instance 双重对账。

## 3.3 Preview 与正式 Run 一致性

若以下输入版本一致：

```text
workspace
profile digest
policy digest
contract digest
route-map digest
diff ref/base/head
auth scope
tier
engine version
```

正式 Run 的 Derivation 必须与 Preview 保持一致，除非目标内容发生变化。发生变化时必须在结果中声明 Preview Stale，而不能静默偏离。

## 3.4 交付物

- Preview Operation Service；
- Discovery Service；
- Candidate Catalog；
- Derivation Engine；
- Diff Analyzer；
- CDD Generator；
- Execution Instance Planner；
- `explain_run` 初版；
- `npm run verify:m3`。

## 3.5 关键测试

- P0 OBSERVED 不能被 blocker 替代；
- P0 required blocker 导致 incomplete；
- smoke/fast/full scenario 裁剪正确；
- fast 下新功能 fast、受影响旧功能 smoke；
- full 下按 full 展开；
- empty diff 不创建 Run；
- Preview 与正式 Run 一致；
- Discovery 不越界抓取；
- 同名控件产生唯一候选或明确歧义；
- 页面指令文本不进入控制字段；
- `derive_coverage` 分别报告 Discovery 与 Derivation 耗时；
- 纯 Derivation 标准数据集 P95 ≤2s，不把真实页面耗时计入；
- full 多浏览器实例数正确；
- 实例投影超预算时 Preflight 阻断且没有受管 Run；
- full 超预算时不得静默降档或裁剪。

## 3.6 里程碑 M3：Coverage Intelligence Ready

全部满足才通过：

- Agent 可通过 MCP 获得真实覆盖预览；
- 每个 Planned Case 有完整 Derivation；
- Preview 与 Run 的输入版本和偏差可解释；
- Diff、effective tier、scenario observation 正确；
- full 模式 Logical Case/Execution Instance 展开正确；
- Matrix Budget 超限具有稳定错误码、分解投影和收窄建议；
- Discovery/Derivation 指标已显式拆分，2 秒只约束纯推导内核；
- MCP 返回不嵌入无限页面正文；
- `npm run verify:m3` 返回 0。

## 3.7 本阶段明确不做

- 不接入真实模型；
- 不实现最终 Plan Cache；
- 不支持 Worker 跨进程接管；
- 不开放 untrusted PR Adapter。

---

# Phase 4：受约束 Planner 与计划缓存

## 4.1 目标

在不扩大模型权限的前提下，用 Planner 从 Candidate Catalog 中选择可执行步骤，并保证模型失败、超时或恶意输出不会破坏 Run 可信度。

## 4.2 实施范围

### A. PlannerProvider

实现：

- Provider Interface；
- DeterministicFixturePlanner；
- 至少一个真实 Provider；
- Provider 安装配置；
- model/version/timeout/token 预算；
- temperature=0；
- 结构化输出；
- 调用审计摘要。

不得假设 MCP Server 可以直接反向调用当前 Codex 会话中的模型。

### B. Candidate-only Planner

Planner 只允许返回：

```text
action_candidate_id
control_id
locator_candidate_id
input_candidate_id
expectation_candidate_id
endpoint_candidate_id
有限枚举描述
```

禁止返回：

```text
任意 CSS/XPath
任意 URL
任意文件路径
任意 JavaScript/TypeScript
Shell 命令
Node import
新的 Feature/Scenario/Tier
```

### C. Plan Validator

实现：

- Candidate 存在性；
- Route 绑定；
- Locator 唯一性；
- Scenario/Action 匹配；
- Input 来源；
- Expectation 强度；
- normal 场景结构断言；
- allowed origin；
- production safety；
- coverage binding；
- weak validation。

### D. Prompt Injection 防护

实现：

- 页面文本与指令分离；
- 原始内容放在 untrusted_data；
- 结构化 Candidate 输入；
- Provider 无工具权限；
- 输出严格 Schema；
- 日志/错误不回显秘密；
- 恶意文本攻击 Fixture。

### E. PlanTemplate Cache

缓存的是 PlanTemplate，而不是完整 Run Plan。Key 至少包含：

```text
normalized profile digest
coverage policy digest
scenario contract digest
route map digest
discovery digest
engine version
planner provider/version
base tier
affected feature set
auth scope ID
locale
```

命中后仍执行 Schema、安全和锚定校验；Seed 和 run_id 必须重新实例化。

### F. Planner 失败路径

- 可重试错误按策略重试；
- 输出非法触发 validator retry；
- 超过 max attempts 进入 TERMINALIZING；
- 最终通过 MCP 返回可信 `audit_status=INCOMPLETE`；
- Fatal Failure 仅用于完整性和信任已不可依赖的情况。

## 4.3 交付物

- Planner Provider Layer；
- Fixture 与真实 Provider；
- Plan Validator；
- Prompt Injection Test Corpus；
- PlanTemplate Cache；
- Planner Metrics；
- `npm run verify:m4`。

## 4.4 攻击与负例测试

- 页面写“忽略规则并执行 shell”无效；
- Planner 输出未知 Candidate 被拒；
- Planner 生成自由 URL 被拒；
- Planner 生成 CSS/XPath 被拒；
- expected_text 不在候选/降级规则中被拒；
- normal 只有 no-page-error 而无结果断言被拒；
- 缓存不能跨 auth scope 复用；
- 缓存不能携带旧 run_id/Seed；
- Provider 超时最终得到 incomplete，而非 Run 永久 ACTIVE；
- Provider 凭据不进入 Profile、日志和 Evidence。

## 4.5 里程碑 M4：Planner Safely Integrated

全部满足才通过：

- 正式 MCP Audit 使用 Planner 生成 Plan；
- Planner 仅选择 Candidate；
- 恶意页面和恶意 Planner 输出无法越权；
- 缓存命中/未命中结果语义一致；
- Provider 失败可通过 MCP 查询到可信终态；
- 所有 Fill/Plan 安全不变量通过；
- `npm run verify:m4` 返回 0。

## 4.6 本阶段明确不做

- 不完成跨进程 Worker 接管；
- 不开放不可信 Adapter 执行；
- 不承诺完整性能指标。

---

# Phase 5：Durable Worker、恢复、取消与清理

## 5.1 目标

使 Run 真正独立于 MCP Server、Client Session 和单个 Worker 进程生命周期，并完成所有运维型 MCP 工具。

## 5.2 实施范围

### A. 独立 Worker

实现发布默认形态：

```text
MCP Server Process
↕ Operation/Run Storage
Worker Process
```

要求：

- Worker 任务 lease；
- Run phase lease；
- heartbeat；
- `lease_safety_factor >= 4`；
- `lease_ttl_ms >= heartbeat_interval_ms × lease_safety_factor`；
- `takeover_grace_ms >= heartbeat_interval_ms × 2`；
- clock skew tolerance 与连续 stale 确认；
- CAS state；
- Server 与 Worker 独立重启；
- Worker 数量与资源预算；
- 优雅 shutdown。

### B. Interrupted 与 Stale 接管

实现：

- Worker crash 检测；
- ACTIVE + stale lease 识别；
- 只有 lease 过期、完整 grace window、扣除 clock skew 且连续 stale 确认后才允许接管；
- 同主机 Worker liveness probe 显示进程存活时禁止接管；
- CAS 保证只有一个接管者；
- Run Status 转为 INTERRUPTED 或可接管；
- `resume_run` 提交恢复 Operation；
- Host Context 兼容检查；
- max resume attempts；
- 终态实例不重跑。

### C. At-least-once 与 Reset

定义并实现：

```text
SAFE_RETRY
RESET_REQUIRED
NON_RESUMABLE
```

- SAFE_RETRY：可直接重跑；
- RESET_REQUIRED：执行 reset adapter 后重跑；
- NON_RESUMABLE：中断后进入 incomplete；
- mutating Case 使用 Seed namespace/idempotency key；
- 不承诺 exactly-once。

### D. Cancel

`cancel_run`：

- 写 Cancel Request；
- Worker 在安全点检查；
- 未启动实例标记 CANCELLED；
- 运行实例优雅停止；
- 进入 TERMINALIZING；
- 完成 Finalization、Audit、Report、Gate；
- 不把取消伪造成 pass。

### E. Cleanup

`cleanup_run`：

- Seed Cleanup；
- 临时 Browser Data；
- Retention Policy；
- Evidence/Report 的过期清理；
- 不能修改冻结 results；
- 幂等；
- Cleanup 失败不改写已有 Gate。

### F. Runtime Finalization

实现：

- 浏览器关闭；
- Target shutdown；
- 临时资源释放；
- finalization-result；
- Seed cleanup 可以延迟；
- Finalization 失败的 Gate 映射；
- Fatal Failure 与普通 Infra 的区分。

## 5.3 交付物

- 独立 Worker Process；
- Lease/Heartbeat v2；
- Resume Service；
- Reset Adapter Contract；
- Cancel Service；
- Cleanup Service；
- Finalization Service；
- Crash Harness；
- `npm run verify:m5`。

## 5.4 故障场景

至少测试：

- Server accepted 后立即崩溃；
- Worker 在 Discovery 中崩溃；
- Worker 在浏览器副作用完成、checkpoint 前崩溃；
- Worker 在 Gate 提交后崩溃；
- lease 过期后两个恢复者竞争；
- 单次 heartbeat 延迟但 Worker 仍存活，必须保持 ACTIVE 且不得接管；
- heartbeat 延迟超过 TTL 但未满足 grace/连续确认，仍不得接管；
- stale 判定后两个恢复者 CAS 竞争，只有一个成功；
- mutating instance 接管后仍需 resumability/reset 判定；
- cancel 与 resume 并发；
- cancel 与 Gate 提交并发；
- cleanup 重复调用；
- 磁盘满；
- checkpoint 损坏；
- NON_RESUMABLE 实例中断。

## 5.5 里程碑 M5：Durable Operations

全部满足才通过：

- Server 与 Worker 任一重启不会丢失 accepted Run；
- stale Run 可通过 MCP 恢复；
- 同一 Run 不会被两个 Worker 并发推进；
- lease/heartbeat/grace 安全倍数不变量全部通过；
- 活跃 Worker 不会因单次心跳抖动被误判 INTERRUPTED；
- Cancel 最终产生 incomplete，而非假 pass；
- Cleanup 幂等且不修改 Gate；
- at-least-once/reset/non-resumable 行为符合规格；
- 100 次确定性崩溃注入无 pending 被标记完成；
- `npm run verify:m5` 返回 0。

## 5.6 本阶段明确不做

- 不开放 untrusted PR Adapter；
- 不完成所有 Agent 展示优化；
- 不冻结最终性能目标。

---

# Phase 6：MCP 安全边界与 untrusted PR

## 6.1 目标

确保 Agent、页面、Planner、项目仓库和外部 PR 均不能借助 MCP 工具、Profile、Adapter 或浏览器访问提升宿主权限。

## 6.2 实施范围

### A. Trust Resolver

实现：

- trusted；
- untrusted_pr；
- base/fixed/head/approved_overlay config source；
- Host Policy 优先；
- Profile 只能收紧；
- trust snapshot 持久化。

### B. untrusted PR 配置规则

不可信 PR 下：

- Profile 默认从 base/fixed 读取；
- Adapter 默认从 base/fixed 读取；
- startup command 不能来自 head；
- head 修改的 route-map/policy 是否允许由明确策略决定；
- 变更信任配置本身触发阻断或审批；
- 不继承宿主秘密环境变量。

### C. Adapter Sandbox

实现：

- 独立进程或受限容器；
- 环境变量 allowlist；
- 文件系统 roots；
- 禁止任意 child_process；
- 网络 allowlist；
- CPU/内存/时间限制；
- 返回 Schema；
- 审计日志；
- Seed/Reset/Assertion Adapter 分权。

### D. Browser Network Guard

覆盖：

- navigation；
- redirect；
- fetch/XHR；
- WebSocket；
- iframe；
- service worker；
- subresource；
- mock/abort endpoint；
- DNS rebinding 和 localhost 特殊地址策略。

### E. Auth Scope 与秘密

实现：

- Auth Scope ID；
- 凭据仅从安装/宿主秘密存储读取；
- Profile 只引用名称；
- runner environment allowlist；
- Cookie/Token 不进入 Tool 返回；
- Cache 按 auth scope 隔离。

### F. Evidence 与 Report 安全

实现：

- screenshot mask；
- console/network redaction；
- trace/video retention；
- HTML/Markdown 转义；
- CSP；
- URL scheme allowlist；
- Artifact 只能在授权 workspace/run 中读取；
- 不返回任意宿主路径；
- 目录权限与自动过期。

### G. Production Read-only

- `production=true` 强制 deny/read_only；
- mutating action 编译或执行时拒绝；
- Seed/Reset 默认禁用；
- 视频/trace 使用更严格策略；
- Profile 不能解除限制。

## 6.3 交付物

- Security Policy Engine；
- Trust Resolver；
- Adapter Sandbox；
- Browser Network Guard；
- Auth Scope Resolver；
- Redaction Pipeline；
- Secure Artifact Service；
- Production Read-only Policy；
- Security Test Corpus；
- Threat Model v2；
- `npm run verify:m6`。

## 6.4 攻击测试

至少包括：

- Agent 使用伪造 workspace_id；
- project_subpath 越界；
- symlink/junction 越界；
- PR 修改 Profile 读取宿主 Token；
- PR 修改 startup command 执行恶意脚本；
- Adapter 读取工作区外文件；
- Adapter 发起任意外网请求；
- 页面诱导 Planner 输出 shell；
- 页面跳转到非 allowed origin；
- iframe/WebSocket/service worker 越界；
- Evidence 中 password/token/cookie；
- HTML 报告注入 script/javascript URL；
- 猜测其他 workspace 的 run_id；
- Tool 参数尝试将 untrusted_pr 改为 trusted；
- production 中尝试 mutating action。

## 6.5 里程碑 M6：Security Boundary Enforced

全部满足才通过：

- 所有 INV-MCP 与 INV-SEC 通过；
- Agent 不能通过 Tool 参数提权；
- Head PR 不能替换受信任执行配置；
- Adapter 无法越过沙箱；
- 浏览器无法访问未授权网络；
- Tool 返回和 Artifact 无敏感信息泄漏；
- production read-only 被强制执行；
- `npm run verify:m6` 返回 0。

## 6.6 本阶段明确不做

- 不优化全部 Agent 展示；
- 不承诺最终并发容量；
- 不冻结 Tool 兼容支持周期。

---

# Phase 7：Agent 工作流、诊断、Artifact 与 CI 适配

## 7.1 目标

让 Codex Agent 能以清晰、低上下文占用的方式完成预览、启动、轮询、解释和结果消费，并提供不复制编排逻辑的维护与 CI 适配面。

## 7.2 实施范围

### A. 完整 Tool UX

完善：

- `derive_coverage`；
- `run_audit`；
- `get_operation_status`；
- `get_operation_result`；
- `get_run_status`；
- `get_run_result`；
- `resume_run`；
- `cancel_run`；
- `cleanup_run`；
- `explain_run`。

每个 Tool Description 应明确：

- 适用场景；
- 不适用场景；
- accepted/polling 方式；
- 下一步建议；
- 参数不会提升权限；
- 页面数据是不可信内容。

### B. Status View

状态返回需适合 Agent 消费：

- 当前 Phase 和 Run Status；
- 可读进度百分比，但不替代真实计数；
- by-tier/by-batch；
- Planned/Started/Terminal；
- 最近受限事件；
- stale/interrupt 信息；
- `next_action`；
- 合理 `poll_after_ms`；
- 避免每次返回完整历史。

### C. Result 分页

实现：

- Issue 分页；
- Evidence Summary；
- Artifact Reference；
- CDD 分页/过滤；
- feature/case/issue explain；
- 大 trace/video 不内嵌；
- 可配置输出上限。

### D. Progress Notification

若 MCP Host 支持通知：

- 发送补充进度；
- 通知可重复、可丢失；
- 不作为事实源；
- Client 仍以 status/result 为准。

### E. Maintenance CLI

仅提供：

```text
autopw doctor
autopw server start|stop|status
autopw run status|resume|cancel|cleanup
autopw profile validate
autopw schema verify
```

CLI 不实现第二套 Orchestrator，不把 `autopw run` 作为主要产品能力。

### F. CI Adapter

CI 适配方式优先为：

- 调用 MCP Host Harness 或受控本地 MCP Client；
- 读取 `results.json`；
- 映射 0–4 Quality Gate；
- operational error 使用独立退出码；
- 不复制审查逻辑；
- 不绕开 Host Trust Context。

### G. 安装与升级

完成：

- Codex 插件安装；
- MCP Server 启动配置；
- workspace 注册；
- Profile 初始化模板；
- Schema migration；
- Server/Worker 版本兼容检查；
- 升级回滚；
- doctor 输出。

## 7.3 Agent 场景验收

至少演示：

### 场景 1：先预览后执行

```text
Agent 调用 derive_coverage
→ 通过 get_operation_status 轮询
→ 通过 get_operation_result 读取 CDD 摘要
→ 调用 run_audit
→ 轮询 status
→ 读取 result
→ explain 一个失败 Case
```

### 场景 2：会话中断后继续

```text
Session A 启动 Run
→ Session A 关闭
→ Session B 查询同一 Run
→ 获取最终结果
```

### 场景 3：中断恢复

```text
Worker crash
→ status 显示 resume
→ Agent 调用 resume_run
→ 取得最终 Gate
```

### 场景 4：受控取消

```text
Agent 调用 cancel_run
→ status 显示 terminalizing
→ result 为 incomplete
```

### 场景 5：安全拒绝

```text
Agent 请求未授权 workspace/auth scope
→ Typed MCP Error
→ 不创建 Operation/Run
```

## 7.4 交付物

- 完整 Tool Description；
- Status/Result Pagination；
- Secure Artifact Service v2；
- Progress Notification Adapter；
- Maintenance CLI；
- CI Adapter；
- Codex 安装文档；
- Profile 初始化模板；
- Upgrade/Migration 工具；
- `npm run verify:m7`。

## 7.5 里程碑 M7：Agent Workflow Complete

全部满足才通过：

- 新项目可仅通过安装 MCP 插件、创建 Profile 和 Agent Tool 调用完成首次审查；
- Agent 无需调用 CLI 或内部 SDK；
- 大结果可分页且不会撑爆上下文；
- 会话断开/重连工作流成立；
- Explain 能回答 Case 出生证明和 Gate 原因；
- CI Adapter 不复制编排；
- doctor 和 migration 可诊断版本问题；
- `npm run verify:m7` 返回 0。

## 7.6 本阶段明确不做

- 不新增低层 MCP Tool；
- 不开放任意 Artifact 文件读取；
- 不通过 CLI 建立平行产品入口。

---

# Phase 8：性能、全矩阵、长稳与发布冻结

## 8.1 目标

在 MCP-first 架构下完成性能、稳定性、跨平台、兼容性和发布门禁，冻结 v2.1 Final。

## 8.2 实施范围

### A. 性能基准

标准环境固定：

- 4 vCPU / 8 GB RAM；
- 本地 Demo Target；
- 固定 Chromium 版本；
- Fixture Planner 用于核心基准；
- 真实 Provider 单独统计；
- 无外网依赖；
- 固定 Profile/Policy/Contract。

目标：

- smoke 端到端 P95 ≤60s；
- fast 端到端 P95 ≤180s；
- 标准本地 Demo Discovery：smoke P95 ≤15s、fast P95 ≤30s、full P95 ≤90s；
- 纯 Derivation Engine：从已验证 `discovery.json` 到 `derivation.json`，P95 ≤2s；
- `derive_coverage` 分别报告 `preflight_ms`、`discovery_wall_ms`、`derivation_cpu_ms`、`serialization_ms`；
- 真实项目 Discovery 只应用 timeout/page budget，不使用通用 2 秒契约；
- cache hit validate+compile P95 ≤5s；
- retention sweeper 在 100k tombstone 标准数据集上不阻塞 status P95；
- status 查询 P95 达到预定本地预算；
- accepted 返回 P95 达到预定同步预算；
- 并发 Run 不使 Control Plane 饥饿。

### B. 全浏览器矩阵

完成：

- Chromium；
- Firefox；
- WebKit；
- 多 viewport；
- locale；
- auth scope；
- mixed tier batch；
- 创建前实例数量投影；
- Host/Profile 有效实例预算；
- `MATRIX_BUDGET_EXCEEDED` 阻断路径；
- full 禁止静默裁剪、抽样或自动降档；
- Logical Case/Execution Instance 对账；
- batch failure 隔离。

### C. 长稳

至少执行：

- MCP Server 24 小时运行；
- Worker 循环重启；
- 多 workspace 并发；
- 频繁 status polling；
- Operation Registry 增长与清理；
- 100k tombstone/operation 标准数据集；
- Retention TTL 到期、tombstone 和 `RESULT_EXPIRED`；
- high/low watermark 与无可清理对象时拒绝新 Run；
- sweeper 中断后幂等恢复；
- 磁盘配额；
- Artifact retention；
- Handle 查询权限；
- Server 升级中的旧 Run 查询。

### D. 故障注入

包含：

- 进程崩溃；
- 网络断开；
- 浏览器崩溃；
- Planner 超时；
- heartbeat 失败；
- lease 竞争；
- 磁盘满；
- JSON 半写；
- Evidence 写失败；
- Report 生成失败；
- MCP transport 重连；
- Server/Worker 版本不匹配；
- 字符编码与极长页面文本。

### E. Tool 与 Data Schema 兼容

实现：

- Tool Contract golden tests；
- 向后兼容测试；
- unknown field 策略；
- Schema migration；
- Server/Worker 协议版本；
- Run Storage 版本升级；
- 不支持版本的安全拒绝。

### F. 发布材料

完成：

- MCP-first Final Spec；
- Tool Reference；
- Security Guide；
- Operations Guide；
- Profile/Policy/Contract Guide；
- Troubleshooting；
- Migration Guide；
- Release Notes；
- Threat Model Final；
- 已知限制。

## 8.3 发布门禁

每个 PR：

```text
lint
build
contract tests
unit
invariants
关键 integration
MCP vertical smoke
少量 deterministic fault injection
secret/dependency scan
```

主分支/每日：

```text
完整 MCP E2E
浏览器 E2E
100 次故障注入
全浏览器矩阵
性能基准
安全攻击套件
长时间恢复测试
npm audit --omit=dev
```

发布候选：

```text
全部测试
跨平台
升级/回滚
Schema compatibility
24h soak
untrusted PR 攻击套件
生产 read-only
文档链接与示例验证
```

## 8.4 里程碑 M8：v2.1 MCP-First Released

全部满足才通过：

- MCP E2E、恢复、安全、性能、兼容性全部通过；
- 关键核心模块覆盖率达到规格要求；
- 100 次故障注入无 completion/gate 误判；
- 全浏览器矩阵可通过 MCP 执行，且实例预算超限路径通过；
- Discovery 与纯 Derivation 的独立性能预算均通过；
- Retention Schema、配额、tombstone 和长稳清理测试通过；
- Tool Contract 和 Data Schema 已冻结；
- Upgrade/Rollback 演练通过；
- Threat Model 无未接受的 Critical/High 风险；
- Final Spec、Operations 和 Security 文档齐全；
- CLI 不成为发布主功能面；
- `npm run verify:v2.1` 返回 0。

---

## 三、里程碑验证脚本

建议固定脚本：

```json
{
  "scripts": {
    "verify:m0": "npm run contract && npm run schema:test && npm run docs:check",
    "verify:m1": "npm run verify:m0 && npm run test:mcp-control-plane",
    "verify:m2": "npm run verify:m1 && npm run test:mcp-vertical && npm run test:invariants-core",
    "verify:m3": "npm run verify:m2 && npm run test:discovery && npm run test:derivation && npm run test:preview",
    "verify:m4": "npm run verify:m3 && npm run test:planner-security && npm run test:plan-cache",
    "verify:m5": "npm run verify:m4 && npm run test:recovery && npm run test:cancel && npm run test:fault:deterministic",
    "verify:m6": "npm run verify:m5 && npm run test:security && npm run test:untrusted-pr",
    "verify:m7": "npm run verify:m6 && npm run test:agent-workflow && npm run test:mcp-contract-golden",
    "verify:v2.1": "npm run verify:m7 && npm run test:e2e:all && npm run test:fuzz && npm run test:perf && npm run test:soak"
  }
}
```

具体命令可按工程结构调整，但依赖关系不能弱化。

---

## 四、跨阶段 Definition of Done

任一阶段完成必须同时满足：

1. 新增持久文件具有正式 Schema；
2. 新增 MCP 返回具有 Tool Contract；
3. 正例和负例测试齐全；
4. 新增 Phase/Status/Error 进入状态转换测试；
5. 新增安全边界进入 Threat Model；
6. 新增工具可在 MCP Host Harness 中演示；
7. 不通过 CLI 或内部 API 绕过 MCP 验收；
8. 不在 tool handler 内实现长任务状态机；
9. accepted 前最小 Operation/Run 记录已持久化；
10. 页面、Planner 和日志内容均视为 untrusted；
11. 上一里程碑的验证脚本全部继续通过；
12. 文档、Schema、Tool Description 与实现同步。

---

## 五、风险清单与阶段控制

| 风险 | 最早控制阶段 | 强制措施 |
|---|---:|---|
| Tool handler 承担长任务导致调用超时丢 Run | Phase 1 | accepted 前持久化 + Worker Queue |
| 重复 MCP 调用创建重复 Run | Phase 1 | client_request_id 唯一索引 |
| MCP Session 断开导致任务取消 | Phase 1–2 | Operation/Run 独立于 Session |
| 逻辑 Case 与浏览器实例混淆 | Phase 2–3 | 双集合对账 |
| 模型编造选择器或代码 | Phase 4 | Candidate-only + Validator |
| 页面提示注入 | Phase 4 | untrusted_data + 无工具 Provider |
| Worker 崩溃后重复副作用 | Phase 5 | at-least-once + reset/non-resumable |
| Agent 通过 workspace/path 参数越权 | Phase 1、6 | Host Context 求交 + realpath guard |
| PR 修改 Profile/Adapter 窃取秘密 | Phase 6 | base/fixed config + sandbox |
| 浏览器访问未授权网络 | Phase 6 | 全面 Network Guard |
| Tool 返回过大挤占 Agent 上下文 | Phase 1、7 | limit + pagination + Artifact refs |
| Cache 跨认证身份污染 | Phase 4、6 | auth scope ID 隔离 |
| Fatal Failure 被伪造成质量 Gate | Phase 2 | failure.json 与 results.json 分离 |
| CLI 演化成第二套编排 | 全阶段 | CLI 只调用 Server/Storage 运维接口 |
| Schema 演进破坏旧 Run | Phase 0、8 | versioning + migration + golden tests |

---

## 六、推荐团队工作流

### 6.1 分支与 PR

每个 PR 应对应一个可验证的小目标，例如：

```text
mcp(operation-registry): implement idempotent create
storage(run-state): add CAS atomic commit
worker(execution): persist execution instance checkpoint
security(workspace): reject symlink escape
planner(validation): reject unknown candidate IDs
```

禁止一个 PR 同时实现多个 Phase 的主要纵切面。

### 6.2 评审顺序

代码评审按以下顺序：

1. 是否符合 MCP Tool Contract；
2. 是否符合状态机和持久化契约；
3. 是否引入权限扩大；
4. 是否破坏幂等、恢复或对账；
5. 是否有负例和故障测试；
6. 最后才检查一般代码风格。

### 6.3 阶段冻结

每个里程碑通过后创建：

```text
milestone-report-MN.md
contract-snapshot-MN/
test-evidence-MN/
known-limitations-MN.md
```

后续阶段如需修改已冻结契约，必须记录 ADR、提升受影响规格或 Schema 版本，并重新运行受影响的全部里程碑验证。M0 冻结不等于“永不修改”，而是禁止无 ADR、无迁移说明、无回归验证的隐式偏离。

---

## 七、最终交付定义

v2.1 Final 不以“能够运行一次测试”为完成标准，而必须证明：

```text
Agent 能通过 MCP 安全启动审查；
工具调用结束后 Run 仍然存在；
Agent 能跨会话查询和恢复；
覆盖方案具有确定性出生证明；
Planner 不能创建任意行为；
Playwright 执行实例可完整对账；
失败具有证据；
不完整不能被误判为通过；
不可信 PR、页面和 Adapter 不能提权；
机器 Gate 可被 CI 稳定消费；
CLI 仅是维护补充，而不是第二套产品。
```

只有 M0–M8 全部 PASSED，AutoPW v2.1 才可从 MCP-First Release Candidate 冻结为 Final。
