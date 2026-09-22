require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");
const OpenAI = require("openai");

const required = ["DISCORD_TOKEN", "OPENAI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const commands = [
  new SlashCommandBuilder().setName("ai").setDescription("Ask the NORTHLINE AI assistant a question.").addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("ping").setDescription("Check whether Northline Utilitys is online."),
  new SlashCommandBuilder().setName("setup-tickets").setDescription("Post or refresh the NORTHLINE ticket panel."),

  new SlashCommandBuilder().setName("warn").setDescription("Warn a member and record the action.").addUserOption(o => o.setName("user").setDescription("Member to warn").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("warnings").setDescription("View a member's warning history.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("remove-warning").setDescription("Remove one warning by ID.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o => o.setName("id").setDescription("Warning ID").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason for removal").setRequired(true)),
  new SlashCommandBuilder().setName("timeout").setDescription("Timeout a member.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addIntegerOption(o => o.setName("minutes").setDescription("Timeout length in minutes").setRequired(true).setMinValue(1).setMaxValue(40320)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("kick").setDescription("Kick a member.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("ban").setDescription("Ban a member.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID.").addStringOption(o => o.setName("user_id").setDescription("Discord user ID").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("user-history").setDescription("View recorded NORTHLINE history for a member.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("staff-note").setDescription("Add an internal staff note to a member's history.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o => o.setName("note").setDescription("Internal note").setRequired(true)),
  new SlashCommandBuilder().setName("staff-role").setDescription("Assign a configured NORTHLINE staff role to a member.").addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)).addRoleOption(o => o.setName("role").setDescription("Configured staff role").setRequired(true)),
].map(c => c.toJSON());

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ warnings: [], actions: [], notes: [], reputation: [] }, null, 2));

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { warnings: [], actions: [], notes: [], reputation: [] }; }
}
function saveStore(store) { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function configuredStaffRoles() {
  return [
    ["MODERATOR_ROLE_ID", 1],
    ["SENIOR_MODERATOR_ROLE_ID", 2],
    ["SUPERVISOR_ROLE_ID", 3],
    ["ADMINISTRATOR_ROLE_ID", 4],
    ["MANAGEMENT_ROLE_ID", 5],
  ].filter(([key]) => process.env[key]).map(([key, level]) => ({ id: process.env[key], level, key }));
}
function staffLevel(member) {
  if (!member?.roles?.cache) return 0;
  return configuredStaffRoles().reduce((highest, r) => member.roles.cache.has(r.id) ? Math.max(highest, r.level) : highest, 0);
}
function canModerate(member) { return staffLevel(member) >= 1 || member?.permissions?.has(PermissionsBitField.Flags.ModerateMembers); }
function canManageStaff(member) { return staffLevel(member) >= 3 || member?.permissions?.has(PermissionsBitField.Flags.ManageRoles); }
function canManageTarget(actor, target) {
  if (!target || !actor) return false;
  if (target.id === actor.id) return false;
  return actor.roles.highest.position > target.roles.highest.position;
}
function actionLog(guildId, type, targetId, actorId, reason, extra = {}) {
  const store = loadStore();
  store.actions.push({ id: id("act"), guildId, type, targetId, actorId, reason, extra, createdAt: new Date().toISOString() });
  saveStore(store);
}
function sendStaffLog(text) {
  if (!process.env.STAFF_LOG_CHANNEL_ID) return;
  client.channels.fetch(process.env.STAFF_LOG_CHANNEL_ID).then(ch => ch?.isTextBased() && ch.send(text)).catch(() => {});
}
function formatHistory(userId) {
  const store = loadStore();
  const warnings = store.warnings.filter(x => x.userId === userId && !x.removed);
  const actions = store.actions.filter(x => x.targetId === userId).slice(-12).reverse();
  const notes = store.notes.filter(x => x.userId === userId).slice(-8).reverse();
  return { warnings, actions, notes };
}

async function registerCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
    body: commands,
  });
}

function isTicketChannel(channel) {
  return Boolean(
    process.env.TICKET_CATEGORY_ID &&
    channel?.parentId === process.env.TICKET_CATEGORY_ID &&
    channel?.topic?.startsWith("northline-ticket:")
  );
}

function aiIsActive(channel) {
  return isTicketChannel(channel) && channel.topic.includes("ai:on");
}

function cleanText(text = "") {
  return text.replace(/<@!?(\d+)>/g, "").trim().slice(0, 5000);
}

function getTicketOwnerId(channel) {
  const match = channel.topic?.match(/owner:(\d+)/);
  return match?.[1] || null;
}

function getTicketType(channel) {
  const match = channel.topic?.match(/type:([a-z-]+)/);
  return match?.[1] || "support";
}

async function askAI({ user, question, ticket = false, recentMessages = "" }) {
  const system = ticket
    ? `
You are the NORTHLINE AI support moderator operating inside a private Discord support ticket.
Your purpose is to resolve normal support requests without requiring human staff for every ticket.

Rules:
- Be concise, friendly, professional, and practical.
- Use the ticket context.
- Ask for missing information when needed.
- Never invent NORTHLINE rules, policies, punishments, refunds, evidence, order details, or staff decisions.
- Never claim you performed an action unless the bot actually performed it.
- You may explain processes and collect information.
- Escalate to staff for account/security issues, payment disputes, punishment appeals, serious complaints, harassment reports, requests requiring staff authority, or uncertainty.
- Do not reveal private staff information.
- Do not make final disciplinary decisions.

Return ONLY valid JSON:
{"reply":"message to the user","escalate":true,"reason":"short reason or empty string"}
`
    : `
You are the NORTHLINE AI assistant for a Discord community.
Answer clearly and naturally.
Do not pretend to be a human or staff member.
Do not invent server-specific facts.
If a request needs staff authority, say so.
Return ONLY valid JSON:
{"reply":"message to the user","escalate":false,"reason":""}
`;

  const prompt = ticket
    ? `User: ${user}\n\nRecent ticket messages:\n${recentMessages}\n\nCurrent message: ${question}`
    : `User: ${user}\n\nMessage: ${question}`;

  const response = await openai.responses.create({
    model: MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });

  const raw = response.output_text.trim();
  try {
    return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
  } catch {
    return { reply: raw, escalate: false, reason: "" };
  }
}

async function getRecentMessages(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 12 });
    return [...messages.values()]
      .reverse()
      .map(m => `${m.author.username}: ${cleanText(m.content)}`)
      .filter(Boolean)
      .join("\n")
      .slice(0, 9000);
  } catch {
    return "";
  }
}

function ticketPanelComponents() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("northline_ticket_type")
    .setPlaceholder("Select a support category")
    .addOptions(
      { label: "General Support", value: "general", description: "General NORTHLINE help", emoji: "💬" },
      { label: "Marketplace", value: "marketplace", description: "Marketplace or seller questions", emoji: "🛒" },
      { label: "Order Issue", value: "order", description: "Something is wrong with an order", emoji: "📦" },
      { label: "Seller Support", value: "seller", description: "Seller applications and seller support", emoji: "🏔️" },
      { label: "Report User", value: "report", description: "Report a user or marketplace issue", emoji: "🚨" },
      { label: "Account", value: "account", description: "Account-related support", emoji: "👤" },
    );

  return [new ActionRowBuilder().addComponents(select)];
}

async function postTicketPanel(channel) {
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find(
    m => m.author.id === client.user.id && m.embeds.some(e => e.footer?.text === "NORTHLINE_TICKET_PANEL")
  );

  const embed = new EmbedBuilder()
    .setColor(0x67e8f9)
    .setTitle("🏔️ NORTHLINE SUPPORT")
    .setDescription(
      "Need help? Select the category that best matches your issue below.\n\n" +
      "**AI support is active immediately** when a ticket opens. If your issue needs human staff, the AI will escalate it."
    )
    .addFields({
      name: "Available support",
      value: "💬 General Support\n🛒 Marketplace\n📦 Order Issue\n🏔️ Seller Support\n🚨 Report User\n👤 Account",
    })
    .setFooter({ text: "NORTHLINE_TICKET_PANEL" });

  if (existing) {
    await existing.edit({ embeds: [embed], components: ticketPanelComponents() });
    return existing;
  }

  return channel.send({ embeds: [embed], components: ticketPanelComponents() });
}

async function findOpenTicket(guild, userId) {
  const categoryId = process.env.TICKET_CATEGORY_ID;
  if (!categoryId) return null;
  return guild.channels.cache.find(
    c => c.parentId === categoryId && isTicketChannel(c) && getTicketOwnerId(c) === userId
  ) || null;
}

async function createTicket(interaction, type) {
  const guild = interaction.guild;
  const user = interaction.user;
  const categoryId = process.env.TICKET_CATEGORY_ID;
  const staffRoleId = process.env.STAFF_ROLE_ID;

  if (!categoryId) {
    return interaction.reply({ content: "⚠️ Ticket category is not configured yet.", ephemeral: true });
  }

  const existing = await findOpenTicket(guild, user.id);
  if (existing) {
    return interaction.reply({ content: `You already have an open ticket: <#${existing.id}>`, ephemeral: true });
  }

  const safeType = String(type).toLowerCase().replace(/[^a-z-]/g, "");
  const channelName = `ticket-${safeType}-${user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user"}`;

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
      ],
    },
  ];

  if (staffRoleId) {
    overwrites.push({
      id: staffRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageMessages,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `northline-ticket: owner:${user.id} type:${safeType} ai:on`,
    permissionOverwrites: overwrites,
    reason: `NORTHLINE ticket opened by ${user.tag}`,
  });

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_takeover").setLabel("Take Over").setEmoji("🛡️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket_ai_resume").setLabel("Return to AI").setEmoji("🤖").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
  );

  const embed = new EmbedBuilder()
    .setColor(0x67e8f9)
    .setTitle("🎫 NORTHLINE Ticket")
    .setDescription(
      `Welcome <@${user.id}>.\n\n` +
      `**Category:** ${safeType}\n` +
      `**AI:** Active\n\n` +
      "The NORTHLINE AI assistant will handle normal support questions. Human staff can take over this ticket at any time."
    )
    .setFooter({ text: "NORTHLINE Ticket System" });

  await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [controls] });
  await interaction.reply({ content: `🎫 Your ticket has been created: <#${channel.id}>`, ephemeral: true });
}

function staffAuthorized(member) {
  const roleId = process.env.STAFF_ROLE_ID;
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}

async function handleTicketButton(interaction) {
  if (!isTicketChannel(interaction.channel)) return;

  if (interaction.customId === "ticket_takeover" || interaction.customId === "ticket_ai_resume") {
    if (!staffAuthorized(interaction.member)) {
      return interaction.reply({ content: "⛔ You do not have permission to control the AI in this ticket.", ephemeral: true });
    }

    const aiOn = interaction.customId === "ticket_ai_resume";
    const topic = interaction.channel.topic || "";
    const updatedTopic = topic.replace(/ai:(on|off)/, `ai:${aiOn ? "on" : "off"}`);
    await interaction.channel.setTopic(updatedTopic, aiOn ? "AI returned to ticket" : "Staff took over ticket");

    await interaction.reply({
      content: aiOn
        ? "🤖 **AI has been returned to this ticket.**"
        : `🛡️ **${interaction.user} has taken over this ticket.** AI responses are paused until staff returns control.`,
    });
    return;
  }

  if (interaction.customId === "ticket_close") {
    if (!staffAuthorized(interaction.member) && interaction.user.id !== getTicketOwnerId(interaction.channel)) {
      return interaction.reply({ content: "⛔ You cannot close this ticket.", ephemeral: true });
    }

    await interaction.reply("🔒 This ticket is being closed and logged...");
    await closeTicket(interaction.channel, interaction.user);
  }
}

async function closeTicket(channel, closedBy) {
  const logId = process.env.STAFF_LOG_CHANNEL_ID;
  let transcript = `NORTHLINE TICKET TRANSCRIPT\nChannel: ${channel.name}\nOwner: ${getTicketOwnerId(channel) || "Unknown"}\nType: ${getTicketType(channel)}\nClosed by: ${closedBy.tag}\n\n`;

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    transcript += [...messages.values()]
      .reverse()
      .map(m => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${cleanText(m.content)}`)
      .join("\n")
      .slice(0, 19000);
  } catch (err) {
    transcript += `Could not fetch full transcript: ${err.message}`;
  }

  if (logId) {
    const logChannel = await client.channels.fetch(logId).catch(() => null);
    if (logChannel?.isTextBased()) {
      await logChannel.send({
        content: `📁 **Ticket Closed**\nChannel: #${channel.name}\nOwner: <@${getTicketOwnerId(channel) || "0"}>\nClosed by: <@${closedBy.id}>`,
        files: [{ attachment: Buffer.from(transcript, "utf8"), name: `${channel.name}-transcript.txt` }],
      }).catch(console.error);
    }
  }

  await channel.delete("NORTHLINE ticket closed").catch(console.error);
}

async function handleModerationCommand(interaction) {
  const name = interaction.commandName;
  if (!["warn","warnings","remove-warning","timeout","kick","ban","unban","user-history","staff-note","staff-role"].includes(name)) return false;
  if (!canModerate(interaction.member)) { await interaction.reply({ content: "⛔ You do not have permission to use NORTHLINE moderation tools.", ephemeral: true }); return true; }

  const store = loadStore();
  const user = interaction.options.getUser("user");

  if (name === "warnings") {
    const rows = store.warnings.filter(x => x.userId === user.id && !x.removed);
    const text = rows.length ? rows.slice(-15).map(x => `**${x.id}** • ${x.reason} • <@${x.moderatorId}> • <t:${Math.floor(new Date(x.createdAt).getTime()/1000)}:R>`).join("\n") : "No active warnings recorded.";
    await interaction.reply({ content: `⚠️ **Warnings for ${user.tag}**\n${text}`.slice(0, 1900), ephemeral: true });
    return true;
  }

  if (name === "user-history") {
    const h = formatHistory(user.id);
    const warnings = h.warnings.length ? h.warnings.map(x => `• Warning ${x.id}: ${x.reason}`).join("\n") : "None";
    const actions = h.actions.length ? h.actions.map(x => `• ${x.type}: ${x.reason}`).join("\n") : "None";
    const notes = h.notes.length ? h.notes.map(x => `• ${x.note} — <@${x.staffId}>`).join("\n") : "None";
    await interaction.reply({ content: `📋 **NORTHLINE History — ${user.tag}**\n\n**Warnings**\n${warnings}\n\n**Actions**\n${actions}\n\n**Staff Notes**\n${notes}`.slice(0, 3900), ephemeral: true });
    return true;
  }

  if (name === "staff-note") {
    if (staffLevel(interaction.member) < 2) { await interaction.reply({ content: "⛔ Senior Moderator level or above is required for staff notes.", ephemeral: true }); return true; }
    const note = interaction.options.getString("note", true).slice(0, 2000);
    store.notes.push({ id: id("note"), guildId: interaction.guildId, userId: user.id, staffId: interaction.user.id, note, createdAt: new Date().toISOString() });
    saveStore(store); actionLog(interaction.guildId, "staff_note", user.id, interaction.user.id, note);
    await interaction.reply({ content: `📝 Internal staff note added to **${user.tag}**.`, ephemeral: true });
    sendStaffLog(`📝 **Staff Note**\nUser: <@${user.id}>\nStaff: <@${interaction.user.id}>\nNote: ${note}`);
    return true;
  }

  if (name === "staff-role") {
    if (!canManageStaff(interaction.member)) { await interaction.reply({ content: "⛔ You do not have permission to manage staff roles.", ephemeral: true }); return true; }
    const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
    const role = interaction.options.getRole("role", true);
    const configured = configuredStaffRoles().find(r => r.id === role.id);
    if (!configured) { await interaction.reply({ content: "⛔ That role is not configured as a NORTHLINE staff role.", ephemeral: true }); return true; }
    if (configured.level >= staffLevel(interaction.member) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) { await interaction.reply({ content: "⛔ You can only assign staff roles below your own level.", ephemeral: true }); return true; }
    if (!targetMember) { await interaction.reply({ content: "⚠️ That user is not in this server.", ephemeral: true }); return true; }
    if (!canManageTarget(interaction.member, targetMember) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) { await interaction.reply({ content: "⛔ You cannot manage that member's role hierarchy.", ephemeral: true }); return true; }
    if (!role.editable) { await interaction.reply({ content: "⚠️ Discord will not let the bot manage that role. Move the bot's role above it.", ephemeral: true }); return true; }
    await targetMember.roles.add(role, `NORTHLINE staff role assigned by ${interaction.user.tag}`);
    actionLog(interaction.guildId, "staff_role_add", user.id, interaction.user.id, `Assigned ${role.name}`, { roleId: role.id });
    await interaction.reply({ content: `✅ Assigned **${role.name}** to **${user.tag}**.`, ephemeral: true });
    sendStaffLog(`👥 **Staff Role Assigned**\nUser: <@${user.id}>\nRole: <@&${role.id}>\nBy: <@${interaction.user.id}>`);
    return true;
  }

  const reason = interaction.options.getString("reason", true).slice(0, 500);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && !canManageTarget(interaction.member, member) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({ content: "⛔ You cannot moderate someone at or above your highest role.", ephemeral: true }); return true;
  }

  if (name === "warn") {
    const warning = { id: id("warn"), guildId: interaction.guildId, userId: user.id, moderatorId: interaction.user.id, reason, createdAt: new Date().toISOString(), removed: false };
    store.warnings.push(warning); saveStore(store); actionLog(interaction.guildId, "warning", user.id, interaction.user.id, reason, { warningId: warning.id });
    await interaction.reply(`⚠️ **${user.tag}** has been warned.\n**Reason:** ${reason}\n**Warning ID:** ${warning.id}`);
    sendStaffLog(`⚠️ **Warning**\nUser: <@${user.id}>\nStaff: <@${interaction.user.id}>\nReason: ${reason}\nID: ${warning.id}`);
    return true;
  }

  if (name === "remove-warning") {
    const warning = store.warnings.find(x => x.userId === user.id && x.id === interaction.options.getString("id", true) && !x.removed);
    if (!warning) { await interaction.reply({ content: "⚠️ Active warning not found.", ephemeral: true }); return true; }
    warning.removed = true; warning.removedBy = interaction.user.id; warning.removedReason = reason; warning.removedAt = new Date().toISOString(); saveStore(store);
    actionLog(interaction.guildId, "warning_removed", user.id, interaction.user.id, reason, { warningId: warning.id });
    await interaction.reply({ content: `✅ Warning **${warning.id}** removed from **${user.tag}**.`, ephemeral: true });
    sendStaffLog(`♻️ **Warning Removed**\nUser: <@${user.id}>\nWarning: ${warning.id}\nBy: <@${interaction.user.id}>\nReason: ${reason}`);
    return true;
  }

  if (!member) { await interaction.reply({ content: "⚠️ That user is not currently in this server.", ephemeral: true }); return true; }
  if (name === "timeout") {
    const minutes = interaction.options.getInteger("minutes", true);
    await member.timeout(minutes * 60 * 1000, reason);
    actionLog(interaction.guildId, "timeout", user.id, interaction.user.id, reason, { minutes });
    await interaction.reply(`⏳ **${user.tag}** has been timed out for **${minutes} minutes**.\n**Reason:** ${reason}`);
    sendStaffLog(`⏳ **Timeout**\nUser: <@${user.id}>\nDuration: ${minutes}m\nStaff: <@${interaction.user.id}>\nReason: ${reason}`);
    return true;
  }
  if (name === "kick") {
    await member.kick(reason); actionLog(interaction.guildId, "kick", user.id, interaction.user.id, reason);
    await interaction.reply(`👢 **${user.tag}** was kicked.\n**Reason:** ${reason}`);
    sendStaffLog(`👢 **Kick**\nUser: <@${user.id}>\nStaff: <@${interaction.user.id}>\nReason: ${reason}`);
    return true;
  }
  if (name === "ban") {
    await member.ban({ reason, deleteMessageSeconds: 0 }); actionLog(interaction.guildId, "ban", user.id, interaction.user.id, reason);
    await interaction.reply(`🔨 **${user.tag}** was banned.\n**Reason:** ${reason}`);
    sendStaffLog(`🔨 **Ban**\nUser: <@${user.id}>\nStaff: <@${interaction.user.id}>\nReason: ${reason}`);
    return true;
  }
  if (name === "unban") {
    const userId = interaction.options.getString("user_id", true);
    await interaction.guild.members.unban(userId, reason); actionLog(interaction.guildId, "unban", userId, interaction.user.id, reason);
    await interaction.reply(`✅ **${userId}** was unbanned.\n**Reason:** ${reason}`);
    sendStaffLog(`✅ **Unban**\nUser ID: ${userId}\nStaff: <@${interaction.user.id}>\nReason: ${reason}`);
    return true;
  }
  return true;
}

async function handleAIMessage(message) {
  if (message.author.bot) return;

  const ticket = isTicketChannel(message.channel);
  const mentioned = message.mentions.has(client.user);
  let isReplyToBot = false;

  if (message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      isReplyToBot = replied.author.id === client.user.id;
    } catch {}
  }

  if (!ticket && !mentioned && !isReplyToBot) return;
  if (ticket && !aiIsActive(message.channel)) return;

  const question = cleanText(message.content);
  if (!question) return;

  await message.channel.sendTyping();

  try {
    const result = await askAI({
      user: `${message.author.username} (${message.author.id})`,
      question,
      ticket,
      recentMessages: ticket ? await getRecentMessages(message.channel) : "",
    });

    await message.reply({
      content: (result.reply || "I couldn't generate a response.").slice(0, 1900),
      allowedMentions: { repliedUser: false },
    });

    if (ticket && result.escalate) {
      const staffRole = process.env.STAFF_ROLE_ID ? `<@&${process.env.STAFF_ROLE_ID}>` : "Staff";
      await message.channel.send(
        `🚨 **AI escalation requested.** ${staffRole}\n**Reason:** ${String(result.reason || "The AI could not safely resolve this ticket.").slice(0, 500)}\n\nStaff can use **Take Over** above to pause AI responses.`
      );

      if (process.env.STAFF_LOG_CHANNEL_ID) {
        const logChannel = await client.channels.fetch(process.env.STAFF_LOG_CHANNEL_ID).catch(() => null);
        if (logChannel?.isTextBased()) {
          await logChannel.send(
            `🚨 **AI Ticket Escalation**\nServer: ${message.guild?.name || "Unknown"}\nTicket: <#${message.channel.id}>\nUser: <@${message.author.id}>\nReason: ${String(result.reason || "Not specified").slice(0, 500)}`
          );
        }
      }
    }
  } catch (err) {
    console.error("AI error:", err);
    await message.reply({
      content: "⚠️ The AI assistant is temporarily unavailable. A human staff member may need to help.",
      allowedMentions: { repliedUser: false },
    });
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerCommands(guild.id);
    } catch (err) {
      console.error(`Could not register commands for ${guild.name}:`, err.message);
    }
  }

  if (process.env.TICKET_PANEL_CHANNEL_ID) {
    const panelChannel = await client.channels.fetch(process.env.TICKET_PANEL_CHANNEL_ID).catch(() => null);
    if (panelChannel?.isTextBased()) {
      await postTicketPanel(panelChannel).catch(err => console.error("Ticket panel error:", err));
    }
  }

  console.log("Northline Utilitys is online.");
});

client.on("guildCreate", async guild => {
  try {
    await registerCommands(guild.id);
  } catch (err) {
    console.error("Guild command registration failed:", err.message);
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isStringSelectMenu() && interaction.customId === "northline_ticket_type") {
    return createTicket(interaction, interaction.values[0]);
  }

  if (interaction.isButton()) {
    return handleTicketButton(interaction);
  }

  if (!interaction.isChatInputCommand()) return;

  if (await handleModerationCommand(interaction)) return;

  if (interaction.commandName === "ping") {
    return interaction.reply(`🏓 Pong! ${client.ws.ping}ms`);
  }

  if (interaction.commandName === "setup-tickets") {
    if (!staffAuthorized(interaction.member)) {
      return interaction.reply({ content: "⛔ You do not have permission to set up the ticket panel.", ephemeral: true });
    }

    const target = process.env.TICKET_PANEL_CHANNEL_ID
      ? await client.channels.fetch(process.env.TICKET_PANEL_CHANNEL_ID).catch(() => null)
      : interaction.channel;

    if (!target?.isTextBased()) {
      return interaction.reply({ content: "⚠️ Configure TICKET_PANEL_CHANNEL_ID first, or run this in a text channel.", ephemeral: true });
    }

    await postTicketPanel(target);
    return interaction.reply({ content: `✅ Ticket panel is ready in <#${target.id}>.`, ephemeral: true });
  }

  if (interaction.commandName === "ai") {
    const question = interaction.options.getString("question", true);
    await interaction.deferReply();
    try {
      const result = await askAI({
        user: `${interaction.user.username} (${interaction.user.id})`,
        question,
      });
      await interaction.editReply(result.reply?.slice(0, 1900) || "No response.");
    } catch (err) {
      console.error(err);
      await interaction.editReply("⚠️ AI is temporarily unavailable.");
    }
  }
});

client.on("messageCreate", handleAIMessage);

client.login(process.env.DISCORD_TOKEN);
