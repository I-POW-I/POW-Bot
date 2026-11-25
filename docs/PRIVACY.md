
# POW-Bot privacy policy

Last updated: 25 November 2026

This explains what POW-Bot stores, why, for how long, and how to have it removed. It is written to be read, so it is short.

## What the bot stores

| What | Why | How long |
|---|---|---|
| **Server settings**: channel IDs, role IDs, and the options chosen in `/setup` | So the features work | Until the bot is removed from the server |
| **Voice sessions**: your Discord user ID, the server, the voice channel and when you joined and left | Voice stats, streaks, the leaderboard and role rewards | Kept until the bot is removed from the server. A server can choose a yearly reset, which deletes everything from before 1 January |
| **Live sessions**: when you went live in a voice channel | Voice stats | Same as voice sessions |
| **Join and leave history**: user ID, server and time | Member overview and verification risk checks | 90 days |
| **Recent messages**: text, attachment names, author ID and tag | Only in servers that switched on the deleted and edited message logs. Lets the log show what was removed | 7 days |
| **Message and reaction counts**: your user ID, the server, the channel, the day and hour, and how many messages and reactions you sent. Never the text, the content or what you reacted to. Bots are not counted | Only in servers whose staff switched on counting in `/setup` > Wrapped. Used for My Server Time Wrapped and Server Wrapped | Until the bot is removed from the server, or staff erase them. A server's yearly reset removes the previous year |
| **Moderation cases**: the member's user ID and tag, the moderator, the action, the reason and the time | The server's moderation record (`/case`, `/history`) | Until the bot is removed from the server. They are the server's records, so `/privacy` does not remove them. Ask the server's staff |
| **Watched streamers, games and feeds** | Alerts | Until the server removes them or the bot leaves |

Server staff can also see what the verification feature shows about an account: its age, avatar and public badges. Nothing else is collected for that.

If a server turns on Raid protection or AutoMod, the bot acts on new members and messages automatically. Actions are recorded as moderation cases (see above) and written to the log channel staff chose. Join counts and AutoMod strikes are held in memory for a few minutes to spot a pattern and are never saved. Messages AutoMod removes are shown in that log so staff can check them, and are not stored by the bot.

If a server turns on the Security Check Point, anyone who posts in its trap channel is removed or muted automatically. The bot may send that person a direct message explaining why. It writes their name, ID, account age and what they posted to the log channel that server's staff chose, and keeps only a running count of catches. It does not store the message itself.

## What the bot does not store

Email addresses, IP addresses, locations, direct messages, voice audio, or message text from servers that have not turned on message logs. Message counting never stores what a message says. The bot stays silent in voice channels and never records audio.

## Backups

The bot's operator receives a weekly backup of the bot's data folder and code. It contains the information in the table above and is sent only to the operator's private Discord messages. Backups never include passwords or tokens.

## Who can see it

- Server staff see the logs and records their own server has turned on.
- The bot's operator can see what is stored, to run and fix the service.
- Data is hosted on Discloud. The bot asks Steam, Twitch, Kick, YouTube, Epic and game publishers for public information such as live status and patch notes. No member data is sent to them.

Data is not sold, shared for advertising, or used to train models.

## Your choices

- **See or delete your data**: use `/privacy` in any server with the bot, or in a direct message with it. Deleting removes your voice and live sessions, join and leave history, stored messages and message and reaction counts in every server. Your voice time on leaderboards starts again from zero.
- **Server removal**: when the bot is removed from a server, everything stored for that server is deleted straight away.
- **Anything else**: ask in the support server or contact [CONTACT: your email or support server link].

## Children

Discord requires users to be at least 13 (or older in some countries). The bot is not meant for anyone younger.

## Changes

If this changes in a way that matters, the new version is posted in the support server and the date above is updated.
