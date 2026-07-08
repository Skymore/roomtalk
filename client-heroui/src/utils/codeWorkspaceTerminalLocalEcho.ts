const MAX_LOCAL_ECHO_CHUNK_LENGTH = 512;
const SENSITIVE_PROMPT_PATTERN = /\b(password|passphrase|secret|token)\b[^\r\n]*[:：]?\s*$/i;

interface TerminalLocalEchoControllerOptions {
  write: (data: string) => void;
}

export interface TerminalLocalEchoController {
  handleInput(data: string): boolean;
  handleRemoteData(data: string): string;
  reset(): void;
}

export function createTerminalLocalEchoController({
  write,
}: TerminalLocalEchoControllerOptions): TerminalLocalEchoController {
  let pendingEcho = '';
  let sensitivePromptActive = false;
  let recentRemoteText = '';

  const reset = () => {
    pendingEcho = '';
    sensitivePromptActive = false;
    recentRemoteText = '';
  };

  const handleInput = (data: string): boolean => {
    if (data === '\r' || data === '\n') {
      sensitivePromptActive = false;
    }
    if (!canLocalEchoInput(data) || sensitivePromptActive) {
      return false;
    }
    write(data);
    pendingEcho = trimPendingEcho(`${pendingEcho}${data}`);
    return true;
  };

  const handleRemoteData = (data: string): string => {
    observeRemoteText(data);
    if (!pendingEcho || !data) {
      return data;
    }

    const printableText = stripTerminalControls(data);
    if (!printableText) {
      return data;
    }

    if (printableText.startsWith(pendingEcho)) {
      const remainder = removeLeadingPrintableChars(data, pendingEcho.length);
      pendingEcho = '';
      return remainder;
    }
    if (pendingEcho.startsWith(printableText)) {
      pendingEcho = pendingEcho.slice(printableText.length);
      return removeLeadingPrintableChars(data, printableText.length);
    }

    const sharedPrefixLength = commonPrefixLength(printableText, pendingEcho);
    if (sharedPrefixLength > 0) {
      pendingEcho = pendingEcho.slice(sharedPrefixLength);
      return removeLeadingPrintableChars(data, sharedPrefixLength);
    }

    if (data.includes('\n')) {
      pendingEcho = '';
    }
    return data;
  };

  const observeRemoteText = (data: string) => {
    const text = stripAnsi(data);
    if (!text) {
      return;
    }
    recentRemoteText = `${recentRemoteText}${text}`.slice(-160);
    if (SENSITIVE_PROMPT_PATTERN.test(recentRemoteText)) {
      pendingEcho = '';
      sensitivePromptActive = true;
    }
  };

  return {
    handleInput,
    handleRemoteData,
    reset,
  };
}

export function canLocalEchoInput(data: string): boolean {
  if (!data || data.length > MAX_LOCAL_ECHO_CHUNK_LENGTH) {
    return false;
  }
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;
  while (index < maxLength && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function trimPendingEcho(value: string): string {
  if (value.length <= MAX_LOCAL_ECHO_CHUNK_LENGTH) {
    return value;
  }
  return value.slice(-MAX_LOCAL_ECHO_CHUNK_LENGTH);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

function stripTerminalControls(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function removeLeadingPrintableChars(value: string, count: number): string {
  if (count <= 0) {
    return value;
  }

  let removed = 0;
  let index = 0;
  let filtered = '';
  while (index < value.length && removed < count) {
    const escapeLength = terminalEscapeSequenceLength(value, index);
    if (escapeLength > 0) {
      filtered += value.slice(index, index + escapeLength);
      index += escapeLength;
      continue;
    }

    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      filtered += value[index];
      index += 1;
      continue;
    }

    index += 1;
    removed += 1;
  }

  return `${filtered}${value.slice(index)}`;
}

function terminalEscapeSequenceLength(value: string, index: number): number {
  if (value.charCodeAt(index) !== 0x1b) {
    return 0;
  }

  const next = value[index + 1];
  if (next === '[') {
    const match = /\x1b\[[0-?]*[ -/]*[@-~]/.exec(value.slice(index));
    return match?.index === 0 ? match[0].length : 1;
  }
  if (next === ']') {
    const rest = value.slice(index);
    const bellIndex = rest.indexOf('\x07');
    const stIndex = rest.indexOf('\x1b\\');
    const endCandidates = [bellIndex >= 0 ? bellIndex + 1 : -1, stIndex >= 0 ? stIndex + 2 : -1]
      .filter(candidate => candidate > 0);
    return endCandidates.length > 0 ? Math.min(...endCandidates) : value.length - index;
  }

  return Math.min(2, value.length - index);
}
