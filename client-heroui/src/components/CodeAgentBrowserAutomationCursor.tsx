import { MousePointer2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  codeWorkspacePreviewAutomationCursorOpacity,
  type CodeWorkspacePreviewAutomationCursorController,
  type CodeWorkspacePreviewAutomationCursorEvent,
} from '../utils/codeWorkspacePreviewAutomationCursor';

const CURSOR_ACTIVE_MS = 700;

interface CodeAgentBrowserAutomationCursorProps {
  event: CodeWorkspacePreviewAutomationCursorEvent | null;
  controller?: CodeWorkspacePreviewAutomationCursorController;
}

export function CodeAgentBrowserAutomationCursor({
  event,
  controller = 'agent',
}: CodeAgentBrowserAutomationCursorProps) {
  if (!event) {
    return null;
  }
  return (
    <CodeAgentBrowserAutomationCursorEvent
      key={event.sequence}
      event={event}
      controller={controller}
    />
  );
}

interface CodeAgentBrowserAutomationCursorEventProps {
  event: CodeWorkspacePreviewAutomationCursorEvent;
  controller: CodeWorkspacePreviewAutomationCursorController;
}

function CodeAgentBrowserAutomationCursorEvent({
  event,
  controller,
}: CodeAgentBrowserAutomationCursorEventProps) {
  const [active, setActive] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: codeWorkspacePreviewAutomationCursorOpacity(active, controller),
        transform: `translate3d(${event.x}px, ${event.y}px, 0)`,
      }}
      aria-hidden="true"
      data-testid="code-agent-browser-automation-cursor"
      data-phase={event.phase}
      data-sequence={event.sequence}
    >
      {event.phase === 'click' ? (
        <span
          key={event.sequence}
          className="absolute left-0.5 top-0.5 h-4 w-4 animate-ping rounded-full bg-[#c96442]/25 motion-reduce:animate-none dark:bg-[#ffb197]/25"
          data-testid="code-agent-browser-automation-cursor-ping"
        />
      ) : null}
      <MousePointer2
        className="relative h-5 w-5 -translate-x-0.5 -translate-y-0.5 fill-[#faf9f5] text-[#c96442] drop-shadow-sm dark:fill-[#141413] dark:text-[#ffb197]"
        strokeWidth={2}
      />
    </div>
  );
}
