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

    if (data.startsWith(pendingEcho)) {
      const remainder = data.slice(pendingEcho.length);
      pendingEcho = '';
      return remainder;
    }
    if (pendingEcho.startsWith(data)) {
      pendingEcho = pendingEcho.slice(data.length);
      return '';
    }

    const sharedPrefixLength = commonPrefixLength(data, pendingEcho);
    if (sharedPrefixLength > 0) {
      pendingEcho = pendingEcho.slice(sharedPrefixLength);
      return data.slice(sharedPrefixLength);
    }

    pendingEcho = '';
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
