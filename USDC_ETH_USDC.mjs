import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  Transaction,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import got from "got";
import { Wallet } from "@project-serum/anchor";
import promiseRetry from "promise-retry";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

console.log({ dotenv });
dotenv.config();

// This is a free Solana RPC endpoint. It may have ratelimit and sometimes
// invalid cache. I will recommend using a paid RPC endpoint.
const connection = new Connection("https://ssc-dao.genesysgo.net/");
const wallet = new Wallet(
  Keypair.fromSecretKey(bs58.decode(process.env.WETH_USDC_KEY || ""))
);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WETH_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";

const PROFIT_BPS = 1.0023;

// weth account
const createWEthAccount = async () => {
  const wethAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(WETH_MINT),
    wallet.publicKey
  );

  const wethAccount = await connection.getAccountInfo(wethAddress);

  if (!wethAccount) {
    const transaction = new Transaction({
      feePayer: wallet.publicKey,
    });
    const instructions = [];

    instructions.push(
      await Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        new PublicKey(WETH_MINT),
        wethAddress,
        wallet.publicKey,
        wallet.publicKey
      )
    );

    // fund 0.1 weth to the account
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wethAddress,
        lamports: 10_000_000, // 0.1 weth
      })
    );

    instructions.push(
      // This is not exposed by the types, but indeed it exists
      Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, wethAddress)
    );

    transaction.add(...instructions);
    transaction.recentBlockhash = await (
      await connection.getRecentBlockhash()
    ).blockhash;
    transaction.partialSign(wallet.payer);
    const result = await connection.sendTransaction(transaction, [
      wallet.payer,
    ]);
    console.log({ result });
  }

  return wethAccount;
};

const getCoinQuote = (inputMint, outputMint, amount) =>
  got
    .get(
      `https://quote-api.jup.ag/v1/quote?outputMint=${outputMint}&inputMint=${inputMint}&amount=${amount}&slippage=0.2`
    )
    .json();

const getTransaction = (route) => {
  return got
    .post("https://quote-api.jup.ag/v1/swap", {
      json: {
        route: route,
        userPublicKey: wallet.publicKey.toString(),
        // to make sure it doesnt close the sol account
        wrapUnwrapSOL: false,
      },
    })
    .json();
};

const getConfirmTransaction = async (txid) => {
  const res = await promiseRetry(
    async (retry, attempt) => {
      let txResult = await connection.getTransaction(txid, {
        commitment: "confirmed",
      });

      if (!txResult) {
        const error = new Error("Transaction was not confirmed");
        error.txid = txid;

        retry(error);
        return;
      }
      return txResult;
    },
    {
      retries: 40,
      minTimeout: 500,
      maxTimeout: 1000,
    }
  );
  if (res.meta.err) {
    throw new Error("Transaction failed");
  }
  return txid;
};

// require weth to start trading, this function create your weth account and fund 1 WETH to it
await createWEthAccount();

// initial 100 USDC for quote
const initial = 100_000_000;

while (true) {
  // 0.1 WETH
  const usdcToWEth = await getCoinQuote(USDC_MINT, WETH_MINT, initial);

  const wethToUsdc = await getCoinQuote(
    WETH_MINT,
    USDC_MINT,
    usdcToWEth.data[0].outAmount
  );

  // when outAmount more than initial
  if (wethToUsdc.data[0].outAmount > initial*PROFIT_BPS) {
    await Promise.all(
      [usdcToWEth.data[0], wethToUsdc.data[0]].map(async (route) => {
        const { setupTransaction, swapTransaction, cleanupTransaction } =
          await getTransaction(route);

        await Promise.all(
          [setupTransaction, swapTransaction, cleanupTransaction]
            .filter(Boolean)
            .map(async (serializedTransaction) => {
              // get transaction object from serialized transaction
              const transaction = Transaction.from(
                Buffer.from(serializedTransaction, "base64")
              );
              // perform the swap
              // Transaction might failed or dropped
              const txid = await connection.sendTransaction(
                transaction,
                [wallet.payer],
                {
                  skipPreflight: true,
                }
              );
              try {
                await getConfirmTransaction(txid);
                console.log(`Success: https://solscan.io/tx/${txid}`);
              } catch (e) {
                console.log(`Failed: https://solscan.io/tx/${txid}`);
              }
            })
        );
      })
    );
  }
}
