# Gradient fallback semantics

Graph search is bounded and external similarity data can be sparse or unavailable. When no route can be discovered, the generator keeps the normal Radio result rather than fabricating a path.

The generation records `gradient_route_warning`; Manager must hide any legacy/index-derived percentage unless the track explicitly carries `trajectoryCoordinateKind: "musical_route"`.
