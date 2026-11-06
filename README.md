# POW-Bot

A Discord bot that sits in a voice channel and stays there 24/7. Keeps call timers running, logs all voice activity, and has live control panel.

---

## What it does

- Joins a voice channel and stays connected permanently
- Plays a silent audio stream to prevent Discord from dropping the connection
- Instantly Auto-rejoins the last known VC if the bot's host connection drops or discord breaks
- Instantly Auto-rejoins the last known VC on restart, so worrying about it leaving during a restart, update or change isn't a issue.
- Logs all voice activity to a chosen channel
- Logs deleted messages
- Live control panel embed with buttons
- Updates its Discord status with the channel name and uptime
- Persists uptime stats across restarts

---

## Commands

| Command | What it does | Who |
|---|---|---|
| `/setup` | One screen to set up the panel, logs, welcome cards, verification, alerts and more — with a checklist and permission check | Manage Server |
| `/help` | What every command does, by topic | Everyone |
| `/botinfo` | Status, latency, RAM, CPU, services, last error (owners also see system / usage / safety details) | Everyone |
| `/serverinfo` | Detailed information about the server | Everyone |
| `/members` | Overview, recent joins/leaves, unverified members and a per-member lookup | Manage Server |
| `/streamers` | Go-live alerts for Twitch, Kick and YouTube | Manage Server |
| `/free-games` | Free games on Epic + Steam: `now`, `setup`, `edit`, `remove`, `status` | Everyone (`now`) / Manage Server |
| `/game-updates` | Steam patch note alerts: `add`, `edit`, `remove`, `list`, `test` | Manage Server |
| `/purge` | Delete up to 100 messages | Manage Messages |
| `/owner` | Bot-owner controls (status, restart, logs, servers, announce, maintenance, bans…) | `OWNER_IDS` / `ADMIN_IDS` only |

---

## Control Panel Buttons

| Button | What it does | Permission |
|---|---|---|
| Join | Joins your voice channel | Manage Server |
| Leave | Disconnects from the voice channel | Server owner / bot control role |
| My Info | Your time in the server and in voice, streaks | Everyone |
| User Lookup | The same, for someone you pick | Everyone |
| Bot Info | Bot status and health | Everyone |

---
