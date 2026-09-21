/* ===========================================================================
 *  X-NUKE v1.0.0
 *  Delete every post, reply and repost on your own X (Twitter) account.
 *
 *  Paste it into the browser console on your own profile. It uses the session
 *  you are already logged in with and X's own internal API, so it is far
 *  faster than clicking Delete 5,000 times, and it cannot touch anyone
 *  else's posts.
 *
 *  ---------------------------------------------------------------------
 *  HOW TO USE
 *    1. Log in to x.com in a desktop browser.
 *    2. Go to  https://x.com/YOUR_HANDLE/all
 *    3. Open DevTools (F12, or Cmd+Option+J) and click the Console tab.
 *       First time pasting, Chrome makes you type  allow pasting  first.
 *    4. Paste this whole file, press Enter, then click once on the page.
 *    5. Leave the tab open. It works through every tab on your profile by
 *       itself and stops when there is nothing left.
 *
 *  CONTROLS (type in the console any time)
 *    XNUKE.status()   how far along it is
 *    XNUKE.stop()     stop after the delete in flight
 *    XNUKE.archive()  delete from a downloaded archive (see COMMUNITY POSTS)
 *
 *  ---------------------------------------------------------------------
 *  COMMUNITY POSTS NEED YOUR ARCHIVE
 *
 *  Posts you made inside an X Community do NOT appear on any profile tab
 *  and do NOT appear in search. Nothing in the browser can list them, so no
 *  script can find them on its own. They are buried in their community's
 *  feed among every other member's posts.
 *
 *  They delete perfectly well once you know the id, so:
 *    1. Settings > Your account > Download an archive of your data
 *    2. Wait for the email, download and unzip it
 *    3. Run this script, then type  XNUKE.archive()
 *    4. Pick  data/community-tweet.js  (and data/tweets.js if you like)
 *
 *  That file lists every community post you ever made, with its id.
 *
 *  ---------------------------------------------------------------------
 *  WHY THIS ONE WORKS WHEN OTHERS STALL
 *
 *  a) It visits every tab. X splits your profile across /all, Posts,
 *     Reposts, Media and Replies, and they are backed by DIFFERENT API
 *     operations. A script pointed at one tab goes blind to the rest and
 *     reports "no posts found" while thousands remain.
 *  b) It reads the API, not the screen. X recycles timeline DOM nodes as you
 *     scroll, so screen scraping catches only what is currently visible.
 *     This hooks the network layer and harvests every id X sends.
 *  c) It matches renamed operations. X renames these endpoints (the Posts
 *     tab moved to UserOriginalsTimeline), so the matcher is a shape, not a
 *     hardcoded list.
 *  d) It waits out rate limits exactly. X allows roughly 200 deletes per 15
 *     minutes per account. That is server-side and cannot be bypassed. On a
 *     429 this reads the reset header and sleeps precisely that long.
 *  e) It survives a backgrounded tab. Timers run in a Web Worker and an
 *     inaudible tone stops the browser throttling the page while you work
 *     in another window.
 *
 *  DELETION IS PERMANENT. If you want a copy first, request your archive at
 *  Settings > Your account > Download an archive of your data, and wait for
 *  it to arrive before running this.
 * ======================================================================== */

(() => {
  'use strict';

  // ============================== SETTINGS ==============================
  const CFG = {
    DELETE_DELAY_MS: 350,    // gap between delete calls
    SCROLL_DELAY_MS: 1400,   // pause after each scroll so the next page loads
    IDLE_SCROLLS: 5,         // scrolls finding nothing new before a tab is done
    TAB_SETTLE_MS: 3500,     // pause after switching tabs
    QUEUE_HIGH_WATER: 400,   // stop scrolling while the backlog is this deep
    KEEP_TAB_AWAKE: true,    // inaudible tone so background tabs are not throttled
    DRY_RUN: false,          // true = count what it would delete, delete nothing
  };
  // ======================================================================

  const VERSION = '1.0.0';

  if (window.__XNUKE_RUNNING__) {
    console.warn('X-NUKE is already running in this tab. XNUKE.stop() first.');
    return;
  }

  if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) {
    alert('Run X-NUKE on x.com, on your own profile.');
    return;
  }

  const cookie = (n) => document.cookie.match(new RegExp('(^| )' + n + '=([^;]+)'))?.[2];
  const csrf = cookie('ct0');
  if (!csrf) {
    alert('No session found (the ct0 cookie is missing). Log in to x.com and try again.');
    return;
  }

  let MY_ID = decodeURIComponent(cookie('twid') || '').replace(/"/g, '').replace(/^u=/, '');

  let HANDLE = (window.__XNUKE_HANDLE__ || '').toLowerCase();
  if (!HANDLE) {
    const fromNav = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    HANDLE = (fromNav || location.pathname).split('/')[1]?.toLowerCase() || '';
  }
  const RESERVED = ['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose'];
  if (!HANDLE || RESERVED.includes(HANDLE)) {
    alert('Open your own profile first, then run X-NUKE:\n\nhttps://x.com/YOUR_HANDLE/all');
    return;
  }

  window.__XNUKE_RUNNING__ = true;

  // The public bearer token X's own web client ships with.
  const HEADERS = {
    authorization:
      'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    'x-csrf-token': csrf,
    'content-type': 'application/json',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
  };

  // Every tab on a profile, because each is backed by a different operation.
  const TABS = ['/all', '', '/reposts', '/media', '/with_replies'];

  const started = Date.now();
  const stats = { found: 0, deleted: 0, unretweeted: 0, gone: 0, failed: 0, waits: 0 };
  const seen = new Set();      // ids already queued, ever
  const queue = new Map();     // id -> source id when it is a repost
  const failedIds = [];
  let stop = false;
  let crawlDone = false;
  let deleteDone = false;

  const removedCount = () => stats.deleted + stats.unretweeted;

  // ---------- timers a background tab cannot throttle ----------
  let worker = null, ticket = 0;
  const waiters = new Map();
  try {
    const src = 'onmessage=e=>{setTimeout(()=>postMessage(e.data.id),e.data.ms)}';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const w = waiters.get(e.data);
      if (w) { waiters.delete(e.data); w(); }
    };
  } catch (e) { /* falls back to setTimeout */ }

  const sleep = (ms) => new Promise((res) => {
    if (!worker) return void setTimeout(res, ms);
    const id = ++ticket;
    waiters.set(id, res);
    worker.postMessage({ id, ms });
  });

  // ---------- keep a backgrounded tab running at full speed ----------
  if (CFG.KEEP_TAB_AWAKE) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;         // inaudible, but the tab counts as playing audio
      osc.frequency.value = 30;
      osc.connect(gain); gain.connect(ctx.destination); osc.start();
      ctx.resume().catch(() => {});
      document.addEventListener('click', () => ctx.resume().catch(() => {}), { once: true });
    } catch (e) { /* not fatal, a visible tab is fine either way */ }
  }

  // ---------- harvest ids out of X's own API responses ----------
  // Matched by shape, not by name: X renames these operations over time.
  const TIMELINE_RE = /\/i\/api\/graphql\/[^/]+\/\w*(Timeline|Tweets|TweetDetail)\w*/i;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }

    // Backup way to learn our own id if the twid cookie was missing.
    if (!MY_ID && node.rest_id && node.legacy?.screen_name?.toLowerCase() === HANDLE) {
      MY_ID = node.rest_id;
    }

    const lg = node.legacy;
    if (node.rest_id && lg && lg.user_id_str && MY_ID && lg.user_id_str === MY_ID) {
      const id = node.rest_id;
      if (!seen.has(id)) {
        seen.add(id);
        const rt = lg.retweeted_status_result?.result;
        queue.set(id, rt?.rest_id || rt?.tweet?.rest_id || null);
        stats.found++;
      }
    }
    for (const k in node) walk(node[k]);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (TIMELINE_RE.test(url)) res.clone().json().then(walk).catch(() => {});
    } catch (e) { /* ignore */ }
    return res;
  };

  const XHRp = XMLHttpRequest.prototype;
  const origOpen = XHRp.open;
  const origSend = XHRp.send;
  XHRp.open = function (m, url, ...rest) { this.__xnUrl = url; return origOpen.call(this, m, url, ...rest); };
  XHRp.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        if (!this.__xnUrl || !TIMELINE_RE.test(String(this.__xnUrl))) return;
        const raw = this.responseType === 'json' ? this.response : this.responseText;
        if (raw) walk(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, a);
  };

  // Backstop: read what is on screen, for anything the hooks miss.
  function scanDOM() {
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const link = art.querySelector('a[href*="/status/"] time')?.closest('a');
      if (!link) continue;
      const m = link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m) continue;
      const author = m[1].toLowerCase(), id = m[2];
      if (seen.has(id)) continue;
      const isRepost = !!art.querySelector('[data-testid="unretweet"]');
      if (!isRepost && author !== HANDLE) continue;   // someone else's post, shown for context
      seen.add(id);
      queue.set(id, isRepost ? id : null);
      stats.found++;
    }
  }

  // ---------- the delete calls ----------
  async function gql(queryId, op, variables) {
    let netErrors = 0;
    for (;;) {
      if (stop) return { stopped: true };
      let res;
      try {
        res = await origFetch(`https://x.com/i/api/graphql/${queryId}/${op}`, {
          method: 'POST',
          headers: HEADERS,
          credentials: 'include',
          body: JSON.stringify({ variables, queryId }),
        });
      } catch (e) {
        if (++netErrors > 8) return { failed: true };
        console.warn(`X-NUKE: network error ${netErrors}/8, retrying in ${10 * netErrors}s`);
        await sleep(10000 * netErrors);
        continue;
      }

      if (res.status === 429) {
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        let waitMs = reset ? reset * 1000 - Date.now() + 5000 : 15 * 60 * 1000;
        waitMs = Math.min(Math.max(waitMs, 5000), 16 * 60 * 1000);
        stats.waits++;
        console.log(
          `%cX-NUKE: rate limited. Sleeping ${Math.ceil(waitMs / 60000)} min ` +
          `(back at ${new Date(Date.now() + waitMs).toLocaleTimeString()}). This is normal.`,
          'color:#b45309'
        );
        report();
        await sleep(waitMs);
        continue;
      }

      const body = await res.json().catch(() => ({}));
      if (res.ok && !body.errors) return { ok: true };

      const msg = JSON.stringify(body.errors ?? body);
      if (/not found|no status found|already|deleted|unauthorized to view/i.test(msg)) return { gone: true };
      if (res.status >= 500) { await sleep(20000); continue; }
      console.warn(`X-NUKE: ${op} failed (HTTP ${res.status}) ${msg}`);
      return { failed: true };
    }
  }

  const deleteTweet = (id) =>
    gql('VaenaVgh5q5ih7kvyVjgtg', 'DeleteTweet', { tweet_id: id, dark_request: false });
  const deleteRepost = (srcId) =>
    gql('iQtK4dl5hBmXewYZuEOKVw', 'DeleteRetweet', { source_tweet_id: srcId, dark_request: false });

  function report() {
    const mins = (Date.now() - started) / 60000;
    console.log(
      `%cX-NUKE  removed ${removedCount()}  (posts ${stats.deleted}, reposts ${stats.unretweeted})  ` +
      `already gone ${stats.gone}  failed ${stats.failed}  queued ${queue.size}  found ${stats.found}  ` +
      `${mins.toFixed(1)} min`,
      'color:#0369a1;font-weight:bold'
    );
  }

  // ---------- move between profile tabs without reloading the page ----------
  async function openTab(suffix) {
    const target = `/${HANDLE}${suffix}`;
    const link = document.querySelector(`a[role="tab"][href="${target}"]`) ||
                 document.querySelector(`a[href="${target}"]`);
    if (link) {
      link.click();
    } else {
      // /all has no tab link, so drive the app's router directly.
      history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    await sleep(CFG.TAB_SETTLE_MS);
    window.scrollTo(0, 0);
    await sleep(600);
    return location.pathname.toLowerCase() === target.toLowerCase();
  }

  // ---------- drain whatever timeline is on screen ----------
  async function drainCurrentTab() {
    const before = removedCount();
    let idle = 0;
    while (idle < CFG.IDLE_SCROLLS && !stop) {
      if (queue.size > CFG.QUEUE_HIGH_WATER) { await sleep(1500); continue; }
      const found0 = stats.found;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(CFG.SCROLL_DELAY_MS);
      scanDOM();
      if (stats.found === found0) idle++; else idle = 0;
    }
    // let the deleter catch up before we judge the tab empty
    while (queue.size > 0 && !stop && !deleteDone) await sleep(800);
    return removedCount() - before;
  }

  // ---------- the two loops ----------
  async function crawler() {
    try {
      let cycle = 0;
      while (!stop) {
        cycle++;
        let removedThisCycle = 0;
        for (const suffix of TABS) {
          if (stop) break;
          const name = suffix.replace('/', '') || 'posts';
          const opened = await openTab(suffix);
          if (!opened) {
            console.warn(`X-NUKE: could not open the ${name} tab, skipping it.`);
            continue;
          }
          const got = await drainCurrentTab();
          removedThisCycle += got;
          console.log(`%cX-NUKE: ${name} tab -> removed ${got}`, 'color:#15803d');
        }
        console.log(`%cX-NUKE: pass ${cycle} finished, removed ${removedThisCycle}`, 'color:#7c3aed;font-weight:bold');
        if (removedThisCycle === 0) break;   // a whole lap of every tab found nothing
      }
    } finally {
      crawlDone = true;
    }
  }

  async function deleter() {
    try {
      while (!stop) {
        if (queue.size === 0) {
          if (crawlDone) break;
          await sleep(700);
          continue;
        }
        const [id, srcId] = queue.entries().next().value;
        queue.delete(id);

        if (CFG.DRY_RUN) { stats.deleted++; continue; }

        const r = srcId ? await deleteRepost(srcId) : await deleteTweet(id);
        if (r.ok) srcId ? stats.unretweeted++ : stats.deleted++;
        else if (r.gone) stats.gone++;
        else if (r.failed) { stats.failed++; failedIds.push(id); }
        else if (r.stopped) break;

        if ((removedCount() + stats.gone + stats.failed) % 25 === 0) report();
        await sleep(CFG.DELETE_DELAY_MS);
      }
    } finally {
      deleteDone = true;
    }
  }

  // ---------- delete a plain list of ids (used by archive mode) ----------
  async function deleteIdList(ids, label) {
    console.log(`%cX-NUKE: deleting ${ids.length} ids from ${label}`, 'color:#7c3aed;font-weight:bold');
    let removed = 0, missing = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      if (stop) { console.log('X-NUKE: stopped.'); break; }
      const r = await deleteTweet(ids[i]);
      if (r.ok) { removed++; stats.deleted++; }
      else if (r.gone) { missing++; stats.gone++; }
      else if (r.stopped) break;
      else { failed++; stats.failed++; failedIds.push(ids[i]); }
      if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${ids.length}`);
      await sleep(CFG.DELETE_DELAY_MS);
    }
    console.log(
      `%cX-NUKE: ${label} finished. removed ${removed}, already gone ${missing}, failed ${failed}`,
      'color:#15803d;font-weight:bold'
    );
    return { removed, missing, failed };
  }

  // ---------- archive mode ----------
  // Community posts are invisible to every timeline and to search, so the
  // only way to learn their ids is the archive X gives you on request.
  async function archiveMode() {
    stop = false;
    console.log(
      'X-NUKE: pick the data files from your unzipped archive.\n' +
      '  data/community-tweet.js  = your community posts (nothing else can find these)\n' +
      '  data/tweets.js           = everything else\n' +
      'You can select more than one.'
    );

    const files = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.js,.json,.txt';
      input.multiple = true;
      input.onchange = () => resolve([...input.files]);
      input.click();
    });
    if (!files.length) { console.log('X-NUKE: nothing selected.'); return; }

    const ids = new Set();
    for (const file of files) {
      const text = await file.text();
      const start = text.indexOf('[');                 // strip the window.YTD... = prefix
      if (start === -1) { console.warn(`  ${file.name}: not an archive data file, skipped.`); continue; }
      let entries;
      try {
        entries = JSON.parse(text.slice(start));
      } catch (e) {
        console.warn(`  ${file.name}: could not parse (${e.message}), skipped.`);
        continue;
      }
      let added = 0;
      for (const entry of entries) {
        const t = entry?.tweet ?? entry;
        if (t?.id_str && !ids.has(t.id_str)) { ids.add(t.id_str); added++; }
      }
      console.log(`  ${file.name}: ${added} ids`);
    }

    if (!ids.size) { console.log('X-NUKE: no post ids found in those files.'); return; }
    return deleteIdList([...ids], 'archive');
  }

  // ---------- controls ----------
  window.XNUKE = {
    version: VERSION,
    status() { report(); return { ...stats, queued: queue.size, failedIds: failedIds.slice() }; },
    stop() { stop = true; console.log('X-NUKE: stopping after the delete in flight...'); },
    archive() { return archiveMode(); },
  };

  console.log(
    `%c X-NUKE v${VERSION} %c @${HANDLE}${CFG.DRY_RUN ? '  (DRY RUN, nothing is deleted)' : ''} `,
    'background:#000;color:#f5ff00;font-weight:bold;padding:3px 6px',
    'background:#f5ff00;color:#000;font-weight:bold;padding:3px 6px'
  );
  console.log('Click once on this page so the tab is not throttled. XNUKE.status() for progress, XNUKE.stop() to stop.');
  console.log('Made posts inside an X Community? Those are invisible to every timeline. Run XNUKE.archive() with your downloaded archive.');
  console.log(`Working through: ${TABS.map((t) => t.replace('/', '') || 'posts').join(' -> ')}`);

  Promise.allSettled([crawler(), deleter()]).then((rs) => {
    for (const r of rs) if (r.status === 'rejected') console.error('X-NUKE: loop crashed', r.reason);
    window.fetch = origFetch;
    XHRp.open = origOpen;
    XHRp.send = origSend;
    window.__XNUKE_RUNNING__ = false;
    console.log(`%c X-NUKE ${stop ? 'stopped' : 'finished'} `, 'background:#000;color:#f5ff00;font-weight:bold;padding:3px 6px');
    report();
    if (failedIds.length) console.log('Ids that failed:', failedIds);
    console.log(
      'If your profile counter still shows a number, that counter is a cached aggregate and lags ' +
      'behind for a few days. What matters is whether posts still render on your tabs.'
    );
    console.log(
      'Posts made inside X Communities are NOT covered by this sweep. They appear on no profile ' +
      'tab and in no search. Download your archive and run XNUKE.archive() to clear those.'
    );
  });
})();
