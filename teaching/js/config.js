/* ==========================================================================
   config.js — per-deployment configuration for the Teaching pages.

   This is the ONE file that differs between you and a colleague running their
   own copy. Everything else (index.html, admin/, scripts, CSS) is identical
   across deployments, so pulling upstream updates never touches your settings.

   Loaded by both js/scripts.js (public page) and admin/js/scripts.js.

   These values are safe to commit and are public by design:
     - supabaseAnonKey is meant to be exposed to the browser; your data is
       protected by Supabase Row-Level Security, not by hiding this key.
     - googleClientId only identifies the app to Google; it grants nothing on
       its own.

   NOTE: on GitHub Pages this file MUST be committed — Pages only serves
   committed files, so a gitignored config would 404 and break the site.
   ========================================================================== */
window.TEACHING_CONFIG = {
    // --- Supabase (public course page + admin) ---
    supabaseUrl: 'https://sreqxyznaymvksygradu.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyZXF4eXpuYXltdmtzeWdyYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMDQ5NzksImV4cCI6MjA5NTc4MDk3OX0.-B-vzU8ZRkUnEp697N0nclLvomdP2k-dt9fPcJNV-gY',

    // --- Google Sign-In (admin login only; public page ignores this) ---
    googleClientId: '740588046540-975b4g8i4915hps31p1ioi0e000f4boi.apps.googleusercontent.com',

    // --- Google Drive Picker (admin file forms only; optional) ---
    // Lets the "pick from Drive" button browse your Drive instead of pasting a link.
    // Leave blank to still use the picker with just your OAuth token — a Google Cloud
    // API key (developer key) only removes Google's quota nag and is otherwise optional.
    // Restrict the key to the Picker API + your site's referrer before committing it.
    googleApiKey: '',

    // --- Floating cat companion on the public course page (true = shown) ---
    catCompanion: true,

    // --- Branding / links shown in the footer of both pages ---
    owner: {
        name: 'Bredli Plaku',
        email: 'bplaku@epoka.edu.al',
        cvUrl: 'https://eis.epoka.edu.al/cv/fullcv/655',
        homeUrl: '/',              // where the footer "home" icon points
        faviconUrl: '/favicon.png', // browser-tab icon
        startYear: 2023,           // first year of the copyright range
    },

    // --- Default colour palette. Applied to both the public page and admin.
    //     On the public page, a course's own custom colours still override these. ---
    theme: {
        primary: '#3949ab',
        primaryDark: '#1a237e',
        secondary: '#ffa726',
        tertiary: '#2196F3',
        accent: '#9c27b0',
        success: '#43a047',
    },
};
