# Capturing a scan from the browser

Playwright is not required to fill the paths database. Google renders the path
pages server-side, so an already signed-in Skills tab can fetch all 207 of them
itself. This is the fastest route when you already have the site open: no second
browser profile, no separate login, no headless rejection.

Measured on the live catalog: **207 paths, 1438 activities, about 2.5 minutes**,
running four requests at a time.

## Steps

1. Open <https://partner.skills.google/paths> in Chrome, signed in.
2. Open DevTools (`F12`) → Console.
3. Paste the script below and press Enter. It prints progress as it runs.
4. When it finishes it saves `skills-scan.json` through the browser's download.
5. Import it:

   ```bash
   npm run paths-import -- ~/Downloads/skills-scan.json
   ```

## The script

```js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

  // 1. Discover every path id from the learning-plan catalog (8 per page).
  const ids = new Set();
  for (let page = 1; page <= 30; page += 1) {
    const html = await (await fetch(`/catalog?format%5B%5D=learning_plans&page=${page}`, { credentials: 'include' })).text();
    const before = ids.size;
    for (const m of html.matchAll(/\/paths\/(\d+)/g)) ids.add(m[1]);
    if (ids.size === before) break;
    await sleep(120);
  }
  console.log(`discovered ${ids.size} paths`);

  // 2. Read each path page. Every activity card carries its own completion
  //    state, so this covers every course and lab in one pass.
  const results = [];
  const failed = [];
  const all = [...ids];
  const readOne = async (id) => {
    try {
      const res = await fetch(`/paths/${id}`, { credentials: 'include' });
      if (!res.ok) return void failed.push([id, res.status]);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const cards = [...doc.querySelectorAll('ql-activity-card')];
      const cardBars = new Set(cards.flatMap((c) => [...c.querySelectorAll('ql-progress-bar')]));
      const headline = [...doc.querySelectorAll('ql-progress-bar')].find((b) => !cardBars.has(b));
      const h1 = doc.querySelector('h1');
      results.push({
        id,
        title: (h1 ? h1.textContent.trim() : '') || `Path ${id}`,
        progress: headline ? num(headline.getAttribute('progress')) : null,
        cards: cards.map((c) => [
          c.getAttribute('name') || '',
          c.getAttribute('type') || '',
          c.getAttribute('credential-type') || '',
          c.hasAttribute('completed') ? 1 : 0,
          num(c.getAttribute('progress')),
          c.getAttribute('duration') || '',
          (c.getAttribute('path') || '').split('?')[0]
        ])
      });
    } catch (e) { failed.push([id, String(e).slice(0, 80)]); }
  };
  for (let i = 0; i < all.length; i += 4) {
    await Promise.all(all.slice(i, i + 4).map(readOne));
    if (i % 40 === 0) console.log(`${results.length}/${all.length} paths`);
    await sleep(150);
  }

  // 3. Save it.
  const activities = results.reduce((s, r) => s + r.cards.length, 0);
  console.log(`done: ${results.length} paths, ${activities} activities, ${failed.length} failed`, failed);
  const blob = new Blob([JSON.stringify({ results, failed })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'skills-scan.json';
  a.click();
})();
```

## Optional: check for broken and retired links

Run this **after** the scan above, in the same tab, to test every outstanding
activity link. It adds a `linkStatus` map that `paths-import` folds into the
database, marking dead content as `⚠️ MISSING`.

**Go one request at a time.** Google returns `403` to a burst of parallel
requests, which looks exactly like a broken lab and will fill your database with
false failures. The pauses and the long timeouts below are the point of the
script, not oversights.

```js
(async () => {
  // Canonicalize first: the URLs on a path page are path-scoped and Google
  // refuses them. /paths/70/course_templates/822 always 403s; the bare
  // /course_templates/822 answers. A bare /focuses/<id> redirects to the
  // dashboard; it needs ?parent=catalog&path=<pathId>.
  const canon = (url, pathId) => {
    const t = url.match(/\/course_templates\/(\d+)/);
    if (t) return `/course_templates/${t[1]}`;
    const f = url.match(/\/focuses\/(\d+)/);
    if (f) return `/focuses/${f[1]}?parent=catalog&path=${pathId}`;
    return url;
  };

  const seen = new Map();
  for (const p of window.__scan.results) {
    for (const c of p.cards) {
      if (c[3] === 1) continue;                                  // already completed
      const url = c[6];
      if (!url || url.includes('/course_sessions/')) continue;   // skip live lab sessions
      seen.set(canon(url, p.id), url);
    }
  }

  const probe = async (u) => {
    // Labs provision an environment before responding: ~30s is normal.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), u.includes('/focuses/') ? 60000 : 20000);
    try {
      const res = await fetch(u, { credentials: 'include', redirect: 'follow', signal: ac.signal });
      if (!res.ok) return res.status;
      const body = await res.text();
      if (new URL(res.url).pathname === '/') return 'gone';   // retired: bounced to dashboard
      if (/we.re sorry, but something went wrong/i.test(body)) return '500page';
      return 200;
    } catch (e) { return e.name === 'AbortError' ? 'timeout' : 'ERR'; }
    finally { clearTimeout(timer); }
  };
  const flaky = (c) => [500, 502, 503, 'ERR', '500page', 'timeout'].includes(c);

  const linkStatus = {};
  let n = 0;
  for (const [url, original] of seen) {
    let c = await probe(url);
    for (let a = 1; a < 3 && flaky(c); a++) {          // only repeated failures count
      await new Promise(r => setTimeout(r, 3000 * a));
      c = await probe(url);
    }
    if (c !== 200) linkStatus[new URL(original, location.origin).href] = c;
    if (++n % 10 === 0) console.log(`${n}/${seen.size} checked, ${Object.keys(linkStatus).length} flagged`);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('flagged:', linkStatus);
  const blob = new Blob([JSON.stringify({ results: window.__scan.results, failed: window.__scan.failed, linkStatus })],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'skills-scan.json';
  a.click();
})();
```

`gone` (a redirect to the dashboard) marks retired content — Google never
returns 404 for a missing course. **`403` does not mark anything broken**: it
means this account is not entitled to that content, and it is also what Google
returns when throttling. Expect the whole pass to take 20-30 minutes; labs alone
are ~30s each.

## Why the CLI still exists

The browser route cannot write to disk on its own, and nothing about it is
schedulable — it needs you in front of it. `npm run paths` does the same fetch
loop from Playwright, which *can* write `paths.md` and `activities.md` directly
and can run unattended. Use whichever fits; both feed the same database.

## A note on paths that fail

A path that returns `403` is one this account cannot open (path `2268` was the
only one at the last scan). Those land in the database as `❔ UNKNOWN` rather
than being silently dropped, and an inconclusive read never overwrites a status
an earlier run established.

## Checking DRI course completion

The same approach refreshes `completions.md`. Two pages hold everything it
needs, and both are server-rendered:

- **Course templates:** `/course_templates/<id>/badge` says *You've completed
  …* when the course is earned and *Access forbidden* when it is not. A
  signed-out tab gets *Access forbidden* for every course, so the script checks
  for a redirect to `/users/sign_in` and stops.
- **Labs:** a lab page renders its score in script, so the raw HTML reads
  `—/100` whether the lab was passed or not. Use the activity history instead:
  `/profile/activity?q[activity_type_in][]=LabInstance&per_page=100` lists every
  lab attempt with a `passed` flag, in a `ql-table` whose `data` attribute is
  JSON. The DRI links are `catalog_lab/<id>`, which redirect to the
  `/focuses/<id>` that the history uses, so each one is fetched once to learn
  its focus id.

Everything runs from a `partner.skills.google` tab. Fetch the
`partner.cloudskillsboost.google` links through the new host (only the path is
used), since a cross-origin fetch would be blocked. The original URL stays the
key in the database.

1. Print the course list from the cache, and copy the line it prints:

   ```bash
   node -e 'const c=require("./courses.json");console.log("window.__courseList="+JSON.stringify(c.map(({href,label})=>({href,label}))))'
   ```

2. In a signed-in `https://partner.skills.google/paths` tab, paste that into the
   Console, then paste the script below. It goes **one request at a time**, for
   the same reason as the link check above. The history alone is about 27
   pages at ~13s each on a slow day.
3. It saves `completions-scan.json`. Import it:

   ```bash
   npm run completions-import -- ~/Downloads/completions-scan.json
   ```

```js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parse = (h) => new DOMParser().parseFromString(h, 'text/html');
  const text = (d) => (d.querySelector('main') || d.body).innerText.replace(/\s+/g, ' ');
  const sorry = (h) => /we.re sorry, but something went wrong/i.test(h.slice(0, 3000));
  const get = async (u, ms = 30000) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(u, { credentials: 'include', signal: ac.signal }); return { r, html: await r.text() }; }
    catch (e) { return { err: e.name === 'AbortError' ? 'timeout' : String(e).slice(0, 60) }; }
    finally { clearTimeout(t); }
  };
  const retry = async (u, ms) => {
    let res;
    for (let a = 0; a < 3; a++) {
      res = await get(u, ms);
      if (!res.err && res.r.status < 500 && !sorry(res.html)) break;
      await sleep(3000 * (a + 1));
    }
    // A signed-out badge page also says "Access forbidden", which would record
    // every course as not completed. Stop rather than write that.
    if (!res.err && new URL(res.r.url).pathname.startsWith('/users/sign_in')) throw new Error('signed out: sign in and rerun');
    return res;
  };

  // 1. Every lab attempt: {focusId: {passed, best, last, n}}.
  const labs = {};
  for (let page = 1; page <= 40; page++) {
    const { html, err } = await retry(`/profile/activity?q%5Bactivity_type_in%5D%5B%5D=LabInstance&per_page=100&page=${page}`);
    if (err) { console.warn('history page', page, err); continue; }
    const t = parse(html).querySelector('ql-table.activities-table');
    const rows = t ? JSON.parse(t.getAttribute('data')) : [];
    if (!rows.length) break;
    for (const row of rows) {
      const m = row.name.match(/\/focuses\/(\d+)/);
      if (!m) continue;
      const e = labs[m[1]] ||= { passed: false, best: null, last: null, n: 0 };
      e.n++;
      if (row.passed) { e.passed = true; if (!e.last || row.ended > e.last) e.last = row.ended; }
      if (row.score != null && (e.best == null || Number(row.score) > e.best)) e.best = Number(row.score);
    }
    console.log(`history page ${page}`);
    await sleep(300);
  }

  // 2. Each DRI link, one at a time.
  const results = [];
  for (const [i, c] of window.__courseList.entries()) {
    const path = new URL(c.href).pathname;
    const rec = { url: c.href, course: c.label };
    let m;
    if ((m = path.match(/\/course_templates\/(\d+)/))) {
      const res = await retry(`/course_templates/${m[1]}/badge`);
      const t = res.err ? '' : text(parse(res.html));
      if (res.err) Object.assign(rec, { completed: null, evidence: `badge page ${res.err}` });
      else if (/You've completed/.test(t)) Object.assign(rec, { completed: true, evidence: 'Completion badge page: "You\'ve completed"' });
      else if (/Access forbidden/i.test(t)) Object.assign(rec, { completed: false, evidence: `Badge page: Access forbidden (HTTP ${res.r.status})` });
      else Object.assign(rec, { completed: null, evidence: `Badge page unrecognized (HTTP ${res.r.status})` });
    } else if ((m = path.match(/\/catalog_lab\/(\d+)/))) {
      const res = await retry(`/catalog_lab/${m[1]}`, 60000);   // labs can take ~30s
      const landed = res.err ? null : new URL(res.r.url).pathname;
      const f = landed && landed.match(/\/focuses\/(\d+)/);
      const h = f && labs[f[1]];
      if (res.err) Object.assign(rec, { completed: null, evidence: `lab page ${res.err}` });
      else if (!f) Object.assign(rec, { completed: null, evidence: `catalog_lab landed on ${landed}` });
      else if (h && h.passed) Object.assign(rec, { completed: true, evidence: `Activity history: passed lab /focuses/${f[1]} on ${h.last.slice(0, 10)}` });
      else Object.assign(rec, { completed: false, evidence: h ? `Activity history: ${h.n} attempt(s) at /focuses/${f[1]}, none passed` : `Activity history: no attempts at /focuses/${f[1]}` });
    } else if ((m = path.match(/^\/paths\/(\d+)$/))) {
      const res = await retry(`/paths/${m[1]}`);
      const cards = res.err ? [] : [...parse(res.html).querySelectorAll('ql-activity-card')];
      const done = cards.filter((x) => x.hasAttribute('completed')).length;
      Object.assign(rec, { completed: cards.length ? done === cards.length : null,
        evidence: cards.length ? `Path page: ${done}/${cards.length} activities completed` : 'path page unreadable' });
    } else Object.assign(rec, { completed: null, evidence: 'unrecognized link' });
    results.push(rec);
    if ((i + 1) % 25 === 0) console.log(`${i + 1}/${window.__courseList.length}`);
    await sleep(400);
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(results)], { type: 'application/json' }));
  a.download = 'completions-scan.json';
  a.click();
})();
```

A link that cannot be read comes back `null`, and `completions-import` never
lets that overwrite a status an earlier run established.
