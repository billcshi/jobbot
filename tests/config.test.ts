import { describe, expect, it } from 'vitest';
import { resolveDeepseekThinking } from '../src/utils/config.js';

describe('DeepSeek thinking mode', () => {
  it('disables automatic thinking for Flash models', () => {
    expect(resolveDeepseekThinking('auto', 'deepseek-v4-flash')).toEqual({ type: 'disabled' });
    expect(resolveDeepseekThinking('auto', 'DEEPSEEK-FLASH')).toEqual({ type: 'disabled' });
  });

  it('enables automatic thinking for heavier models', () => {
    expect(resolveDeepseekThinking('auto', 'deepseek-v4-pro')).toEqual({ type: 'enabled' });
  });

  it('honors explicit overrides regardless of model', () => {
    expect(resolveDeepseekThinking('enabled', 'deepseek-v4-flash')).toEqual({ type: 'enabled' });
    expect(resolveDeepseekThinking('disabled', 'deepseek-v4-pro')).toEqual({ type: 'disabled' });
  });
});
