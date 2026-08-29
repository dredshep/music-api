# Gradient direct edge verification

Compression may need to verify a specific retained adjacency even when that target is outside a recording's generic top-N neighbor list. `lookupEdge()` exists for that point-to-point verification, including reverse-only cached collaborative evidence.

The validated Gradient provider must apply the same cached acoustic transition policy to `lookupEdge()` that it applies to `neighbors()` and `bidirectionalNeighbors()`:

- catastrophic cached acoustic cliffs are rejected;
- weak but non-catastrophic acoustic matches reduce confidence;
- strong acoustic evidence may modestly raise confidence;
- missing acoustic analysis remains neutral.

This keeps direct compression lookups from becoming an acoustic-validation bypass.
