# Gradient Radio route model

Gradient Radio has three deliberately separate jobs:

1. **Route discovery** finds a path through musical regions. Intermediate regions do not need direct affinity to either endpoint; each local graph step must be plausible.
2. **Track selection** chooses actual recordings near successive route coordinates while applying taste, feedback, availability, cooldown, and diversity constraints.
3. **DJ sequencing** optimizes local hand-offs using cached audio features. It is subordinate to the route and may not introduce meaningful A→B backtracking.

## Algorithms

- `geodesic`: bounded graph expansion plus minimum accumulated local-edge cost.
- `scenic`: searches the discovered graph for a longer locally coherent route and samples nearby interior territory.
- `blend`: legacy endpoint interpolation retained only as a live-test baseline.

## Coordinate invariant

`radio_generation_tracks.trajectory_position` is authoritative as a musical route coordinate **only** when track metadata contains `trajectoryCoordinateKind: "musical_route"`.

For graph-routed generations the coordinate is calculated from cumulative graph edge cost inside each user waypoint interval. It is never assigned from physical playlist index. Legacy/fallback generations may still contain old numeric values for compatibility, but callers must not present them as musical trajectory percentages.

## Failure behavior

If a required graph route cannot be discovered, generation falls back to the base Radio order and records `gradient_route_warning`. No UI should invent route percentages for that fallback.

## DJ invariant

The normal DJ sequencer runs after local playback resolution. A final Gradient route-order guard then repairs route-coordinate inversions inside unlocked segments while preserving regenerate prefixes, pins, manual edits, and unknown-coordinate slots.
