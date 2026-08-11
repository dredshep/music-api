import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { runGeneration, type GenerateOptions } from "../domain/recommendations";
import {
  getRecommendation,
  listRecommendations,
  getGeneration,
  listGenerations,
  addFeedback,
  getFeedbackForRecommendation,
  type RecommendationType,
  type RecommendationReason,
  type RecommendationSource,
  type FeedbackValue,
} from "../db/repositories/recommendations";
import type { AppVariables } from "../middleware/logging";

export const recommendationRoutes = new Hono<{ Variables: AppVariables }>();

const generateSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  sources: z.array(z.enum(["lastfm_similar", "listenbrainz_cf", "musicbrainz_new_release"])).optional(),
  include_uncertain: z.boolean().optional(),
}).optional();

const feedbackSchema = z.object({
  feedback: z.enum(["love", "interested", "meh", "dislike", "already_know"]),
});

// POST /v1/recommendations/generate
recommendationRoutes.post("/recommendations/generate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = generateSchema.parse(body);

  const options: GenerateOptions = {
    limit: parsed?.limit,
    sources: parsed?.sources as RecommendationSource[] | undefined,
    includeUncertain: parsed?.include_uncertain,
  };

  const result = await runGeneration(options);

  return c.json({
    generation_id: result.generationId,
    status: result.status,
    selected: result.selected,
    stats: result.stats,
  });
});

// GET /v1/recommendations
recommendationRoutes.get("/recommendations", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const type = c.req.query("type") as RecommendationType | undefined;
  const reason = c.req.query("reason") as RecommendationReason | undefined;
  const minScore = c.req.query("min_score") ? parseFloat(c.req.query("min_score")!) : undefined;
  const includeOwned = c.req.query("include_owned") === "true";
  const includeUncertain = c.req.query("include_uncertain") === "true";

  const recs = listRecommendations({
    type: type && ["artist", "release_group"].includes(type) ? type : undefined,
    reason,
    minScore,
    includeOwned,
    includeUncertain,
    limit,
  });

  const results = recs.map((rec) => {
    const breakdown = rec.score_breakdown_json ? JSON.parse(rec.score_breakdown_json) : null;

    return {
      id: rec.id,
      type: rec.type,
      artist: rec.artist_name,
      artist_mbid: rec.artist_mbid,
      release: rec.release_title,
      release_group_mbid: rec.release_group_mbid,
      score: rec.score,
      score_breakdown: breakdown,
      primary_reason: rec.primary_reason,
      ownership: {
        state: rec.ownership_state,
      },
      first_release_date: rec.first_release_date,
      first_seen_at: rec.first_seen_at,
      last_recommended_at: rec.last_recommended_at,
      times_recommended: rec.times_recommended,
      feedback: rec.feedback,
    };
  });

  return c.json({ recommendations: results, count: results.length });
});

// GET /v1/recommendations/generations (must be before :id)
recommendationRoutes.get("/recommendations/generations", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const status = c.req.query("status") as "running" | "completed" | "partial" | "failed" | undefined;

  const gens = listGenerations({ status, limit });

  return c.json({
    generations: gens.map((gen) => ({
      id: gen.id,
      status: gen.status,
      started_at: gen.started_at,
      completed_at: gen.completed_at,
      seed_count: gen.seed_count,
      selected_count: gen.selected_count,
      error_count: gen.error_count,
      stats: gen.stats_json ? JSON.parse(gen.stats_json) : null,
    })),
  });
});

// GET /v1/recommendations/generations/:id
recommendationRoutes.get("/recommendations/generations/:id", (c) => {
  const id = c.req.param("id");
  const gen = getGeneration(id);

  if (!gen) {
    throw new AppError("GENERATION_NOT_FOUND", "Generation not found", 404);
  }

  return c.json({
    id: gen.id,
    status: gen.status,
    started_at: gen.started_at,
    completed_at: gen.completed_at,
    seed_count: gen.seed_count,
    observation_count: gen.observation_count,
    canonical_candidate_count: gen.canonical_candidate_count,
    eligible_candidate_count: gen.eligible_candidate_count,
    selected_count: gen.selected_count,
    error_count: gen.error_count,
    config: gen.config_json ? JSON.parse(gen.config_json) : null,
    stats: gen.stats_json ? JSON.parse(gen.stats_json) : null,
    errors: gen.error_json ? JSON.parse(gen.error_json) : null,
  });
});

// GET /v1/recommendations/:id (after /generations to avoid conflict)
recommendationRoutes.get("/recommendations/:id", (c) => {
  const id = c.req.param("id");
  const rec = getRecommendation(id);

  if (!rec) {
    throw new AppError("RECOMMENDATION_NOT_FOUND", "Recommendation not found", 404);
  }

  const breakdown = rec.score_breakdown_json ? JSON.parse(rec.score_breakdown_json) : null;
  const feedbackHistory = getFeedbackForRecommendation(id);

  return c.json({
    id: rec.id,
    type: rec.type,
    artist: rec.artist_name,
    artist_mbid: rec.artist_mbid,
    release: rec.release_title,
    release_group_mbid: rec.release_group_mbid,
    score: rec.score,
    score_breakdown: breakdown,
    primary_reason: rec.primary_reason,
    ownership: {
      state: rec.ownership_state,
    },
    first_release_date: rec.first_release_date,
    first_seen_at: rec.first_seen_at,
    last_seen_at: rec.last_seen_at,
    last_recommended_at: rec.last_recommended_at,
    times_seen: rec.times_seen,
    times_recommended: rec.times_recommended,
    status: rec.status,
    feedback: rec.feedback,
    feedback_history: feedbackHistory.map((f) => ({
      feedback: f.feedback,
      created_at: f.created_at,
    })),
  });
});

// POST /v1/recommendations/:id/feedback
recommendationRoutes.post("/recommendations/:id/feedback", async (c) => {
  const id = c.req.param("id");
  const rec = getRecommendation(id);

  if (!rec) {
    throw new AppError("RECOMMENDATION_NOT_FOUND", "Recommendation not found", 404);
  }

  const body = await c.req.json();
  const { feedback } = feedbackSchema.parse(body);

  addFeedback(id, feedback as FeedbackValue);

  const updated = getRecommendation(id)!;
  return c.json({
    id: updated.id,
    feedback: updated.feedback,
    status: updated.status,
    message: `Feedback '${feedback}' recorded`,
  });
});
