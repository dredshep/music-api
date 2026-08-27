# Gradient invariants

1. Intermediate route regions need only local adjacency; no direct endpoint affinity is required.
2. Route discovery, track selection, and DJ sequencing are separate stages.
3. A musical-route coordinate is never derived from playlist index.
4. DJ optimization cannot introduce meaningful route backtracking except around user-locked tracks.
5. Failure to discover a route produces an explicit fallback, never a fabricated trajectory.
6. Saved generations remain immutable unless the user explicitly edits/regenerates them.
