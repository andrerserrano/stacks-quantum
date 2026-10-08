// A simnet at Epoch 4.0 with the contracts deployed, shared by the tests, the
// cost measurement and the demo.

import { readFileSync } from "node:fs";
import { getSDK } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";

export const EPOCH = "4.0";
export const CLARITY_VERSION = 6;
export const CHAIN_ID = 0x80000000; // what `chain-id` returns on simnet and testnet; mainnet is 1
export const CONTRACTS = ["pq-verifier-trait", "wots", "lamport", "sbtc-token", "pq-vault"];
export const TENURE_BUDGET = { runtime: 5_000_000_000, readCount: 30_000, readLength: 200_000_000, writeCount: 15_000, writeLength: 15_000_000 };

export const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
export const ALICE = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
export const BOB = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
export const MALLORY = "ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC";

const root = new URL("../contracts/", import.meta.url);
export const source = (name) => readFileSync(new URL(`${name}.clar`, root), "utf8");

// `override` replaces a contract's source by name, for the mutation check.
// `deployer` puts the contracts under another address, to mirror a testnet run.
export async function boot({ extra = [], override = {}, deployer = DEPLOYER } = {}) {
  const simnet = await getSDK({ trackCosts: true, trackCoverage: false });
  await simnet.initEmptySession({ enabled: false, api_url: "", initial_height: 1, use_mainnet_wallets: false });
  simnet.setEpoch(EPOCH);
  const accounts = [...new Set([deployer, ALICE, BOB, MALLORY])];
  simnet.setLocalAccounts(accounts);
  for (const who of accounts) simnet.mintSTX(who, 1_000_000_000_000n);

  const deployCosts = {};
  const deploy = (name, src = source(name)) => {
    deployCosts[name] = simnet.deployContract(name, src, { clarityVersion: CLARITY_VERSION }, deployer).costs.total;
  };
  CONTRACTS.forEach((name) => deploy(name, override[name] ?? source(name)));
  extra.forEach(([name, src]) => deploy(name, src));

  const id = (name) => `${deployer}.${name}`;
  const call = (contract, fn, args, sender = deployer) => simnet.callPublicFn(id(contract), fn, args, sender);
  const read = (contract, fn, args = [], sender = deployer) => simnet.callReadOnlyFn(id(contract), fn, args, sender).result;
  const stx = (who) => simnet.getAssetsMap().get("STX")?.get(who) ?? 0n;
  const sbtc = (who) => BigInt(read("sbtc-token", "get-balance", [Cl.principal(who)]).value.value);
  return { simnet, id, call, read, stx, sbtc, chainId: CHAIN_ID, deployCosts, vault: id("pq-vault") };
}
