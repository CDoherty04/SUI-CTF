import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };
import { Transaction } from '@mysten/sui/transactions';

/**
 *
 * Global variables
 *
 * These variables can be used throughout the exercise below.
 *
 */
const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});
const USDC_COIN_TYPE = '0x2::coin::Coin<0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC>';
const CTF_PACKAGE_ID = '0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd';
const COST_PER_FLAG = 5_849_000;

(async () => {
	const { objects } = await suiClient.listOwnedObjects({
		owner: keypair.getPublicKey().toSuiAddress(),
		type: USDC_COIN_TYPE,
		limit: 50,
	});

	const usdcCoin = objects[0].objectId;

	const tx = new Transaction();
	const paymentCoin = tx.object(usdcCoin);

	const payment = tx.splitCoins(paymentCoin, [COST_PER_FLAG]);

	// Buy flag
	const flag = tx.moveCall({
		target: `0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd::merchant::buy_flag`,
		arguments: [payment],
	});

	// Transfer flag to recipient
	tx.transferObjects([flag], keypair.getPublicKey().toSuiAddress());

	// Sign and execute transaction
	const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx });

	// Check transaction status
	if (result.$kind === 'FailedTransaction') {
		throw new Error(`Transaction failed: ${result.FailedTransaction.status.error?.message}`);
	}

	// Wait for transaction to be processed and log result
	await suiClient.waitForTransaction({ result });
	console.log(result);

})();
