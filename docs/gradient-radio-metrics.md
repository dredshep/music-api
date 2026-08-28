# Gradient route diagnostics

- `gradient_route.algorithm`: `geodesic`, `scenic`, or legacy `blend`.
- `gradient_route.usable`: whether at least one required waypoint leg has a discovered graph route.
- `gradient_route.confidence`: mean connected-segment geometric edge confidence.
- `gradient_route.query_count`: bounded artist-similarity lookups used for route discovery.
- `gradient_route.max_gap`: largest normalized distance between discovered route nodes.
- `gradient_route_candidate_count`: actual recordings materialized from route regions.
- `gradient_route_positioned_ratio`: selected tracks carrying an authoritative musical-route coordinate.
- `gradient_route_backtracks`: route inversions before final DJ protection.
- `gradient_route_order_guard.backtracksAfter`: inversions after the final route guard.

These are diagnostics, not a replacement for listening tests.
