import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { resetConfigForTests } from "../src/config";
import { initDatabase } from "../src/db/database";
import { createJob, listJobs } from "../src/db/repositories/jobs";

const dbPath = `/tmp/music-api-jobs-test-${Date.now()}.sqlite`;

beforeAll(() => {
  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = "test-test-test-test-test-test-test-test";
  process.env.NAVIDROME_USERNAME = "test";
  process.env.NAVIDROME_PASSWORD = "test";
  process.env.LASTFM_API_KEY = "test";
  process.env.LASTFM_USERNAME = "test";
  resetConfigForTests();
  initDatabase();
});

afterAll(() => {
  try {
    unlinkSync(dbPath);
  } catch {}
});

describe("listJobs identity filters", () => {
  test("filters by artist and release substring", () => {
    createJob({
      candidateId: "cand_test1",
      artist: "Fcukers",
      releaseTitle: "Fcukers",
      peer: "peer1",
      remoteDirectory: "/music/Fcukers",
    });
    createJob({
      candidateId: "cand_test2",
      artist: "Massive Attack",
      releaseTitle: "Mezzanine",
      peer: "peer2",
      remoteDirectory: "/music/Mezzanine",
    });

    const fcukers = listJobs({ status: "all", artist: "fcuker", limit: 10 });
    expect(fcukers.length).toBe(1);
    expect(fcukers[0]?.artist).toBe("Fcukers");

    const byRelease = listJobs({ status: "all", release: "mezz", limit: 10 });
    expect(byRelease.length).toBe(1);
    expect(byRelease[0]?.release_title).toBe("Mezzanine");

    const byQ = listJobs({ status: "all", q: "fcuk", limit: 10 });
    expect(byQ.length).toBe(1);
  });
});
