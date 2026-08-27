# Gradient Radio live validation checklist

Validate against real Last.fm/Navidrome/Spotify-connected deployment after PR CI passes.

For every trial keep all station settings fixed except `gradientAlgorithm` and generate a new immutable version for `geodesic`, `scenic`, and `blend`.

Required checks:

- Poppy → Taake distant-route reference
- another distant pair
- close/same-scene pair
- three-waypoint gradient
- deliberately hard/unconnectable pair
- tail regeneration with a pinned route track
- Live Radio continuation

Capture `gradient_route`, route candidate count, positioned ratio, route errors, route-order guard result, provider counts, availability counts, and request duration. Confirm no graph-routed generation exposes an index-derived trajectory as a musical coordinate. Confirm final route-coordinate order has no meaningful backtracking except where a locked/pinned/manual track makes it unavoidable.

Judge the default by listening as well as diagnostics: smooth global journey, useful/interesting middle, local transition quality, endpoint arrival, repetition, and overall preference.
