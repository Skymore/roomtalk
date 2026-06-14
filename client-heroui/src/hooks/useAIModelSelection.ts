import { useEffect, useState } from 'react';
import {
  AIModelOption,
  FALLBACK_AI_MODEL,
  FALLBACK_AI_MODELS,
  fetchAIModels,
  resolveSelectedAIModel,
} from '../utils/aiModels';
import { defaultRoomAISettings, getStoredRoomAISettings, updateStoredRoomAISettings } from '../utils/aiSettings';

export const useAIModelSelection = (roomId: string) => {
  const [aiModels, setAiModels] = useState<AIModelOption[]>(FALLBACK_AI_MODELS);
  const [defaultAIModel, setDefaultAIModel] = useState<string>(FALLBACK_AI_MODEL);
  const [selectedAIModel, setSelectedAIModel] = useState<string>(() => {
    const settings = getStoredRoomAISettings(roomId, defaultRoomAISettings(FALLBACK_AI_MODEL));
    return settings.selectedModel || FALLBACK_AI_MODEL;
  });

  useEffect(() => {
    let isMounted = true;

    const storedSettings = getStoredRoomAISettings(roomId, defaultRoomAISettings(FALLBACK_AI_MODEL));
    setSelectedAIModel(resolveSelectedAIModel(storedSettings.selectedModel, FALLBACK_AI_MODEL, FALLBACK_AI_MODELS));

    fetchAIModels()
      .then(({ defaultModel, models }) => {
        if (!isMounted) return;

        const latestSettings = getStoredRoomAISettings(roomId, defaultRoomAISettings(defaultModel));
        const nextModel = resolveSelectedAIModel(latestSettings.selectedModel, defaultModel, models);

        setDefaultAIModel(defaultModel);
        setAiModels(models);
        setSelectedAIModel(nextModel);
        updateStoredRoomAISettings(roomId, { selectedModel: nextModel }, defaultRoomAISettings(defaultModel));
      })
      .catch(error => {
        console.warn('Failed to load AI models, using fallback models.', error);
      });

    return () => {
      isMounted = false;
    };
  }, [roomId]);

  const handleModelChange = (model: string) => {
    setSelectedAIModel(model);
    updateStoredRoomAISettings(roomId, { selectedModel: model }, defaultRoomAISettings(defaultAIModel));
  };

  return {
    aiModels,
    defaultAIModel,
    selectedAIModel,
    handleModelChange,
  };
};
