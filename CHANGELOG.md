# Changelog

## 5.10.0

- **Cards where they help, embeds everywhere else.** The live panel, My card and member cards, Wrapped, busy times, the weekly recap, the leaderboard, and streamer, game update and free game posts stay as picture cards (links stay clickable buttons, and the people and channels in them are repeated above the card as real mentions). Everything else is now a classic Discord embed: verification, reaction roles, help, setup and `/owner` screens, confirmations, polls, announcements, log entries and error replies. A card that cannot be drawn, or is too long to read as a picture, is still sent as the embed. Embeds send faster, and their text can be copied and read by a screen reader. Each server can switch the picture cards to embeds with `/setup` > Display > **Card style**; the panel embed shows the same figures as the card, and the card image has a spoken description. The older per-area choices on that page still work
- **Verification wording.** The prompt, code screen, "Why verify?" and the replies are shorter and plainer, with no emoji or exclamation marks. Buttons are now **Verify** and **New image**
- **Fewer false alarms.** A brief Discord voice-server drop (errors like 522 or 503) is now a warning, not an error, and the hourly check rejoins as before. If Discord rate-limits the alert webhook (429), the bot waits the time Discord asks for and tries once more instead of losing the alert
- **Game Updates Hub.** Set `GAME_UPDATES_HUB_GUILD_ID` to your own server's ID (the bot needs Manage Channels there) and every game update is also copied there, one channel per game under a "Game Updates" category, posted once however many servers follow the game. If the server has Community on, the channels are Announcement channels, so anyone can follow them with Discord's Follow button. Other servers keep their own updates channel and are not affected. `/owner` > Owner tools shows whether it is connected
- **Alert timing.** `/owner` > Alerts > Digest and memory > Timing sets how long a repeat of the same alert is held back (1 minute to 1 hour), how often errors can ping you (5 minutes to 4 hours) and the most alerts per minute. The console digest shows the latest 14 lines instead of 6
- **Cleaner alerts.** Webhook, DM and channel alerts now share one layout: a label on top (Error, Warning, Change, Notice, Memory, Console digest), the plain-English cause, then short fields (server, user, code, where). Repeats and skipped alerts are worded clearly. The console digest reads the new log lines, shows 12-hour times, and has one row of memory, CPU, uptime and calls
- **More on My card and Wrapped.** My card shows your longest streak ever with its dates (not only the current one), your busiest day and your time streaming. My Server Time Wrapped and Server Wrapped show the streak with its dates, time streaming, and who streamed the most. Streaks no longer use imported totals, which have no dates
- **Owner tools** (`/owner` > Owner tools): Stat check (how one member's voice days, streaks and streams add up), Health (how long the bot goes without being able to answer, memory, database size), Game Updates Hub status, Switch commands off (a command you switch off answers politely for everyone but you and bot admins; `/owner`, `/setup` and `/help` can never be switched off) and Save data now
- **Announcement formatting.** After writing an announcement, Format text lets you pick the title style (bold, large, medium or small heading, capitals, small grey), bullets or numbers, words to make bold, the colour and whether the footer shows. The preview updates as you choose
- **Bot status.** 22 templates, seven ready-made sets (Minimal, Community, Voice focused, Stats showcase, Gaming, Professional, Day and time) and a shuffle option. New placeholders: `{today}`, `{calls}`, `{streaming}`, `{commands}`, `{day}`, `{time}`
- **Server options** in `/setup` > Display: an accent colour for the bot's posts and replies, and a 12 or 24 hour clock. Times read like `9:00 PM` by default
- **One tap channel.** Streamer alerts, game updates, free games and the scheduled leaderboard post offer "Use #announcements" when the server has an announcement channel
- **Names on cards.** Small capitals, stacked "zalgo" accents, odd brackets and symbols the font cannot draw are cleaned from names, so they no longer show as empty boxes

## 5.9.1

- **Console lines.** Every line is now `LEVEL | TAG | sentence | details` and starts with one of Discloud's own levels (trace, debug, info, warn, error, fatal) in its colours, so Discloud's filters and search work on all of them. Each tag has its own colour, so lines are easy to tell apart at a glance. HEART, VOICE and AUDIT are tags on info lines, a lost call is a warning, and an uncaught exception is fatal
- **Heartbeat.** One line an hour (`Connected | all 8 healthy | up …`) instead of a line per server. Server details only appear on a problem, and reconnects only when an error caused one
- **Slow replies.** The bot now tells Discord it is working sooner (after 0.7 seconds, and a watchdog at 2.3 seconds for commands that are slow to start), so a slow moment no longer becomes "Unknown interaction". A reply that still arrives too late is logged as a warning, not an error. Database saves are less frequent, because each one briefly holds the bot up
- **Streaks in Wrapped** now count every day a call ran into, so a session across midnight no longer breaks a streak (My card already did this)
- **Time zones.** `/setup` > Display has a time zone choice for the server (UK time unless the bot's `TZ` says otherwise). Busy times, Wrapped's busiest hour and the charts use it instead of UTC
- **Wrapped cards** are sent as separate messages, because Discord was putting the stats card and the chart side by side and cropping both

## 5.9.0

- **Role menus.** `/setup` > Role menus: write a title, choose up to 15 roles, a channel and whether members pick one or any, and the bot posts a message with a drop-down. Picking gives the roles and removes the ones no longer chosen. Menus can be posted again or removed from the same page
- **Join to create.** `/setup` > Join to create: pick a hub voice channel (or let the bot make one). Whoever joins it gets a voice room named after them, with control of it, and is moved in. The room is deleted when it empties, including after a restart. Room name and user limit are chosen in setup
- **`/poll`.** Discord's own polls: a question, two to six choices, how long it stays open and whether people can pick more than one. Votes are counted live by Discord
- **Leaderboard: ignore time alone.** A new switch in `/setup` > Voice leaderboard. When on, time spent in a call with nobody else does not count
- **Verification has its own log.** It used to share the member join/leave log. Servers that had one keep getting verification results in the same channel until they choose another under Logs > Verification. Raid alerts no longer fall back to the join/leave log (they use their own channel or the Moderation log)
- **Duplicate game updates fixed.** Steam's feed and its news API number the same post differently, and which one answered could change between checks, so one post could be announced twice. Every number and the title are now remembered
- **Deleted by:** Discord writes its audit entry a moment after announcing a delete, so the lookup now checks again after about two seconds
- **Owner tools:** a **Server tools** page for each server (what it has set up, stored data, log channels), a look override, features you can lock off for one server only (streamer alerts, game alerts, AutoMod, raid protection, Check Point), **Export data** and **Erase data** for one server, a **Usage** page (the last 30 days, top commands) and a **Recent errors** list
- **Memory:** cards are drawn at a smaller internal size, the image and card caches are smaller, and Discord.js forgets cached messages after 15 minutes. Most of the bot's memory is the libraries it loads (about 150 MB before it does anything), so expect a lower baseline rather than a dramatic drop

## 5.8.1

- **Voice panel redesign.** The title is your server's name, with a green **Bot online** label above it and **Bot is in** and the channel on the right. Under it: who is in the call, with their picture and how long each has been there, then six figures along the bottom: server voice today, most at once today, calls today, bot in call for, bot memory and bot uptime. When the bot is not in a call it shows the week's top three instead
- **Fewer buttons.** Only **Join**, **Move**, **Leave**, **Leaderboard** and **My card** are buttons. Busy times, Weekly recap, Server Wrapped, My Server Time Wrapped and User lookup are in the **More** menu
- **Deleted pictures** now show as their own message holding only the picture, after the log entry, instead of inside it. The channel is shown once, not twice
- **Owner commands are never logged.** `/owner` and its buttons no longer appear in any server's command log
- **Clickable names in logs.** A card is a picture, so the people, roles and channels in a log entry are also shown as real mentions in a small line above it (without pinging anyone)
- **Who deleted a message** is now found even when Discord merges several deletes by the same moderator into one entry. (When people delete their own messages Discord does not say who did it, so no "Deleted by" is shown)
- **Cards:** labels that were too long for their column ("Top voice chan…") are now set slightly smaller or shortened so nothing is cut off

## 5.8.0

- **Logs are readable.** Audit entries no longer show raw IDs or permission numbers: channels and roles are mentions, levels and durations are words, and permission changes list what was allowed or denied
- **One home for every log.** The Moderation page no longer has its own channel picker; it links to Logs. Server changes only go to the Server log (servers that relied on the old fallback are carried over once), and the Logs page shows where AutoMod, Raid protection and Security Check Point write
- **Lighter and faster.** Server settings are cached in memory and saved safely, Discord.js keeps fewer messages and no presences in memory, database saves are batched every 5 seconds and the card caches are smaller
- **New voice panel.** The title is now the channel the bot is in, under a small "Bot is in" label, with time in the call, people in the call, status, memory, bot uptime and reconnects. **Join** lets you choose the channel (a button for yours, or a menu of every voice channel with how many people are in it). **Move** (blurple) picks a channel and asks to confirm. **Leave** asks to confirm
- **My card:** a cleaner member card with voice time, sessions, streak, favourite voice channel and when you joined
- **Busy times:** people in voice now, how many usually are at this time ("5 to 7 people"), the peak today and the peak of the week, with a chart
- **Weekly recap:** the last 7 days in voice: time, people, longest call, busiest day, top three and your own week
- **My Server Time Wrapped:** your year in the server: messages, reactions, voice time, favourite text and voice channel, longest streak, busiest day, most active hour, days active, first message, who you spent the most time with, a persona and a month-by-month chart. Open it any time from the panel's More menu. **Server Wrapped** is the whole server's version
- **`/setup` > Wrapped:** switch message and reaction counting on or off (numbers only, never text, from the moment it is switched on), choose the channel and the December day for the automatic Server Wrapped post (or use the server's own announcement channel in one tap), post it now, or erase the counts
- Counts are removed with `/privacy`, and when the bot leaves a server. The privacy policy now lists them
- Live stream posts now carry the same "Updated … ago" line as the panel
- Wide cards can now hold more: up to four columns of facts, and charts sit on their own card so they stay readable

## 5.7.2

- **Cards read bigger.** Discord shrinks any picture taller than about 400 pixels, which is why long cards were small. Tall messages (leaderboard, streamers, setup home, long notes) are now drawn wide with the text in two columns, so they stay readable and no longer fall back to a classic embed
- **Fixed:** names and channels were drawn as two or three separate boxes, and some channel names showed black blocks (invisible filler characters). Each name is now one box and the blanks are removed
- **Streamers** list is more compact: the alert channel and ping role are written once when every streamer shares them
- **Panel refresh:** the control panel now carries a live "Updated … ago" line, and `/setup` > Voice panel has a refresh choice: edit in place every minute, or delete and post again every 5, 15 or 60 minutes so its sent time stays fresh
- **Deleted pictures** are now kept in the log entry: the picture is copied when the message is deleted, so it shows in the log even after Discord removes it
- `/botinfo` shows memory use instead of latency
- Faster and steadier replies: repeated cards are reused, and a command that already waited too long for the bot gets the plain embed instead of timing out

## 5.7.1

- **Fixed:** the control panels in every server failed to update ("Could not update panel") because the new card layer took the wrong argument when the bot edits an existing message
- **Fixed:** commands and buttons could time out ("didn't respond in time") while the first card was being drawn. Fonts and emoji are now loaded at start-up, and if a card is slow the bot now acknowledges first and fills it in a moment later
- **New `/setup` > Display page:** each server chooses how the bot's messages look, for everything or per area (Setup screens, Logs, Commands and buttons, Posts and alerts). **Smart** (default) draws a card, but sends a classic embed when the message is too long to read as a picture. **Always cards** and **Classic embeds** are there too. The bot owner can still switch cards off for everyone, or force a look in one server
- **Bigger, clearer cards:** a narrower card with larger text, so it is readable without opening the picture
- Game update posts no longer show the same address twice ("Read full notes" and "Open")
- Channel and role names with emoji, fancy lettering or decorative symbols now show properly in cards

## 5.7.0

- **One look everywhere.** Every message the bot sends, in every command, every `/setup` page, the owner hub, logs, alerts and posts, is now drawn as a dark card in the same style as the Wrapped card, with no plain grey boxes left. Links inside a card appear as buttons underneath, and the picture carries hidden alt text for screen readers. The owner can switch this off with **Card panels** in `/owner` > Maintenance and features (the old plain embeds come back instantly)
- **Message logs can ignore roles, people and bots** as well as channels, from the new **Ignore lists** page. Anything from an ignored person or role is left out of the deleted and edited logs and its text is not even kept
- **Voice log switches**: choose which of joins, leaves, moves, server mutes and deafens, streams, and "bot dragged out" are logged
- **Route server changes by kind**: send roles to one channel, invites to another, and so on, from **Route by kind** on the Server changes page. Anything without its own channel still goes to the main Server log
- **Console digest destination**: `/owner` > Alerts > Digest and memory now lets you send the digest to your webhook or alerts channel, to your DMs, or both. Digest summary counts are easier to read
- Console lines show each detail with a dimmer name and a lighter value, and very long values are clipped. The `|||` info style is unchanged

## 5.6.0

- **Logs overhaul** (`/setup` > Logs): every log now has its own page with a channel, a **test entry** button and, where it makes sense, switches for each kind of event
- **New Server changes log**: channels (including permission changes), roles, member roles, nicknames, emoji and stickers, invites, threads, webhooks and bots, server settings, Discord's AutoMod rules and blocked messages, and scheduled events, all with **who did it**. Servers that never choose a Server log keep getting these in their Moderation log, so nothing changes until staff pick a channel
- Message logs can **ignore channels**, and deleted messages, edited messages and bulk deletes can each be switched off
- **Owner controls**: new global switches in `/owner` > Maintenance and features for Raid protection, AutoMod and the Security Check Point, so any of them can be turned off in every server at once

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
