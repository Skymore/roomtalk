import React from "react";
import { renderMarkdown as renderA2UIMarkdown } from "@a2ui/markdown-it";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import type { A2uiClientAction, SurfaceModel } from "@a2ui/web_core/v0_9";
import {
  A2uiSurface,
  MarkdownContext,
  basicCatalog,
} from "@a2ui/react/v0_9";
import type { ReactComponentImplementation } from "@a2ui/react/v0_9";
import { A2UIActionEvent, A2UIPayload } from "../utils/types";
import "./A2UIRenderer.css";

interface A2UIRendererProps {
  payload: A2UIPayload;
  roomId: string;
  messageId: string;
  onAction?: (action: A2UIActionEvent) => void;
}

const surfaceList = (processor: MessageProcessor<ReactComponentImplementation>) => (
  Array.from(processor.model.surfacesMap.values())
);

export const A2UIRenderer: React.FC<A2UIRendererProps> = ({ payload, roomId, messageId, onAction }) => {
  const onActionRef = React.useRef(onAction);
  const processedCountRef = React.useRef(0);
  const [processingError, setProcessingError] = React.useState<unknown>(null);
  const [surfaces, setSurfaces] = React.useState<Array<SurfaceModel<ReactComponentImplementation>>>([]);

  React.useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  const processor = React.useMemo(() => (
    new MessageProcessor([basicCatalog], (action: A2uiClientAction) => {
      onActionRef.current?.({
        ...action,
        context: {
          ...action.context,
          roomId,
          messageId,
        },
      });
    })
  ), [messageId, roomId]);

  const syncSurfaces = React.useCallback(() => {
    setSurfaces(surfaceList(processor));
  }, [processor]);

  React.useEffect(() => {
    processedCountRef.current = 0;
    setProcessingError(null);
    setSurfaces([]);

    const createdSub = processor.onSurfaceCreated(syncSurfaces);
    const deletedSub = processor.onSurfaceDeleted(syncSurfaces);
    syncSurfaces();

    return () => {
      createdSub.unsubscribe();
      deletedSub.unsubscribe();
      processor.model.dispose();
    };
  }, [processor, syncSurfaces]);

  React.useEffect(() => {
    if (payload.format !== "a2ui" || payload.version !== "v0.9") {
      return;
    }

    if (payload.messages.length < processedCountRef.current) {
      processedCountRef.current = 0;
    }

    const nextMessages = payload.messages.slice(processedCountRef.current);
    if (nextMessages.length === 0) {
      return;
    }

    try {
      processor.processMessages(nextMessages as never);
      processedCountRef.current = payload.messages.length;
      setProcessingError(null);
      syncSurfaces();
    } catch (error) {
      console.error("Failed to process A2UI messages:", error);
      setProcessingError(error);
    }
  }, [payload.format, payload.messages, payload.version, processor, syncSurfaces]);

  if (payload.format !== "a2ui" || payload.version !== "v0.9" || processingError) {
    return null;
  }

  const renderableSurfaces = surfaces.filter(surface => surface.componentsModel.get("root"));
  if (renderableSurfaces.length === 0) {
    return null;
  }

  return (
    <MarkdownContext.Provider value={renderA2UIMarkdown}>
      <div className="a2ui-renderer mt-2 flex max-w-full flex-col gap-2">
        {renderableSurfaces.map(surface => (
          <div key={surface.id} data-testid="a2ui-surface" data-surface-id={surface.id}>
            <A2uiSurface surface={surface} />
          </div>
        ))}
      </div>
    </MarkdownContext.Provider>
  );
};

export default A2UIRenderer;
