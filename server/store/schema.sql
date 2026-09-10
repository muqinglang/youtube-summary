-- Two tiers, and the split is the whole cost model.
--
-- `artifacts` and `digests` carry no user_id on purpose: an outline of a video is the same outline
-- for everyone, so the first viewer pays for the model calls and everyone after reads a row. Only
-- `library` and `usage_jobs` are partitioned by account.

-- Identity comes from Google; this service never holds a password. The subject is the key
-- rather than the address, because a Google account can change its address and the person is
-- still the same person with the same library.
CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY,
  google_sub text NOT NULL UNIQUE,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  video_id text PRIMARY KEY,
  title    text NOT NULL DEFAULT '',
  author   text NOT NULL DEFAULT '',
  url      text NOT NULL DEFAULT '',
  duration double precision NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transcripts (
  video_id   text NOT NULL,
  track_id   text NOT NULL,
  language   text NOT NULL,
  source     text NOT NULL,
  coverage   text NOT NULL,
  cues       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, track_id)
);

-- Key already encodes task, language, model, prompt and a fingerprint of the subtitles, so a
-- changed transcript or a bumped PIPELINE_VERSION simply misses instead of serving stale work.
CREATE TABLE IF NOT EXISTS artifacts (
  key        text PRIMARY KEY,
  video_id   text NOT NULL,
  task       text NOT NULL,
  payload    jsonb NOT NULL,
  notice     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_video_task ON artifacts (video_id, task);

-- Per-fragment summaries. Shared across users and across the outline/guide/summarize tasks,
-- which read identical evidence for the same video and language.
CREATE TABLE IF NOT EXISTS digests (
  key        text PRIMARY KEY,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_jobs (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day     date NOT NULL,
  jobs    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS library (
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  video_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
