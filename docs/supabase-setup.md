# Supabase setup

The app uses two Supabase projects on the free plan (which allows two active projects):

| Project | Used for |
| --- | --- |
| `qobo-dev` | Local development, hosted security tests, eval runs. Test users are created and deleted here. |
| `qobo-prod` | The deployed demo only. |

Both receive the same migrations from `supabase/migrations/`.

## 1. Create each project

1. In [supabase.com/dashboard](https://supabase.com/dashboard), click **New project**. Pick region **South Asia (Mumbai)** and save the database password in a password manager.
2. **Project Settings → JWT Keys:** make sure the project signs tokens with an **asymmetric key** (ECC/RSA). If it still uses the legacy HS256 secret, create a standby asymmetric key and rotate to it. The API's `getClaims()` verifies tokens locally only with asymmetric keys.
3. **Authentication → Sign In / Providers → Email:**
   - Enable email sign-ups
   - **Turn off "Confirm email".** The built-in email service only sends to your Supabase team members, at most 2 emails per hour.
   - Minimum password length: **8**; password requirements: **letters and digits**
4. **Authentication → Sign In / Providers:** make sure **anonymous sign-ins are off**.
5. **Project Settings → API Keys:** copy the **publishable** key (`sb_publishable_…`) and create or copy a **secret** key (`sb_secret_…`). Do not use the legacy `anon` / `service_role` keys, which Supabase is deprecating by the end of 2026.

## 2. Apply migrations

From the repository root, once per project:

```bash
npx supabase@2.117.0 login
npx supabase@2.117.0 link --project-ref <project-ref>
npx supabase@2.117.0 db push
```

`<project-ref>` is the subdomain in the project URL (`https://<project-ref>.supabase.co`). `db push` asks for the database password.

## 3. Verify security on the dev project

```bash
cd api
cp .env.test.example .env.test   # fill in qobo-dev URL + keys
npm run test:hosted
```

The suite signs in two throwaway users through the public Data API, the same way a browser would, and checks the following. It deletes the users afterwards.

- Users can read only their own conversations and messages.
- Users cannot insert or update messages (no forged assistant replies) or insert conversations.
- Users cannot call backend-only functions or reach the `private` schema.
- A user can delete only their own conversations, and messages are removed with them.
- Anonymous requests get nothing.
- Access tokens use an asymmetric signing algorithm, and `getClaims()` verifies them.
- The backend can pass an embedding array to `match_kb_chunks`.

## Security model summary

- `authenticated` has **SELECT** on its own `conversations` and `messages` rows and **DELETE** on its own `conversations`. It has no INSERT or UPDATE, and no function EXECUTE.
- The backend writes through `append_exchange` / `consume_user_quota` / `consume_global_quota` and reads the knowledge base through `match_kb_chunks` / `get_kb_meta`. All of these are executable **only** by `service_role` (the secret key).
- Knowledge-base and usage tables live in the `private` schema, which the Data API does not expose.
- Every table explicitly revokes Supabase's default grants.

Local tests (`npm test`) apply the same migrations to an in-process Postgres (PGlite) that emulates Supabase's roles and default privileges. The hosted suite is the final proof.
