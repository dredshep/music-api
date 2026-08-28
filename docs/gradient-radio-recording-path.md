# Gradient Radio recording-path architecture

Gradient Radio is a pathfinding product, not endpoint radio. For graph-routed generations the backend must construct a traversable sequence of recordings between requested musical regions and must not call ordinary recommendation filler a successful Gradient.

## Starting regression

The redesign was triggered by a real Poppy → Taake generation whose first track was Satyricon and which contained an abrupt `Satyricon - Mother North → Poppy - Girls in Bikinis` transition. The previous implementation discovered an artist path, fetched top tracks for each route artist, assigned every fetched recording the artist's route coordinate, then allowed those inherited coordinates to influence DJ semantic compatibility. That made artist position masquerade as recording evidence.

## Model

The graph-routed model is now:

1. **Seed regions** resolve to actual recordings.
   - exact track: exactly that recording;
   - artist: several recordings by that artist, with one selected as the route waypoint;
   - broad playlist/library/liked/genre/collection seeds: regions, not hard recordings.
2. **Recording graph search** performs bounded multi-source bidirectional search between consecutive waypoint regions.
3. **Path densification** fills requested length by inserting recordings that bridge both adjacent sides. A bottleneck-safe one-recording common neighbor is preferred; if that is exhausted, a bounded two-interior `left → C → D → right` fallback can bridge a gap.
4. **Familiarity shaping** prefers a U-shaped familiarity curve: familiar near endpoints and novel around the middle. Endpoint artists are excluded from the central discovery region during densification.
5. **Independent acoustic validation** uses cached local DSP when available. Catastrophic known cliffs are rejected; weak known acoustic matches reduce graph-edge confidence; missing analysis is neutral.
6. **Playback resolution** remains downstream. A recording is chosen because it belongs on the route, then Navidrome/Spotify resolution attempts to make it playable.
7. **DJ sequencing** may optimize local flow but trajectory-coordinate closeness is no longer counted as independent semantic evidence.
8. **Final order repair** is a safety invariant only. Diagnostics report its order and independent acoustic impact before/after.

A successful recording-path generation does not merge ordinary Radio candidates into the route. If no route is found, ordinary Radio is generated only as an explicitly labeled `gradient_fallback_radio` and receives no fabricated musical-route coordinates.

## Recording identity and coordinates

The persistent similarity graph keeps a compact normalized graph key for provider/cache identity. Joins against the existing Radio history/audio model always use `canonicalRadioTrackKey(artist, title)` so old saved generations and new paths share the established exact-recording namespace.

`radio_generation_tracks.trajectory_position` is authoritative only when metadata contains `trajectoryCoordinateKind: "musical_route"`. Recording-path coordinates are derived from cumulative edge cost and then scaled into the user's waypoint interval. Playlist index is never substituted for musical distance.

## Providers and persistent graph

`recording_similarity_nodes`, `recording_similarity_edges`, and `recording_similarity_fetches` persist graph discoveries and negative/failed fetch state. Current edge providers are:

- Last.fm `track.getSimilar`;
- ListenBrainz Labs Similar Recordings when a recording MBID exists;
- optional local Discogs-EffNet cosine neighbors through `simil`.

Provider evidence remains separate. Multiple providers may increase confidence but collaborative agreement is not treated as acoustic truth.

The cache is intentionally organic: a cold unusual route may be expensive, but its discovered graph edges make future overlapping searches warmer.

## Local embeddings with simil

Local embedding integration is optional. Set:

```env
GRADIENT_SIMIL_ENABLED=true
GRADIENT_SIMIL_COMMAND=simil
GRADIENT_SIMIL_LIBRARY=gradient
GRADIENT_SIMIL_WORKERS=2
GRADIENT_SIMIL_MIN_COSINE=0.22
```

The `simil` executable must be available inside the music-api runtime and see the same `LIBRARY_MUSIC_PATH` mount. music-api periodically queues:

```text
simil index <LIBRARY_MUSIC_PATH> --embedder effnet-discogs --library gradient --workers N
```

`simil` owns incremental file fingerprinting and re-embeds only new/changed tracks. Route lookups use `simil search ... --json` and persist **raw cosine (`raw_score`)**, never the per-query min-max display score.

This dependency is not installed automatically in the production Docker image. A deployment without `simil` continues to use Last.fm/ListenBrainz plus existing cached DSP instead of failing generation or downloading a model unexpectedly.

## Prior art reviewed

### BoilTheFrog

`plamere/BoilTheFrog` used a precomputed artist graph and NetworkX `bidirectional_dijkstra`. Its graph/path framing is directly relevant, but its nodes are artists and its historical edge weighting is not suitable as recording-level acoustic truth.

### artistpath

`malbiruk/artistpath` demonstrates the modern large-graph version of the same idea: millions of Last.fm artist nodes, memory-mapped graph data, and explicit bidirectional BFS/Dijkstra with search budgets/filters. Its weighted implementation uses `1 - similarity` edge cost. Gradient Radio borrows the persistent/bidirectional graph architecture while moving the playable path down to recordings.

### simil

`horacio/simil` demonstrates a practical local audio-index architecture. Discogs-EffNet produces 1280-dimensional music-specific embeddings; indexing is incremental; raw cosine is available in JSON search output; and a local collection can be queried without recomputing every embedding during radio generation.

## Failure semantics

Route state is explicit:

- `complete`: every requested leg connected;
- `partial`: at least one leg connected but the full requested trajectory is not valid;
- `no_route`: no connected recording leg;
- `gradient_fallback_radio=true`: ordinary Radio generated after a route failure.

Hard exact-track/artist waypoints remain present when possible even on partial/fallback output, but unsupported waypoints remain unpositioned. A pin/manual lock that prevents a hard final endpoint is preserved as a user lock and the generation is marked partial with `gradient_endpoint_lock_conflict`; the backend must not call that route ready.

## Live Gradient

A recording-path Live session plans a bounded future path once, returns that path as client-carried route state, and consumes it across refill boundaries. The state includes the next planned index, previous actual recording, and completion status. Refill N+1 therefore continues refill N's path instead of independently rediscovering another route. Reaching B completes the recording path rather than silently wrapping to A.

Legacy Blend, standard Radio, and fallback/old Gradient outputs retain the older cursor-window continuation behavior.

## Diagnostics

Recording-path diagnostics include:

- actual route recordings and coordinates;
- raw discovered path and densification operations;
- edge provider/similarity/confidence;
- bottleneck score;
- actual nodes visited, frontier sizes and intersection;
- provider calls/cache hits/cache misses;
- catastrophic acoustic-edge rejections;
- middle novelty/familiarity;
- actual hard endpoint status;
- path-search, densification and acoustic-validation timing;
- DJ and order-guard movement/transition impact;
- Live route-state reuse/completion.

These measurements aid diagnosis; none replaces listening acceptance.
