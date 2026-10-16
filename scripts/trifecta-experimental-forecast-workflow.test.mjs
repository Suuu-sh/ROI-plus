import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/trifecta-experimental-forecast.yml', import.meta.url), 'utf8');

test('watchdog dispatch input is opt-in and bounds both market-window checks', () => {
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+market_window_only:\n[\s\S]*?required: false\n\s+default: false\n\s+type: boolean/);

  const marketWindowChecks = workflow.match(/GITHUB_EVENT_NAME" == 'schedule' \|\| "\$MARKET_WINDOW_ONLY" == 'true'/g) ?? [];
  assert.equal(marketWindowChecks.length, 2, 'pre-setup skip and post-setup duration must both honor the opt-in input');

  const forwardedInputs = workflow.match(/MARKET_WINDOW_ONLY:\s*\$\{\{[^\n]+\}\}/g) ?? [];
  assert.equal(forwardedInputs.length, 2, 'each bounded shell step must receive the input through its environment');
  assert.ok(forwardedInputs.every(value => value.includes("github.event_name == 'workflow_dispatch'")));
});
