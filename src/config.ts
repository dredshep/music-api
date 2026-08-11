import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(8787),

  API_KEY: z.string().min(32, "API_KEY must be at least 32 characters").max(256),

  SLSKD_URL: z.string().url().default("http://slskd:5030"),
  SLSKD_API_VERSION: z.string().default("v0"),
  SLSKD_API_KEY: z.string().default(""),

  NAVIDROME_URL: z.string().url().default("http://navidrome:4533"),
  NAVIDROME_USERNAME: z.string().min(1, "NAVIDROME_USERNAME is required"),
  NAVIDROME_PASSWORD: z.string().min(1, "NAVIDROME_PASSWORD is required"),
  NAVIDROME_CLIENT_NAME: z.string().default("music-api"),
  NAVIDROME_API_VERSION: z.string().default("1.16.1"),

  MUSICBRAINZ_URL: z
    .string()
    .url()
    .default("https://musicbrainz.org/ws/2"),
  MUSICBRAINZ_USER_AGENT: z
    .string()
    .default("MeepMusicAutomation/1.0 (contact@example.com)"),

  DATABASE_PATH: z.string().default("/app/data/music-api.sqlite"),

  SEARCH_COLLECTION_MS: z.coerce.number().default(7000),
  SEARCH_RESULT_TTL_MINUTES: z.coerce.number().default(60),

  CATALOG_CACHE_HOURS: z.coerce.number().default(24),
  ARTIST_CACHE_DAYS: z.coerce.number().default(30),
  LIBRARY_CACHE_MINUTES: z.coerce.number().default(10),

  DEFAULT_MAX_CANDIDATES: z.coerce.number().default(10),
  MAX_SEARCH_CANDIDATES: z.coerce.number().default(20),

  MAX_CONCURRENT_SOULSEEK_SEARCHES: z.coerce.number().default(2),
  MAX_CONCURRENT_NAVIDROME_REQUESTS: z.coerce.number().default(5),

  LASTFM_API_KEY: z.string().min(1, "LASTFM_API_KEY is required"),
  LASTFM_USERNAME: z.string().min(1, "LASTFM_USERNAME is required"),

  LISTENBRAINZ_USERNAME: z.string().default(""),
  LISTENBRAINZ_TOKEN: z.string().default(""),

  RECOMMENDATION_SEEDS_PER_WINDOW: z.coerce.number().default(25),
  RECOMMENDATION_MAX_SEEDS: z.coerce.number().default(60),
  RECOMMENDATION_SIMILAR_PER_SEED: z.coerce.number().default(20),
  RECOMMENDATION_DEFAULT_LIMIT: z.coerce.number().default(50),
  RECOMMENDATION_NEW_RELEASE_DAYS: z.coerce.number().default(180),

  RECOMMENDATION_WEIGHT_EXTERNAL: z.coerce.number().default(0.35),
  RECOMMENDATION_WEIGHT_SEED_AFFINITY: z.coerce.number().default(0.25),
  RECOMMENDATION_WEIGHT_CONSENSUS: z.coerce.number().default(0.15),
  RECOMMENDATION_WEIGHT_RECENCY: z.coerce.number().default(0.10),
  RECOMMENDATION_WEIGHT_NOVELTY: z.coerce.number().default(0.10),
  RECOMMENDATION_WEIGHT_POPULARITY: z.coerce.number().default(0.05),

  RECOMMENDATION_MAX_PER_SEED: z.coerce.number().default(3),
  RECOMMENDATION_MAX_RELEASES_PER_ARTIST: z.coerce.number().default(2),
  RECOMMENDATION_WILDCARD_RATIO: z.coerce.number().default(0.10),
  RECOMMENDATION_REPEAT_COOLDOWN_DAYS: z.coerce.number().default(30),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Configuration validation failed:\n${issues}`);
    process.exit(1);
  }

  _config = result.data;

  const weightSum =
    _config.RECOMMENDATION_WEIGHT_EXTERNAL +
    _config.RECOMMENDATION_WEIGHT_SEED_AFFINITY +
    _config.RECOMMENDATION_WEIGHT_CONSENSUS +
    _config.RECOMMENDATION_WEIGHT_RECENCY +
    _config.RECOMMENDATION_WEIGHT_NOVELTY +
    _config.RECOMMENDATION_WEIGHT_POPULARITY;

  if (Math.abs(weightSum - 1.0) > 0.01) {
    console.error(
      `Recommendation score weights must sum to ~1.0, got ${weightSum.toFixed(4)}`
    );
    process.exit(1);
  }

  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}
