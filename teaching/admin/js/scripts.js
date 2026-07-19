    const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
    const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;
    const { createClient } = supabase;
    // Synchronously pre-clear only genuinely unusable session blobs BEFORE createClient
    // (corrupt JSON, or missing the refresh_token needed to revive the session). An expired
    // access_token alone is normal — that's what the refresh_token is for — so it must NOT
    // be treated as a reason to delete the session, or the user gets signed out on every
    // visit once the (short-lived) access_token naturally expires.
    (function () {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
            try {
              const d = JSON.parse(localStorage.getItem(k));
              if (!d?.access_token || !d?.refresh_token)
                localStorage.removeItem(k);
            } catch { localStorage.removeItem(k); }
          }
        }
      } catch { }
    })();
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true }
    });

    const S = { course: null, isArchive: false, section: 'info', admin: null };
    const ROW_STORE = {};
    let _sessionHandled = false;
    let _overlayMD = false;

    // ── Unsaved-changes tracking ──
    // True once the user has staged any change in the current tab that isn't yet in the DB:
    // typing in a field, adding/deleting a row, or reordering. Reset when a section (re)loads
    // (loadSection) or a save succeeds. Used to prompt before switching tab/course.
    let _sectionDirty = false;
    function markDirty() { _sectionDirty = true; }
    // Typing in any field inside the section body counts as an edit. Delegated on document so it
    // keeps working after the section body is re-rendered. (Programmatic value/innerHTML changes
    // don't fire these events, so a fresh render never trips the flag on its own.)
    document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#section-body')) markDirty(); });
    document.addEventListener('change', e => { if (e.target.closest && e.target.closest('#section-body')) markDirty(); });
    // Leaving the whole page (refresh/close/navigate away) can only use the browser's own native
    // prompt — a custom dialog isn't allowed here. In-app course/tab switches use confirmLeaveIfDirty.
    window.addEventListener('beforeunload', e => {
      if (_sectionDirty || (typeof inlinePanelDirty === 'function' && inlinePanelDirty())) { e.preventDefault(); e.returnValue = ''; }
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // Config
    // ─────────────────────────────────────────────────────────────────────────────

    // Grading categories, in display order. `multi: true` categories can have any number of
    // numbered entries (Homework 1, Homework 2, ...) via the +/- UI in the Grading section.
    // `legacyKey` keeps reading older single, un-numbered keys (e.g. courses saved before this
    // category supported multiple entries) and folds them into the numbered list for display;
    // they're migrated to the new `${id}${n}_percentage` naming the next time settings are saved.
    const GRADING_CATEGORIES = [
      { id: 'hw', label: 'Homework', icon: 'fa-solid fa-book', multi: true },
      { id: 'project', label: 'Project', icon: 'fa-solid fa-diagram-project', multi: true, legacyKey: 'term_project_percentage' },
      { id: 'casestudy', label: 'Case Study', icon: 'fa-solid fa-magnifying-glass-chart', multi: true },
      { id: 'lab', label: 'Laboratory', icon: 'fa-solid fa-flask', multi: true },
      { id: 'quiz', label: 'Quiz', icon: 'fa-solid fa-question', multi: true },
      { id: 'midterm', label: 'Midterm', icon: 'fa-solid fa-pen-to-square', multi: true, legacyKey: 'midterm_percentage' },
      { id: 'final', label: 'Final', icon: 'fa-solid fa-graduation-cap', multi: false, key: 'final_percentage' },
      { id: 'attendance', label: 'Attendance', icon: 'fa-solid fa-calendar-check', multi: false, key: 'attendance_percentage' },
      { id: 'other', label: 'Other', icon: 'fa-solid fa-ellipsis', multi: true },
    ];
    const GRADING_LEGACY_KEYS = GRADING_CATEGORIES.filter(c => c.legacyKey).map(c => c.legacyKey);
    const GRADING_FIXED_KEYS = GRADING_CATEGORIES.filter(c => !c.multi).map(c => c.key);

    // The five slots of the theme_colours metadata, in order, and the site-wide defaults used
    // when a course sets none (must match teaching/index.html's fallback palette).
    const THEME_COLOR_NAMES = ['Primary', 'Secondary', 'Tertiary', 'Accent', 'Success'];
    // Default course palette offered in the colour picker — drawn from config.js so a
    // deployment's brand colours are what new courses (and "reset to default") land on.
    const _cfgTheme = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.theme) || {};
    const THEME_COLOR_DEFAULTS = [
        _cfgTheme.primary || '#3949ab',
        _cfgTheme.secondary || '#ffa726',
        _cfgTheme.tertiary || '#2196f3',
        _cfgTheme.accent || '#9c27b0',
        _cfgTheme.success || '#43a047',
    ];

    const FA_SEARCH_URL = 'https://fontawesome.com/search?ic=free-collection';

    // Existing numbered + legacy entries for a multi category, e.g. quiz1_percentage, quiz2_percentage.
    function gradingEntriesFor(cat, metaMap) {
      const re = new RegExp(`^${cat.id}(\\d+)_percentage$`);
      const nums = [];
      for (const k of Object.keys(metaMap)) {
        const m = k.match(re);
        if (m) nums.push(parseInt(m[1], 10));
      }
      nums.sort((a, b) => a - b);
      const entries = nums.map(n => ({ n, key: `${cat.id}${n}_percentage` }));
      if (cat.legacyKey && metaMap[cat.legacyKey]) {
        entries.push({ n: entries.length ? entries[entries.length - 1].n + 1 : 1, key: cat.legacyKey });
      }
      return entries;
    }

    const STATIC_META_KEYS = new Set([
      'code', 'title', 'year', 'semester', 'level', 'type', 'credits',
      'startdate', 'enddate', 'holidayweeks', 'holiday_startdate',
      'header_decoration', 'theme_colours',
      ...GRADING_FIXED_KEYS, ...GRADING_LEGACY_KEYS,
    ]);

    function isDynamicMetaKey(k) {
      return /^professor\d+(_link|_photo)?$/.test(k) ||
        /^timetable\d+_(name|id|height)$/.test(k) ||
        /^class\d+_id$/.test(k) ||
        /^(hw|project|casestudy|lab|quiz|midterm|other)\d+_percentage$/.test(k);
    }
    function isKnownMetaKey(k) { return STATIC_META_KEYS.has(k) || isDynamicMetaKey(k); }

    const TYPE_NAMES = {
      metadata: 'Metadata', button: 'Link Button', announcement: 'Announcement',
      module: 'Module', material: 'Material', project: 'Project',
      project_file: 'Project File', project_description: 'Project Description',
      project_group: 'Project Group', group_file: 'Group File',
      funfact: 'Fun Fact',
    };

    const FIELDS = {
      button: [
        { col: 'b', label: 'Button Label', fi: 'fa-solid fa-tag' },
        { col: 'c', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        { col: 'd', label: 'Link URL', link: true, fi: 'fa-solid fa-link' },
        {
          col: 'e', label: 'Button Color', fi: 'fa-solid fa-palette', sel: [
            { val: '', lbl: '—' }, { val: 'btn-blue', lbl: 'Blue' }, { val: 'btn-red', lbl: 'Red' },
            { val: 'btn-green', lbl: 'Green' }, { val: 'btn-orange', lbl: 'Orange' }, { val: 'btn-purple', lbl: 'Purple' }
          ]
        },
      ],
      announcement: [
        { col: 'e', label: 'Title', fi: 'fa-solid fa-heading' },
        { col: 'f', label: 'Body', ta: true, hint: 'HTML allowed', fi: 'fa-solid fa-align-left' },
        { col: 'd', label: 'Date / Time', dt: true, fi: 'fa-solid fa-calendar' },
        { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        {
          col: 'c', label: 'Accent Colour', fi: 'fa-solid fa-palette', sel: [
            { val: '', lbl: '—' },
            { val: 'var(--primary-color)', lbl: 'Primary (Blue)' },
            { val: 'var(--secondary-color)', lbl: 'Secondary (Orange)' },
            { val: 'var(--warning-color)', lbl: 'Warning (Amber)' },
            { val: 'var(--danger-color)', lbl: 'Danger (Red)' },
            { val: 'var(--success-color)', lbl: 'Success (Green)' }
          ]
        },
        { col: 'g', label: 'Action Links', hint: 'comma-separated URLs', fi: 'fa-solid fa-link' },
        { col: 'h', label: 'Action Icons', hint: 'comma-separated FA classes matching each link', fi: 'fa-solid fa-icons' },
        { col: 'i', label: 'Visibility', fi: 'fa-regular fa-eye', sel: [{ val: '', lbl: '—' }, { val: 'SHOW', lbl: 'Show' }, { val: 'HIDE', lbl: 'Hide' }] },
      ],
      module: [
        { col: 'b', label: 'Order', fi: 'fa-solid fa-list-ol' },
        { col: 'c', label: 'Module Title', fi: 'fa-solid fa-heading' },
        { col: 'd', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        { col: 'e', label: 'Subtitle', fi: 'fa-solid fa-align-left' },
        {
          col: 'f', label: 'Default State', fi: 'fa-solid fa-toggle-on', sel: [
            { val: 'SHOW', lbl: 'Expanded' }, { val: 'HIDE', lbl: 'Collapsed' }, { val: '', lbl: 'Hidden' }
          ]
        },
      ],
      material: [
        { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
        { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons', default: 'fa-regular fa-file-powerpoint' },
        { col: 'd', label: 'Subtitle / Description', fi: 'fa-solid fa-align-left' },
        { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
        { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
        { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
        { col: 'h', label: 'Autofill Link', autofill: true, fi: 'fa-solid fa-wand-magic-sparkles' },
      ],
      funfact: [
        { col: 'b', label: 'Fun Fact Text', ta: true, fi: 'fa-solid fa-lightbulb' },
      ],
      project: [
        { col: 'b', label: 'Order', fi: 'fa-solid fa-list-ol' },
        { col: 'c', label: 'Project Title', fi: 'fa-solid fa-heading' },
        { col: 'd', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        { col: 'e', label: 'Subtitle / Deadline', fi: 'fa-regular fa-clock' },
        {
          col: 'f', label: 'Default State', fi: 'fa-solid fa-toggle-on', sel: [
            { val: 'SHOW', lbl: 'Expanded' }, { val: 'HIDE', lbl: 'Collapsed' }, { val: '', lbl: 'Hidden' }
          ]
        },
      ],
      project_file: [
        { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
        { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        { col: 'd', label: 'Subtitle / Description', fi: 'fa-solid fa-align-left' },
        { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
        { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
        { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
        { col: 'h', label: 'Autofill Link', autofill: true, fi: 'fa-solid fa-wand-magic-sparkles' },
      ],
      project_description: [
        { col: 'b', label: 'Description (HTML)', ta: true, fi: 'fa-solid fa-code' },
      ],
      project_group: 'dynamic', // handled inline via buildInlineGroupFieldsHtml/commitInlineGroupFields
      group_file: [
        { col: 'c', label: 'Title', fi: 'fa-solid fa-heading' },
        { col: 'b', label: 'Icon', icon: true, fi: 'fa-solid fa-icons' },
        { col: 'd', label: 'Subtitle', fi: 'fa-solid fa-align-left' },
        { col: 'e', label: 'View Link', link: true, fi: 'fa-regular fa-eye' },
        { col: 'f', label: 'Download Link', link: true, fi: 'fa-solid fa-download' },
        { col: 'g', label: 'Open Link', link: true, fi: 'fa-solid fa-arrow-up-right-from-square' },
      ],
    };

    const SECTIONS = [
      { id: 'modules', label: 'Modules', icon: 'fa-solid fa-layer-group', types: ['module', 'material', 'funfact'], hier: true },
      { id: 'projects', label: 'Projects', icon: 'fa-solid fa-diagram-project', types: ['project', 'project_file', 'project_description', 'project_group', 'group_file'], proj: true },
      { id: 'announce', label: 'Announcements', icon: 'fa-solid fa-bullhorn', types: ['announcement'] },
      { id: 'links', label: 'Links', icon: 'fa-solid fa-link', types: ['button'] },
      { id: 'grading', label: 'Grading', icon: 'fa-solid fa-chart-simple', types: ['metadata'] },
      { id: 'info', label: 'Info', icon: 'fa-solid fa-circle-info', types: ['metadata'] },
    ];

    // Distinct row_index band per section so the public site's global row_index ordering never
    // interleaves rows from two different sections (see saveSectionChanges). Metadata (grading/
    // info) isn't here — it's parsed by key on the public side, so its order is irrelevant.
    const SECTION_ROW_BASE = { modules: 100000, projects: 200000, announce: 300000, links: 400000 };

    // ─────────────────────────────────────────────────────────────────────────────
    // Auth
    // ─────────────────────────────────────────────────────────────────────────────

    // Whether a session blob with both tokens is sitting in localStorage right now.
    // Used below to tell "definitely logged out" apart from "getSession() came back
    // empty because its internal token-refresh race hasn't resolved yet" — the latter
    // must NOT flash the login screen, since onAuthStateChange corrects it a moment later.
    function hasStoredSession() {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
            const d = JSON.parse(localStorage.getItem(k));
            if (d?.access_token && d?.refresh_token) return true;
          }
        }
      } catch { }
      return false;
    }

    // Sizes the ambiguous-session fallback (below) from the browser's own reported
    // connection quality instead of a blind guess. A token refresh is one network
    // round trip, so the wait only needs to be a small multiple of the actual RTT —
    // fast connections shouldn't be held to the same grace period as slow ones.
    // Falls back to a flat, moderate default on browsers without the Network
    // Information API (Safari, Firefox).
    function estimateAuthTimeoutMs() {
      if (navigator.onLine === false) return 0; // no network at all — no point waiting
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        if (typeof conn.rtt === 'number' && conn.rtt > 0) {
          return Math.min(6000, Math.max(1200, conn.rtt * 6));
        }
        const byEffectiveType = { 'slow-2g': 6000, '2g': 5000, '3g': 3000, '4g': 1500 };
        if (conn.effectiveType && byEffectiveType[conn.effectiveType] != null) {
          return byEffectiveType[conn.effectiveType];
        }
      }
      return 3000;
    }

    // Bootstrap: race getSession() against a timeout so a slow token-refresh network call
    // never leaves the user stuck on a blank screen. Crucially, a timeout only shows the
    // login screen as a fallback — it does NOT delete the stored session. If getSession()
    // is just slow (cold start, flaky network) and eventually succeeds, we still log the
    // user in automatically once it resolves, instead of forcing a fresh OAuth sign-in.
    (async () => {
      let didTimeout = false;
      const timeoutId = setTimeout(() => {
        didTimeout = true;
        if (!_sessionHandled) { hideBootSpinner(); showScreen('login'); }
      }, estimateAuthTimeoutMs());

      try {
        const { data: { session } } = await sb.auth.getSession();
        if (session && !_sessionHandled) {
          clearTimeout(timeoutId);
          _sessionHandled = true;
          promoteToFullSkeleton();
          await handleSession(session);
        } else if (!session && !hasStoredSession() && !_sessionHandled && !didTimeout) {
          // Nothing to restore at all — genuinely logged out, safe to show login right away.
          clearTimeout(timeoutId);
          hideBootSpinner();
          showScreen('login');
        }
        // else: getSession() came back empty despite a stored session existing. Don't flash
        // the login screen — keep the neutral boot spinner up (never the full admin-shaped
        // skeleton, since this session may turn out to be stale/invalid) and let
        // onAuthStateChange (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT) decide, with the
        // timeout above as the final fallback.
      } catch {
        if (!hasStoredSession() && !_sessionHandled) {
          clearTimeout(timeoutId);
          hideBootSpinner();
          showScreen('login');
        }
      }
    })();

    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') { _sessionHandled = false; hideBootSpinner(); showScreen('login'); return; }
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session && !_sessionHandled) {
        _sessionHandled = true;
        promoteToFullSkeleton();
        await handleSession(session);
      }
    });

    async function signIn() {
      const btn = document.getElementById('signin-btn');
      const origHTML = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px"></i>Signing in...';
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname }
      });
      if (error) { toast('Sign-in failed: ' + error.message, 'err'); btn.disabled = false; btn.innerHTML = origHTML; }
    }

    async function signOut() {
      _sessionHandled = false;
      // Stop One Tap from silently re-selecting the same Google account the moment the
      // login screen reappears — without this, signing out becomes an instant re-login loop.
      try { google.accounts.id.disableAutoSelect(); } catch { }
      await sb.auth.signOut();
      window.history.replaceState(null, '', window.location.pathname);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Google One Tap — signs in without any redirect or popup window. GIS shows a
    // browser-mediated prompt (FedCM) with the user's Google account; picking it hands
    // us an ID token that Supabase verifies via signInWithIdToken(). The classic
    // signIn() button stays as the fallback (full-page redirect, also popup-free) for
    // when One Tap can't display: GIS blocked, prompt dismissed earlier (Google then
    // applies a cooldown), or no Google session in the browser.
    //
    // Nonce contract (per Supabase docs): Google receives the SHA-256 HASH of the
    // nonce inside the ID token; Supabase receives the RAW nonce and checks that its
    // hash matches the token's claim — proving the token was minted for this page load.
    // ─────────────────────────────────────────────────────────────────────────────

    const GOOGLE_CLIENT_ID = window.TEACHING_CONFIG.googleClientId;
    let _oneTapNonce = null;
    let _oneTapInited = false;
    let _oneTapWanted = false; // login screen showed before the GIS script finished loading

    window._gsiOnLoad = () => { if (_oneTapWanted) showOneTap(); };

    async function initOneTap() {
      if (_oneTapInited) return true;
      if (!window.google?.accounts?.id || !window.crypto?.subtle) return false;

      const raw = crypto.getRandomValues(new Uint8Array(32));
      _oneTapNonce = btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(_oneTapNonce));
      const hashedNonce = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: onOneTapCredential,
        nonce: hashedNonce,
        context: 'signin',
        auto_select: true,          // returning admin with one Google account: zero-click sign-in
        itp_support: true,          // Safari/ITP-friendly UX
        use_fedcm_for_prompt: true  // browser-native FedCM prompt — the non-popup path Chrome mandates
      });
      _oneTapInited = true;
      return true;
    }

    async function showOneTap() {
      _oneTapWanted = false;
      if (!(await initOneTap())) { _oneTapWanted = true; return; } // GIS not ready yet; retried from _gsiOnLoad
      google.accounts.id.prompt();
    }

    function cancelOneTap() {
      // Close any prompt still on screen once we leave the login screen.
      if (_oneTapInited) { try { google.accounts.id.cancel(); } catch { } }
    }

    async function onOneTapCredential(resp) {
      const btn = document.getElementById('signin-btn');
      const origHTML = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px"></i>Signing in...';
      const { error } = await sb.auth.signInWithIdToken({
        provider: 'google',
        token: resp.credential,
        nonce: _oneTapNonce
      });
      if (error) {
        toast('Sign-in failed: ' + error.message, 'err');
        btn.disabled = false; btn.innerHTML = origHTML;
      }
      // On success onAuthStateChange fires SIGNED_IN → handleSession() routes into the app.
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Idle sign-out — protects against staying logged in on a shared/public machine.
    // Any interaction resets the clock; if none arrives for IDLE_TIMEOUT_MS, we sign out
    // automatically. Watching starts/stops based on showScreen(), so the timer only ever
    // runs while the admin dashboard is actually visible.
    // ─────────────────────────────────────────────────────────────────────────────

    const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity
    let _idleTimer = null;
    let _idleWatchStarted = false;

    function resetIdleTimer() {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(async () => {
        toast('Signed out due to inactivity', 'err');
        await signOut();
      }, IDLE_TIMEOUT_MS);
    }

    function startIdleWatch() {
      resetIdleTimer();
      if (_idleWatchStarted) return;
      _idleWatchStarted = true;
      ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt =>
        document.addEventListener(evt, resetIdleTimer, { passive: true }));
    }

    function stopIdleWatch() {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = null;
    }

    async function handleSession(session) {
      let admin;
      try {
        // Kick off the sidebar's course list query now, in parallel with the admin-identity
        // lookup, instead of waiting for this to finish first — the two queries are independent
        // (both only need the auth token), so overlapping them cuts perceived load time roughly
        // in half instead of paying for both network round trips back to back.
        prefetchSidebar();
        const result = await Promise.race([
          sb.from('admins').select('name,surname,email').single(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
        ]);
        admin = result.data;
      } catch {
        // Supabase cold-start or network issue — the auth session itself is still fine,
        // so don't delete it. Just fall back to the login screen; refreshing or signing
        // in again will retry this lookup against the (still valid) session.
        _sessionHandled = false;
        hideLoading();
        showScreen('login');
        return;
      }
      hideLoading();
      if (!admin) {
        document.getElementById('error-msg').textContent = (session.user.email || 'Your account') + ' is not in the admin list.';
        showScreen('error'); return;
      }
      S.admin = admin;
      document.getElementById('top-user').textContent = admin.name + ' ' + admin.surname;
      if (window.location.href.includes('#')) window.history.replaceState(null, '', window.location.pathname);
      showScreen('admin');
      await loadSidebar();
    }

    function hideBootSpinner() {
      const el = document.getElementById('boot-spinner');
      el.classList.add('hidden');
      setTimeout(() => el.style.display = 'none', 300);
    }

    // Swaps the neutral boot spinner for the admin-shaped skeleton (sidebar,
    // tabs, cards). Only ever called once a session is confirmed to exist —
    // never by default — so the fake UI can't leak the admin layout to a
    // signed-out visitor.
    function promoteToFullSkeleton() {
      hideBootSpinner();
      document.getElementById('app-loading').style.display = 'flex';
    }

    function hideLoading() {
      const el = document.getElementById('app-loading');
      el.classList.add('hidden');
      setTimeout(() => el.style.display = 'none', 400);
    }

    function showScreen(w) {
      hideBootSpinner();
      document.getElementById('login-screen').style.display = w === 'login' ? 'flex' : 'none';
      document.getElementById('error-screen').style.display = w === 'error' ? 'flex' : 'none';
      document.getElementById('admin-app').style.display = w === 'admin' ? 'flex' : 'none';
      if (w !== 'admin') { hideLoading(); applyCourseTheme(''); } // reset brand colour off any course
      if (w === 'admin') { startIdleWatch(); applyArchiveGroupState(); } else stopIdleWatch();
      if (w === 'login') showOneTap(); else cancelOneTap();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Sidebar
    // ─────────────────────────────────────────────────────────────────────────────

    // The sidebar is a normal always-visible docked panel on desktop, so this only ever
    // matters on mobile, where it's an off-canvas drawer opened via the floating FAB.
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      if (window.innerWidth <= 768) {
        const open = sidebar.classList.toggle('mobile-open');
        document.getElementById('sidebar-backdrop').classList.toggle('active', open);
        document.getElementById('sidebar-fab').classList.toggle('active', open);
      } else {
        const hidden = sidebar.classList.toggle('desktop-hidden');
        document.getElementById('admin-app').classList.toggle('sidebar-desktop-hidden', hidden);
      }
    }

    // Archive-group expand/collapse persists across visits.
    function toggleArchiveGroup() {
      const body = document.getElementById('sb-archive');
      const btn = document.getElementById('sb-archive-toggle');
      const expanded = body.classList.toggle('sb-archive-collapsed') === false;
      btn.classList.toggle('expanded', expanded);
      try { localStorage.setItem('admin_archive_expanded', expanded ? '1' : '0'); } catch { }
    }

    function applyArchiveGroupState() {
      let expanded = false;
      try { expanded = localStorage.getItem('admin_archive_expanded') === '1'; } catch { }
      document.getElementById('sb-archive').classList.toggle('sb-archive-collapsed', !expanded);
      document.getElementById('sb-archive-toggle').classList.toggle('expanded', expanded);
    }

    let _sidebarPrefetch = null;
    function prefetchSidebar() {
      // Supabase's query builder is lazy — it only issues the actual HTTP request once
      // awaited/then'd, not when the filter chain is built. Calling .then() here forces the
      // request to start immediately (turning it into a real Promise), so it genuinely runs
      // concurrently with the admin-identity lookup instead of only starting once loadSidebar()
      // later awaits it.
      _sidebarPrefetch = sb.from('course_rows')
        .select('sheet_name, is_archive, b, c')
        .eq('type', 'metadata').order('sheet_name')
        .then(r => r);
      return _sidebarPrefetch;
    }

    async function loadSidebar() {
      const { data, error } = await (_sidebarPrefetch || prefetchSidebar());
      _sidebarPrefetch = null;
      if (error) { toast('Sidebar error: ' + error.message, 'err'); return; }
      const map = {};
      for (const r of (data || [])) {
        const k = r.sheet_name + '|' + String(r.is_archive);
        if (!map[k]) map[k] = { sheet_name: r.sheet_name, is_archive: r.is_archive };
        if (r.b === 'code') map[k].code = r.c;
        if (r.b === 'title') map[k].title = r.c;
        if (r.b === 'semester') map[k].semester = r.c;
        if (r.b === 'year') map[k].year = r.c;
        if (r.b === 'header_decoration') map[k].icon = r.c;
      }
      const active = Object.values(map).filter(c => !c.is_archive).sort(courseOrder);
      const archive = Object.values(map).filter(c => c.is_archive).sort(courseOrder);
      renderSidebarGroup('sb-active', active, false);
      renderSidebarGroup('sb-archive', archive, true);
    }

    // Sidebar order: course code A→Z, then newest offering first — academic year descending, and
    // within a year Summer → Spring → Fall, which is that year's terms in reverse order too.
    const SEMESTER_ORDER = ['Summer', 'Spring', 'Fall'];

    // Courses with no semester/year set sort after those that have one, so a half-filled course
    // never wedges itself between two real offerings.
    function semesterRank(s) {
      const m = String(s || '').match(/^\s*(Fall|Spring|Summer)/);
      const i = m ? SEMESTER_ORDER.indexOf(m[1]) : -1;
      return i === -1 ? SEMESTER_ORDER.length : i;
    }

    // Sentinel rather than -Infinity: two unset years must subtract to 0, not NaN.
    function yearStart(y) {
      const m = String(y || '').match(/(\d{4})/);
      return m ? parseInt(m[1], 10) : -1;
    }

    // numeric:true so CE 99 sorts before CE 132 instead of after it.
    function courseOrder(a, b) {
      return (a.code || a.sheet_name).localeCompare(b.code || b.sheet_name, undefined, { numeric: true })
        || (yearStart(b.year) - yearStart(a.year))
        || (semesterRank(a.semester) - semesterRank(b.semester));
    }

    function renderSidebarGroup(id, courses, isArchive) {
      const el = document.getElementById(id);
      if (!courses.length) { el.innerHTML = `<div class="sb-empty">None</div>`; return; }
      el.innerHTML = courses.map(c => {
        const active = S.course === c.sheet_name && S.isArchive === isArchive;
        const code = c.code || c.sheet_name;
        const title = c.title && c.title !== code ? c.title : '';
        const term = [c.semester, c.year].filter(Boolean).join(' ');
        const icon = c.icon || 'fa-solid fa-graduation-cap';
        return `<button class="course-btn${active ? ' active' : ''}"
                onclick="selectCourse('${x(c.sheet_name)}',${isArchive},this)">
      <i class="${x(icon)} cb-icon"></i>
      <div class="cb-text">
        <div class="cb-code">${x(code)}</div>
        ${title ? `<div class="cb-name">${x(title)}</div>` : ''}
        ${term ? `<div class="cb-sub">${x(term)}</div>` : ''}
      </div>
    </button>`;
      }).join('');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Course / Section
    // ─────────────────────────────────────────────────────────────────────────────

    // Remembers which section tab was last open per course (keyed by sheet_name + archive
    // flag, which together already uniquely identify a course/year offering), so reopening a
    // course returns to where you left off instead of always resetting to the same tab.
    function lastSectionKey(course, isArchive) { return `admin_last_section:${course}:${isArchive}`; }
    function getLastSection(course, isArchive) {
      try { return localStorage.getItem(lastSectionKey(course, isArchive)) || 'modules'; } catch { return 'modules'; }
    }
    function saveLastSection(course, isArchive, id) {
      try { localStorage.setItem(lastSectionKey(course, isArchive), id); } catch { }
    }

    // Persists whatever tab is currently open, dispatching to the right save routine. Returns
    // true only if the save actually succeeded (so navigation can be aborted on failure).
    async function saveCurrentSection() {
      if (S.section === 'info') return await saveSettings();
      if (S.section === 'grading') return await saveGradingSettings();
      return await saveSectionChanges(S.section);
    }

    // Returns true if it's safe to leave the current tab/course.
    async function confirmLeaveIfDirty() {
      if (!_sectionDirty && !inlinePanelDirty()) return true;
      const choice = await confirmDialog('You have unsaved changes in this tab.',
        { title: 'Save changes?', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
      if (choice === true) {
        const ok = await saveCurrentSection();
        if (!ok) return false; // save failed — stay put so nothing is lost
        _sectionDirty = false;
        return true;
      }
      if (choice === 'alt') { _sectionDirty = false; return true; } // discard
      return false; // cancel — stay
    }

    async function selectCourse(name, isArchive, el) {
      if (name === S.course && isArchive === S.isArchive) return;
      if (!(await confirmLeaveIfDirty())) return;
      closeInlineEdit(true); // drop any open editor without re-prompting
      S.course = name; S.isArchive = isArchive; S.section = getLastSection(name, isArchive);
      document.querySelectorAll('.course-btn').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
      if (window.innerWidth <= 768 && document.getElementById('sidebar').classList.contains('mobile-open')) {
        toggleSidebar();
      }
      lockHeight(document.getElementById('main-area'));
      renderCourseShell(name, isArchive);
    }

    function renderCourseShell(name, isArchive) {
      document.getElementById('main-area').innerHTML = `
    <div class="course-header${isArchive ? ' is-archive' : ''}">
      <div class="ch-title-wrap" style="flex:1;min-width:0">
        <h2 id="ch-title">${x(name)}</h2>
        <div id="ch-meta" class="ch-meta"><span class="skeleton skeleton-on-dark" style="display:inline-block;width:160px;height:12px;vertical-align:middle"></span></div>
      </div>
      <div class="ch-actions">
        <span class="header-chip">${isArchive ? 'Archive' : 'Active'}</span>
        ${isArchive
          ? `<button class="btn-ghost btn-sm" onclick="restoreCourse('${x(name)}')"><i class="fa-solid fa-rotate-left" style="margin-right:5px"></i>Restore</button>`
          : `<button class="btn-ghost btn-sm" onclick="archiveCourse('${x(name)}')"><i class="fa-solid fa-box-archive" style="margin-right:5px"></i>Archive</button>`}
        <button class="btn-ghost btn-sm btn-red" style="border-color:rgba(255,120,120,0.5)"
                onclick="deleteCourse('${x(name)}',${isArchive})"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
      </div>
    </div>
    <div class="section-tabs" id="section-tabs">
      ${SECTIONS.map((s, i, arr) => {
            const r = i === 0 ? 'border-radius:20px 8px 8px 20px'
              : i === arr.length - 1 ? 'border-radius:8px 20px 20px 8px' : '';
            return `<button class="section-tab${s.id === S.section ? ' active' : ''}" style="${r}" data-sec="${s.id}"
                  onclick="selectSection('${s.id}',this)">${s.icon ? `<i class="${s.icon}" style="margin-right:5px;font-size:0.88em"></i>` : ''}${s.label}</button>`;
          }).join('')}
    </div>
    <div class="section-body" id="section-body">${sectionSkeletonHtml()}</div>
  `;
      fillCourseHeader(name, isArchive);
      loadSection(S.section);
    }

    // Darkens a hex colour toward black (matches teaching/index.html's darkenHex) — used to
    // derive --primary-dark from a course's primary colour.
    function darkenHex(hex, amount = 0.25) {
      hex = String(hex || '').replace('#', '');
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      const r = Math.max(0, Math.round(parseInt(hex.substring(0, 2), 16) * (1 - amount)));
      const g = Math.max(0, Math.round(parseInt(hex.substring(2, 4), 16) * (1 - amount)));
      const b = Math.max(0, Math.round(parseInt(hex.substring(4, 6), 16) * (1 - amount)));
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    // Recolours the whole admin UI to the current course's primary colour (col-1 of the course's
    // theme_colours metadata). Falls back to the default blue (:root) when the course sets none.
    function applyCourseTheme(themeStr) {
      const root = document.documentElement;
      const first = String(themeStr || '').split(',')[0].trim();
      const hex = first ? (first.startsWith('#') ? first : '#' + first) : '';
      if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
        root.style.setProperty('--primary-color', hex);
        root.style.setProperty('--primary-dark', darkenHex(hex, 0.25));
      } else {
        root.style.removeProperty('--primary-color');
        root.style.removeProperty('--primary-dark');
      }
    }

    async function fillCourseHeader(name, isArchive) {
      const { data } = await sb.from('course_rows').select('b,c')
        .eq('sheet_name', name).eq('is_archive', isArchive).eq('type', 'metadata')
        .in('b', ['code', 'title', 'semester', 'credits', 'year', 'theme_colours']);
      const m = {};
      for (const r of (data || [])) m[r.b] = r.c;
      applyCourseTheme(m.theme_colours);
      const titleEl = document.getElementById('ch-title');
      const metaEl = document.getElementById('ch-meta');
      if (!titleEl) return;
      titleEl.textContent = m.title || m.code || name;
      const parts = [m.code && m.code !== (m.title || m.code) ? m.code : null, m.semester, m.year, m.credits ? m.credits + ' ECTS' : null].filter(Boolean);
      metaEl.textContent = parts.join(' · ');
    }

    // Shimmer placeholder shown the instant a tab/course switch starts — shaped like a card
    // list, which is a reasonable stand-in for any of the section types.
    function sectionSkeletonHtml() {
      return `<div class="skeleton-section">
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
  </div>`;
    }

    // Freezing min-height right before swapping in the skeleton (and clearing it once real
    // content lands) keeps the page from collapsing then re-expanding between the two —
    // that collapse/expand was what made the browser's scrollbar flicker on every switch.
    function lockHeight(el) {
      if (el) el.style.minHeight = el.offsetHeight + 'px';
    }

    function finishSectionLoad(body) {
      body.style.minHeight = '';
      const main = document.getElementById('main-area');
      if (main) main.style.minHeight = '';
      body.classList.remove('loaded');
      requestAnimationFrame(() => body.classList.add('loaded'));
    }

    async function selectSection(id, el) {
      if (id === S.section) return;
      if (!(await confirmLeaveIfDirty())) return; // unsaved changes, user cancelled
      closeInlineEdit(true); // drop any open editor without re-prompting
      S.section = id;
      saveLastSection(S.course, S.isArchive, id);
      document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
      if (el) el.classList.add('active');
      const body = document.getElementById('section-body');
      lockHeight(body);
      body.innerHTML = sectionSkeletonHtml();
      loadSection(id);
    }

    async function loadSection(id) {
      const sec = SECTIONS.find(s => s.id === id);
      if (!sec) return;
      _sectionDirty = false; // fresh load — nothing staged yet
      if (id === 'info') { await loadMetadataSettings(); return; }
      if (id === 'grading') { await loadGradingSettings(); return; }
      if (id === 'links') { await loadLinksSection(sec); return; }
      // The Modules view is the single place where module & project ORDER is set, so it also
      // loads project header rows (type 'project') to show them as draggable refs alongside
      // modules. Their content stays in the Projects tab.
      const fetchTypes = sec.hier ? [...sec.types, 'project'] : sec.types;
      const { data, error } = await sb.from('course_rows').select('*')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive)
        .in('type', fetchTypes).order('row_index');
      const body = document.getElementById('section-body');
      if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }
      for (const r of (data || [])) ROW_STORE[r.row_uid] = r;
      if (sec.hier) body.innerHTML = renderHier(data || []);
      else if (sec.proj) body.innerHTML = renderProjects(data || []);
      else body.innerHTML = renderCards(data || [], sec);
      finishSectionLoad(body);
      initDnD(sec);
      // Arriving here from an Edit click on a project ref in the Modules view: open that
      // project's inline editor now that the Projects tab has rendered.
      if (sec.proj && _openProjectAfterLoad) {
        const uid = _openProjectAfterLoad; _openProjectAfterLoad = null;
        openInlineEdit(uid);
      }
    }
    let _openProjectAfterLoad = null;

    // Links tab shows the Timetables editor above the Link Button cards; both save together
    // via the one Save button (saveSectionChanges('links') also calls saveTimetablesWork()).
    async function loadLinksSection(sec) {
      const body = document.getElementById('section-body');
      const [metaRes, btnRes] = await Promise.all([
        sb.from('course_rows').select('*').eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata').order('row_index'),
        sb.from('course_rows').select('*').eq('sheet_name', S.course).eq('is_archive', S.isArchive).in('type', sec.types).order('row_index'),
      ]);
      if (metaRes.error) { body.innerHTML = `<div class="empty-content">Error: ${x(metaRes.error.message)}</div>`; return; }
      if (btnRes.error) { body.innerHTML = `<div class="empty-content">Error: ${x(btnRes.error.message)}</div>`; return; }

      const metaMap = {};
      for (const r of (metaRes.data || [])) { ROW_STORE[r.row_uid] = r; if (isKnownMetaKey(r.b)) metaMap[r.b] = r; }

      const ttNums = new Set();
      for (const k of Object.keys(metaMap)) {
        const m = k.match(/^timetable(\d+)_name$/);
        if (m) ttNums.add(parseInt(m[1]));
      }
      const tts = Array.from(ttNums).sort((a, b) => a - b);

      let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveSectionChanges('links')"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
  </div>`;

      h += `<div class="settings-group" style="margin-bottom:14px">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-clock"></i>Timetables</span>
      <button class="btn-sm btn-secondary" type="button" onclick="addTimetableCard()"><i class="fa-solid fa-plus"></i></button>
    </div>
    <div class="settings-body" id="timetables-list">`;
      if (tts.length) {
        for (const n of tts) h += timetableCardHtml(n, metaMap);
      } else {
        h += `<div id="no-tt-msg" class="form-hint" style="padding:4px 0">No timetables yet.</div>`;
      }
      h += `</div></div>`;

      for (const r of (btnRes.data || [])) ROW_STORE[r.row_uid] = r;
      // Wrapped in the same settings-group shell as Timetables above, so the two blocks read as
      // one consistent "Links" page instead of two differently-styled widgets.
      h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-link"></i>Link Buttons</span>
      <button class="btn-sm btn-secondary" type="button" onclick="addFlatRow('button')"><i class="fa-solid fa-plus"></i></button>
    </div>
    <div class="settings-body" id="links-cards-body">${renderCards(btnRes.data || [], sec, { bare: true })}</div>
  </div>`;

      body.innerHTML = h;
      finishSectionLoad(body);
      initDnD(sec);
    }

    // Timetables (metadata rows): delete all old + insert fresh from current DOM order.
    // Returns an error message string on failure, or null on success.
    async function saveTimetablesWork() {
      const { data: existing } = await sb.from('course_rows').select('row_uid,b,row_index')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
      const existMap = {};
      let maxIdx = 0;
      for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }
      const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

      const oldTtUids = Object.entries(existMap)
        .filter(([k]) => /^timetable\d+_(name|id|height)$/.test(k) || /^class\d+_id$/.test(k))
        .map(([, r]) => r.row_uid);
      if (oldTtUids.length) {
        const { error } = await sb.from('course_rows').delete().in('row_uid', oldTtUids);
        if (error) return error.message;
      }

      const ttCards = document.getElementById('timetables-list') ? [...document.querySelectorAll('#timetables-list .dynamic-card')] : [];
      const newTtRows = [];
      ttCards.forEach((card, idx) => {
        const i = idx + 1;
        const name = card.querySelector('[name=tt_name]')?.value?.trim() || '';
        const tid = card.querySelector('[name=tt_id]')?.value?.trim() || '';
        const classId = card.querySelector('[name=tt_class]')?.value?.trim() || '';
        let ri = maxIdx + idx * 5;
        if (name) newTtRows.push({ ...base, row_uid: `${S.course}:adm_tt${i}n`, row_index: ri + 1, b: `timetable${i}_name`, c: name });
        if (tid) newTtRows.push({ ...base, row_uid: `${S.course}:adm_tt${i}i`, row_index: ri + 2, b: `timetable${i}_id`, c: tid });
        if (classId) newTtRows.push({ ...base, row_uid: `${S.course}:adm_tt${i}c`, row_index: ri + 3, b: `class${i}_id`, c: classId });
      });
      if (newTtRows.length) {
        const { error } = await sb.from('course_rows').upsert(newTtRows, { onConflict: 'row_uid' });
        if (error) return error.message;
      }
      return null;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Info / Metadata Settings
    // ─────────────────────────────────────────────────────────────────────────────

    async function loadGradingSettings() {
      const { data, error } = await sb.from('course_rows').select('*')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata')
        .order('row_index');
      const body = document.getElementById('section-body');
      if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }

      const metaMap = {};
      for (const r of (data || [])) { ROW_STORE[r.row_uid] = r; if (isKnownMetaKey(r.b)) metaMap[r.b] = r; }

      const { html: gradeRows, total: gradeTotal } = renderGradingRows(metaMap);
      const h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveGradingSettings()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
  </div>
  <div class="settings-panel">
    <div class="settings-group">
      <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-chart-simple"></i>Grading</span></div>
      <div class="settings-body">
        <table class="grade-table" id="grade-table">${gradeRows}</table>
        <div class="grade-total">Total: <strong id="grade-total" style="color:${Math.abs(gradeTotal - 100) < 0.01 ? 'var(--success-color)' : (gradeTotal > 100 ? 'var(--danger-color)' : 'var(--primary-color)')}">${gradeTotal}</strong> %</div>
      </div>
    </div>
  </div>`;
      body.innerHTML = h;
      finishSectionLoad(body);
    }

    async function saveGradingSettings() {
      const btn = document.getElementById('section-save-btn');
      const origHtml = btn ? btn.innerHTML : '';
      const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

      const { data: existing } = await sb.from('course_rows').select('row_uid,b,row_index')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
      const existMap = {};
      let maxIdx = 0;
      for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }

      const toUpsert = [];
      const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

      const doneMap = {};
      document.querySelectorAll('.grade-done').forEach(s => doneMap[s.dataset.donekey] = s.value);
      for (const inp of document.querySelectorAll('.grade-val')) {
        const key = inp.dataset.key;
        const val = inp.value.trim();
        const done = doneMap[key] || '';
        if (!val && !existMap[key]) continue;
        const uid = existMap[key]?.row_uid || `${S.course}:adm_${key}`;
        const idx = existMap[key]?.row_index || (maxIdx += 10, maxIdx);
        toUpsert.push({ ...base, row_uid: uid, row_index: idx, b: key, c: val, d: done });
      }

      if (toUpsert.length) {
        const { error } = await sb.from('course_rows').upsert(toUpsert, { onConflict: 'row_uid' });
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }

      // Multi-entry categories: delete all old + legacy keys for each category, then renumber
      // fresh from current DOM order — same pattern as professors/timetables.
      let gradeRowIdx = maxIdx + 20;
      for (const cat of GRADING_CATEGORIES.filter(c => c.multi)) {
        const re = new RegExp(`^${cat.id}\\d+_percentage$`);
        const oldGradeUids = Object.entries(existMap)
          .filter(([k]) => re.test(k) || k === cat.legacyKey)
          .map(([, r]) => r.row_uid);
        if (oldGradeUids.length) {
          const { error } = await sb.from('course_rows').delete().in('row_uid', oldGradeUids);
          if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
        }

        const newGradeRows = [];
        document.querySelectorAll(`tr.grading-row[data-cat="${cat.id}"]`).forEach((tr, idx) => {
          const i = idx + 1;
          const val = tr.querySelector('.grade-val-multi')?.value?.trim() || '';
          const done = tr.querySelector('.grade-done-multi')?.value || '';
          if (!val) return;
          const key = `${cat.id}${i}_percentage`;
          newGradeRows.push({ ...base, row_uid: `${S.course}:adm_${key}`, row_index: ++gradeRowIdx, b: key, c: val, d: done });
        });
        if (newGradeRows.length) {
          const { error } = await sb.from('course_rows').upsert(newGradeRows, { onConflict: 'row_uid' });
          if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
        }
      }

      toast('Grading saved', 'ok');
      resetBtn();
      _sectionDirty = false;
      return true;
    }

    async function loadMetadataSettings() {
      const { data, error } = await sb.from('course_rows').select('*')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata')
        .order('row_index');
      const body = document.getElementById('section-body');
      if (error) { body.innerHTML = `<div class="empty-content">Error: ${x(error.message)}</div>`; return; }

      const metaMap = {}, extras = [];
      for (const r of (data || [])) {
        ROW_STORE[r.row_uid] = r;
        if (isKnownMetaKey(r.b)) metaMap[r.b] = r;
        else extras.push(r);
      }

      if (!metaMap['year']?.c && metaMap['startdate']?.c) {
        const parts = String(metaMap['startdate'].c).split('-');
        const yr = parseInt(parts[0]), mo = parseInt(parts[1]);
        if (!isNaN(yr) && !isNaN(mo) && yr > 2000) {
          const derived = mo >= 9 ? `${yr}–${yr + 1}` : `${yr - 1}–${yr}`;
          metaMap['year'] = { c: derived };
        }
      }

      const profNums = new Set();
      for (const k of Object.keys(metaMap)) {
        const m = k.match(/^professor(\d+)$/);
        if (m) profNums.add(parseInt(m[1]));
      }
      const profs = Array.from(profNums).sort((a, b) => a - b);
      if (!profs.length) profs.push(1);

      const themeStr = metaMap['theme_colours']?.c || '';
      const themeParts = themeStr.split(',').map(s => s.trim());

      const v = k => x(metaMap[k]?.c || '');
      const vDate = k => { const s = metaMap[k]?.c || ''; if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0, 10); return ''; };

      let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveSettings()"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
  </div><div class="settings-panel">`;

      // ── Course Identity ──
      h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-id-card"></i>Course Identity</span></div>
    <div class="settings-body"><div class="sg-grid">
      <div class="form-group">
        <label class="form-label">Course Code</label>
        <input type="text" class="meta-field" data-metakey="code" value="${v('code')}">
      </div>
      <div class="form-group">
        <label class="form-label">Title</label>
        <input type="text" class="meta-field" data-metakey="title" value="${v('title')}">
      </div>
      <div class="form-group">
        <label class="form-label">Academic Year</label>
        <input type="text" class="meta-field" data-metakey="year" value="${v('year')}" oninput="onYearInput(this)" onblur="normalizeYearField(this)">
      </div>
      <div class="form-group">
        <label class="form-label">Semester</label>
        <select class="meta-field" data-metakey="semester">
          ${['', 'Fall Semester', 'Spring Semester', 'Summer Semester'].map(o => `<option value="${x(o)}"${(metaMap['semester']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Level</label>
        <select class="meta-field" data-metakey="level">
          ${['', 'Undergraduate', 'Graduate', 'Integrated Second Cycle', 'Postgraduate'].map(o => `<option value="${x(o)}"${(metaMap['level']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="meta-field" data-metakey="type">
          ${['', 'Compulsory', 'Elective', 'Optional'].map(o => `<option value="${x(o)}"${(metaMap['type']?.c || '') === (o) ? ` selected` : ''}>${o || '—'}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Credits (ECTS)</label>
        <input type="number" class="meta-field" data-metakey="credits" min="1" max="10" step="1" value="${v('credits')}">
      </div>
    </div></div>
  </div>`;

      // ── Dates ──
      h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-calendar-days"></i>Dates</span></div>
    <div class="settings-body"><div class="sg-grid">
      <div class="form-group">
        <label class="form-label">Start Date</label>
        <input type="date" class="meta-field" data-metakey="startdate" value="${vDate('startdate')}">
      </div>
      <div class="form-group">
        <label class="form-label">End Date</label>
        <input type="date" class="meta-field" data-metakey="enddate" value="${vDate('enddate')}">
      </div>
      <div class="form-group">
        <label class="form-label">Holiday Weeks</label>
        <input type="number" class="meta-field" data-metakey="holidayweeks" min="0" max="2" step="1" value="${v('holidayweeks') || '0'}">
      </div>
      <div class="form-group">
        <label class="form-label">Holiday Start Date</label>
        <input type="date" class="meta-field" data-metakey="holiday_startdate" value="${vDate('holiday_startdate')}">
      </div>
    </div></div>
  </div>`;

      // ── Professors (dynamic) ──
      h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-user-tie""></i>Professors</span>
      <button class="btn-sm btn-secondary" type="button" onclick="addProfessorCard()"><i class="fa-solid fa-plus"></i></button>
    </div>
    <div class="settings-body" id="professors-list">`;
      for (const n of profs) {
        h += professorCardHtml(n, metaMap);
      }
      h += `</div></div>`;

      // ── Appearance ──
      const hdVal = metaMap['header_decoration']?.c || '';
      const tpTitle = metaMap['title']?.c || metaMap['code']?.c || S.course;
      const tpSub = [metaMap['code']?.c, metaMap['semester']?.c].filter(Boolean).join(' · ') || 'Course page preview';
      h += `<div class="settings-group">
    <div class="settings-head"><span style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-palette"></i>Appearance</span></div>
    <div class="settings-body">
      <div class="form-group">
        <label class="form-label">Header Icon <span class="form-hint" style="display:inline;margin-left:6px">Font Awesome class · e.g. fa-solid fa-tent-arrows-down · <a href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer">find an icon <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.85em"></i></a></span></label>
        <div class="icon-input-wrap">
          <input type="text" class="meta-field" data-metakey="header_decoration"
                 value="${x(hdVal)}"
                 oninput="previewFaIcon(this,'hd-preview');previewFaIcon(this,'tp-icon')">
          <i id="hd-preview" class="${x(hdVal || 'fa-solid fa-question')}" style="font-size:1.8em;color:var(--primary-color);width:32px;text-align:center;flex-shrink:0"></i>
          <a class="icon-find-link" href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer" title="Find an icon on Font Awesome"><i class="fa-solid fa-magnifying-glass"></i></a>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Theme Colours <span class="form-hint" style="display:inline;margin-left:6px">pick a swatch or type a hex value</span></label>
        <div class="color-picker-row">
          ${THEME_COLOR_NAMES.map((name, i) => {
        const val = (themeParts[i] && themeParts[i].startsWith('#')) ? themeParts[i] : THEME_COLOR_DEFAULTS[i];
        return `<div class="color-picker-item">
              <input type="color" id="tc_${i}" value="${val}" oninput="onThemeSwatchInput(${i})">
              <input type="text" class="tc-hex" id="tcx_${i}" value="${val}" maxlength="7" spellcheck="false" autocomplete="off"
                     oninput="onThemeHexInput(${i})" onblur="normalizeThemeHexInput(${i})">
              <span class="color-label">${name}</span>
            </div>`;
      }).join('')}
        </div>
        <input type="hidden" class="meta-field" data-metakey="theme_colours" id="theme_colours_field" value="${x(themeStr)}">
        <div class="theme-preview" id="theme-preview">
          <div class="tp-header">
            <i id="tp-icon" class="${x(hdVal || 'fa-solid fa-graduation-cap')}" style="font-size:1.5em;flex-shrink:0;width:26px;text-align:center"></i>
            <div class="tp-head-text">
              <div class="tp-title">${x(tpTitle)}</div>
              <div class="tp-sub">${x(tpSub)}</div>
            </div>
            <span class="tp-chip"><i class="fa-regular fa-clock" style="margin-right:4px"></i>Timetable</span>
          </div>
          <div class="tp-body">
            <div class="tp-module"><i class="fa-solid fa-layer-group"></i>Module — Lecture Slides</div>
            <div class="tp-row">
              <span class="tp-pill" style="background:var(--tp-primary,#3949ab)">Primary</span>
              <span class="tp-pill" style="background:var(--tp-secondary,#ffa726)">Secondary</span>
              <span class="tp-pill" style="background:var(--tp-tertiary,#2196f3)">Tertiary</span>
              <span class="tp-pill" style="background:var(--tp-accent,#9c27b0)">Accent</span>
              <span class="tp-pill" style="background:var(--tp-success,#43a047)">Success</span>
            </div>
          </div>
        </div>
        <div class="form-hint" style="margin-top:6px">Live preview of the public course page with these colours · <button type="button" class="link-btn" onclick="resetThemeColours()">reset to default colours</button></div>
      </div>
    </div>
  </div>`;

      h += `</div>`;

      if (extras.length) {
        h += `<div style="margin-top:18px;margin-bottom:8px;font-size:0.72em;font-weight:700;color:#9e9e9e;text-transform:uppercase;letter-spacing:0.07em">Custom / Other Keys</div>`;
        for (const r of extras) {
          h += `<div class="material-card">
        <div class="card-main">
          <div class="card-title">${x(r.b)}</div>
          ${r.c ? `<div class="card-detail">${x(r.c.substring(0, 100))}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-secondary btn-sm" onclick="openEditCustomMeta('${x(r.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
          <button class="btn-red btn-sm" onclick="deleteRow('${x(r.row_uid)}')"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
        </div>
      </div>`;
        }
      }

      body.innerHTML = h;
      finishSectionLoad(body);
      updateThemePreview();
    }

    function updateDynamicCardLabel(input, fallback) {
      const lbl = input.closest('.dynamic-card')?.querySelector('.dcl-text');
      if (lbl) lbl.textContent = input.value.trim() || fallback;
    }

    function professorCardHtml(n, metaMap) {
      const name = metaMap[`professor${n}`]?.c || '';
      const link = metaMap[`professor${n}_link`]?.c || '';
      const photo = metaMap[`professor${n}_photo`]?.c || '';
      return `<div class="dynamic-card">
    <div class="dynamic-card-head">
      <span class="dynamic-card-label"><i class="fa-solid fa-user-tie" style="margin-right:5px;opacity:0.7"></i><span class="dcl-text">${x(name || 'New Professor')}</span></span>
      <button class="btn-red btn-sm" type="button" onclick="removeProfessorCard(this)"><i class="fa-solid fa-trash""></i></button>
    </div>
    <div class="dynamic-card-body sg-grid1">
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" name="prof_name" value="${x(name)}" oninput="updateDynamicCardLabel(this,'New Professor')">
      </div>
      <div class="form-group">
        <label class="form-label">Profile URL</label>
        <div class="icon-input-wrap">
          <input type="text" name="prof_link" value="${x(link)}"
                 oninput="updateLinkPreview(this,this.nextElementSibling)">
          <a href="${x(link || '#')}" target="_blank" rel="noopener"
             style="flex-shrink:0;padding:6px 10px;background:var(--primary-color);color:white;border-radius:10px;text-decoration:none;display:${link ? 'flex' : 'none'};align-items:center;gap:4px;font-size:0.82em;border:1.5px solid rgba(0,0,0,0.18)">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Photo URL</label>
        <div class="icon-input-wrap">
          <input type="text" name="prof_photo" value="${x(photo)}"
                 oninput="updatePhotoPreview(this,this.nextElementSibling)">
          <img src="${x(photo || '')}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;display:${photo ? 'block' : 'none'};border:2px solid #e0e0e0"
               onerror="this.style.display='none'">
        </div>
      </div>
    </div>
  </div>`;
    }

    function addProfessorCard() {
      const list = document.getElementById('professors-list');
      const noMsg = list.querySelector('#no-prof-msg');
      if (noMsg) noMsg.remove();
      list.insertAdjacentHTML('beforeend', professorCardHtml(0, {}));
    }

    function removeProfessorCard(btn) {
      btn.closest('.dynamic-card').remove();
      const list = document.getElementById('professors-list');
      if (!list.querySelector('.dynamic-card')) {
        list.insertAdjacentHTML('beforeend', `<div id="no-prof-msg" class="form-hint" style="padding:4px 0">No professors yet.</div>`);
      }
    }

    function timetableCardHtml(n, metaMap) {
      const name = metaMap[`timetable${n}_name`]?.c || '';
      const tid = metaMap[`timetable${n}_id`]?.c || '';
      const classId = metaMap[`class${n}_id`]?.c || '';
      return `<div class="dynamic-card">
    <div class="dynamic-card-head">
      <span class="dynamic-card-label"><i class="fa-solid fa-clock" style="margin-right:5px;opacity:0.7"></i><span class="dcl-text">${x(name || 'New Timetable')}</span></span>
      <button class="btn-red btn-sm" type="button" onclick="removeTimetableCard(this)"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="dynamic-card-body sg-grid3">
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" name="tt_name" value="${x(name)}" oninput="updateDynamicCardLabel(this,'New Timetable')">
      </div>
      <div class="form-group">
        <label class="form-label">Timetable ID</label>
        <input type="text" name="tt_id" value="${x(tid)}">
      </div>
      <div class="form-group">
        <label class="form-label">Class ID</label>
        <input type="text" name="tt_class" value="${x(classId)}">
      </div>
    </div>
  </div>`;
    }

    function addTimetableCard() {
      const list = document.getElementById('timetables-list');
      const noMsg = list.querySelector('#no-tt-msg');
      if (noMsg) noMsg.remove();
      list.insertAdjacentHTML('beforeend', timetableCardHtml(0, {}));
    }

    function removeTimetableCard(btn) {
      btn.closest('.dynamic-card').remove();
      const list = document.getElementById('timetables-list');
      if (!list.querySelector('.dynamic-card')) {
        list.insertAdjacentHTML('beforeend', `<div id="no-tt-msg" class="form-hint" style="padding:4px 0">No timetables yet.</div>`);
      }
    }

    // ── Date/time conversion: "DD-MM-YYYY, HH:mm" ↔ "YYYY-MM-DDTHH:mm" ──
    function toIsoDatetime(str) {
      if (!str) return '';
      const m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}`;
      return '';
    }
    function fromIsoDatetime(str) {
      if (!str) return '';
      const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}, ${m[4]}:${m[5]}`;
      return str;
    }

    // ── Link preview button ──
    function updateLinkPreview(inp, btn) {
      if (typeof btn === 'string') btn = document.getElementById(btn);
      if (!btn) return;
      const url = inp.value.trim();
      btn.href = url || '#';
      btn.style.display = url ? 'flex' : 'none';
    }
    function updatePhotoPreview(inp, img) {
      if (!img) return;
      const url = inp.value.trim();
      img.src = url || '';
      img.style.display = url ? 'block' : 'none';
    }

    // ── Autofill Google Drive / OneDrive links ──
    function autofillDriveLink(inp, force = false) {
      const url = inp.value.trim();
      if (!url) return;
      let viewUrl = '', dlUrl = '';

      // Google Drive file (PDF, PPTX, etc.)
      let m = url.match(/drive\.google\.com\/file\/d\/([^\/\?&#]+)/);
      if (m) {
        const id = m[1];
        viewUrl = `https://drive.google.com/file/d/${id}/preview`;
        dlUrl = `https://drive.google.com/uc?export=download&id=${id}`;
      }
      // Google Docs
      if (!viewUrl) {
        m = url.match(/docs\.google\.com\/document\/d\/([^\/\?&#]+)/);
        if (m) { const id = m[1]; viewUrl = `https://docs.google.com/document/d/${id}/preview`; dlUrl = `https://docs.google.com/document/d/${id}/export?format=pdf`; }
      }
      // Google Sheets
      if (!viewUrl) {
        m = url.match(/docs\.google\.com\/spreadsheets\/d\/([^\/\?&#]+)/);
        if (m) { const id = m[1]; viewUrl = `https://docs.google.com/spreadsheets/d/${id}/preview`; dlUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`; }
      }
      // Google Slides
      if (!viewUrl) {
        m = url.match(/docs\.google\.com\/presentation\/d\/([^\/\?&#]+)/);
        if (m) { const id = m[1]; viewUrl = `https://docs.google.com/presentation/d/${id}/preview`; dlUrl = `https://docs.google.com/presentation/d/${id}/export/pptx`; }
      }
      // Google Drive open?id=...
      if (!viewUrl) {
        m = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
        if (m) { const id = m[1]; viewUrl = `https://drive.google.com/file/d/${id}/preview`; dlUrl = `https://drive.google.com/uc?export=download&id=${id}`; }
      }
      // OneDrive 1drv.ms / onedrive.live.com
      if (!viewUrl && (url.includes('1drv.ms') || url.includes('onedrive.live.com'))) {
        viewUrl = url; dlUrl = url.replace(/\?.*$/, '').replace(/embed$/, 'download');
      }
      // SharePoint / OneDrive for Business
      if (!viewUrl && url.includes('sharepoint.com')) {
        viewUrl = url.includes('?') ? url + '&web=1' : url + '?web=1'; dlUrl = url;
      }

      if (!viewUrl) {
        if (force) toast('Unrecognised link, use a Google Drive or OneDrive URL', 'err');
        return;
      }
      const viewEl = document.getElementById('mf_e');
      const dlEl = document.getElementById('mf_f');
      if (viewEl) { viewEl.value = viewUrl; updateLinkPreview(viewEl, 'lp_e'); }
      if (dlEl) { dlEl.value = dlUrl; updateLinkPreview(dlEl, 'lp_f'); }
      toast('View & Download links filled', 'ok');
    }

    // ── Google Drive Picker ──
    // The paste-a-link flow above stays; this is the second option: browse Drive and
    // click a file. It needs an OAuth access token carrying a Drive scope — the admin
    // login (One Tap ID token, or the redirect flow) never requests one, so we mint a
    // token on demand with the GIS token client. Google shows a consent screen the first
    // time only; after that requestAccessToken() returns silently. The picked file's URL
    // is dropped into the autofill input, which reuses autofillDriveLink() to fill the
    // View/Download links exactly as a pasted link would.
    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
    const GOOGLE_API_KEY = window.TEACHING_CONFIG.googleApiKey || '';
    const GOOGLE_APP_ID = String(GOOGLE_CLIENT_ID).split('-')[0]; // project number = numeric client-id prefix
    let _driveToken = null;         // { value, expiresAt }
    let _driveTokenClient = null;
    let _pickerApiLoaded = false;
    let _pickerScrollY = 0;
    let _pickerScrollLocked = false;

    // Freeze the page while the picker is up. The dialog itself is pinned viewport-fixed in
    // CSS, so pinning the body (fixed at its current scroll offset) can't misplace it — it
    // just stops Google's internal window.scrollTo from moving the page underneath.
    function lockPickerScroll() {
      if (_pickerScrollLocked) return;
      _pickerScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${_pickerScrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      _pickerScrollLocked = true;
    }

    function unlockPickerScroll() {
      if (!_pickerScrollLocked) return;
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      window.scrollTo(0, _pickerScrollY);
      _pickerScrollLocked = false;
    }

    function loadPickerApi() {
      return new Promise((resolve, reject) => {
        if (_pickerApiLoaded) return resolve();
        if (!window.gapi) return reject(new Error('Google API not loaded yet — try again in a moment'));
        gapi.load('picker', {
          callback: () => { _pickerApiLoaded = true; resolve(); },
          onerror: () => reject(new Error('Drive picker failed to load')),
        });
      });
    }

    function getDriveToken() {
      return new Promise((resolve, reject) => {
        // Reuse a still-valid token (with a 60s safety margin) to avoid re-prompting.
        if (_driveToken && _driveToken.expiresAt > Date.now() + 60000) return resolve(_driveToken.value);
        if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in not loaded yet'));
        if (!_driveTokenClient) {
          _driveTokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => {},
          });
        }
        // Reassign per call so this Promise gets the result; empty prompt = silent when
        // already granted, consent only on first use.
        _driveTokenClient.callback = (resp) => {
          if (resp.error) return reject(new Error(resp.error));
          _driveToken = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) * 1000) };
          resolve(resp.access_token);
        };
        // hint = the signed-in admin's email so Google skips the account chooser and
        // reuses the already-signed-in account instead of asking every time.
        _driveTokenClient.requestAccessToken({ prompt: '', hint: S.admin?.email || '' });
      });
    }

    async function openDrivePicker(inp) {
      if (!inp) return;
      try {
        const [token] = await Promise.all([getDriveToken(), loadPickerApi()]);
        // Three tabs mirroring the standard Google Drive picker:
        //  • Recent      — RECENTLY_PICKED
        //  • My Drive    — a plain DocsView shows ALL of the user's own Drive files with
        //                  real folder browsing (adding setEnableDrives here is what had
        //                  turned this tab into "Shared drives" before).
        //  • Shared drives — a second DocsView with setEnableDrives(true).
        const myDrive = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setIncludeFolders(true).setSelectFolderEnabled(false);
        const sharedDrives = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false);
        // Size the dialog to the viewport (CSS also clamps it), so it stays usable on
        // phones instead of overflowing at Google's fixed default size.
        const w = Math.min(1051, Math.max(320, Math.floor(window.innerWidth * 0.95)));
        const h = Math.min(650, Math.max(380, Math.floor(window.innerHeight * 0.9)));
        const builder = new google.picker.PickerBuilder()
          .setAppId(GOOGLE_APP_ID)
          .setOrigin(window.location.protocol + '//' + window.location.host)
          .setOAuthToken(token)
          .addView(google.picker.ViewId.RECENTLY_PICKED)
          .addView(myDrive)
          .addView(sharedDrives)
          .setSize(w, h)
          .setCallback((data) => onDrivePicked(data, inp));
        if (GOOGLE_API_KEY) builder.setDeveloperKey(GOOGLE_API_KEY);
        lockPickerScroll();          // freeze the page before the dialog appears
        builder.build().setVisible(true);
      } catch (e) {
        unlockPickerScroll();
        toast('Could not open Google Drive: ' + e.message, 'err');
      }
    }

    function onDrivePicked(data, inp) {
      // The picker occasionally leaves the busy cursor set after LOADED fires; clear it
      // defensively on every callback so it can't get stuck once the dialog is up.
      document.body.style.cursor = '';
      if (!data) return;
      // LOADED just means the dialog rendered — keep the scroll lock in place. Any other
      // terminal action (PICKED / CANCEL) closes the dialog, so release the page then.
      if (data.action === google.picker.Action.LOADED) return;
      unlockPickerScroll();
      if (data.action !== google.picker.Action.PICKED) return;
      const doc = data.docs && data.docs[0];
      if (!doc) return;
      inp.value = doc.url || `https://drive.google.com/file/d/${doc.id}/view`;
      autofillDriveLink(inp, true); // reuse the paste path to fill View/Download links
    }

    function previewFaIcon(inp, previewId) {
      const el = document.getElementById(previewId);
      if (!el) return;
      const cls = inp.value.trim();
      el.className = cls || 'fa-solid fa-question';
    }

    function syncThemeColourField() {
      const vals = [0, 1, 2, 3, 4].map(i => {
        const el = document.getElementById('tc_' + i);
        return el ? el.value : '';
      });
      const field = document.getElementById('theme_colours_field');
      if (field) field.value = vals.join(', ');
    }

    // Accepts "#abc", "abc", "#aabbcc" or "aabbcc"; returns canonical "#aabbcc" or null.
    function normalizeHexColour(s) {
      s = String(s || '').trim().replace(/^#?/, '#');
      if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + [...s.slice(1)].map(c => c + c).join('');
      return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
    }

    function onThemeSwatchInput(i) {
      const sw = document.getElementById('tc_' + i);
      const tx = document.getElementById('tcx_' + i);
      if (sw && tx) { tx.value = sw.value; tx.classList.remove('invalid'); }
      syncThemeColourField();
      updateThemePreview();
    }

    // Hex typed → only mirror into the swatch once it parses; flag it red while it doesn't.
    function onThemeHexInput(i) {
      const tx = document.getElementById('tcx_' + i);
      if (!tx) return;
      const hex = normalizeHexColour(tx.value);
      tx.classList.toggle('invalid', !hex);
      if (!hex) return;
      const sw = document.getElementById('tc_' + i);
      if (sw) sw.value = hex;
      syncThemeColourField();
      updateThemePreview();
    }

    // On blur, snap the hex box back to the swatch's canonical value (fixes half-typed input).
    function normalizeThemeHexInput(i) {
      const tx = document.getElementById('tcx_' + i);
      const sw = document.getElementById('tc_' + i);
      if (tx && sw) { tx.value = sw.value; tx.classList.remove('invalid'); }
    }

    function resetThemeColours() {
      THEME_COLOR_DEFAULTS.forEach((hex, i) => {
        const sw = document.getElementById('tc_' + i);
        if (sw) sw.value = hex;
        const tx = document.getElementById('tcx_' + i);
        if (tx) { tx.value = hex; tx.classList.remove('invalid'); }
      });
      syncThemeColourField();
      updateThemePreview();
      markDirty(); // programmatic value changes don't fire the delegated input listener
    }

    // Repaints the mini course-page mock from the current picker values via its --tp-* props.
    function updateThemePreview() {
      const prev = document.getElementById('theme-preview');
      if (!prev) return;
      const vals = [0, 1, 2, 3, 4].map(i => document.getElementById('tc_' + i)?.value || THEME_COLOR_DEFAULTS[i]);
      prev.style.setProperty('--tp-primary', vals[0]);
      prev.style.setProperty('--tp-primary-dark', darkenHex(vals[0], 0.25));
      prev.style.setProperty('--tp-secondary', vals[1]);
      prev.style.setProperty('--tp-tertiary', vals[2]);
      prev.style.setProperty('--tp-accent', vals[3]);
      prev.style.setProperty('--tp-success', vals[4]);
    }

    function updateGradeTotal() {
      const inputs = document.querySelectorAll('.grade-val, .grade-val-multi');
      let t = 0;
      inputs.forEach(i => t += parseFloat(i.value) || 0);
      const el = document.getElementById('grade-total');
      if (el) {
        el.textContent = t;
        el.style.color = Math.abs(t - 100) < 0.01 ? 'var(--success-color)' : (t > 100 ? 'var(--danger-color)' : 'var(--primary-color)');
      }
    }

    function gradingCatHeadHtml(cat, withAdd) {
      return `<tr class="grading-cat-head" data-cat="${cat.id}">
      <td colspan="4"><i class="${cat.icon}" style="margin-right:6px;opacity:0.6;width:14px;text-align:center;display:inline-block"></i>${x(cat.label)}</td>
      <td class="gt-del">${withAdd ? `<button type="button" class="btn-secondary btn-icon" onclick="addGradingRow('${cat.id}')" title="Add ${x(cat.label)}"><i class="fa-solid fa-plus"></i></button>` : ''}</td>
    </tr>`;
    }

    function gradingRowHtml(catId, label, key, row) {
      const val = row?.c || '';
      const done = row?.d || '';
      return `<tr class="grading-row" data-cat="${x(catId)}">
      <td class="gt-label">${x(label)}</td>
      <td class="gt-pct"><input type="number" min="0" max="100" class="grade-val-multi" data-key="${x(key)}" value="${x(val)}" oninput="updateGradeTotal()"></td>
      <td class="gt-unit">%</td>
      <td class="gt-done"><select class="grade-done-multi" data-donekey="${x(key)}">
        <option value=""${done === '' ? ' selected' : ''}>—</option>
        <option value="Done"${done === 'Done' ? ' selected' : ''}>Done</option>
      </select></td>
      <td class="gt-del"><button type="button" class="btn-red btn-icon" onclick="removeGradingRow(this)" title="Remove"><i class="fa-solid fa-xmark"></i></button></td>
    </tr>`;
    }

    // Fixed (non-multi) categories — e.g. Final, Attendance — get a header for visual parity
    // with the multi-entry categories, but their single row has no add/remove controls.
    function fixedGradingRowHtml(cat, row) {
      const val = row?.c || '';
      const done = row?.d || '';
      return `<tr>
      <td class="gt-label">${x(cat.label)}</td>
      <td class="gt-pct"><input type="number" min="0" max="100" class="grade-val" data-key="${x(cat.key)}" value="${x(val)}" oninput="updateGradeTotal()"></td>
      <td class="gt-unit">%</td>
      <td class="gt-done"><select class="grade-done" data-donekey="${x(cat.key)}">
        <option value=""${done === '' ? ' selected' : ''}>—</option>
        <option value="Done"${done === 'Done' ? ' selected' : ''}>Done</option>
      </select></td>
      <td class="gt-del"></td>
    </tr>`;
    }

    function renderGradingRows(metaMap) {
      let total = 0;
      let html = '';
      for (const cat of GRADING_CATEGORIES) {
        if (!cat.multi) {
          const row = metaMap[cat.key];
          total += parseFloat(row?.c || '') || 0;
          html += gradingCatHeadHtml(cat, false);
          html += fixedGradingRowHtml(cat, row);
          continue;
        }
        html += gradingCatHeadHtml(cat, true);
        const entries = gradingEntriesFor(cat, metaMap);
        entries.forEach((e, i) => {
          const row = metaMap[e.key];
          total += parseFloat(row?.c || '') || 0;
          // Only number entries once there are 2+ (e.g. "Quiz" alone, but "Quiz 1"/"Quiz 2" when there are several).
          const label = entries.length > 1 ? `${cat.label} ${i + 1}` : cat.label;
          html += gradingRowHtml(cat.id, label, e.key, row);
        });
      }
      return { html, total };
    }

    function relabelGradingCategory(catId) {
      const cat = GRADING_CATEGORIES.find(c => c.id === catId);
      if (!cat) return;
      const rows = document.querySelectorAll(`tr.grading-row[data-cat="${catId}"]`);
      rows.forEach((row, i) => {
        const labelCell = row.querySelector('.gt-label');
        if (labelCell) labelCell.textContent = rows.length > 1 ? `${cat.label} ${i + 1}` : cat.label;
      });
    }

    function addGradingRow(catId) {
      const cat = GRADING_CATEGORIES.find(c => c.id === catId);
      if (!cat) return;
      const head = document.querySelector(`tr.grading-cat-head[data-cat="${catId}"]`);
      if (!head) return;
      const rows = document.querySelectorAll(`tr.grading-row[data-cat="${catId}"]`);
      const n = rows.length + 1;
      const html = gradingRowHtml(catId, cat.label, `${catId}${n}_percentage`, null);
      const last = rows.length ? rows[rows.length - 1] : head;
      last.insertAdjacentHTML('afterend', html);
      relabelGradingCategory(catId);
      updateGradeTotal();
    }

    function removeGradingRow(btn) {
      const tr = btn.closest('tr');
      const catId = tr.dataset.cat;
      tr.remove();
      relabelGradingCategory(catId);
      updateGradeTotal();
    }

    async function saveSettings() {
      const btn = document.getElementById('section-save-btn');
      const origHtml = btn ? btn.innerHTML : '';
      const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

      const { data: existing } = await sb.from('course_rows').select('row_uid,b,row_index')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).eq('type', 'metadata');
      const existMap = {};
      let maxIdx = 0;
      for (const r of (existing || [])) { existMap[r.b] = r; if (r.row_index > maxIdx) maxIdx = r.row_index; }

      const toUpsert = [];
      const base = { sheet_name: S.course, is_archive: S.isArchive, type: 'metadata', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };

      const pushField = (key, val, extra = {}) => {
        if (!val && !existMap[key]) return;
        const uid = existMap[key]?.row_uid || `${S.course}:adm_${key.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const idx = existMap[key]?.row_index || (maxIdx += 10, maxIdx);
        toUpsert.push({ ...base, row_uid: uid, row_index: idx, b: key, c: val, ...extra });
      };

      for (const inp of document.querySelectorAll('.meta-field')) {
        const key = inp.dataset.metakey;
        if (!key) continue;
        pushField(key, inp.value.trim());
      }

      if (toUpsert.length) {
        const { error } = await sb.from('course_rows').upsert(toUpsert, { onConflict: 'row_uid' });
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }

      const oldProfUids = Object.entries(existMap)
        .filter(([k]) => /^professor\d+(_link|_photo)?$/.test(k))
        .map(([, r]) => r.row_uid);
      if (oldProfUids.length) {
        const { error } = await sb.from('course_rows').delete().in('row_uid', oldProfUids);
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }

      const profCards = [...document.querySelectorAll('#professors-list .dynamic-card')];
      const newProfRows = [];
      profCards.forEach((card, idx) => {
        const i = idx + 1;
        const name = card.querySelector('[name=prof_name]')?.value?.trim() || '';
        const link = card.querySelector('[name=prof_link]')?.value?.trim() || '';
        const photo = card.querySelector('[name=prof_photo]')?.value?.trim() || '';
        let ri = maxIdx + idx * 5;
        if (name) newProfRows.push({ ...base, row_uid: `${S.course}:adm_prof${i}n`, row_index: ri + 1, b: `professor${i}`, c: name });
        if (link) newProfRows.push({ ...base, row_uid: `${S.course}:adm_prof${i}l`, row_index: ri + 2, b: `professor${i}_link`, c: link });
        if (photo) newProfRows.push({ ...base, row_uid: `${S.course}:adm_prof${i}p`, row_index: ri + 3, b: `professor${i}_photo`, c: photo });
      });
      if (newProfRows.length) {
        const { error } = await sb.from('course_rows').upsert(newProfRows, { onConflict: 'row_uid' });
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }

      // Timetables and Grading save separately (saveTimetablesWork/saveGradingSettings), not here.

      toast('Settings saved', 'ok');
      resetBtn();
      _sectionDirty = false;
      await loadSidebar();
      await fillCourseHeader(S.course, S.isArchive);
      return true;
    }

    function openEditCustomMeta(uid) {
      const row = ROW_STORE[uid];
      if (!row) return;
      document.getElementById('modal-title').textContent = 'Edit: ' + row.b;
      document.getElementById('modal-body').innerHTML = `
    <input type="hidden" id="m_uid" value="${x(row.row_uid)}">
    <input type="hidden" id="m_sheet" value="${x(row.sheet_name)}">
    <input type="hidden" id="m_archive" value="${row.is_archive}">
    <input type="hidden" id="m_index" value="${row.row_index}">
    <input type="hidden" id="m_type" value="_custom">
    <div class="form-group"><label class="form-label">Key</label><input type="text" id="mf_b" value="${x(row.b)}"></div>
    <div class="form-group"><label class="form-label">Value</label><input type="text" id="mf_c" value="${x(row.c || '')}"></div>
    <div class="form-group"><label class="form-label">Status (col D)</label><input type="text" id="mf_d" value="${x(row.d || '')}"></div>
  `;
      FIELDS['_custom'] = [{ col: 'b' }, { col: 'c' }, { col: 'd' }];
      document.getElementById('modal-foot').style.display = '';
      document.getElementById('modal-save').onclick = modalSave;
      document.getElementById('modal-overlay').classList.add('open');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Module hierarchy (modules + materials + funfacts)
    // ─────────────────────────────────────────────────────────────────────────────

    function moduleHeaderHtml(p) {
      return `<div class="module-header">
        <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
        <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : ''}</div>
        <div class="mod-info">
          <div class="mod-title">${x(p.c || 'Untitled Module')}</div>
          ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-ghost btn-sm" onclick="openInlineEdit('${x(p.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
          <button class="btn-ghost btn-sm" onclick="addMaterialOrFunfact('${x(p.row_uid)}','material')"><i class="fa-regular fa-file-powerpoint" style="margin-right:5px"></i>Add Material</button>
          <button class="btn-ghost btn-sm" onclick="addMaterialOrFunfact('${x(p.row_uid)}','funfact')"><i class="fa-solid fa-lightbulb" style="margin-right:5px"></i>Add Fun Fact</button>
          <button class="btn-ghost btn-sm btn-red" style="border-color:rgba(255,100,100,0.4)" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
        </div>
      </div>`;
    }

    function funfactCardHtml(c) {
      return `<div class="funfact-card" data-uid="${x(c.row_uid)}">
    <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
    <i class="fa-solid fa-lightbulb" style="color:var(--secondary-color);font-size:1.1em;flex-shrink:0"></i>
    <div class="card-main">
      <div class="card-title">${x((c.b || '').substring(0, 100))}</div>
    </div>
    <div class="card-actions">
      <button class="btn-secondary btn-sm" onclick="openInlineEdit('${x(c.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
      <button class="btn-red btn-sm" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
    </div>
  </div>`;
    }

    function moduleContentHtml(children) {
      const materials = children.filter(c => c.type !== 'funfact');
      const funfacts = children.filter(c => c.type === 'funfact');
      let h = `<div class="module-content">`;
      // The materials/funfacts wrapper divs always render, even when empty, so "Add Material"/
      // "Add Fun Fact" always has somewhere to insert into — only the placeholder text is conditional.
      if (!children.length) {
        h += `<div class="empty-content" style="padding:14px;margin:0">No items. Use the buttons above.</div>`;
      }
      h += `<div class="module-materials">${materials.map(c => materialCardHtml(c)).join('')}</div>`;
      h += `<div class="module-funfacts">${funfacts.map(c => funfactCardHtml(c)).join('')}</div>`;
      h += `</div>`;
      return h;
    }

    function renderHier(rows) {
      let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveSectionChanges('modules')"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    <div class="add-bar">
      <button onclick="addModule()" class="btn-sm"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Module</button>
    </div>
  </div>`;
      if (!rows.length) return h + `<div class="empty-content">No modules or projects yet.</div>`;

      // Walk the row_index-ordered rows into top-level items. A 'module' starts a module group
      // (materials/funfacts attach to it); a 'project' is a standalone ref (its content lives in
      // the Projects tab). Everything else attaches to the current module group only.
      const items = []; let cur = null;
      for (const row of rows) {
        if (row.type === 'module') { cur = { kind: 'module', parent: row, children: [] }; items.push(cur); }
        else if (row.type === 'project') { cur = null; items.push({ kind: 'project', parent: row }); }
        else if (cur) cur.children.push(row);
        else { if (!items.length || items[items.length - 1].kind !== 'orphan') items.push({ kind: 'orphan', parent: null, children: [] }); items[items.length - 1].children.push(row); }
      }

      // Modules and projects share one Order (`b`); highest on top. Orphaned items stay pinned first.
      const orphan = items.length && items[0].kind === 'orphan' ? items.shift() : null;
      items.sort((a, b) => (parseFloat(b.parent?.b) || 0) - (parseFloat(a.parent?.b) || 0));
      if (orphan) items.unshift(orphan);

      for (const g of items) {
        if (g.kind === 'project') {
          h += projectRefCardHtml(g.parent);
        } else if (g.kind === 'module') {
          h += `<div class="module" data-uid="${x(g.parent.row_uid)}">
        ${moduleHeaderHtml(g.parent)}
        ${moduleContentHtml(g.children)}
      </div>`;
        } else {
          h += `<div class="module">
        <div class="module-header">
          <div class="mod-icon"></div>
          <div class="mod-info"><div class="mod-title">Orphaned items</div></div>
        </div>
        ${moduleContentHtml(g.children)}
      </div>`;
        }
      }
      return h;
    }

    // Compact, drag-to-reorder stand-in for a project shown inside the Modules view. It carries
    // the project's data-uid so it takes part in the unified top-level ordering, but its only
    // action is Edit, which jumps to the Projects tab (where its content is edited).
    function projectRefCardHtml(p) {
      return `<div class="module project-ref" data-uid="${x(p.row_uid)}">
    <div class="module-header">
      <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
      <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : '<i class="fa-solid fa-diagram-project"></i>'}</div>
      <div class="mod-info">
        <div class="mod-title"><span class="proj-ref-badge">Project</span>${x(p.c || 'Untitled Project')}</div>
        ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn-ghost btn-sm" onclick="editProjectFromModules('${x(p.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
      </div>
    </div>
  </div>`;
    }

    // Edit a project from the Modules view → switch to the Projects tab and open its editor.
    // Goes through selectSection so unsaved module-order changes still prompt to save.
    async function editProjectFromModules(uid) {
      _openProjectAfterLoad = uid;
      const tab = document.querySelector('.section-tab[data-sec="projects"]');
      await selectSection('projects', tab);
      if (S.section !== 'projects') _openProjectAfterLoad = null; // switch was cancelled
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Projects hierarchy
    // ─────────────────────────────────────────────────────────────────────────────

    function projectHeaderHtml(p) {
      // No drag handle here: project ORDER is set in the Modules view (where projects appear as
      // refs alongside modules). This tab is for editing project content only.
      return `<div class="module-header">
        <div class="mod-icon">${p.d ? `<i class="${x(p.d)}"></i>` : ''}</div>
        <div class="mod-info">
          <div class="mod-title">${x(p.c || 'Untitled Project')}</div>
          ${p.e ? `<div class="mod-sub">${x(p.e)}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-ghost btn-sm" onclick="openInlineEdit('${x(p.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
          <button class="btn-ghost btn-sm" onclick="addProjectFile('${x(p.row_uid)}')"><i class="fa-solid fa-file" style="margin-right:5px"></i>Add File</button>
          <button class="btn-ghost btn-sm" onclick="addProjectDescription('${x(p.row_uid)}')"><i class="fa-solid fa-align-left" style="margin-right:5px"></i>Add Description</button>
          <button class="btn-ghost btn-sm" onclick="addProjectGroup('${x(p.row_uid)}')"><i class="fa-solid fa-users" style="margin-right:5px"></i>Add Group</button>
          <button class="btn-ghost btn-sm btn-red" style="border-color:rgba(255,100,100,0.4)" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
        </div>
      </div>`;
    }

    function projectDescCardHtml(d) {
      return `<div class="material-card project-desc-card" data-uid="${x(d.row_uid)}" style="margin-bottom:8px;background:#f7f8fc">
    <div class="card-icon"><i class="fa-solid fa-align-left"></i></div>
    <div class="card-main">
      <div class="card-title">Project Description</div>
      <div class="card-detail">${x((d.b || '').substring(0, 80))}</div>
    </div>
    <div class="card-actions">
      <button class="btn-secondary btn-sm" onclick="openInlineEdit('${x(d.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
      <button class="btn-red btn-sm" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
    </div>
  </div>`;
    }

    function pgbHeadHtml(g) {
      const members = [g.e, g.f, g.g, g.h, g.i].filter(Boolean);
      return `<div class="pgb-headwrap">
    <div class="pgb-head">
      <div class="pgb-name"><i class="fa-solid fa-users" style="opacity:0.5;margin-right:6px"></i>${x(g.b || 'Group')}</div>
      <div class="pgb-chips">
        ${g.c ? `<span class="pgb-chip"><i class="fa-solid fa-chalkboard-user" style="margin-right:4px;opacity:0.6"></i>${x(g.c)}</span>` : ''}
        ${g.d ? `<span class="pgb-chip"><i class="fa-solid fa-star" style="margin-right:4px;opacity:0.6"></i>${x(g.d)}</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn-secondary btn-sm" onclick="openInlineEdit('${x(g.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
        <button class="btn-secondary btn-sm" onclick="addGroupFile('${x(g.row_uid)}')"><i class="fa-solid fa-file-circle-plus" style="margin-right:5px"></i>Add File</button>
        <button class="btn-red btn-sm" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
      </div>
    </div>
    ${members.length ? `<div class="pgb-members">${members.map(m => `<span class="member-chip">${x(m)}</span>`).join('')}</div>` : ''}
  </div>`;
    }

    function projectGroupBlockHtml(g, files) {
      return `<div class="project-group-block" data-uid="${x(g.row_uid)}">
    ${pgbHeadHtml(g)}
    ${files.length ? `<div class="pgb-files">${files.map(f => materialCardHtml(f)).join('')}</div>` : ''}
  </div>`;
    }

    function renderProjects(rows) {
      let h = `<div class="section-topbar">
    <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveSectionChanges('projects')"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
    <div class="add-bar">
      <button onclick="addProject()" class="btn-sm"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Project</button>
    </div>
  </div>`;
      if (!rows.length) return h + `<div class="empty-content">No projects yet.</div>`;

      const projects = []; let curProj = null; let curGrp = null;
      for (const row of rows) {
        if (row.type === 'project') {
          curProj = { header: row, desc: null, files: [], groups: [] }; curGrp = null;
          projects.push(curProj);
        } else if (curProj) {
          if (row.type === 'project_description') curProj.desc = row;
          else if (row.type === 'project_file') curProj.files.push(row);
          else if (row.type === 'project_group') { curGrp = { header: row, files: [] }; curProj.groups.push(curGrp); }
          else if (row.type === 'group_file' && curGrp) curGrp.files.push(row);
        }
      }

      // Same Order as the Modules view / public page: highest on top.
      projects.sort((a, b) => (parseFloat(b.header.b) || 0) - (parseFloat(a.header.b) || 0));

      for (const proj of projects) {
        const p = proj.header;
        h += `<div class="module" data-uid="${x(p.row_uid)}">
      ${projectHeaderHtml(p)}
      <div class="module-content">`;

        if (proj.desc) h += projectDescCardHtml(proj.desc);
        for (const f of proj.files) h += materialCardHtml(f);
        for (const grp of proj.groups) h += projectGroupBlockHtml(grp.header, grp.files);

        if (!proj.desc && !proj.files.length && !proj.groups.length) {
          h += `<div class="empty-content" style="padding:14px;margin:0">No content yet. Click <strong>Add File</strong>, <strong>Add Description</strong>, or <strong>Add Group</strong> above.</div>`;
        }

        h += `</div></div>`;
      }
      return h;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Cards (links, announcements)
    // ─────────────────────────────────────────────────────────────────────────────

    function flatCardHtml(row) {
      let t1 = '', t2 = '';
      if (row.type === 'button') { t1 = row.b; t2 = row.d; }
      else if (row.type === 'announcement') { t1 = row.e; t2 = row.d; }
      else { t1 = row.b || row.c || ''; }
      const icon = (row.type === 'announcement' || row.type === 'button') ? row.b : '';
      return `<div class="material-card" data-uid="${x(row.row_uid)}">
      <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
      ${icon ? `<div class="card-icon"><i class="${x(icon)}"></i></div>` : ''}
      <div class="card-main">
        <div class="card-title">${x((t1 || '').substring(0, 70)) || '(empty)'}</div>
        ${t2 ? `<div class="card-detail">${x((t2 || '').substring(0, 80))}</div>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn-secondary btn-sm" onclick="openInlineEdit('${x(row.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
        <button class="btn-red btn-sm" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
      </div>
    </div>`;
    }

    function renderCards(rows, sec, opts = {}) {
      const ADD_ICONS = { button: 'fa-solid fa-link', announcement: 'fa-solid fa-plus' };
      let h = '';
      if (!opts.bare) {
        const btns = sec.types.map(t => `<button onclick="addFlatRow('${t}')" class="btn-sm"><i class="${ADD_ICONS[t] || 'fa-solid fa-plus'}" style="margin-right:5px"></i>Add ${TYPE_NAMES[t] || t}</button>`).join('');
        h += `<div class="section-topbar">
      <button class="btn-sm btn-save-section" id="section-save-btn" onclick="saveSectionChanges('${sec.id}')"><i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save</button>
      <div class="add-bar">${btns}</div>
    </div>`;
      }
      if (!rows.length) return h + `<div class="empty-content">No ${sec.label.toLowerCase()} yet.</div>`;
      for (const row of rows) h += flatCardHtml(row);
      return h;
    }

    function materialCardHtml(c) {
      return `<div class="material-card" data-uid="${x(c.row_uid)}">
    <div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
    ${c.b ? `<div class="card-icon"><i class="${x(c.b)}"></i></div>` : ''}
    <div class="card-main">
      <div class="card-title">${x(c.c || 'Untitled')}</div>
      ${c.d ? `<div class="card-detail">${x(c.d.substring(0, 80))}</div>` : ''}
    </div>
    <div class="card-actions">
      <button class="btn-secondary btn-sm" onclick="openInlineEdit('${x(c.row_uid)}')"><i class="fa-solid fa-pen" style="margin-right:5px"></i>Edit</button>
      <button class="btn-red btn-sm" onclick="stageDeleteRow(this)"><i class="fa-solid fa-trash" style="margin-right:5px"></i>Delete</button>
    </div>
  </div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Row CRUD
    // ─────────────────────────────────────────────────────────────────────────────

    // ── Inline editing (replaces the old modal for Modules/Projects/Links/Announcements) ──
    // Only one row is ever being edited inline at a time; opening a new one commits + collapses
    // whatever was previously open first. Nothing here touches the database — edits, adds,
    // deletes, and drag reordering are all purely local until the tab's Save button is clicked.

    let _inlineEditUid = null;
    let _newRowSeq = 0;

    function attrSel(uid) { return `[data-uid="${String(uid).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`; }

    function addNewRow(type, defaults = {}) {
      const uid = `${S.course}:new_${Date.now()}_${_newRowSeq++}`;
      const row = { row_uid: uid, sheet_name: S.course, is_archive: S.isArchive, row_index: 0, type, b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: '', ...defaults };
      ROW_STORE[uid] = row;
      markDirty(); // a new (unsaved) row now exists
      return { uid, row };
    }

    function currentDatetimeStr() {
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      return `${dd}-${mm}-${yyyy}, ${hh}:${min}`;
    }

    // The element whose outerHTML gets replaced when an inline edit closes, and right after
    // which the edit panel gets inserted. For module/project/project_group this is just the
    // header portion, so re-rendering it never disturbs already-rendered children.
    function getEditAnchor(uid, row) {
      const el = document.querySelector('#section-body ' + attrSel(uid));
      if (!el) return null;
      if (row.type === 'module' || row.type === 'project') return el.querySelector(':scope > .module-header') || el;
      if (row.type === 'project_group') return el.querySelector(':scope > .pgb-headwrap') || el;
      return el;
    }

    // JSON of the field values shown in the open panel, taken when it opens — compared against
    // the current DOM on close to know whether there are unsaved edits.
    let _inlineEditSnapshot = null;

    function openInlineEdit(uid) {
      const row = ROW_STORE[uid];
      if (!row) { toast('Row not in cache, reload the section', 'err'); return; }
      // Clicking the same Edit toggle again is a request to close (and may prompt to save).
      if (_inlineEditUid === uid) { requestCloseInlineEdit(); return; }
      closeInlineEdit();
      // Drop any panel still mid-collapse from a previous close so we never get two at once.
      document.getElementById('inline-edit-panel')?.remove();
      const anchor = getEditAnchor(uid, row);
      if (!anchor) return;
      let inner;
      if (row.type === 'project_group') {
        inner = buildInlineGroupFieldsHtml(row);
      } else {
        const schema = FIELDS[row.type];
        if (!schema || schema === 'dynamic') { toast('No schema for type: ' + row.type, 'err'); return; }
        inner = buildInlineFieldsHtml(row, schema);
      }
      _inlineEditUid = uid;
      const panel = document.createElement('div');
      panel.className = 'inline-edit-panel';
      panel.id = 'inline-edit-panel';
      // All chrome/fields live on .iep-inner so the outer grid row can collapse to zero height.
      // Every panel gets the same Save / Cancel footer (Save persists like the big section Save).
      panel.innerHTML = `<div class="iep-inner">${inner}<div class="inline-edit-foot">
        <button type="button" class="btn-secondary btn-sm" onclick="requestCloseInlineEdit()"><i class="fa-solid fa-xmark" style="margin-right:5px"></i>Cancel</button>
        <button type="button" class="btn-sm btn-save-section" onclick="inlineSave()"><i class="fa-solid fa-floppy-disk" style="margin-right:5px"></i>Save</button>
      </div></div>`;
      anchor.classList.add('inline-editing-anchor');
      anchor.insertAdjacentElement('afterend', panel);
      _inlineEditSnapshot = readInlineFieldsJson(row);
      setDnDDisabled(true);
      // Force a reflow at 0fr, then flip to .open so the accordion actually animates the expand.
      void panel.offsetHeight;
      panel.classList.add('open');
      // Land the cursor in the first field once the accordion has mostly expanded, so editing
      // can start immediately without an extra click.
      setTimeout(() => {
        if (_inlineEditUid !== uid) return; // panel already closed/switched meanwhile
        panel.querySelector('input:not([type=hidden]), textarea, select')?.focus();
      }, 180);
    }

    // Tears the panel down. Commits DOM → ROW_STORE first (unless discarding) — this MUST happen
    // before the panel is removed, since the fields live inside it. When `animate` is set (the
    // user-facing Cancel / toggle paths), the panel collapses shut first; programmatic callers
    // (Save, switching rows) tear down instantly since the section re-renders anyway.
    function closeInlineEdit(discard, animate) {
      if (!_inlineEditUid) return;
      const uid = _inlineEditUid;
      const row = ROW_STORE[uid];
      if (row && !discard) {
        if (row.type === 'project_group') commitInlineGroupFields(row);
        else {
          const schema = FIELDS[row.type];
          if (schema && schema !== 'dynamic') commitInlineFieldsFromDom(row, schema);
        }
      }
      // Clear state up front so a follow-up open can't double-commit or race this teardown.
      _inlineEditUid = null;
      _inlineEditSnapshot = null;
      setDnDDisabled(false);
      const panel = document.getElementById('inline-edit-panel');
      // Remove the panel and re-render the edited card together at the end, so the card stays
      // flush-attached while the panel collapses, then swaps instantly (no fade) once it's gone.
      const finish = () => { if (panel) panel.remove(); if (row) rerenderAnchor(uid); };
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (panel && animate && !reduce) {
        panel.classList.remove('open'); // collapse shut, then tear down after the transition
        setTimeout(finish, 300);
      } else {
        finish();
      }
    }

    // User-facing close (Cancel button, or toggling the Edit button off). Prompts to save when
    // there are unsaved edits so a stray click can't quietly drop them.
    async function requestCloseInlineEdit() {
      if (!_inlineEditUid) return;
      if (inlinePanelDirty()) {
        const choice = await confirmDialog('You have unsaved changes to this item.',
          { title: 'Save changes?', okLabel: 'Save', okIcon: 'fa-floppy-disk', altLabel: 'Discard' });
        if (choice === true) { await inlineSave(); return; }
        if (choice === 'alt') { closeInlineEdit(true, true); return; } // discard, animated
        return; // Cancel — keep editing
      }
      closeInlineEdit(false, true); // commit, animated collapse
    }

    // Save the open panel exactly like the big section Save (commit → persist → reload). Because
    // saveSectionChanges() calls closeInlineEdit() first, the panel's edits are committed and
    // written in the same pass.
    async function inlineSave() {
      if (!S.section) { closeInlineEdit(); return; }
      await saveSectionChanges(S.section);
    }

    // Whether the panel's current field values differ from what it opened with.
    function inlinePanelDirty() {
      if (!_inlineEditUid || _inlineEditSnapshot == null) return false;
      const row = ROW_STORE[_inlineEditUid];
      if (!row) return false;
      return readInlineFieldsJson(row) !== _inlineEditSnapshot;
    }

    // Reads the panel's live field values (without mutating ROW_STORE) as a stable JSON string.
    function readInlineFieldsJson(row) {
      if (row.type === 'project_group') return JSON.stringify(readGroupFieldsFromDom());
      const schema = FIELDS[row.type];
      if (!schema || schema === 'dynamic') return '';
      return JSON.stringify(readInlineFieldsFromDom(schema));
    }


    // Sortable's own `filter`/`handle` gating isn't enough once a panel is open — dragging a
    // card out from under an open editor (or reordering while its commit-on-close logic is
    // about to run) is confusing, so dragging is fully suspended for the section while any
    // inline editor is open.
    function setDnDDisabled(disabled) {
      document.querySelectorAll('#section-body, #section-body .module-materials, #section-body .module-funfacts, #links-cards-body')
        .forEach(el => { const s = window.Sortable && Sortable.get(el); if (s) s.option('disabled', disabled); });
    }

    function buildInlineFieldsHtml(row, schema) {
      let h = '';
      for (const f of schema) {
        const raw = row[f.col] || '';
        const v = raw || f.default || '';
        const pid = 'icon_prev_' + f.col;
        h += `<div class="form-group"><label class="form-label">${x(f.label)}</label>`;
        if (f.ta) {
          h += `<textarea id="mf_${f.col}">${xh(v)}</textarea>`;
        } else if (f.sel) {
          const opts = f.sel.map(o => {
            const oval = (typeof o === 'object') ? o.val : o;
            const olbl = (typeof o === 'object') ? o.lbl : (o || '—');
            return `<option value="${x(oval)}"${v === oval ? ' selected' : ''}>${x(olbl)}</option>`;
          }).join('');
          h += `<select id="mf_${f.col}">${opts}</select>`;
        } else if (f.dt) {
          h += `<input type="datetime-local" id="mf_${f.col}" value="${x(toIsoDatetime(v))}">`;
        } else if (f.icon) {
          h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}"
               oninput="previewFaIcon(this,'${pid}')">
        <i id="${pid}" class="${x(v || 'fa-solid fa-question')}" style="font-size:1.6em;color:var(--primary-color);width:28px;text-align:center;flex-shrink:0"></i>
        <a class="icon-find-link" href="${FA_SEARCH_URL}" target="_blank" rel="noopener noreferrer" title="Find an icon on Font Awesome"><i class="fa-solid fa-magnifying-glass"></i></a>
      </div>`;
        } else if (f.link) {
          h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}"
               oninput="updateLinkPreview(this,'lp_${f.col}')">
        <a id="lp_${f.col}" href="${x(v || '#')}" target="_blank" rel="noopener"
           class="btn btn-sm" style="flex-shrink:0;padding:6px 10px;background:var(--primary-color);color:white;border-radius:10px;text-decoration:none;display:${v ? 'flex' : 'none'};align-items:center;gap:4px;border:none">
          <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.85em"></i>
        </a>
      </div>`;
        } else if (f.autofill) {
          h += `<div class="icon-input-wrap">
        <input type="text" id="mf_${f.col}" value="${x(v)}" placeholder="Pick from Drive or paste a Drive / OneDrive link"
               onpaste="setTimeout(()=>autofillDriveLink(this),50)"
               onblur="autofillDriveLink(this)">
        <button type="button" class="btn btn-sm" title="Pick a file from Google Drive"
                style="flex-shrink:0;padding:6px 11px;font-size:0.95em"
                onclick="openDrivePicker(document.getElementById('mf_${f.col}'))"><i class="fa-brands fa-google-drive"></i></button>
        <button type="button" class="btn btn-sm" style="flex-shrink:0;padding:6px 12px;font-size:0.82em"
                onclick="autofillDriveLink(document.getElementById('mf_${f.col}'),true)">Fill</button>
      </div>`;
        } else {
          h += `<input type="text" id="mf_${f.col}" value="${x(v)}">`;
        }
        if (f.hint && !f.sel && !f.icon && !f.dt && !f.link && !f.autofill) h += `<div class="form-hint">${x(f.hint)}</div>`;
        h += `</div>`;
      }
      return h;
    }

    function readInlineFieldsFromDom(schema) {
      const o = {};
      for (const f of schema) {
        const el = document.getElementById('mf_' + f.col);
        if (!el) continue;
        o[f.col] = f.dt && el.value ? fromIsoDatetime(el.value) : (el.value || '');
      }
      return o;
    }

    function commitInlineFieldsFromDom(row, schema) {
      Object.assign(row, readInlineFieldsFromDom(schema));
    }

    function buildInlineGroupFieldsHtml(row) {
      // cols e,f,g,h each store one member; col i stores member5,member6,... comma-separated
      const allMembers = ['e', 'f', 'g', 'h'].map(c => row[c] || '').filter(Boolean);
      if (row.i) allMembers.push(...row.i.split(',').map(s => s.trim()).filter(Boolean));
      allMembers.push(''); // one empty slot at end
      let membersHtml = '';
      allMembers.forEach((val, i) => { membersHtml += memberRowHtml(i + 1, val); });
      return `
    <div class="form-group"><label class="form-label">Group Name</label><input type="text" id="mf_b" value="${x(row.b || '')}"></div>
    <div class="form-group"><label class="form-label">Supervisor</label><input type="text" id="mf_c" value="${x(row.c || '')}"></div>
    <div class="form-group"><label class="form-label">Leader</label><input type="text" id="mf_d" value="${x(row.d || '')}"></div>
    <div style="margin-bottom:4px;font-size:0.77em;font-weight:700;color:#9e9e9e;text-transform:uppercase;letter-spacing:0.05em"><i class="fa-solid fa-person" style="margin-right:5px;opacity:0.6"></i>Members</div>
    <div id="members-list">${membersHtml}</div>
    <button type="button" class="btn-secondary btn-sm" onclick="addMemberSlot()" style="margin-top:4px"><i class="fa-solid fa-plus" style="margin-right:5px"></i>Add Member</button>
  `;
    }

    function readGroupFieldsFromDom() {
      const members = [...document.querySelectorAll('#members-list .member-input')].map(inp => inp.value.trim()).filter(Boolean);
      return {
        b: (document.getElementById('mf_b')?.value || '').trim(),
        c: (document.getElementById('mf_c')?.value || '').trim(),
        d: (document.getElementById('mf_d')?.value || '').trim(),
        e: members[0] || '', f: members[1] || '', g: members[2] || '', h: members[3] || '',
        i: members.slice(4).join(',')
      };
    }

    function commitInlineGroupFields(row) {
      Object.assign(row, readGroupFieldsFromDom());
    }

    function rerenderAnchor(uid) {
      const row = ROW_STORE[uid];
      if (!row) return;
      const anchor = getEditAnchor(uid, row);
      if (!anchor) return;
      let html;
      if (row.type === 'module') html = moduleHeaderHtml(row);
      else if (row.type === 'project') html = projectHeaderHtml(row);
      else if (row.type === 'project_group') html = pgbHeadHtml(row);
      else if (row.type === 'funfact') html = funfactCardHtml(row);
      else if (row.type === 'material' || row.type === 'project_file' || row.type === 'group_file') html = materialCardHtml(row);
      else if (row.type === 'project_description') html = projectDescCardHtml(row);
      else if (row.type === 'button' || row.type === 'announcement') html = flatCardHtml(row);
      else return;
      anchor.outerHTML = html;
    }

    function memberRowHtml(n, val) {
      return `<div class="form-group member-row" style="display:flex;align-items:center;gap:6px">
    <label class="form-label" style="min-width:84px;margin:0">Member ${n}</label>
    <input type="text" class="member-input" value="${x(val)}" style="flex:1">
    <button type="button" class="btn-secondary btn-icon" style="flex-shrink:0"
            onclick="this.closest('.member-row').remove()"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
    }

    function addMemberSlot() {
      const list = document.getElementById('members-list');
      const count = list.querySelectorAll('.member-row').length;
      list.insertAdjacentHTML('beforeend', memberRowHtml(count + 1, ''));
    }

    // ── Staged delete: just removes the DOM node (after confirming). Nothing is deleted from
    // the database until the tab's Save button diffs the final DOM state against it. ──

    async function stageDeleteRow(btn) {
      const el = btn.closest('[data-uid]');
      if (!el) return;
      const ok = await confirmDialog('This item will be permanently deleted.', { title: 'Delete item', okLabel: 'Remove', danger: true });
      if (!ok) return;
      if (_inlineEditUid === el.dataset.uid) {
        _inlineEditUid = null;
        const panel = document.getElementById('inline-edit-panel');
        if (panel) panel.remove();
      }
      const moduleContent = el.closest('.module-content');
      el.remove();
      if (moduleContent) refreshModuleContentPlaceholder(moduleContent);
      refreshTopLevelPlaceholder();
      markDirty(); // a row was removed but not yet persisted
    }

    function refreshModuleContentPlaceholder(contentEl) {
      const mats = contentEl.querySelector(':scope > .module-materials');
      const funs = contentEl.querySelector(':scope > .module-funfacts');
      let placeholder = contentEl.querySelector(':scope > .empty-content');
      if (mats || funs) {
        const isEmpty = (!mats || !mats.children.length) && (!funs || !funs.children.length);
        if (isEmpty && !placeholder) contentEl.insertAdjacentHTML('afterbegin', `<div class="empty-content" style="padding:14px;margin:0">No items. Use the buttons above.</div>`);
        else if (!isEmpty && placeholder) placeholder.remove();
      } else {
        const hasContent = !!contentEl.querySelector(':scope > [data-uid], :scope > .project-group-block');
        if (!hasContent && !placeholder) contentEl.insertAdjacentHTML('beforeend', `<div class="empty-content" style="padding:14px;margin:0">No content. Click <strong>Add File</strong>, <strong>Add Description</strong>, or <strong>Add Group</strong> above.</div>`);
        else if (hasContent && placeholder) placeholder.remove();
      }
    }

    function refreshTopLevelPlaceholder() {
      const sec = SECTIONS.find(s => s.id === S.section);
      if (!sec) return;
      const body = document.getElementById('section-body');
      if (!body) return;
      const listEl = sec.id === 'links' ? (document.getElementById('links-cards-body') || body) : body;
      const hasItems = !!listEl.querySelector(':scope > [data-uid], :scope > .module');
      let placeholder = listEl.querySelector(':scope > .empty-content');
      if (!hasItems && !placeholder) listEl.insertAdjacentHTML('beforeend', `<div class="empty-content">No ${sec.label.toLowerCase()} yet.</div>`);
      else if (hasItems && placeholder) placeholder.remove();
    }

    // ── Add flows: create the row locally, insert its (empty) card into the right spot,
    // then immediately open it for inline editing — no dialogue, no DB write yet. ──

    function addModule() {
      closeInlineEdit();
      const body = document.getElementById('section-body');
      const emptyMsg = body.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const uids = [...body.querySelectorAll(':scope > .module[data-uid]')].map(el => el.dataset.uid);
      const maxOrder = Math.max(0, ...uids.map(u => parseInt(ROW_STORE[u]?.b) || 0));
      // f = Default State. Empty means "Hidden" on the public site, so a new module must default
      // to SHOW (Expanded) or it silently never appears — that's the "0 modules" footgun.
      const { uid, row } = addNewRow('module', { b: String(maxOrder + 1), f: 'SHOW' });
      const html = `<div class="module" data-uid="${x(uid)}">${moduleHeaderHtml(row)}${moduleContentHtml([])}</div>`;
      const topbar = body.querySelector(':scope > .section-topbar');
      if (topbar) topbar.insertAdjacentHTML('afterend', html); else body.insertAdjacentHTML('afterbegin', html);
      initDnD(SECTIONS.find(s => s.id === 'modules'));
      openInlineEdit(uid);
    }

    function addMaterialOrFunfact(moduleUid, type) {
      closeInlineEdit();
      const moduleEl = document.querySelector('#section-body > .module' + attrSel(moduleUid));
      if (!moduleEl) return;
      const listEl = moduleEl.querySelector(type === 'funfact' ? '.module-funfacts' : '.module-materials');
      if (!listEl) return;
      const emptyMsg = moduleEl.querySelector(':scope > .module-content > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const { uid, row } = addNewRow(type);
      listEl.insertAdjacentHTML('beforeend', type === 'funfact' ? funfactCardHtml(row) : materialCardHtml(row));
      initDnD(SECTIONS.find(s => s.id === 'modules'));
      openInlineEdit(uid);
    }

    function addProject() {
      closeInlineEdit();
      const body = document.getElementById('section-body');
      const emptyMsg = body.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const uids = [...body.querySelectorAll(':scope > .module[data-uid]')].map(el => el.dataset.uid);
      const maxOrder = Math.max(0, ...uids.map(u => parseInt(ROW_STORE[u]?.b) || 0));
      // See addModule: empty f = Hidden on the public site, so default a new project to SHOW.
      const { uid, row } = addNewRow('project', { b: String(maxOrder + 1), f: 'SHOW' });
      const html = `<div class="module" data-uid="${x(uid)}">${projectHeaderHtml(row)}<div class="module-content"><div class="empty-content" style="padding:14px;margin:0">No content. Click <strong>Add File</strong>, <strong>Add Description</strong>, or <strong>Add Group</strong> above.</div></div></div>`;
      body.insertAdjacentHTML('beforeend', html);
      initDnD(SECTIONS.find(s => s.id === 'projects'));
      openInlineEdit(uid);
    }

    function addProjectFile(projectUid) {
      closeInlineEdit();
      const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
      if (!moduleEl) return;
      const contentEl = moduleEl.querySelector(':scope > .module-content');
      if (!contentEl) return;
      const emptyMsg = contentEl.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const { uid, row } = addNewRow('project_file');
      contentEl.insertAdjacentHTML('beforeend', materialCardHtml(row));
      initDnD(SECTIONS.find(s => s.id === 'projects'));
      openInlineEdit(uid);
    }

    function hasProjectDescription(projectUid) {
      const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
      return !!(moduleEl && moduleEl.querySelector(':scope > .module-content > .project-desc-card'));
    }

    function addProjectDescription(projectUid) {
      if (hasProjectDescription(projectUid)) { toast('This project already has a description, edit it below', 'err'); return; }
      closeInlineEdit();
      const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
      if (!moduleEl) return;
      const contentEl = moduleEl.querySelector(':scope > .module-content');
      if (!contentEl) return;
      const emptyMsg = contentEl.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const { uid, row } = addNewRow('project_description');
      contentEl.insertAdjacentHTML('afterbegin', projectDescCardHtml(row));
      initDnD(SECTIONS.find(s => s.id === 'projects'));
      openInlineEdit(uid);
    }

    function addProjectGroup(projectUid) {
      closeInlineEdit();
      const moduleEl = document.querySelector('#section-body > .module' + attrSel(projectUid));
      if (!moduleEl) return;
      const contentEl = moduleEl.querySelector(':scope > .module-content');
      if (!contentEl) return;
      const emptyMsg = contentEl.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      const { uid, row } = addNewRow('project_group');
      contentEl.insertAdjacentHTML('beforeend', projectGroupBlockHtml(row, []));
      initDnD(SECTIONS.find(s => s.id === 'projects'));
      openInlineEdit(uid);
    }

    function addGroupFile(groupUid) {
      closeInlineEdit();
      const groupEl = document.querySelector('#section-body .project-group-block' + attrSel(groupUid));
      if (!groupEl) return;
      const { uid, row } = addNewRow('group_file');
      let filesEl = groupEl.querySelector(':scope > .pgb-files');
      if (!filesEl) {
        groupEl.insertAdjacentHTML('beforeend', '<div class="pgb-files"></div>');
        filesEl = groupEl.querySelector(':scope > .pgb-files');
      }
      filesEl.insertAdjacentHTML('beforeend', materialCardHtml(row));
      initDnD(SECTIONS.find(s => s.id === 'projects'));
      openInlineEdit(uid);
    }

    function addFlatRow(type) {
      closeInlineEdit();
      const defaults = {};
      if (type === 'announcement') defaults.d = currentDatetimeStr();
      const { uid, row } = addNewRow(type, defaults);
      const body = document.getElementById('section-body');
      const container = document.getElementById('links-cards-body') || body;
      const emptyMsg = container.querySelector(':scope > .empty-content');
      if (emptyMsg) emptyMsg.remove();
      container.insertAdjacentHTML('beforeend', flatCardHtml(row));
      const sec = SECTIONS.find(s => s.types.includes(type));
      initDnD(sec);
      openInlineEdit(uid);
    }

    // ── Save: diff the section's current DOM state against the database and reconcile ──

    function collectSectionUids(sec) {
      const body = document.getElementById('section-body');
      if (sec.hier || sec.proj) {
        // allUids = rows this section actually owns (for the upsert/delete diff and row_index).
        // topUids = every top-level card in DOM order (used only to assign the shared Order).
        // In the Modules view, project refs are top-level too, but they are NOT owned here — their
        // rows stay untouched apart from the Order (`b`) written back in saveSectionChanges.
        const allUids = [];
        const topUids = [];
        body.querySelectorAll(':scope > .module').forEach(modEl => {
          const uid = modEl.dataset.uid;
          if (!uid) return;
          topUids.push(uid);
          if (modEl.classList.contains('project-ref')) return; // owned by the Projects tab
          allUids.push(uid);
          modEl.querySelectorAll('.module-content [data-uid]').forEach(el => allUids.push(el.dataset.uid));
        });
        return { allUids, topUids };
      }
      const container = document.getElementById('links-cards-body') || body;
      const allUids = [...container.querySelectorAll(':scope > [data-uid]')].map(el => el.dataset.uid);
      return { allUids, topUids: allUids };
    }

    async function saveSectionChanges(sectionId) {
      const sec = SECTIONS.find(s => s.id === sectionId);
      if (!sec) return;
      closeInlineEdit();

      const btn = document.getElementById('section-save-btn');
      const origHtml = btn ? btn.innerHTML : '';
      const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = origHtml; } };
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }

      if (sectionId === 'links') {
        const ttErr = await saveTimetablesWork();
        if (ttErr) { toast('Save failed: ' + ttErr, 'err'); resetBtn(); return false; }
      }

      const { allUids, topUids } = collectSectionUids(sec);

      // The shared module/project Order (`b`) is owned by the MODULES view — its top-level cards
      // (modules + project refs) are renumbered from their drag order, highest on top. This is
      // what keeps modules and projects on one clash-free number line: a new module dropped after
      // project #9 becomes #10, not another #9. The Projects tab never touches the Order.
      if (sec.hier && topUids.length > 1) {
        // Surface a pre-existing clash (e.g. two items hand-typed to the same number) before we
        // silently renumber, so the fix is visible rather than mysterious.
        const seen = new Set(); let clash = false;
        for (const uid of topUids) { const b = (ROW_STORE[uid]?.b || '').trim(); if (b && seen.has(b)) clash = true; seen.add(b); }
        if (clash) toast('Some Order numbers clashed. Renumbered automatically...', 'err');
        const n = topUids.length;
        topUids.forEach((uid, i) => { if (ROW_STORE[uid]) ROW_STORE[uid].b = String(n - i); });
      }

      const { data: existing, error: fetchErr } = await sb.from('course_rows').select('row_uid')
        .eq('sheet_name', S.course).eq('is_archive', S.isArchive).in('type', sec.types);
      if (fetchErr) { toast('Save failed: ' + fetchErr.message, 'err'); resetBtn(); return false; }

      // Each section keeps its own 10k row_index band so the public site's global row_index walk
      // never interleaves two sections' rows (which would misattach materials to a parent). The
      // public page interleaves modules & projects for display by sorting on the shared Order.
      const base = SECTION_ROW_BASE[sectionId] || 0;
      const existingUids = new Set((existing || []).map(r => r.row_uid));
      const finalSet = new Set(allUids);
      const toDelete = [...existingUids].filter(u => !finalSet.has(u));
      const toUpsert = allUids.map((uid, i) => {
        const row = ROW_STORE[uid];
        return row ? { ...row, row_index: base + (i + 1) * 10 } : null;
      }).filter(Boolean);

      if (toDelete.length) {
        const { error } = await sb.from('course_rows').delete().in('row_uid', toDelete);
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }
      if (toUpsert.length) {
        const { error } = await sb.from('course_rows').upsert(toUpsert, { onConflict: 'row_uid' });
        if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
      }

      // Modules view also owns project ordering: persist the reordered project refs' Order only,
      // leaving their content and row_index (their own band) untouched.
      if (sec.hier) {
        const projRows = topUids.map(uid => ROW_STORE[uid]).filter(r => r && r.type === 'project');
        if (projRows.length) {
          const { error } = await sb.from('course_rows').upsert(projRows.map(r => ({ ...r })), { onConflict: 'row_uid' });
          if (error) { toast('Save failed: ' + error.message, 'err'); resetBtn(); return false; }
        }
      }

      toast('Saved', 'ok');
      await loadSection(sectionId);
      return true;
    }

    async function modalSave() {
      const btn = document.getElementById('modal-save');
      btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Saving…';
      const type = document.getElementById('m_type').value;
      const row = {
        row_uid: document.getElementById('m_uid').value,
        sheet_name: document.getElementById('m_sheet').value,
        is_archive: document.getElementById('m_archive').value === 'true',
        row_index: parseInt(document.getElementById('m_index').value),
        type: type === '_custom' ? 'metadata' : type,
        b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: ''
      };
      for (const f of (FIELDS[type] || [])) {
        const el = document.getElementById('mf_' + f.col);
        if (!el) continue;
        row[f.col] = f.dt && el.value ? fromIsoDatetime(el.value) : (el.value || '');
      }
      const { error } = await sb.from('course_rows').upsert(row, { onConflict: 'row_uid' });
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check" style="margin-right:5px"></i>Save';
      if (error) { toast('Save failed: ' + error.message, 'err'); return; }
      ROW_STORE[row.row_uid] = row;
      toast('Saved', 'ok'); closeModal();
      if (S.section === 'info') await loadMetadataSettings();
      else await loadSection(S.section);
    }

    async function deleteRow(uid) {
      if (!await confirmDialog('This row will be permanently deleted.', { title: 'Delete this row?', okLabel: 'Delete', danger: true })) return;
      const { error } = await sb.from('course_rows').delete().eq('row_uid', uid);
      if (error) { toast('Delete failed: ' + error.message, 'err'); return; }
      delete ROW_STORE[uid]; toast('Deleted', 'ok');
      if (S.section === 'info') await loadMetadataSettings();
      else await loadSection(S.section);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Course management
    // ─────────────────────────────────────────────────────────────────────────────

    function openNewCourseModal() {
      document.getElementById('modal-title').textContent = 'New Course';
      document.getElementById('modal-save').innerHTML = '<i class="fa-solid fa-plus" style="margin-right:5px"></i>Create';
      document.getElementById('modal-save').onclick = createCourse;
      document.getElementById('modal-foot').style.display = '';
      document.getElementById('modal-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Sheet Name (DB key)</label>
      <input type="text" id="nc_sheet">
      <div class="form-hint">Unique ID: letters, digits, underscores. Cannot be changed later.</div>
    </div>
    <div class="form-group"><label class="form-label">Course Code</label><input type="text" id="nc_code"></div>
    <div class="form-group"><label class="form-label">Course Title</label><input type="text" id="nc_title"></div>
    <div class="form-group"><label class="form-label">Academic Year</label><input type="text" id="nc_year" oninput="onYearInput(this)" onblur="normalizeYearField(this)"></div>
    <div class="form-group">
      <label class="form-label">Semester</label>
      <select id="nc_sem">
        <option value=""></option>
        <option>Fall Semester</option><option>Spring Semester</option><option>Summer Semester</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Status</label>
      <select id="nc_archive"><option value="false">Active</option><option value="true">Archived</option></select>
    </div>
  `;
      document.getElementById('modal-overlay').classList.add('open');
    }

    async function createCourse() {
      const sheet = document.getElementById('nc_sheet').value.trim();
      const code = document.getElementById('nc_code').value.trim();
      const title = document.getElementById('nc_title').value.trim();
      const year = document.getElementById('nc_year').value.trim();
      const sem = document.getElementById('nc_sem').value.trim();
      const archive = document.getElementById('nc_archive').value === 'true';
      if (!sheet) { toast('Sheet name is required', 'err'); return; }
      const btn = document.getElementById('modal-save'); btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:5px"></i>Creating…';
      const base = { sheet_name: sheet, is_archive: archive, type: 'metadata', b: '', c: '', d: '', e: '', f: '', g: '', h: '', i: '', j: '' };
      const rows = [];
      if (code) rows.push({ ...base, row_uid: sheet + ':10', row_index: 10, b: 'code', c: code });
      if (title) rows.push({ ...base, row_uid: sheet + ':20', row_index: 20, b: 'title', c: title });
      if (year) rows.push({ ...base, row_uid: sheet + ':25', row_index: 25, b: 'year', c: year });
      if (sem) rows.push({ ...base, row_uid: sheet + ':30', row_index: 30, b: 'semester', c: sem });
      if (!rows.length) rows.push({ ...base, row_uid: sheet + ':10', row_index: 10, b: 'code', c: sheet });
      const { error } = await sb.from('course_rows').insert(rows);
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus" style="margin-right:5px"></i>Create';
      if (error) { toast('Create failed: ' + error.message, 'err'); return; }
      document.getElementById('modal-save').onclick = modalSave;
      closeModal(); toast('Course created', 'ok');
      await loadSidebar();
      S.course = sheet; S.isArchive = archive; S.section = getLastSection(sheet, archive);
      renderCourseShell(sheet, archive);
      await loadSidebar();
    }

    // ── Archive naming ───────────────────────────────────────────────────────
    // sheet_name doubles as the public course link (teaching/index.html reads #<sheet_name>), so
    // teaching the same code twice would leave two courses fighting over one URL. Archiving stamps
    // the offering onto the key — CE_132 + "Fall Semester" + "2024–2025" → CE_132_Fall2425 — which
    // frees the bare code for the next offering; restoring strips the stamp back off.
    const COURSE_SUFFIX_RE = /_(Fall|Spring|Summer)(\d{4})?$/;

    function courseNameBase(name) { return String(name || '').replace(COURSE_SUFFIX_RE, ''); }

    // '' when there's no semester to stamp: a bare year ("_2425") is indistinguishable from the tail
    // of a course code, so courseNameBase() could not strip it off again on restore.
    function courseNameSuffix(semester, year) {
      const sem = (String(semester || '').match(/^\s*(Fall|Spring|Summer)/) || [])[1];
      if (!sem) return '';
      const ym = String(year || '').match(/(\d{4})\D*(\d{4})?/);
      if (!ym) return '_' + sem;
      const start = parseInt(ym[1], 10);
      const end = ym[2] ? parseInt(ym[2], 10) : start + 1;
      const yy = v => String(v % 100).padStart(2, '0');
      return `_${sem}${yy(start)}${yy(end)}`;
    }

    async function courseMetaValues(name, isArchive, keys) {
      const { data, error } = await sb.from('course_rows').select('b,c')
        .eq('sheet_name', name).eq('is_archive', isArchive).eq('type', 'metadata').in('b', keys);
      if (error) return null;
      const m = {};
      for (const r of (data || [])) m[r.b] = r.c;
      return m;
    }

    // "CE 132 Structural Analysis" — how the course is named to the user, since the sheet name is
    // an internal key. Falls back to it for a course with no code or title of its own.
    function courseLabel(meta, sheetName) {
      const parts = [...new Set([meta.code, meta.title].filter(Boolean))];
      return parts.join(' ').trim() || sheetName;
    }

    // Names already used in the group we're moving into. sheet_name only has to be unique per
    // archive flag — the public page queries one flag at a time.
    async function takenCourseNames(isArchive) {
      const { data, error } = await sb.from('course_rows').select('sheet_name')
        .eq('is_archive', isArchive).eq('type', 'metadata');
      if (error) return null;
      return new Set((data || []).map(r => r.sheet_name));
    }

    // Moves a course between the active/archived groups, optionally under a new sheet_name. The
    // sheet_name-derived row_uids ("CE_132:adm_code") must be rewritten alongside it — a later
    // course reusing the bare code mints those same uids, and would silently overwrite this
    // course's rows on its first upsert. Rows are inserted under the new key before the old ones
    // are deleted, so a failure part-way leaves the original course untouched.
    async function moveCourse(oldName, newName, fromArchive) {
      const toArchive = !fromArchive;
      if (newName === oldName) {
        const { error } = await sb.from('course_rows').update({ is_archive: toArchive })
          .eq('sheet_name', oldName).eq('is_archive', fromArchive);
        return error;
      }
      const { data, error } = await sb.from('course_rows').select('*')
        .eq('sheet_name', oldName).eq('is_archive', fromArchive);
      if (error) return error;
      const rows = data || [];
      if (!rows.length) return { message: `no rows found for "${oldName}"` };
      const prefix = oldName + ':';
      const moved = rows.map(r => {
        const uid = String(r.row_uid);
        return {
          ...r,
          sheet_name: newName,
          is_archive: toArchive,
          row_uid: newName + ':' + (uid.startsWith(prefix) ? uid.slice(prefix.length) : uid),
        };
      });
      const { error: insErr } = await sb.from('course_rows').insert(moved);
      if (insErr) return insErr;
      const { error: delErr } = await sb.from('course_rows').delete()
        .in('row_uid', rows.map(r => r.row_uid));
      return delErr || null;
    }

    async function archiveCourse(n) {
      const meta = await courseMetaValues(n, false, ['semester', 'year', 'code', 'title']);
      if (!meta) { toast('Could not read the course metadata', 'err'); return; }
      // Strip any existing stamp before re-adding one, so archiving a restored course (which kept
      // its stamp because the bare code was taken) can't append a second one.
      const suffix = courseNameSuffix(meta.semester, meta.year);
      const target = suffix ? courseNameBase(n) + suffix : n;

      if (target !== n) {
        const taken = await takenCourseNames(true);
        if (!taken) { toast('Could not check the archived course names', 'err'); return; }
        if (taken.has(target)) {
          toast(`"${target}" is already archived. Change this course's semester or year first`, 'err');
          return;
        }
      }

      // The only case worth a word: with no semester there's nothing to file the offering under.
      const tip = suffix ? '' : '\n\nTip: set a Semester on the Info tab to file it under its academic year.';
      if (!await confirmDialog(`This course will be moved to your archived courses list.${tip}`,
        { title: `Archive ${courseLabel(meta, n)}?`, okLabel: 'Archive' })) return;

      const error = await moveCourse(n, target, false);
      if (error) { toast('Failed: ' + error.message, 'err'); return; }
      toast(target === n ? 'Archived' : `Archived as ${target}`, 'ok');
      S.course = null; clearMain(); await loadSidebar();
    }

    async function restoreCourse(n) {
      const meta = await courseMetaValues(n, true, ['code', 'title']);
      if (!meta) { toast('Could not read the course metadata', 'err'); return; }
      const base = courseNameBase(n);
      let target = n;
      if (base !== n) {
        const taken = await takenCourseNames(false);
        if (!taken) { toast('Could not check the active course names', 'err'); return; }
        // An active course already holds the bare code — keep the stamp so both keep a distinct link.
        target = taken.has(base) ? n : base;
      }
      if (!await confirmDialog('This course will be moved back to your active courses list.',
        { title: `Restore ${courseLabel(meta, n)}?`, okLabel: 'Restore' })) return;

      const error = await moveCourse(n, target, true);
      if (error) { toast('Failed: ' + error.message, 'err'); return; }
      toast(target === n ? 'Restored' : `Restored as ${target}`, 'ok');
      S.course = null; clearMain(); await loadSidebar();
    }
    async function deleteCourse(n, a) {
      if (!await confirmDialog('This CANNOT be undone.', { title: `Permanently delete ALL data for "${n}"?`, okLabel: 'Delete Everything', danger: true })) return;
      const { error } = await sb.from('course_rows').delete().eq('sheet_name', n).eq('is_archive', a);
      if (error) { toast('Failed: ' + error.message, 'err'); return; }
      toast(`"${n}" deleted`, 'ok'); S.course = null; clearMain(); await loadSidebar();
    }

    function clearMain() {
      document.getElementById('main-area').innerHTML =
        `<div class="no-course"><div><h3>No course selected</h3><p>Choose from the sidebar or create a new one.</p></div></div>`;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Theme
    // ─────────────────────────────────────────────────────────────────────────────

    function setupThemeToggle() {
      const KEY = 'theme-preference';
      const icons = { auto: 'fa-solid fa-adjust', light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon' };
      const getSaved = () => localStorage.getItem(KEY) || 'auto';
      const currentIsDark = () => {
        const forced = document.documentElement.getAttribute('data-theme');
        if (forced) return forced === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      };
      const updateThemeColorMeta = () => {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', currentIsDark() ? '#000000' : '#f4f4f4');
      };
      const updateUI = (pref) => {
        const oldIcon = document.getElementById('theme-toggle-icon');
        if (oldIcon) {
          const i = document.createElement('i');
          i.id = 'theme-toggle-icon';
          i.className = icons[pref] || icons.auto;
          i.setAttribute('aria-hidden', 'true');
          oldIcon.replaceWith(i);
        }
        const btn = document.getElementById('theme-toggle');
        if (btn) {
          const label = pref.charAt(0).toUpperCase() + pref.slice(1);
          btn.setAttribute('aria-label', `Theme: ${label}`);
          btn.title = `Theme: ${label}`;
        }
      };
      const applyTheme = (pref) => {
        const html = document.documentElement;
        if (pref === 'auto') html.removeAttribute('data-theme');
        else html.setAttribute('data-theme', pref);
        localStorage.setItem(KEY, pref);
        updateUI(pref);
        updateThemeColorMeta();
      };
      applyTheme(getSaved());
      const btn = document.getElementById('theme-toggle');
      if (btn) {
        btn.addEventListener('click', () => {
          const cur = getSaved();
          const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          applyTheme(cur === 'auto' ? (isSystemDark ? 'light' : 'dark') : 'auto');
        });
      }
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getSaved() === 'auto') applyTheme('auto');
      });
    }

    const _yr = document.getElementById('currentYear');
    if (_yr) _yr.textContent = new Date().getFullYear();

    // Footer branding + favicon + default colour palette from config.js, so the markup
    // and CSS stay identical across deployments (only config.js differs).
    (function applyConfig() {
        const cfg = window.TEACHING_CONFIG || {};
        const owner = cfg.owner || {};
        const cv = document.getElementById('footer-cv');
        if (cv && owner.cvUrl) cv.href = owner.cvUrl;
        const email = document.getElementById('footer-email');
        if (email && owner.email) email.href = 'mailto:' + owner.email;
        const name = document.getElementById('footer-owner');
        if (name && owner.name) name.textContent = owner.name;
        const startYear = document.getElementById('footer-start-year');
        if (startYear && owner.startYear) startYear.textContent = owner.startYear;
        const home = document.getElementById('footer-home');
        if (home && owner.homeUrl) home.href = owner.homeUrl;
        const favicon = document.querySelector('link[rel="icon"]');
        if (favicon && owner.faviconUrl) favicon.href = owner.faviconUrl;

        const t = cfg.theme || {};
        const root = document.documentElement.style;
        const map = {
            '--primary-color': t.primary, '--primary-dark': t.primaryDark,
            '--secondary-color': t.secondary, '--tertiary-color': t.tertiary,
            '--accent-color': t.accent, '--success-color': t.success,
        };
        Object.keys(map).forEach(k => { if (map[k]) root.setProperty(k, map[k]); });
    })();

    setupThemeToggle();

    // ─────────────────────────────────────────────────────────────────────────────
    // Drag & Drop
    // ─────────────────────────────────────────────────────────────────────────────

    const DND_OPTS = {
      animation: 180,
      handle: '.drag-handle',
      ghostClass: 'dnd-ghost',
      chosenClass: 'dnd-chosen',
      forceFallback: true,
      delay: 250,
      delayOnTouchOnly: true,
      touchStartThreshold: 5,
      preventOnFilter: false,
      onEnd: () => markDirty(), // a reorder is an unsaved change
    };

    // Drag-and-drop only ever reorders DOM nodes now — nothing is persisted here. The tab's
    // Save button reads the final DOM order directly (see collectSectionUids/saveSectionChanges).
    // Because Add actions insert into the *existing* DOM (rather than reloading the whole
    // section from the database), this gets called again after every add — so it must not
    // attach a second, duplicate Sortable instance to a container that's already managed.
    function ensureSortable(el, opts) {
      if (!el || Sortable.get(el)) return;
      Sortable.create(el, opts);
    }

    function initDnD(sec) {
      if (!sec || !window.Sortable) return;
      const body = document.getElementById('section-body');
      if (!body) return;

      if (sec.hier) {
        const modules = body.querySelectorAll(':scope > .module[data-uid]');
        if (modules.length > 1) {
          ensureSortable(body, { ...DND_OPTS, filter: '.section-topbar, .empty-content' });
        }
        // Inner level: materials and fun facts live in two physically separate lists, so
        // dragging can only reorder within each kind — a fun fact can never end up above a
        // material, since it's never possible to drag between the two containers.
        body.querySelectorAll('.module-materials, .module-funfacts').forEach(listEl => {
          ensureSortable(listEl, { ...DND_OPTS, filter: '.inline-edit-panel' });
        });
      } else if (sec.proj) {
        const modules = body.querySelectorAll(':scope > .module[data-uid]');
        if (modules.length > 1) {
          ensureSortable(body, { ...DND_OPTS, filter: '.section-topbar, .empty-content' });
        }
      } else {
        // Simple flat list of material-cards. On the Links tab, cards live nested inside
        // #links-cards-body (inside the unified settings-group shell) rather than directly
        // under #section-body, so Sortable needs to operate on that inner container instead.
        const container = document.getElementById('links-cards-body') || body;
        const cards = container.querySelectorAll(':scope > .material-card[data-uid]');
        if (cards.length > 1) {
          ensureSortable(container, { ...DND_OPTS, filter: '.section-topbar, .empty-content, .inline-edit-panel' });
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────────

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
      document.getElementById('modal-foot').style.display = '';
    }

    // Styled stand-in for window.confirm(). Resolves true/false; used with await.
    let _confirmOverlayMD = false;
    let _confirmResolve = null;
    function _resolveConfirm(val) {
      document.getElementById('confirm-overlay').classList.remove('open');
      const resolve = _confirmResolve;
      _confirmResolve = null;
      if (resolve) resolve(val);
    }
    // Resolves true (OK), false (Cancel / backdrop), or 'alt' (the optional middle button,
    // e.g. "Discard"). altLabel is only shown when provided.
    function confirmDialog(message, opts = {}) {
      const { title = 'Please Confirm', okLabel = 'Confirm', danger = false, altLabel = '', okIcon = 'fa-check' } = opts;
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-body').textContent = message;
      const okBtn = document.getElementById('confirm-ok-btn');
      okBtn.className = 'btn-sm' + (danger ? ' btn-red' : '');
      okBtn.innerHTML = `<i class="fa-solid ${okIcon}" style="margin-right:5px"></i>${x(okLabel)}`;
      const altBtn = document.getElementById('confirm-alt-btn');
      if (altLabel) {
        altBtn.style.display = '';
        altBtn.innerHTML = `<i class="fa-solid fa-trash-can" style="margin-right:5px"></i>${x(altLabel)}`;
      } else {
        altBtn.style.display = 'none';
      }
      if (_confirmResolve) _resolveConfirm(false);
      document.getElementById('confirm-overlay').classList.add('open');
      return new Promise(resolve => { _confirmResolve = resolve; });
    }

    // ── Keyboard shortcuts ──
    // Escape dismisses whatever is topmost (confirm dialog → modal → inline editor → mobile
    // drawer); Ctrl/Cmd+S saves the open tab instead of triggering the browser's Save Page.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (document.getElementById('confirm-overlay').classList.contains('open')) { _resolveConfirm(false); return; }
        if (document.getElementById('modal-overlay').classList.contains('open')) { closeModal(); return; }
        if (_inlineEditUid) { requestCloseInlineEdit(); return; }
        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('mobile-open')) toggleSidebar();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        if (document.getElementById('admin-app').style.display !== 'flex' || !S.course) return;
        e.preventDefault(); // never fall through to the browser's Save Page dialog
        if (document.getElementById('confirm-overlay').classList.contains('open') ||
          document.getElementById('modal-overlay').classList.contains('open')) return;
        const saveBtn = document.getElementById('section-save-btn');
        if (saveBtn && saveBtn.disabled) return; // a save is already running
        saveCurrentSection();
      }
    });

    // Academic Year field: the instant a 4-digit start year is typed, the next year is filled
    // in live ("2024" -> "2024–2025") with the cursor left right after the typed digits so the
    // user can keep typing or tab away. onblur is a safety net that normalizes anything typed
    // or pasted in another shape (e.g. "2024-2025", "2024/2025") to the same en-dash format.
    function onYearInput(el) {
      const raw = el.value;
      if (/^\d{4}$/.test(raw)) {
        el.value = `${raw}–${parseInt(raw, 10) + 1}`;
        el.setSelectionRange(4, 4);
      }
    }
    function normalizeYearField(el) {
      const raw = el.value.trim();
      if (!raw) return;
      const m = raw.match(/(\d{4})\D*(\d{4})?/);
      if (!m) return;
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start + 1;
      el.value = `${start}–${end}`;
    }

    function x(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function xh(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    let _tt;
    function toast(msg, type) {
      const el = document.getElementById('toast');
      const icon = type === 'ok' ? 'fa-circle-check' : type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-info';
      el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${x(msg)}</span>`;
      el.className = 'toast show' + (type ? ' ' + type : '');
      // Errors linger longer so the reason is actually readable before it fades.
      clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), type === 'err' ? 6000 : 3000);
    }
