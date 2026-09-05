// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 地址与解析策略
//
//   文件:       providerEndpointPolicy.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 配置地址只限定为 HTTP/HTTPS，不再按公网、内网或回环范围拦截用户明确填写的服务。
// --------------------------------------------------------------------------

import { lookup as systemLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type {
  DnsAddressResolver,
  DnsResolvedAddress,
} from './providers/openaiTransport.js'

export interface ProviderEndpointPolicyDependencies {
  lookup?: typeof systemLookup
}

export function assertCustomProviderBaseUrl(baseUrl: string): URL {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('自定义 Provider Base URL 无效。')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`自定义 Provider 不支持协议 '${url.protocol}'。`)
  }
  if (url.username || url.password) throw new Error('自定义 Provider Base URL 不能包含用户凭据。')
  if (url.search || url.hash) throw new Error('自定义 Provider Base URL 不能包含查询参数或片段。')

  return url
}

export function createProviderDnsResolver(
  dependencies: ProviderEndpointPolicyDependencies = {},
): DnsAddressResolver {
  const lookup = dependencies.lookup ?? systemLookup
  return async (hostname, family) => {
    const normalized = normalizeHostname(hostname)
    const literalFamily = isIP(normalized)
    const addresses: DnsResolvedAddress[] = literalFamily
      ? [{ address: normalized, family: literalFamily as 4 | 6 }]
      : (await lookup(normalized, {
          all: true,
          verbatim: true,
          family: family === 4 || family === 6 ? family : 0,
        })).map(result => ({ address: result.address, family: result.family }))
    if (!addresses.length) throw new Error(`自定义 Provider 域名 '${normalized}' 没有可用地址。`)

    return addresses
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
}
