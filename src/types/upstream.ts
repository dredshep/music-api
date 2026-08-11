// slskd types (internal, not exposed to API consumers)

export interface SlskdSearchState {
  id: string;
  searchText: string;
  state: string;
  responseCount: number;
  fileCount: number;
}

export interface SlskdSearchResponse {
  username: string;
  fileCount: number;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength: number;
  files: SlskdFile[];
  lockedFiles?: SlskdFile[];
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

export interface SlskdUserDirectory {
  name: string;
  files: SlskdFile[];
  directories?: SlskdUserDirectory[];
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
