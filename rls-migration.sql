-- ========================================
-- REVISEFLOW RLS ENFORCEMENT MIGRATION
-- Run this in Supabase SQL Editor
-- ========================================

-- Enable Row Level Security on all critical tables
ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_uploads_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_throttle_minute ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_weak_topics ENABLE ROW LEVEL SECURITY;

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
-- AI_USAGE_MONTHLY TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own AI usage"
ON ai_usage_monthly
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own AI usage"
ON ai_usage_monthly
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own AI usage"
ON ai_usage_monthly
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own AI usage"
ON ai_usage_monthly
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- AI_UPLOADS_MONTHLY TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own upload counts"
ON ai_uploads_monthly
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own upload counts"
ON ai_uploads_monthly
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own upload counts"
ON ai_uploads_monthly
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own upload counts"
ON ai_uploads_monthly
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- AI_THROTTLE_MINUTE TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own throttle data"
ON ai_throttle_minute
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own throttle data"
ON ai_throttle_minute
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own throttle data"
ON ai_throttle_minute
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own throttle data"
ON ai_throttle_minute
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- AI_CONVERSATIONS TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own conversations"
ON ai_conversations
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conversations"
ON ai_conversations
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own conversations"
ON ai_conversations
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own conversations"
ON ai_conversations
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- AI_WEAK_TOPICS TABLE POLICIES
-- ========================================

CREATE POLICY "Users can view own weak topics"
ON ai_weak_topics
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own weak topics"
ON ai_weak_topics
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own weak topics"
ON ai_weak_topics
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own weak topics"
ON ai_weak_topics
FOR DELETE
USING (auth.uid() = user_id);

-- ========================================
-- VERIFICATION QUERIES
-- ========================================

-- Run these to verify RLS is enabled:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('user_data', 'user_settings', 'streak_log', 'user_tasks', 'ai_usage_monthly');

-- View all policies:
-- SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
