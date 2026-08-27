# Gradient Radio route model

Gradient Radio has three deliberately separate jobs:

1. **Route discovery** finds a path through musical regions. Intermediate regions do not need direct affinity to either endpoint; each local graph step must be plausible.
2. **Track selection** chooses actual recordings near successive route coordinates while applying taste, feedback, availability, cooldown, and diversity constraints.
3. **DJ sequencing** optimizes local hand-offs using cached audio features. It is subordinate to the route and may not introduce meaningful A→B backtracking.

## Algorithms

- `geodesic`: bounded graph expansion plus minimum accumulated local-edge cost.
- `scenic`: searches the discovered graph for a longer locally coherent route and samples nearby interior territory.
- `blend`: legacy endpoint interpolation retained only as a live-test baseline.

## Seed-region semantics

Explicit track, artist, and album seeds have a narrow artist anchor. Broad playlist, liked, library, and collection snapshots are represented by up to four weighted/distinct artists instead of one arbitrary track. Genre seeds derive several representative artists from Last.fm tag results.

Adjacent broad regions share one bounded multi-source graph search budget. The route may therefore choose a secondary representative artist when it creates a substantially better local path, while still preferring higher-ranked representatives when routes are otherwise similar. Diagnostics record both candidate anchor sets and the selected graph-anchor pair.

An explicit **track** waypoint is stronger than a recommendation hint: on a connected route leg that exact recording is enforced near its requested waypoint. Artist/album/genre/broad seeds describe musical regions and remain free to choose a representative recording. On a partially connected multipoint route, a track waypoint on an undiscovered leg is not stamped with a fake route coordinate.

## Coordinate invariant

`radio_generation_tracks.trajectory_position` is authoritative as a musical route coordinate **only** when track metadata contains `trajectoryCoordinateKind: "musical_route"`.

For graph-routed generations the coordinate is calculated from cumulative graph edge cost inside each user waypoint interval. It is never assigned from physical playlist index. Legacy/fallback generations may still contain old numeric values for compatibility, but callers must not present them as musical trajectory percentages.

## Failure and partial-route behavior

Graph search is bounded and external similarity data can be sparse or unavailable. If no graph leg is discovered, the generator keeps the normal Radio result and records `gradient_route_warning`; no UI may fabricate route percentages.

For multipoint routes, connected legs may still carry authoritative coordinates while disconnected intervals fall back to normal Radio ordering. `gradient_route.segments` is the source of truth for which intervals are connected.

## DJ and edit invariants

The normal DJ sequencer runs after local playback resolution. A final Gradient route-order guard then repairs route-coordinate inversions inside unlocked segments while preserving regenerate prefixes, pins, manual edits, and unknown-coordinate slots.

Saved generations remain immutable unless the user explicitly edits, restores, imports, or regenerates them.