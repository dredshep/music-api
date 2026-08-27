import { queueRadioGenerationAnalysis } from "./audio-analysis";
import { resolveRadioGenerationLocally } from "./radio-local-resolution";

/**
 * Final generation lifecycle pass owned by music-api.
 *
 * Every generated or materially edited playlist gets one last Navidrome lookup
 * after selection, then any resolved local files are queued for background DSP
 * analysis. A transient local-library failure is already tolerated by the
 * resolver and never destroys the saved generation.
 */
export async function finalizeRadioGeneration(generationId: string) {
  const generation = await resolveRadioGenerationLocally(generationId);
  if (generation) queueRadioGenerationAnalysis(generationId);
  return generation;
}
