# Teaching pages — setup & sharing guide

This folder is a self-contained "course website + admin panel". Everything that is
specific to *you* (Supabase keys, Google sign-in, name, links, colours) lives in a
single file — **`teaching/js/config.js`**. Every other file is identical across
deployments, so once it's set up you can pull the original author's updates without
redoing your configuration.

There are two audiences below:

- **[Running your own copy](#running-your-own-copy)** — a colleague setting up their instance.
- **[Before you share it](#before-you-share-it)** — the original author preparing the repo for others.

---

## Running your own copy

You'll need: a GitHub account, a (free) Supabase account, and a Google account.
Budget ~20–30 minutes the first time.

### 1. Get the code

1. **Fork** the original repository on GitHub (top-right → *Fork*).
2. In your fork: **Settings → Pages →** set the source to the `main` branch. Your site
   will publish at `https://<your-username>.github.io/` (user site) or
   `https://<your-username>.github.io/<repo>/` (project site). Note this URL — you'll
   need it in steps 4 and 5.

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a name and a
   database password; wait for it to provision.
2. **Project Settings → API** and copy two values for later:
   - **Project URL** → goes into `supabaseUrl`
   - **anon / public key** → goes into `supabaseAnonKey`

   (Both are safe to commit — they're meant to be public. Your data is protected by
   Row-Level Security, set up by the schema in the next step, not by hiding the key.)

### 3. Create the database schema

In the Supabase dashboard: **SQL Editor → New query**, paste the contents of
[`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates the
`course_rows` and `admins` tables plus the Row-Level Security policies (public read,
admin-only write).

> Before running it, open `supabase/schema.sql` and set the **bootstrap email** at the
> bottom to your own Google account — that's the row that lets you into the admin panel.
> The file's header notes a couple of things to double-check (e.g. whether admins are
> keyed by email vs. user id).

### 4. Deploy the timetable proxy (Edge Function)

The public timetable is fetched through a small serverless function so the browser
never talks to the university site directly.

The `supabase/` folder lives inside `teaching/`, so **run the CLI commands below from
inside the `teaching/` folder** (that's where the CLI looks for `supabase/`).

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and sign in:
   `supabase login`.
2. Link your project: `supabase link --project-ref <your-project-ref>`
   (the ref is the `xxxx` in your Project URL `https://xxxx.supabase.co`).
3. **Edit [`supabase/functions/eis-timetable/index.ts`](supabase/functions/eis-timetable/index.ts)**:
   in the `ALLOWED_ORIGINS` set near the top, replace the existing domains with **your
   site's origin(s)** (e.g. `https://<your-username>.github.io`). Only listed origins
   get a browser-readable response.
4. Deploy it: `supabase functions deploy eis-timetable`
   This function is intentionally public (no JWT) — it's a read-only proxy.

### 5. Set up Google sign-in (admin login only)

The admin panel authenticates you with Google. The public course page needs none of this.

1. In the **Supabase dashboard → Authentication → Providers → Google**, enable it.
   (You'll paste a Client ID/secret here in a moment.)
2. In [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services →
   Credentials → Create credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins**: add your site origin (e.g.
     `https://<your-username>.github.io`) and `http://localhost:...` if you test locally.
   - **Authorized redirect URIs**: add the callback Supabase shows you on the Google
     provider screen (`https://<your-project-ref>.supabase.co/auth/v1/callback`).
3. Copy the **Client ID** → goes into `googleClientId`. Paste the Client ID **and**
   secret back into the Supabase Google provider screen from step 5.1.
4. In the **Supabase dashboard → Authentication → URL Configuration** — this is what
   decides where you get sent *back* to after Google signs you in:
   - **Site URL**: your site's root, e.g. `https://<your-username>.github.io/`
     (or `https://<your-domain>/` if you point a custom domain at Pages). Wildcards are
     not accepted here.
   - **Redirect URLs**: one entry per origin you actually open the admin panel from —

     ```
     https://<your-username>.github.io/teaching/admin/
     https://<your-domain>/teaching/admin/       ← only if you use a custom domain
     http://localhost:5500/teaching/admin/       ← only if you test locally (5500 = VS Code Live Server)
     ```

     On a *project* site the path is `/<repo>/teaching/admin/`. These are matched
     exactly, so if you ever open the panel as `…/teaching/admin/index.html` rather than
     `…/teaching/admin/`, list that too — or use a wildcard entry
     (`https://<your-username>.github.io/teaching/admin/**`) to cover both.

   **Don't skip this step.** The admin panel asks to be returned to the page you signed
   in from, but Supabase only honours that if the URL is on the Redirect URLs list.
   Otherwise it silently ignores the request and falls back to the **Site URL** — which
   on a fresh project defaults to `http://localhost:3000`. Getting dumped on
   `localhost:3000` after clicking "Sign in" always means this list is missing the URL
   you started from.
5. (First sign-in only) The admin gate is owner-only. After you sign in once, make your
   account the owner per the note in `supabase/schema.sql` (or however the RLS policy is
   keyed) so only you can edit.

### 6. Fill in `config.js`

Open **`teaching/js/config.js`** and set:

```js
supabaseUrl:     'https://<your-project-ref>.supabase.co',
supabaseAnonKey: '<your anon key>',
googleClientId:  '<your-client-id>.apps.googleusercontent.com',
catCompanion:    true,          // set false to hide the cat companion
owner: {
  name:      'Your Name',
  email:     'you@example.edu',
  cvUrl:     'https://…',        // footer CV icon
  homeUrl:   '/',                // footer home icon target
  faviconUrl:'/favicon.png',     // browser-tab icon (drop your own favicon.png at the site root)
  startYear: 2025,               // copyright range start
},
theme: {                        // default palette (a course's own colours still override)
  primary: '#3949ab', primaryDark: '#1a237e', secondary: '#ffa726',
  tertiary: '#2196F3', accent: '#9c27b0', success: '#43a047',
},
```

### 7. Commit and go live

Commit `config.js` (yes, commit it — GitHub Pages only serves committed files, and these
values are public-safe) and push. Your site is live at your Pages URL; the admin panel is
at `…/teaching/admin/`.

---

## Getting the author's updates later

Because **only `config.js` differs** from the original, you can pull improvements cleanly:

```sh
git remote add upstream https://github.com/<original-author>/<repo>.git   # one time
git fetch upstream
git merge upstream/main            # or use GitHub's "Sync fork" button
```

The only file that can ever conflict is `config.js` (you edited it, they might have too).
If it conflicts, keep yours: `git checkout --ours teaching/js/config.js`. Everything
else — scripts, styles, markup — updates automatically.

---

## Before you share it

*(For the original author — do this once so colleagues get a smooth setup.)*

`supabase/schema.sql` is committed, but it was **reconstructed from the app code**, not
exported from a live database — the table columns are exact, but the Row-Level Security
and the admins-table key are best-effort (see the file's header). Before relying on it,
confirm it matches your real project. If you have the Supabase CLI, the authoritative
version is one command:

```sh
supabase link --project-ref <your-project-ref>
supabase db dump --schema public > supabase/schema.sql
```

Diff that against the reconstructed file, keep whichever is correct, and make sure the
write policy is keyed the way you actually gate editing. Commit it, and the guide above
works end to end.
