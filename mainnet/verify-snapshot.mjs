// Offline consistency check only. This does not query the chain or access custody.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const defaultRead = path => readFileSync(new URL(path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifySnapshot({ read = defaultRead } = {}) {
  const parse = path => JSON.parse(read(path));
  const candidateHash = 'f20785dfe1a21e3f8098cfa2268352f5ed07ebf8074ebaa4dc0a161a831535b4';
  const prefix = './snapshot/mainnet/';
  const c = parse(`${prefix}candidate/manifest.json`);
  assert.equal(sha(read(`${prefix}candidate/manifest.json`)), candidateHash);
  assert.equal(read(`${prefix}candidate/manifest.sha256`).toString(), `${candidateHash}  manifest.json\n`);
  for (const [path, hash] of Object.entries(c.reviewedFiles)) {
    assert.equal(sha(read(prefix + path)), hash, `Sealed file changed: ${path}`);
  }
  for (const [name, source] of Object.entries(c.sources)) {
    const bytes = read(`${prefix}contracts/${name}.clar`);
    assert.equal(bytes.toString(), source.code);
    assert.equal(sha(bytes), source.sha256);
  }
  for (const [name, hash] of Object.entries(c.libraryPins)) {
    assert.equal(sha(read(`./snapshot/source/vault/src/${name}`)), hash, `Signer changed: ${name}`);
  }
  assert.equal(sha(read('./snapshot/source/vault/package-lock.json')), c.dependenciesLockSha256);
  for (const [name, hash] of Object.entries(c.tokenSourceHashes)) {
    assert.equal(sha(read(`${prefix}evidence/${name}.deployed.clar`).toString().trim()), hash);
  }

  const e = parse('./evidence/mainnet-execution.json');
  assert.equal(sha(read('./evidence/mainnet-execution.json')), '91c60f925d414a4f5c1dca57a147c9921095ea324e8ff17bffc9668877d213fa', 'Historical execution evidence changed');
  const audit = parse('./evidence/completion-audit.json');
  assert.equal(sha(read('./evidence/mainnet-execution.json')), audit.executionEvidenceSha256);
  assert.equal(e.candidateSha256, candidateHash);
  assert.equal(audit.candidateSha256, candidateHash);
  assert.equal(e.complete, true);
  assert.equal(e.retiredOperationally, true);
  assert.equal(e.chainId, 1);
  assert.equal(e.token, c.token);
  for (const field of ['vault', 'verifier', 'vaultId', 'digest', 'recipient', 'amountSats']) assert.equal(e[field], c[field]);
  assert.deepEqual(e.sourceHashes, Object.fromEntries(Object.entries(c.sources).map(([name, s]) => [name, s.sha256])));
  const labels = ['deploy-pq-verifier-trait', 'deploy-lamport', 'deploy-pq-vault', 'open-vault', 'deposit-sbtc', 'fund-submitter', 'withdraw-sbtc'];
  assert.deepEqual(e.transactions.map(t => t.label), labels);
  let fees = 0n;
  for (const tx of e.transactions) {
    assert.equal(tx.status, 'success');
    assert.equal(tx.canonical, true);
    assert.ok(tx.confirmations >= c.confirmations);
    fees += BigInt(tx.feeMicroStx);
  }
  assert.equal(fees.toString(), e.actualFeesMicroStx);
  assert.equal(e.actualFeesMicroStx, audit.actualFeesMicroStx);
  assert.ok(fees <= BigInt(c.feeCapMicroStx));
  assert.equal(e.transactions[6].txid, audit.withdrawalTxid);
  assert.ok(e.transactions[6].transfers.some(t => t.asset_id === `${c.token}::sbtc-token` && t.sender === c.vault && t.recipient === c.recipient && t.amount === c.amountSats));
  assert.equal(e.vaultSbtcSats, '0');
  assert.equal(e.finalVault.sbtc, '0');
  assert.equal(e.finalVault.nonce, '1');
  assert.equal(e.finalVault.key, c.nextKey);
  assert.equal(e.recipientIncreaseSats, c.amountSats);
  assert.equal(e.oneTimeKeyClaims, 1);
  assert.equal(e.initialClaimDigest, c.digest);

  const integration = parse('./evidence/integration-results.json');
  assert.equal(integration.passed, true);
  assert.equal(integration.scenarios.length, 13);
  assert.equal(integration.testSourceSha256, sha(read(`${prefix}integration.test.mjs`)));
  assert.deepEqual(integration.contractSourceSha256, e.sourceHashes);
  assert.ok(integration.contractRejections.every(r => r.stateAndBalancesUnchanged && r.events.length === 0));
  verifyExecutionEvidence(c, e, audit);
  return { offline: true, candidateSha256: candidateHash, sealedFiles: Object.keys(c.reviewedFiles).length, historicalTransactions: e.transactions.length, actualFeesStx: e.actualFeesStx, consistent: true };
}

export function verifyExecutionEvidence(c, e, audit) {
  assert.equal(e.network, 'mainnet');
  assert.equal(e.minimumStacksConfirmations, c.confirmations);
  assert.equal(e.feeCapMicroStx, c.feeCapMicroStx);
  const hex = /^0x[0-9a-f]{64}$/;
  assert.equal(new Set(e.transactions.map(t => t.txid)).size, 7, 'Duplicate or missing transactions');
  let fees = 0n;
  for (const [i, tx] of e.transactions.entries()) {
    assert.match(tx.txid, hex); assert.match(tx.blockHash, hex);
    assert.ok(Number.isSafeInteger(tx.blockHeight) && tx.blockHeight > 0);
    assert.ok(Number.isSafeInteger(tx.confirmations) && tx.confirmations >= c.confirmations);
    assert.equal(tx.status, 'success'); assert.equal(tx.canonical, true);
    assert.equal(tx.sender, c.accounts[i === 6 ? 'submitter' : 'operator'].address);
    assert.equal(tx.nonce, String(BigInt(c.accounts[i === 6 ? 'submitter' : 'operator'].startNonce) + BigInt(i === 6 ? 0 : i)));
    assert.equal(tx.result, i === 3 ? `(ok 0x${c.vaultId})` : '(ok true)');
    assert.ok(Number.isSafeInteger(tx.bytes) && tx.bytes > 0);
    assert.match(tx.feeMicroStx, /^(0|[1-9][0-9]*)$/); fees += BigInt(tx.feeMicroStx);
    assert.equal(tx.explorer, `https://explorer.hiro.so/txid/${tx.txid}?chain=mainnet`);
    if (i > 0) assert.ok(tx.blockHeight - e.transactions[i-1].blockHeight >= c.confirmations, 'Confirmation spacing is too short');
    const expected = i === 4 ? ['fungible_token_asset', c.accounts.operator.address, c.vault, c.amountSats] : i === 5 ? ['stx_asset', c.accounts.operator.address, c.accounts.submitter.address, c.submitterReserveMicroStx] : i === 6 ? ['fungible_token_asset', c.vault, c.recipient, c.amountSats] : null;
    assert.equal(tx.transfers.length, expected ? 1 : 0, 'Unexpected transfer count');
    if (expected) {
      const [type,sender,recipient,amount] = expected, t = tx.transfers[0];
      assert.equal(t.type,type); assert.equal(t.sender,sender); assert.equal(t.recipient,recipient);
      assert.equal(t.amount,amount); assert.equal(t.asset_event_type,'transfer');
      if (type === 'fungible_token_asset') assert.equal(t.asset_id, `${c.token}::sbtc-token`);
    }
  }
  assert.equal(String(fees), e.actualFeesMicroStx);
  assert.equal(Number(fees)/1e6, e.actualFeesStx);
  assert.equal(String(BigInt(c.feeCapMicroStx)-fees), audit.unusedFeeBudgetMicroStx);
  assert.equal(e.finalVault.stx,'0'); assert.equal(e.finalVault.verifier,c.verifier);
  assert.equal(BigInt(e.balances.recipient.sbtcSats)-BigInt(e.recipientSbtcBefore), BigInt(c.amountSats));
  for (const role of ['operator','submitter','recipient']) assert.equal(e.balances[role].address,c.accounts[role].address);
  const requirements = ['threeDedicatedAccountsAndCustodyVerified','mainnetContractsDeployedAndSourceHashesMatch','sevenCanonicalSuccessesAtLeastSixStacksConfirmations','oneThousandSatsOfOfficialMainnetSbtcPaid','independentCarrierAndPinnedRecipient','vaultDrainedNonceOneSuccessorInstalled','oneDurableKeyClaimAndAuthorizationRetained','allFeesWithinTwentyStx','original105AndCandidate48TestsPassed','freshBundle48TestsPassed','nativeProposalAndMarkdownSynced'];
  for (const name of requirements) assert.equal(audit.requirements[name], true, `Missing completion assertion: ${name}`);
  assert.deepEqual(audit.remainingRequiredOnChainWork, []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifySnapshot(), null, 2));
