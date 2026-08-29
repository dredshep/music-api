/**
 * Offline benchmark for the cached minimax hop search.
 *
 * Usage:
 *   DATABASE_PATH=/tmp/music-api-bench.sqlite bun run benchmark/minimax-bench.ts
 *
 * Requires a copy of the production SQLite DB at DATABASE_PATH.
 */
import { resetConfigForTests } from "../src/config";
import { initDatabase, getDb } from "../src/db/database";
import { gradientRecording, gradientRecordingEdgeCost } from "../src/services/radio-gradient-recording-path";
import { searchCachedBalancedFixedHopPath } from "../src/services/radio-gradient-cached-minimax-hop-search";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "/tmp/music-api-bench.sqlite";
process.env.API_KEY = "bench-bench-bench-bench-bench-bench-bench-bench";
process.env.NAVIDROME_USERNAME = "bench";
process.env.NAVIDROME_PASSWORD = "bench";
process.env.LASTFM_API_KEY = "bench";
process.env.LASTFM_USERNAME = "bench";
resetConfigForTests();
initDatabase();

const db = getDb();
const nodeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM recording_similarity_nodes").get()!.c;
const edgeCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM recording_similarity_edges").get()!.c;
const audioCount = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM track_audio_analysis WHERE status='ready'").get()!.c;

console.log(`\nGraph: ${nodeCount} nodes, ${edgeCount} edges, ${audioCount} audio analyses\n`);

interface BenchCase {
  label: string;
  start: ReturnType<typeof gradientRecording>;
  end: ReturnType<typeof gradientRecording>;
  length: number;
}

const cases: BenchCase[] = [
  {
    label: "A. Poppy -> Marduk (10 tracks)",
    start: gradientRecording("Poppy", "Girls In Bikinis"),
    end: gradientRecording("Marduk", "Panzer Division Marduk"),
    length: 10,
  },
  {
    label: "B. In Flames -> Dark Tranquillity (10 tracks)",
    start: gradientRecording("In Flames", "Only for the Weak"),
    end: gradientRecording("Dark Tranquillity", "Damage Done"),
    length: 10,
  },
  {
    label: "C. Poppy -> Taake (10 tracks)",
    start: gradientRecording("Poppy", "Girls In Bikinis"),
    end: gradientRecording("Taake", "Nattestid Ser Ppp I Vepp"),
    length: 10,
  },
  {
    label: "D. Poppy -> Marduk (15 tracks, longer route)",
    start: gradientRecording("Poppy", "Girls In Bikinis"),
    end: gradientRecording("Marduk", "Panzer Division Marduk"),
    length: 15,
  },
  {
    label: "CACHE HIT: Poppy -> Marduk (10 tracks, repeat)",
    start: gradientRecording("Poppy", "Girls In Bikinis"),
    end: gradientRecording("Marduk", "Panzer Division Marduk"),
    length: 10,
  },
];

function formatMs(ms: number) { return `${ms.toFixed(1)} ms`; }
function formatMb(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

for (const bench of cases) {
  console.log(`=== ${bench.label} ===`);

  if (typeof Bun !== "undefined") Bun.gc(true);
  const memBefore = process.memoryUsage();

  const t0 = performance.now();
  const result = searchCachedBalancedFixedHopPath(bench.start, bench.end, {
    requestedLength: bench.length,
    minSimilarity: 0.08,
    endpointArtists: [bench.start.artist, bench.end.artist],
  });
  const elapsed = performance.now() - t0;

  const memAfter = process.memoryUsage();

  console.log(`  Wall time:   ${formatMs(elapsed)}`);
  console.log(`  Candidates:  ${result.candidatesEvaluated.toLocaleString()}`);
  console.log(`  Graph:       ${result.graphNodes} nodes, ${result.graphEdges} edges`);
  console.log(`  RSS delta:   ${formatMb(memAfter.rss - memBefore.rss)}`);
  console.log(`  Heap used:   ${formatMb(memAfter.heapUsed)}`);
  console.log(`  Heap total:  ${formatMb(memAfter.heapTotal)}`);

  if (result.path) {
    const recs = result.path.recordings;
    const edges = result.path.edges;
    console.log(`  Tracks:      ${recs.length}`);
    console.log(`  Route:`);
    for (let i = 0; i < recs.length; i++) {
      const pos = edges.length > 0
        ? (i === 0 ? 0 : edges.slice(0, i).reduce((s, e) => s + gradientRecordingEdgeCost(e.similarity, e.confidence), 0) / result.path.cost * 100)
        : 0;
      console.log(`    ${(i + 1).toString().padStart(2)}. ${recs[i]!.artist} — ${recs[i]!.title}  (${pos.toFixed(1)}%)`);
    }
    const jumps = edges.map(e => {
      const cost = gradientRecordingEdgeCost(e.similarity, e.confidence);
      return (cost / result.path!.cost * 100).toFixed(1);
    });
    console.log(`  Jumps:       ${jumps.join(", ")}`);
    const costs = edges.map(e => gradientRecordingEdgeCost(e.similarity, e.confidence));
    console.log(`  Max jump:    ${Math.max(...costs.map((c, i) => parseFloat(jumps[i]!)))}%`);
    console.log(`  Max edge:    ${Math.max(...costs).toFixed(3)}`);
    console.log(`  Total cost:  ${result.path.cost.toFixed(3)}`);
  } else {
    console.log(`  NO PATH FOUND`);
  }
  console.log();
}
