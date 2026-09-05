// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务协议与隐私政策页面
//
//   文件:       LegalPolicyPage.tsx
//
//   日期:       2026年07月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { requestDesktopDocument } from '../../app/desktopNavigation'

type LegalKind = 'terms' | 'privacy'

interface LegalPolicyPageProps {
  kind: LegalKind
}

const TERMS_SECTIONS = [
  {
    title: '1. 服务范围',
    body: [
      '本服务提供气象数据分析、地图浏览、图层管理、智能体工具调用、自动化流程、定时任务、语音输入、报告和成果文件生成等工作台能力。',
      '平台输出用于辅助分析与决策，不替代法定气象预警、应急指挥、工程验收、金融交易或医疗安全等高风险场景中的专业判断。',
    ],
  },
  {
    title: '2. 账号与工作区',
    body: [
      '用户通过工作台账号登录后访问所属工作区。账号、成员关系、角色和权限以服务端 Better Auth 与 Casbin 校验结果为准。',
      '用户应妥善保管账号凭据，不得共享账号、绕过权限、冒用他人身份或利用接口探测无权资源。',
    ],
  },
  {
    title: '3. 数据上传与输出',
    body: [
      '用户上传 NetCDF、GRIB、GeoJSON、栅格、雷达等数据时，应确保其拥有合法使用权，并理解数据质量会直接影响分析结果。',
      '平台生成的图层、统计、报告、音频、图片和其他成果文件会记录在对应工作区和运行历史中，并受到相同权限边界保护。',
    ],
  },
  {
    title: '4. 智能体、工具与审批',
    body: [
      '智能体可能调用工具读取文件、执行气象计算、生成图层或创建报告。高风险、写入、删除、导出或外部副作用工具必须遵守工作区审批策略。',
      '计划模式、审批模式、自动化流程和定时任务不会绕过服务端权限；任何权限不足的操作都会失败并记录审计。',
    ],
  },
  {
    title: '5. 语音与第三方服务',
    body: [
      '语音识别和语音合成可能使用 Azure Speech 等第三方服务。浏览器只接收短期授权，长期订阅密钥保存在服务端。',
      '外部模型和工具调用失败时，平台应返回明确错误，不会伪造成功结果。',
    ],
  },
  {
    title: '6. 可接受使用',
    body: [
      '不得上传恶意文件、利用路径遍历或超大数据攻击服务，不得绕过沙箱、Worker、RBAC、CSRF、限流和审计机制。',
      '不得使用平台生成违法、侵权、误导公众或冒充官方预警的信息。',
    ],
  },
  {
    title: '7. 服务变更与终止',
    body: [
      '平台可能根据安全、稳定性或产品演进调整工具、模型、自动化流程、配额和权限策略。',
      '若账号被禁用、权限被撤销、工作区归档或存在安全风险，相关访问和后台任务会被拒绝或停止。',
    ],
  },
  {
    title: '8. 责任限制',
    body: [
      '本服务尽力提供可靠的数据处理链路、日志、指标和审计，但不保证第三方模型、外部 API、上传数据或科学算法在所有场景下无误。',
      '正式生产使用应结合业务合同、合规要求和人工复核流程，本协议页面不替代双方另行签署的法律文件。',
    ],
  },
]

const PRIVACY_SECTIONS = [
  {
    title: '1. 我们处理的数据',
    body: [
      '账号数据：邮箱、显示名、账号状态、登录时间、工作区成员关系、角色和权限。',
      '业务数据：用户输入、上传文件、气象数据集、图层、成果文件、自动化流程参数、定时任务配置、工具调用记录和运行历史。',
      '安全数据：CSRF 令牌、会话状态、审计日志、限流记录、错误日志、Worker 调用状态和必要的诊断指标。',
    ],
  },
  {
    title: '2. 使用目的',
    body: [
      '用于完成登录认证、权限判断、工作区隔离、气象分析、地图展示、报告生成、语音识别授权、后台任务执行和故障排查。',
      '用于记录审计事件、检测滥用、保护系统安全、统计模型服务真实返回的词元用量和改进平台可靠性。',
    ],
  },
  {
    title: '3. 模型与工具处理',
    body: [
      '用户请求可能被发送给配置的模型服务或工具服务以生成回答、计划、统计、图层或报告。平台只应发送完成任务所需的上下文。',
      '历史对话不会被运行时静默注入提示词；需要历史事实时，智能体必须通过上下文工具显式读取。',
    ],
  },
  {
    title: '4. 存储与隔离',
    body: [
      '用户、工作区、权限、会话、线程、运行历史、图层和索引元数据保存在 PostgreSQL/PostGIS；上传内容、成果文件二进制、检查点和记忆正文保存在内容寻址对象存储。',
      '私有记忆绑定用户，团队记忆绑定工作区，运行时成果文件绑定线程、运行和工作区。资源 ID 不是访问令牌，每次访问都由服务端回校权限。',
    ],
  },
  {
    title: '5. Cookie 与短期授权',
    body: [
      '本服务使用 HTTP-only Cookie 保存 Better Auth 登录会话，并使用 CSRF 令牌保护可变更请求。',
      'Azure Speech 等浏览器侧能力只接收短期授权令牌，不接收长期订阅密钥；前端不会将长期密钥写入 localStorage、运行历史或工具结果。',
    ],
  },
  {
    title: '6. 共享与第三方',
    body: [
      '除完成模型调用、语音识别、科学计算、存储和运维所需外，平台不应主动向无关第三方共享用户数据。',
      '当工作区管理员导出成果文件、报告或图层时，导出文件的后续使用由导出者和所属组织负责。',
    ],
  },
  {
    title: '7. 保留与删除',
    body: [
      '会话、运行、成果文件、审计和日志的保留周期由部署环境和工作区策略决定。删除或归档操作应通过服务端接口完成，并记录必要审计。',
      '对于必须保留的安全审计、账务统计或合规记录，平台可能在合理期限内继续保存最小必要信息。',
    ],
  },
  {
    title: '8. 用户权利与联系',
    body: [
      '用户可通过账号中心查看当前身份、工作区、角色和权限；管理员可通过安全管理后台禁用用户、管理成员关系和查看审计。',
      '如需更正、导出或删除组织数据，应联系工作区管理员或平台运维人员，具体流程以部署方制度为准。',
    ],
  },
]

export function LegalPolicyPage({ kind }: LegalPolicyPageProps) {
  const isTerms = kind === 'terms'
  const title = isTerms ? '服务协议' : '隐私政策'
  const sections = isTerms ? TERMS_SECTIONS : PRIVACY_SECTIONS

  return (
    <main className="legal-page ui-page" aria-labelledby="legal-title">
      <article className="legal-shell ui-page__content">
        <header className="legal-hero ui-page-header">
          <div>
            <span className="account-eyebrow">{isTerms ? '服务条款' : '隐私与数据'}</span>
            <h1 id="legal-title">{title}</h1>
            <p>
              最近更新：2026年7月9日。本文面向地理智能工作台使用场景，覆盖账号、权限、气象数据、
              模型工具、自动化流程、语音服务、审计和运行历史等能力。
            </p>
          </div>
          <div className="legal-actions">
            <button type="button" onClick={() => requestDesktopDocument('account')}>返回账号中心</button>
            <button type="button" onClick={() => requestDesktopDocument('map')}>返回工作台</button>
            <button type="button" onClick={() => requestDesktopDocument(isTerms ? 'privacy' : 'terms')}>
              {isTerms ? '查看隐私政策' : '查看服务协议'}
            </button>
          </div>
        </header>

        <nav className="legal-toc ui-card" aria-label="章节目录">
          {sections.map(section => (
            <a key={section.title} href={`#${slug(section.title)}`}>{section.title}</a>
          ))}
        </nav>

        <div className="legal-sections">
          {sections.map(section => (
            <section key={section.title} id={slug(section.title)} className="legal-section ui-page-section">
              <h2>{section.title}</h2>
              {section.body.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
        </div>
      </article>
    </main>
  )
}

function slug(value: string): string {
  return value.replace(/[^0-9A-Za-z\u4e00-\u9fa5]+/gu, '-')
}
