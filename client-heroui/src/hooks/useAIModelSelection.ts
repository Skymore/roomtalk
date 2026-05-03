import { useEffect, useState } from 'react';
import {
  AIModelOption,
  FALLBACK_AI_MODEL,
  FALLBACK_AI_MODELS,
  fetchAIModels,
  getStoredAIModel,
  resolveSelectedAIModel,
  saveStoredAIModel,
} from '../utils/aiModels';

export const useAIModelSelection = () => {
  const [aiModels, setAiModels] = useState<AIModelOption[]>(FALLBACK_AI_MODELS);
  const [defaultAIModel, setDefaultAIModel] = useState<string>(FALLBACK_AI_MODEL);
  const [selectedAIModel, setSelectedAIModel] = useState<string>(() => getStoredAIModel() || FALLBACK_AI_MODEL);

  useEffect(() => {
    let isMounted = true;

    fetchAIModels()
      .then(({ defaultModel, models }) => {
        if (!isMounted) return;

        const nextModel = resolveSelectedAIModel(getStoredAIModel(), defaultModel, models);

        setDefaultAIModel(defaultModel);
        setAiModels(models);
        setSelectedAIModel(nextModel);
        saveStoredAIModel(nextModel);
      })
      .catch(error => {
        console.warn('Failed to load AI models, using fallback models.', error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleModelChange = (model: string) => {
    setSelectedAIModel(model);
    saveStoredAIModel(model);
  };

  return {
    aiModels,
    defaultAIModel,
    selectedAIModel,
    handleModelChange,
  };
};
