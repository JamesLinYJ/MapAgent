// +-------------------------------------------------------------------------
//
//   地理智能平台 - 计划模式工具
//
//   文件:       planTools.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 计划模式只改变运行约束，不执行业务写入。结构化工作流是进度投影，
// 不是额外审批层；真正有副作用的工具在各自执行边界请求审批。
import type { ToolDef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import {
  ENTER_PLAN_MODE_DESCRIPTION,
  ENTER_PLAN_MODE_PROMPT,
  REVISE_AGENT_WORKFLOW_DESCRIPTION,
  REVISE_AGENT_WORKFLOW_PROMPT,
  REQUEST_CLARIFICATION_DESCRIPTION,
  REQUEST_CLARIFICATION_PROMPT,
  SUBMIT_AGENT_WORKFLOW_DESCRIPTION,
  SUBMIT_AGENT_WORKFLOW_PROMPT,
} from './prompts.js'

export const requestClarificationTool: ToolDef = {
  name: 'request_clarification', label: '请求澄清',
  description: REQUEST_CLARIFICATION_DESCRIPTION,
  prompt: REQUEST_CLARIFICATION_PROMPT,
  group: '系统', tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false,
  agentResultMode: 'return_direct',

  jsonSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '向用户提出的澄清问题。' },
      reason: { type: 'string', description: '为什么必须先澄清。' },
      options: {
        type: 'array',
        description: '可选的快捷选项。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: '选项按钮文本。' },
            description: { type: 'string', description: '选项说明。' },
          },
            required: ['label', 'description'],
        },
      },
      allowFreeText: { type: 'boolean', description: '是否允许用户自由输入补充。' },
    },
    required: ['question', 'reason', 'options', 'allowFreeText'],
  },

  async handler(args, runtime) {
    const options = Array.isArray(args.options)
      ? args.options.filter(isRecord).map((option, index) => ({
        optionId: `clarification_option_${index + 1}`,
        label: typeof option.label === 'string' ? option.label : `选项 ${index + 1}`,
        description: typeof option.description === 'string' ? option.description : '',
        kind: 'generic',
        reason: null,
        payload: {},
      }))
      : []
    const question = String(args.question)
    return {
      message: '需要用户补充信息。',
      modelOutput: question,
      payload: {
        runId: runtime.runId,
        clarification: {
          clarificationId: makeId('clarification'),
          kind: 'plan_requirement',
          reason: String(args.reason),
          question,
          options,
          selectedOptionId: null,
          allowFreeText: typeof args.allowFreeText === 'boolean' ? args.allowFreeText : true,
        },
      },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}

export const enterPlanModeTool: ToolDef = {
  name: 'enter_plan_mode', label: '进入计划模式',
  description: ENTER_PLAN_MODE_DESCRIPTION,
  prompt: ENTER_PLAN_MODE_PROMPT,
  group: '系统',  tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false,

  jsonSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: '进入计划模式的原因' } },
    required: [],
  },

  async handler(args, runtime) {
    return {
      message: `已进入计划模式。原因: ${(args.reason as string) ?? '用户请求'}`,
      payload: { planMode: true, runId: runtime.runId },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const submitAgentWorkflowTool: ToolDef = {
  name: 'submit_agent_workflow', label: '提交智能体工作流',
  description: SUBMIT_AGENT_WORKFLOW_DESCRIPTION,
  prompt: SUBMIT_AGENT_WORKFLOW_PROMPT,
  group: '系统',  tags: ['plan', 'system'],
  isReadOnly: true, isDestructive: false,
  agentSchemaMode: 'compatible',

  jsonSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'object',
        additionalProperties: false,
        description: '待用户批准的智能体工作流。',
        properties: {
          goal: { type: 'string', description: '本轮实施目标。' },
          steps: {
            type: 'array',
            description: '按执行顺序排列的计划步骤。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                stepId: { type: 'string', description: '稳定步骤 ID，例如 step_1。' },
                title: { type: 'string', description: '面向用户的步骤标题。' },
                kind: { type: 'string', enum: ['analysis', 'tool', 'agent', 'automation', 'delivery'], description: '步骤执行类型。' },
                phase: { type: ['string', 'null'], enum: ['discover', 'validate', 'analyze', 'visualize', 'verify', 'deliver', null], description: 'Compose 阶段；普通工作流可以传 null。' },
                toolName: { type: 'string', description: '实际执行该步骤的工具名。' },
                ownerAgentId: { type: 'string', description: '负责步骤的 Agent ID；主智能体步骤固定填写 supervisor。' },
                args: { type: 'object', additionalProperties: true, description: '预计工具参数；无法确定时使用空对象。' },
                reason: { type: 'string', description: '为什么需要这一步。' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: '必须先完成的步骤 ID。' },
              },
              required: ['stepId', 'title', 'kind', 'toolName', 'ownerAgentId', 'args', 'reason', 'dependsOn'],
            },
          },
        },
        required: ['goal', 'steps'],
      },
    },
    required: ['workflow'],
  },

  async handler(args, runtime) {
    return {
      message: '智能体工作流已记录并开始执行。',
      payload: {
        planMode: false,
        agentWorkflowDraft: args.workflow,
        runId: runtime.runId,
      },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}

export const reviseAgentWorkflowTool: ToolDef = {
  name: 'revise_agent_workflow', label: '调整智能体工作流',
  description: REVISE_AGENT_WORKFLOW_DESCRIPTION,
  prompt: REVISE_AGENT_WORKFLOW_PROMPT,
  group: '系统', tags: ['plan', 'workflow', 'system'],
  isReadOnly: true, isDestructive: false,
  agentSchemaMode: 'compatible',
  jsonSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', description: '调整后的完整目标。' },
          changeReason: { type: 'string', description: '必须调整执行路径的真实原因。' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                stepId: { type: 'string', description: '稳定步骤 ID。' },
                title: { type: 'string', description: '面向用户的步骤标题。' },
                kind: { type: 'string', enum: ['analysis', 'tool', 'agent', 'automation', 'delivery'], description: '步骤执行类型。' },
                phase: { type: ['string', 'null'], enum: ['discover', 'validate', 'analyze', 'visualize', 'verify', 'deliver', null], description: 'Compose 阶段；普通工作流可以传 null。' },
                toolName: { type: 'string', description: '实际执行该步骤的工具名。' },
                ownerAgentId: { type: 'string', description: '负责步骤的 Agent ID；主智能体步骤固定填写 supervisor。' },
                args: { type: 'object', additionalProperties: true, description: '预计工具参数。' },
                reason: { type: 'string', description: '为什么需要这一步。' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: '必须先完成的步骤 ID。' },
              },
              required: ['stepId', 'title', 'kind', 'toolName', 'ownerAgentId', 'args', 'reason', 'dependsOn'],
            },
          },
        },
        required: ['goal', 'changeReason', 'steps'],
      },
    },
    required: ['workflow'],
  },
  async handler(args, runtime) {
    return {
      message: '智能体工作流已根据新情况调整。',
      payload: { agentWorkflowRevision: args.workflow, runId: runtime.runId },
      warnings: [], valueRefs: [],
      resultId: makeId('result'), source: 'system',
    }
  },
}
