import type { WarpCredential } from '../desktop'

/**
 * 解析 WARP 账户凭证，兼容多种常见格式：
 * 1. WARP 官方/第三方客户端导出的 account JSON：
 *    { "private_key": "...", "public_key": "...", "address": "172.16.0.2/32", "endpoint": { "host": "...", "port": 2408 } }
 * 2. 带 peer 信息的完整注册响应：
 *    { "warp": { "public_key": "...", "endpoint": {...} }, "client_key": "...", "private_key": "..." }
 * 3. 直接的 wireguard 字段命名（camelCase）
 */
export function parseWarpCredential(input: string): WarpCredential {
  let raw: any
  try {
    raw = JSON.parse(input.trim())
  } catch {
    throw new Error('JSON 解析失败')
  }
  if (!raw || typeof raw !== 'object') throw new Error('凭证格式错误')

  // XEHN 的账号文件把外层 / 内层 / MASQUE 设备放在同一份 JSON 里
  const outer: any = raw.outer && typeof raw.outer === 'object' ? raw.outer : raw
  const inner: any = raw.inner && typeof raw.inner === 'object' ? raw.inner : raw
  const masque: any = raw.masque && typeof raw.masque === 'object' ? raw.masque : {}

  const pick = (obj: any, ...keys: string[]): string => {
    for (const k of keys) {
      const v = obj?.[k]
      if (typeof v === 'string' && v) return v
      if (v && typeof v === 'object') {
        const nested = v.private_key ?? v.privateKey ?? v.key ?? v.public_key ?? v.publicKey
        if (typeof nested === 'string' && nested) return nested
      }
    }
    return ''
  }

  const privateKey = pick(outer, 'private_key', 'privateKey', 'client_key', 'clientKey', 'key')
  const peerPublicKey = pick(outer, 'public_key', 'publicKey', 'peer_public_key', 'peerPublicKey', 'server_key', 'serverKey')
  const endpointRaw = outer.endpoint ?? {}
  const endpointHost = typeof endpointRaw === 'string'
    ? endpointRaw.split(':')[0]
    : (endpointRaw.host ?? endpointRaw.hostname ?? endpointRaw.host_v4 ?? endpointRaw.hostV4 ?? '')
  const endpointPort = Number(
    (typeof endpointRaw === 'string' ? endpointRaw.split(':')[1] : (endpointRaw.port ?? 2408)) || 2408,
  )

  let address = pick(outer, 'address', 'address_v4', 'addressV4', 'ip', 'client_ip', 'clientIp')
  if (address.includes('/')) address = address.split('/')[0]
  const addressV6Raw = pick(outer, 'address_v6', 'addressV6', 'ipv6')
  const addressV6 = addressV6Raw.includes('/') ? addressV6Raw.split('/')[0] : addressV6Raw

  if (!privateKey || !peerPublicKey || !address) {
    throw new Error('缺少必要字段：private_key / public_key / address')
  }

  // PEM 公钥去掉头尾和换行，mihomo 需要纯 base64 DER
  const stripPem = (s: string) => s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')

  return {
    privateKey,
    peerPublicKey,
    addressV4: address,
    addressV6,
    endpointHost: endpointHost || '8.35.211.178',
    endpointPort: Number.isFinite(endpointPort) ? endpointPort : 2408,
    innerPrivateKey: pick(inner, 'private_key', 'privateKey') || undefined,
    innerEndpointHost: undefined,
    innerEndpointPort: undefined,
    masquePrivateKey: pick(masque, 'private_key', 'privateKey') || undefined,
    masquePublicKey: stripPem(pick(masque, 'peer_public_key', 'peerPublicKey', 'public_key', 'publicKey')) || undefined,
  }
}
