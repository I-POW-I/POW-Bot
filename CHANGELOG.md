# Changelog

## 5.5.5

- **Steam game updates are back to the clean layout** from the formatted Steam feed (headings, bullets, picture), which is the version that looked right
- **No more repeat posts.** The feed and Steam's news API number the same post differently, so switching between them made every game look like it had a new update. Posts now always keep the number your alerts already remember. As a second safety net, a post more than 7 days old is never announced as new
- **Game colour**: each update post now takes the main colour of the game's artwork instead of orange (orange is still used if no colour can be found)
- If the feed ever fails, the bot says so in the console and falls back to the full post from Steam's news API, with its images and links tidied up

## 5.5.4

- **Steam game updates fixed at the root.** The bot was asking Steam for a shortened summary of each post, and Steam sends that as one run of text with no line breaks, headings or bullets. It now asks for the full post, so Counter-Strike 2, Tarkov and every other Steam game show Maps, Misc and each change as proper headings and bullets, like the Minecraft and VALORANT posts
- The "Read full notes" button now opens the post on store.steampowered.com instead of an unfamiliar akamaihd.net address that made Discord show a "Leaving Discord" warning
- Headings written as `[ MISC ]` in the middle of a post are recognised, and the `[/*]` list-item closer is handled

## 5.5.3

- **Raid protection** (`/setup` > Raid protection): detects a flood of joins (you choose how many people and how many seconds) and either alerts staff or starts **raid mode**. In raid mode new members you choose (everyone, new accounts, accounts with no profile picture) are kicked, timed out or banned, and invites are paused. Raid mode ends after the time you pick, or when staff end it. Staff can alert a role, choose the alert channel, and decide whether people who just arrived are dealt with too
- **Account age gate**: refuse accounts under a number of days, any time, with the action you choose
- **`/raidmode on | off | status`** to switch raid mode yourself
- **AutoMod** (`/setup` > AutoMod): eight filters you switch on one by one: invite links, scam links (fake Discord and Steam sites, "free nitro" lures, your own blocked sites), all links (with an allow list), message spam, mass mentions, capitals, emoji and your own blocked words. Each has its own response (delete, delete and warn, delete and time out) and its own limits
- Strikes: every removed message is a strike, and enough strikes in a short time earn a timeout. Staff, roles and channels you pick are ignored. Every removal is logged with what was said
- **Discord's built-in AutoMod**: one button each adds Discord's own rules (bad language, mention spam, spam, scam lures), which block a message before anyone sees it
- Everything automatic is a numbered case, so `/history` shows it
- The old "possible raid" alert in Verification steps aside when Raid protection is on, so you get one alert, not two

## 5.5.2

- **Welcome & leave overhaul**: each post can now be an image card, a rich embed, a card inside an embed, or plain text. Five built-in card styles (Classic, Midnight, Aurora, Sunset, Graphite), a circle or rounded avatar, and your own wording with placeholders: `{user}` `{username}` `{mention}` `{server}` `{count}` `{ordinal}` `{accountage}` `{joined}` `{rules}`. Leave posts say how long the person was in the server. **Preview** shows exactly what will be posted
- **Extras**: a private welcome message to new members, roles given to every new member (skipped when verification is on, because verification decides roles), and a separate "welcome back" text for people who left and returned
- Staff cannot upload their own card backgrounds, only the built-in styles
- Existing welcome and leave settings carry over unchanged
- **Steam game updates**: posts are now built from Steam's formatted news feed, so patch notes keep their headings and bullet points instead of one flattened paragraph. Falls back to the old source if the feed is unavailable

## 5.5.1

- **Moderation commands**: `/warn`, `/timeout`, `/untimeout`, `/kick`, `/softban`, `/ban` and `/unban`. Each needs the matching Discord permission and respects role order, so nobody can act on someone above them. Replies are private to the moderator and the action is posted to the mod log
- **Cases**: every action is a numbered case (Case #1, #2, ...). `/case` shows one or changes its reason, `/history` shows everything for a member. Bans, kicks and timeouts done by hand in Discord, and Security Check Point catches, are recorded as cases too
- Members are sent a short message with the reason when something is done to them. Staff can turn that off in `/setup` > Moderation
- `/lock` and `/unlock` (put back exactly as it was) and `/slowmode`
- New `/setup` > Moderation page: choose the mod log channel, message to member on or off, and see which permissions are missing for which command
- `/unban` suggests the people who are banned as you type

## 5.5.0

- **Security Check Point**: a trap channel that catches spam bots and hacked accounts. Set it up in `/setup` > Security Check Point. Press **Create the channel for me** and it is on. Staff choose what happens to anyone who posts there (softban is the default, or kick, ban, timeout), where it is logged, and which roles are never actioned. **Test it** checks permissions and sends a sample log entry
- New permissions: Ban Members, Timeout Members and Manage Channels. Existing servers keep working, and `/setup` tells staff if a permission is missing for the action they chose
- Streamer alerts recover on their own: if a live post was deleted or lost during a restart, the bot posts it again and keeps it updated, and it now logs when an update fails instead of failing silently
- Fortnite and Blizzard game updates removed. Existing alerts for them are deleted automatically
- After adding a game update alert, its page opens straight away with the **Send latest post as a test** button
- Help text corrected (free games include GOG)

## 5.4.2

- `/botinfo` is now a short public post for everyone: status, latency, uptime, version and whether the bot is in voice there. The bot owner also gets the full system details, privately. Fixes the "Unable to show bot info" error
- `/leaderboard`, `/streamers` and `/botinfo` are posted in the channel. `/leaderboard` has a period option (all time, 7 or 30 days)
- Voice and live stats are kept until the bot leaves a server. A server can opt in to a yearly reset on 1 January in `/setup` > Voice leaderboard
- Steam free games now come straight from the Steam store, in the same layout as PatchBot: price, release date, reviews and platforms. Games that need another account are no longer posted
- Game updates: **Send latest post as a test** in `/setup` > Game updates > Manage alerts, and the add confirmation points to it

## 5.4.1

- Durations read naturally everywhere: `1 day 1 hour 10 minutes` instead of `34h 10m`
- Voice panel redesigned: status, channel, members in voice, connected time, uptime and memory, with the top three this week at the bottom
- Voice leaderboard and `/streamers` lists spaced out so they are easier to read
- Free games: Epic, Steam and GOG each have their own on/off button in `/setup` > Free games. `/free-games` shows all three
- Deleted POW-Bot log messages are now logged like any other deleted message

## 5.4.0

- Game update posts redesigned: game name, linked title, large section headings, sub-headings and bullet lists, a small game icon, and the Read full notes and Open store page buttons
- Optional weekly or monthly voice leaderboard post, set up in `/setup` > Voice leaderboard > Scheduled post
- `/privacy`: see what the bot has stored about you and delete it
- Stored data now ages out: join and leave history after 90 days, voice and live sessions after 1 year (voice time is kept as a total). Everything for a server is deleted when the bot is removed from it
- Permission check now flags a bot role that sits low in the role list and channels the bot cannot see or join
- Weekly backup of the whole application (without `.env`) to the owner's DMs, plus a Back up now button in `/owner`
- Timestamps removed from posts that already show their send time
- Subtle emoji added back to menus, log titles and status lines
- `npm run check` loads every file before you push. `deploy-commands.js` removed: commands register themselves on start

## 5.1 to 5.3

Added or improved

- Streamer, game update and free game alerts are set up in `/setup` with everything else
- Voice leaderboard on the panel and as `/leaderboard`, with role rewards for voice time (preset ladders or your own hours, roles created for you)
- Game update alerts for Steam, Minecraft (Java and Bedrock), Riot, Fortnite, Blizzard and any RSS or Atom feed
- Welcome and leave messages can be edited: card on or off, title, subtitle, colour and message text
- Deleted and edited message logs keep the text for 7 days so they always work, with an optional log for messages deleted from other bots
- `/changelog` shows what has changed in the bot
- Bot status shows server count, member count and hours spent in voice
- Owner announcements: changelog, update, maintenance, incident and event styles, sent to servers and channels chosen each time

Fixed

- Verify button errors when someone clicked twice
- Staff could still press Approve or Kick on a member who had already verified
- One broken command file could stop the whole bot from starting
- The setup permission check missed Read Message History

Removed

- The Bot Info panel button, the subcommands of `/streamers`, `/game-updates` and `/free-games`, and voice channel names in the bot status
