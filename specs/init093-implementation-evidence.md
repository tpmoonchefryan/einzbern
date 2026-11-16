# INIT-093 implementation evidence

范围为 STORY-653、654、655、656。live work 与冻结决定的同版本读取复用 `dist/init093/live-recheck/` 和 `live-recheck.log`：INIT revision 5，两个 Epic 与四个 Story revision 6。未写共享知识库、安装 Engine、发布或实施后续阶段。

attempt3 独立读取一次 live work 快照，并对照 implementation snapshot、show 与完整 context 的身份、revision、content/source 及 context digest；七项均一致。另行读取 minutes D2/D3，决定记录未变。接手时 staged、unstaged 和 untracked 原文及哈希保留于私有 run 目录；旧执行终态与偏差记录保持原样，源码候选的核验不代表旧工作已获验收。

最后从本次全库审计实际使用的 version 21402 authority cache 核对七项原始 work record 与 minutes 的公开字段，仍未变化；没有再次运行 snapshot 或逐项冷读七个工单。

统一了四态固有范围、真实互斥确认、写入预检与投影/查询；保留显式共存、替代与只追加历史。普通 library 的 CLI 和 prompt hook 都消费 project binding，有真实 hook 回归。双库 Recall 在预算不足时压缩重复 legacy 诊断，保留同快照计数、ID 示例及显式分页入口。

合成正负例覆盖中文同步/异步、数值等式与单位/区间、否定等价、技术说明同义、明确 store/chain 排他选择。私人语料中发现的同义误判仅保留在私有审计；公开夹具没有复制真实语料身份或片段。

## 实测

命令均从 repository root 执行，临时目录为 `dist/init093/tmp`。输出均保留于 `dist/init093/`。

| 命令 | 结果与日志 |
| --- | --- |
| `pnpm run build` | 复用退出 0 的 `complete-build.log`。核对原始命令终态与时序，并用同一转换器逐字节核验全部 157 个当前 TypeScript 输入对应的 build 输出及 8 个运行时副本；`attempt3-frozen-check-v3.log`、`attempt3-frozen-evidence.json` |
| `pnpm run typecheck` | attempt3 实跑退出 0，TYPECHECK_VERIFIED，157 files；`attempt3-typecheck.log` |
| `pnpm run lint` | 在 typecheck 完成后串行实跑退出 0，LINT_VERIFIED，536 modules；`attempt3-lint.log` |
| `TMPDIR="$PWD/dist/init093/tmp" node --test --test-reporter=tap tests/init093-knowledge.test.mjs tests/knowledge-cli.test.mjs tests/recall-cli.test.mjs tests/library-crest-devices.test.mjs tests/user-crest.test.mjs tests/hook-read-guard.test.mjs tests/hook-recall-log.test.mjs` | 退出 0，97/97 通过；`handoff-affected-tests.tap` |
| `TMPDIR="$PWD/dist/init093/tmp" node --test --test-reporter=tap tests/init093-knowledge.test.mjs tests/knowledge-capture.test.mjs tests/knowledge-lifecycle.test.mjs tests/library-crest-devices.test.mjs tests/consolidate.test.mjs tests/conflict-family.test.mjs tests/knowledge-read-family.test.mjs` | 复用退出 0 的历史回归，98 tests、97 通过、1 Darwin 专属项跳过；`final-affected-tests.tap`。后续变更由 handoff 测试及 attempt3 定向回归补足 |
| `TMPDIR="$PWD/dist/init093/tmp" node --test --test-reporter=tap tests/p4-knowledge-core.test.mjs tests/knowledge-capacity.test.mjs tests/knowledge-write-retrievable.test.mjs tests/story-362-recall.test.mjs tests/knowledge-batch.test.mjs tests/knowledge-batch-validation-regressions.test.mjs tests/knowledge-duplicates.test.mjs` | 退出 0，88/88 通过；`handoff-core-tests.tap` |
| `TMPDIR="$PWD/dist/init093/tmp" node --test --test-reporter=tap tests/init093-knowledge.test.mjs` | attempt3 实跑退出 0，28/28 通过；`attempt3-focused-tests.log`，包含单数字数量修复、同步/异步、60/120 秒、store/chain 同义与反向、hook binding、预算及完整分页 |

复用的 handoff 97/97 与 core 88/88 已核对原始命令、退出码、输入与后续变更时序。它们之后仅有 core 注释修正，以及数量值被 tokenizer 丢弃时仍保留合法 scalar constraint 的一行修复和对应断言；该差异由最新 28/28 回归覆盖。attempt3 命令的 argv、退出码、时间、输入 SHA-256 与日志 SHA-256 保留于伴随的命令 JSON 中（后续采用 `.command.json`，与报告分名）。初始私有复核脚本的导出/可选文件假设失败及首次 live digest 不同的结果也保留，未当作成功证据。私有包装器曾覆盖两份本次新报告；修正命名后已分别重生成依赖和全库审计报告，原始命令日志保留。

首次并发 typecheck 因 OUTPUT_SESSION_RECOVERY_OWNER_LIVE 退出 1，保留 `candidate-typecheck.log`。lint 完成后按正常 output-session 路径串行恢复，未删除锁或修改保护。之前所有语义、fixture、归档和预算失败日志均保留，后续成功不覆盖其证据。

146-ID / 73-pair 回归：空列表 1518 bytes，空 Recall 2853 bytes，完整合法单卡元数据 13114 bytes，诊断开销 1505 bytes；双库混合冲突/重复诊断空 Recall 2965 bytes。全部 ID、冲突对和审计页按同一固定 snapshot 分页核验。

## 私有逐卡审计

复现命令：`node scripts/audit-init093.mjs --workspace <shared-library> --baseline dist/init093/baseline-utf8.json --out dist/init093/attempt3-corpus-final-report.json`，attempt3 实跑退出 0，日志为 `attempt3-corpus-final.log`。完整输出、固定 snapshot 与 sourceVersion 在该 JSON；完整合法元数据在 `attempt3-corpus-final-report-metadata.json`。禁止把其中真实身份/正文复制进公开夹具。

旧审计固定源 version 21393，`full-audit-final.json` 与 `handoff-corpus-audit.json` 字节相同，`final-metadata.json` 与 handoff metadata 也相同。attempt3 发现 live sourceVersion/snapshot 已变化，故在最新固定 version 21402 重跑完整审计。507 条元数据全部可读，四页审计列取 507 条；506 active、505 eligible、0 withheld、1 ineligible（explicit-only）。原 165 条空 project 元数据解析为 164 project / 1 workspace-global。所有 507 条元数据与正确 UTF-8 基线的摘要相同；243 个原扣留 ID 恢复，另一个保持 explicit-only，剩余冲突对为 0。9 个项目及全库空查询最大 1162 bytes。完整恢复 ID、每卡 metadata digest、固有范围、前后冲突邻接与 1544 个原冲突对的原因逐项留在私有报告。

另在旧固定快照上使用当前构建重新核验 507 条 metadata digest、1544 个旧配对及 127765 个 active 卡对，结论一致；分别保留 version 21393、21394 与最新 21402 的来源标识。真实卡/项目/库身份的改动文件扫描无匹配，独立原始证据文件逐字节未变。

原 `baseline.json` 的 3 个字段有分块 UTF-8 解码损坏，保留原文件；用 Engine 直接重读字节生成 `baseline-utf8.json`。两次 Engine resultDigest 相同，当前完整元数据 resultDigest 也相同，未改写源卡。两份独立正常 API 证据原文、返回值、原 default list 和隔离库信息均保留在 `independent/`，并核对原文件字节未变。

链上验收描述的 501 活卡是早期基线；本次报告明确审计实际 live 全集 507 条/506 active，不声称重放一个另行提供的历史 501-ID 快照。检测采用明确规则语法，未证明任意自然语言的语义完备性。

## CI dependency audit

已读取 Owner 提供的 16 项原始不匹配清单。暂存新增文件后共有 23 个待审 sourceAudit 项，逐项对照 `impact-dependencies-before.json` 与 `impact-dependency-review.json` 的真实 import/read graph。

- 新 scope 模块依赖 metadata type；conflict 模块依赖 scope 与共享 Recall tokenizer；core/CLI/hook/Recall 消费该统一实现。
- 新回归依赖 core、CLI、hook、registry、Recall、协议和两份合成 JSON；共享断言 helper 只依赖 Node assert。
- 审计脚本只读取 core/protocol 与调用者指定的输入，输出和设备缓存留在本工作树。
- 既有 CI graph 仅新增 `tests/init093-knowledge.test.mjs` 为 Portal consumer/root test；privacy 与 document maps 无变化。更新 reviewed sourceAudit 以及对应 consumer/test map。version、category input fingerprints、category paths、阈值、豁免和 full fallback 均未改变。

attempt3 独立重算全部 23 项真实依赖，与旧 dependency review 的增删边逐项一致；新增 Portal reader/root test 恰为本阶段回归。最后的单数字修复留下两项 stale sourceAudit，在确认依赖图无变化后仅更新这两项，结果 `remaining=[]`；证据为 `attempt3-impact-final.log` 与 `attempt3-source-audit-review.json`。其余规则字段、阈值、豁免、category input 与 full fallback 均未改变。

`tests/ci-impact-plan.test.mjs` 的旧运行是 41/42，唯一失败发生在未提交时对 immutable HEAD 的核对；原 `impact-plan-tests.tap` 保留。候选 commit 固定后按同一仓库测试重新核验，实际结果以 `attempt3-impact-tests.log` 及同名命令 JSON 为准；本文件不预声明提交后的结果。

## 边界

STORY-669 的旧树来源仅用于现有直接 Darwin byte-count guard：Darwin 保留严格相等，portable fallback 保留全量校验的下界断言，未扩展后续平台实现。此 Linux 主机未运行 Darwin 原生优化项。未运行完整 formal gates、发布/安装验收或后续阶段；完整固定候选验收由 main 运行。已执行的针对性测试不代替 Owner 最终验收。

## 改动文件

- `packages/cli/src/index.ts`
- `packages/core/src/hook-recall.ts`
- `packages/core/src/index.ts`
- `packages/core/src/knowledge-conflict.ts`
- `packages/core/src/knowledge-core.ts`
- `packages/core/src/knowledge-scope.ts`
- `packages/core/src/recall-inputs.ts`
- `scripts/audit-init093.mjs`
- `scripts/ci/impact-rules.json`
- `specs/init093-implementation-evidence.md`
- `specs/knowledge-conflict-projection-v1.md`
- `tests/conflict-family.test.mjs`
- `tests/consolidate.test.mjs`
- `tests/fixtures/init093-equivalent-version.json`
- `tests/fixtures/init093-normal-entry.json`
- `tests/helpers/knowledge-evidence.mjs`
- `tests/init093-knowledge.test.mjs`
- `tests/knowledge-capture.test.mjs`
- `tests/knowledge-cli.test.mjs`
- `tests/knowledge-lifecycle.test.mjs`
- `tests/knowledge-read-family.test.mjs`
- `tests/knowledge-write-retrievable.test.mjs`
- `tests/library-crest-devices.test.mjs`
- `tests/p4-knowledge-core.test.mjs`
- `tests/recall-cli.test.mjs`
- `tests/user-crest.test.mjs`
