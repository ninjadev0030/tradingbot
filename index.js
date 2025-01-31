require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Web3 } = require("web3");
const fs = require("fs");
// const { abi: KATANA_ROUTER_ABI } = require("./katanaRouterABI.json");
// const { abi: ERC20_ABI } = require("./erc20ABI.json"); // ERC20 ABI for token approval
const KATANA_ROUTER_ABI = JSON.parse(fs.readFileSync("./katanaRouterABI.json", "utf8"));
const ERC20_ABI = JSON.parse(fs.readFileSync("./erc20ABI.json", "utf8"));
// console.log(KATANA_ROUTER_ABI);
// console.log(Array.isArray(ERC20_ABI))
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const web3 = new Web3(new Web3.providers.HttpProvider("https://api.roninchain.com/rpc"));

const KATANA_ROUTER_ADDRESS = "0xC873fEd316bE69b144Aab81177bd86E6a6cD555F";
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

// Buy Token (RON → AXS)
bot.action("buy", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  const account = session.account;
  const recipient = account.address;
  const tokenOut = "0xa8754b9fa15fc18bb59458815510e40a12cd2014"; // AXS Token Address
  const amountInWei = web3.utils.toWei("0.001", "ether"); // Swap 0.1 RON

  ctx.reply("🔄 Swapping **0.1 RON** for **AXS** on Katana...");

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
});

// Sell Token (AXS → RON)
bot.action("sell", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  const account = session.account;
  const recipient = account.address;
  const tokenIn = "0xa8754b9fa15fc18bb59458815510e40a12cd2014"; // AXS Token Address
  const amountInWei = web3.utils.toWei("0.001", "ether"); // Swap 1 AXS to RON
  const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenIn);

  ctx.reply("🔄 Approving **1 AXS** for sale...");

  try {
    // Step 1: Approve Router Contract to spend user's tokens
    const approveTx = {
      from: recipient,
      to: tokenIn,
      gas: 100000,
      data: tokenContract.methods.approve(KATANA_ROUTER_ADDRESS, amountInWei).encodeABI()
    };

    const signedApproveTx = await web3.eth.accounts.signTransaction(approveTx, account.privateKey);
    await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);

    ctx.reply("✅ Approval complete. Executing trade...");

    // Step 2: Swap AXS → RON
    const swapTx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      gas: 2000000,
      data: routerContract.methods.swapExactTokensForETH(
        amountInWei,
        0,
        [tokenIn, "0xe514d9deb7966c8be0ca922de8a064264ea6bcd4"], // AXS → RON
        recipient,
        Math.floor(Date.now() / 1000) + 60 * 10
      ).encodeABI()
    };

    const signedSwapTx = await web3.eth.accounts.signTransaction(swapTx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedSwapTx.rawTransaction);

    ctx.reply(`✅ Swap successful!\n🔹 **Transaction Hash:** [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);
  } catch (error) {
    console.error(error);
    ctx.reply("❌ Swap failed. Please try again.");
  }
});

// Copy Trade Feature
bot.action("copy_trade", (ctx) => ctx.reply("Copy trading activated!"));

// Launch bot
bot.launch();
console.log("Bot is running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
