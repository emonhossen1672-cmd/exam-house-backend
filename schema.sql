-- Exam House database schema

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ministries (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  ministry_id INTEGER REFERENCES ministries(id) ON DELETE SET NULL,
  grade INTEGER,
  subject VARCHAR(30) NOT NULL, -- বাংলা / ইংরেজি / গণিত / সাধারণ জ্ঞান
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('A','B','C','D')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exams (
  id SERIAL PRIMARY KEY,
  title VARCHAR(250) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('live','model')),
  ministry_id INTEGER REFERENCES ministries(id) ON DELETE SET NULL,
  grade INTEGER,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  start_time TIMESTAMP, -- only used for live exams
  status VARCHAR(15) NOT NULL DEFAULT 'scheduled', -- scheduled / active / closed
  serial VARCHAR(30) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_questions (
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (exam_id, question_id)
);

CREATE TABLE IF NOT EXISTS results (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  participant_name VARCHAR(150) NOT NULL,
  participant_phone VARCHAR(30),
  answers JSONB NOT NULL, -- { "question_id": "A" }
  correct_count INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  score NUMERIC(6,2) NOT NULL,
  submitted_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE results ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS longest_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_date DATE;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS post_name VARCHAR(200);
ALTER TABLE exams ADD COLUMN IF NOT EXISTS subject VARCHAR(30);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT;
CREATE INDEX IF NOT EXISTS idx_exams_ministry_post ON exams(ministry_id, post_name, grade);
CREATE INDEX IF NOT EXISTS idx_exams_subject ON exams(subject);

-- Negative marking: per-wrong-answer deduction for an exam (e.g. 0.25). 0 = no negative marking.
ALTER TABLE exams ADD COLUMN IF NOT EXISTS negative_marks NUMERIC(4,2) NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN IF NOT EXISTS raw_marks NUMERIC(8,2);

-- Bookmarked questions, so logged-in users can save questions for later revision.
CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);

-- Question reports: students flag a question that looks wrong, so admins can review/fix it.
CREATE TABLE IF NOT EXISTS question_reports (
  id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  status VARCHAR(15) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_question_reports_status ON question_reports(status);

-- Daily quiz: a small auto-generated model test, regenerated once per calendar day.
ALTER TABLE exams ADD COLUMN IF NOT EXISTS is_daily BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS quiz_date DATE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_daily_date ON exams(quiz_date) WHERE is_daily = true;

CREATE INDEX IF NOT EXISTS idx_questions_ministry ON questions(ministry_id);
CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_exam ON results(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_user ON results(user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- ===== Feature: OTP-based phone verification =====
-- Verifies a phone number actually belongs to whoever registers, so the
-- users table can't be filled with fake numbers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(30) NOT NULL,
  code_hash TEXT NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register', -- register | reset_password
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_codes(phone, purpose, created_at DESC);

-- ===== Feature: Subject-wise practice mode =====
-- Marks exams that were auto-generated on-demand by practice mode (as opposed
-- to admin-created live/model exams), purely so the admin dashboard can tell
-- them apart later if needed. Practice exams otherwise behave like any other
-- 'model' exam (taking, submitting, subject-stats, streak all reuse the same code).
ALTER TABLE exams ADD COLUMN IF NOT EXISTS is_practice BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject);

-- ===== Fields the admin panel (admin_index.html) already had UI for, but the
-- backend was missing — adding them now so those buttons actually save data
-- instead of silently doing nothing (or worse, see the exams.routes.js fix
-- for the data-loss bug this uncovered in the old PUT /api/exams/:id).
ALTER TABLE exams ADD COLUMN IF NOT EXISTS topic VARCHAR(150);
ALTER TABLE exams ADD COLUMN IF NOT EXISTS application_deadline TIMESTAMP;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS exam_probable_date DATE;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS circular_url TEXT;
