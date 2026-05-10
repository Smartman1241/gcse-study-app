# ReviseFlow Security Documentation

## Last Updated
2026-05-10

## Row Level Security (RLS) Status

All user-facing database tables are protected by Row Level Security policies that enforce the following rule:

**Users can only access rows where `user_id = auth.uid()`**

This prevents users from reading, modifying, or deleting other users' data.

---

## Protected Tables

### ✅ RLS Enabled (Current Schema)

| Table Name | Description | User ID Column | Policies |
|------------|-------------|----------------|----------|
| `user_data` | User's application state (tasks, study sets, timer) | `user_id` | SELECT, INSERT, UPDATE, DELETE |
| `user_settings` | User preferences (theme, tier, username) | `user_id` | SELECT, INSERT, UPDATE, DELETE |
| `streak_log` | Daily streak activity tracking | `user_id` | SELECT, INSERT, UPDATE, DELETE |
| `user_tasks` | Supabase-synced tasks | `user_id` | SELECT, INSERT, UPDATE, DELETE |

### 🔜 Future Tables (Not Yet Implemented)

These tables are referenced in API code but not yet created in the database:

| Table Name | Description | Status |
|------------|-------------|--------|
| `ai_usage_monthly` | AI token usage tracking | Planned |
| `ai_uploads_monthly` | Document upload quota tracking | Planned |
| `ai_throttle_minute` | Rate limiting per user | Planned |
| `ai_conversations` | AI chat history | Planned |
| `ai_weak_topics` | Subject weakness tracking | Planned |

**Note**: When these tables are created, apply the same RLS pattern shown in the existing policies.

### ⚠️ Public Tables (No User-Specific Data)

| Table Name | Description | RLS Status | Notes |
|------------|-------------|------------|-------|
| `past_papers` | AQA exam papers catalog | Not Required | Read-only, no user data |

---

## Policy Details

### Standard Policy Pattern

All protected tables use this policy structure:

```sql
-- SELECT: View own data
CREATE POLICY "Users can view own [resource]"
ON [table_name]
FOR SELECT
USING (auth.uid() = user_id);

-- INSERT: Create own data
CREATE POLICY "Users can insert own [resource]"
ON [table_name]
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- UPDATE: Modify own data
CREATE POLICY "Users can update own [resource]"
ON [table_name]
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- DELETE: Remove own data
CREATE POLICY "Users can delete own [resource]"
ON [table_name]
FOR DELETE
USING (auth.uid() = user_id);
```

---

## Credential Management

### Centralized Configuration

All Supabase credentials are centralized in **`theme.js`** as `window.REVISEFLOW_CONFIG`:

```javascript
window.REVISEFLOW_CONFIG = {
  supabase: {
    url: "https://mgpwknnbhaljsscsvucm.supabase.co",
    anonKey: "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs"
  }
};
```

### Files Using Centralized Config

- `theme.js` (source)
- `auth-guard.js` (with fallback)
- `index.html`
- `auth.html`
- `pastpapers.html`
- `studysets.html`
- `subscriptions.html`
- `account.html`
- `flashcards.html`
- `editset.html`
- `tasks.html`

### Anon Key Security

The `anonKey` is a **public** key and is safe to expose in frontend code. It is protected by:

1. **RLS Policies**: Enforce user isolation at the database level
2. **Server-Side Validation**: API routes use `SUPABASE_SERVICE_ROLE_KEY` for privileged operations
3. **Rate Limiting**: AI endpoints throttle requests per user

⚠️ **Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code!**

---

## XSS Protection

### HTML Sanitization

All user-generated content is sanitized using the `escapeHtml()` function before rendering:

```javascript
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
```

### Protected Fields

- Task names
- Study set titles
- Flashcard content
- AI chat messages
- User-provided text in dashboards

### Usage Example

```javascript
// SAFE: Escapes HTML entities
taskElement.innerHTML = `<div>${escapeHtml(task.name)}</div>`;

// SAFER: Use textContent for plain text
taskElement.textContent = task.name;
```

---

## Validation Checklist

Before deploying to production, verify:

- [ ] RLS is enabled on all user tables (`SELECT rowsecurity FROM pg_tables WHERE tablename='user_data';` → `true`)
- [ ] Policies prevent cross-user access (test with two accounts)
- [ ] No hardcoded credentials outside `theme.js` and `auth-guard.js` fallback
- [ ] All user input is sanitized before rendering
- [ ] Service role key is never exposed in frontend code
- [ ] Rate limiting is active on AI endpoints
- [ ] HTTPS is enforced (check Vercel deployment settings)

---

## Testing RLS

### Test 1: User Isolation

1. Create two test accounts (User A, User B)
2. Log in as User A, create a task
3. Log in as User B, try to query User A's data via browser console:
   ```javascript
   const { data, error } = await supabaseClient
     .from('user_data')
     .select('*')
     .eq('user_id', '<User_A_UUID>');
   console.log(data); // Should be empty or null
   ```
4. Confirm `data` is empty (RLS blocks cross-user reads)

### Test 2: Insert Validation

1. Log in as User B
2. Try to insert data for User A:
   ```javascript
   const { error } = await supabaseClient
     .from('user_data')
     .insert({ user_id: '<User_A_UUID>', data: {} });
   console.log(error); // Should fail with RLS violation
   ```
3. Confirm insert fails with policy violation error

---

## Incident Response

If a security issue is discovered:

1. **Immediate**: Revoke compromised keys via Supabase dashboard
2. **Short-term**: Deploy hotfix with new keys via `theme.js`
3. **Long-term**: Audit RLS policies and run test suite
4. **Communication**: Notify affected users if data breach occurred

---

## Migration Script

To apply RLS policies, run **`rls-migration.sql`** in the Supabase SQL Editor.

This script:
- Enables RLS on all protected tables
- Creates policies for SELECT, INSERT, UPDATE, DELETE
- Includes verification queries

---

## Compliance Notes

- **GDPR**: Users can request data deletion (implement via account settings)
- **COPPA**: App is intended for students 13+ with parental consent
- **Data Retention**: User data is retained until account deletion
- **Third Parties**: OpenAI, Stripe, Google AdSense (see Privacy Policy)

---

## Contact

For security concerns, email: **security@reviseflow.co.uk**

For general support: **contact@reviseflow.co.uk**
