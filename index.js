require("dotenv").config();
const cron = require("node-cron");
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== YOUR CONFIG =====
const OWNER_ID = process.env.OWNER_ID;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;

// Store calls temporarily
const activeCalls = new Map();

// Scoring rules
function score(result) {
  if (result === "SILENT") return { possible: 0.5, earned: 0.5 };
  if (result === "MADE") return { possible: 1, earned: 1 };
  return { possible: 1, earned: 0 };
}

// Slash command setup
const commands = [
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("Create a Fort Lee call card")
    .addStringOption(option =>
      option.setName("cad")
        .setDescription("CAD number")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("type")
        .setDescription("Call type")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("detail")
        .setDescription("Call detail")
        .setRequired(false))
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered");
}

// When bot is ready
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// Handle interactions
client.on(Events.InteractionCreate, async interaction => {

  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === "call") {

      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          content: "This bot is locked to one user.",
          ephemeral: true
        });
      }

      const cad = interaction.options.getString("cad");
      const type = interaction.options.getString("type");
      const detail = interaction.options.getString("detail") || "No detail";

      const embed = new EmbedBuilder()
        .setTitle(`🚒 ${type}`)
        .setDescription(`CAD: ${cad}\nDetail: ${detail}`)
        .setColor(0xff0000)
        .setTimestamp();

      const buttons = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId("MADE")
            .setLabel("Toned Out / Drill (1)")
            .setStyle(ButtonStyle.Success),

          new ButtonBuilder()
            .setCustomId("SILENT")
            .setLabel("Silent (0.5)")
            .setStyle(ButtonStyle.Secondary),

          new ButtonBuilder()
            .setCustomId("MISSED")
            .setLabel("Missed (0)")
            .setStyle(ButtonStyle.Danger)
        );

      const msg = await interaction.reply({
        embeds: [embed],
        components: [buttons],
        fetchReply: true
      });

      activeCalls.set(msg.id, {
        cad,
        type,
        detail,
        date: new Date()
      });
    }
  }

  if (interaction.isButton()) {

    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: "Not authorized.",
        ephemeral: true
      });
    }

    const call = activeCalls.get(interaction.message.id);

    if (!call) {
      return interaction.reply({
        content: "Call expired.",
        ephemeral: true
      });
    }

    const result = interaction.customId;
    const pts = score(result);

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);

    await logChannel.send(
      `CAD ${call.cad} — ${result} — Earned: ${pts.earned} / Possible: ${pts.possible}`
    );

    await interaction.reply({
      content: `Saved: ${result}`,
      ephemeral: true
    });
  }

});

// Login bot
client.login(process.env.DISCORD_TOKEN);
