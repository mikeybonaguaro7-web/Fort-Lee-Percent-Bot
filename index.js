require("dotenv").config();

const fs = require("fs");
const path = require("path");
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
  ButtonStyle,
} = require("discord.js");

// ===== ENV VARS =====
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;       // Application ID
const GUILD_ID = process.env.GUILD_ID;         // Server ID
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // Channel where cards post
const MIN_PERCENT = Number(process.env.MIN_PERCENT ?? 40);

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !LOG_CHANNEL_ID) {
  console.error("Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, GUILD_ID, LOG_CHANNEL_ID");
  process.exit(1);
}

// ===== SIMPLE DATA STORE =====
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { nextId: 1, calls: [] };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ===== SAFE HELPERS =====
const asStr = (v, fallback = "") => (v === null || v === undefined ? fallback : String(v));
const nonEmpty = (v, fallback = "N/A") => {
  const s = asStr(v, "").trim();
  return s.length ? s : fallback;
};
const clip = (s, max) => {
  s = asStr(s, "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

// ===== DATE HELPERS (Ridgefield style) =====
function formatRidgefieldDate(date = new Date()) {
  // "Thursday, February 12, 2026 at 9:40 PM" (America/New_York)
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  const weekday = get("weekday");
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const dayPeriod = get("dayPeriod");

  return `${weekday}, ${month} ${day}, ${year} at ${hour}:${minute} ${dayPeriod}`;
}

function monthKey(date = new Date()) {
  // "02 / 2026"
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    year: "numeric",
    timeZone: "America/New_York",
  }).formatToParts(date);

  const mm = parts.find((p) => p.type === "month")?.value;
  const yy = parts.find((p) => p.type === "year")?.value;
  return `${mm} / ${yy}`;
}

function monthKeySortable(date = new Date()) {
  // "2026-02"
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    year: "numeric",
    timeZone: "America/New_York",
  }).formatToParts(date);

  const mm = parts.find((p) => p.type === "month")?.value;
  const yy = parts.find((p) => p.type === "year")?.value;
  return `${yy}-${mm}`;
}

function quarterKey(date = new Date()) {
  const d = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

// ===== ATTENDANCE HELPERS =====
function mentionList(ids) {
  return ids.length ? ids.map((id) => `<@${id}>`).join("\n") : "_None_";
}

function buildAttendanceLists(attendance) {
  const made = [];
  const silent = [];
  const missed = [];
  for (const [uid, st] of Object.entries(attendance || {})) {
    if (st === "MADE") made.push(uid);
    else if (st === "SILENT") silent.push(uid);
    else if (st === "MISSED") missed.push(uid);
  }
  return { made, silent, missed };
}

function buildButtons(callId, points) {
  // Label includes point value like your screenshot buttons: "Made (1)" etc
  const p = Number(points ?? 1);
  const madeLabel = `Made (${p})`;
  const silentLabel = `Silent (${Math.min(0.5, p)})`;
  const missedLabel = `Missed (0)`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`att:${callId}:MADE`)
      .setLabel(madeLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`att:${callId}:SILENT`)
      .setLabel(silentLabel)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`att:${callId}:MISSED`)
      .setLabel(missedLabel)
      .setStyle(ButtonStyle.Danger)
  );
}

// ===== EMBED BUILDER =====
function buildCallEmbed(call) {
  const { made, silent, missed } = buildAttendanceLists(call.attendance);

  const cad = nonEmpty(call.cad, "N/A");
  const ridgeDate = nonEmpty(call.ridgeDate, "Unknown date/time");
  const countTowards = nonEmpty(call.countTowards, "Unknown");
  const points = Number(call.points ?? 1);
  const countsAgainst = Boolean(call.countsAgainst);

  const typeShort = nonEmpty(call.typeShort, "ALARM").toUpperCase();
  const type = nonEmpty(call.type, "Unknown Type");
  const location = nonEmpty(call.location, "Unknown Location");
  const details = asStr(call.details, "").trim();

  const detailBlock =
    `(FortLeeFire-CAD) -\n` +
    `${type}\n` +
    `${location}` +
    (details ? `\n${details}` : "");

  const desc =
    `**CAD Number =** ${cad}\n` +
    `**${ridgeDate}**\n\n` +
    `**Will Count Towards:**\n` +
    `${countTowards}\n\n` +
    `**Points:**\n` +
    `Worth **${points}** point(s) if made.\n` +
    (countsAgainst
      ? `If missed, counts against as **${points}** point(s)\n\n`
      : `If missed, **does not** count against.\n\n`) +
    `**Detail:**\n` +
    `${detailBlock}`;

  const embed = new EmbedBuilder()
    .setTitle(clip(`🚨 ${typeShort} 🚨`, 256))
    .setDescription(clip(desc, 4096))
    .addFields(
      { name: "✅ Made", value: clip(mentionList(made), 1024), inline: true },
      { name: "🔇 Silent", value: clip(mentionList(silent), 1024), inline: true },
      { name: "❌ Missed", value: clip(mentionList(missed), 1024), inline: true }
    )
    .setFooter({ text: clip(`Event ID: ${nonEmpty(call.id, "N/A")}`, 2048) })
    .setTimestamp(call.createdAt ? new Date(call.createdAt) : new Date());

  return embed;
}

// ===== SCORING =====
// countsAgainst = true => always counts in denominator
// countsAgainst = false => only counts if you responded (made/silent)
function calcStats(userId, calls) {
  let possible = 0;
  let earned = 0;
  let made = 0, silent = 0, missed = 0;

  for (const c of calls) {
    const p = Number(c.points) || 0;
    if (p === 0) continue;

    const resp = c.attendance?.[userId]; // MADE/SILENT/MISSED/undefined

    if (c.countsAgainst) {
      possible += p;
      if (resp === "MADE") { earned += p; made++; }
      else if (resp === "SILENT") { earned += Math.min(0.5, p); silent++; }
      else { missed++; }
    } else {
      if (resp === "MADE") { possible += p; earned += p; made++; }
      else if (resp === "SILENT") { possible += p; earned += Math.min(0.5, p); silent++; }
      else { missed++; }
    }
  }

  const pct = possible > 0 ? (earned / possible) * 100 : 0;
  return { possible, earned, pct, made, silent, missed };
}

// ===== COMMANDS =====
const commandDefs = [
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("Post a Ridgefield-style CAD call card")

    // ✅ REQUIRED options FIRST (fixes your error)
    .addIntegerOption(o => o.setName("cad").setDescription("CAD Number").setRequired(true))
    .addStringOption(o => o.setName("type_short").setDescription("ALARM / STRUCTURE / MVA / etc").setRequired(true))
    .addStringOption(o => o.setName("type").setDescription("Full type line (ex: MVC - FLUID SPILL)").setRequired(true))
    .addStringOption(o => o.setName("location").setDescription("Location (ex: GRAND AVE and LINDEN AVE)").setRequired(true))
    .addNumberOption(o => o.setName("points").setDescription("Points for this call").setRequired(true).addChoices(
      { name: "0", value: 0 },
      { name: "0.5", value: 0.5 },
      { name: "1", value: 1 }
    ))
    .addBooleanOption(o => o.setName("counts_against").setDescription("If missed, does it count against you?").setRequired(true))

    // ✅ OPTIONAL options LAST
    .addStringOption(o => o.setName("details").setDescription("Extra details (optional)").setRequired(false))
    .addStringOption(o => o.setName("datetime").setDescription('Optional: "2026-03-02 21:40"').setRequired(false)),

  new SlashCommandBuilder()
    .setName("percent")
    .setDescription("Show your percent (This Month + Lifetime)"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show this month’s leaderboard"),

  new SlashCommandBuilder()
    .setName("rollcall")
    .setDescription("Show who made/silent/missed for a CAD number")
    .addIntegerOption(o => o.setName("cad").setDescription("CAD Number").setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandDefs });
  console.log("✅ Slash commands registered.");
}

// ===== DISCORD CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ===== INTERACTIONS =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // BUTTONS
    if (interaction.isButton()) {
      const [prefix, idStr, status] = interaction.customId.split(":");
      if (prefix !== "att") return;

      const data = loadData();
      const id = Number(idStr);
      const call = data.calls.find(c => c.id === id);
      if (!call) return interaction.reply({ content: "Call not found.", ephemeral: true });

      call.attendance = call.attendance || {};
      call.attendance[interaction.user.id] = status;
      saveData(data);

      const embed = buildCallEmbed(call);
      return interaction.update({ embeds: [embed], components: [buildButtons(call.id, call.points)] });
    }

    // SLASH COMMANDS
    if (!interaction.isChatInputCommand()) return;

    const data = loadData();

    if (interaction.commandName === "call") {
      const cad = interaction.options.getInteger("cad");
      const typeShort = interaction.options.getString("type_short");
      const type = interaction.options.getString("type");
      const location = interaction.options.getString("location");
      const points = Number(interaction.options.getNumber("points"));
      const countsAgainst = interaction.options.getBoolean("counts_against");
      const details = interaction.options.getString("details") || "";
      const dtStr = interaction.options.getString("datetime");

      let dt = new Date();
      if (dtStr) {
        // expects "YYYY-MM-DD HH:MM"
        const normalized = dtStr.trim().replace(" ", "T");
        const parsed = new Date(normalized);
        if (!Number.isNaN(parsed.getTime())) dt = parsed;
      }

      const call = {
        id: data.nextId++,
        cad,
        typeShort,
        type,
        location,
        details,
        points,
        countsAgainst,
        createdAt: new Date().toISOString(),

        ridgeDate: formatRidgefieldDate(dt),
        countTowards: monthKey(dt),
        monthSort: monthKeySortable(dt),
        quarter: quarterKey(dt),

        attendance: {},
      };

      data.calls.push(call);
      saveData(data);

      const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (!logCh) return interaction.reply({ content: "LOG_CHANNEL_ID is wrong in Render.", ephemeral: true });

      await interaction.reply({ content: `✅ Posted CAD ${cad}.`, ephemeral: true });
      await logCh.send({ embeds: [buildCallEmbed(call)], components: [buildButtons(call.id, call.points)] });
      return;
    }

    if (interaction.commandName === "percent") {
      const userId = interaction.user.id;
      const now = new Date();
      const thisMonth = monthKeySortable(now);

      const monthCalls = data.calls.filter(c => c.monthSort === thisMonth);
      const lifeCalls = data.calls;

      const m = calcStats(userId, monthCalls);
      const l = calcStats(userId, lifeCalls);

      const monthStatus = m.pct >= MIN_PERCENT ? "✅" : "❌";
      const lifeStatus = l.pct >= MIN_PERCENT ? "✅" : "❌";

      const embed = new EmbedBuilder()
        .setTitle("📊 Fort Lee % Tracker")
        .setDescription(`Minimum required: **${MIN_PERCENT}%**`)
        .addFields(
          {
            name: `This Month (${monthKey(now)}) ${monthStatus}`,
            value:
              `**${m.pct.toFixed(1)}%** — ${m.earned.toFixed(1)} / ${m.possible.toFixed(1)}\n` +
              `Made: ${m.made} • Silent: ${m.silent} • Missed: ${m.missed}`,
            inline: false
          },
          {
            name: `Lifetime ${lifeStatus}`,
            value:
              `**${l.pct.toFixed(1)}%** — ${l.earned.toFixed(1)} / ${l.possible.toFixed(1)}\n` +
              `Made: ${l.made} • Silent: ${l.silent} • Missed: ${l.missed}`,
            inline: false
          }
        )
        .setTimestamp(new Date());

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "leaderboard") {
      const now = new Date();
      const thisMonth = monthKeySortable(now);
      const monthCalls = data.calls.filter(c => c.monthSort === thisMonth);

      // Gather users who interacted this month
      const users = new Set();
      for (const c of monthCalls) {
        for (const uid of Object.keys(c.attendance || {})) users.add(uid);
      }
      if (users.size === 0) {
        return interaction.reply({ content: "No attendance logged yet this month.", ephemeral: true });
      }

      const rows = [];
      for (const uid of users) {
        const s = calcStats(uid, monthCalls);
        rows.push({ uid, pct: s.pct, earned: s.earned, possible: s.possible });
      }
      rows.sort((a, b) => b.pct - a.pct);

      const lines = rows.slice(0, 25).map((r, i) => {
        const ok = r.pct >= MIN_PERCENT ? "✅" : "❌";
        return `**${i + 1}.** ${ok} <@${r.uid}> — **${r.pct.toFixed(1)}%** (${r.earned.toFixed(1)} / ${r.possible.toFixed(1)})`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Leaderboard — ${monthKey(now)}`)
        .setDescription(lines.join("\n"))
        .setTimestamp(new Date());

      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "rollcall") {
      const cad = interaction.options.getInteger("cad");
      const calls = data.calls.filter(c => c.cad === cad);
      if (!calls.length) return interaction.reply({ content: `No record found for CAD ${cad}.`, ephemeral: true });

      // latest by createdAt
      calls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const call = calls[0];

      const { made, silent, missed } = buildAttendanceLists(call.attendance);

      const embed = new EmbedBuilder()
        .setTitle(`🧾 Roll Call — CAD ${cad}`)
        .setDescription(
          `**${call.ridgeDate}**\n` +
          `**Will Count Towards:** ${call.countTowards}\n\n` +
          `✅ **Made**\n${mentionList(made)}\n\n` +
          `🔇 **Silent**\n${mentionList(silent)}\n\n` +
          `❌ **Missed**\n${mentionList(missed)}`
        )
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

client.login(TOKEN);
