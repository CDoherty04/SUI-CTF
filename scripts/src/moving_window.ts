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

let isWindowOpen = false;
const time = new Date().toISOString();
// if time is the first 5 minutes of the hour, or the first 5 minutes of the half hour, the window is open
if (parseInt(time.split(':')[1]) < 5 || (parseInt(time.split(':')[1]) >= 30 && parseInt(time.split(':')[2]) < 5)) {
	isWindowOpen = true;
}

(async () => {
	// Init transaction
	const tx = new Transaction();
	const clock = tx.object.clock();

	// Throw error if window is not open
	if (!isWindowOpen) {
		console.log(`Current minute is ${time.split(':')[1]}`);
		throw new Error(`Window is not open`);
	}
	
	// Move call to extract flag when window is open
	const flag = tx.moveCall({
		target: `0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd::moving_window::extract_flag`,
		arguments: [clock],
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