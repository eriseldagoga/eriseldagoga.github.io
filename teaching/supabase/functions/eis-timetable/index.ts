// EIS timetable proxy — Supabase Edge Function (Deno).
//
// Why this exists: eis.epoka.edu.al sends no CORS headers, so the browser
// cannot fetch it directly from the course page. Supabase's REST API can't
// help either — it only queries the database. This function runs server-side,
// fetches the EIS timetable fragment, extracts the <table>, and returns it as
// HTML the frontend drops straight into #native-timetable-container.
//
// Deploy:
//   supabase functions deploy eis-timetable --project-ref sreqxyznaymvksygradu
//
// verify_jwt is OFF for this function (toggled in the Supabase dashboard). It
// must be: a CORS preflight (OPTIONS) request never carries an Authorization
// header, so if the platform-level JWT check were on, it would reject the
// preflight itself before this code ever runs — the exact "preflight doesn't
// pass access control check" error browsers report. That's fine here: this
// proxies a public EIS timetable page with no user-specific data, read-only,
// with input validated as digits-only below.
//
// Why GET /{tId}/show/programgrade/{cId}/ instead of POSTing the form: the
// POST to /publictimetable only returns the picker page. The actual table is
// loaded by EIS's own frontend from this endpoint, which returns a
// self-contained fragment (a namespaced <style> block + one <table>, no
// scripts). We proxy that directly.

const EIS_BASE = "https://eis.epoka.edu.al/publictimetable";
const CACHE_SECONDS = 1800; // 30 min — timetables change rarely mid-semester

// Only the site's own origins get a browser-readable response. This doesn't
// stop direct/non-browser callers (curl, scripts) — CORS can't, since it's a
// browser-enforced check, not server-side auth — but it does stop some other
// website's frontend JS from quietly embedding calls to this endpoint and
// spending your invocation quota / EIS's bandwidth under your name.
const ALLOWED_ORIGINS = new Set([
  "https://bredliplaku.com",
  "https://www.bredliplaku.com",
  "https://bredliplaku.github.io",
]);

// Any port: local dev servers (VS Code Live Server, `python -m http.server`,
// etc.) don't run on a fixed port. Safe to allow broadly — this only ever
// matches a server actually running on the caller's own machine, and the
// response has nothing sensitive in it either way.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = !!origin && (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN.test(origin));
  return {
    // Omitted (rather than "*") for a disallowed/absent origin — the browser
    // then has no matching header to accept, exactly as if CORS were denied.
    ...(allowed ? { "Access-Control-Allow-Origin": origin! } : {}),
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

const errorHtml = (msg: string) => `<div class="tt-error">${msg}</div>`;

/**
 * Keeps the fragment's own <style> block (it carries the timetable colours and
 * responsive breakpoints) through the final </table>, and strips scripts.
 */
function extractFragment(body: string): string {
  const tableStart = body.indexOf("<table");
  const tableEnd = body.lastIndexOf("</table>");
  if (tableStart === -1 || tableEnd === -1) return "";

  const styleStart = body.indexOf("<style");
  const start = styleStart !== -1 && styleStart < tableStart ? styleStart : tableStart;

  return body
    .substring(start, tableEnd + "</table>".length)
    .replace(/<script[\s\S]*?(<\/script>|$)/gi, "");
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const htmlHeaders = { ...cors, "Content-Type": "text/html; charset=utf-8" };

  const url = new URL(req.url);
  const tId = (url.searchParams.get("tId") ?? "").trim();
  const cId = (url.searchParams.get("cId") ?? "").trim();

  if (!/^\d+$/.test(tId) || !/^\d+$/.test(cId)) {
    return new Response(errorHtml("Invalid timetable request."), { headers: htmlHeaders });
  }

  try {
    const res = await fetch(`${EIS_BASE}/${tId}/show/programgrade/${cId}/`, { redirect: "follow" });
    if (!res.ok) throw new Error(`EIS returned HTTP ${res.status}`);

    const table = extractFragment(await res.text());
    if (!table) {
      // Valid-but-empty (wrong class id, or timetable no longer published).
      // Not cached, so it recovers as soon as EIS does.
      return new Response(errorHtml("No timetable found for this class."), { headers: htmlHeaders });
    }

    return new Response(table, {
      headers: { ...htmlHeaders, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    });
  } catch (_err) {
    return new Response(errorHtml("The timetable could not be loaded from EIS."), { headers: htmlHeaders });
  }
});
