import { ethers } from "ethers";

// --- Configuration ---
const ACROSS_API_BASE = "https://app.across.to/api";

const ARBITRUM_CHAIN_ID = 42161;
const BASE_CHAIN_ID = 8453;

// USDC contract addresses (native USDC, not bridged)
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const USDC_DECIMALS = 6;

// Arbitrum RPC (public endpoint)
const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

// --- Environment ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AMOUNT_USDC = process.env.AMOUNT_USDC || "10";
const RECIPIENT = process.env.RECIPIENT;

if (!PRIVATE_KEY) {
  console.error("Error: Set PRIVATE_KEY environment variable.");
  console.error("  export PRIVATE_KEY=0x...");
  process.exit(1);
}

// --- Helpers ---
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function pollDepositStatus(txHash) {
  const url = `${ACROSS_API_BASE}/deposit/status?depositTxnRef=${txHash}`;
  console.log("\nTracking deposit...");

  for (let i = 0; i < 60; i++) {
    const status = await fetchJson(url);
    const state = status.status || "unknown";
    console.log(`  Status: ${state}`);

    if (state === "filled") {
      console.log("Bridge complete! Funds delivered on Base.");
      return status;
    }
    if (state === "expired" || state === "refunded") {
      console.log(`Bridge ${state}. Check the Across explorer for details.`);
      return status;
    }

    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("Timed out waiting for fill. Check https://app.across.to manually.");
}

// --- Main ---
async function main() {
  const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const depositor = wallet.address;

  const amountWei = ethers.parseUnits(AMOUNT_USDC, USDC_DECIMALS).toString();

  console.log(`Bridging ${AMOUNT_USDC} USDC from Arbitrum to Base`);
  console.log(`  Depositor: ${depositor}`);
  console.log(`  Recipient: ${RECIPIENT || depositor}`);
  console.log(`  Amount:    ${amountWei} (smallest units)\n`);

  // Step 1: Get a quote from the Swap API
  const params = new URLSearchParams({
    tradeType: "exactInput",
    amount: amountWei,
    inputToken: USDC_ARBITRUM,
    outputToken: USDC_BASE,
    originChainId: ARBITRUM_CHAIN_ID.toString(),
    destinationChainId: BASE_CHAIN_ID.toString(),
    depositor,
    slippage: "auto",
  });
  if (RECIPIENT) params.set("recipient", RECIPIENT);

  console.log("Fetching quote from Across Swap API...");
  const quote = await fetchJson(`${ACROSS_API_BASE}/swap/approval?${params}`);

  console.log(`  Route type:      ${quote.crossSwapType}`);
  console.log(`  Expected output: ${ethers.formatUnits(quote.expectedOutputAmount, USDC_DECIMALS)} USDC`);
  console.log(`  Min output:      ${ethers.formatUnits(quote.minOutputAmount, USDC_DECIMALS)} USDC`);
  console.log(`  Expected fill:   ~${quote.expectedFillTime}s`);

  // Step 2: Submit approval transactions if needed
  if (quote.approvalTxns && quote.approvalTxns.length > 0) {
    console.log(`\nSubmitting ${quote.approvalTxns.length} approval transaction(s)...`);
    for (const approvalTx of quote.approvalTxns) {
      const tx = await wallet.sendTransaction({
        to: approvalTx.to,
        data: approvalTx.data,
        chainId: approvalTx.chainId,
      });
      console.log(`  Approval tx: ${tx.hash}`);
      await tx.wait();
      console.log("  Confirmed.");
    }
  }

  // Step 3: Submit the swap/bridge transaction
  console.log("\nSubmitting bridge transaction...");
  const swapTx = await wallet.sendTransaction({
    to: quote.swapTx.to,
    data: quote.swapTx.data,
    chainId: quote.swapTx.chainId,
    gasLimit: quote.swapTx.gas,
  });
  console.log(`  Bridge tx: ${swapTx.hash}`);
  const receipt = await swapTx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber}`);

  // Step 4: Track the deposit until filled
  await pollDepositStatus(receipt.hash);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
