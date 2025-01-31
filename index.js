require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Web3 } = require("web3");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const web3 = new Web3(new Web3.providers.HttpProvider("https://api.roninchain.com/rpc"));

const userSessions = new Map(); // Store user wallet sessions

// Main menu buttons
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback("🔹 Buy", "buy"), Markup.button.callback("🔸 Sell", "sell")],
  [Markup.button.callback("🔗 Connect Wallet", "connect_wallet"), Markup.button.callback("📋 Copy Trade", "copy_trade")]
]);

bot.start((ctx) => ctx.reply("Welcome to Ronin Trading Bot!", mainMenu));

// Buying and selling handlers
bot.action("buy", (ctx) => ctx.reply("Buying on Ronin..."));
bot.action("sell", (ctx) => ctx.reply("Selling on Ronin..."));

// Wallet Connection Flow
bot.action("connect_wallet", (ctx) => {
  ctx.reply("Please send your Ronin wallet **private key** to connect.\n\n⚠ **Warning:** Never share your private key with anyone. Use a dedicated wallet for this bot.");
  userSessions.set(ctx.from.id, { step: "awaiting_private_key" });
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (session && session.step === "awaiting_private_key") {
    const privateKey = ctx.message.text.trim();

    try {
      const account = web3.eth.accounts.privateKeyToAccount(privateKey);
      web3.eth.accounts.wallet.add(account);

      userSessions.set(userId, { step: "connected", account });
      ctx.reply(`✅ Successfully connected!\nYour Ronin Address: \`${account.address}\``);
    } catch (error) {
      ctx.reply("❌ Invalid private key. Please try again.");
    }
  }
});

bot.action("copy_trade", (ctx) => ctx.reply("Copy trading activated!"));

// Launch bot
bot.launch();
console.log("Bot is running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
