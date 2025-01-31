require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Web3 } = require("web3");
const fs = require("fs");

const KATANA_ROUTER_ABI = JSON.parse(fs.readFileSync("./katanaRouterABI.json", "utf8"));
const ERC20_ABI = JSON.parse(fs.readFileSync("./erc20ABI.json", "utf8"));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const web3 = new Web3(new Web3.providers.HttpProvider("https://api.roninchain.com/rpc"));

const KATANA_ROUTER_ADDRESS = "0xC873fEd316bE69b144Aab81177bd86E6a6cD555F";
const routerContract = new web3.eth.Contract(KATANA_ROUTER_ABI, KATANA_ROUTER_ADDRESS);

const userSessions = new Map(); // Store user wallet sessions

// Main menu buttons
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback("🔹 Buy", "buy_preset"), Markup.button.callback("🔸 Sell", "sell_preset")],
  [Markup.button.callback("🔗 Connect Wallet", "connect_wallet"), Markup.button.callback("📋 Copy Trade", "copy_trade")]
]);

bot.start((ctx) => ctx.reply("Welcome to Ronin Trading Bot!", mainMenu));

// Connect Wallet Flow
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

// 🔹 Buy Command: Allows users to specify amount and token
bot.command("buy", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  const args = ctx.message.text.split(" ");
  if (args.length < 3) {
    return ctx.reply("⚠ Usage: `/buy <amount in RON> <token_address>`\nExample: `/buy 10 0xa8754b9fa15fc18bb59458815510e40a12cd2014`", { parse_mode: "Markdown" });
  }

  const account = session.account;
  const recipient = account.address;
  const amountInRON = args[1];
  const tokenOut = args[2];

  if (isNaN(amountInRON) || parseFloat(amountInRON) <= 0) {
    return ctx.reply("❌ Invalid amount. Please enter a valid number.");
  }

  const amountInWei = web3.utils.toWei(amountInRON, "ether");

  ctx.reply(`🔄 Swapping **${amountInRON} RON** for tokens on Katana...`);

  try {
    const tx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      value: amountInWei,
      gas: 2000000,
      data: routerContract.methods.swapExactETHForTokens(
        0,
        ["0xe514d9deb7966c8be0ca922de8a064264ea6bcd4", tokenOut], // RON → User specified token
        recipient,
        Math.floor(Date.now() / 1000) + 60 * 10
      ).encodeABI()
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    ctx.reply(`✅ Swap successful!\n🔹 **Transaction Hash:** [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);
  } catch (error) {
    console.error(error);
    ctx.reply("❌ Swap failed. Please try again.");
  }
});

// 🔸 Pre-set Buy Buttons
bot.action("buy_preset", (ctx) => {
  ctx.reply("Select an amount to buy:", Markup.inlineKeyboard([
    [Markup.button.callback("10 RON", "buy_10"), Markup.button.callback("25 RON", "buy_25")],
    [Markup.button.callback("50 RON", "buy_50"), Markup.button.callback("100 RON", "buy_100")]
  ]));
});

// Handling Pre-set Buy Amounts (Default Token: AXS)
const defaultToken = "0xa8754b9fa15fc18bb59458815510e40a12cd2014"; // Default: AXS Token
["10", "25", "50", "100"].forEach(amount => {
  bot.action(`buy_${amount}`, (ctx) => executeBuy(ctx, amount, defaultToken));
});

// Function to Handle Pre-set Buy Transactions
async function executeBuy(ctx, amountInRON, tokenOut) {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  const account = session.account;
  const recipient = account.address;
  const amountInWei = web3.utils.toWei(amountInRON, "ether");

  ctx.reply(`🔄 Swapping **${amountInRON} RON** for tokens on Katana...`);

  try {
    const tx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      value: amountInWei,
      gas: 2000000,
      data: routerContract.methods.swapExactETHForTokens(
        0,
        ["0xe514d9deb7966c8be0ca922de8a064264ea6bcd4", tokenOut], // RON → AXS
        recipient,
        Math.floor(Date.now() / 1000) + 60 * 10
      ).encodeABI()
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    ctx.reply(`✅ Swap successful!\n🔹 **Transaction Hash:** [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);
  } catch (error) {
    console.error(error);
    ctx.reply("❌ Swap failed. Please try again.");
  }
}

// Copy Trade Feature
bot.action("copy_trade", (ctx) => ctx.reply("Copy trading activated!"));

// Launch bot
bot.launch();
console.log("Bot is running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
