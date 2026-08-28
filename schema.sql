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

CREATE INDEX IF NOT EXISTS idx_questions_ministry ON questions(ministry_id);
CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_exam ON results(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_user ON results(user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
