require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Web3 } = require("web3");
const fs = require("fs");

const KATANA_ROUTER_ABI = JSON.parse(fs.readFileSync("./katanaRouterABI.json", "utf8"));
const ERC20_ABI = JSON.parse(fs.readFileSync("./erc20ABI.json", "utf8"));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const web3 = new Web3(new Web3.providers.HttpProvider("https://api.roninchain.com/rpc"));

const KATANA_ROUTER_ADDRESS = "0xc05afc8c9353c1dd5f872eccfacd60fd5a2a9ac7";
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
    } if (session.step === "awaiting_token_to_sell") {
      session.tokenIn = ctx.message.text.trim();
      if (!web3.utils.isAddress(session.tokenIn)) {
        return ctx.reply("❌ Invalid token address. Please enter a correct Ethereum/Ronin address.");
      }
      session.step = "awaiting_sell_amount";
      ctx.reply("✅ Token address saved!\nNow, enter the **amount of tokens** you want to sell.");
    } else if (session.step === "awaiting_sell_amount") {
      const amountInToken = ctx.message.text.trim();
      if (isNaN(amountInToken) || parseFloat(amountInToken) <= 0) {
        return ctx.reply("❌ Invalid amount. Please enter a valid number.");
      }
      session.amountInToken = amountInToken;
      session.step = "confirming_sell_trade";
      confirmSellTrade(ctx, session);
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

    // 🔥 Ensure the token address is valid
    if (!web3.utils.isAddress(tokenOut)) {
      return ctx.reply("❌ Invalid token address. Please enter a correct Ethereum/Ronin address.");
    }

    // 🔥 Define Swap Path (RON → Token)
    const WRON_ADDRESS = "0xe514d9deb7966c8be0ca922de8a064264ea6bcd4"; // Wrapped RON
    const path = [WRON_ADDRESS, tokenOut];

    // ✅ Set Minimum Output (`amountOutMin`) for Slippage Protection
    const amountOutMin = web3.utils.toWei("0.0001", "ether"); // Adjust for slippage

    // ✅ Construct Transaction Using `swapExactRONForTokens()`
    const tx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      value: amountInWei, // 🔥 Ensures enough RON is sent
      gas: 2000000,
      gasPrice: gasPrice,
      data: routerContract.methods.swapExactRONForTokens(
        amountOutMin, // ✅ Minimum tokens expected (adjust slippage tolerance)
        path,
        recipient,
        Math.floor(Date.now() / 1000) + 60 * 10 // ✅ 10-minute deadline
      ).encodeABI()
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    ctx.reply(`✅ Swap successful!\n🔹 **Transaction Hash:** [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);

    // ✅ Fetch and Display Updated Token Balance
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenOut);
    const newBalance = await tokenContract.methods.balanceOf(recipient).call();
    const decimals = await tokenContract.methods.decimals().call();
    const formattedBalance = web3.utils.fromWei(newBalance, "ether");

    ctx.reply(`📈 **New token balance:** ${formattedBalance} tokens`);
  } catch (error) {
    console.error("🔴 Swap failed with error:", error);

    if (error.reason) {
      ctx.reply(`❌ Transaction failed: ${error.reason}`);
    } else {
      ctx.reply("❌ Swap failed due to a smart contract error. Please try again.");
    }
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

/********* Sell Part ***********/
// 🔹 Sell Flow: Ask for Token Address First
bot.action("sell", (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "connected") {
    return ctx.reply("⚠ Please **connect your wallet** first using 'Connect Wallet'.");
  }

  ctx.reply("🔸 Enter the **Token Address** you want to sell.");
  userSessions.set(userId, { step: "awaiting_token_to_sell", account: session.account });
});

bot.action("confirm_sell", async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions.get(userId);

  if (!session || session.step !== "confirming_sell_trade") {
    return ctx.reply("⚠ Trade session expired. Please restart by clicking 'Sell'.");
  }

  const account = session.account;
  const recipient = account.address;
  const tokenIn = session.tokenIn;
  const amountInWei = web3.utils.toWei(session.amountInToken, "ether");

  ctx.reply(`🔄 Selling **${session.amountInToken}** tokens for RON on Katana...`);

  try {
    // 🔥 Get the latest gas fee details for EIP-1559 transactions
    const feeData = await web3.eth.getBlock("latest");
    const gasLimit = 2000000; // ✅ Manually set gas limit
    const baseFeePerGas = await web3.eth.getGasPrice();
    const maxPriorityFeePerGas = web3.utils.toWei("20", "gwei"); // ✅ Higher priority fee
    const maxFeePerGas = (BigInt(baseFeePerGas) * BigInt(3)).toString();

    // 🔥 Ensure the token address is valid
    if (!web3.utils.isAddress(tokenIn)) {
      return ctx.reply("❌ Invalid token address. Please enter a correct Ethereum/Ronin address.");
    }

    // 🔥 Define Swap Path (Token → RON)
    const WRON_ADDRESS = "0xe514d9deb7966c8be0ca922de8a064264ea6bcd4"; // Wrapped RON
    const path = [tokenIn, WRON_ADDRESS];

    // ✅ Set Minimum Output (`amountOutMin`) for Slippage Protection
    const amountOutMin = web3.utils.toWei("0.0001", "ether"); // Adjust for slippage

    // ✅ Check Allowance & Approve Token if Needed
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenIn);
    const allowance = await tokenContract.methods.allowance(recipient, KATANA_ROUTER_ADDRESS).call();

    // if (BigInt(allowance) < BigInt(amountInWei)) { // ✅ Use BigInt instead of toBN
      ctx.reply("🔄 Approving tokens for sale...");

      // ✅ Construct Approval Transaction without `gasPrice`
      const approveTx = {
        from: recipient,
        to: tokenIn,
        gas: 200000, // ✅ Manually set gas limit
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        maxFeePerGas: maxFeePerGas,
        data: tokenContract.methods.approve(KATANA_ROUTER_ADDRESS, amountInWei).encodeABI(),
      };

      // ✅ Sign and Send Approval Transaction
      const signedApproveTx = await web3.eth.accounts.signTransaction(approveTx, account.privateKey);
      await web3.eth.sendSignedTransaction(signedApproveTx.rawTransaction);
      ctx.reply("✅ Approval complete. Executing trade...");
    // }

    // ✅ Construct Sell Transaction Using `swapExactTokensForRON()` (No `gasPrice`)
    const sellTx = {
      from: recipient,
      to: KATANA_ROUTER_ADDRESS,
      gas: gasLimit, // ✅ Manually set gas limit
      maxPriorityFeePerGas: maxPriorityFeePerGas, // ✅ EIP-1559 compatible
      maxFeePerGas: maxFeePerGas, // ✅ EIP-1559 compatible
      data: routerContract.methods.swapExactTokensForRON(
        amountInWei, // ✅ Tokens to sell
        amountOutMin, // ✅ Minimum RON expected (adjust slippage tolerance)
        path,
        recipient,
        Math.floor(Date.now() / 1000) + 60 * 10 // ✅ 10-minute deadline
      ).encodeABI(),
    };

    const signedSellTx = await web3.eth.accounts.signTransaction(sellTx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedSellTx.rawTransaction);

    ctx.reply(`✅ Sell successful!\n🔹 **Transaction Hash:** [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);

    // ✅ Fetch and Display Updated RON Balance
    const newRonBalance = await web3.eth.getBalance(recipient);
    const formattedRonBalance = web3.utils.fromWei(newRonBalance, "ether");

    ctx.reply(`📈 **New RON balance:** ${formattedRonBalance} RON`);
  } catch (error) {
    console.error("🔴 Sell failed with error:", error);

    if (error.reason) {
      ctx.reply(`❌ Transaction failed: ${error.reason}`);
    } else {
      ctx.reply("❌ Sell failed due to a smart contract error. Please try again.");
    }
  }

  userSessions.delete(userId);
});

// 🔹 Cancel Sell Trade
bot.action("cancel_sell_trade", (ctx) => {
  const userId = ctx.from.id;
  userSessions.delete(userId);
  ctx.reply("❌ Sell trade canceled.");
});

// 🔹 Confirm Sell Trade Function
function confirmSellTrade(ctx, session) {
  ctx.reply(
    `✅ You are about to swap **${session.amountInToken} tokens** for RON at **${session.tokenIn}**.\n\nClick **Confirm** to proceed.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirm Trade", "confirm_sell")],
      [Markup.button.callback("❌ Cancel", "cancel_sell_trade")]
    ])
  );
}

// Copy Trade Feature
bot.action("copy_trade", (ctx) => ctx.reply("Copy trading activated!"));

bot.command("copy", (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length !== 2 || !web3.utils.isAddress(args[1])) {
    return ctx.reply("❌ Invalid command! Use: `/copy <wallet_address>`");
  }
  const walletAddress = args[1];
  copyTradeSessions.set(ctx.from.id, { walletAddress, active: true });
  ctx.reply(`✅ Copy trade activated for wallet: \`${walletAddress}\``);
});

// ✅ Pause Copy Trading
bot.command("pause_copy", (ctx) => {
  if (copyTradeSessions.has(ctx.from.id)) {
    copyTradeSessions.get(ctx.from.id).active = false;
    ctx.reply("⏸ Copy trading paused.");
  } else {
    ctx.reply("❌ No active copy trade found.");
  }
});

// ✅ Resume Copy Trading
bot.command("resume_copy", (ctx) => {
  if (copyTradeSessions.has(ctx.from.id)) {
    copyTradeSessions.get(ctx.from.id).active = true;
    ctx.reply("▶ Copy trading resumed.");
  } else {
    ctx.reply("❌ No active copy trade found.");
  }
});

// ✅ Track Trades of Copied Wallets
async function trackCopiedTrades() {
  setInterval(async () => {
    for (const [userId, session] of copyTradeSessions.entries()) {
      if (!session.active) continue;
      try {
        const latestTxs = await web3.eth.getPastLogs({
          address: session.walletAddress,
          fromBlock: "latest",
        });
        for (const tx of latestTxs) {
          if (tx.topics.length > 0) {
            bot.telegram.sendMessage(userId, `📢 **Copy Trade Alert** \nTrade detected for wallet: \`${session.walletAddress}\`\nTX Hash: [View on Explorer](https://explorer.roninchain.com/tx/${tx.transactionHash})`);
            executeCopyTrade(userId, session.walletAddress, tx);
          }
        }
      } catch (error) {
        console.error("Error tracking trades:", error);
      }
    }
  }, 30000); // Poll every 30 seconds
}

// ✅ Execute Copied Trade
async function executeCopyTrade(userId, walletAddress, tx) {
  try {
    const session = userSessions.get(userId);
    if (!session) return bot.telegram.sendMessage(userId, "⚠ Please connect your wallet to copy trades.");
    
    const { account } = session;
    const gasPrice = await web3.eth.getGasPrice();
    const txData = await web3.eth.getTransaction(tx.transactionHash);
    
    const copiedTx = {
      from: account.address,
      to: txData.to,
      value: txData.value,
      gas: 2000000,
      gasPrice: gasPrice,
      data: txData.input,
    };
    
    const signedTx = await web3.eth.accounts.signTransaction(copiedTx, account.privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
    bot.telegram.sendMessage(userId, `✅ **Copied Trade Executed!** \nTransaction: [View on Explorer](https://explorer.roninchain.com/tx/${receipt.transactionHash})`);
  } catch (error) {
    console.error("Error executing copied trade:", error);
    bot.telegram.sendMessage(userId, "❌ Failed to execute copied trade.");
  }
}

// Start tracking trades
trackCopiedTrades();

// Launch bot
bot.launch();
console.log("Bot is running...");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
