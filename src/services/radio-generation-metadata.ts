import { getDb } from "../db/database";
import { presentGeneration } from "./radio";

/**
 * Editing operations can intentionally change a generation's exact playlist
 * length (for example Spotify import or restoring a pre-import revision). Keep
 * requested_length aligned with the saved playlist whenever the operation is
 * meant to restore/replace the exact generation rather than leave it partial.
 */
export function syncRadioGenerationLengthToTracks(generationId: string) {
  const row = getDb().query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM radio_generation_tracks WHERE generation_id=?",
  ).get(generationId);
  if (!row) return null;
  getDb().query("UPDATE radio_generations SET requested_length=? WHERE id=?")
    .run(Number(row.count), generationId);
  return presentGeneration(generationId);
}
