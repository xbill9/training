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
