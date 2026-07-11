import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { CodeAgentMode } from '../types';
import {
  codeAgentModeAllowsStaticPublish,
  codeAgentModeAllowsWriteTools,
} from './codeAgentModes';

describe('codeAgentModes', () => {
  it('keeps Plan read-only and allows static publishing in every writable mode', () => {
    const expected = new Map<CodeAgentMode, boolean>([
      ['plan', false],
      ['edit', true],
      ['acceptEdits', true],
      ['approveForMe', true],
      ['fullAccess', true],
    ]);

    for (const [mode, allowsWrite] of expected) {
      assert.equal(codeAgentModeAllowsWriteTools(mode), allowsWrite, mode);
      assert.equal(codeAgentModeAllowsStaticPublish(mode), allowsWrite, mode);
    }
  });
});
