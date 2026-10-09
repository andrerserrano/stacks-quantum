// Amounts as people write them and as the chain counts them.

const DECIMALS = { stx: 6, sbtc: 8 };

// "1.5" of an asset in its smallest unit, exactly. 1.5 STX is 1500000 uSTX.
export function units(text, asset) {
  const d = DECIMALS[asset];
  const m = /^(\d+)(?:\.(\d+))?$/.exec((text ?? "").trim());
  if (!d || !m || (m[2]?.length ?? 0) > d) throw new Error(`"${text}" is not an amount of ${asset}`);
  return BigInt(m[1]) * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0"));
}

// And back: 1500000 uSTX is "1.5".
export function amountText(amount, asset) {
  const d = DECIMALS[asset];
  const s = String(amount).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, "");
}

export const LABEL = { stx: "STX", sbtc: "sBTC" };
