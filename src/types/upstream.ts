// slskd types (internal, not exposed to API consumers)

export interface SlskdSearchState {
  id: string;
  searchText: string;
  state: string;
  responseCount: number;
  fileCount: number;
  isComplete?: boolean;
}

/**
 * Raw slskd search response — the upstream payload uses `hasFreeUploadSlot`
 * (boolean) while legacy/test code may still send `freeUploadSlots` (number).
 * Normalise via {@link normalizeSearchResponse} before use.
 */
export interface SlskdSearchResponseRaw {
  username: string;
  fileCount: number;
  hasFreeUploadSlot?: boolean;
  freeUploadSlots?: number;
  uploadSpeed: number;
  queueLength: number;
  files: SlskdFile[];
  lockedFiles?: SlskdFile[];
  lockedFileCount?: number;
}

/** Normalised form consumed by the candidate pipeline. */
export interface SlskdSearchResponse {
  username: string;
  fileCount: number;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength: number;
  files: SlskdFile[];
  lockedFiles: SlskdFile[];
  lockedFileCount: number;
}

export interface SlskdFile {
  filename: string;
  size: number;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  length?: number;
  code?: string;
}

export interface SlskdDownloadState {
  username: string;
  directories: SlskdDownloadDirectory[];
}

export interface SlskdDownloadDirectory {
  directory: string;
  fileCount: number;
  files: SlskdTransferFile[];
}

export interface SlskdTransferFile {
  id: string;
  filename: string;
  size: number;
  state: string;
  bytesTransferred: number;
  averageSpeed?: number;
  startedAt?: string;
  endedAt?: string;
}

/**
 * slskd POST /users/{username}/directory returns an array of directory
 * objects.  Each directory has a `name` and `files` where filenames may
 * be basenames rather than full remote paths.
 */
export interface SlskdUserDirectory {
  name: string;
  files: SlskdFile[];
  directories?: SlskdUserDirectory[];
}

// --- Normalisation helpers ---

export function normalizeSearchResponse(
  raw: SlskdSearchResponseRaw
): SlskdSearchResponse {
  let freeSlots: number;
  if (typeof raw.hasFreeUploadSlot === "boolean") {
    freeSlots = raw.hasFreeUploadSlot ? 1 : 0;
  } else if (typeof raw.freeUploadSlots === "number") {
    freeSlots = raw.freeUploadSlots;
  } else {
    freeSlots = 0;
  }

  return {
    username: raw.username,
    fileCount: raw.fileCount,
    freeUploadSlots: freeSlots,
    uploadSpeed: raw.uploadSpeed ?? 0,
    queueLength: raw.queueLength ?? 0,
    files: Array.isArray(raw.files) ? raw.files : [],
    lockedFiles: Array.isArray(raw.lockedFiles) ? raw.lockedFiles : [],
    lockedFileCount:
      raw.lockedFileCount ?? (Array.isArray(raw.lockedFiles) ? raw.lockedFiles.length : 0),
  };
}

export function isSearchComplete(state: SlskdSearchState): boolean {
  if (state.isComplete === true) return true;
  const s = state.state?.toLowerCase().replace(/\s/g, "") ?? "";
  return (
    s === "completed" ||
    s.startsWith("completed,") ||
    s === "completed,succeeded" ||
    s === "completed,timedout"
  );
}

// Navidrome/Subsonic types

export interface SubsonicResponse<T> {
  "subsonic-response": {
    status: "ok" | "failed";
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic: boolean;
    error?: { code: number; message: string };
  } & T;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount: number;
  artistImageUrl?: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  songCount: number;
  duration: number;
  year?: number;
  genre?: string;
  coverArt?: string;
}

export interface SubsonicSong {
  id: string;
  title: string;
  album: string;
  artist: string;
  albumId: string;
  artistId: string;
  track?: number;
  year?: number;
  duration: number;
  size: number;
  suffix: string;
  bitRate?: number;
  path: string;
}

export interface SubsonicSearchResult {
  artist?: SubsonicArtist[];
  album?: SubsonicAlbum[];
  song?: SubsonicSong[];
}

// MusicBrainz types

export interface MBArtist {
  id: string;
  name: string;
  "sort-name": string;
  disambiguation?: string;
  aliases?: MBAlias[];
  type?: string;
  country?: string;
}

export interface MBAlias {
  name: string;
  "sort-name": string;
  type?: string;
  locale?: string;
  primary?: boolean;
}

export interface MBReleaseGroup {
  id: string;
  title: string;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "first-release-date"?: string;
  "artist-credit"?: MBArtistCredit[];
}

export interface MBArtistCredit {
  artist: { id: string; name: string };
  joinphrase?: string;
}

export interface MBArtistSearchResult {
  artists: MBArtist[];
  count: number;
  offset: number;
}

export interface MBReleaseGroupBrowseResult {
  "release-groups": MBReleaseGroup[];
  "release-group-count": number;
  "release-group-offset": number;
}
