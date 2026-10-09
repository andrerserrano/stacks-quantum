// A stand-in for the Hiro testnet API, backed by a simnet. It accepts the
// transactions the demo sends, runs them on a bare simnet and answers the
// queries testnet.mjs makes, so the --send path runs end to end on one
// machine. It checks what a node would: the sender's nonce, and each
// transaction's post-conditions against what the transaction moved.
//
// It has no mempool: a transaction is mined as it arrives. Simnet charges no
// fees. A transaction that fails its post-conditions is reported as rolled
// back, but simnet has already applied it, so a test must end there.

import { createServer } from "node:http";
import {
  AddressVersion, Cl, addressFromVersionHash, addressToString, cvToHex, deserializeTransaction, hexToCV,
} from "@stacks/transactions";
import { boot } from "../src/simnet.mjs";

const KIND = { 0: "transfer", 2: "call", 6: "deploy" };
const CODE = { 1: "eq", 2: "gt", 3: "gte", 4: "lt", 5: "lte" };
const HOLDS = { eq: (a, b) => a === b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };

// A post-condition as { principal, asset, code, amount }. The asset is "STX"
// or a token's full name, "address.contract::token".
function condition(pc) {
  const at = (a) => addressToString(a);
  const principal = pc.principal.contractName ? `${at(pc.principal.address)}.${pc.principal.contractName.content}` : at(pc.principal.address);
  const asset = pc.asset ? `${at(pc.asset.address)}.${pc.asset.contractName.content}::${pc.asset.assetName.content}` : "STX";
  return { principal, asset, code: CODE[pc.conditionCode], amount: BigInt(pc.amount) };
}

// What each principal sent of each asset, from a transaction's events.
function sentBy(events) {
  const total = new Map();
  for (const { event, data } of events ?? []) {
    const asset = event === "stx_transfer_event" ? "STX" : event === "ft_transfer_event" ? data.asset_identifier : null;
    if (asset) total.set(`${data.sender} ${asset}`, (total.get(`${data.sender} ${asset}`) ?? 0n) + BigInt(data.amount));
  }
  return total;
}

// Deny mode: every condition has to hold, and nothing may be sent that no
// condition covers.
function conditionsHold(conditions, events) {
  const total = sentBy(events);
  const covered = new Set(conditions.map((c) => `${c.principal} ${c.asset}`));
  return conditions.every((c) => HOLDS[c.code](total.get(`${c.principal} ${c.asset}`) ?? 0n, c.amount))
    && [...total.keys()].every((k) => covered.has(k));
}

export async function fakeNode() {
  const t = await boot({ contracts: [] });
  const nonces = new Map(), txs = new Map(), deployed = new Map(), moved = new Map(), sent = [];
  // The count of transactions seen at which the next one is refused or dropped.
  let height = 100, refuseAt = -1, dropAt = -1, rollBackAt = -1, loseAt = -1;

  function broadcast(hex) {
    const tx = deserializeTransaction(hex);
    const cond = tx.auth.spendingCondition, p = tx.payload;
    const sender = addressToString(addressFromVersionHash(AddressVersion.TestnetSingleSig, cond.signer));
    const txid = tx.txid(), nonce = Number(cond.nonce);
    if (sent.length === refuseAt) {
      refuseAt = -1;
      return [400, { error: "transaction rejected", reason: "ServerFailureOther", txid }];
    }
    if (nonce !== (nonces.get(sender) ?? 0)) return [400, { error: "transaction rejected", reason: "BadNonce", txid }];
    const seen = { txid: `0x${txid}`, sender, nonce, fee: cond.fee, kind: KIND[p.payloadType], bytes: hex.length / 2,
                   denies: tx.postConditionMode === 2, conditions: tx.postConditions.values.map(condition) };
    // The same transaction again, as after a lost reply: it is already here.
    if (txs.has(seen.txid) && !txs.get(seen.txid).tx_status.startsWith("dropped")) return [400, { error: "transaction rejected", reason: "ConflictingNonceInMempool", txid }];
    if (sent.length === dropAt) {
      dropAt = -1;
      txs.set(seen.txid, { tx_id: seen.txid, tx_status: "dropped_replace_by_fee" });
      sent.push({ ...seen, dropped: true });
      return [200, txid];
    }

    if (sent.length === rollBackAt) {
      // What a node reports when a post-condition fails: the function's own
      // result, and nothing changed. The nonce is used up.
      nonces.set(sender, nonce + 1);
      txs.set(seen.txid, { tx_id: seen.txid, tx_status: "abort_by_post_condition", tx_result: { repr: "(ok true)" }, fee_rate: String(cond.fee), block_height: ++height });
      sent.push({ ...seen, rolledBack: true });
      return [200, txid];
    }

    let r;
    if (seen.kind === "transfer") {
      r = t.simnet.transferSTX(p.amount, p.recipient.value, sender);
    } else if (seen.kind === "deploy") {
      seen.call = `${sender}.${p.contractName.content}`;
      r = t.simnet.deployContract(p.contractName.content, p.codeBody.content, { clarityVersion: p.clarityVersion }, sender);
      deployed.set(seen.call, p.codeBody.content);
    } else {
      seen.call = `${addressToString(p.contractAddress)}.${p.contractName.content}.${p.functionName.content}`;
      r = t.simnet.callPublicFn(`${addressToString(p.contractAddress)}.${p.contractName.content}`, p.functionName.content, p.functionArgs, sender);
    }
    nonces.set(sender, nonce + 1);
    const repr = seen.kind === "deploy" ? "(ok true)" : Cl.prettyPrint(r.result);
    const cost = r.costs?.total ?? {};
    const held = seen.kind !== "call" || !repr.startsWith("(ok") || conditionsHold(seen.conditions, r.events);
    // The transaction's asset events, in the shape the API gives them.
    moved.set(seen.txid, !held || !repr.startsWith("(ok") ? [] : (r.events ?? []).flatMap(({ event, data }) => {
      const kind = { stx_transfer_event: ["stx_asset", "transfer"], ft_transfer_event: ["fungible_token_asset", "transfer"], ft_mint_event: ["fungible_token_asset", "mint"] }[event];
      return kind ? [{ event_type: kind[0], asset: { asset_event_type: kind[1], sender: data.sender ?? "", recipient: data.recipient, amount: String(data.amount) } }] : [];
    }));
    txs.set(seen.txid, {
      tx_id: seen.txid, tx_status: !held ? "abort_by_post_condition" : repr.startsWith("(ok") ? "success" : "abort_by_response", tx_result: { repr },
      fee_rate: String(cond.fee), block_height: ++height, block_time_iso: new Date().toISOString(),
      execution_cost_runtime: cost.runtime ?? 0, execution_cost_read_count: cost.readCount ?? 0, execution_cost_read_length: cost.readLength ?? 0,
      execution_cost_write_count: cost.writeCount ?? 0, execution_cost_write_length: cost.writeLength ?? 0,
    });
    const lose = sent.length === loseAt;
    if (lose) loseAt = -1;
    sent.push({ ...seen, result: repr, ...(!held && { failedConditions: true }) });
    return [200, txid, lose];
  }

  function route(method, url, body) {
    const path = url.pathname.split("/").filter(Boolean);
    const at = (prefix) => url.pathname.startsWith(prefix);
    if (method === "POST" && at("/v2/transactions")) return broadcast(body.tx);
    if (method === "POST" && at("/v2/contracts/call-read/")) {
      const [, , , address, name, fn] = path;
      try {
        const r = t.simnet.callReadOnlyFn(`${address}.${name}`, decodeURIComponent(fn), body.arguments.map((a) => hexToCV(a)), body.sender);
        return [200, { okay: true, result: cvToHex(r.result) }];
      } catch (e) {
        return [200, { okay: false, cause: String(e) }];
      }
    }
    if (method === "POST" && at("/extended/v1/faucets/stx")) {
      t.simnet.mintSTX(url.searchParams.get("address"), 500_000_000n);
      return [200, { success: true }];
    }
    if (at("/extended/v1/address/") && path[4] === "stx") return [200, { balance: String(t.stx(path[3])) }];
    if (at("/extended/v1/address/") && path[4] === "nonces") return [200, { possible_next_nonce: nonces.get(path[3]) ?? 0 }];
    if (at("/v2/contracts/interface/")) return deployed.has(`${path[3]}.${path[4]}`) ? [200, {}] : [404, { error: "no such contract" }];
    if (at("/v2/contracts/source/")) return deployed.has(`${path[3]}.${path[4]}`) ? [200, { source: deployed.get(`${path[3]}.${path[4]}`) }] : [404, {}];
    if (at("/extended/v1/tx/events")) return [200, { events: moved.get(url.searchParams.get("tx_id")) ?? [] }];
    if (at("/extended/v1/tx/")) return txs.has(path[3]) ? [200, txs.get(path[3])] : [404, { error: "no such transaction" }];
    return [404, { error: `the stand-in does not serve ${method} ${url.pathname}` }];
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let status, answer, lose;
      try {
        [status, answer, lose] = route(req.method, new URL(req.url, "http://localhost"), raw ? JSON.parse(raw) : {});
      } catch (e) {
        [status, answer] = [500, { error: String(e) }];
      }
      // The node took the transaction and the reply never arrives.
      if (lose) return req.socket.destroy();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sent,
    stx: (address) => t.stx(address),
    refuseAfter: (count = sent.length) => { refuseAt = count; },
    dropAfter: (count = sent.length) => { dropAt = count; },
    rollBackAfter: (count = sent.length) => { rollBackAt = count; },
    loseReplyAfter: (count = sent.length) => { loseAt = count; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
