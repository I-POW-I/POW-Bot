
# POW-Bot privacy policy

Last updated: 24 November 2026

This explains what POW-Bot stores, why, for how long, and how to have it removed. It is written to be read, so it is short.

## What the bot stores

| What | Why | How long |
|---|---|---|
| **Server settings**: channel IDs, role IDs, and the options chosen in `/setup` | So the features work | Until the bot is removed from the server |
| **Voice sessions**: your Discord user ID, the server, the voice channel and when you joined and left | Voice stats, streaks, the leaderboard and role rewards | Kept until the bot is removed from the server. A server can choose a yearly reset, which deletes everything from before 1 January |
| **Live sessions**: when you went live in a voice channel | Voice stats | Same as voice sessions |
| **Join and leave history**: user ID, server and time | Member overview and verification risk checks | 90 days |
| **Recent messages**: text, attachment names, author ID and tag | Only in servers that switched on the deleted and edited message logs. Lets the log show what was removed | 7 days |
| **Watched streamers, games and feeds** | Alerts | Until the server removes them or the bot leaves |

Server staff can also see what the verification feature shows about an account: its age, avatar and public badges. Nothing else is collected for that.

## What the bot does not store

Email addresses, IP addresses, locations, direct messages, voice audio, or message text from servers that have not turned on message logs. The bot stays silent in voice channels and never records audio.

## Backups

The bot's operator receives a weekly backup of the bot's data folder and code. It contains the information in the table above and is sent only to the operator's private Discord messages. Backups never include passwords or tokens.

## Who can see it

- Server staff see the logs and records their own server has turned on.
- The bot's operator can see what is stored, to run and fix the service.
- Data is hosted on Discloud. The bot asks Steam, Twitch, Kick, YouTube, Epic and game publishers for public information such as live status and patch notes. No member data is sent to them.

Data is not sold, shared for advertising, or used to train models.

## Your choices

- **See or delete your data**: use `/privacy` in any server with the bot, or in a direct message with it. Deleting removes your voice and live sessions, join and leave history and stored messages in every server. Your voice time on leaderboards starts again from zero.
- **Server removal**: when the bot is removed from a server, everything stored for that server is deleted straight away.
- **Anything else**: ask in the support server or contact [CONTACT: your email or support server link].

## Children

Discord requires users to be at least 13 (or older in some countries). The bot is not meant for anyone younger.

## Changes

If this changes in a way that matters, the new version is posted in the support server and the date above is updated.
