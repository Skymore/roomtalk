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
  let pendingRemoteErases = 0;
  let localVisibleInputLength = 0;
  let localInputText = '';
  let remoteEchoActive = false;
  let sensitivePromptActive = false;
  let recentRemoteText = '';

  const reset = () => {
    pendingEcho = '';
    pendingRemoteErases = 0;
    localVisibleInputLength = 0;
    localInputText = '';
    remoteEchoActive = false;
    sensitivePromptActive = false;
    recentRemoteText = '';
  };

  const handleInput = (data: string): boolean => {
    if (data === '\r' || data === '\n') {
      localVisibleInputLength = 0;
      localInputText = '';
      sensitivePromptActive = false;
    }
    if (isBackspaceInput(data)) {
      if (sensitivePromptActive || localVisibleInputLength <= 0) {
        return false;
      }
      write('\b \b');
      localVisibleInputLength -= 1;
      localInputText = removeLastPrintableChar(localInputText);
      pendingRemoteErases += 1;
      return true;
    }
    if (!canLocalEchoInput(data) || sensitivePromptActive) {
      return false;
    }
    write(data);
    pendingEcho = trimPendingEcho(`${pendingEcho}${data}`);
    if (!pendingEcho) {
      remoteEchoActive = false;
    }
    localVisibleInputLength += printableCharCount(data);
    localInputText = trimPendingEcho(`${localInputText}${stripTerminalControls(data)}`);
    return true;
  };

  const handleRemoteData = (data: string): string => {
    observeRemoteText(data);
    if ((!pendingEcho && pendingRemoteErases <= 0) || !data) {
      return data;
    }

    let output = data;
    if (pendingEcho) {
      output = consumePendingEcho(output);
    }
    if (pendingRemoteErases > 0 && output && localInputText) {
      const fullLineEraseEcho = removeEmbeddedPendingEcho(output, localInputText, true, true);
      if (fullLineEraseEcho.consumed === localInputText.length) {
        pendingRemoteErases = Math.max(0, pendingRemoteErases - 1);
        output = printableOutputOrEmpty(fullLineEraseEcho.output);
      }
    }
    if (pendingRemoteErases > 0 && output) {
      output = consumePendingRemoteErases(output);
    }
    if (output.includes('\n')) {
      localVisibleInputLength = 0;
      localInputText = '';
    }
    return output;
  };

  const consumePendingEcho = (data: string): string => {
    const printableText = stripTerminalControls(data);
    if (!printableText) {
      return data;
    }

    if (printableText === pendingEcho) {
      const remainder = removeLeadingPrintableChars(data, pendingEcho.length);
      pendingEcho = '';
      remoteEchoActive = false;
      return remainder;
    }
    if (pendingEcho.startsWith(printableText)) {
      pendingEcho = pendingEcho.slice(printableText.length);
      remoteEchoActive = true;
      return removeLeadingPrintableChars(data, printableText.length);
    }
    if (pendingEcho.length > 1 && printableText.startsWith(pendingEcho)) {
      const remainder = removeLeadingPrintableChars(data, pendingEcho.length);
      pendingEcho = '';
      remoteEchoActive = false;
      return remainder;
    }

    const sharedPrefixLength = commonPrefixLength(printableText, pendingEcho);
    if (sharedPrefixLength > 1) {
      pendingEcho = pendingEcho.slice(sharedPrefixLength);
      remoteEchoActive = pendingEcho.length > 0;
      return removeLeadingPrintableChars(data, sharedPrefixLength);
    }

    const fullLineEcho = removeEmbeddedPendingEcho(
      data,
      localInputText,
      localInputText.length > 1 && pendingEcho.length > 0,
      remoteEchoActive,
    );
    if (fullLineEcho.consumed === localInputText.length) {
      pendingEcho = '';
      remoteEchoActive = false;
      return printableOutputOrEmpty(fullLineEcho.output);
    }

    const embeddedEcho = removeEmbeddedPendingEcho(
      data,
      pendingEcho,
      remoteEchoActive || pendingEcho.length > 1,
      remoteEchoActive,
    );
    if (embeddedEcho.consumed > 0) {
      pendingEcho = pendingEcho.slice(embeddedEcho.consumed);
      remoteEchoActive = pendingEcho.length > 0;
      return embeddedEcho.output;
    }

    if (data.includes('\n')) {
      pendingEcho = '';
      localInputText = '';
      remoteEchoActive = false;
    }
    return data;
  };

  const consumePendingRemoteErases = (data: string): string => {
    let output = '';
    let index = 0;
    while (index < data.length && pendingRemoteErases > 0) {
      const eraseLength = remoteEraseSequenceLength(data, index);
      if (eraseLength > 0) {
        index += eraseLength;
        pendingRemoteErases -= 1;
        continue;
      }

      const escapeLength = terminalEscapeSequenceLength(data, index);
      if (escapeLength > 0) {
        output += data.slice(index, index + escapeLength);
        index += escapeLength;
        continue;
      }

      const code = data.charCodeAt(index);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        output += data[index];
        index += 1;
        continue;
      }

      break;
    }
    return `${output}${data.slice(index)}`;
  };

  const observeRemoteText = (data: string) => {
    const text = stripAnsi(data);
    if (!text) {
      return;
    }
    recentRemoteText = `${recentRemoteText}${text}`.slice(-160);
    if (SENSITIVE_PROMPT_PATTERN.test(recentRemoteText)) {
      pendingEcho = '';
      localInputText = '';
      remoteEchoActive = false;
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

function isBackspaceInput(data: string): boolean {
  return data === '\x7f' || data === '\b';
}

function printableCharCount(value: string): number {
  return Array.from(stripTerminalControls(value)).length;
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

function removeLastPrintableChar(value: string): string {
  const chars = Array.from(value);
  chars.pop();
  return chars.join('');
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

function stripTerminalControls(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function printableOutputOrEmpty(value: string): string {
  return stripTerminalControls(value) ? value : '';
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

function removeEmbeddedPendingEcho(
  value: string,
  pendingEcho: string,
  allowEmbedded: boolean,
  preferEarliest: boolean,
): { output: string; consumed: number } {
  if (!allowEmbedded || !pendingEcho) {
    return { output: value, consumed: 0 };
  }

  let bestStart = -1;
  let bestConsumed = 0;
  let index = 0;
  while (index < value.length) {
    const escapeLength = terminalEscapeSequenceLength(value, index);
    if (escapeLength > 0) {
      index += escapeLength;
      continue;
    }

    if (isTerminalControlChar(value, index)) {
      index += 1;
      continue;
    }

    const consumed = countPendingEchoMatch(value, index, pendingEcho);
    const isBetterTie = preferEarliest ? bestStart < 0 || index < bestStart : index > bestStart;
    if (consumed > bestConsumed || (consumed === bestConsumed && consumed > 0 && isBetterTie)) {
      bestStart = index;
      bestConsumed = consumed;
    }
    index += 1;
  }

  if (bestStart < 0 || bestConsumed <= 0) {
    return { output: value, consumed: 0 };
  }
  return {
    output: removePrintableCharsFrom(value, bestStart, bestConsumed),
    consumed: bestConsumed,
  };
}

function countPendingEchoMatch(value: string, start: number, pendingEcho: string): number {
  let index = start;
  let consumed = 0;
  while (index < value.length && consumed < pendingEcho.length) {
    const escapeLength = terminalEscapeSequenceLength(value, index);
    if (escapeLength > 0) {
      index += escapeLength;
      continue;
    }

    if (isTerminalControlChar(value, index)) {
      index += 1;
      continue;
    }

    if (value[index] !== pendingEcho[consumed]) {
      break;
    }

    consumed += 1;
    index += 1;
  }
  return consumed;
}

function removePrintableCharsFrom(value: string, start: number, count: number): string {
  let removed = 0;
  let index = 0;
  let output = '';
  while (index < value.length) {
    const escapeLength = terminalEscapeSequenceLength(value, index);
    if (escapeLength > 0) {
      output += value.slice(index, index + escapeLength);
      index += escapeLength;
      continue;
    }

    if (isTerminalControlChar(value, index)) {
      output += value[index];
      index += 1;
      continue;
    }

    if (index >= start && removed < count) {
      removed += 1;
      index += 1;
      continue;
    }

    output += value[index];
    index += 1;
  }
  return output;
}

function isTerminalControlChar(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
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

function remoteEraseSequenceLength(value: string, index: number): number {
  const rest = value.slice(index);
  if (rest.startsWith('\b \b')) {
    return 3;
  }
  if (rest.startsWith('\x7f')) {
    return 1;
  }

  const cursorEraseMatch = /^\x1b\[(?:\d+)?D \x1b\[(?:\d+)?D/.exec(rest);
  if (cursorEraseMatch) {
    return cursorEraseMatch[0].length;
  }

  const deleteCharMatch = /^\x1b\[(?:\d+)?P/.exec(rest);
  if (deleteCharMatch) {
    return deleteCharMatch[0].length;
  }

  return 0;
}
