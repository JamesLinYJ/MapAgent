// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 系统工具提示词
//
//   文件:       prompts.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export const LIST_AUTOMATIONS_PROMPT = `列出当前用户有权执行、且明确允许由智能体同步调用的自动化流程。

- 当任务可能对应一条稳定的多步骤业务流程时，先调用本工具。
- 只能使用返回结果中的 automationId，不得猜测或拼接 ID。
- 比较调用说明、示例和参数 Schema；没有匹配项时继续使用普通智能体工具，不得伪造自动化流程。`

export const EXECUTE_AUTOMATION_PROMPT = `在当前对话和当前智能体运行内执行一条已发布自动化流程。

- automation_id 必须来自 list_automations 的结果。
- prompt 应保留用户原始目标、时间范围、空间范围和输出要求，不得擅自改写业务含义。
- parameters 只填写用户明确指定或 Schema 明确要求的值；未指定项使用自动化流程自身默认参数。
- 工具返回自动化流程输出节点的权威 answer、警告、关联产物和运行引用；不要在调用前自行执行该流程的内部工具。
- 若用户只需要流程结论，保持 answer 的业务事实不变后交付；若用户还要求报告、表格或其它产物，继续用 automation_run 引用读取持久结果并执行后续交付工具，不得提前结束整个 Agent Workflow。`

export const LIST_AUTOMATION_RUNS_PROMPT = `列出当前会话或当前对话中已经持久化的自动化运行记录。

- 当用户要求基于“刚刚、上一次、最新一次”自动化结果继续生成表格、报告或地图时，必须先调用本工具。
- 默认使用 scope=session，以便在同一会话的新对话中复用既有结果；用户明确限定“本对话”时使用 scope=thread。
- 不得根据聊天文本猜测 automationRunId，也不能读取其他会话或工作区的运行。
- 后续读取完整输出时，必须使用本工具返回的 automation_run valueRef。`

export const READ_AUTOMATION_RUN_PROMPT = `读取一条当前会话自动化运行的持久化事实。

- automation_run_ref 必须来自 list_automation_runs 或 execute_automation 返回的 automation_run valueRef。
- 返回内容包含运行状态、修订、节点记录、输出 JSON 和关联产物，属于后续表格、报告与复核的权威事实源。
- 不得用单帧数据集、上一条自然语言摘要或模型记忆代替本工具结果。`
