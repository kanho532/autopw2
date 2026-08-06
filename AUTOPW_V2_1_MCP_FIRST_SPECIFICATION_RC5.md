# AutoPW v2.1 技术规格（MCP-First Release Candidate）

> 版本：2.1-rc5-mcp-first ｜ 状态：冻结候选；完成 M0 契约验证后形成受 ADR 治理的冻结基线 ｜ 日期：2026-08-05
>
> 本文档是 AutoPW v2.1 的自包含技术规格候选。冻结后，任何实现偏离本文档均视为缺陷；冻结前发现的内部矛盾必须通过修改本文档解决，不允许由实现自行猜测。
>
> 本版本在 v2.0 基础上完成以下结构性修订：
>
> 1. **状态机闭合**：Profile 解析是创建 Run 前的纯操作；`INCOMPLETE` 是审计结果而非主相位；connect/manage、恢复和失败路径均有明确语义。
> 2. **真正的 per-case tier**：先计算 feature 的 effective tier，再按该 tier 裁剪 priority 和 scenario；执行时按 batch 分组调用 Playwright。
> 3. **受约束 Planner**：模型通过 `PlannerProvider` 选择候选 ID，不得生成任意选择器、代码、URL 或路径。
> 4. **门禁确定化**：门禁优先级固定为 incomplete > infra > fail > unstable > pass；PRODUCT 和 INCOMPLETE 不允许配置成 warn。
> 5. **scenario 级发现**：Discovery 不再用 feature 级 OBSERVED 代替全部场景的可测性。
> 6. **安全信任边界**：明确 trusted 与 untrusted_pr 两种模式；不可信 PR 不得执行其自带 Profile、Adapter 或启动脚本。
> 7. **缓存与恢复闭合**：缓存键使用规范化内容摘要；恢复语义明确为 at-least-once，并引入重置策略与不可恢复用例。
> 8. **正式契约化**：所有持久化文件必须有 JSON Schema Draft 2020-12；示例不再冒充 Schema。
> 9. **不采用哈希链**：内容摘要只用于缓存、完整性和版本锚定，不构成防篡改审计链。
10. **复审闭合执行实例与异常路径**：逻辑 Case 与跨浏览器执行实例分离；增加受控提前终止、Fatal Failure、恢复接管和报告安全规则。
11. **MCP-First 产品定位**：MCP Server 是唯一主要产品入口和控制平面；Run 由本地持久 Worker 执行，SDK 仅是内部核心接口，CLI 降为维护与故障排查工具。
12. **长任务协议化**：`run_audit` 默认立即返回持久 `run_handle`，通过 `get_run_status` / `get_run_result` 获取进度与结果；模型会话断开不得导致 Run 丢失。
13. **宿主授权不可伪造**：工作区根目录、Host Trust Context、认证范围和可用 Profile 由 MCP 宿主或安装配置注入，Agent 不得仅靠工具参数提权。
14. **Operation 查询闭合**：Preview、resume、cancel、cleanup 等非 Run 或辅助异步操作统一通过 `get_operation_status` / `get_operation_result` 查询，任何 accepted `operation_id` 都有后续读取路径。
15. **性能预算拆分**：真实 Discovery 的浏览器与页面等待耗时和纯 Derivation 计算耗时分别计量；`≤2s` 仅适用于已验证 Discovery 输入上的纯推导内核。
16. **Lease 接管安全窗**：lease TTL、heartbeat 间隔、时钟宽限和接管确认满足硬性倍数关系，活跃 Worker 不得因单次心跳抖动被误接管。
17. **Full 矩阵预算**：创建 Run 前计算 Execution Instance 投影数量；full 不允许静默裁剪或降档，超出 Host/Profile 有效预算时必须阻断并返回可解释结果。
18. **Retention 正式契约**：Operation、Run、Preview、Evidence、Cache 和幂等记录均受版本化 retention policy、TTL、配额和 tombstone 规则治理。
19. **冻结语义明确**：Phase 0 冻结的是可实施基线，不等于永久不可修改；后续实证发现必须通过 ADR、版本变更和受影响里程碑回归来修订。

## 开发语言与实现约定

AutoPW 的主要实现语言为 **TypeScript**。MCP Server、Control Plane、Operation Registry、Worker、Run Storage、Core、Discovery、Derivation、Planner、Compiler、Execution、Audit、Reporting 和 Gate 等运行时代码统一使用严格 TypeScript，并以类型检查和 lint 作为交付门槛。`.mjs` 仅用于生成器、验证器及必要的兼容性入口；新增核心运行时代码不得扩大 `.mjs` 范围。

第十五章的不变量是不可协商的硬约束。

---

## 开发语言约定

本项目主要实现语言为 **TypeScript**。实现层新增或修改核心模块时，应使用严格 TypeScript，并保持公共 MCP Tool、持久化 Data Schema、状态机和安全边界与本规格一致。

`.mjs` 仅作为生成器、验证器或兼容性过渡入口使用；现有 M1 `.mjs` 运行时实现属于迁移过渡，不改变 TypeScript 作为后续核心实现语言的约定。任何需要继续使用 `.mjs` 的核心实现，必须在开发变更中说明原因、影响范围和迁移计划。

## 目录

1. [概述与目标](#一概述与目标)
2. [术语与核心概念](#二术语与核心概念)
3. [总体架构](#三总体架构)
4. [MCP 公共工具契约](#四mcp-公共工具契约)
5. [MCP 控制平面、Worker 与会话模型](#五mcp-控制平面worker-与会话模型)
6. [内部 Core API 与维护 CLI](#六内部-core-api-与维护-cli)
7. [编排内核与状态机](#七编排内核与状态机)
8. [覆盖推导与 Discovery](#八覆盖推导与-discovery)
9. [Planner、填空与内容锚定](#九planner填空与内容锚定)
10. [执行策略引擎](#十执行策略引擎)
11. [Diff、门禁与流水线](#十一diff门禁与流水线)
12. [Profile 与安全契约](#十二profile-与安全契约)
13. [核心数据契约](#十三核心数据契约)
14. [错误、恢复与清理](#十四错误恢复与清理)
15. [测试要求](#十五测试要求强制)
16. [实施路线图](#十六实施路线图)
17. [附录](#附录-a-dogfood-实践映射)

---

## 一、概述与目标

### 1.1 定位

AutoPW 是以 **MCP Server 为主要产品形态**的 Codex 本地插件：Agent 通过少量高层 MCP 工具发起覆盖预览、启动审查、查询状态、取得结果和恢复中断 Run。浏览器、Planner、状态机、证据采集和门禁均运行在 MCP Server 管理的本地执行平面中。

AutoPW 不是“一个 CLI 工具外加 MCP 包装层”。MCP 是控制平面和稳定公共协议；CLI 只用于安装诊断、人工恢复和无 MCP 宿主时的维护，SDK/Core API 只用于 MCP Server 内部编排和测试扩展。

AutoPW 解决以下问题：

- Agent 自由浏览和自由生成测试时容易漏测、编造定位器或绕过安全约束；
- MCP 单次调用存在时限，完整 Web 审查却可能持续数分钟；
- Agent 会话、MCP 连接或宿主进程重连时，长任务不能丢失；
- 测试方案缺少可追溯来源，结果缺少统一证据和机器门禁；
- 工具参数可能被模型或页面内容诱导，扩大工作区、认证或网络权限。

标准 MCP 工作流：

```text
MCP Host 注入 Workspace / Trust / Auth Scope
→ Agent 调用 derive_coverage 预览范围
→ Agent 调用 run_audit 启动持久 Run
→ MCP Server 返回 run_handle
→ Worker 独立推进状态机并采集证据
→ Agent 轮询 get_run_status（审查 Run）或 get_operation_status（Preview/运维 Operation）
→ Agent 调用 get_run_result 或 get_operation_result 取得结果
→ 必要时 resume_run / cancel_run / cleanup_run
```

内部审查流程保持为：

```text
解析 Profile 与执行范围
→ 创建受管 Run
→ 准备目标与 Seed
→ Discovery 观测并生成候选
→ 确定性推导 feature × scenario 骨架
→ Planner 选择候选 ID
→ 硬校验并冻结计划
→ 确定性编译 Playwright Suite
→ 按 effective tier 分批执行
→ 采集证据与分类问题
→ 结构审计
→ 生成报告
→ 计算门禁
```

### 1.2 产品入口与能力边界

| 层级 | 定位 | 是否公共稳定接口 | 能力 |
|---|---|---:|---|
| MCP Tools | Agent/Codex 的主要入口 | 是 | 预览、启动、状态、结果、恢复、取消、清理 |
| MCP Control Plane | 校验工具请求、解析宿主上下文、分配 Run、维护句柄 | 是，但不直接暴露为工具 | 授权、幂等、并发、事件与结果路由 |
| Local Worker | 长任务执行平面 | 否 | 状态机、Discovery、Planner、Playwright、Audit、Gate |
| Core API | MCP Server 内部编排接口 | 否，版本可随 Server 演进 | 分步服务与 Provider 扩展 |
| Maintenance CLI | 安装诊断与人工恢复 | 仅运维兼容接口 | doctor、status、resume、cleanup、schema/profile 校验 |

MCP 工具只暴露高层意图，不暴露 `fill_plan`、`freeze_plan`、`compile_suite`、`execute_batch` 等低层相位函数。Agent 无法通过多次低层工具调用绕过相位门控、审计或安全策略。

MCP Server 是 Run 的逻辑所有者；具体执行可以由同进程 Worker 或独立本地 Worker 完成，但必须使用相同的持久 Run Storage、lease 和 Schema。Codex 会话关闭、工具调用超时或 MCP transport 重连不得自动取消已经 accepted 的 Run。

### 1.3 目标与衡量标准

| 目标 | 标准 |
|---|---|
| 快速 | 在标准基准环境中 smoke P95 ≤60s、fast P95 ≤180s；真实项目记录实际耗时但不以外部波动误判实现缺陷 |
| 可解释 | 每个 PLANNED case 都有 matrix cell、discovery evidence、effective tier、候选选择和覆盖绑定 |
| 可接入 | MCP 稳定工具契约、持久 run_handle、结构化结果、NOOP、Diff 收窄；维护 CLI 仅作补充 |
| 可信完成 | case ID 集合严格对账；未执行、缺证据、计划/测试缺陷均不能被标记为可信完成 |
| 安全 | Profile、Adapter、页面内容、目标网络和生成 Suite 均按不可信输入处理 |
| 可恢复 | 崩溃后依据原子快照和事件日志恢复；明确 at-least-once 限制 |

### 1.4 核心不变量

1. **受管相位不可跳过、不可逆序**。正常路径和受控提前终止路径都必须符合显式转换表。
2. **完成不等于通过**。产品缺陷可以对应 `audit_status=COMPLETE` 和 `gate=fail`；未执行或审查自身缺陷对应 `audit_status=INCOMPLETE`。
3. **矩阵决定测什么**。模型不得创建或删除 matrix cell，不得修改 priority、scenario 或 effective tier。
4. **模型只选择候选**。模型不得输出任意代码、CSS/XPath、自由 URL、宿主路径或系统命令。
5. **证据先于结论**。失败分类必须引用执行证据；证据采集失败会降低审查完整性。
6. **逻辑 Case 与执行实例分离**。一个 Case 在 full 浏览器/视口矩阵中可以展开为多个 Execution Instance；审计分别对账 Case 集合与 Execution Instance 集合。
7. **内核项目无关**。业务知识位于 Profile、Coverage Policy、Route Map、Scenario Contract。
8. **安全优先于继续执行**。普通产品失败不得阻止其他 Case；全局安全违规、信任破坏或存储完整性失败必须 fail closed。
9. **缓存不是事实源**。缓存命中后仍必须完成 Schema、安全、锚定和版本校验。
10. **恢复是 at-least-once**。无重置能力的中断副作用用例不得盲目重跑。
11. **机器结果优先于人类报告**。`results.json` 是唯一门禁事实源；报告必须转义不可信内容，且报告生成失败不得篡改已有审计事实。
12. **信任等级只能收紧，不能由项目配置提升**。CI/宿主提供的 Host Trust Context 优先于 Profile。
13. **Accepted Run 独立于工具调用生命周期**。`run_audit` 返回 accepted 后，客户端断开不能回滚或隐式取消 Run。
14. **工具请求不等于授权**。`workspace_id`、`project_subpath`、trust mode、auth scope 和可执行配置必须与 MCP Host Context 求交集；工具参数只能收紧，不能扩大。
15. **MCP 公共响应必须可重试且幂等**。创建型工具使用 `client_request_id`；重复请求不得创建重复 Run。


---

## 二、术语与核心概念

| 术语 | 定义 |
|---|---|
| Preflight | 创建受管 Run 前执行的 Profile、Diff、Host Trust Context 和目标参数解析 |
| Host Trust Context | 由 MCP Host 或安装策略注入、不可由项目或 Agent 提升的信任上下文 |
| Run | 一次受管执行，由 `run_id` 标识，产物位于独立 `run_directory` |
| NOOP Result | 空 Diff 或策略明确无需审查时返回的非受管结果，无 `run_id` 和 lease |
| Phase | Run 的已提交主相位；正常路径和 TERMINALIZING 分支均只允许单向前进 |
| Run Status | `ACTIVE / INTERRUPTED / FAILED / COMPLETED`，与 Phase 正交 |
| Audit Status | `COMPLETE / INCOMPLETE`，由结构审计产生，不是 Phase |
| Terminalization | 已获得足够结构化信息、但无法继续正常流水线时进入的受控提前终止分支，最终仍生成 incomplete/infra 等 Gate |
| Fatal Failure | 信任、目录、Schema bundle、状态存储等完整性已不可信时的 fail-closed 终止；不生成质量 Gate，生成 `failure.json` |
| Feature | 被测功能单元，包含 id、capability、priority、route 和 signals |
| Scenario | normal、required_field、invalid_input、boundary、empty_state、service_error、network_failure |
| Base Tier | 用户请求的 run 基准档位：smoke、fast、full |
| Effective Tier | 针对每个 feature 计算的实际档位，用于裁剪 priority、scenario 和执行配置 |
| Logical Case | 一个 feature × scenario 的计划用例，由稳定 `case_id` 标识 |
| Execution Batch | effective tier、browser、viewport、locale、auth scope 等配置相同的一组执行实例 |
| Execution Instance | Logical Case 在某个 Batch 中的一次必需执行，由 `execution_id` 标识；full 矩阵中一个 Case 可有多个实例 |
| Discovery | 对页面、控件、API、验证文案和场景可测性的结构化观测 |
| Candidate | Discovery 或 Contract 产生的受控候选，如 action、control、locator、input、expectation、endpoint |
| Planner | 选择候选 ID 并形成计划的受约束决策器，可由模型或确定性实现提供 |
| Derivation | case 的出生证明：matrix cell、scope、effective tier、发现证据、理由 |
| CDD Draft | COVERAGE_DERIVED 时生成的覆盖推导草案，不含最终 step 绑定 |
| CDD Final | PLAN_FROZEN 后生成，补充 action/expectation step 绑定 |
| Weak Validation | 使用结构性或受控正则降级断言产生的警告，不代表无断言 |
| Objective Blocker | 因缺少必要观测或契约而无法安全生成 case 的客观阻断 |
| Evidence | error、截图、console、network、trace、video、runner log、route match 等证据 |
| Lease | 防止同一 Run 被多个执行者并发推进的租约 |
| Content Digest | 规范化内容摘要，用于缓存、损坏检测和版本锚定，不构成哈希链 |
| Auth Scope ID | 由宿主基于账号角色、租户和认证状态生成的非秘密稳定标识，不得直接使用 Cookie/Token，也不得由页面任意指定 |
| MCP Host Context | 由 Codex/宿主在建立 MCP 会话时注入的可信上下文，包含允许工作区、信任模式、认证范围、调用者与策略版本 |
| MCP Session | 一次 transport 会话；不是 Run 的生命周期边界 |
| Run Handle | 返回给 Agent 的稳定句柄，至少包含 `run_id` 和不可猜测的 `handle_token` 或由本地会话绑定的等价引用 |
| Client Request ID | 创建型 MCP 调用的幂等键；同一宿主、同一工具和同一 ID 必须返回同一操作结果 |
| MCP Operation | 预览或审查等可能跨调用完成的操作；状态为 ACCEPTED/RUNNING/COMPLETED/FAILED/CANCELLED |

---

## 三、总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                       Codex / MCP Host                              │
│ workspace allowlist │ host trust │ auth scope │ caller/session     │
└───────────────────────────────┬────────────────────────────────────┘
                                │ MCP transport
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                  AutoPW MCP Control Plane                          │
│ tool schema │ authorization intersection │ idempotency │ handles    │
│ concurrency │ operation registry │ status/result routing           │
└──────────────┬───────────────────────────────┬─────────────────────┘
               │ enqueue/lease                 │ read-only queries
               ▼                               ▼
┌──────────────────────────────┐   ┌─────────────────────────────────┐
│ Durable Local Worker        │   │ Run/Operation Storage           │
│ orchestration state machine │   │ atomic JSON │ CAS │ events      │
│ discovery/planner/compiler  │   │ lease │ evidence │ reports      │
│ Playwright batches          │   └─────────────────────────────────┘
└──────────────┬───────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Target + Playwright Browser                                        │
│ execution fixture │ network guard │ evidence collectors            │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Audit │ Issue Classification │ Report │ Gate                        │
└────────────────────────────────────────────────────────────────────┘

      Optional maintenance surfaces（非主要产品入口）
┌──────────────────────┐             ┌───────────────────────────────┐
│ Maintenance CLI      │             │ Internal Core API             │
│ doctor/status/resume │             │ MCP Server/Worker 内部使用     │
└──────────────────────┘             └───────────────────────────────┘
```

### 3.1 MCP Control Plane 职责

- 校验 MCP 工具输入 Schema；
- 从 MCP Host Context 解析允许工作区、信任模式和 auth scope；
- 将工具参数与宿主授权求交集，拒绝任何提权；
- 对创建型调用执行 `client_request_id` 幂等去重；
- 创建 Operation/Run Handle，并将工作交给持久 Worker；
- 限制并发 Run、浏览器数量、磁盘配额和单调用输出大小；
- 提供状态、结果、取消和恢复路由；
- 对所有返回中的页面内容、日志和报告摘要标记为非可信数据；
- MCP Server 重启后从 Operation Registry 和 Run Storage 恢复可查询状态。

### 3.2 Worker 与编排内核职责

- Worker 是唯一允许推进 Run Phase 的执行者；MCP tool handler 不直接执行低层相位；
- 使用 lease、heartbeat、CAS 和原子产物提交保证单写者；
- 执行 Preflight、Discovery、Derivation、Planner、Compiler、Playwright、Audit、Report、Gate；
- 对普通产品失败继续执行其他 Case；对安全、信任或存储完整性失败 fail closed；
- accepted Run 即使客户端断开也继续运行，除非收到合法 `cancel_run` 或宿主关闭策略要求取消。

### 3.3 Internal Core 职责

- **Preflight**：解析规范化 Profile、Diff 和执行范围；宿主信任值由 Control Plane 注入；
- **Run Storage**：目录锚定、Schema 校验、原子写、状态 CAS；
- **Discovery Service**：输出结构化数据和候选；
- **Derivation Engine**：完全确定性，不调用模型；
- **PlannerProvider**：只返回候选引用；
- **Compiler**：从冻结计划确定性生成测试；
- **Execution Batch Planner**：展开 mixed tier 与 browser/viewport 实例；
- **Audit/Gate**：对账并生成唯一机器事实源。

### 3.4 部署形态

最小部署为单个本地 MCP Server 进程，其中包含 Control Plane 和嵌入式 Worker。可靠模式允许 MCP Server 与 Worker 分进程，但二者必须共享同一受保护的本地数据根目录。

```text
embedded：MCP Server + Worker（开发默认）
durable：MCP Server + Worker Process（发布默认）
```

不得把长任务仅保存在 tool handler 的内存 Promise 中。`run_audit` 返回 accepted 前，Operation 和 Run 的最小持久记录必须已经原子落盘。

## 四、MCP 公共工具契约

MCP 是 AutoPW 的唯一主要公共入口。所有工具输入使用 `snake_case`，输出使用带 `schema_version` 和 `kind` 的显式联合类型。任何页面文本、控制台内容、网络响应和报告摘录都必须放在 `untrusted_data` 或明确的证据字段中，不能混入工具控制指令。

### 4.1 公共工具集合

| 工具 | 类型 | 作用 |
|---|---|---|
| `derive_coverage` | 创建型/可异步 | 预览范围、骨架、blocker、候选摘要和 CDD Draft |
| `run_audit` | 创建型/异步默认 | 创建并启动完整受管 Run |
| `get_operation_status` | 查询型 | 查询 Preview、resume、cancel、cleanup 等 Operation 的状态 |
| `get_operation_result` | 查询型 | 读取已完成非 Run Operation 的结果或结果引用 |
| `get_run_status` | 查询型 | 查询 Phase、Run Status、执行计数、进度和下一动作 |
| `get_run_result` | 查询型 | 在 GATED 后返回机器结果和报告路径；失败时返回 failure 摘要 |
| `resume_run` | 创建型 | 接管 stale/interrupted Run 并继续未完成执行 |
| `cancel_run` | 创建型 | 请求受控取消，进入 TERMINALIZING，而不是直接杀死并伪造结果 |
| `cleanup_run` | 创建型 | 幂等清理 Seed、临时浏览器数据和满足保留策略的产物 |
| `explain_run` | 查询型 | 返回 CDD、Case 出生证明和 Gate 解释的受限视图 |

不得公开：`fill_plan`、`freeze_plan`、`compile_suite`、`execute_batch`、`commit_gate`、任意文件读写或任意 Shell 工具。

### 4.2 公共请求头

所有创建型工具必须包含或由宿主自动补充：

```json
{
  "schema_version": "2.1",
  "client_request_id": "uuid-or-host-stable-id",
  "workspace_id": "host-issued-id"
}
```

规则：

1. `client_request_id` 在同一 MCP installation、workspace 和 tool 下唯一；
2. 重复调用返回同一 Operation/Run，不得重复创建；
3. `workspace_id` 必须存在于 MCP Host Context，Agent 不能使用任意文件路径替代授权；
4. 可选 `project_subpath` 必须在授权 workspace realpath 内；
5. 工具参数中的 trust、auth、network、production 选项只能收紧宿主策略。

### 4.3 `derive_coverage`

输入：

```json
{
  "schema_version": "2.1",
  "client_request_id": "string",
  "workspace_id": "string",
  "project_subpath": ".",
  "profile_path": ".autopw/profile.yaml",
  "tier": "smoke",
  "diff_ref": "origin/main...HEAD",
  "execution_mode": "start"
}
```

- `execution_mode=start` 为默认：持久化 Preview Operation 后立即返回 handle；
- `execution_mode=wait` 仅允许在 Server 配置的同步预算内等待；超出预算必须返回 accepted，而不是超时丢失；
- Preview 不创建质量 Gate，不持有 Run execution lease；它可持有独立 preview lease；
- 返回不得包含完整原始页面正文，只返回有长度限制的候选摘要和 CDD 路径。

Accepted：

```json
{
  "schema_version": "2.1",
  "kind": "accepted",
  "operation_type": "coverage_preview",
  "operation_id": "OP-...",
  "status": "ACCEPTED",
  "poll_after_ms": 1000,
  "next_action": "get_operation_status"
}
```

Completed：

```json
{
  "schema_version": "2.1",
  "kind": "coverage_preview",
  "operation_id": "OP-...",
  "status": "COMPLETED",
  "summary": {
    "planned": 0,
    "objective_blockers": 0,
    "not_applicable": 0,
    "tier_skipped": 0,
    "weak_validation": 0
  },
  "cdd_path": "string",
  "preview_path": "string",
  "untrusted_data": {
    "candidate_summaries": []
  }
}
```

### 4.4 `run_audit`

输入：

```json
{
  "schema_version": "2.1",
  "client_request_id": "string",
  "workspace_id": "string",
  "project_subpath": ".",
  "profile_path": ".autopw/profile.yaml",
  "tier": "fast",
  "diff_ref": "origin/main...HEAD",
  "start_policy": "immediate"
}
```

`run_audit` 默认且推荐始终异步启动。它必须在以下内容原子落盘后才返回 accepted：

- operation record；
- `run_id`、`run_directory`；
- 规范化请求摘要；
- Host Context 摘要；
- 初始 lease 或可领取任务记录。

返回：

```json
{
  "schema_version": "2.1",
  "kind": "accepted",
  "operation_type": "audit",
  "operation_id": "OP-...",
  "run_handle": {
    "run_id": "RUN-...",
    "workspace_id": "string"
  },
  "phase": "CREATED",
  "run_status": "ACTIVE",
  "poll_after_ms": 1500,
  "next_action": "get_run_status"
}
```

空 Diff 返回 `kind=noop`，不创建 Run。Preflight 错误返回 typed MCP error；Fatal Failure 不得伪造成 Gate。

### 4.5 `get_operation_status`

用于查询 `coverage_preview`、`resume`、`cancel`、`cleanup` 等 Operation。它不推进 Run Phase，也不隐式重试。

输入：

```json
{
  "schema_version": "2.1",
  "workspace_id": "string",
  "operation_id": "OP-..."
}
```

返回至少包含：

- `operation_type`、`status`、`created_at`、`updated_at`；
- 关联 `run_id`（若存在）；
- `progress` 和受限事件摘要；
- `next_action`：`poll / get_operation_result / get_run_status / get_run_result / none`；
- `poll_after_ms`；
- typed error reference（若失败）。

查询必须验证当前 Host Context 对 Operation 所属 workspace 的访问权。Operation ID 不得作为绕过 workspace 授权的 bearer secret。

### 4.6 `get_operation_result`

用于读取已完成的非 Run Operation 结果：

- `coverage_preview`：返回覆盖摘要、CDD Draft 和受控 Candidate 摘要；
- `resume`：返回恢复是否已被接受、关联 Run 和当前状态；
- `cancel`：返回取消请求提交及最终 terminalization 引用；
- `cleanup`：返回 `cleanup-result.json` 摘要；
- 未终态时返回 `kind=not_ready` 和建议轮询时间；
- 结果过大时返回分页信息或受控 Artifact 引用。

`get_operation_result` 不替代 `get_run_result`。审查 Run 的最终 Gate、Issue 和报告必须从 `get_run_result` 获取。

### 4.7 `get_run_status`

输入只接受 `run_id` 或由本会话保存的 run handle，不接受任意 `run_directory`：

```json
{
  "schema_version": "2.1",
  "workspace_id": "string",
  "run_id": "RUN-..."
}
```

返回至少包含：

- phase、run_status、audit_status（若存在）；
- lease 是否健康，但不泄漏 owner secret；
- logical case / execution instance 计数；
- by-tier / by-batch 进度；
- `next_action`：`poll / get_result / resume / cleanup / none`；
- 有上限的最近事件摘要；
- `poll_after_ms`。

状态查询必须是只读操作，不续租、不推进 Phase、不触发隐式 resume。

### 4.8 `get_run_result`

- `phase=GATED`：返回 `results.json` 的结构化摘要、Issue 列表分页信息和 Artifact 引用；
- `run_status=FAILED`：返回 Fatal Failure 摘要和 `failure_path`；
- 未终态：返回 `kind=not_ready`、当前状态和建议轮询时间；
- 大型 Issue/Evidence 不直接嵌入单次 MCP 返回，通过分页或受控 Artifact 引用访问。

### 4.9 `resume_run`

`resume_run` 只提交恢复意图，由 Worker 获取 lease：

```json
{
  "schema_version": "2.1",
  "client_request_id": "string",
  "workspace_id": "string",
  "run_id": "RUN-..."
}
```

允许条件：

1. `run_status=INTERRUPTED` 且 lease 过期；
2. `run_status=ACTIVE` 但 heartbeat/lease 已 stale；
3. Host Context、input versions、auth scope 和 workspace 与原 Run 兼容；
4. 未超过 max resume attempts。

已终态 Execution 不得重跑；RESET_REQUIRED 必须先完成 reset；NON_RESUMABLE 中断进入 incomplete。

### 4.10 `cancel_run`

取消是受控状态转换，不是删除目录或强杀后宣称完成：

- 对尚未运行的 execution 标记 `CANCELLED`；
- 正在运行的 execution 尝试优雅停止，超时后由 Worker 终止；
- 写入 `USER_CANCELLED` terminalization；
- 完成 Runtime Finalization、Audit、Report、Gate；
- 最终通常为 `audit_status=INCOMPLETE`、`gate=incomplete`。

如果发生存储完整性失败，才走 Fatal Failure。

### 4.11 `cleanup_run` 与 `explain_run`

`cleanup_run`：

- 默认只清理临时数据和 Seed；
- 删除报告/证据必须满足 retention policy，并需要显式 `cleanup_scope=all_expired_artifacts`；
- 不得修改已冻结 `results.json`；
- 幂等返回 `cleanup-result.json` 摘要。

`explain_run`：

- 可按 feature/case/issue 过滤；
- 返回 derivation、effective tier、Candidate 选择、执行实例和 Gate 原因；
- 页面原始文本必须截断和标记为 untrusted；
- 不返回密钥、Cookie、完整 trace 或任意宿主文件。

### 4.12 MCP Error Envelope

```json
{
  "schema_version": "2.1",
  "kind": "error",
  "error": {
    "code": "WORKSPACE_NOT_ALLOWED",
    "category": "usage|temporary|integrity|safety",
    "recoverable": false,
    "message": "sanitized message",
    "operation_id": null,
    "run_id": null,
    "details": {}
  }
}
```

错误负载不得包含绝对宿主路径、凭据、Cookie、Token、页面秘密或未经转义的 HTML。

---

## 五、MCP 控制平面、Worker 与会话模型

### 5.1 MCP Host Context

MCP Server 启动或建立会话时，由宿主注入：

```ts
interface McpHostContext {
  installationId: string;
  sessionId: string;
  callerId?: string;
  workspaces: Array<{
    workspaceId: string;
    realRoot: string;
    mode: 'trusted' | 'untrusted_pr';
    configSource: 'base' | 'fixed' | 'head' | 'approved_overlay';
    approvedAuthScopeIds: string[];
    policyId: string;
  }>;
  maxConcurrentRuns: number;
  maxBrowsers: number;
  maxExecutionInstancesPerRun: number;
  maxDiskBytes: number;
  retentionPolicyId: string;
}
```

Host Context 不得由 Profile 或 Agent 工具参数覆盖。Server 可以进一步收紧，但不能放宽。

### 5.2 Operation Registry

所有可异步工具使用持久 Operation Registry，并可通过 `get_operation_status` / `get_operation_result` 查询：

```ts
type OperationStatus =
  | 'ACCEPTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED';

interface OperationRecord {
  operationId: string;
  operationType: 'coverage_preview' | 'audit' | 'resume' | 'cleanup';
  clientRequestId: string;
  workspaceId: string;
  runId?: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  resultRef?: string;
  errorRef?: string;
}
```

Registry 必须在 accepted 前提交。Server 重启后可以重建查询索引；Operation 不得仅存在内存中。Operation Record 的可查询期限、结果引用过期、幂等 tombstone 与清理顺序由第 5.8 节的 Retention Policy 决定。

### 5.3 Worker 调度

- Control Plane 只入队，不直接持有长时间浏览器调用；
- Worker 通过任务 lease 领取 Run；
- 同一 Run 任意时刻只有一个 Phase writer；
- 并发预算按 workspace、installation 和全局三层限制；
- 超出并发返回 accepted/queued，而不是创建多个冲突 Worker；
- Worker crash 后由 lease 过期和 resume policy 接管；
- Server shutdown 应先停止接收新任务，再等待或标记运行任务为可接管。

### 5.4 会话断开与重连

MCP Session 不是 Run 所有权边界：

- transport 断开不取消 accepted Run；
- 新会话在相同 installation/workspace 授权下可通过 run_id 查询；
- 若宿主要求 session-bound mode，Server 可将 Run 限制为原 caller，但此策略必须在 accepted 前记录；
- handle 不得包含可用于越权读取其他 workspace 的可猜测路径；
- 日志中只记录 run_id/operation_id，不记录秘密 handle token。

### 5.5 幂等与重复调用

`run_audit`、`derive_coverage`、`resume_run`、`cancel_run`、`cleanup_run` 均必须按 `client_request_id` 幂等：

- 同参数重复请求返回原结果；
- 同 ID 不同参数返回 `IDEMPOTENCY_CONFLICT`；
- 幂等记录的保留期不得短于对应 Run 的可查询期；
- Worker 重试不能创建第二个 Run。

### 5.6 资源与背压

MCP Server 必须配置：

- 最大并发 Run；
- 每 workspace 最大并发；
- 浏览器/Context 上限；
- Planner 并发和 token 上限；
- Run、preview、cache 和 evidence 磁盘配额；
- 单工具响应字节上限；
- status 轮询最小间隔。

超过预算时返回 `QUEUED`、`RESOURCE_LIMIT` 或受控 TERMINALIZING，不允许 OOM 后留下伪 ACTIVE 状态。

### 5.7 Retention Policy 与容量治理

Retention 是持久化公共契约，不得只由后台脚本约定。MCP Server 在 Preflight 时解析 Host 指定的 `retentionPolicyId`，与 Server 安装策略和 Profile 的只收紧覆盖求交，生成 `retention-policy.json` 快照。

```ts
interface RetentionPolicy {
  policyId: string;
  operationCompletedTtlDays: number;
  operationFailedTtlDays: number;
  idempotencyTtlDays: number;
  runGatedTtlDays: number;
  runFailedTtlDays: number;
  runInterruptedTtlDays: number;
  previewTtlHours: number;
  reportTtlDays: number;
  evidenceTtlDays: number;
  traceVideoTtlDays: number;
  discoveryCacheTtlDays: number;
  planCacheTtlDays: number;
  maxWorkspaceBytes: number;
  highWatermarkPct: number;
  lowWatermarkPct: number;
  cleanupIntervalMinutes: number;
  onQuotaExceeded: 'REJECT_NEW_RUNS' | 'EVICT_EXPIRED_ONLY';
}
```

硬约束：

- `idempotencyTtlDays` 不得短于相关 Operation/Run 的最长可查询期限；
- 非过期的 `results.json`、`failure.json` 和 Gate 事实不得因磁盘水位被自动删除；
- 自动清理只能删除已过期对象，除非用户通过已授权的 `cleanup_run` 明确请求；
- Artifact 被清理后保留最小 tombstone，查询返回 `RESULT_EXPIRED`，不得伪装成不存在或成功空结果；
- Evidence、trace、video 可以比 report 更早过期，但报告必须明确标注证据已过期；
- cleanup 先提交清单与 tombstone，再删除文件，崩溃后可幂等继续；
- 达到 high watermark 且没有可清理过期对象时，拒绝新 Run，不得删除未过期事实；
- Retention 配置必须通过 `retention-policy.schema.json` 校验并写入每个 Run 的 input versions。

### 5.8 进度与通知

基础协议使用 polling，保证所有 MCP Host 可用。若宿主支持 progress notification，可发送补充通知，但通知不是事实源。事实源仍是 Run Storage 和 Operation Registry。

通知必须可丢失、可重复；客户端不得仅凭通知判断 GATED。

### 5.9 MCP Server 启动与诊断

Server 启动时必须：

1. 校验 Schema Bundle 和引擎版本；
2. 校验数据根目录权限；
3. 扫描 stale Operations/Runs；
4. 恢复查询索引；
5. 启动 Worker/heartbeat；
6. 通过 `server_info` 内部握手声明工具版本和能力。

启动完整性失败时不注册审查工具，只暴露安全的诊断错误。

---

## 六、内部 Core API 与维护 CLI

### 6.1 Internal Core API

Core API 是 MCP Server/Worker 的内部实现边界，不承诺作为独立公共 SDK 长期兼容：

```ts
interface StartManagedRunOptions {
  normalizedRequest: NormalizedMcpAuditRequest;
  hostContextSnapshot: HostContextSnapshot;
  plannerProvider: PlannerProvider;
}

async function createManagedRun(options: StartManagedRunOptions): Promise<RunRecord>;
async function advanceRun(runId: string): Promise<void>;
async function resumeManagedRun(runId: string): Promise<void>;
async function requestCancellation(runId: string): Promise<void>;
async function readRunStatus(runId: string): Promise<RunStatusView>;
async function readRunResult(runId: string): Promise<RunResultView>;
```

低层相位服务可以在包内存在，但不得直接注册为 MCP tool。

### 6.2 PlannerProvider

```ts
interface PlannerProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  fill(input: PlannerInput, options: PlannerOptions): Promise<PlannerOutput>;
}

interface PlannerOptions {
  modelId: string;
  timeoutMs: number;
  maxAttempts: number;
  maxOutputTokens: number;
  temperature: 0;
}
```

必须提供 `DeterministicFixturePlanner`。Provider 不得假设能反向调用当前 Codex 对话；若使用 OpenAI 或本地模型，凭据和模型配置由 Server 安装配置提供，不从页面或 Profile 读取。

### 6.3 Internal Progress Event

```ts
type ProgressEvent =
  | { type: 'OPERATION_ACCEPTED'; operationId: string }
  | { type: 'PHASE_COMMITTED'; runId: string; phase: Phase }
  | { type: 'RUN_INTERRUPTED'; runId: string; recoverable: boolean; errorCode: string }
  | { type: 'EXECUTION_STATUS'; executionId: string; caseId: string; batchId: string; status: CaseStatus }
  | { type: 'AUDIT_FINISHED'; auditStatus: AuditStatus }
  | { type: 'GATE_FINISHED'; gate: GateDecision; exitCode: number };
```

事件写入 `events.jsonl`，MCP status 只读取聚合视图。

### 6.4 Maintenance CLI

CLI 不承担主要用户工作流，不要求与 MCP 工具一一对应。最小命令：

```bash
autopw doctor
autopw server start|stop|status
autopw run status <run_id>
autopw run resume <run_id>
autopw run cancel <run_id>
autopw run cleanup <run_id>
autopw profile validate [path]
autopw schema verify
```

约束：

- CLI 使用与 MCP Server 相同的数据根、Schema 和授权规则；
- CLI 不能绕过 Host Context 读取任意 workspace；管理员离线模式必须显式配置；
- 不将完整 `autopw run` 作为 v2.1 的主要验收入口；
- CLI operational exit code 可使用 64/70/75，但质量 Gate 仍来自 `results.json` 的 0–4。

### 6.5 可选嵌入式 API

未来需要在其他 Node 应用内嵌时，可以提供不稳定的 `@autopw/core` API，但它不得改变 MCP-first 的公共契约。任何对外稳定兼容承诺以 MCP Tool Schema 和持久 Data Schema 为准。

---

## 七、编排内核与状态机

### 7.1 MCP 请求校验与 Preflight 不属于受管状态机

以下步骤发生在创建 Run 前：

```text
resolveMcpHostContext
→ authorizeWorkspaceAndProject
→ resolveProfile
→ resolveDiffAndScope
→ validatePlannerConfiguration
→ managed 或 NOOP
```

MCP tool handler 在此阶段验证 Host Context、workspace 和幂等键。Profile 解析时没有 run_id、run_directory 或 execution lease；但异步 Operation Record 可先存在。`request.json` 和规范化 `profile.json` 由 `createRun` 写入。

### 7.2 主相位与显式分支

正常路径：

```text
CREATED
→ TARGET_READY
→ SEED_RESOLVED
→ DISCOVERED
→ COVERAGE_DERIVED
→ PLAN_FILLED
→ PLAN_FROZEN
→ SUITE_GENERATED
→ SUITE_FROZEN
→ RUNNING
→ EXECUTION_FINISHED
→ RUNTIME_FINALIZED
→ AUDITED
→ REPORTED
→ GATED
```

受控提前终止路径：

```text
任一已提交 Phase（CREATED 至 SUITE_FROZEN，或 RUNNING 中止后）
→ TERMINALIZING
→ RUNTIME_FINALIZED
→ AUDITED
→ REPORTED
→ GATED
```

适用示例：Planner 重试耗尽形成 PLAN_DEFECT、Seed 重试耗尽、无法安全继续的 TEST_DEFECT、全局目标 INFRA 阻断。`terminalization.json` 必须说明触发 Phase、错误、已存在产物、未执行范围和预期 Gate 影响。

Fatal Failure 不进入 TERMINALIZING：当 Run Storage、Schema bundle、Host Trust Context、目录锚定或状态完整性已不可信时，`run_status=FAILED`，写 `failure.json`，释放 lease，停止生成质量 Gate。

其他说明：

- connect 和 manage 都必须进入 `TARGET_READY`；结果字段记录 `CONNECTED` 或 `STARTED`。
- Seed 无论执行还是跳过，都必须进入 `SEED_RESOLVED`；结果字段记录 `APPLIED` 或 `SKIPPED`。
- `AUDITED` 后的 `audit_status` 可以是 COMPLETE 或 INCOMPLETE；两者均必须继续生成报告并进入 GATED。
- `RUNTIME_FINALIZED` 只处理浏览器、临时代理、manage 目标关闭和临时秘密；Seed 业务数据默认在 GATED 后由幂等 cleanup 清理。
- 报告先使用 Gate Draft 渲染；报告成功或降级报告成功后，才原子提交 `results.json` 与 GATED。

允许转换由固定表驱动：

| 当前 Phase | 正常下一 Phase | 允许的分支 |
|---|---|---|
| CREATED | TARGET_READY | TERMINALIZING |
| TARGET_READY | SEED_RESOLVED | TERMINALIZING |
| SEED_RESOLVED | DISCOVERED | TERMINALIZING |
| DISCOVERED | COVERAGE_DERIVED | TERMINALIZING |
| COVERAGE_DERIVED | PLAN_FILLED | TERMINALIZING |
| PLAN_FILLED | PLAN_FROZEN | TERMINALIZING |
| PLAN_FROZEN | SUITE_GENERATED | TERMINALIZING |
| SUITE_GENERATED | SUITE_FROZEN | TERMINALIZING |
| SUITE_FROZEN | RUNNING | TERMINALIZING |
| RUNNING | EXECUTION_FINISHED | INTERRUPTED 状态或 TERMINALIZING |
| EXECUTION_FINISHED | RUNTIME_FINALIZED | TERMINALIZING |
| TERMINALIZING | RUNTIME_FINALIZED | — |
| RUNTIME_FINALIZED | AUDITED | — |
| AUDITED | REPORTED | — |
| REPORTED | GATED | — |

任何表外转换均为 `RUN_PHASE_INVALID`。Fatal Failure 只改变 Run Status，不伪造一个 Phase 转换。

### 7.3 Run Status

```ts
type RunStatus = 'ACTIVE' | 'INTERRUPTED' | 'FAILED' | 'COMPLETED';
```

- `ACTIVE`：持有有效 lease，允许推进正常路径或 TERMINALIZING 路径。
- `INTERRUPTED`：可恢复错误或执行者丢失；Phase 保持在最后一次成功提交的位置。
- `FAILED`：Fatal Failure；不得 resume，不生成质量 Gate，但必须尽力写 `failure.json` 和释放资源。
- `COMPLETED`：Phase=GATED；延迟 Seed cleanup 可尚未完成。

`ACTIVE + stale lease` 被视为可接管的隐式中断状态，接管者通过 CAS 转为自身 owner 后再恢复。

### 7.4 Phase 提交协议

每个相位执行：

```text
assert current phase
→ 执行工作并写临时产物
→ 校验 Schema 与安全约束
→ 原子 rename 产物
→ compare-and-swap 更新 run_state.state_version 与 phase
→ 追加 PHASE_COMMITTED 事件
```

若 CAS 失败，当前执行者停止推进并返回 `STATE_VERSION_CONFLICT`。

### 7.5 治理机制

本方案不使用哈希链，但必须使用：

1. 相位门控和 write-once；
2. 原子快照；
3. `state_version` CAS；
4. `events.jsonl` 追加日志；
5. case ID 集合结构审计；
6. Content Digest 检测缓存损坏和输入版本变化；
7. lease 与 heartbeat。

Content Digest 不提供事后防篡改保证。

### 7.6 产物清单

| 文件 | Phase | 说明 |
|---|---|---|
| `operation.json` | MCP accepted 前 | MCP Operation、幂等键、workspace、run/result 引用 |
| `request.json` | CREATED | 规范化请求与 Preflight 摘要 |
| `profile.json` | CREATED | 规范化 Profile；不含明文密钥 |
| `input-versions.json` | CREATED | Profile、Policy、Route Map、Contract、引擎版本摘要 |
| `target-result.json` | TARGET_READY | CONNECTED/STARTED、health evidence |
| `seed-result.json` | SEED_RESOLVED | APPLIED/SKIPPED 与 reset 能力 |
| `discovery.json` | DISCOVERED | 页面、scenario observation、候选 |
| `derivation.json` | COVERAGE_DERIVED | skeleton 与矩阵状态 |
| `coverage-derivation.draft.md` | COVERAGE_DERIVED | 不含 step 绑定 |
| `planner-output.json` | PLAN_FILLED | 原始候选选择，已做内容隔离 |
| `plan.json` | PLAN_FROZEN | 冻结逻辑 Case 计划 |
| `coverage-derivation.md` | PLAN_FROZEN | 最终 CDD |
| `generated-tests/` | SUITE_GENERATED | 确定性生成代码 |
| `mapping-audit.json` | SUITE_GENERATED | planned→generated logical case 映射 |
| `execution-manifest.json` | SUITE_FROZEN | batch、logical case 和 execution instance 初始状态 |
| `events.jsonl` | 全程 | 追加事件日志 |
| `checkpoint.json` | RUNNING | execution instance 原子快照 |
| `evidence-manifest.json` | RUNNING/EXECUTION_FINISHED | 证据索引与脱敏状态 |
| `issues.json` | EXECUTION_FINISHED/TERMINALIZING | 分类问题 |
| `terminalization.json` | TERMINALIZING | 受控提前终止原因和未完成范围 |
| `finalization-result.json` | RUNTIME_FINALIZED | 浏览器、代理、目标和临时秘密清理结果 |
| `completion-audit.json` | AUDITED | audit_status 与 Case/Execution 对账 |
| `gate-draft.json` | AUDITED 后内部提交 | 报告渲染使用的不可变 Gate 草案 |
| `report.md`、`report.html` | REPORTED | 已转义的人类报告；必要时为内置降级报告 |
| `results.json` | GATED | CI 门禁产物 |
| `failure.json` | FAILED | Fatal Failure 机器记录，不是质量 Gate |
| `cleanup-result.json` | GATED 后 | 延迟 Seed 数据清理结果 |
| `run_state.json` | 全程 | 唯一相位事实源 |



---

## 八、覆盖推导与 Discovery

### 8.1 Discovery 职责

Discovery 负责观测目标并产生结构化候选，不负责决定最终测试覆盖。它必须将页面内容视为不可信数据。

输出至少包括：

- Page Inventory；
- Feature Inventory；
- scenario 级 observation；
- 控件与唯一性候选；
- API endpoint 候选；
- validation text 候选；
- input template 和边界候选；
- structural expectation 候选；
- health、console 和 network 基线；
- 缓存验证元数据。

### 8.2 scenario 级 Observation

不得使用 feature 级 `OBSERVED` 推断所有 scenario 都可测。每个 feature × scenario 必须有独立状态：

```ts
type ScenarioObservationStatus =
  | 'OBSERVED'
  | 'BLOCKED'
  | 'NOT_APPLICABLE';

interface ScenarioObservation {
  scenario: CoverageScenario;
  status: ScenarioObservationStatus;
  evidence: EvidenceRef[];
  candidateRefs: {
    actions: string[];
    routes: string[];
    locators: string[];
    inputs: string[];
    endpoints: string[];
    expectations: string[];
  };
  reason?: string;
}
```

示例：

```json
{
  "feature_id": "search",
  "scenario_observations": [
    {
      "scenario": "normal",
      "status": "OBSERVED",
      "candidate_refs": {
        "actions": ["ACT-fill-search"],
        "routes": ["ROUTE-search"],
        "locators": ["LOC-search-role"],
        "inputs": ["INPUT-search-normal"],
        "endpoints": [],
        "expectations": ["EXP-results-visible"]
      }
    },
    {
      "scenario": "required_field",
      "status": "NOT_APPLICABLE",
      "reason": "契约声明允许空搜索"
    },
    {
      "scenario": "boundary",
      "status": "BLOCKED",
      "reason": "未发现 maxlength 且契约未提供边界"
    }
  ]
}
```

### 8.3 Candidate 模型

所有 Candidate ID 在同一个 `candidate_catalog` 内全局唯一，并满足稳定 ID pattern。Planner 输出必须按类型引用，禁止使用一个无类型的混合 ID 列表。

#### 8.3.1 ActionTemplate

```ts
interface ActionTemplate {
  actionTemplateId: string;
  kind: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'check' |
        'uncheck' | 'upload' | 'request' | 'mock_response' |
        'abort_request' | 'resize';
  requiredCandidateTypes: Array<'route' | 'locator' | 'input' | 'endpoint'>;
  allowedNextRouteIds: string[];
  fixedArguments?: Record<string, string | number | boolean>;
}
```

#### 8.3.2 RouteCandidate

```ts
interface RouteCandidate {
  routeId: string;
  pathRef: string;
  origin: string;
  observed: boolean;
  allowed: boolean;
}
```

Planner 选择 navigate 目标时只能引用 `routeId`。相对路径、query 模板和 origin 由 Contract/Discovery 注册，不能由模型自由拼接。

#### 8.3.3 ControlCandidate

```ts
interface ControlCandidate {
  controlId: string;
  route: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  placeholder?: string;
  inputType?: string;
  testId?: string;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  locatorCandidates: LocatorCandidate[];
}

interface LocatorCandidate {
  locatorId: string;
  controlId: string;
  kind: 'test_id' | 'role' | 'label' | 'placeholder' | 'text';
  arguments: Record<string, string>;
  matchCount: number;
  stable: boolean;
}
```

Planner 只能选择 `locatorId`。执行计划中不得出现未经 Candidate 注册的 CSS、XPath 或字符串拼接定位器。

#### 8.3.4 InputCandidate

```ts
interface InputCandidate {
  inputId: string;
  source: 'seed' | 'contract' | 'observed_option' | 'html_constraint';
  scenario: CoverageScenario;
  valueRef: string;
  sensitive: boolean;
}
```

#### 8.3.5 EndpointCandidate

```ts
interface EndpointCandidate {
  endpointId: string;
  route: string;
  method: string;
  urlPatternRef: string;
  origin: string;
  mutation: boolean;
  mockable: boolean;
  abortable: boolean;
}
```

#### 8.3.6 ExpectationCandidate

```ts
type ExpectationCandidate =
  | { expectationId: string; kind: 'text'; textRef: string }
  | { expectationId: string; kind: 'visible'; controlId: string }
  | { expectationId: string; kind: 'url'; patternRef: string }
  | { expectationId: string; kind: 'response_status'; endpointId: string; status: number }
  | { expectationId: string; kind: 'state_change'; controlId: string; property: string; valueRef: string }
  | { expectationId: string; kind: 'no_page_error'; observationWindowMs: number };
```

`normal` 场景不得使用“任意可观测预期”这种不可执行描述，必须选择一个或多个结构化 ExpectationCandidate。

```ts
interface CandidateCatalog {
  actions: ActionTemplate[];
  routes: RouteCandidate[];
  controls: ControlCandidate[];
  locators: LocatorCandidate[];
  inputs: InputCandidate[];
  endpoints: EndpointCandidate[];
  expectations: ExpectationCandidate[];
}
```

Candidate 在运行时仍需重新解析：每次交互前必须验证当前 route、origin 和 locator 唯一性。Discovery 时唯一但运行时不唯一的 locator 属于 TEST/PLAN 可信度问题，不得直接归为 PRODUCT_DEFECT。

### 8.4 Discovery 边界

Profile 必须支持：

```yaml
discovery:
  max_pages: 100
  max_depth: 4
  max_links_per_page: 50
  max_controls_per_page: 500
  max_text_chars_per_page: 50000
  max_redirects: 10
  route_deduplication: normalized_pattern
  include_iframes: same_origin
  include_popups: false
```

超过边界时产生 warning；若被截断部分包含 required P0 capability 的可能范围，则产生 objective blocker，而不是静默认为未发现。

### 8.5 Effective Tier 计算

必须先计算 effective tier，再决定是否生成 case。

```ts
function effectiveTier(
  baseTier: Tier,
  scope: FeatureScope,
  propagate: boolean,
  diffProvided: boolean,
): Tier | 'SKIPPED' {
  if (!scope.inScope) return 'SKIPPED';
  if (!diffProvided || propagate) return baseTier;
  if (baseTier === 'full') return 'full';
  if (scope.isMandatorySentinel) return 'smoke';
  if (baseTier === 'smoke') return 'smoke';
  return scope.isNewFeature ? 'fast' : 'smoke';
}
```

规则：

| Base Tier | 新功能 | 受影响旧功能 | 无关功能 |
|---|---|---|---|
| smoke | smoke | smoke | skipped |
| fast | fast | smoke | skipped |
| full | full | full | skipped |
| 任意 + propagate | base tier | base tier | 全量 scope |
| mandatory always sentinel | smoke（full base 时 full） | smoke（full base 时 full） | 由 Policy 强制进入 scope |
| 无 Diff | base tier | base tier | 全量 scope |

Tier 对 priority 的允许范围：

| Tier | Priority |
|---|---|
| smoke | P0 |
| fast | P0、P1 |
| full | P0、P1、P2 |

因此 fast 中新增 P2 feature 仍会因 priority 被裁剪；必须在 CDD 中记录 `TIER_SKIPPED_PRIORITY`。

### 8.6 推导算法

对 Coverage Policy 中每个 feature × scenario：

1. 计算 scope；
2. 计算 effective tier；
3. 检查 feature priority 是否被 effective tier 包含；
4. 检查 scenario 是否被 effective tier 包含；
5. 读取 scenario observation；
6. 产生矩阵状态。

| 条件 | 结果 |
|---|---|
| 不在 scope | TIER_SKIPPED_SCOPE |
| priority 不允许 | TIER_SKIPPED_PRIORITY |
| scenario 不允许 | TIER_SKIPPED_SCENARIO |
| Policy=not_applicable | NOT_APPLICABLE |
| observation=OBSERVED | PLANNED |
| observation=BLOCKED | OBSERVED_BLOCKED |
| observation=NOT_APPLICABLE 且 Policy=required | POLICY_DISCOVERY_CONFLICT，产生 PLAN_DEFECT/incomplete |

P0 规则：

- required P0 cell 的 blocker 不得从覆盖率分母中删除；
- 任何 included required P0 blocker 都使最终 gate 至少为 incomplete；
- Discovery 可以重新探测一次，但不得将 blocker 伪装成 covered。

### 8.7 CaseSkeleton

```ts
type ExpectationKind =
  | 'text' | 'visible' | 'url' | 'response_status' | 'state_change' | 'no_page_error';

interface CaseSkeleton {
  caseId: string; // CASE-{featureId}-{scenario}
  featureId: string;
  capability: string;
  scenario: CoverageScenario;
  priority: Priority;
  effectiveTier: Tier;
  requiredActionTemplateIds: string[];
  allowedRouteIds: string[];
  allowedLocatorIds: string[];
  allowedInputIds: string[];
  allowedEndpointIds: string[];
  allowedExpectationIds: string[];
  requiredExpectationKinds: ExpectationKind[];
  derivation: Derivation;
  weakValidationEligible: boolean;
}
```

feature ID、case ID、candidate ID 和 batch ID 必须由 Schema 限制字符集和最大长度，防止路径、marker 和报告注入。

### 8.8 Weak Validation

Weak Validation 不是“没有可靠预期也继续执行”。它只允许以下降级：

| Scenario | 降级 |
|---|---|
| required_field | 受控文案正则或明确 invalid state |
| invalid_input | 受控文案正则、invalid state 或拒绝响应 |
| boundary | 契约/HTML 边界 + 状态或文案 |
| empty_state | 受控空状态文本或已发现 empty container |
| service_error | 注入的 5xx route + 错误 UI/稳定降级 UI |
| network_failure | 已匹配 abort route + 离线/失败 UI |
| normal | 仅允许 Discovery 已生成的 visible/url/response/state_change/no_page_error 组合 |

`no_page_error` 不得作为 normal 的唯一预期，除非 Scenario Contract 明确将该 Case 声明为纯导航/只读健康检查。若 normal 无任何足以证明行为结果的结构化 expectation candidate，则不能使用自由正则，必须产生 objective blocker。

### 8.9 CDD 两阶段

`coverage-derivation.draft.md` 在 COVERAGE_DERIVED 生成，包含：

- matrix status；
- effective tier；
- scope reason；
- discovery evidence；
- case ID；
- blocker/not applicable/skipped reason；
- weak validation eligibility。

`coverage-derivation.md` 在 PLAN_FROZEN 生成，额外包含：

- action step；
- expectation step；
- selected candidate IDs；
- coverage bindings；
- final weak validation 状态。

---

## 九、Planner、填空与内容锚定

### 9.1 Planner 信任模型

Planner 输入中的页面文本、控件名称、网络内容和 validation text 均是不可信数据。Provider 必须将系统规则和页面数据分离，页面数据必须以结构化字段传入，不能作为系统指令拼接。

Planner：

- 无工具调用权限；
- 不访问文件系统、Shell 或网络；
- 只输出符合 Schema 的 JSON；
- temperature 固定为 0；
- 输出不得包含代码；
- 输出不得新增 Candidate；
- 输出中的所有 ID 必须来自 Skeleton 对应的 typed allowed lists。

### 9.2 PlannerInput 与输出

```ts
interface ContractReference {
  contractId: string;
  version: string;
  ref: string;
}

interface StructuredObservation {
  observationId: string;
  untrusted: true;
  kind: string;
  value: string;
}

interface PlannerInput {
  schemaVersion: '2.1';
  skeletons: CaseSkeleton[];
  candidates: CandidateCatalog;
  contractRefs: ContractReference[];
  untrustedObservations: StructuredObservation[];
}

interface PlannerCaseSelection {
  caseId: string;
  actionSelections: Array<{
    actionTemplateId: string;
    routeId?: string;
    locatorId?: string;
    inputId?: string;
    endpointId?: string;
  }>;
  expectationIds: string[];
  description?: string;
}
```

`ContractReference` 只包含契约 ID、版本和非秘密引用；`StructuredObservation` 必须有显式 `untrusted=true` 标记并受长度上限约束。`description` 仅用于报告，渲染前必须转义，不参与执行语义。

### 9.3 定位器锚定

硬约束：

- 所有交互 target 必须引用 `locatorId`；
- Discovery/Plan Validator 时 `matchCount` 必须为 1，除非 Contract 明确声明集合定位和 index 语义；
- 执行每一步前再次解析 Candidate，并验证当前 match count、route 和 origin；
- 不稳定 text locator 在存在 test_id/role/label 候选时不得优先选择；
- locator 必须属于 case 的 observed route 或 Contract 明确允许的后续 route；
- iframe/shadow root 必须由 Candidate 显式建模。

静态校验失败产生 `PLAN_INVALID` 并重试 Planner。达到 maxAttempts 后形成 PLAN_DEFECT 并进入 TERMINALIZING。运行时重新解析失败形成 TEST_DEFECT 或 PLAN_DEFECT，停止当前 execution instance；是否继续其他实例由安全范围决定。

### 9.4 输入来源

| Scenario | 允许来源 |
|---|---|
| normal | seed、contract normal template、observed option |
| required_field | 仅 Contract 声明的 empty value；默认空字符串 |
| invalid_input | `invalid_templates`；不得自动复用 required_field 空值 |
| boundary | `boundary_constants`、HTML min/max/maxLength 的受控派生值 |
| empty_state | seed/reset state 或 Contract empty fixture |
| service_error | mock endpoint candidate + Contract error payload |
| network_failure | abort endpoint candidate |

敏感值只能以 `valueRef` 形式存在，冻结计划和报告不得写入明文。

### 9.5 预期锚定

预期来源优先级：

1. Scenario Contract；
2. Profile validation preset；
3. Discovery 静态文案；
4. P0 交互探针；
5. 8.8 定义的 weak validation。

编辑距离 ≤2 只允许用于同一语言、同一规范化文本候选，不得将语义不同的短文本误匹配。长度小于 4 的文本禁用编辑距离容错。

### 9.6 Scenario Contract

Contract 必须提供正式 Schema，核心结构：

```json
{
  "schema_version": "2.1",
  "features": {
    "search": {
      "controls": [],
      "input_templates": {
        "normal": [],
        "invalid_input": [],
        "boundary": []
      },
      "validation_texts": {},
      "expectations": [],
      "mock_endpoints": [],
      "reset_strategy": {
        "kind": "seed_adapter|api|none",
        "idempotent": true
      }
    }
  }
}
```

### 9.7 Plan Validator

验证顺序：

1. JSON Schema；
2. case ID 与 Skeleton 一一对应；
3. Action/Route/Locator/Input/Endpoint/Expectation ID 按类型存在且属于 case；
4. Locator 唯一且稳定；
5. input 与 scenario 匹配；
6. expectation 类型与 scenario 匹配；
7. Route/URL/origin/network/path 安全；
8. production/read-only 约束；
9. coverage binding 完整；
10. 敏感字段仅使用引用；
11. 所有描述字段可安全渲染且不影响执行；
12. resumability 与 mutation 动作一致。

Planner 重试耗尽后不得跨 Phase 跳到 AUDITED，必须提交 PLAN_DEFECT 和 `terminalization.json`，进入 TERMINALIZING。

### 9.8 Plan Cache

缓存对象是 `PlanTemplate`，不是完整 `plan.json`。新 Run 必须重新绑定：

- run_id；
- Seed value references；
- auth scope；
- artifact paths；
- current candidate catalog。

缓存键至少包含：

```text
normalized_profile_digest
coverage_policy_digest
scenario_contract_digest
route_map_digest
discovery_digest
engine_version
schema_version
planner_provider_id/version
model_id
base_tier
sorted_scope
locale
auth_scope_id
```

命中后仍执行 9.7 全部验证。

---

## 十、执行策略引擎

### 10.1 Tier 语义

| 维度 | smoke | fast | full |
|---|---|---|---|
| Scenario | normal、required_field | + invalid_input、empty_state | + boundary、service_error、network_failure |
| Priority | P0 | P0、P1 | P0、P1、P2 |
| Browser | Chromium | Chromium | Profile 全矩阵 |
| Viewport | 最大桌面视口 | 最大桌面视口 | Profile 全矩阵 |
| Workers | 1 | 4（可由 Profile 合法覆盖，最小 2） | 4 |
| Retries | 0 | 0 | 1 |
| Screenshot | failure | failure | failure |
| Console/Network | 全量 JSONL | 全量 JSONL | 全量 JSONL |
| Trace | failure | failure | `on` 或 retain-on-failure，按 Profile |
| Video | off | off | retain-on-failure |
| Discovery | P0 route | P0/P1 route + API | 全路由 |

Smoke/Fast 的 flaky 识别不依赖 Playwright retries，而使用独立 diagnostic rerun。

### 10.2 Batch 与 Execution Instance 规划

一次 Run 可以含多个 effective tier。Execution Batch Key：

```ts
interface ExecutionBatchKey {
  tier: Tier;
  browser: string;
  viewport: Viewport;
  locale: string;
  authScopeId: string;
}
```

Batch Planner 将每个 Logical Case 展开为一个或多个必需 Execution Instance：

```ts
interface ExecutionInstance {
  executionId: string; // EXE-{shortDigest(caseId + batchId)}
  caseId: string;
  batchId: string;
  status: CaseStatus;
}
```

- smoke/fast 通常每个 Case 只有一个实例；
- full Case 必须在 Profile 批准的全部 browser × viewport × locale × auth scope 组合中各有一个实例；
- Batch Planner 在创建受管 Run 前计算 `projected_execution_instances`，有效上限为 Host `maxExecutionInstancesPerRun` 与 Profile `matrix_budget.max_execution_instances` 的较小值；
- full 超出有效上限时返回 `MATRIX_BUDGET_EXCEEDED`，不创建 Run，也不得静默裁剪、抽样、pairwise 化或自动降为 fast；
- `derive_coverage` 必须返回按 browser、viewport、locale、auth scope 分解的投影数量和收窄建议；调用方只能显式修改 Profile/范围或改选 tier 后重新提交；
- 一个 Case 的结构对账在全部必需实例被 accounted 时闭合；coverage cell 只有在全部必需实例进入 PASSED/FAILED/FLAKY 可信执行终态且证据满足要求时才视为 covered；
- issue、event、checkpoint 和 evidence 优先引用 `execution_id`，同时保留 `case_id`。

按以下顺序执行：

1. smoke batches；
2. fast batches；
3. full batches；
4. 同 tier 内按 browser、viewport 字典序；
5. batch 内 execution 按 case_id、execution_id 字典序。

普通产品/断言失败不得阻止其余可启动实例。以下全局事件例外，必须停止新实例并进入 TERMINALIZING 或 FAILED：安全边界违规、Host Trust Context 被破坏、Run Storage 完整性失败、环境可能泄密。

`full` 的语义是完整执行获批笛卡尔积。未来若引入 pairwise、采样或优先级裁剪，必须使用新的显式矩阵策略名称和独立 Gate 语义，不能继续标记为 full。

### 10.3 RunnerConfig

```ts
interface RunnerConfig {
  workers: number;
  fullyParallel: true;
  retries: number;
  maxFailures: 0;
  timeout: number;
  use: {
    trace: 'off' | 'on' | 'on-first-retry' | 'retain-on-failure';
    screenshot: 'only-on-failure' | 'on';
    video: 'off' | 'retain-on-failure';
    locale: string;
    viewport: Viewport;
  };
}
```

生成测试只能从受控 `@autopw/execution-fixture` 导入。Compiler 不允许模型输出源码。

### 10.4 Execution Instance 状态

```ts
type CaseStatus =
  | 'NOT_RUN'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'FLAKY'
  | 'INTERRUPTED'
  | 'BLOCKED_RESUME'
  | 'INFRA_BLOCKED';
```

状态属于 Execution Instance。Logical Case 的聚合状态由其全部必需实例计算，不单独作为可写事实源。

可信执行终态包括 PASSED、FAILED、FLAKY。`INFRA_BLOCKED` 仅在绑定到一个有完整 runner/health 证据的 `infrastructure_block_id`、覆盖整个受影响 batch、且没有状态不确定性时，作为“已解释实例”参与结构对账；此时 audit 可为 COMPLETE，gate=infra。未绑定或证据不完整的 INFRA_BLOCKED，以及 BLOCKED_RESUME、INTERRUPTED，均使审查 INCOMPLETE。

Logical Case 聚合只用于汇总，不作为独立可写状态：

1. 任一必需实例未 accounted → case incomplete；
2. 否则任一实例 FAILED → case failed；
3. 否则任一实例为已解释 INFRA_BLOCKED → case infra；
4. 否则任一实例 FLAKY → case flaky；
5. 否则全部 PASSED → case passed。

### 10.5 Flaky 识别

Smoke/Fast 的某个 Execution Instance 首次失败后，可以执行一次隔离 diagnostic rerun：

- rerun 使用同一 `execution_id` 的诊断 attempt、相同输入、独立 context 和相同 Seed/reset；
- rerun 仅用于分类，不修改首次执行事实；
- 首次失败、诊断通过 → 该实例 FLAKY；
- 两次同类稳定失败 → 根据证据分类 PRODUCT/TEST/PLAN/INFRA；
- 无法安全 reset → 不执行 rerun，若分类不确定则 TEST_DEFECT/PLAN_DEFECT 或 `classification_confidence=LOW`，审查 incomplete。

full 的 Playwright retry 同样记录为 attempt，不能覆盖首次失败记录。

### 10.6 Evidence 最低要求

| 失败阶段 | 最低证据 |
|---|---|
| 浏览器启动前 | error + runner log |
| 导航/断言失败 | error + screenshot + console log + network log |
| service/network 注入 | error + route match + request log + UI evidence |
| JS 未捕获异常 | console error + screenshot + route |
| evidence collector 自身失败 | collector error；case 不得计为 evidence-complete |

Trace/Video 是增强证据，不替代最低证据。

### 10.7 生命周期

```yaml
lifecycle:
  mode: connect | manage
```

- connect：健康检查通过后提交 TARGET_READY；Seed 结果通常为 SKIPPED。
- manage：启动目标、健康检查、执行 Seed，并在 finalization 中关闭。
- `require_seed_discovery=true` 与 connect 冲突，Preflight 直接 `RUN_INVALID`。
- untrusted_pr 模式强制 connect，见第十二章。

### 10.8 Discovery Cache

不能仅通过“当前 DOM 指纹等于缓存”来跳过当前 DOM 抓取。缓存验证顺序：

1. 可信 build/version endpoint；
2. HTTP ETag/Last-Modified；
3. 应用 shell digest；
4. 无可靠验证信号时执行轻量 route probe；
5. 仍无法判断时重新 Discovery。

缓存必须按 auth scope、tenant、locale、Profile digest 和 base_url 隔离。

### 10.9 性能基准

性能契约只在标准环境中测量：

- 4 vCPU / 8GB RAM；
- 固定 demo；
- 固定 Chromium/Playwright 版本；
- `DeterministicFixturePlanner`；
- 本地网络；
- 5 feature、3 P0、3 route。

| 基准 | 目标 |
|---|---|
| smoke | P95 ≤60s |
| fast | P95 ≤180s |
| cached fast | P95 ≤90s，推荐指标 |
| 标准 Demo Discovery | smoke P95 ≤15s、fast P95 ≤30s、full P95 ≤90s |
| 纯 Derivation Engine | P95 ≤2s；输入为已通过 Schema 校验的 `discovery.json`，不含浏览器、页面网络、Planner 或文件抓取 |
| plan cache validate + compile | P95 ≤5s |

`derive_coverage` 的端到端耗时必须拆分报告 `preflight_ms`、`discovery_wall_ms`、`derivation_cpu_ms` 和 `serialization_ms`。真实项目只对 Discovery 应用 timeout/page budget，并记录目标响应与外部等待；不得把端到端 Preview 耗时套用纯 Derivation 的 2 秒契约。

---

## 十一、Diff、门禁与流水线

### 11.1 Diff Analyzer

输入：

```json
{
  "diff_ref": "origin/main...HEAD",
  "route_map_path": ".autopw/route-map.json",
  "base_policy_path": "...",
  "head_policy_path": "..."
}
```

输出必须区分：

- analyzed files；
- new/modified/deleted/renamed；
- affected features；
- new features；
- propagate；
- unresolved mappings；
- empty diff。

新 feature 不能只通过新增文件判断，还必须比较 base/head Coverage Policy 和 Route Map 中的 feature ID 增量。

### 11.2 Route Map

支持规范化 POSIX 路径和 glob：

```json
{
  "schema_version": "2.1",
  "ignore_globs": ["docs/**", "**/*.md"],
  "mappings": [
    {
      "file_glob": "src/pages/search/**/*.{ts,tsx}",
      "routes": ["/search"],
      "features": ["search"],
      "propagate": false
    },
    {
      "file_glob": "src/components/**",
      "routes": ["*"],
      "features": ["*"],
      "propagate": true
    }
  ]
}
```

多条匹配取并集；任一匹配 `propagate=true` 即传播。ignore 只在文件未同时命中业务 mapping 时生效，避免用 ignore 规避覆盖。无法映射的业务文件默认 propagate。

在 `untrusted_pr` 中，Head Policy/Route Map 只可作为非权威变更提示，不能直接扩大可信配置。PR 新增但 base/fixed Policy 未声明的 feature 记录为 `UNAPPROVED_NEW_FEATURE` blocker/warning；需通过受信 overlay 或配置评审后进入权威覆盖。

### 11.3 Mandatory Capability

Coverage Policy 必须使用带 priority、scope mode 和明确 sentinel feature 的对象：

```json
{
  "mandatory_capabilities": [
    {
      "id": "authentication",
      "priority": "P0",
      "scope_mode": "always",
      "feature_ids": ["login"],
      "on_missing": "incomplete"
    },
    {
      "id": "search",
      "priority": "P1",
      "scope_mode": "when_affected",
      "feature_ids": ["search"],
      "on_missing": "warn"
    }
  ]
}
```

- `always`：Diff 收窄时仍把指定 sentinel feature 加入 scope；base smoke/fast 下以 smoke 执行，base full 下以 full 执行。
- `when_affected`：仅当其 supporting feature 已因 Diff/传播进入 scope 时评估。
- capability 必须由至少一个 in-scope OBSERVED supporting feature 支撑；不得从不存在的 feature 反推 priority。
- P0 缺失固定 incomplete；P1/P2 按 `on_missing` 取 warn 或 incomplete。
- sentinel feature 本身未在 Coverage Policy 定义属于 Policy 错误，不是 Discovery blocker。

### 11.4 P0 覆盖率

```text
p0_required_total =
  included required P0 PLANNED cells
  + included required P0 OBSERVED_BLOCKED cells

p0_covered =
  其全部必需 Execution Instance 均进入 PASSED/FAILED/FLAKY 可信执行终态且 evidence-complete 的 P0 PLANNED cells

p0_coverage_pct = p0_covered / p0_required_total
```

NOT_APPLICABLE 和 tier skipped 不进入分母。任何 P0 blocker 无论百分比如何都触发 incomplete。

若 `p0_required_total=0`，`p0_coverage_pct` 必须为 `null` 而不是伪造 100；门槛检查视为不适用，但 mandatory capability 规则仍独立生效。

### 11.5 Gate 固定优先级

```text
incomplete > infra > fail > unstable > pass
```

判定：

1. 以下任一存在 → incomplete：
   - audit_status=INCOMPLETE；
   - TEST_DEFECT 或 PLAN_DEFECT；
   - required P0 blocker；
   - required execution instance 未被 accounted；
   - case/instance failure evidence 不完整；
   - coverage binding/Schema/结构对账失败；
   - resume 被 `BLOCKED_RESUME` 阻断；
   - 任一最终分类为 `classification_confidence=LOW`；
   - runtime finalization 中 gate-critical 项失败。
2. 否则存在 INFRA_DEFECT → infra。
3. 否则存在 PRODUCT_DEFECT，或非 null 的 P0 coverage 低于阈值 → fail。
4. 否则仅有 FLAKY：product → unstable，strict → fail。
5. 否则 pass。

PRODUCT_DEFECT 和 INCOMPLETE 不允许配置为 warn。Profile 只允许：

```yaml
gate:
  strategy: product | strict
  min_p0_coverage_pct: 100
```

Gate Draft 在 AUDITED 后计算并 write-once；报告层只能读取。最终 `results.json` 必须与 Gate Draft 一致。

### 11.6 Issue 分类

| 分类 | Gate 影响 |
|---|---|
| PRODUCT_DEFECT | fail |
| TEST_DEFECT | incomplete |
| PLAN_DEFECT | incomplete |
| INFRA_DEFECT | infra，除非存在更高优先级 incomplete |
| FLAKY | product=unstable；strict=fail |

分类不确定且无法安全重试时，不得猜测 PRODUCT，应归入 TEST/PLAN 或给出 `classification_confidence` 并使审查 incomplete。

### 11.7 CI 信任模式

Host Trust Context 由 CI/宿主注入，Profile 只能请求更严格限制，不能提升权限：

- trusted：允许 manage、受信 Profile/Adapter、受控凭据。
- untrusted_pr：权威 Profile/Policy/Route Map/Contract 必须来自 base revision、CI fixed path 或受签名 overlay；强制 connect；目标由可信 CI 容器预先启动；不得执行 PR 自带 startup script、Adapter 或包脚本。
- untrusted_pr 默认 auth=none；需要认证时只能使用隔离、一次性、最小权限测试账号和独立租户，禁止复用开发者/生产凭据或高权限 storage state。
- `auth_scope_id` 由宿主生成，Profile 只能引用已批准 ID，不能自行声明与其他身份相同。
- Host Trust Context 与 Profile 冲突时取更严格值，并把冲突记录在 Preflight。
- Host Trust Context 必须来自项目根目录之外的 CI 保护配置、宿主 API 或可验证签名输入；仓库内普通文件不得作为提权来源。

### 11.8 门禁产物

`results.json` 是唯一机器门禁事实源。Markdown/HTML 报告不得修改 gate 或 exit code。

---

## 十二、Profile 与安全契约

### 12.0 MCP 宿主授权优先

Profile 不是授权源。MCP Host Context 决定：

- 可访问的 workspace real root；
- trusted / untrusted_pr 上限；
- 允许的 auth scope；
- 是否允许 manage、Adapter、startup、网络故障注入和生产目标；
- 并发与磁盘预算。

Profile 只能在这些上限内进一步收紧。工具参数中的 `project_subpath`、`profile_path`、`diff_ref` 必须在 workspace 和策略内解析；禁止接受 Agent 提供的任意绝对 `project_root`、`run_directory` 或凭据值。

### 12.1 Profile 示例

```yaml
schema_version: "2.1"
name: example-project

# 信任等级由 Host Trust Context 注入；Profile 只能声明最低要求。
trust_requirements:
  minimum_mode: untrusted_pr     # untrusted_pr | trusted；不能把宿主从 untrusted 提升为 trusted
  approved_config_sources: [base, fixed, head]

target:
  base_url: http://localhost:3000
  allowed_origins: [http://localhost:3000]
  allowed_network_origins: [http://localhost:3000]
  production: false

lifecycle:
  mode: connect
  startup:
    command: npm run dev
    cwd: .
    timeout_ms: 120000
  health_checks:
    - url: http://localhost:3000
      expected_status: 200
      timeout_ms: 5000

discovery:
  max_pages: 100
  max_depth: 4
  max_links_per_page: 50
  max_controls_per_page: 500
  max_text_chars_per_page: 50000
  max_redirects: 10
  route_deduplication: normalized_pattern
  include_iframes: same_origin
  include_popups: false

playwright:
  browsers: [chromium]
  locale: zh-CN
  viewports:
    - { width: 1440, height: 900 }

matrix_budget:
  max_execution_instances: 256
  on_exceed: fail_preflight      # v2.1 唯一允许值；禁止静默裁剪/降档

execution_tiers:
  smoke:
    workers: 1
    retries: 0
    trace: retain-on-failure
    video: off
  fast:
    workers: 4
    retries: 0
    trace: retain-on-failure
    video: off
  full:
    workers: 4
    retries: 1
    trace: on
    video: retain-on-failure

auth:
  mode: none
  storage_state_path: .autopw/auth/state.json
  username_env: TEST_USERNAME
  password_env: TEST_PASSWORD
  auth_scope_ref: anonymous

automation:
  require_seed_discovery: false
  seed_adapter: adapters/seed.mjs
  assertion_adapter: adapters/assertions.ts
  scenario_contract: .autopw/scenario-contract.json
  validation_preset: {}

planner:
  provider: openai
  model: configured-model-id
  api_key_env: OPENAI_API_KEY
  timeout_ms: 30000
  max_attempts: 2
  max_output_tokens: 6000
  temperature: 0

safety:
  destructive_actions: deny
  allowed_file_roots: [tests/fixtures]
  allowed_env: [NODE_ENV, TEST_USERNAME, TEST_PASSWORD]
  redact_fields: [password, token, authorization, cookie]
  mask_sensitive_controls: true

retention:
  policy_ref: default-local
  overrides:                       # 只能比 Host Policy 更短/更小
    evidence_ttl_days: 14
    trace_video_ttl_days: 7

reporting:
  allow_remote_assets: false
  html_csp: "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"

gate:
  strategy: product
  min_p0_coverage_pct: 100

diff:
  route_map: .autopw/route-map.json
  default_ref: origin/main...HEAD
  on_empty: pass

reliability:
  heartbeat_interval_ms: 5000
  lease_ttl_ms: 30000
  lease_safety_factor: 6          # 必须 >=4，且 ttl >= heartbeat × factor
  takeover_grace_ms: 10000        # 必须 >= heartbeat ×2
  clock_skew_tolerance_ms: 2000
  takeover_confirmation_count: 2
  runner_timeout_ms: 1800000
  test_timeout_ms: 600000
  navigation_timeout_ms: 10000
  max_resume_attempts: 3
  circuit_breaker_threshold: 3

artifacts:
  root: .autopw/runs
  discovery_cache: .autopw/discovery-cache
  plan_cache: .autopw/plan-cache
  previews: .autopw/previews
```

`trust_requirements.minimum_mode` 表示项目要求的最低隔离级别：`untrusted_pr` 比 `trusted` 更严格。它不能覆盖 Host Trust Context，也不能开启额外权限。`auth_scope_ref` 只引用 Host Trust Context 已批准的身份范围，Preflight 将其解析为不可伪造的 `auth_scope_id`。

### 12.2 配置唯一来源

- Coverage Policy 是 scenario 集合和业务覆盖的唯一来源；
- Profile `execution_tiers` 只定义运行参数，不重复定义 scenario；
- `playwright` 定义浏览器、locale 和 viewport，不再重复 workers/retries；
- `matrix_budget` 定义 Profile 软上限，Host Context 提供不可突破的硬上限；full 超限只能 Preflight 失败；
- `retention` 只能引用 Host 已批准策略并进一步收紧 TTL/配额，不能延长保留期或提高配额；
- 内核提供默认值，Profile 可在合法范围覆盖；
- 配置冲突必须报错，不能静默选择一个来源。

### 12.3 明文凭据

以下均拒绝：

- Profile 中直接出现密码、Token、Cookie、私钥；
- Adapter 配置包含明文秘密；
- request/result/report 中落盘秘密；
- Planner 输入中包含解析后的秘密值。

仅允许环境变量名或受控 secret reference。

### 12.4 Production 约束

`production=true` 时：

- destructive_actions 只能 deny 或 read_only；
- 禁止 manage；
- 禁止 Seed 修改；
- 禁止 service_error/network_failure 的侵入式全局注入，除非目标为隔离测试租户且 Profile 明确证明；
- 默认关闭 video；
- screenshot/trace 必须 mask 敏感控件；
- evidence retention 使用比 trusted 测试环境更短的 Host-approved 期限；Profile 只能进一步缩短，不能延长。

### 12.5 Adapter 与自定义断言沙箱

即使 trusted 模式，Seed Adapter 和 Assertion Adapter 也必须：

- 独立进程；
- 环境变量白名单；
- 文件系统根目录限制；
- 默认无宿主密钥；
- 网络 origin 白名单；
- 超时和输出大小限制；
- 返回符合 Schema 的结果；
- 记录 adapter digest 和版本。

Assertion Adapter 只能注册受控 `expectation_handler_id`，由 execution fixture 调用；不得被生成测试直接 import，不得接收原始宿主路径或未脱敏秘密。untrusted_pr 禁止执行 Head Adapter。

### 12.6 网络边界

限制不仅适用于页面导航，还适用于：

- fetch/XHR；
- WebSocket；
- iframe；
- redirect；
- popup；
- service worker；
- mock/abort route；
- 资源下载。

越界请求默认阻断并记录 `SAFETY_POLICY_VIOLATION`。

### 12.7 路径边界

路径校验必须覆盖：

- `..`；
- 绝对路径；
- symlink；
- Windows junction；
- UNC；
- 大小写规范化；
- realpath 后根目录锚定；
- TOCTOU 风险的二次校验。

### 12.8 证据安全

- 文本日志落盘前脱敏；
- screenshot 前 mask password、token、PII selector；
- trace/video 采用访问权限 0700 或平台等价权限；
- evidence manifest 记录 `redaction_status`；
- `content_digest` 对落盘后的已脱敏内容计算；
- 到期自动清理；
- evidence collector 失败不能被当作成功脱敏。

### 12.9 报告渲染安全

- 页面文本、Planner description、console、URL 和 issue actual/expected 均按不可信字符串转义；
- HTML 报告禁止内联脚本和远程资源，使用严格 CSP；
- 链接只允许相对 artifact path 或批准的 `http/https`，拒绝 `javascript:`、`data:text/html` 等危险 scheme；
- Markdown 中的 HTML 默认禁用或转义；
- 报告生成失败时使用内置最小模板；只有最小模板也无法原子落盘时才升级为 Fatal Failure；
- 报告不得重新计算或覆盖 Gate Draft。


---

## 十三、核心数据契约

### 13.1 Schema 规范

所有持久化 JSON 文件必须有 JSON Schema Draft 2020-12。Schema 使用：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autopw.dev/schemas/<name>-2.1.schema.json",
  "type": "object",
  "additionalProperties": false
}
```

要求：

- 核心对象默认 `additionalProperties:false`；
- 所有 enum、required、pattern、minimum 和跨对象引用明确；
- 写入前和读取后均验证；
- Schema version 不兼容时拒绝 resume；
- 本章中的 JSON 是规范性结构示例，不得把 `"Issue[]"` 等伪类型写进真实文件。

规范 Schema 清单：

```text
mcp-operation.schema.json
mcp-tool-envelope.schema.json
mcp-status-view.schema.json
request.schema.json
input-versions.schema.json
run-state.schema.json
target-result.schema.json
seed-result.schema.json
discovery.schema.json
derivation.schema.json
planner-output.schema.json
plan.schema.json
mapping-audit.schema.json
execution-manifest.schema.json
checkpoint.schema.json
event.schema.json
evidence-manifest.schema.json
issues.schema.json
completion-audit.schema.json
results.schema.json
gate-draft.schema.json
terminalization.schema.json
finalization-result.schema.json
failure.schema.json
cleanup-result.schema.json
coverage-policy.schema.json
retention-policy.schema.json
route-map.schema.json
scenario-contract.schema.json
profile.schema.json
```

### 13.2 MCP `operation.json`

```json
{
  "schema_version": "2.1",
  "operation_id": "OP-...",
  "operation_type": "audit",
  "client_request_id": "uuid-or-host-stable-id",
  "installation_id": "local-installation-id",
  "workspace_id": "workspace-id",
  "run_id": "RUN-...",
  "status": "ACCEPTED",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "request_digest": "sha256:...",
  "result_ref": null,
  "error_ref": null
}
```

`operation.json` 必须在创建型 MCP 工具返回 accepted 前原子提交。相同 `client_request_id` 的参数摘要不同则返回 `IDEMPOTENCY_CONFLICT`。Operation 是 MCP 查询索引，不替代 `run_state.json`。

### 13.3 `request.json`

```json
{
  "schema_version": "2.1",
  "operation_id": "OP-...",
  "client_request_id": "uuid-or-host-stable-id",
  "run_id": "RUN-...",
  "workspace_id": "workspace-id",
  "project_subpath": ".",
  "project_root": "<redacted-or-relative>",
  "profile_source": ".autopw/profile.yaml",
  "base_tier": "fast",
  "diff_ref": "origin/main...HEAD",
  "mcp_host_context_snapshot": {
    "installation_id": "local-installation-id",
    "caller_id": "codex-session-or-user?",
    "workspace_id": "workspace-id",
    "trust_mode": "trusted",
    "config_source": "head",
    "auth_scope_id": "default-test-user",
    "policy_id": "host-policy-v1"
  },
  "lifecycle_mode": "connect",
  "scope": {
    "affected_features": ["search"],
    "new_features": ["search"],
    "propagate": false
  }
}
```

不再包含无来源的 `goal` 字段。

### 13.4 `input-versions.json`

```json
{
  "schema_version": "2.1",
  "engine_version": "2.1.0",
  "schema_bundle_version": "2.1",
  "profile_digest": "sha256:...",
  "coverage_policy_digest": "sha256:...",
  "route_map_digest": "sha256:...",
  "scenario_contract_digest": "sha256:...",
  "planner_provider": {
    "id": "openai",
    "version": "...",
    "model_id": "configured-model-id"
  },
  "source_revision": "git-sha?"
}
```

这些摘要不构成哈希链，只用于版本锚定、缓存和恢复兼容性。

### 13.5 `run_state.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "phase": "RUNNING",
  "run_status": "ACTIVE",
  "audit_status": null,
  "state_version": 17,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "project_root_realpath": "<redacted>",
  "artifacts_root_realpath": "<redacted>",
  "lease": {
    "owner_id": "worker-...",
    "expires_at": "ISO8601",
    "heartbeat_at": "ISO8601"
  },
  "checkpoint_seq": 20,
  "resume_attempts": 0,
  "last_error": null,
  "runtime_finalization": {
    "browser": "PENDING|DONE|FAILED",
    "proxy": "NOT_REQUIRED|PENDING|DONE|FAILED",
    "target_shutdown": "NOT_REQUIRED|PENDING|DONE|FAILED",
    "temporary_secrets": "NOT_REQUIRED|PENDING|DONE|FAILED"
  },
  "deferred_cleanup": {
    "seed_data": "NOT_REQUIRED|PENDING|DONE|FAILED"
  }
}
```

heartbeat 和 Phase 更新必须通过同一个串行状态写入器或 CAS，禁止读改写覆盖。FAILED 状态不得伪造 audit_status 或 gate。

### 13.6 `discovery.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "inspected_at": "ISO8601",
  "base_url": "http://localhost:3000",
  "auth_scope_id": "anonymous",
  "cache": {
    "hit": false,
    "validation_kind": "build_id|etag|last_modified|probe|none",
    "source_digest": "sha256:..."
  },
  "pages": [
    {
      "page_id": "PAGE-search",
      "route": "/search",
      "url": "http://localhost:3000/search",
      "title": "搜索",
      "status": 200,
      "content_digest": "sha256:...",
      "controls": [],
      "endpoints": [],
      "expectations": [],
      "validation_text_refs": [],
      "screenshot_ref": "evidence/..."
    }
  ],
  "features": [
    {
      "id": "search",
      "capability": "search",
      "priority": "P0",
      "route": "/search",
      "signals": [],
      "scenario_observations": []
    }
  ],
  "candidate_catalog": {
    "actions": [],
    "routes": [],
    "controls": [],
    "locators": [],
    "inputs": [],
    "expectations": [],
    "endpoints": []
  },
  "limits": {
    "truncated": false,
    "warnings": []
  }
}
```

不得把整页原始 HTML 或无限制 DOM text 直接提供给 Planner。

### 13.7 `derivation.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "base_tier": "fast",
  "scope": {},
  "cells": [
    {
      "matrix_cell": "search:normal",
      "feature_id": "search",
      "scenario": "normal",
      "priority": "P0",
      "effective_tier": "fast",
      "status": "PLANNED",
      "case_id": "CASE-search-normal",
      "discovery_evidence": [],
      "allowed_candidate_ids": {
        "actions": ["ACT-fill-search"],
        "routes": ["ROUTE-search"],
        "locators": ["LOC-search-role"],
        "inputs": ["INPUT-search-normal"],
        "endpoints": [],
        "expectations": ["EXP-search-results-visible"]
      },
      "reason": "new feature under fast base tier"
    }
  ],
  "summary": {
    "matrix_total": 0,
    "planned": 0,
    "observed_blocked": 0,
    "not_applicable": 0,
    "tier_skipped_scope": 0,
    "tier_skipped_priority": 0,
    "tier_skipped_scenario": 0,
    "policy_discovery_conflicts": 0
  }
}
```

### 13.8 `planner-output.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "provider": {
    "id": "openai",
    "version": "...",
    "model_id": "configured-model-id"
  },
  "attempt": 1,
  "cases": [
    {
      "case_id": "CASE-search-normal",
      "actions": [
        {
          "action_template_id": "ACT-fill-search",
          "locator_id": "LOC-search-role",
          "input_id": "INPUT-search-normal"
        }
      ],
      "expectation_ids": ["EXP-search-results-visible"]
    }
  ]
}
```

不允许包含自由代码、CSS、XPath、绝对路径、任意 URL 或秘密值。

### 13.9 `plan.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "base_tier": "fast",
  "cases": [
    {
      "id": "CASE-search-normal",
      "order": 1,
      "feature_id": "search",
      "scenario": "normal",
      "priority": "P0",
      "effective_tier": "fast",
      "resumability": {
        "mode": "SAFE_RERUN|RESET_REQUIRED|NON_RESUMABLE",
        "reset_strategy_id": "RESET-search?"
      },
      "derivation": {
        "matrix_cell": "search:normal",
        "policy_source": ".autopw/coverage-policy.json",
        "discovery_evidence": [],
        "scope_reason": "new feature",
        "tier_reason": "fast base + new feature"
      },
      "steps": [
        {
          "step": 1,
          "action": {
            "kind": "fill",
            "locator_id": "LOC-search-role",
            "input_id": "INPUT-search-normal"
          },
          "expectation_ids": []
        },
        {
          "step": 2,
          "action": {
            "kind": "press",
            "locator_id": "LOC-search-role",
            "key": "Enter"
          },
          "expectation_ids": ["EXP-search-results-visible"]
        }
      ],
      "coverage_bindings": [
        {
          "matrix_cell": "search:normal",
          "action_step": 1,
          "expectation_step": 2,
          "expectation_id": "EXP-search-results-visible"
        }
      ],
      "weak_validation": false
    }
  ]
}
```

navigate action 使用 `route_id`；press/resize 等非候选参数只能来自 ActionTemplate 的 `fixedArguments`，不得由 Planner 自由填写。

### 13.10 `mapping-audit.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "planned_case_ids": [],
  "generated_case_ids": [],
  "duplicates": [],
  "missing": [],
  "unexpected": [],
  "marker_errors": [],
  "status": "PASS|FAIL"
}
```

不再要求 `planned case count == generated file count`。

### 13.11 `execution-manifest.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "logical_cases": [
    {
      "case_id": "CASE-search-normal",
      "required_execution_ids": [
        "EXE-a13f70c2"
      ]
    }
  ],
  "batches": [
    {
      "batch_id": "BATCH-fast-chromium-1440x900",
      "key": {
        "tier": "fast",
        "browser": "chromium",
        "viewport": { "width": 1440, "height": 900 },
        "locale": "zh-CN",
        "auth_scope_id": "anonymous"
      },
      "execution_ids": [
        "EXE-a13f70c2"
      ]
    }
  ],
  "executions": [
    {
      "execution_id": "EXE-a13f70c2",
      "case_id": "CASE-search-normal",
      "batch_id": "BATCH-fast-chromium-1440x900",
      "status": "NOT_RUN",
      "attempts": [],
      "evidence_refs": [],
      "infrastructure_block_id": null
    }
  ]
}
```

同一 `case_id` 可以出现在多个 Execution Instance 中，但每个 `execution_id` 必须全局唯一。

### 13.12 `events.jsonl` 与 `checkpoint.json`

每行 Event 都符合 `event.schema.json`：

```json
{"seq":1,"at":"ISO8601","type":"EXECUTION_STARTED","execution_id":"EXE-...","case_id":"CASE-search-normal","batch_id":"BATCH-fast-chromium-1440x900","attempt":1}
```

`checkpoint.json` 是原子快照：

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "checkpoint_seq": 10,
  "last_event_seq": 72,
  "execution_states": {},
  "completed_batch_ids": [],
  "updated_at": "ISO8601"
}
```

禁止将多个 JSON 对象直接追加到 `checkpoint.json`。

### 13.13 `evidence-manifest.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "items": [
    {
      "evidence_id": "EVD-...",
      "execution_id": "EXE-...",
      "case_id": "CASE-search-normal",
      "kind": "screenshot|console|network|trace|video|runner_log|route_match",
      "path": "evidence/...",
      "created_at": "ISO8601",
      "redaction_status": "COMPLETE|FAILED|NOT_APPLICABLE",
      "content_digest": "sha256:..."
    }
  ]
}
```

`content_digest` 对已脱敏落盘内容计算，用于损坏检测，不用于构建审计链。

### 13.14 `issues.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "issues": [
    {
      "issue_id": "ISSUE-...",
      "execution_id": "EXE-...",
      "case_id": "CASE-search-normal",
      "classification": "PRODUCT_DEFECT|TEST_DEFECT|PLAN_DEFECT|INFRA_DEFECT|FLAKY",
      "classification_confidence": "HIGH|MEDIUM|LOW",
      "severity": "Critical|High|Medium|Low",
      "category": "Functional|Visual|Accessibility|Console|UX|Content|Security",
      "feature_id": "search",
      "scenario": "normal",
      "effective_tier": "fast",
      "trigger_step": 2,
      "input_refs": [],
      "preconditions": [],
      "expected": "string",
      "actual": "string",
      "first_failure": {},
      "diagnostic_rerun": null,
      "evidence_refs": [],
      "derivation_ref": "search:normal",
      "suggested_fix": null
    }
  ]
}
```

由 TERMINALIZING 在执行前创建的问题可以没有 `execution_id`，但必须有 `case_id` 或全局 scope 和明确原因。所有字符串写报告前转义。

### 13.15 `completion-audit.json`

```json
{
  "schema_version": "2.1",
  "run_id": "RUN-...",
  "audit_status": "COMPLETE|INCOMPLETE",
  "checks": {
    "planned_equals_generated_case_ids": true,
    "required_equals_collected_execution_ids": true,
    "all_required_executions_accounted": true,
    "infra_blocked_executions_have_complete_batch_evidence": true,
    "failure_evidence_complete": true,
    "coverage_bindings_valid": true,
    "no_forbidden_modifiers": true,
    "schemas_valid": true,
    "no_test_or_plan_defects": true,
    "no_low_confidence_classifications": true,
    "no_p0_blockers": true,
    "runtime_finalization_complete": true
  },
  "case_sets": {
    "planned": [],
    "generated": []
  },
  "execution_sets": {
    "required": [],
    "collected": [],
    "started": [],
    "trusted_terminal": [],
    "infra_resolved": [],
    "accounted": []
  },
  "weak_validation_warnings": [],
  "incomplete_reasons": []
}
```

必须满足：`planned cases = generated cases`，以及 `required executions = collected executions = accounted executions`。`started`、`trusted_terminal` 和 `infra_resolved` 是 accounted 的组成集合，不要求彼此等于 planned。

### 13.16 `results.json`

```json
{
  "schema_version": "2.1",
  "kind": "managed",
  "run_id": "RUN-...",
  "phase": "GATED",
  "audit_status": "COMPLETE",
  "gate": "pass",
  "exit_code": 0,
  "base_tier": "fast",
  "summary": {
    "logical_cases": {
      "planned": 0,
      "passed": 0,
      "failed": 0,
      "flaky": 0,
      "infra": 0,
      "incomplete": 0
    },
    "executions": {
      "required": 0,
      "passed": 0,
      "failed": 0,
      "flaky": 0,
      "interrupted": 0,
      "blocked_resume": 0,
      "infra_blocked": 0
    },
    "p0_coverage_pct": null,
    "duration_ms": 0,
    "by_effective_tier": {
      "smoke": {},
      "fast": {},
      "full": {}
    }
  },
  "coverage": {
    "matrix_total": 0,
    "planned": 0,
    "observed_blocked": 0,
    "not_applicable": 0,
    "tier_skipped": 0,
    "weak_validation": 0,
    "p0_covered": 0,
    "p0_required_total": 0,
    "mandatory_capability_blockers": []
  },
  "issues": [],
  "warnings": [],
  "artifacts": {
    "report_md": "report.md",
    "report_html": "report.html",
    "cdd": "coverage-derivation.md",
    "issues_json": "issues.json",
    "run_directory": "..."
  },
  "gate_policy": {
    "strategy": "product",
    "min_p0_coverage_pct": 100,
    "precedence": ["incomplete", "infra", "fail", "unstable", "pass"]
  }
}
```

### 13.17 `terminalization.json`、`failure.json` 与 Finalization

`terminalization.json` 用于可审计的提前终止，至少包含触发 Phase、分类、未执行 Case/Execution 范围和 Gate 影响。它仍会产生 `results.json`。

`failure.json` 仅用于 Fatal Failure，至少包含稳定错误码、最后可信 Phase、state version、是否成功释放 lease、可选恢复建议和已脱敏诊断路径。它不得包含 `gate` 字段。

`finalization-result.json` 记录 runtime finalization；`cleanup-result.json` 记录 GATED 后的延迟 Seed 数据清理。二者不得混淆。

在 Coverage 尚未推导前因“目标整体不可用”进入 TERMINALIZING 时，只有 health/runner 证据足以证明整个请求 scope 被同一基础设施故障统一阻断，Audit 才可 COMPLETE 并 gate=infra；Seed、Planner、Policy、测试生成或安全可信度问题均为 INCOMPLETE。


---

## 十四、错误、恢复与清理

### 14.1 错误分类与去向

| 错误码 | 可恢复 | 去向 |
|---|---|---|
| PROFILE_NOT_FOUND / PROFILE_INVALID | 否，Preflight | 不创建 Run，CLI 64 |
| TRUST_POLICY_INVALID | 否，Preflight | 不创建 Run，CLI 64 |
| COVERAGE_POLICY_INVALID | 否，通常 Preflight | 不创建 Run；若创建后才发现完整性损坏则 Fatal Failure |
| RUN_INVALID / RUN_PHASE_INVALID | 否 | Fatal Failure，CLI 70 |
| STATE_VERSION_CONFLICT | 是 | INTERRUPTED，MCP `resume_run` 或维护 CLI 可恢复 |
| PLAN_INVALID | 是，限 maxAttempts | 耗尽后 PLAN_DEFECT → TERMINALIZING → incomplete |
| PLAN_ALREADY_FROZEN | 否 | Fatal Failure |
| SUITE_INVALID | 确定性重编译一次 | 仍失败则 TEST_DEFECT → TERMINALIZING；若编译器完整性不可证明则 Fatal Failure |
| SAFETY_POLICY_VIOLATION | 否 | 停止新执行；可完整记录时 TERMINALIZING/incomplete，否则 Fatal Failure |
| TARGET_UNHEALTHY / TARGET_START_FAILED | 是 | 重试耗尽且边界清晰时 TERMINALIZING/infra；状态不确定时 incomplete |
| SEED_FAILED | 是 | 重试耗尽 → TERMINALIZING/incomplete |
| DISCOVERY_FAILED | 是 | 重试耗尽 → TERMINALIZING/incomplete |
| LEASE_CONFLICT | 是 | 不修改原 Run；调用方临时错误 75 |
| EVIDENCE_COLLECTION_FAILED | 部分可恢复 | 审计 incomplete |
| RESUME_RESET_REQUIRED | 是 | INTERRUPTED |
| RESUME_UNSAFE | 否 | BLOCKED_RESUME/incomplete |
| CACHE_INVALID | 是 | 隔离/删除缓存后重算 |
| MATRIX_BUDGET_EXCEEDED | 否，需显式收窄 | Preflight 不创建 Run；返回 projected instances 与收窄建议 |
| RETENTION_QUOTA_EXCEEDED | 是，等待清理或调整 Host 策略 | 不删除未过期事实；拒绝新 Run |
| REPORT_RENDER_FAILED | 是 | 使用内置降级报告；降级也失败则 Fatal Failure |

错误负载不得包含明文凭据；路径默认相对化或脱敏。

### 14.2 Lease、Heartbeat 与安全接管

配置必须满足：

```text
lease_safety_factor >= 4
lease_ttl_ms >= heartbeat_interval_ms × lease_safety_factor
takeover_grace_ms >= heartbeat_interval_ms × 2
```

默认值为 heartbeat=5s、TTL=30s、safety factor=6、takeover grace=10s。Profile 只能在 Host Policy 允许范围内采用更保守的值，不能降低硬性倍数。

接管规则：

- createRun 获取 lease，ACTIVE 期间续租，GATED 或 FAILED 后释放；
- `INTERRUPTED + expired lease` 可以进入接管竞争；
- `ACTIVE` 只有在 lease 已过期、heartbeat 超过 `lease_ttl_ms + takeover_grace_ms` 未更新、时钟宽限已扣除，并连续 `takeover_confirmation_count` 次观测为 stale 时才可接管；
- 同主机上能够执行 Worker liveness probe 时，进程仍存活则禁止接管；无法确认存活时必须等待完整 grace window；
- 接管前必须以 CAS 更新 lease owner，失败者不得修改 Run；
- 接管后把遗留 RUNNING execution 转为 INTERRUPTED，但 mutating Case 仍必须经过 SAFE_RETRY/RESET_REQUIRED/NON_RESUMABLE 判定，不得仅因 lease stale 自动重跑；
- 单次 heartbeat 延迟、一次 CAS 超时或短暂停顿不得触发接管；
- 系统时钟只允许有限 `clock_skew_tolerance_ms`，不得无限延长或提前判定失联 lease。

### 14.3 恢复语义

AutoPW 只保证 at-least-once。恢复时：

1. 读取并验证 `run_state.json`、input versions、checkpoint 和 events；
2. 校验 Host Trust Context 与 auth scope 未被提升或替换；
3. 将遗留 RUNNING execution 转为 INTERRUPTED；
4. NOT_RUN execution 可直接执行；
5. INTERRUPTED execution：
   - SAFE_RERUN → 重跑；
   - RESET_REQUIRED → reset 成功后重跑；
   - NON_RESUMABLE 或 reset 失败 → BLOCKED_RESUME；
6. 已有可信终态 execution 不重跑；
7. 达到 max_resume_attempts 后进入 TERMINALIZING，gate=incomplete。

### 14.4 副作用控制

对 create/update/delete、付款、发送消息等动作：

- 默认 deny；
- trusted 测试环境中允许时，必须声明 idempotency key 或 reset strategy；
- case 计划必须标记 resumability；
- 生产目标禁止此类动作；
- 不能证明可重置的 execution 在中断后不得盲目重跑。

### 14.5 Runtime Finalization 与延迟 Cleanup

`RUNTIME_FINALIZED` 前必须尽力完成：

- 关闭浏览器；
- 关闭临时代理和 route 注入；
- 关闭由 manage 启动的目标；
- 删除临时秘密文件。

失败处理：

- 可能泄密、目标状态不确定或关键资源未关闭 → incomplete；
- 仅非关键清理失败且有完整证据 → INFRA issue，由 Gate 优先级处理；
- Run Storage 已不可写 → Fatal Failure。

Run 级 Seed 业务数据默认在 GATED 后由幂等 `cleanup` 执行，写 `cleanup-result.json`，不得追溯修改已冻结 `results.json`。只有 Profile 明确把某种 Seed teardown 标记为 gate-critical 时，它才属于 runtime finalization。


---

## 十五、测试要求（强制）

### 15.1 测试原则

1. 完成真相不可伪造；
2. Phase 与 Run Status 不得混淆；
3. 模型输出永远是不可信输入；
4. 门禁必须满足固定优先级；
5. 并行不得污染状态；
6. 缓存命中不得绕过验证；
7. 恢复必须验证副作用安全；
8. 性能只在标准环境固化。

### 15.2 相位和存储不变量

| 编号 | 不变量 |
|---|---|
| INV-STATE-01 | Preflight 未完成不得 createRun |
| INV-STATE-02 | 正常 Phase 和 TERMINALIZING 分支均不可非法跳过或逆序 |
| INV-STATE-03 | connect/manage 均经过 TARGET_READY 与 SEED_RESOLVED |
| INV-STATE-04 | COMPLETE/INCOMPLETE 只能出现在 audit_status，不是 Phase |
| INV-STATE-05 | PLAN_FROZEN 后 plan write-once |
| INV-STATE-06 | run_state 原子写且 state_version 单调递增 |
| INV-STATE-07 | heartbeat 不得覆盖新 Phase |
| INV-LEASE-01 | `lease_ttl_ms >= heartbeat_interval_ms × lease_safety_factor` 且 factor >=4 |
| INV-LEASE-02 | 单次 heartbeat 延迟或未满足 grace/连续确认不得接管 ACTIVE Run |
| INV-LEASE-03 | stale 接管后的 mutating instance 必须再次经过 resumability/reset 判定 |
| INV-STATE-08 | CAS 冲突时只有一个执行者继续推进 |
| INV-STATE-09 | NOOP 不创建 Run、lease 或伪造 phase 文件 |
| INV-STATE-10 | AUDITED 无论 COMPLETE/INCOMPLETE 都能 REPORTED→GATED |
| INV-STATE-11 | Planner/Seed 等受控失败通过 TERMINALIZING 到 Gate，不跨 Phase |
| INV-STATE-12 | Fatal Failure 只写 failure，不伪造 Gate |
| INV-STATE-13 | Gate Draft 与 results 一致，报告层不能改写 |
| INV-STATE-14 | 报告主模板失败时降级模板仍能完成；全部落盘失败才 Fatal |

### 15.3 结构审计不变量

| 编号 | 不变量 |
|---|---|
| INV-STRUCT-01 | planned logical cases == generated logical cases |
| INV-STRUCT-02 | required execution instances == collected == accounted |
| INV-STRUCT-03 | started/trusted-terminal/infra-resolved 是 execution accounted 的组成集合，不与 logical case 集合混用 |
| INV-STRUCT-04 | 测试文件数不参与 case 数量相等判断 |
| INV-STRUCT-05 | 每个 case marker 和 coverage binding 有效 |
| INV-STRUCT-06 | 一个 full logical case 正确展开为全部 browser×viewport execution instances |
| INV-STRUCT-07 | 存在 NOT_RUN/RUNNING/INTERRUPTED/BLOCKED_RESUME 时 audit incomplete；INFRA_BLOCKED 只有在批次证据完整时可解释 |
| INV-STRUCT-08 | 99% passed + 1 必需 execution 未执行 → incomplete |
| INV-STRUCT-09 | 100 次故障注入不得把 pending 标成 terminal |
| INV-STRUCT-10 | 失败证据不完整 → incomplete |
| INV-STRUCT-11 | report 不能修改 results gate |

### 15.4 Discovery 和推导不变量

| 编号 | 不变量 |
|---|---|
| INV-DISC-01 | 每个 required cell 使用 scenario observation，不使用 feature 级推断 |
| INV-DISC-02 | Discovery 超限不能静默丢弃可能的 P0 |
| INV-MTX-01 | 先计算 effective tier，再裁剪 priority/scenario |
| INV-MTX-02 | fast base 下新功能 fast、旧功能 smoke |
| INV-MTX-03 | full base 下 in-scope feature 均 full |
| INV-MTX-04 | 每个 PLANNED cell 恰好对应一个 case |
| INV-MTX-05 | required P0 blocker 计入分母并使 gate incomplete |
| INV-MTX-06 | NOT_APPLICABLE 必须有 rationale |
| INV-MTX-07 | Policy required + Discovery not applicable 是冲突，不得静默跳过 |
| INV-MTX-08 | mandatory capability 的 always sentinel 正确进入 scope；when_affected 不误阻断无关 Diff |

### 15.5 Planner 和锚定不变量

| 编号 | 不变量 |
|---|---|
| INV-PLAN-01 | Planner 只能选择允许 Candidate ID |
| INV-PLAN-02 | Planner 输出含代码/CSS/XPath/任意 URL/路径时拒绝 |
| INV-PLAN-03 | 页面提示注入文本不能改变系统规则 |
| INV-PLAN-04 | locator matchCount 必须满足唯一性约束 |
| INV-PLAN-05 | invalid_input 不得自动复用 required_field 空值 |
| INV-PLAN-06 | normal 必须有结构化 expectation；no_page_error 不得默认单独充当行为断言 |
| INV-PLAN-07 | 弱校验必须计入 CDD 与 warnings |
| INV-PLAN-08 | 缓存 PlanTemplate 必须重新绑定 run/seed/auth |
| INV-PLAN-09 | 缓存命中后仍执行全部 Plan Validator |

### 15.6 执行和并行不变量

| 编号 | 不变量 |
|---|---|
| INV-EXEC-01 | 混合 tier 必须拆为正确 batch |
| INV-EXEC-02 | full logical case 必须展开为完整获批 browser×viewport×locale×auth scope execution instances |
| INV-EXEC-03 | projected instances 超过有效 matrix budget 时 Preflight 返回 MATRIX_BUDGET_EXCEEDED 且不创建 Run |
| INV-EXEC-04 | full 不得静默裁剪、抽样、pairwise 化或自动降档 |
| INV-EXEC-03 | batch 内 execution 按 case_id/execution_id 排序 |
| INV-EXEC-04 | 普通 case 失败不阻止其余可执行实例；全局安全/完整性事件必须停止 |
| INV-EXEC-05 | 每 execution 独立 BrowserContext |
| INV-EXEC-06 | 禁止跨 case `test.describe.serial` |
| INV-EXEC-07 | 生成代码只从 execution fixture 导入 |
| INV-EXEC-08 | smoke/fast flaky 由 diagnostic rerun 识别 |
| INV-EXEC-09 | diagnostic rerun 不覆盖首次失败事实 |
| INV-EXEC-10 | evidence collector 失败不能被算作 evidence complete |
| INV-EXEC-11 | 每步执行前重新校验 locator route/origin/唯一性 |

### 15.7 门禁不变量

| 编号 | 不变量 |
|---|---|
| INV-GATE-01 | 优先级固定为 incomplete > infra > fail > unstable > pass |
| INV-GATE-02 | TEST_DEFECT/PLAN_DEFECT/LOW confidence → incomplete |
| INV-GATE-03 | PRODUCT_DEFECT → fail，不能配置 warn |
| INV-GATE-04 | INFRA_DEFECT 或证据完整的批次级 INFRA_BLOCKED → infra，除非存在更高优先级 incomplete |
| INV-GATE-05 | product 下仅 FLAKY → unstable；strict → fail |
| INV-GATE-06 | 非 null P0 coverage 低于门槛 → fail；P0 blocker → incomplete |
| INV-GATE-07 | P0 denominator=0 时 coverage=null 且不伪造 100 |
| INV-GATE-08 | exit code 与 gate 一致 |
| INV-GATE-09 | NOOP empty diff → pass/0 且无 run_id |
| INV-GATE-10 | Fatal Failure 使用 operational exit，不生成 results gate |

### 15.8 恢复不变量

| 编号 | 不变量 |
|---|---|
| INV-RESUME-01 | 已终态 execution 不重跑 |
| INV-RESUME-02 | stale ACTIVE lease 可被安全接管并把遗留 RUNNING 转 INTERRUPTED |
| INV-RESUME-03 | RESET_REQUIRED 必须 reset 成功后才能重跑 |
| INV-RESUME-04 | NON_RESUMABLE 中断 → BLOCKED_RESUME/incomplete |
| INV-RESUME-05 | checkpoint 是合法原子 JSON，events 才使用 JSONL |
| INV-RESUME-06 | 输入版本、Host Trust Context 或 auth scope 不兼容时拒绝 resume |
| INV-RESUME-07 | max resume attempts 达到后通过 TERMINALIZING 到 incomplete |

### 15.9 安全不变量

| 编号 | 不变量 |
|---|---|
| INV-SEC-01 | 明文密码、Token、Cookie、私钥被拒绝 |
| INV-SEC-02 | production + destructive allow 被拒绝 |
| INV-SEC-03 | 项目 Profile 不能提升 Host Trust Context |
| INV-SEC-04 | untrusted_pr 强制 connect，配置来自 base/fixed/approved overlay |
| INV-SEC-05 | untrusted_pr 不执行 PR startup/Adapter/package script |
| INV-SEC-06 | untrusted_pr 不使用高权限或非一次性认证状态 |
| INV-SEC-07 | 页面、XHR、WebSocket、iframe、redirect 越界均阻断 |
| INV-SEC-08 | 生成代码含 node:*、child_process 或直接 Playwright import 被拒 |
| INV-SEC-09 | runner/adapter env 仅含白名单 |
| INV-SEC-10 | 路径越界、symlink、junction、UNC 被拒 |
| INV-SEC-11 | screenshot/trace/video 脱敏策略生效 |
| INV-SEC-12 | evidence redaction 失败不能标 COMPLETE |
| INV-SEC-13 | Planner 不接收解析后的秘密值 |
| INV-SEC-14 | 报告对不可信 HTML/Markdown/URL 完成转义并启用 CSP |

### 15.10 MCP 不变量

| 编号 | 不变量 |
|---|---|
| INV-MCP-01 | `run_audit` accepted 前 Operation 与最小 Run 记录已持久化 |
| INV-MCP-02 | transport 断开不取消 accepted Run |
| INV-MCP-03 | 同一 `client_request_id` 重试不创建第二个 Run |
| INV-MCP-04 | 同一幂等键配不同参数返回 IDEMPOTENCY_CONFLICT |
| INV-MCP-05 | 工具参数不能扩大 workspace、trust、auth 或 network 权限 |
| INV-MCP-06 | status 查询只读，不续租、不推进 Phase、不触发 resume |
| INV-MCP-07 | MCP Server 重启后可查询并接管 stale Operation/Run |
| INV-MCP-08 | Agent 不能传任意 run_directory 读取其他 workspace Run |
| INV-MCP-09 | cancel 走 TERMINALIZING，不能直接删除或伪造 pass |
| INV-MCP-10 | 大型证据和页面内容不突破响应大小与不可信数据边界 |
| INV-MCP-11 | Worker 并发与磁盘预算触发背压，不产生重复执行者 |
| INV-MCP-12 | get_run_result 的 Gate 与冻结 results.json 完全一致 |

### 15.11 单元测试

| 模块 | 必测内容 |
|---|---|
| preflight | Profile、Trust、Diff、NOOP、默认优先级 |
| run-storage | atomic write、CAS、realpath、symlink、state_version、failure/terminalization |
| discovery | scenario observation、Candidate、限制、cache validation |
| derivation | effective tier 顺序、priority/scenario、P0 blocker、capability |
| planner-provider | Schema、timeout、attempt、fixture provider |
| plan-validator | Candidate 锚定、input/expectation、prompt injection、安全 |
| compiler | deterministic output、fixture import、marker、mapping audit |
| batch-planner | mixed tier、logical case→execution instance、browser/viewport、排序 |
| execution | checkpoint、events、evidence、diagnostic rerun |
| audit | logical case 集合、execution instance 集合、evidence complete、audit status |
| gate | 全部组合和固定优先级 |
| recovery | reset、non-resumable、input version compatibility |
| redaction | 文本、截图 mask 元数据、trace/video policy |

### 15.12 集成测试

| 编号 | 场景 |
|---|---|
| INT-01 | trusted manage 完整闭环 |
| INT-02 | connect 模式 Seed SKIPPED 但相位完整 |
| INT-03 | fast base 混合 fast/smoke batches |
| INT-04 | full base 全部 full |
| INT-05 | propagate 全量 |
| INT-06 | empty diff 返回 NOOP |
| INT-07 | Discovery cache 可信验证命中 |
| INT-08 | PlanTemplate cache 重绑定 |
| INT-09 | Planner 非法 ID 重试后 PLAN_DEFECT/incomplete |
| INT-10 | 首 case 产品失败，其余 case 仍启动 |
| INT-11 | TEST_DEFECT 与 PRODUCT_DEFECT 同时存在，gate incomplete |
| INT-12 | INFRA + 未执行不确定性，gate incomplete |
| INT-13 | diagnostic rerun 识别 flaky |
| INT-14 | 中断后 reset 并恢复 |
| INT-15 | non-resumable 中断阻断恢复 |
| INT-16 | untrusted_pr 拒绝 head 配置和 Adapter |
| INT-17 | full case 展开多浏览器/视口 execution 并完整对账 |
| INT-18 | Planner 耗尽后通过 TERMINALIZING 生成 incomplete |
| INT-19 | stale ACTIVE lease 被安全接管 |
| INT-20 | 主报告失败后使用降级报告且 Gate Draft 不变 |
| INT-21 | Fatal Storage Failure 生成 failure.json 且无 results.json |
| INT-22 | MCP run_audit accepted 后客户端断开，Run 仍完成 |
| INT-23 | 重复 client_request_id 返回同一 run_id |
| INT-24 | MCP Server 重启后 status/result 可恢复 |
| INT-25 | Agent 尝试越权 workspace/profile/run_id 被拒绝 |
| INT-26 | cancel_run 受控终止并得到 incomplete |
| INT-27 | 并发超限时排队/背压且不重复执行 |

### 15.13 E2E

| 编号 | 场景 |
|---|---|
| E2E-01 | 标准 demo smoke P95 基准 |
| E2E-02 | 标准 demo fast P95 基准 |
| E2E-03 | 注入 DOM 产品缺陷 → fail |
| E2E-04 | 注入 locator/test defect → incomplete |
| E2E-05 | 目标整体不可用 → infra |
| E2E-06 | runner 崩溃 + safe rerun 恢复 |
| E2E-07 | runner 崩溃 + non-resumable → incomplete |
| E2E-08 | report.md 与 report.html 证据链接和 gate 一致 |
| E2E-09 | 恶意页面提示注入不影响计划约束 |
| E2E-10 | untrusted PR 沙箱路径 |
| E2E-11 | full 多浏览器 logical case/instance 汇总正确 |
| E2E-12 | 恶意报告文本和危险 URL 被转义 |
| E2E-13 | Codex/MCP 工作流：derive→run→poll→result 完整闭环 |
| E2E-14 | MCP transport 中断并重连后继续查询同一 Run |
| E2E-15 | MCP Host Context 阻止 Agent 通过参数提权 |

### 15.14 故障注入

故障包括：进程崩溃、磁盘满、rename 失败、CAS 冲突、网络断开、heartbeat 失败、lease 过期、浏览器崩溃、证据写入失败、编码异常、缓存损坏。

每次验证：

- pending 不变 terminal；
- state_version 不回退；
- JSON 文件合法；
- gate 不误判；
- 敏感数据不泄漏；
- 恢复遵循 resumability。

### 15.14A Retention 与容量不变量

| 编号 | 不变量 |
|---|---|
| INV-RET-01 | 幂等记录 TTL 不短于对应 Operation/Run 最长可查询期 |
| INV-RET-02 | 自动清理不得删除未过期的 results/failure/gate 事实 |
| INV-RET-03 | Artifact 删除前提交 tombstone，删除后查询返回 RESULT_EXPIRED |
| INV-RET-04 | 高水位且无过期对象可清理时拒绝新 Run，不得牺牲未过期事实 |
| INV-RET-05 | cleanup 崩溃后可幂等继续且不会修改已冻结 Gate |

### 15.15 性能测试

性能指标必须按阶段分别记录，`derive_coverage` 的端到端耗时不得用纯 Derivation 的 2 秒预算代替。

| 编号 | 标准环境基准 |
|---|---|
| PERF-01 | smoke 端到端 P95 ≤60s |
| PERF-02 | fast 端到端 P95 ≤180s |
| PERF-03A | 纯 Derivation Engine：从已通过 Schema 校验的 `discovery.json` 到 `derivation.json`，P95 ≤2s；不包含浏览器、页面网络、Planner、文件抓取 |
| PERF-03B | 标准本地 Demo Discovery：smoke P95 ≤15s、fast P95 ≤30s、full P95 ≤90s；真实项目只记录 `discovery_wall_ms` 并受 discovery timeout/page budget 约束，不套用通用 2s 契约 |
| PERF-03C | `derive_coverage` 端到端必须分别报告 `preflight_ms`、`discovery_wall_ms`、`derivation_cpu_ms`、`serialization_ms`，总耗时为各阶段实际值 |
| PERF-04 | cache validate + compile P95 ≤5s |
| PERF-05 | 标准并行数据集 workers=4 对 workers=1 P50 加速 ≥1.8x |
| PERF-06 | Operation/Run retention sweeper 在 100k tombstone 标准数据集上不阻塞 status P95 预算 |

PERF 不使用真实外部模型，使用 DeterministicFixturePlanner。真实页面响应、DNS、第三方网络和目标服务抖动必须作为独立 target timing 报告，不能计入纯 Derivation 实现缺陷。

### 15.16 CI 分层

每个 PR：

1. lint；
2. build；
3. unit；
4. invariants；
5. 关键 integration；
6. 少量确定性 fault injection；
7. 依赖与秘密扫描。

主分支/每日：

1. 完整 E2E；
2. 100 次故障注入；
3. 完整浏览器矩阵；
4. 性能基准；
5. `npm audit --omit=dev`。

发布前运行全部门禁和跨平台验证。禁止 `test.skip`、`test.only`、`test.fixme` 规避强制套件。

### 15.17 覆盖要求

- derivation、plan-validator、audit、gate、run-storage、security 核心模块行覆盖率 ≥90%；
- 每个错误码至少一个负例；
- 每个安全不变量至少一个攻击探针；
- 每个 Phase 转换至少一个正例和一个非法转换负例；
- 不允许仅正例模块。

---

### 15.18 冻结基线与 ADR 回改

M0 的 `MCP Contract Frozen` 表示公共语义已达到可并行实施的受控基线，不表示后续永远不能修改。Phase 1–8 若通过原型、性能、故障注入或宿主集成证明某项冻结契约不可实现或不安全，必须：

1. 新建 ADR，记录证据、影响范围和替代方案；
2. 提升文档 patch/RC 版本；若破坏兼容则提升 Tool/Data Schema 版本；
3. 重新生成 Schema/类型/Fixture；
4. 重跑所有受影响的 `verify:mN`，不仅运行当前阶段测试；
5. 在变更日志中标记 superseded contract。

实现不得以“Phase 0 已冻结”为由保留已知错误，也不得绕过 ADR 私自放宽契约。

---

## 十六、实施路线图（MCP-First）

### Phase 0：冻结 MCP Tool Schema 与 Host Contract

交付：

- MCP 工具集合（含通用 Operation 查询）、请求/响应联合类型和 Error Envelope；
- `client_request_id` 幂等规则；
- MCP Host Context、workspace 授权和权限求交规则；
- Operation Registry、Run Handle 和持久数据 Schema；
- 状态机、Gate、Logical Case/Execution Instance 等现有核心契约。

里程碑：所有 MCP 示例和持久 JSON 通过 Schema；不存在需要 tool handler 自行猜测的授权或长任务语义。

### Phase 1：MCP Server 骨架与持久 Operation

交付：

- MCP Server 启动、工具注册和 `server_info`；
- workspace resolver；
- Operation Registry；
- 幂等去重；
- `get_operation_status` / `get_operation_result` 与 `get_run_status` 的只读 Fixture 版本；
- Worker 队列与并发预算骨架。

里程碑：accepted 前持久化、Server 重启后 Operation 可查询、重复请求不创建重复任务。

### Phase 2：通过 MCP 完成确定性最小审查闭环

范围：

```text
run_audit
→ accepted run_handle
→ Worker + 固定 Discovery/Plan
→ deterministic compiler
→ Chromium
→ evidence/audit/report/gate
→ get_run_status
→ get_run_result
```

暂不接入真实 Discovery、Planner、Diff 和缓存。里程碑以 MCP E2E 为准，不以 CLI 为准。

### Phase 3：MCP 覆盖预览、Discovery 与 Derivation

交付：

- `derive_coverage(start/wait)`；
- Preview Operation；
- 通过 `get_operation_status` / `get_operation_result` 完成 Preview 查询闭环；
- 真实 Discovery、Candidate Catalog、scenario observation；
- effective tier、Diff Analyzer、CDD Draft/Final；
- mixed/full Execution Instance 规划。

里程碑：Agent 可先预览再启动审查；preview/run 在同一 workspace 权限和输入版本下保持一致。

### Phase 4：受约束 Planner 与安全输入隔离

交付：

- Provider 层、Fixture Planner、真实 Provider；
- Candidate-only 输出；
- prompt injection 防护；
- Plan Validator；
- PlanTemplate Cache；
- Provider 超时/重试耗尽的 TERMINALIZING。

里程碑：恶意页面无法诱导 MCP/Planner 越权，Planner 失败仍能通过 MCP 返回可信 incomplete 结果。

### Phase 5：持久 Worker、恢复、取消与清理

交付：

- 独立 Worker 进程；
- lease、heartbeat、stale ACTIVE 接管；
- checkpoint、resume/reset/non-resumable；
- `resume_run`、`cancel_run`、`cleanup_run`；
- MCP Server/Worker 重启恢复；
- Runtime Finalization 和延迟 Seed Cleanup。

里程碑：工具调用或 MCP transport 中断不丢 Run；取消和恢复均符合显式状态机。

### Phase 6：MCP 安全边界与 untrusted PR

交付：

- Host Trust Resolver；
- workspace/path/run handle 隔离；
- untrusted_pr base/fixed config；
- Adapter 沙箱；
- network guard；
- auth scope、证据脱敏、报告 CSP；
- production read-only。

里程碑：全部 INV-MCP 与 INV-SEC 通过，Agent、页面和 PR 均不能通过工具参数或内容提权。

### Phase 7：Agent 体验、诊断与可选适配层

交付：

- `explain_run`、Issue 分页和 Artifact 引用；
- 合理 `poll_after_ms`、进度通知和输出限额；
- Maintenance CLI：doctor/server/status/resume/cleanup；
- 可选 CI adapter，从 MCP results 读取 Gate，而不是建立第二套编排实现；
- Codex 插件安装、升级和 Profile 初始化文档。

里程碑：一个新项目可仅通过安装 MCP 插件、创建 Profile 和 Agent 工具调用完成首个审查。

### Phase 8：性能、长稳与发布冻结

交付：

- 多 workspace 并发和背压基准；
- MCP Server/Worker 长稳与重启测试；
- 全浏览器矩阵；
- 故障注入、磁盘配额、响应大小；
- Tool Schema 兼容性与迁移；
- 文档冻结为 v2.1 Final MCP-First。

发布门禁：MCP E2E、恢复、安全、性能、Schema Compatibility 全部通过；CLI 不再是发布阻塞的主要功能面。

每个 Phase 的共同验收：

- 对应不变量 100% 通过；
- 必须提供可从 MCP 工具触发的纵向演示；
- Schema、Tool Description 和实现同步；
- 不得在 tool handler 内复制编排状态机；
- 新增风险必须进入 threat model 和攻击测试。

---

## 附录 A：dogfood 实践映射

| 实践 | v2.1 落点 |
|---|---|
| 先定范围再测试 | MCP derive_coverage + Preview Operation + CDD Draft |
| 证据优先 | Evidence 最低要求 + evidence manifest |
| 控制台错误必查 | 全 tier console JSONL；未捕获异常优先 Console/High |
| 问题分类 | PRODUCT/TEST/PLAN/INFRA/FLAKY + confidence |
| 报告结构 | 执行摘要、逐 Issue、覆盖网格、证据、测试说明 |
| 边角场景 | 7 scenario + scenario observation |
| 可复现 | Seed/ref、输入引用、步骤、expected/actual、evidence refs |

## 附录 B：不使用哈希链的取舍

AutoPW 不提供事后抗篡改审计证明。它使用：

- Phase write-once；
- 原子文件；
- CAS state version；
- events JSONL；
- 结构对账；
- Content Digest。

Content Digest 用于缓存键、损坏检测和恢复版本兼容。若未来进入合规审计场景，应作为独立产品能力增加签名 manifest 或外部不可变存储，而不是将其隐含在当前 v2.1 中。

## 附录 C：门禁示例

| 情况 | Audit | Gate |
|---|---|---|
| 全部执行，2 个产品缺陷，证据完整 | COMPLETE | fail |
| 仅 flaky，product 策略 | COMPLETE | unstable |
| 仅 flaky，strict 策略 | COMPLETE | fail |
| 浏览器整体不可用，执行边界清晰 | COMPLETE | infra |
| 1 case 未启动 | INCOMPLETE | incomplete |
| locator 计划错误 | INCOMPLETE | incomplete |
| 产品缺陷 + 测试缺陷 | INCOMPLETE | incomplete |
| P0 required blocker | INCOMPLETE | incomplete |
| 空 Diff | 无受管 Audit | NOOP pass |

## 附录 D：v2.0 → v2.1 关键变更

1. `PROFILE_RESOLVED` 从受管 Phase 移到 Preflight。
2. connect/manage 不再跳过 Seed Phase，统一为 `SEED_RESOLVED`。
3. `INCOMPLETE` 从 Phase 改为 Audit Status。
4. empty diff 改为 NOOP Result，不伪造 Run。
5. 推导顺序改为 effective tier → priority → scenario → observation。
6. 混合 tier 通过 Execution Batch 执行。
7. PRODUCT/INCOMPLETE 的 warn 配置被删除。
8. P0 blocker 纳入覆盖总量并强制 incomplete。
9. Planner 改为 Candidate ID 选择器。
10. normal expectation 改为结构化断言。
11. Discovery 改为 scenario 级 observation。
12. Plan Cache 改为 PlanTemplate 并扩大缓存键。
13. checkpoint 使用原子 JSON，events 使用 JSONL。
14. 恢复明确为 at-least-once。
15. 新增 trusted/untrusted_pr 信任模式。
16. 新增正式 Schema 清单和缺失数据契约。
17. 性能契约限定标准环境，CI 改为分层执行。
18. 实施路线图先证明确定性闭环，再接入 Planner 和缓存。
19. Logical Case 与 Execution Instance 分离，修复 full 矩阵一对多执行。
20. 增加 TERMINALIZING 与 Fatal Failure，闭合早期失败和操作退出码。
21. resume 支持 stale ACTIVE lease 接管。
22. Host Trust Context 不可由 Profile 提权；untrusted PR 使用一次性最小权限身份。
23. 增加 Gate Draft、报告转义/CSP 和降级报告。
24. Runtime Finalization 与 GATED 后 Seed Cleanup 分离。
25. MCP 成为唯一主要公共入口；CLI/SDK 降为维护和内部接口。
26. accepted Operation 统一提供 `get_operation_status` / `get_operation_result` 查询闭环。
27. `run_audit` 默认返回持久 run_handle，使用 status/result 完成长任务协议。
28. 新增 MCP Host Context、workspace 授权求交、Operation Registry 与创建型调用幂等。
29. 新增 cancel_run、get_run_result、explain_run 以及 MCP Server/Worker 重启恢复语义。
30. Discovery 与纯 Derivation 性能预算拆分，2 秒预算只约束确定性推导内核。
31. Lease TTL、heartbeat、grace 与连续 stale 确认形成硬性安全窗。
32. Full 矩阵新增 Execution Instance 预算，超限阻断且禁止静默裁剪或降档。
33. Operation、Run、Artifact、Preview、Cache 和幂等记录纳入正式 Retention Policy Schema。
34. Phase 0 冻结被定义为 ADR 治理的可实施基线，而非禁止后续实证修订。
