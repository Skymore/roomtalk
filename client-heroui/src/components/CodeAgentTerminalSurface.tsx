import { useEffect, useRef, useState } from 'react';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createTerminalLocalEchoController } from '../utils/codeWorkspaceTerminalLocalEcho';
import {
  inputCodeWorkspaceTerminalSession,
  openCodeWorkspaceTerminalSession,
  resizeCodeWorkspaceTerminalSession,
  subscribeCodeWorkspaceTerminalEvents,
} from '../utils/codeWorkspaceTerminalSessions';

interface CodeAgentTerminalSurfaceProps {
  roomId: string;
  terminalId?: string;
}

const DEFAULT_TERMINAL_ID = 'terminal';

export function CodeAgentTerminalSurface({
  roomId,
  terminalId = DEFAULT_TERMINAL_ID,
}: CodeAgentTerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new XTermTerminal({
      allowProposedApi: false,
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#111111',
        foreground: '#f4f4f4',
        cursor: '#f4f4f4',
        selectionBackground: '#4d4d4d',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const localEcho = createTerminalLocalEchoController({
      write: (data) => terminal.write(data),
    });

    const sendResize = () => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const size = { cols: terminal.cols, rows: terminal.rows };
      const previous = lastSizeRef.current;
      if (previous && previous.cols === size.cols && previous.rows === size.rows) {
        return;
      }
      lastSizeRef.current = size;
      void resizeCodeWorkspaceTerminalSession({
        roomId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
      }).catch(() => undefined);
    };

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        sendResize();
      });
    };

    const dataSubscription = terminal.onData((data) => {
      localEcho.handleInput(data);
      void inputCodeWorkspaceTerminalSession({ roomId, terminalId, data }).catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : 'Terminal input failed');
      });
    });

    const unsubscribeEvents = subscribeCodeWorkspaceTerminalEvents(roomId, (event) => {
      if (event.terminalId !== terminalId) {
        return;
      }
      if (event.type === 'data' && typeof event.data === 'string') {
        const remoteData = localEcho.handleRemoteData(event.data);
        if (remoteData) {
          terminal.write(remoteData);
        }
      }
      if ((event.type === 'closed' || event.type === 'exited') && event.snapshot) {
        localEcho.reset();
        terminal.writeln('');
        terminal.writeln(`[terminal ${event.snapshot.status}]`);
      }
    });

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleResize)
      : null;
    observer?.observe(container);

    window.setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {
        // A hidden or zero-size terminal will be fitted on the next resize.
      }
      const size = { cols: terminal.cols, rows: terminal.rows };
      lastSizeRef.current = size;
      openCodeWorkspaceTerminalSession({
        roomId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
      }).then((session) => {
        setError(null);
        if (session.output) {
          localEcho.reset();
          terminal.write(session.output);
        }
      }).catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : 'Terminal failed to open');
      });
    }, 0);

    return () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      observer?.disconnect();
      unsubscribeEvents();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSizeRef.current = null;
    };
  }, [roomId, terminalId]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[#111111]" data-testid="code-agent-terminal-surface">
      <div ref={containerRef} className="min-h-0 min-w-0 flex-1 p-2 [&_.xterm]:h-full" />
      {error ? (
        <div className="absolute left-3 right-3 top-3 rounded border border-[#7a2e20] bg-[#2a1713] px-3 py-2 text-xs text-[#ffd5c9]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
