// The downloaded tools this page keeps in the browser: the video engine and
// the speech models. Neither is personal; they're cached so they don't have
// to be downloaded again. Shared by both backends (the local server's page
// can use them too, e.g. for captions when the server has no Whisper).

import { engineCacheSize, clearEngineCache } from './media.js';
import { MODELS, RETIRED_MODELS, modelCacheSizes, clearModel, clearAllModels } from './speech.js';

export async function toolInventory() {
  const [engine, { sizes, other }] = await Promise.all([engineCacheSize(), modelCacheSizes()]);
  return {
    engine,
    models: [...MODELS, ...RETIRED_MODELS].filter(m => sizes.has(m.name))
      .map(m => ({ name: m.name, label: m.label, retired: RETIRED_MODELS.includes(m), bytes: sizes.get(m.name) })),
    modelOther: other,
  };
}

export const toolActions = {
  clearEngine: clearEngineCache,
  clearModel,
  clearAllTools: () => Promise.all([clearEngineCache(), clearAllModels()]),
};
