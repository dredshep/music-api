# Gradient Radio live validation checklist

Validate against a real Last.fm/Navidrome/Spotify-connected deployment after exact-head PR CI passes.

For comparable trials keep all station settings fixed except `gradientAlgorithm` and generate a new immutable version for `geodesic`, `scenic`, and `blend`.

## Required scenarios

- Poppy → Taake distant-route reference, all three algorithms
- another distant pair
- close/same-scene pair
- A → B → C three-waypoint gradient
- exact Track A → exact Track B, including:
  - both tracks available locally
  - a Spotify-resolved exact track
  - an exact requested recording that cannot be resolved for playback
- deliberately hard/unconnectable pair
- partially connected multi-waypoint route
- tail regeneration with pinned/manual material before and after the cut point
- Live Radio through several refills and through the B → A route wrap

## Exact waypoint invariants

An exact `track` seed is a request for that recording, not merely its artist region. Confirm the requested recording remains in the saved playlist even when its graph leg is disconnected. When its route coordinate is unsupported it must have `trajectory_position = null`, must not claim `trajectoryCoordinateKind = "musical_route"`, and should be reported as an unpositioned Gradient waypoint. DJ resequencing and final route repair must not move exact Gradient waypoints.

## Capture the pipeline, not just the final playlist

Persist the generation diagnostics for every non-blend trial. At minimum capture:

- `gradient_route` and its selected representative anchors, nodes, edges, confidence, query count, connected/disconnected segments
- `gradient_route_candidate_count` and `gradient_route_candidate_regions`
- `gradient_stage_route_selected`
- `gradient_stage_before_waypoints` / `gradient_stage_after_waypoints`
- `gradient_stage_after_resolution`
- `gradient_stage_after_dj`
- `gradient_stage_final`
- `gradient_track_waypoint_guard`
- `gradient_route_order_guard`
- `dj_moved_count` and `local_resolution_changed_count`
- `gradient_pipeline_timing` (`route_search_ms`, `route_materialization_ms`, `route_selection_ms`, `local_resolution_ms`, `dj_resequence_ms`, `route_order_guard_ms`, and `total_until_finalized_ms`)
- provider and final availability counts

The stage snapshots deliberately expose compact track order/route-coordinate traces. Use them to locate the first stage at which a bad musical transition or route inversion appears instead of blaming the final output generically.

The old top-level request/generation duration may describe only part of the pipeline. Use `gradient_pipeline_timing.total_until_finalized_ms` for the instrumented end-to-end generation/finalization measurement.

## Listening criteria

Confirm no graph-routed generation exposes an index-derived trajectory as a musical coordinate. Compare route-selected → after-DJ → final backtracking and note how many tracks the DJ and final order guard moved.

Judge the feature by listening as well as diagnostics: smooth global journey, useful/interesting middle, local transition quality, endpoint arrival, repetition, and overall preference. Pay special attention to:

- whether Last.fm similarity produces fandom bridges that do not sound musically plausible
- whether different recordings by the same route artist make the artist-level route coordinate too coarse
- whether the strict final monotonic guard improves the journey or damages otherwise-good local transitions
- the seam between the last track of one Live refill and the first track of the next, since batches are generated independently

Do not loosen the final monotonic guard, redesign route search, or change Live wrap semantics solely to make diagnostics prettier. Make those changes only when a repeatable real-service/listening failure identifies that stage as the cause.
