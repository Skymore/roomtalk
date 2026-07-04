import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCodexMessageAIModel,
  normalizeCodexRunSettings,
} from './codexRunSettings';

describe('codexRunSettings', () => {
  it('normalizes requested Codex model and reasoning effort', () => {
    assert.deepEqual(normalizeCodexRunSettings('gpt-5.3-codex-spark', 'high', 'fullAccess'), {
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'high',
      permissionMode: 'fullAccess',
    });
    assert.deepEqual(normalizeCodexRunSettings('unknown', 'invalid', 'invalid'), {
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
    });
  });

  it('builds message model metadata without pricing', () => {
    assert.deepEqual(getCodexMessageAIModel({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
    }), {
      id: 'gpt-5.5',
      apiModel: 'gpt-5.5',
      provider: 'openai',
      label: 'GPT-5.5 Extra High',
    });
  });
});
