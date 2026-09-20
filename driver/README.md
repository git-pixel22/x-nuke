# Unattended driver

```bash
pip install playwright
playwright install chrome
python3 x-nuke-driver.py
```

Everything lands in `~/.x-nuke/`:

| File | What it is |
| --- | --- |
| `chrome-profile/` | its own browser profile, holds your signed-in session |
| `run.log` | full log, `tail -f` it |
| `summary.json` | before/after counts when it finishes |
| `final.png` | screenshot of the profile at the end |
| `STOP` | create this file to stop politely |

First run asks you to sign in inside its Chrome window. Later runs reuse that
session and need nothing from you.

It does not read your normal browser profile, your saved passwords, or your
cookie store.
