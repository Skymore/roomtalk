import { describe, expect, it } from 'vitest';
import {
  canLocalEchoInput,
  createTerminalLocalEchoController,
} from './codeWorkspaceTerminalLocalEcho';

describe('codeWorkspaceTerminalLocalEcho', () => {
  it('locally echoes printable input and suppresses matching remote echo', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('abc')).toBe(true);
    expect(writes).toEqual(['abc']);
    expect(localEcho.handleRemoteData('a')).toBe('');
    expect(localEcho.handleRemoteData('bc')).toBe('');
    expect(localEcho.handleRemoteData('\r\nok\r\n')).toBe('\r\nok\r\n');
  });

  it('does not locally echo control input', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('\x1b[D')).toBe(false);
    expect(localEcho.handleInput('\x7f')).toBe(false);
    expect(localEcho.handleInput('\r')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('stops local echo while a sensitive prompt is active', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleRemoteData('Password: ')).toBe('Password: ');
    expect(localEcho.handleInput('secret')).toBe(false);
    expect(writes).toEqual([]);
    expect(localEcho.handleInput('\r')).toBe(false);
    expect(localEcho.handleInput('n')).toBe(true);
    expect(writes).toEqual(['n']);
  });

  it('accepts unicode printable input but rejects long paste chunks', () => {
    expect(canLocalEchoInput('你好')).toBe(true);
    expect(canLocalEchoInput('x'.repeat(513))).toBe(false);
  });
});
