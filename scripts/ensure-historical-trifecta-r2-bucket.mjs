import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const bucketName = 'roi-plus-trifecta-archive'

export const bucketExists = output => {
  try {
    const parsed = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.result) ? parsed.result : [])]
    if (rows.some(row => row?.name === bucketName)) return true
  } catch { /* Continue with Wrangler's human-readable output. */ }
  return output.split(/\r?\n/).some(line => {
    const normalized = line.replace(/[|│┌┐└┘─]/g, ' ').trim()
    return normalized === bucketName || normalized === `name: ${bucketName}`
      || normalized === `name: '${bucketName}'` || normalized === `name: "${bucketName}"`
      || normalized.split(/\s+/)[0] === bucketName
  })
}

const findEnabledValue = value => {
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    if (/^(enabled|isEnabled|publicAccessEnabled|public_access_enabled)$/i.test(key) && typeof child === 'boolean') return child
    if (/^(status|state)$/i.test(key) && typeof child === 'string') {
      if (/^(enabled|allowed|active)$/i.test(child)) return true
      if (/^(disabled|not enabled|disallowed|inactive|not allowed)$/i.test(child)) return false
    }
    const nested = findEnabledValue(child)
    if (nested !== null) return nested
  }
  return null
}

export const devUrlEnabled = output => {
  try {
    const parsed = findEnabledValue(JSON.parse(output))
    if (parsed !== null) return parsed
  } catch { /* Continue with stable status labels in Wrangler output. */ }
  if (/public development url\s*:\s*(?:enabled|allowed)/i.test(output)
    || /public access\s*:\s*(?:enabled|allowed)/i.test(output)
    || /status\s*:\s*(?:enabled|allowed)/i.test(output)) return true
  if (/public development url\s*:\s*(?:disabled|not enabled|not allowed)/i.test(output)
    || /public access\s*:\s*(?:disabled|not allowed)/i.test(output)
    || /status\s*:\s*(?:disabled|not enabled|not allowed)/i.test(output)
    || /public development url is not enabled/i.test(output)) return false
  return null
}

export const noCustomDomains = output => {
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) return parsed.length === 0
    if (Array.isArray(parsed?.result)) return parsed.result.length === 0
    if (Array.isArray(parsed?.domains)) return parsed.domains.length === 0
  } catch { /* Continue with documented command output. */ }
  if (/no (?:custom )?domains? (?:are )?(?:configured|connected|found)/i.test(output)) return true
  const lines = output.split(/\r?\n/).map(line => line.replace(/[|│┌┐└┘─]/g, ' ').trim()).filter(Boolean)
  const domainRows = lines.filter(line => /(?:^|\s)(?:domain|hostname)\s*:/i.test(line)
    || /\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(line))
  return domainRows.length === 0 && /(?:domain|hostname)/i.test(output)
}

export const ensurePrivateBucket = async run => {
  if (!bucketExists(await run(['r2', 'bucket', 'list']))) {
    try { await run(['r2', 'bucket', 'create', bucketName]) } catch { /* A concurrent create may have won; verify below. */ }
  }
  if (!bucketExists(await run(['r2', 'bucket', 'list']))) throw new Error('bucket verification failed')

  const firstPrivacy = devUrlEnabled(await run(['r2', 'bucket', 'dev-url', 'get', bucketName]))
  if (firstPrivacy === null) throw new Error('public development URL status is unknown')
  if (firstPrivacy) {
    await run(['r2', 'bucket', 'dev-url', 'disable', bucketName, '--force'])
    const verified = devUrlEnabled(await run(['r2', 'bucket', 'dev-url', 'get', bucketName]))
    if (verified !== false) throw new Error('public development URL disable verification failed')
  }

  const domains = await run(['r2', 'bucket', 'domain', 'list', bucketName])
  if (!noCustomDomains(domains)) throw new Error('custom domain exposure cannot be ruled out')
}

const runWrangler = args => execFileSync('npx', ['wrangler', ...args], {
  cwd: 'apps/api', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensurePrivateBucket(args => runWrangler(args))
    process.stdout.write('Private historical trifecta R2 bucket is ready.\n')
  } catch {
    // Keep Wrangler stderr/stdout, API tokens, and account metadata out of logs.
    process.stderr.write('Historical trifecta R2 bucket provisioning failed closed.\n')
    process.exitCode = 1
  }
}
