# batch-execution-v1

Load only when the corresponding principle is enabled and this task needs its procedures. Existing task authorization and approved methods remain authoritative; this reference adds no agents, stages or permissions to an ordinary task.


## Batch Processing Principle v3

This governs approved decomposition, implementation, gates, testing, acceptance, chain writes, reporting and dispatch. It does not automatically add an INIT, agents or acceptance stages to ordinary tasks. Follow the current Owner decision on methods, roles, order, gates and criteria. Before changing an approved method, explain the difference, evidence, benefits, costs and risks and obtain the corresponding approval; unknown benefits remain unknown.

1. One Initiative owns formal acceptance. Decompose implementation by dependency and shared writes. Keep requirement IDs, expected results and methods on each work item so implementers can test their work and the INIT can trace the results. Put all independent acceptance on the INIT checklist. Existing verification assignments and completed findings remain usable.
For each criterion identify when evidence first exists and which decision it gates. Track evidence that needs publication, adoption or a business event in linked post-release work with its trigger, verifier and expected receipt. Independently validate the delivery scope and finalize accepted items bottom-up before starting release checks.
2. Dispatch each authorized independent package as soon as its frozen inputs and a real slot are available. Fill the maximum compatible set within project, device and host capacity, then refill when a worker releases a slot. A pending predecessor can supply a usable implementation candidate. Overlapping writes or unavailable inputs hold only the affected packages. Reconcile native worker state after an interruption. Prepare the prior report alongside newly authorized work.
When the queue empties, Main reads every Initiative covered by its current implementation grants and checks each full work tree, existing evidence, outstanding attempts and reports. Reconcile fully implemented legacy work to Pending Validate and retain partial scope. Record the basis and trigger for inactive conditions, and the evidence and release condition for actual blockers. Refill ready work until complete or every remaining applicable item is demonstrably blocked.

3. Implementers self-test their changes and return the candidate, input, criterion, command and actual result. The implementer responsible for merging checks affected interfaces and repairs integration failures. Mark implemented work Pending Validate. Main uses this evidence to decide which packages can start. A complete Story checklist is never a per-wave dispatch gate. Once every Epic is implementation-ready, the coordinator dispatches fresh validators independent of the corresponding implementation. Main adjudicates their combined reports. Reuse equivalent evidence, collect findings together and rerun only missing or invalidated checks. Existing security and release gates and Owner decisions still apply.
4. Generate according to purpose. Generate formal coverage baselines, proof artifacts and hook renderings once at batch end, not after each edit. Temporary output needed for local compilation or testing may be generated during implementation and reclaimed under residue cleanup. If aggregate fixes invalidate formal output, regenerate only affected output. Raising budgets, rewriting baselines or changing thresholds still requires the corresponding approval; regeneration is no substitute.
5. One chain write and report per batch. Aggregate transitions and annotations through the batch entry and read them back. Group decisions needed from the Owner with recommendations. Make nonblocking choices first only when they are within existing authorization and delegated discretion, and report them at closure. A nonblocking action still needing approval is not executed first; necessary communication follows the silent-reporting exceptions.
6. Size dispatches by purpose. Give each implementation package one implementer and assign merge responsibilities within that work. Independent validators may divide the INIT checklist. An implementation wave adds no separate acceptance or judgment round. For small rounds outside an INIT, retain the existing approved combined acceptance and judgment role. A reviewer must be independent of the corresponding implementation.
7. Continue for substantive progress. Findings and queued work feed the next round. The responsible role continues authorized work that can advance until the goal is reached or all remaining work is blocked. Codex peers follow the stage handoff and next-batch authorization below, without idle polling by main. For the same issue, stop repeating an action after two consecutive analyses or rechecks yield no new evidence. Choose a check that distinguishes causes, or present the specific difference, actual impact and disposition choices requiring an Owner decision. Changing agents, rounds or models does not reset this history. New checks stay within approved methods and permissions; other actionable work continues. End when required acceptance is satisfied and there are no substantive findings; do not manufacture issues to start another round.
8. Capture knowledge per round. The judgment agent produces lessons.json beside its report, with subject, summary, snippet, body, tags and source evidence references (stable project identity plus repository-relative path). Capture at most 5 newly established facts or lessons; an empty list is valid. In the same round's chain write, main uses knowledge-capture and reads back the result. Record budget refusals and their actual release conditions rather than assuming migration is the only remedy. Do not depend on Stop-hook markers or repeatedly capture the same conclusion.
9. Read evidence as needed. Governance agents and main start with dispatched excerpts, sections or line ranges while preserving complete requirements and context needed for judgment. Save tool output as evidence and use tools to extract identity, hashes, counts, mappings and differences; main-tier work addresses behavior, contracts and disputed conclusions. Read no more than 200 lines at a time and do not read files over 32 KB whole. Retrieve relevant segments within actual host limits. Fill evidence gaps from relevant sources without repeatedly restating the full history.

### Acceptance evidence and recheck scope

1. For runnable questions, first choose the smallest empirical check that can change the judgment, then expand only as its result warrants. Record actual inputs, commands, output, exit status and candidate version. Static proof needs a definite trigger and contract basis. Distinguish observed failures, static proof and untested hypotheses. Missing environment or permission remains explicitly unverified with a reason; inference cannot manufacture a pass or failure. Check test assertions against current requirements too. Passing tests does not replace Owner visual acceptance or publication authorization.
2. A blocking finding needs current behavior, an explicit contract or a credible security boundary, with its trigger and impact. Style preferences, unsupported future extensions and speculative defenses do not automatically require rework; no substantive findings is a valid outcome. Do not silently relax an existing criterion because its measured impact is small; present the difference and options to the authorized decision-maker.
3. Before rechecking, identify which changes invalidate which evidence. Reuse locatable successful execution evidence when the source, dependencies, environment, parameters, inputs and baseline relevant to that check are equivalent. Deduplicate parent and child gates from actual execution records: a script naming a child does not prove it ran, and early-failure skips remain not run. A successful child within a parent can satisfy the same check without a separate rerun, but cannot turn a failed parent into a pass. When equivalence is unproved, evidence is missing or relevant inputs changed, run the affected required checks.
4. Independent review focuses on this round's changes, failures and affected behavior, citing still-valid conclusions. Required complete validation, final integration, release and security checks follow the current contract. Reuse cannot delete gates, change criteria, reorder dependencies or conceal checks not run. Use existing tools for mechanical checks without adding review layers, agents or proof frameworks.

### Agent communication and waiting

1. Subagents deliver complete packages. Report ordinary progress, stage summaries and deferrable issues together when the package is complete. When the host already sends a completion notification, do not repeat the same result through send_message. Include this constraint when dispatching subagents.
2. Limit communication during a package to necessary exceptions. Immediately report safety issues, hard blockers that prevent further work, and dependencies or conflicts that would block other agents without immediate coordination. Keep the factual clarification needed to resolve these issues; necessary communication remains allowed.
3. The main agent reduces round trips. Do not reply with pure acknowledgments or ask for ordinary progress. Act directly on information that needs a decision or action. Ordinary status messages do not trigger extra queries of every agent's status or repeated reports.
4. Avoid empty polling while waiting. Use completion notifications and blocking waits supported by the host. Lengthen query intervals when there is repeatedly no new state, respect the host's wait limit and user interruption requirements, and continue independent work when it is available.

### Pack dispatch and recovery

When INIT-108 is complete, a new implementation dispatch must carry a live Pack
reference, the stable assignment ID, the frozen assignment roster, and an
observed capacity snapshot. `execution-host-prepare` re-reads the Pack from the
workspace, checks the Pack revision and all source, acceptance, prerequisite,
result and parent references, and confirms that the requested work revision is
one of that assignment's sources. It puts the Pack ID, stable assignment ID,
all original source/ancestor work contexts, criteria and file scope into the
native worker prompt and retains the same structured context beside the
ordinary host context. The context also lists plan concurrency and each row
left for later. A missing or stale binding fails before an attempt is prepared.
Work already in progress keeps its original native attempt and can be
reconciled through its existing record.

Freeze the roster in plan order. Its size cannot exceed
`min(Pack.maxConcurrency, capacity.limit) - capacity.active`; capacity must be
known before a new dispatch. Concurrent rows must share a declared
`parallelGroup`, and their persisted prerequisites must already be satisfied.
The snapshot reports the plan concurrency, selected rows and remaining rows;
it is an observation, not a host reservation.

For Codex, each peer manifest member binds one unique Pack assignment ID. The
receipt checks the worker preparation against that Pack ID/revision, frozen
roster and capacity snapshot, then retains the native conversation identity,
attempt, terminal result, failure and released or occupied slot as before.
Unknown or running attempts keep their occupancy; reconcile them by the same
attempt instead of dispatching a duplicate. A failed terminal result remains a
failure and is reported as a terminal failure, not successful completion.

A coordinator takeover may change only the coordinator conversation. The new
manifest must keep the same batch ID and attempt, main conversation, Pack,
roster and member attempts, and it must cite the exact prior receipt digest and
all earlier coordinator IDs. Existing member receipts are carried forward; a
handoff does not start workers again. Preserve the normal result and delivery
boundaries, including the prohibition on replaying a confirmed delivery or
advancing after an unknown delivery.

Candidate verification may simulate INIT-108 complete to test this rule.
Formal enforcement applies only after INIT-108 is complete and only to new
implementation dispatches. Existing work and in-flight attempts continue under
the existing dispatch path. Source/fixture regression and real-host acceptance
are recorded separately.

### Codex independent peer-conversation contract (not other hosts or dot)

Only explicitly selected Codex multi-subagent orchestration uses an independent main-category decision conversation and economy-category coordinator conversation, not a parent/collector pair. The main conversation owns batch goals, stage boundaries, judgment and next-batch authorization. The economy coordinator directly dispatches fresh workers according to task categories and existing rejection-escalation thresholds, waits for them and reads their native results. Workers do not proactively message their parent; retain native final and use supported result/interruption paths for safety and hard blockers. The coordinator is not a read-only collector and dispatches no collector. Claude Code and DSH retain single-conversation coordination and native completion notifications; dot policy is unchanged.

Roles use main, economy and optional flagship categories, never concrete model bindings. Installation guidance offers all three stable categories. This mode requires usable main and economy model groups in the selected device-host policy; the flagship model group may remain unconfigured. Empty groups are neither usable models nor escalation ceilings. Never invent a model, effort, decision provenance or host support. Update/repair supplements missing defaults idempotently while preserving user models, custom categories and other hosts. Resolve the actual policy revision and retain dispatch receipts.

Before dispatch, fix batchId, application attempt, both independent conversation identities and member scope. Bind each worker's agentId, package and attempt from actual dispatch receipts, not names, markers, self-reports or local files posing as native authority. Worker concurrency obeys execution.maxConcurrentSubagents, device/project limits and actual hard host capacity. There is no collector cap exemption or reserved collector slot. Reduce concurrency or split stages when capacity is insufficient; never bypass the limit.

After handing off a stage, the main conversation stops idle polling and must not use /goal or /loop to actively wait. The economy coordinator directly reads fixed members using supported bounded waits, respecting intervals, deadline, query-failure limits, budget and user interruption. Preserve failed, cancelled_confirmed and unknown outcomes. Stale, future, wrong-batch/wrong-attempt or drifted observations and query failures do not establish completion. No dedicated collector subagent, SubagentStop keepalive, collector-wait helper or old collection fallback remains. Retire old engine-owned hooks only after ownership verification; preserve user edits and unrelated hooks.

Deduplicate within the exact batch/attempt and hand back one batch report after all members have confirmed terminal outcomes; failure is not success. Interruption, deadline, permission, safety, exhausted budget and no-progress exceptions retain outstanding ownership. On recovery reconcile existing dispatch, native state and delivery receipts first: unknown is investigated, not duplicate dispatch, replay of confirmed delivery or revival of ended workers. Retain late results without advancing another attempt. Unknown delivery holds retries and work dependent on that delivery. Independently authorized, nonoverlapping packages with confirmed free slots may start while the earlier report is assembled. Missing capability stops only the dependent path, with no collector fallback.

A cross-conversation report is ordinary text. Model and effort belong only in the native worker spawn. Main authorizes scope, ready inputs and the INIT disposition. Economy dispatches both implementers and, at the INIT boundary, independent validators.

Record source/automated regression separately from native-host acceptance. The current Owner decision defines the testing scope and acceptance responsibility; documentation and fixtures do not prove native acceptance of a candidate. No daemon, private session database or invented RPC is introduced. Preserve existing user goals, automations and legitimate M governance rounds with substantive work.

## 批量处理原则 v3

适用于已获批的拆分、实施、跑门、测试、验收、链写、汇报与派工。批量原则不为普通任务自动新增 INIT、代理或验收阶段；具体执行方法、角色、顺序、门与判据遵循当前 Owner 决定。需要改变已批准方法时，说明差异、依据、收益、成本与风险并取得相应批准；未知收益保持未知。

1. 正式验收只跟 INIT。拆单按硬依赖和共写范围分配实施，工单保留需求、判据和自测方法，汇总到 INIT 验收清单。旧工单的核验分工和历史有效结论继续复用。
拆单逐项记录证据最早可取得的阶段及其决定的阶段。公开发行、实际采用或业务事件之后才有的证据交由关联的发布后工单收取，登记触发事件、收证人和回执。主对话独立验收本轮适用范围，验收通过的交付项自下而上转 done，再进入正式发行检查。
2. 已授权的包有可用冻结候选和真实空槽即派，按项目、设备和宿主容量选出可并行的最大集合，释放一个名额即补位。待验的前置可以交付可用的实施输入。输入未就绪或写入冲突只影响相关包。中断后先核对原生在途和终态，上一批汇报可与新授权包并行。
队列为空时，主对话从本次全部实施授权读取各 INIT 的完整工单树，核对已有证据、适用条件、在途尝试与未收报告。完整实施项逐项衔接为待验，局部交付保留剩余范围。条件未触发记依据及触发事件，真正受阻记缺口、证据和解除条件。继续派就绪包，完成或所有剩余适用工作确实受阻时才结束。

3. 实施者交付候选、输入、判据、命令和实际结果。负责合并的实施者只验证受影响接口，复现并修复集成故障，交付后记 Pending Validate。主对话据此判断后继能否开工，逐项核准 Story 不作为逐批派工门。全部 EPIC 实施就绪后，协调者新派未参与相应实现的独立验收者，主对话根据报告集中裁定。等价证据复用，集中反馈，只补缺失或失效的检查。原有安全、发布及 Owner 专属门照常执行。
4. 生成物按用途处理。正式覆盖基线、证明物、钩子渲染等在批末各生成一次，不随每条修改重做；局部编译或测试必需的临时产物可在实施期间生成，随后按残余收尾原则回收。集中修复确实使正式产物失效时，只再生受影响产物。预算抬线、基线改写和阈值变化仍须有对应批准，不能以生成物更新代替。
5. 一批一次链写、一次汇报。转态与注解通过批量入口集中写入并读回。需要 Owner 决定的事项集中列出并附建议；可自主选择且已有授权的非阻塞事项先做并在收口回显。仍需批准的事项不能因“不阻塞”而先执行，沟通时点遵循静默汇报原则的必要例外。
6. 一个实施包由一名实施者负责，在分工中指定负责合并的人。独立验收者可并行覆盖同一 INIT 清单。每个实施批次只增加必要的实施工作。INIT 之外的小轮次沿用已批准的验收与裁定分工，对应实现的参与者不得担任独立验收者。
7. 按实质进展接续。一轮的问题清单与排队项是下一轮输入；仍有已批准且可推进的工作时，由负责该阶段的角色继续，直到达到目标终态或剩余工作全部阻塞。Codex 双对话按下文的批段交接与下一批授权执行，不让主决策对话空闲轮询。对同一问题，连续两次分析或复验没有新增证据时，停止重复同一动作；改用能区分原因的检查，或说明需 Owner 决定的具体差异、实际影响和可选处置。更换代理、轮次或模型不重置该记录；新检查仍须在已批准的方法与权限内，其他可推进工作继续。没有实质性发现且必需验收已满足时结束，不为凑问题启动下一轮。
8. 知识采集按轮。判断代理在判断报告旁产出 lessons.json，每条含 subject、summary、snippet、body、tags 与来源证据引用（稳定项目标识和仓库相对路径）；只写本轮新确立的事实与教训，不超过 5 条，没有新知识可为空。主线程在同一轮的链写中用 knowledge-capture 落卡并读回；预算拒绝如实记录并按实际解除条件处理，不自动假定迁移是唯一出口。不依赖 Stop 钩子标记行，不重复落同一结论。
9. 证据按需要读取。治理代理与主线程先读派工指定的摘录、节号或行号范围，保留判断必需的完整要求与上下文。工具输出先写入证据文件，机器提取身份、哈希、计数、映射与差异；主力负责行为、契约和争议判断。每次读入不超过 200 行，不整读超过 32 KB 的文件；按相关范围分段，遵守宿主实际读取限制。证据缺口只补相关来源，不反复复述完整历史。

### 验收依据与复验范围

1. 可运行的问题优先选择能改变判断的最小实测，再据结果决定是否扩大检查。记录实际输入、命令、输出、退出状态及候选版本。静态证明须给出确定触发路径与契约依据；实测失败、静态证明和待验证假设分开。环境或权限不足时标明未验证及原因，不用推测补成通过或失败。测试断言也须核对当前需求，测试通过不替代 Owner 目视验收或发布授权。
2. 阻断发现须对应当前行为、明确契约或可信安全边界，并说明触发条件与影响。风格偏好、无依据的未来扩展或推测性防御建议不能自动变成必修项；允许无实质性发现。既定判据即使影响很小也不能私自放宽，须把实测差异和处置选择交有权决定的人。
3. 复验前说明哪些改动使哪些证据失效。该项检查涉及的源码、依赖、环境、参数、相关输入与基线一致，且有可定位的成功执行证据时，可以复用。父门去重以实际执行记录为准，脚本声明包含子门不证明子门已执行；被早期失败跳过的项目保持未执行。父门内已成功的子门可满足同一检查，不再单独重跑，但不能据此把失败的父门标为通过。无法证明等价、证据缺失或相关输入变化时，补跑相关必需项。
4. 独立审查聚焦本轮变更、失败和受影响行为，引用仍有效的既有结论；必要完整验证、最终集成、发布及安全检查仍按当前契约执行。不得因复用证据删除门、改变判据、重排依赖或掩盖未执行项。机械核对优先用现有工具，不为此新增审查层、代理或证明框架。

### 代理通信与等待

1. 子代理按包交付。普通进度、阶段小结、可延后的问题集中在完成时报告；已有宿主完成通知时，不再用 send_message 重复发送同一结果。派工时确保子代理收到本条约束。
2. 中途通信限定例外。安全问题、无法继续的硬阻塞，以及不立即协调就会阻塞其他代理的依赖或冲突，可以立即上报；保留解决这些问题所需的事实澄清，不禁止必要通信。
3. 主代理减少往返。不回复纯确认，不催问普通进度；收到需要决策或行动的信息时直接处理。普通状态消息不触发额外的全体状态查询或重复汇报。
4. 等待避免空轮询。使用宿主支持的完成通知与阻塞等待；连续没有新状态时延长查询间隔，遵守宿主等待上限和用户中断要求；有独立可做的工作时继续该工作。

### Codex 独立双对话契约（其他宿主与 dot 不适用）

仅在明确选定 Codex 宿主的多子代理编排中使用独立的主力主决策对话与经济协调对话；不是父子收集代理。主决策对话负责批目标、阶段边界、判断及下一批授权；经济协调对话直接派出全新工作子代理，按任务类型的类别与既有退回阈值升档，直接等待并读取其原生结果。工作子代理不主动向父对话发消息，保留原生 final；安全和硬阻塞通过宿主支持的结果/中断路径处理。协调者不是只读收集者，也不另派收集者。Claude Code、DSH 仍由单主对话协调子代理并使用原生完成通知；dot 策略不变。

角色只使用 main（主力）、economy（经济）与可选 flagship（旗舰）类别，不绑定具体模型。安装引导提供这三个稳定分类；所选设备宿主策略必须配置可解析的 main 与 economy 模型组才可启用本模式，flagship 模型组可跳过。空组不是可用模型或升档上限，不编造模型、effort、决定来源或宿主支持；更新/修复幂等补缺，保留用户模型、自定义分类及其他宿主。按实际策略版本解析并保留派工回执。

派工前固定 batchId、application attempt、两个独立对话标识及成员范围；每个工作子代理由真实派工回执绑定 agentId、任务包与 attempt。不得凭名称、marker、自述或本地文件冒充原生授权。工作并发同时遵守 execution.maxConcurrentSubagents、设备/项目限制与真实宿主硬容量；没有 collector cap 豁免或预留收集槽。容量不足则减并发或分批，不能绕限。

主决策对话交付批段后停止空闲轮询，不用 /goal 或 /loop 主动等待；经济协调对话使用宿主支持的有界等待直接读取固定成员结果，遵守间隔、截止、失败次数、预算及用户中断。保留 failed、cancelled_confirmed 与 unknown；陈旧、未来、错批、错 attempt、漂移及查询失败不算完成。禁止专用收集子代理、SubagentStop 保活、collector-wait 或旧收集机制 fallback。旧引擎 owned hook 仅在核实归属后退役，保留用户修改及无关 hook。

协调者按同批同 attempt 去重，全部成员确认终态后向主决策对话交付一次批报告；失败不伪装成功。中断、期限、权限、安全、预算耗尽与无进展明确报告剩余责任。恢复时先核对既有派工、原生状态与已交付回执，结果未知先查证，不重复派工、不重放已确认交付、不复活已结束 worker；迟到结果保留但不得推进另一 attempt。交付未知时先核实，该交付的重发和依赖方等待；已单独获批、有明确输入与空槽的独立包可以接续。缺能力只停依赖路径，不能换收集者回退。

跨对话以普通文本回报，模型和档位仅传给工作子代理的原生派工调用。主对话给出授权范围、可用输入和 INIT 裁定，Economy 负责派实施者和 INIT 边界的独立验收者。

源码/自动化回归与真实宿主验收分别记录；具体测试范围和验收责任遵循当前 Owner 决定，不以文档或模拟冒称候选真实宿主已验收。不创建 daemon、不读取私有会话数据库、不虚构 RPC。保留既有用户目标、自动化及 M 正常治理轮次；本限制不取消有实质工作的后续轮。


## Recording checks and reusing results

For a batch's checks, use `gates-plan` before the first execution, again on the merged
candidate, and in the independent INIT acceptance brief. `gates-run` verifies matching
proofs again and starts only missing, failed or invalidated checks. Attach the run ID to the
existing handoff. The independent validator checks the coverage, chooses the smallest
additional test and executes any check that the contract requires to be performed independently.

Use the project's declared gates where available. For batch-local checks pass the same
`--checks-from` file to both commands with `--project`, `--base` and `--work-id`. Each entry
names a check, its actual command as an argument array, an optional relative root and its reuse inputs.
Batch-local receipts are evidence for review. Ordinary project gate execution records formal
gate coverage under the current declarations. See the [check input and handoff contract](../docs/verification-evidence.md).

### Direct checks and independent reproduction

For a local check, select the command that exercises the changed behavior through
its normal entry point. Use the existing test selector, fixture or declared gate
that covers the actual trigger. Record the candidate revision, relevant fixture
or input revision, invocation and environment, stdout or stderr evidence, and
exit status. Record a skipped or unavailable check separately. The implementer
can fix a confirmed failure in the original package and recheck its affected
behavior.

- Exercise an added or changed guard with real inputs the current contract supports. Use the actual interface or filesystem layout when it is part of the behavior under review.
- For an added or changed fallback, distinguish permitted absence, unreadable data, malformed data and a valid empty result. Apply an absence default only where the contract allows it. Keep reads required for a completion decision failed or explicitly unverified when they cannot be completed.
- For a bug fix, use the original failing input to show that the regression detects the defect and that the fixed candidate meets the contract. Reuse locatable evidence of the original failure when the relevant inputs are equivalent under item 3.

An independent reviewer can run the smallest reproduction that can change the
judgment in the approved isolated environment. Follow the permissions and role
limits for that batch. Cite the observed trigger, result and impact when asking
for rework. Compare passing evidence against the current source, dependencies,
environment, arguments, relevant inputs and baseline. A change invalidates
evidence only where it affects one of those inputs. The approved formal gates
and independent judgment retain their own scope.

### One execution record and its references

Record each actual execution once with a stable reference. Implementation
handoff, acceptance, judgment and lessons cite the same record for the same
execution, and each supplies the findings appropriate to its role. Keep raw
outputs at the referenced location and let tools extract the fields needed for
the decision. A required delivery view can carry a short finding and evidence
reference. An earlier success can satisfy a current check only when its relevant
inputs match and the record shows that it ran.

For governance reads within one responsibility, reuse the version and head
from the same live `work-show` receipt when the next step needs only that
identity and revision. Read `status` when its own fields are needed. A new
worker still reads its live work and inherited constraints. After a write or
a relevant state change, read back the affected scope. When comparing a read
workflow, keep the library, work item, inputs and effective head comparable.
Record the command sequence, exit statuses, raw and delivered bytes where
observable, and wall time. Keep token use, cost and causes unknown when the
measurements cannot establish them.

## 检查记录与结果复用

首跑、合并候选和 INIT 独立验收都用 `gates-plan` 核对逐项证据，`gates-run` 再核实匹配，
只执行缺失、失败或失效的检查。回执 ID 随本批现有交接返回。独立验收者核对判据覆盖，
选择能消除疑点的最小补测，并执行契约要求独立实跑的检查。

有项目正式门声明时按声明使用。批次局部检查给两个命令传同一份 `--checks-from` 文件、
`--project`、`--base` 和 `--work-id`。每项绑定实际 argv、可选相对工作目录及复用输入。
局部回执用于复核，正式转态从项目的有效门声明核对覆盖及证据。
具体字段见[验证输入与交接](../docs/verification-evidence.md)。

### 局部检查与独立复现

局部检查从正常入口触发本次改动影响的行为，使用现有测试选择器、夹具或适用门。
记录候选版本、相关夹具或输入版本、命令和环境、标准输出或错误输出的证据及退出状态。
跳过或无法执行的检查单列。实施者在原包内修复已确认的失败，并复验受影响行为。

- 新增或修改 guard 时，用当前契约支持的真实合法输入验证。被审行为依赖实际接口或文件系统布局时，使用该接口或布局。
- 新增或修改 fallback 时，区分合法缺失、不可读、损坏与有效空结果。只有契约允许的缺失才使用默认值。完成判定所依赖的读取未能完成时，保留失败或明确标为未验证。
- 修复缺陷时，用原失败输入证明回归能检出缺陷，且修复后的候选满足契约。相关输入符合第 3 条的等价条件时，复用可定位的原失败证据。

独立验收者可在已批准的隔离环境中执行能改变判断的最小复现，遵循该批次的权限与角色限制。
要求返工时引用实测触发条件、结果和影响。复用通过证据前，核对相关源码、依赖、环境、参数、
输入及基线是否等价。变更只使受影响的证据失效。既定正式门与独立判断各按其范围执行。

### 一份执行事实与引用

每次实际执行只记录一次并给出稳定引用。实施交接、验收、判断与知识采集针对同一次执行引用
同一份记录，各自写出该角色应作出的结论。原始输出留在引用位置，需要哪些字段就用工具提取哪些。
现有必需交付可只附简短发现和证据引用。只有相关输入等价且有实际成功执行记录时，才复用已有检查。

同一职责范围内，后续若只需要任务身份、库版本及 head，复用同一份实时 `work-show` 回执。
需要 `status` 独有字段时单独读取。新工作者仍须读取实时任务与继承约束。发生写入或相关状态
变化后，读回受影响范围。比较读取流程时对齐库、任务、输入与生效的 head，记录调用序列、
退出状态、可观测的原始与交付字节及墙钟时间。实测无法证明的 token、费用与归因保持未知。
