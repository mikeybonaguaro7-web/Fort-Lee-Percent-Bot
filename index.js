const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

// =====================
// CONFIG (ENV VARS)
// =====================
// REQUIRED:
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID (Discord Dev Portal -> General Information)
const GUILD_ID = process.env.GUILD_ID;   // Your server ID (right click server -> Copy ID)

// OPTIONAL:
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || ""; // channel where bot posts cards (optional)

// SCORING:
const MIN_PERCENT = 40;
const POINTS = {
  made: 1,
  silent: 0.5,
  missed: 0
};

// Data file (note: Render free services can lose local files on redeploy unless you add a persistent disk)
const DATA_FILE = path.join(__dirname, "data.json");

// =====================
// STORAGE HELPERS
// =====================
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { events: [], nextEventId: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { events: [], nextEventId: 1 };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// =====================
// TIME HELPERS
// =====================
function yyyyMm(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function quarterKey(date = new Date()) {
  const y = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

// =====================
// EVENT / REPORT LOGIC
// =====================
function createEvent({ type, title, details, createdBy, timestamp }) {
  const data = loadData();
  const id = data.nextEventId++;

  const event = {
    id,
    type,               // "call" | "drill"
    title,              // e.g. "CALL" or "DRILL/MEETING"
    details: details || "",
    createdBy,
    timestamp: timestamp || Date.now(),
    month: yyyyMm(new Date(timestamp || Date.now())),
    quarter: quarterKey(new Date(timestamp || Date.now())),
    // attendance maps userId -> "made" | "silent" | "missed"
    attendance: {}
  };

  data.events.push(event);
  saveData(data);
  return event;
}

function getEventById(eventId) {
  const data = loadData();
  return data.events.find(e => e.id === eventId);
}

function updateAttendance(eventId, userId, status) {
  const data = loadData();
  const e = data.events.find(ev => ev.id === eventId);
  if (!e) return null;
  e.attendance[userId] = status;
  saveData(data);
  return e;
}

function computeUserStats(userId, monthKey, quarter) {
  const data = loadData();
  const monthEvents = data.events.filter(e => e.month === monthKey);
  const quarterEvents = data.events.filter(e => e.quarter === quarter);

  const calc = (events) => {
    let possible = 0;
    let earned = 0;
    let counts = { made: 0, silent: 0, missed: 0 };

    for (const e of events) {
      // every event is worth 1 possible point
      possible += 1;

      const status = e.attendance[userId] || null;
      if (status === "made") { earned += POINTS.made; counts.made++; }
      else if (status === "silent") { earned += POINTS.silent; counts.silent++; }
      else if (status === "missed") { earned += POINTS.missed; counts.missed++; }
      else {
        // not responded yet => treat as missed? (You can change this behavior)
        // We'll treat "no response" as missed so it counts against you.
        earned += 0;
        counts.missed++;
      }
    }

    const pct = possible === 0 ? 0 : (earned / possible) * 100;
    return { possible, earned, pct, counts, totalEvents: events.length };
  };

  return {
    month: calc(monthEvents),
    quarter: calc(quarterEvents),
    monthEvents,
    quarterEvents
  };
}

function attendanceLists(event) {
  const made = [];
  const silent = [];
  const missed = [];

  for (const [uid, status] of Object.entries(event.attendance || {})) {
    if (status === "made") made.push(uid);
    else if (status === "silent") silent.push(uid);
    else if (status === "missed") missed.push(uid);
  }

  return { made, silent, missed };
}

function eventEmbed(event) {
  const { made, silent, missed } = attendanceLists(event);

  const embed = new EmbedBuilder()
    .setTitle(`${event.title}  •  ID #${event.id}`)
    .setDescription(event.details?.trim() ? event.details : "_No details provided_")
    .addFields(
      { name: "Counts Toward", value: `${event.month}  (${event.quarter})`, inline: true },
      { name: "Created", value: formatDateTime(event.timestamp), inline: true },
      { name: "Points", value: "Made = 1 • Silent = 0.5 • Missed = 0 (counts against)", inline: false }
    )
    .addFields(
      { name: "✅ Made", value: made.length ? made.map(id => `<@${id}>`).join("\n") : "_None_", inline: true },
      { name: "🔇 Silent", value: silent.length ? silent.map(id => `<@${id}>`).join("\n") : "_None_", inline: true },
      { name: "❌ Missed", value: missed.length ? missed.map(id => `<@${id}>`).join("\n") : "_None_", inline: true }
    );

  return embed;
}

function eventButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`att:${eventId}:made`)
      .setLabel("Made (1)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`att:${eventId}:silent`)
      .setLabel("Silent (0.5)")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`att:${eventId}:missed`)
      .setLabel("Missed (0)")
      .setStyle(ButtonStyle.Danger)
  );
}

// =====================
// SLASH COMMANDS
// =====================
const commands = [
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("Create a Fort Lee call card")
    .addStringOption(opt =>
      opt.setName("details")
        .setDescription("CAD#, type, address, notes, etc.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("drill")
    .setDescription("Create a Fort Lee drill/meeting card")
    .addStringOption(opt =>
      opt.setName("details")
        .setDescription("Topic, location, notes, etc.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("percent")
    .setDescription("Show your Monthly + Quarterly percentage report"),

  new SlashCommandBuilder()
    .setName("who")
    .setDescription("Show who made/silent/missed for a specific call/drill ID")
    .addIntegerOption(opt =>
      opt.setName("id")
        .setDescription("Event ID number (from the card title)")
        .setRequired(true)
    )
].map(c => c.toJSON());

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, GUILD_ID.");
    process.exit(1);
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Registered guild slash commands.");
}

// =====================
// DISCORD CLIENT
// =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Command register failed:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    // Buttons
    if (interaction.isButton()) {
      const [prefix, eventIdStr, status] = interaction.customId.split(":");
      if (prefix !== "att") return;

      const eventId = Number(eventIdStr);
      const updated = updateAttendance(eventId, interaction.user.id, status);

      if (!updated) {
        return interaction.reply({ content: "Could not find that event.", ephemeral: true });
      }

      // Update the original message embed
      const embed = eventEmbed(updated);
      const row = eventButtons(updated.id);

      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "call") {
      const details = interaction.options.getString("details") || "";
      const event = createEvent({
        type: "call",
        title: "CALL",
        details,
        createdBy: interaction.user.id
      });

      const embed = eventEmbed(event);
      const row = eventButtons(event.id);

      // Post to current channel (or forced log channel if set)
      const targetChannel = LOG_CHANNEL_ID
        ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null)
        : interaction.channel;

      if (!targetChannel) {
        return interaction.reply({ content: "I couldn't find the log channel. Check LOG_CHANNEL_ID.", ephemeral: true });
      }

      await interaction.reply({ content: `✅ Created CALL card (ID #${event.id}).`, ephemeral: true });
      await targetChannel.send({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.commandName === "drill") {
      const details = interaction.options.getString("details") || "";
      const event = createEvent({
        type: "drill",
        title: "DRILL / MEETING",
        details,
        createdBy: interaction.user.id
      });

      const embed = eventEmbed(event);
      const row = eventButtons(event.id);

      const targetChannel = LOG_CHANNEL_ID
        ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null)
        : interaction.channel;

      if (!targetChannel) {
        return interaction.reply({ content: "I couldn't find the log channel. Check LOG_CHANNEL_ID.", ephemeral: true });
      }

      await interaction.reply({ content: `✅ Created DRILL/MEETING card (ID #${event.id}).`, ephemeral: true });
      await targetChannel.send({ embeds: [embed], components: [row] });
      return;
    }

    if (interaction.commandName === "percent") {
      const now = new Date();
      const monthKey = yyyyMm(now);
      const qKey = quarterKey(now);

      const stats = computeUserStats(interaction.user.id, monthKey, qKey);

      const monthStatus = stats.month.pct >= MIN_PERCENT ? "✅ Made it" : "❌ Below minimum";
      const quarterStatus = stats.quarter.pct >= MIN_PERCENT ? "✅ Made it" : "❌ Below minimum";

      const embed = new EmbedBuilder()
        .setTitle("Fort Lee % Tracker — Your Report")
        .setDescription(`Minimum Required: **${MIN_PERCENT}%**`)
        .addFields(
          {
            name: `Monthly (${monthKey})`,
            value:
              `Points Earned: **${stats.month.earned.toFixed(1)}** / **${stats.month.possible}**\n` +
              `Made: **${stats.month.counts.made}** • Silent: **${stats.month.counts.silent}** • Missed: **${stats.month.counts.missed}**\n` +
              `Percent: **${stats.month.pct.toFixed(1)}%**\n` +
              `Status: **${monthStatus}**`,
            inline: false
          },
          {
            name: `Quarterly (${qKey})`,
            value:
              `Points Earned: **${stats.quarter.earned.toFixed(1)}** / **${stats.quarter.possible}**\n` +
              `Made: **${stats.quarter.counts.made}** • Silent: **${stats.quarter.counts.silent}** • Missed: **${stats.quarter.counts.missed}**\n` +
              `Percent: **${stats.quarter.pct.toFixed(1)}%**\n` +
              `Status: **${quarterStatus}**`,
            inline: false
          }
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "who") {
      const id = interaction.options.getInteger("id");
      const event = getEventById(id);
      if (!event) return interaction.reply({ content: "No event found with that ID.", ephemeral: true });

      const embed = eventEmbed(event);
      const row = eventButtons(event.id);
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "Something went wrong. Check Render logs.", ephemeral: true });
      } catch {}
    }
  }
});

client.login(TOKEN);
