require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;     // Application ID
const GUILD_ID = process.env.GUILD_ID;       // Server ID
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;       // where cards are posted
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID; // where auto reports go (optional)

const MIN_PERCENT = 40;

// ===== DATA (simple JSON store) =====
// NOTE: Render can wipe local files on redeploy unless you add a persistent disk.
// This works fine to start; if you want guaranteed history, we’ll switch to a DB later.
const DATA_FILE = path.join(__dirname, "fortlee_data.json");

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { nextId: 1, events: [] };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function nowISO() {
  return new Date().toISOString();
}
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function quarterKey(d = new Date()) {
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function formatMonthForCard(yyyyMm) {
  const [y, m] = yyyyMm.split("-");
  return `${m} / ${y}`;
}

function pointsText(points, countsAgainst) {
  if (!countsAgainst) {
    return `Worth **${points}** point(s) if made.\nIf missed, **does not** count against you.`;
  }
  return `Worth **${points}** point(s) if made.\nIf missed, counts against as **${points}** point(s).`;
}

function buildAttendanceLists(attendance) {
  const made = [];
  const silent = [];
  const missed = [];

  for (const [uid, status] of Object.entries(attendance || {})) {
    if (status === "MADE") made.push(uid);
    if (status === "SILENT") silent.push(uid);
    if (status === "MISSED") missed.push(uid);
  }
  return { made, silent, missed };
}

function mentionList(uids) {
  return uids.length ? uids.map(id => `<@${id}>`).join("\n") : "_None_";
}

function buildCardEmbed(evt) {
  const d = new Date(evt.datetimeISO || evt.createdAtISO);
  const dateLine = d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

  const { made, silent, missed } = buildAttendanceLists(evt.attendance);

  const embed = new EmbedBuilder()
    .setTitle(`🚨 ${evt.incidentType.toUpperCase()} 🚨`)
    .setDescription([
      `**CAD Number =** ${evt.cadNumber}`,
      `**${dateLine}**`,
      ``,
      `**Will Count Towards:**`,
      `${formatMonthForCard(evt.countsTowardMonth)}`,
      ``,
      `**Points:**`,
      pointsText(evt.points, evt.countsAgainst),
      ``,
      `**Detail:**`,
      evt.detail?.trim() ? evt.detail : "_No detail_"
    ].join("\n"))
    .addFields(
      { name: "✅ Made", value: mentionList(made), inline: true },
      { name: "🔇 Silent", value: mentionList(silent), inline: true },
      { name: "❌ Missed", value: mentionList(missed), inline: true }
    )
    .setFooter({ text: `Event ID: ${evt.id}` })
    .setTimestamp(new Date(evt.createdAtISO));

  return embed;
}

function buildButtons(evtId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`att:${evtId}:MADE`).setLabel("Made").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`att:${evtId}:SILENT`).setLabel("Silent").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`att:${evtId}:MISSED`).setLabel("Missed").setStyle(ButtonStyle.Danger)
  );
}

function createEvent({ cadNumber, incidentType, detail, points, countsAgainst, datetimeISO }) {
  const data = loadData();
  const id = data.nextId++;

  const createdAtISO = nowISO();
  const dt = datetimeISO ? new Date(datetimeISO) : new Date();

  const evt = {
    id,
    cadNumber,
    incidentType,
    detail: detail || "",
    points,                       // 0 / 0.5 / 1
    countsAgainst,                // true/false
    createdAtISO,
    datetimeISO: dt.toISOString(),
    countsTowardMonth: monthKey(dt),
    quarter: quarterKey(dt),
    attendance: {}                // userId -> MADE/SILENT/MISSED
  };

  data.events.push(evt);
  saveData(data);
  return evt;
}

function findEvent(id) {
  const data = loadData();
  return data.events.find(e => e.id === id);
}

function updateAttendance(eventId, userId, status) {
  const data = loadData();
  const evt = data.events.find(e => e.id === eventId);
  if (!evt) return null;
  evt.attendance[userId] = status;
  saveData(data);
  return evt;
}

// Percent logic:
// - Each event contributes "possible" = (countsAgainst ? points : points) … but if points=0 it’s informational.
// - If countsAgainst=false, it still can give credit (points) but doesn’t penalize missed.
//   For a standard percent, we treat possible as points either way (so making it helps, missing doesn't hurt).
//   If you want "countsAgainst=false" to NOT affect percent at all, set possible=0 below.
function calcStatsForUser(userId, filterFn) {
  const data = loadData();
  const events = data.events.filter(filterFn);

  let possible = 0;
  let earned = 0;
  let counts = { made: 0, silent: 0, missed: 0 };

  for (const e of events) {
    const p = Number(e.points) || 0;

    // Informational events (0 points) do not affect percent.
    if (p === 0) continue;

    // Possible points count toward denominator.
    // This keeps 0.5 calls weighted correctly.
    possible += p;

    const st = e.attendance[userId] || "MISSED"; // if you never clicked, treat as missed

    if (st === "MADE") { earned += p; counts.made++; }
    else if (st === "SILENT") { earned += 0.5; counts.silent++; } // silent always 0.5
    else { // MISSED
      counts.missed++;
      // If countsAgainst is false, missing should not penalize beyond just not earning points.
      // (earned already not increased)
    }
  }

  const pct = possible > 0 ? (earned / possible) * 100 : 0;
  return { earned, possible, pct, counts };
}

async function postAutoMonthlyReport(client) {
  if (!REPORT_CHANNEL_ID) return;

  const ch = await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);
  if (!ch) return;

  const m = monthKey(new Date()); // current month
  // This report is best when you add more people. For now it just shows overall totals in the server.
  const data = loadData();

  // Collect unique users who clicked anything this month
  const users = new Set();
  for (const e of data.events) {
    if (e.countsTowardMonth !== m) continue;
    for (const uid of Object.keys(e.attendance || {})) users.add(uid);
  }

  // If nobody clicked yet, still post something
  if (users.size === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`📊 Fort Lee Monthly Report — ${formatMonthForCard(m)}`)
      .setDescription("No attendance logged yet this month.")
      .setTimestamp(new Date());
    await ch.send({ embeds: [embed] });
    return;
  }

  const lines = [];
  for (const uid of users) {
    const stats = calcStatsForUser(uid, e => e.countsTowardMonth === m);
    const status = stats.pct >= MIN_PERCENT ? "✅" : "❌";
    lines.push(`${status} <@${uid}> — **${stats.pct.toFixed(1)}%** (${stats.earned.toFixed(1)} / ${stats.possible.toFixed(1)})`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 Fort Lee Monthly Report — ${formatMonthForCard(m)}`)
    .setDescription(lines.join("\n"))
    .setTimestamp(new Date());

  await ch.send({ embeds: [embed] });
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("Create a Fort Lee CAD card (Ridgefield-style)")
    .addStringOption(o => o.setName("cad").setDescription("CAD number").setRequired(true))
    .addStringOption(o => o.setName("type").setDescription("Alarm / Structure / MVA / etc.").setRequired(true))
    .addStringOption(o => o.setName("detail").setDescription("Details (address, notes, etc.)").setRequired(false))
    .addNumberOption(o =>
      o.setName("points")
        .setDescription("Points for this call")
        .setRequired(true)
        .addChoices(
          { name: "0", value: 0 },
          { name: "0.5", value: 0.5 },
          { name: "1", value: 1 }
        )
    )
    .addBooleanOption(o =>
      o.setName("counts_against")
        .setDescription("If missed, does it count against you?")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("datetime")
        .setDescription('Optional. Format: "2026-02-12 21:40" (local time)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("percent")
    .setDescription("Show your Monthly + Quarterly percent (min 40%)"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show ranking for this month (for when you add more members)")
].map(c => c.toJSON());

async function registerCommands() {
  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing env vars: DISCORD_TOKEN, CLIENT_ID, GUILD_ID are required.");
    process.exit(1);
  }
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  await registerCommands();

  // Auto monthly report at 00:05 on the 1st of each month (optional)
  cron.schedule("5 0 1 * *", async () => {
    await postAutoMonthlyReport(client);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // BUTTONS
    if (interaction.isButton()) {
      const [prefix, idStr, status] = interaction.customId.split(":");
      if (prefix !== "att") return;

      const eventId = Number(idStr);
      const updated = updateAttendance(eventId, interaction.user.id, status);
      if (!updated) {
        return interaction.reply({ content: "Couldn’t find that event.", ephemeral: true });
      }

      // Update the same message (Ridgefield style where the card updates)
      const embed = buildCardEmbed(updated);
      await interaction.update({ embeds: [embed], components: [buildButtons(updated.id)] });
      return;
    }

    // SLASH COMMANDS
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "call") {
      const cad = interaction.options.getString("cad");
      const type = interaction.options.getString("type");
      const detail = interaction.options.getString("detail") || "";
      const points = interaction.options.getNumber("points");
      const countsAgainst = interaction.options.getBoolean("counts_against");
      const dtStr = interaction.options.getString("datetime");

      let dtISO = null;
      if (dtStr) {
        // best-effort parse: "YYYY-MM-DD HH:MM"
        const normalized = dtStr.replace(" ", "T");
        const parsed = new Date(normalized);
        if (!isNaN(parsed.getTime())) dtISO = parsed.toISOString();
      }

      const evt = createEvent({
        cadNumber: cad,
        incidentType: type,
        detail,
        points,
        countsAgainst,
        datetimeISO: dtISO
      });

      const embed = buildCardEmbed(evt);
      const row = buildButtons(evt.id);

      const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (!logCh) {
        return interaction.reply({ content: "I can’t find LOG_CHANNEL_ID. Check your Render env vars.", ephemeral: true });
      }

      await interaction.reply({ content: `✅ Posted CAD card (Event ID #${evt.id}).`, ephemeral: true });
      await logCh.send({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.commandName === "percent") {
      const now = new Date();
      const m = monthKey(now);
      const q = quarterKey(now);

      const monthStats = calcStatsForUser(interaction.user.id, e => e.countsTowardMonth === m);
      const quarterStats = calcStatsForUser(interaction.user.id, e => e.quarter === q);

      const monthOK = monthStats.pct >= MIN_PERCENT ? "✅" : "❌";
      const quarterOK = quarterStats.pct >= MIN_PERCENT ? "✅" : "❌";

      const embed = new EmbedBuilder()
        .setTitle("📊 Fort Lee Percentage")
        .setDescription(`Minimum required: **${MIN_PERCENT}%**`)
        .addFields(
          {
            name: `Monthly (${formatMonthForCard(m)}) ${monthOK}`,
            value: `**${monthStats.pct.toFixed(1)}%**  —  ${monthStats.earned.toFixed(1)} / ${monthStats.possible.toFixed(1)}\nMade: ${monthStats.counts.made} • Silent: ${monthStats.counts.silent} • Missed: ${monthStats.counts.missed}`,
            inline: false
          },
          {
            name: `Quarterly (${q}) ${quarterOK}`,
            value: `**${quarterStats.pct.toFixed(1)}%**  —  ${quarterStats.earned.toFixed(1)} / ${quarterStats.possible.toFixed(1)}\nMade: ${quarterStats.counts.made} • Silent: ${quarterStats.counts.silent} • Missed: ${quarterStats.counts.missed}`,
            inline: false
          }
        )
        .setTimestamp(new Date());

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "leaderboard") {
      const now = new Date();
      const m = monthKey(now);
      const data = loadData();

      // find users who clicked anything this month
      const users = new Set();
      for (const e of data.events) {
        if (e.countsTowardMonth !== m) continue;
        for (const uid of Object.keys(e.attendance || {})) users.add(uid);
      }

      if (users.size === 0) {
        return interaction.reply({ content: "No attendance logged yet this month.", ephemeral: true });
      }

      const rows = [];
      for (const uid of users) {
        const s = calcStatsForUser(uid, e => e.countsTowardMonth === m);
        rows.push({ uid, pct: s.pct, earned: s.earned, possible: s.possible });
      }

      rows.sort((a, b) => b.pct - a.pct);

      const lines = rows.slice(0, 25).map((r, i) => {
        const ok = r.pct >= MIN_PERCENT ? "✅" : "❌";
        return `**${i + 1}.** ${ok} <@${r.uid}> — **${r.pct.toFixed(1)}%** (${r.earned.toFixed(1)} / ${r.possible.toFixed(1)})`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Leaderboard — ${formatMonthForCard(m)}`)
        .setDescription(lines.join("\n"))
        .setTimestamp(new Date());

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: "Error — check Render logs.", ephemeral: true }); } catch {}
    }
  }
});

client.login(DISCORD_TOKEN);
