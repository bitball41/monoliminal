// Both shipped apps are standalone HTML. Keep their embedded analytics view
// identical; run `node scripts/chat-analytics-ui.mjs` after editing this source.
import { readFile, writeFile } from 'node:fs/promises';

export const analyticsCss = `
/* CHAT_ANALYTICS_CSS_START */
.analytics-view { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: var(--text, #f5f3ff); margin: 18px 0; }
.analytics-kpis { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.analytics-kpi, .analytics-card { border:1px solid var(--line, #ffffff20); border-radius:14px; padding:16px; background:var(--surface, #ffffff06); min-width:0; }
.analytics-kpi strong { display:block; font-size:30px; font-weight:600; letter-spacing:-.035em; line-height:1.4; font-variant-numeric:tabular-nums; }
.analytics-kpi span, .analytics-note, .analytics-kpi small { color:var(--muted, #b8b3d3); font-size:12px; line-height:1.6; }
.analytics-kpi small { display:block; }
.analytics-card { margin-top:12px; }
.analytics-card h3 { margin:0 0 10px; font-size:15px; }
.analytics-toolbar { display:flex; align-items:center; gap:10px; justify-content:space-between; flex-wrap:wrap; margin-bottom:12px; }
.analytics-toolbar button, .analytics-toolbar select { font:inherit; font-size:12px; color:inherit; background:var(--surface, #ffffff08); border:1px solid var(--line, #ffffff20); border-radius:8px; padding:8px 12px; cursor:pointer; }
.analytics-chart svg { display:block; width:100%; height:auto; max-height:200px; }
.analytics-chart rect:focus, .analytics-chart rect:hover { fill:var(--accent-strong,#a78bfa); stroke:var(--text,#fff); stroke-width:1; outline:none; }
.analytics-inspector { display:block; min-height:24px; margin:6px 0 0; font-size:12px; color:var(--text-soft,#d7d3e8); font-variant-numeric:tabular-nums; }
.analytics-view [aria-busy="true"] { opacity:.65; }
.analytics-table caption { text-align:left; padding:8px; color:var(--muted,#b8b3d3); font-size:12px; }
.analytics-chart text { fill:var(--muted, #b8b3d3); font-size:11px; }
.analytics-chart .analytics-missing { fill:#77738a; opacity:.5; }
.analytics-scroll { overflow-x:auto; }
.analytics-table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric:tabular-nums; }
.analytics-table th, .analytics-table td { text-align:right; padding:9px 8px; border-bottom:1px solid var(--line, #ffffff16); white-space:nowrap; }
.analytics-table th:first-child, .analytics-table td:first-child { text-align:left; }
.analytics-table th { color:var(--muted, #b8b3d3); font-weight:500; }
.analytics-note { margin:10px 0; }
.analytics-view details summary { cursor:pointer; font-size:13px; padding:8px 0; }
@media(max-width:600px) { .analytics-kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } .analytics-kpi { padding:12px; } }
/* CHAT_ANALYTICS_CSS_END */
`;

export const analyticsJs = `
    /* CHAT_ANALYTICS_UI_START */
    function analyticsNumber(value) {
      return value == null ? '—' : Number(value).toLocaleString();
    }
    function analyticsChart(summary, key = 'messages') {
      const daily = summary.daily || [], max = Math.max(1, ...daily.map(row => Number(row[key] || 0)));
      const labels = { messages: 'Public messages', accounts: 'Active accounts', browsers: 'Browser IDs', dms: 'Private messages' };
      return '<svg viewBox="0 0 720 180" role="img" aria-label="' + esc(labels[key]) + ' by day; exact values in the daily table">'
        + '<text x="0" y="13">' + analyticsNumber(max) + '</text>'
        + daily.map((row, i) => {
          const missing = row[key] == null, height = missing ? 3 : Math.max(1, Number(row[key]) / max * 125);
          const title = row.day + ': ' + (missing ? 'not tracked' : analyticsNumber(row[key]) + ' ' + labels[key].toLowerCase());
          return '<rect data-analytics-bar tabindex="0" x="' + (i * 23 + 22) + '" y="' + (150 - height) + '" width="17" height="' + height + '" rx="3" fill="#8b72eb" class="' + (missing ? 'analytics-missing' : '') + '" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title></rect>';
        }).join('') + '<text x="22" y="175">' + esc(daily[0]?.day || '') + '</text><text x="716" y="175" text-anchor="end">' + esc(daily.at(-1)?.day || '') + '</text></svg>';
    }
    function analyticsMarkup(summary) {
      if (!summary || !Array.isArray(summary.daily)) return '<p class="analytics-note" role="status">Analytics unavailable. Refresh to retry.</p>';
      const age = Date.parse(summary.generated_at) - Date.parse(summary.activity_since);
      const current = Number(summary.messages_24h || 0), previous = Number(summary.messages_previous_24h || 0);
      const change = previous ? (current > previous ? '+' : '') + ((current - previous) / previous * 100).toFixed(1) + '% vs prior 24h' : 'Prior 24h: ' + analyticsNumber(previous);
      const cards = [
        ['Active today',summary.dau,'Distinct signed-in accounts'],
        ['Active · 7 days',summary.wau,age < 7*86400000 ? 'Collecting first 7 days' : '7 calendar days, including today'],
        ['Active · 30 days',summary.mau,age < 30*86400000 ? 'Collecting first 30 days' : '30 calendar days, including today'],
        ['Browser IDs today',summary.browsers_today,'Shared across accounts on this browser'],
        ['Returning today',summary.returning_today,'Also observed on an earlier day'],
        ['Public messages · 24h',summary.messages_24h,change],
      ];
      const since = new Date(summary.activity_since).toLocaleString([], {timeZone:'America/Chicago'});
      const durable = new Date(summary.durable_messages_since).toLocaleString([], {timeZone:'America/Chicago'});
      const updated = new Date(summary.generated_at).toLocaleString([], {timeZone:'America/Chicago'});
      return '<div class="analytics-view"><div class="analytics-kpis">' + cards.map(([label,value,note]) => '<div class="analytics-kpi"><span>' + esc(label) + '</span><strong>' + analyticsNumber(value) + '</strong><small>' + esc(note) + '</small></div>').join('')
        + '</div><p class="analytics-note">Foreground in last 5m: ' + analyticsNumber(summary.foreground_5m) + ' accounts · Public senders in 7d: ' + analyticsNumber(summary.active_senders_7d) + ' · Signups in 7d: ' + analyticsNumber(summary.signups_7d) + '<br>Tracked public messages: ' + analyticsNumber(summary.messages_total) + ' · Currently visible: ' + analyticsNumber(summary.visible_messages) + ' · Private messages in 24h: ' + analyticsNumber(summary.dm_messages_24h) + '</p>'
        + '<section class="analytics-card"><div class="analytics-toolbar"><h3>Last 30 calendar days</h3><label>Show <select data-analytics-series aria-label="Chart metric"><option value="messages">Public messages</option><option value="accounts">Active accounts</option><option value="browsers">Browser IDs</option><option value="dms">Private messages</option></select></label></div><div class="analytics-chart">' + analyticsChart(summary) + '</div><output class="analytics-inspector" aria-live="polite">Hover or focus a bar for its exact count.</output>'
        + '<details><summary>Daily values</summary><div class="analytics-scroll"><table class="analytics-table"><caption>Daily activity · America/Chicago</caption><thead><tr><th scope="col">Chicago date</th><th scope="col">Accounts</th><th scope="col">Browsers</th><th scope="col">Public messages</th><th scope="col">Private messages</th><th scope="col">Signups</th></tr></thead><tbody>'
        + [...summary.daily].reverse().map(row => '<tr><th scope="row">' + esc(row.day) + '</th>' + ['accounts','browsers','messages','dms','signups'].map(key => '<td>' + analyticsNumber(row[key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></details></section>'
        + '<section class="analytics-card"><h3>Busiest public channels · rolling 7 days</h3><div class="analytics-scroll"><table class="analytics-table"><thead><tr><th scope="col">Channel</th><th scope="col">Messages</th><th scope="col">Senders</th></tr></thead><tbody>'
        + ((summary.top_channels || []).length ? summary.top_channels.map(row => '<tr><th scope="row">' + esc(row.label) + '</th><td>' + analyticsNumber(row.messages) + '</td><td>' + analyticsNumber(row.senders) + '</td></tr>').join('') : '<tr><td colspan="3">No public messages in the last 7 days.</td></tr>') + '</tbody></table></div></section>'
        + '<details class="analytics-card"><summary>Definitions & coverage</summary><p class="analytics-note">Active = chat was visible with interaction in the last 5 minutes. Refreshes and extra tabs do not add accounts. Browser IDs identify browser storage, not people or physical devices; clearing storage creates another ID. Bots and test accounts are excluded from engagement. Private conversations contribute counts only.</p>'
        + '<p class="analytics-note">Activity collection began ' + esc(since) + ' CT; its first day and today are partial. Older activity is unknown (—). Returning counts use only collected activity. The 7/30-day totals are observed counts until enough history accumulates. Calendar dates use America/Chicago, including daylight saving time; 24h and channel rankings use rolling windows.</p>'
        + '<p class="analytics-note">Message and signup history before ' + esc(durable) + ' CT comes from surviving database rows. Earlier hard-deleted records are unavailable. Future message deletions preserve sent totals; visible messages are counted separately. Historical exclusions use account classification when recorded. Updated ' + esc(updated) + ' CT.</p></details></div>';
    }
    function bindAnalyticsChart(root, summary) {
      const showValue = event => {
        const bar = event.target.closest?.('[data-analytics-bar]');
        const inspector = root.querySelector('.analytics-inspector');
        if (bar && inspector) inspector.textContent = bar.getAttribute('aria-label');
      };
      root.querySelector('.analytics-chart')?.addEventListener('pointerover', showValue);
      root.querySelector('.analytics-chart')?.addEventListener('focusin', showValue);
      root.querySelector('[data-analytics-series]')?.addEventListener('change', event => {
        const key = event.target.value;
        if (['messages','accounts','browsers','dms'].includes(key)) {
          root.querySelector('.analytics-chart').innerHTML = analyticsChart(summary,key);
          const inspector = root.querySelector('.analytics-inspector');
          if (inspector) inspector.textContent = 'Hover or focus a bar for its exact count.';
        }
      });
    }
    /* CHAT_ANALYTICS_UI_END */
`;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const path of ['Chat/chat.html','Admin/liminal-admin-dashboard.html']) {
    const url = new URL('../' + path, import.meta.url);
    let html = await readFile(url,'utf8');
    html = html.replace(/\s*\/\* CHAT_ANALYTICS_CSS_START \*\/[\s\S]*?\/\* CHAT_ANALYTICS_CSS_END \*\//,'');
    html = html.replace(/[ \t]*<\/style>/, analyticsCss + '\n</style>');
    html = html.replace(/\s*\/\* CHAT_ANALYTICS_UI_START \*\/[\s\S]*?\/\* CHAT_ANALYTICS_UI_END \*\//,'');
    const anchor = path.startsWith('Chat/') ? '    let staffPanel =' : '    function renderOverview()';
    html = html.replace(anchor, analyticsJs + '\n' + anchor);
    await writeFile(url,html);
  }
}
