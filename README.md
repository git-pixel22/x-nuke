# X-NUKE

**Delete every post, reply and repost on your own X (Twitter) account.**

Paste one script into your browser console, click once, walk away. No signup, no
OAuth handover, no 50-a-day cap, nothing leaves your browser.

Built while wiping a real account of **5,852 posts**. Every gotcha documented
below came from something breaking during that run.

---

## Quick start

1. In a desktop browser, signed in, open `https://x.com/YOUR_HANDLE/all`
2. Open DevTools (<kbd>F12</kbd>, or <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>J</kbd>) and pick the **Console** tab
3. Paste [`script/x-nuke.js`](script/x-nuke.js), press Enter, then **click once on the page**
4. Leave the tab open

```js
XNUKE.status()    // progress
XNUKE.stop()      // stop after the delete in flight
XNUKE.archive()   // clear community posts, see below
```

The first time you paste into Chrome's console it makes you type `allow pasting`.
That exists to protect you from scams and it is a good instinct. **Read the
script before you run it.** It is ~400 commented lines.

---

## Community posts: the one thing no script can find

**Posts you made inside an X Community do not appear on any profile tab and do
not appear in search.** They live in their community's feed among every other
member's posts. Nothing running in your browser can enumerate them, so no tool
can delete what it cannot find. This is a hard limit, not a bug to fix.

They delete perfectly well *once you know the id*. The id is the only missing
piece, and exactly one place has it: the archive X gives you on request.

1. Settings → Your account → **Download an archive of your data**
2. Wait for the email (hours to a day), download and unzip
3. Run the script, then type `XNUKE.archive()`
4. Select `data/community-tweet.js` (you can add `data/tweets.js` too)

It parses the ids and deletes them with the same rate limit handling as the
main sweep.

> Found the hard way. An account that had been swept until every tab was empty
> and search returned nothing still held **17 community posts**, dating back
> years. The archive's `tweets.js` was an empty array while
> `community-tweet.js` had all 17 with their ids.

**Useful side effect:** the archive is also how you *verify* a wipe. If
`data/tweets.js` comes back as `window.YTD.tweets.part0 = [ ]`, every regular
post and reply is genuinely gone, regardless of what your profile counter says.

---

## Why other scripts stall

Most give up after a few hundred posts and tell you to refresh and start over.
Five reasons this one finishes:

### 1. It visits every tab

X splits your profile across five surfaces, each backed by a **different API
operation**:

| Tab | Path | Backed by |
| --- | --- | --- |
| All | `/handle/all` | `UserTweetsAndReplies` |
| Posts | `/handle` | `UserOriginalsTimeline` |
| Reposts | `/handle/reposts` | its own timeline |
| Media | `/handle/media` | `UserMedia` |
| Replies | `/handle/with_replies` | `UserTweetsAndReplies` |

Point a script at one and it goes blind to the rest, then reports "no posts
found" while thousands remain.

> **The trap that cost a full day:** `/with_replies` is the **Replies** tab, not
> "posts and replies". Once the replies were gone it rendered completely empty
> while ~1,600 posts and reposts sat untouched in other tabs. It looked exactly
> like hitting an API limit.

### 2. It reads the API, not the screen

X recycles timeline DOM nodes as you scroll, so screen scraping only ever sees
what is currently visible. This hooks `fetch` and `XMLHttpRequest` and harvests
every id X sends, including posts that scrolled out of the DOM.

### 3. It survives renamed operations

X renames these endpoints. The Posts tab moved to `UserOriginalsTimeline`, which
silently breaks any matcher pinned to a fixed list of names. This matches the
*shape* of a timeline operation instead.

### 4. It waits out rate limits exactly

X allows roughly **200 deletes per 15 minutes**, enforced server side. Nothing
can bypass that. On a 429 this reads X's own `x-rate-limit-reset` header and
sleeps precisely that long, then resumes.

Reads are limited **separately** from deletes. Hammering the timeline (for
example by restarting repeatedly) exhausts the read budget and X starts serving
empty timelines and error cards, which looks exactly like an empty account.
If everything suddenly reads empty, stop for an hour.

### 5. It keeps working in a background tab

Browsers throttle hidden tabs to one timer tick per minute. Timers run in a Web
Worker and an inaudible tone keeps the tab active, so you can use other windows.

---

## What to expect

- **~800 deletes per hour.** 5,000 posts is a 6 to 7 hour job, mostly spent
  asleep between rate limit windows.
- **Do not let the machine sleep.** A suspend kills the run.
  - Linux: `systemd-inhibit --what=idle:sleep --why="x-nuke" sleep 8h &`
  - macOS: `caffeinate -i &`
- **The post counter lies at the end.** It is a cached aggregate that lags days
  behind the timeline index. It may read `5` while every tab is empty. Trust the
  tabs, not the number.
- **Run it twice.** If X throttles reads partway through, some posts stay hidden
  until it recovers. A second pass the next day catches stragglers.

---

## Unattended mode

Do not want a console tab open for seven hours? The Python driver launches its
own browser, injects the script, re-injects after navigations, rides out rate
limits, retries dropped wifi, and writes a summary.

```bash
pip install playwright
playwright install chrome
python3 driver/x-nuke-driver.py

tail -f ~/.x-nuke/run.log     # watch
touch ~/.x-nuke/STOP          # stop politely
```

It uses a **separate, empty Chrome profile** at `~/.x-nuke/chrome-profile`. It
never touches your normal browser profile, your saved passwords, or your cookie
store. You sign in yourself, in its window, once.

---

## Warnings

- **Deletion is permanent.** No undo, no trash, no recovery.
- **Want a copy first?** Settings → Your account → Download an archive of your
  data. It takes hours to prepare. Wait for it before running this.
- **Your own account only.** It uses your session and can only delete what you
  own. It cannot touch anyone else's posts.
- **Unofficial API.** These are X's internal endpoints, the same ones the site
  itself calls. They change without notice and this may break.
- Not affiliated with, endorsed by, or connected to X Corp.

---

## The website

The `index.html` / `src/` in this repo is a small Vite site that explains all of
the above.

```bash
npm install
npm run dev      # local
npm run build    # -> dist/
```

Deploying to Vercel: import the repo, framework preset **Vite**, build
`npm run build`, output `dist`. No environment variables needed.

---

MIT licensed. Use at your own risk, on your own account.
