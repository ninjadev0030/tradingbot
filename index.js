require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Web3 } = require("web3");
const fs = require("fs");

const KATANA_ROUTER_ABI = JSON.parse(fs.readFileSync("./katanaRouterABI.json", "utf8"));
const ERC20_ABI = JSON.parse(fs.readFileSync("./erc20ABI.json", "utf8"));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const web3 = new Web3(new Web3.providers.HttpProvider("https://api.roninchain.com/rpc"));

const KATANA_ROUTER_ADDRESS = "0x7d0556d55ca1a92708681e2e231733ebd922597d";
const routerContract = new web3.eth.Contract(KATANA_ROUTER_ABI, KATANA_ROUTER_ADDRESS);

const userSessions = new Map(); // Store user wallet sessions

// Main menu buttons
const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback("🔹 Buy", "buy"), Markup.button.callback("🔸 Sell", "sell")],
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

  if (session) {
    if (session.step === "awaiting_private_key") {
      const privateKey = ctx.message.text.trim();
      try {
        const account = web3.eth.accounts.privateKeyToAccount(privateKey);
        web3.eth.accounts.wallet.add(account);
        userSessions.set(userId, { step: "connected", account });
        ctx.reply(`✅ Successfully connected!\nYour Ronin Address: \`${account.address}\``);
      } catch (error) {
        ctx.reply("❌ Invalid private key. Please try again.");
      }
    } else if (session.step === "awaiting_token_address") {
      session.tokenOut = ctx.message.text.trim();
      if (!web3.utils.isAddress(session.tokenOut)) {
        return ctx.reply("❌ Invalid token address. Please enter a correct Ethereum/Ronin address.");
      }
      session.step = "awaiting_ron_amount";

      // Ask for RON amount with preset buttons
      ctx.reply(
        "✅ Token address saved!\nNow, enter the **amount of RON** you want to spend or choose a pre-set amount.",
        Markup.inlineKeyboard([
          [Markup.button.callback("10 RON", "buy_10"), Markup.button.callback("25 RON", "buy_25")],
          [Markup.button.callback("50 RON", "buy_50"), Markup.button.callback("100 RON", "buy_100")],
          [Markup.button.callback("Enter Custom Amount", "buy_custom")]
        ])
      );
    } else if (session.step === "awaiting_custom_ron") {
      const amountInRON = ctx.message.text.trim();
      if (isNaN(amountInRON) || parseFloat(amountInRON) <= 0) {
        return ctx.reply("❌ Invalid RON amount. Please enter a valid number.");
      }
      session.amountInRON = amountInRON;
      session.step = "confirming_trade";
      confirmTrade(ctx, session);
    }
  }
});

// 🔹 Buy Flow: First Ask for Token Address
bot.action("buy", (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  ctx.reply("🔹 Enter the **Token Address** you want to buy.");
  userSessions.set(userId, { step: "awaiting_token_address", account: session.account });
});

// 🔹 Handle Pre-set Buy Amounts
["10", "25", "50", "100"].forEach((amount) => {
  bot.action(`buy_${amount}`, (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);

    if (!session || session.step !== "awaiting_ron_amount") {
      return ctx.reply("⚠ Please start the buy process again by clicking 'Buy'.");
    }

    session.amountInRON = amount;
    session.step = "confirming_trade";
    confirmTrade(ctx, session);
  });
});

// 🔹 Handle Custom Buy Amount
bot.action("buy_custom", (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "awaiting_ron_amount") {
    return ctx.reply("⚠ Please start the buy process again by clicking 'Buy'.");
  }

  session.step = "awaiting_custom_ron";
  ctx.reply("🔹 Enter the **amount of RON** you want to spend.");
});

// 🔹 Confirm and Execute Buy
// 🔹 Confirm and Execute Buy
bot.action("confirm_buy", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "confirming_trade") {
    return ctx.reply("⚠ Trade session expired. Please restart by clicking 'Buy'.");
  }

  const account = session.account;
  const recipient = account.address;
  const tokenOut = session.tokenOut;
  const amountInWei = web3.utils.toWei(session.amountInRON, "ether");

  ctx.reply(`🔄 Swapping **${session.amountInRON} RON** for tokens on Katana...`);

  try {
    // 🔥 Get current gas price dynamically
    const gasPrice = await web3.eth.getGasPrice();

    const tx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      value: amountInWei,
      gas: 2000000,  // ✅ Ensure gas is defined
      gasPrice: gasPrice, // ✅ Use the latest gas price
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
    
    // 🔥 Fetch and display the updated balance
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenOut);
    const newBalance = await tokenContract.methods.balanceOf(recipient).call();
    const decimals = await tokenContract.methods.decimals().call();
    const formattedBalance = web3.utils.fromWei(newBalance, "ether");

    ctx.reply(`📈 New token balance: **${formattedBalance}** tokens`);
  } catch (error) {
    console.error(error);
    ctx.reply("❌ Swap failed. Please try again.");
  }

  userSessions.delete(userId);
});


// 🔹 Cancel Trade
bot.action("cancel_trade", (ctx) => {
  const userId = ctx.from.id;
  userSessions.delete(userId);
  ctx.reply("❌ Trade canceled.");
});

// 🔹 Confirm Trade Function
function confirmTrade(ctx, session) {
  ctx.reply(
    `✅ You are about to swap **${session.amountInRON} RON** for tokens at **${session.tokenOut}**.\n\nClick **Confirm** to proceed.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirm Trade", "confirm_buy")],
      [Markup.button.callback("❌ Cancel", "cancel_trade")]
    ])
  );
}

// Copy Trade Feature
bot.action("copy_trade", (ctx) => ctx.reply("Copy trading activated!"));

// Launch bot
bot.launch();
console.log("Bot is running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
