#!/usr/bin/env python3
"""
X-NUKE unattended driver.

The console script does the work. This babysits it so you do not have to keep a
DevTools window open for hours: it launches its own Chrome profile, waits for
you to log in once, injects the script, re-injects it if a navigation wipes it,
and writes a summary when the account is clear.

    pip install playwright
    playwright install chrome
    python3 driver/x-nuke-driver.py

    tail -f ~/.x-nuke/run.log      # watch it
    touch ~/.x-nuke/STOP           # stop it politely

It never reads your saved passwords or your browser's cookie store. It opens a
separate, empty Chrome profile and you sign in there yourself, once. That
session is remembered for later runs.

Keep the machine awake for the whole run:
    linux   systemd-inhibit --what=idle:sleep --why="x-nuke" sleep 8h &
    macos   caffeinate -i &
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, Error as PWError
except ImportError:
    sys.exit("Playwright is missing. Run:  pip install playwright && playwright install chrome")

HOME = Path.home() / ".x-nuke"
PROFILE = HOME / "chrome-profile"
LOG = HOME / "run.log"
SUMMARY = HOME / "summary.json"
STOPFILE = HOME / "STOP"
SCRIPT = Path(__file__).resolve().parent.parent / "script" / "x-nuke.js"

LOGIN_WAIT_S = 1800      # how long to wait for you to sign in the first time
POLL_S = 20
MAX_RUNTIME_S = 24 * 3600


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    HOME.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as fh:
        fh.write(line + "\n")


def stopping():
    return STOPFILE.exists()


def post_count(page):
    """Best effort read of the 'N posts' line in the profile header."""
    try:
        txt = page.locator('div[data-testid="primaryColumn"]').inner_text(timeout=5000)
    except Exception:
        return None
    m = re.search(r"([\d,.]+)\s*(K|M)?\s*posts", txt, re.I)
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    if m.group(2):
        n *= {"K": 1_000, "M": 1_000_000}[m.group(2).upper()]
    return int(n)


def goto(page, url, attempts=4):
    """Navigation that survives a dropped wifi connection."""
    for i in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded")
            return True
        except Exception as e:
            log(f"  nav failed ({i}/{attempts}): {str(e).splitlines()[0][:110]}")
            if i < attempts:
                time.sleep(10 * i)
    return False


def main():
    HOME.mkdir(parents=True, exist_ok=True)
    if stopping():
        STOPFILE.unlink()
    if not SCRIPT.exists():
        sys.exit(f"Cannot find the script at {SCRIPT}")
    source = SCRIPT.read_text()
    wrapped = "() => {\n" + source + "\n}"

    with sync_playwright() as p:
        log("Launching Chrome...")
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE),
            channel="chrome",
            headless=False,                       # x.com blocks headless browsers
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.set_default_timeout(60000)
        page.on("console", lambda m: log(f"  js: {m.text}") if "X-NUKE" in m.text else None)
        page.on("pageerror", lambda e: log(f"  js error: {str(e)[:200]}"))
        page.on("dialog", lambda d: d.dismiss())

        if not goto(page, "https://x.com/home"):
            log("Cannot reach x.com. Check your connection.")
            ctx.close()
            return

        # ---- sign in (only needed the first time) ----
        handle, deadline, told = None, time.time() + LOGIN_WAIT_S, False
        while time.time() < deadline:
            if stopping():
                log("Stopped before sign-in.")
                ctx.close()
                return
            try:
                link = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first
                if link.count() > 0:
                    href = (link.get_attribute("href") or "").strip("/")
                    if href:
                        handle = href.split("/")[0]
                        break
            except Exception:
                pass
            if not told:
                log("NOT SIGNED IN. Sign in to X in the Chrome window that just opened.")
                log("Waiting up to 30 minutes. Nothing is deleted until you are in.")
                told = True
            time.sleep(5)

        if not handle:
            log("Timed out waiting for sign-in. Nothing was deleted.")
            ctx.close()
            return

        log(f"Signed in as @{handle}")
        profile_url = f"https://x.com/{handle}/all"
        goto(page, profile_url)
        page.wait_for_timeout(6000)

        before = post_count(page)
        log(f"Post count before: {before if before is not None else 'unknown'}")

        # ---- run the script, keeping it alive ----
        log("Injecting X-NUKE. It sweeps every profile tab on its own.")
        page.evaluate(f"() => {{ window.__XNUKE_HANDLE__ = {json.dumps(handle)}; }}")
        page.evaluate(wrapped)

        started = time.time()
        while time.time() - started < MAX_RUNTIME_S:
            time.sleep(POLL_S)

            if stopping():
                log("Stop requested, asking the script to finish.")
                try:
                    page.evaluate("() => window.XNUKE && window.XNUKE.stop()")
                except Exception:
                    pass
                time.sleep(10)
                break

            try:
                running = page.evaluate("() => window.__XNUKE_RUNNING__ === true")
                alive = page.evaluate("() => typeof window.XNUKE === 'object'")
            except PWError as e:
                log(f"Page went away ({str(e)[:90]}). Reloading.")
                if not goto(page, profile_url):
                    log("Browser looks closed. Stopping.")
                    break
                page.wait_for_timeout(6000)
                page.evaluate(f"() => {{ window.__XNUKE_HANDLE__ = {json.dumps(handle)}; }}")
                page.evaluate(wrapped)
                continue

            if not alive:
                log("Script is gone (hard navigation). Re-injecting.")
                page.evaluate(f"() => {{ window.__XNUKE_HANDLE__ = {json.dumps(handle)}; }}")
                page.evaluate(wrapped)
                continue

            if not running:
                log("Script reported it is finished.")
                break

        # ---- verify ----
        stats = {}
        try:
            stats = page.evaluate("() => window.XNUKE ? window.XNUKE.status() : {}") or {}
        except Exception:
            pass

        goto(page, profile_url)
        page.wait_for_timeout(8000)
        after = post_count(page)
        try:
            page.screenshot(path=str(HOME / "final.png"))
        except Exception:
            pass

        summary = {
            "handle": handle,
            "finished_at": datetime.now().isoformat(timespec="seconds"),
            "post_count_before": before,
            "post_count_after": after,
            "removed": (stats.get("deleted", 0) + stats.get("unretweeted", 0)),
            "stats": stats,
        }
        SUMMARY.write_text(json.dumps(summary, indent=2))

        log("================ DONE ================")
        log(f"Account:       @{handle}")
        log(f"Posts before:  {before if before is not None else 'unknown'}")
        log(f"Posts now:     {after if after is not None else 'unknown'}")
        log(f"Removed:       {summary['removed']}")
        log(f"Failed:        {stats.get('failed', 0)}")
        log(f"Summary:       {SUMMARY}")
        log("A profile counter that still shows a number is a cached aggregate and")
        log("lags for a few days. What matters is whether posts still render.")
        log("======================================")
        ctx.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Interrupted.")
