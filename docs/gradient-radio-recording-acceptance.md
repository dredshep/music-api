# Gradient Radio recording-path local acceptance

Do not merge the recording-path redesign solely because unit tests and CI are green. The product contract is audible: a listener should be able to hear how the route got from A to B.

## 1. Environment

Run against a copy of the real music-api DB and the real provider configuration used in deployment.

Confirm:

- Navidrome is reachable and `LIBRARY_MUSIC_PATH` points at the same audio library;
- Last.fm recording similarity works;
- ListenBrainz Labs failures are tolerated and cached rather than aborting the route;
- Spotify playback resolution works if configured;
- if local embeddings are being evaluated, `simil` is available in the music-api runtime and `GRADIENT_SIMIL_ENABLED=true`.

If using `simil`, force/observe an initial index build before comparing warm-route performance. Confirm a subsequent index pass does not re-embed unchanged files.

## 2. Regression: Poppy → Taake

Create an artist Gradient:

```text
Poppy → Taake
length ≈ 30
algorithm = geodesic
```

Then repeat with `scenic` while keeping every other setting constant.

Hard requirements:

- track 1 artist is Poppy;
- final track artist is Taake;
- endpoint artists do not occupy the central discovery region;
- output is not marked `gradient_fallback_radio` unless no route was found;
- every displayed percentage has `trajectoryCoordinateKind=musical_route`;
- the central ~10 tracks contain visibly intermediate territory rather than endpoint repetition/generic filler.

Export the exact ordered track list and generation diagnostics before listening.

## 3. Listen to every adjacency

Play the generated sequence in order. For every consecutive pair record one of:

- smooth / obvious continuation;
- surprising but plausible step;
- questionable;
- cliff / unacceptable.

Specifically reject a generation containing anything comparably abrupt to the original regression:

```text
Satyricon - Mother North
→
Poppy - Girls in Bikinis
```

When a cliff exists, inspect the relevant edge diagnostics:

- collaborative/provider similarity;
- local EffNet edge if present;
- cached DSP evidence;
- whether acoustic evidence was missing;
- whether the route planner produced the adjacency or DJ/order repair created it;
- order-guard acoustic score/catastrophic-edge delta.

Do not fix the diagnostic number instead of the audible problem.

## 4. Middle/discovery assessment

Inspect roughly positions 10–20 of a 30-track Poppy → Taake route.

Record:

- artists/recordings already familiar to the user;
- genuinely unknown recordings;
- whether endpoint artists appear in the discovery core;
- whether the middle feels like its own connective musical territory;
- whether novelty rises into the middle and falls toward Taake.

Compare this to `gradient_route.middle_novelty` and per-track familiarity metadata. If the diagnostic curve claims novelty but the user plainly knows the middle, tune familiarity data plumbing rather than route coordinates.

## 5. Other required routes

Run and listen to:

1. another distant genre pair;
2. a close/same-scene pair;
3. a three-waypoint artist route `A → B → C`;
4. exact recording → exact recording;
5. a deliberately bizarre distant pair;
6. an intentionally unconnectable pair.

For `A → B → C`, confirm the actual B recording that ends the first leg is the same recording that starts the second leg.

For exact recordings, confirm exact identity, not just artist/title substitution.

For no-route, confirm explicit fallback/no-route UI and absence of fabricated musical percentages.

## 6. Tail regeneration and locks

Generate a route, then test tail regeneration with:

- an unchanged prefix;
- a pin on a recording that remains on the newly planned path;
- an off-route pin;
- an off-route manual track;
- a final-slot pin/manual track that prevents the requested hard destination.

Expected behavior:

- locks are never silently discarded;
- a locked recording still present on the new path is reprojected to the new path coordinate;
- an off-route lock remains in place but has no musical-route coordinate and is marked `gradientLockedOffRoute`;
- if a lock prevents hard endpoint B, generation status is `partial` and `gradient_endpoint_lock_conflict=true`, never `ready`.

## 7. Live Gradient

Start a recording-path Live session and capture at least three refill responses.

Verify:

- the first response carries route state;
- later responses report `live_route_state_reused=true`;
- batch N+1 begins from the next planned path portion, not a rediscovered A-side route;
- exclusions advance through the same plan;
- the previous actual recording is retained in route state;
- destination B is eventually reached;
- the recording-path session marks completion and does not silently wrap to A;
- the seam between every two batches is listened to and judged like any other adjacency.

## 8. Cold/warm performance

For the same route, record at least:

```text
route_search_ms
path_search_ms
densification_ms
acoustic_validation_ms
cache_hits
cache_misses
provider_calls
nodes_visited
forward_frontier_max
backward_frontier_max
```

Run once cold and again warm.

A warm route should show materially more cache reuse and fewer external provider calls. Investigate if the same route repeatedly incurs the same expensive provider expansion.

## 9. Local embedding coverage

If `simil` is enabled, capture:

- total library files indexed;
- indexing failures;
- index size;
- initial build time;
- incremental no-change scan time;
- changed/new-track indexing behavior;
- percentage of final route adjacencies where local EffNet evidence was available.

Do not require local EffNet evidence for every global/discovered recording: remote discoveries may not exist in the local library.

## 10. Merge decision

Only recommend merge when all are true:

- repository CI green at exact PR heads;
- migrations apply cleanly to a DB copy;
- Poppy → Taake hard endpoints pass;
- Poppy → Taake middle is recognizably connective/discovery-oriented;
- no unacceptable adjacency remains in the acceptance generation;
- other route shapes behave honestly;
- fallback semantics are explicit;
- Live refill continuity passes;
- cold/warm/cache measurements are captured;
- any remaining weakness is documented with an understood impact.

If listening has not been performed, report the PR as engineering-complete or locally-testable as appropriate, but **not musically validated** and not ready to merge on musical correctness grounds.
