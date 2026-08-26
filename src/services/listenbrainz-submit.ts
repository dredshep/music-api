import { getConfig } from "../config";
import { AppError } from "../middleware/errors";

export type ListenBrainzListen = {
  artist: string;
  title: string;
  album?: string;
  listenedAt?: number;
  recordingMbid?: string;
};

export function canSubmitListen(): boolean {
  return Boolean(getConfig().LISTENBRAINZ_TOKEN?.trim());
}

export async function submitSingleListen(listen: ListenBrainzListen): Promise<boolean> {
  const config = getConfig();
  const token = config.LISTENBRAINZ_TOKEN?.trim();
  if (!token) return false;

  const listenedAt = Math.floor(listen.listenedAt ?? Date.now() / 1000);
  const additionalInfo: Record<string, string> = {};
  if (listen.album) additionalInfo.release_name = listen.album;
  if (listen.recordingMbid) additionalInfo.recording_mbid = listen.recordingMbid;

  const response = await fetch("https://api.listenbrainz.org/1/submit-listens", {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "MeepMusicAPI/1.0",
    },
    body: JSON.stringify({
      listen_type: "single",
      payload: [
        {
          listened_at: listenedAt,
          track_metadata: {
            artist_name: listen.artist,
            track_name: listen.title,
            ...(listen.album ? { release_name: listen.album } : {}),
            ...(Object.keys(additionalInfo).length ? { additional_info: additionalInfo } : {}),
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AppError(
      "LISTENBRAINZ_UNAVAILABLE",
      `ListenBrainz scrobble returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
      502,
      true,
    );
  }
  return true;
}
