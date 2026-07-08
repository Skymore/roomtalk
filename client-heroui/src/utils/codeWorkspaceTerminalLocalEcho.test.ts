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

  it('locally erases backspace and suppresses the later remote erase echo', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('abc')).toBe(true);
    expect(localEcho.handleInput('\x7f')).toBe(true);
    expect(writes).toEqual(['abc', '\b \b']);
    expect(localEcho.handleRemoteData('abc\b \b')).toBe('');
  });

  it('suppresses a deleted character that the PTY echoes after local backspace', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('ab')).toBe(true);
    expect(localEcho.handleRemoteData('a')).toBe('');
    expect(localEcho.handleInput('\x7f')).toBe(true);
    expect(localEcho.handleRemoteData('b')).toBe('');
    expect(localEcho.handleRemoteData('\b \b')).toBe('');
    expect(writes).toEqual(['ab', '\b \b']);
  });

  it('does not locally erase when there is no local input to delete', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('\x7f')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('keeps pending local echo across terminal control sequences', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('ls')).toBe(true);
    expect(localEcho.handleRemoteData('\x1b[?2004h\x1b]133;A\x07')).toBe('\x1b[?2004h\x1b]133;A\x07');
    expect(localEcho.handleRemoteData('\x1b[?2004hl')).toBe('\x1b[?2004h');
    expect(localEcho.handleRemoteData('s\r\ncss\r\n')).toBe('\r\ncss\r\n');
    expect(writes).toEqual(['ls']);
  });

  it('keeps pending local echo across prompt status text before the PTY echo arrives', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('l')).toBe(true);
    expect(localEcho.handleRemoteData('[powerlevel10k] fetching gitstatusd .. [ok]\r')).toBe('[powerlevel10k] fetching gitstatusd .. [ok]\r');
    expect(localEcho.handleRemoteData('l')).toBe('');
    expect(writes).toEqual(['l']);
  });

  it('clears stale local echo when remote output moves to a new line without echoing it', () => {
    const writes: string[] = [];
    const localEcho = createTerminalLocalEchoController({
      write: (data) => writes.push(data),
    });

    expect(localEcho.handleInput('x')).toBe(true);
    expect(localEcho.handleRemoteData('command output\n')).toBe('command output\n');
    expect(localEcho.handleRemoteData('x')).toBe('x');
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
