# Enable accounts, cloud sync, and secure sharing

Termwise works without a backend for local budgeting, confirmed CSV import, and Reset Week. The account, household collaboration, and support-sharing features use Supabase Auth and PostgreSQL row-level security.

The integration is implemented and tested locally. A hosted Supabase project must be configured before these features can operate online.

## 1. Create the backend

1. Sign in to [Supabase](https://supabase.com/dashboard) and create a project.
2. Choose a database password and retain it privately. The website never needs that password.
3. Open the project's **SQL Editor**.
4. Paste and run the complete contents of [schema.sql](../supabase/schema.sql).

Run this schema **once in a new project**. It creates the application's tables, access policies, and checked database functions inside a transaction. It is not a destructive reset or a rerunnable migration for an existing database. If an existing project already has Termwise tables, apply a reviewed migration instead.

## 2. Configure authentication

Enable email/password sign-in and **keep email confirmation enabled**. Household invitations and support access depend on the signed-in account proving ownership of the chosen email address.

In the project's Auth URL configuration:

- Set **Site URL** to your production origin, such as `https://your-project.vercel.app`.
- Add your production origin and callback route, such as `https://your-project.vercel.app/#account`, to the allowed redirect URLs.
- For local development, add `http://localhost:5173` and `http://localhost:5173/#account`.

Account confirmation and password recovery use Supabase's email service. Configure your own SMTP provider for reliable delivery before offering accounts broadly. Test a real confirmation and password-reset email against your hosted project; simulated browser tests do not exercise email delivery.

References: [password authentication](https://supabase.com/docs/guides/auth/passwords), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## 3. Add public connection settings

Find the **Project URL** and **publishable key** in the Supabase project dashboard. A legacy `anon` key is also accepted.

For local development, copy [.env.example](../.env.example) to `.env` in the repository root and fill in:

```dotenv
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Never use a `service_role` key, an `sb_secret_` key, a database password, or an administrative token. The build explicitly rejects private key types. The publishable key is intentionally included in browser assets; database policies enforce access.

Reference: [Supabase API keys](https://supabase.com/docs/guides/api/api-keys).

Restart the local server after changing these settings:

```sh
npm ci
npm run dev
```

## 4. Configure Vercel

Open the Termwise project's **Settings > Environment Variables** and add both variables above for the environments you intend to enable. Redeploy after saving them: the build generates the public configuration, so changing environment variables alone does not update an existing deployment.

Keep the existing build settings:

| Setting | Value |
| --- | --- |
| Framework | Other |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node.js | 22 or later |

Netlify can use the same environment variables and checked-in build settings.

## 5. Verify two real accounts

Use two separate browser profiles or a normal and private window. Do not use two tabs sharing the same browser session to represent separate people.

1. Create accounts A and B using two email addresses you control; confirm both emails.
2. Sign in as A and enter a budget and private transaction. In B, confirm that A's private record is absent.
3. As A, create a household and an invitation addressed to B. Copy the link manually; the app does not automatically send invitation emails.
4. As B, open the invitation link and accept it. A link addressed to B must fail for a different email.
5. Add a household bill and reconcile its shares. B can settle B's own share. The household must not display private transactions.
6. As A, prepare a support snapshot. Select categories, dates, B's email, and an access period. Review the totals and confirm consent.
7. Open its link as B. Only category totals and snapshot metadata should appear; descriptions and notes must be absent.
8. Revoke the snapshot as A, then refresh B's view. It must be unavailable. Expired snapshots must also be unavailable.
9. Change the same budget from two devices. A stale save must report a conflict rather than silently replace newer data.
10. Verify password recovery using a real email and confirm that signing out returns to the separate guest plan.

## Storage and access model

- `budget_accounts`: one private JSON budget per authenticated owner, with a revision number for optimistic concurrency.
- `households` and `household_members`: membership controls reads of the household ledger. Only the owner creates invitations.
- `household_invites`: direct reads are disabled. Acceptance requires the invited email, an unexpired link, and an authenticated account. Links are single-use and expire after seven days.
- `household_bills`: only selected household members receive shares. A participant can settle only their own share. Settled bills are retained as payment history.
- `support_snapshots`: server-generated category totals, a named recipient, creation and expiry timestamps, and revocation. Recipients must authenticate with the chosen email. Anonymous access is denied.
- Direct browser writes to tables are disabled. Checked functions enforce ownership, membership, share totals, snapshot scope, and version checks.

Guest data is never uploaded just because someone signs in. **Copy device plan to account** is a separate, confirmed operation. Guest and account caches use separate keys. Normal sign-out clears the synced account cache. If you explicitly sign out with unsynced changes, that account's recovery copy remains in this browser and is restored or flagged for conflict review on the next sign-in.

Sync errors retain local changes and show a status warning. Export transactions before discarding unsynced changes. Reloading a cloud copy explicitly replaces the local account plan; it is never an automatic conflict merge.

Shared views refresh every 30 seconds while visible and offer manual refresh. The database denies a revoked or expired snapshot on every subsequent request. Revocation cannot erase information a recipient has already viewed or copied. Snapshots are dated copies and do not silently change with later transactions.

Reference: [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Local verification

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

Database tests execute the actual schema in PGlite with separate authenticated roles. Browser integration tests run the UI against that local database through a simulated Supabase API. They cover account isolation, cloud persistence, invitations, share settlement, consent, and revocation. Hosted credentials, network delivery, email confirmation, and production infrastructure still require the live checks above.
