// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 清单签名
//
//   文件:       manifest-signing.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function publicKeyFingerprint(key) {
  const publicKey = key
    && typeof key === 'object'
    && key.type === 'public'
    && typeof key.export === 'function'
    ? key
    : createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('发布签名密钥必须是 Ed25519。')
  }
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

export async function readSigningMaterial(repositoryRoot, signingKeyPath) {
  const privateKey = createPrivateKey(
    await readFile(path.resolve(repositoryRoot, signingKeyPath)),
  )
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('--signing-key 必须是 Ed25519 私钥。')
  }
  return { privateKey, keyFingerprint: publicKeyFingerprint(privateKey) }
}

export async function writeManifestSignature(artifactRoot, manifestBytes, signingMaterial) {
  const signature = sign(null, manifestBytes, signingMaterial.privateKey)
  await writeFile(
    path.join(artifactRoot, 'runtime-service-manifest.sig'),
    `${JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyFingerprint: signingMaterial.keyFingerprint,
      signatureBase64: signature.toString('base64'),
    }, null, 2)}\n`,
    'utf8',
  )
}

export function verifyTrustedManifestSignature(input) {
  const { manifestBytes, manifestSigning, signature, trustedPublicKey } = input
  if (manifestSigning?.algorithm !== 'ed25519' || signature?.algorithm !== 'ed25519') {
    throw new Error('Runtime Service 只支持 Ed25519 manifest 签名。')
  }
  if (signature.schemaVersion !== 1 || typeof signature.signatureBase64 !== 'string') {
    throw new Error('Runtime Service manifest 签名格式不受支持。')
  }
  const trustedFingerprint = publicKeyFingerprint(trustedPublicKey)
  if (manifestSigning.keyFingerprint !== trustedFingerprint
    || signature.keyFingerprint !== trustedFingerprint) {
    throw new Error('Runtime Service manifest 签名密钥指纹与部署侧信任根不一致。')
  }
  const valid = verify(
    null,
    manifestBytes,
    trustedPublicKey,
    Buffer.from(signature.signatureBase64, 'base64'),
  )
  if (!valid) throw new Error('Runtime Service manifest Ed25519 签名校验失败。')
}
