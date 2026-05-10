-- ========================================
-- REVISEFLOW RLS ENFORCEMENT MIGRATION
-- Run this in Supabase SQL Editor
-- ========================================
-- UPDATED: Only includes existing tables
-- ========================================

-- Drop existing policies first (prevents "already exists" errors)
DROP POLICY IF EXISTS "Users can view own data" ON user_data;
DROP POLICY IF EXISTS "Users can insert own data" ON user_data;
DROP POLICY IF EXISTS "Users can update own data" ON user_data;
DROP POLICY IF EXISTS "Users can delete own data" ON user_data;

DROP POLICY IF EXISTS "Users can view own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can insert own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON user_settings;
DROP POLICY IF EXISTS "Users can delete own settings" ON user_settings;

DROP POLICY IF EXISTS "Users can view own streak logs" ON streak_log;
DROP POLICY IF EXISTS "Users can insert own streak logs" ON streak_log;
DROP POLICY IF EXISTS "Users can update own streak logs" ON streak_log;
DROP POLICY IF EXISTS "Users can delete own streak logs" ON streak_log;

DROP POLICY IF EXISTS "Users can view own tasks" ON user_tasks;
DROP POLICY IF EXISTS "Users can insert own tasks" ON user_tasks;
DROP POLICY IF EXISTS "Users can update own tasks" ON user_tasks;
DROP POLICY IF EXISTS "Users can delete own tasks" ON user_tasks;

-- Enable Row Level Security on existing tables
ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tasks ENABLE ROW LEVEL SECURITY;

-- ========================================
-- USER_DATA TABLE POLICIES
-- ========================================

-- Allow users to SELECT only their own data
CREATE POLICY "Users can view own data"
ON user_data
FOR SELECT
USING (auth.uid() = user_id);

-- Allow users to INSERT only their own data
CREATE POLICY "Users can insert own data"
ON user_data
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Allow users to UPDATE only their own data
CREATE POLICY "Users can update own data"
ON user_data
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Allow users to DELETE only their own data
CREATE POLICY "Users can delete own data"
ON user_data
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- USER_SETTINGS TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own settings"
ON user_settings
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings"
ON user_settings
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
ON user_settings
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own settings"
ON user_settings
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- STREAK_LOG TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own streak logs"
ON streak_log
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own streak logs"
ON streak_log
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own streak logs"
ON streak_log
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own streak logs"
ON streak_log
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- USER_TASKS TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own tasks"
ON user_tasks
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks"
ON user_tasks
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
ON user_tasks
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
ON user_tasks
FOR DELETE
USING (auth.uid() = user_id);


-- ========================================
-- VERIFICATION QUERIES
-- ========================================

-- Run these to verify RLS is enabled (should return 'true' for all):
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('user_data', 'user_settings', 'streak_log', 'user_tasks')
ORDER BY tablename;

-- View all policies (should show 4 policies per table = 16 total):
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('user_data', 'user_settings', 'streak_log', 'user_tasks')
ORDER BY tablename, policyname;
