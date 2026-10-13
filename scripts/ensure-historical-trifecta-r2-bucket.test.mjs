import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketExists, devUrlEnabled, ensurePrivateBucket, noCustomDomains } from './ensure-historical-trifecta-r2-bucket.mjs'

test('recognizes documented Wrangler bucket list formats with informational banners', () => {
  assert.equal(bucketExists('Creating resource listing...\nname: roi-plus-trifecta-archive\n'), true)
  assert.equal(bucketExists('┌────────────────────────────────┐\n│ name                           │\n├────────────────────────────────┤\n│ roi-plus-trifecta-archive      │\n└────────────────────────────────┘'), true)
  assert.equal(bucketExists('[{"name":"roi-plus-trifecta-archive"}]'), true)
  assert.equal(bucketExists('No buckets found.'), false)
})

test('parses enabled/disabled public URL status and fails closed on unknown output', () => {
  assert.equal(devUrlEnabled('{"result":{"enabled":true}}'), true)
  assert.equal(devUrlEnabled('Public Development URL: Disabled'), false)
  assert.equal(devUrlEnabled('Some unexpected output'), null)
})

test('requires custom-domain list to be verifiably empty', () => {
  assert.equal(noCustomDomains('{"result":[]}'), true)
  assert.equal(noCustomDomains('Domains configured:\n- archive.example.com'), false)
  assert.equal(noCustomDomains('unexpected output'), false)
})

test('disables and verifies an enabled dev URL before accepting private bucket', async () => {
  let enabled = true
  const calls = []
  const run = async args => {
    calls.push(args)
    if (args[2] === 'list') return 'name: roi-plus-trifecta-archive'
    if (args[2] === 'dev-url' && args[3] === 'get') return `Public Development URL: ${enabled ? 'Enabled' : 'Disabled'}`
    if (args[2] === 'dev-url' && args[3] === 'disable') { enabled = false; return '' }
    if (args[2] === 'domain') return 'Domains\n(no domains configured)'
    throw new Error('unexpected command')
  }
  await ensurePrivateBucket(run)
  assert.equal(enabled, false)
  assert.equal(calls.some(args => args[2] === 'dev-url' && args[3] === 'disable'), true)
})
