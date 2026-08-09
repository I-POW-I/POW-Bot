# POW-Bot

A Discord bot that sits in a voice channel and stays there 24/7. Keeps call timers running, logs all voice activity, and manages itself through a live control panel.

---

## What it does

- Joins a voice channel and stays connected permanently
- Plays a silent audio stream to prevent Discord from dropping the connection
- Auto-rejoins if dropped — heartbeat checks every 2 minutes
- Auto-rejoins the last known channel on restart
- Logs all voice activity to a chosen channel
- Logs deleted messages
- Live control panel embed with buttons — no commands needed day-to-day
- Updates its Discord status with the channel name and uptime
- Persists uptime stats across restarts

---

## Commands

| Command | What it does | Permission |
|---|---|---|
| `/panel` | Post the live control panel in this channel | Manage Server |
| `/setlogchannel` | Set which channel a log type posts to | Manage Server |
| `/status` | Show current connection stats | Everyone |
| `/clearcommands` | Force clear and re-register all slash commands | Administrator |

---

## Control Panel Buttons

| Button | What it does | Permission |
|---|---|---|
| 🔊 Join | Join your current VC, or pick one from a dropdown | Manage Server |
| 👋 Leave | Clean disconnect | Manage Server |
| 🔌 Force Leave | Wipes all state — fixes ghost connection issues | Manage Server |
| 📊 Stats | Shows detailed bot stats | Everyone |
| 🔄 Refresh | Refreshes the panel embed | Everyone |

---

