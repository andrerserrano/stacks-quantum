// Clarity values on the wire, for the calls the page makes to read-only
// contract functions. Only what the page needs: the encodings in SIP-005 and
// Stacks addresses. No dependencies, so the same file runs in the browser and
// in the tests, which compare it against @stacks/transactions.

const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex) => {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const u32 = (n) => n.toString(16).padStart(8, "0");
const ascii = (s) => {
  if (/[^\x20-\x7e]/.test(s)) throw new Error("not ASCII");
  return hexOf(new TextEncoder().encode(s));
};

// --- addresses ----------------------------------------------------------------

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

// "ST..." to its version byte and 20-byte hash, as hex. Throws on a mistyped
// address: the last four bytes are a checksum.
export async function addressParts(address) {
  const text = address.trim().toUpperCase().replace(/O/g, "0").replace(/[LI]/g, "1");
  if (!/^S[0-9A-HJKMNP-TV-Z]{2,}$/.test(text)) throw new Error("not a Stacks address");
  const version = C32.indexOf(text[1]);
  let n = 0n;
  for (const ch of text.slice(2)) n = n * 32n + BigInt(C32.indexOf(ch));
  const data = n.toString(16).padStart(48, "0");
  if (data.length !== 48) throw new Error("not a Stacks address");
  const hash = data.slice(0, 40);
  const check = await sha256(await sha256(bytesOf(version.toString(16).padStart(2, "0") + hash)));
  if (hexOf(check.slice(0, 4)) !== data.slice(40)) throw new Error("this address has a typo: its checksum does not match");
  return { version, hash };
}

// --- encoding -----------------------------------------------------------------

export const uint = (n) => {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 128n) throw new Error("not a uint");
  return `01${v.toString(16).padStart(32, "0")}`;
};
export const buffer = (hex) => {
  const h = hexOf(bytesOf(hex));
  return `02${u32(h.length / 2)}${h}`;
};
export const stringAscii = (s) => `0d${u32(s.length)}${ascii(s)}`;
export const list = (items) => `0b${u32(items.length)}${items.join("")}`;

// A standard principal, "ST...", or a contract, "ST....name".
export async function principal(text) {
  const [address, name, extra] = text.trim().split(".");
  const { version, hash } = await addressParts(address);
  const head = `${version.toString(16).padStart(2, "0")}${hash}`;
  if (name === undefined) return `05${head}`;
  if (extra !== undefined || !/^[a-zA-Z]([a-zA-Z0-9]|[-_]){0,127}$/.test(name)) throw new Error("not a contract name");
  return `06${head}${name.length.toString(16).padStart(2, "0")}${ascii(name)}`;
}

// --- decoding -----------------------------------------------------------------

// A serialized value as plain JavaScript: uints as BigInt, buffers as hex,
// tuples as objects, none as null. A response is { ok } or { err }.
export function decode(hex) {
  const bytes = bytesOf(hex);
  let at = 0;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error("the value is cut short");
    return bytes.slice(at, (at += n));
  };
  const size = () => Number(BigInt(`0x${hexOf(take(4))}`));
  const text = (n) => new TextDecoder().decode(take(n));
  function value() {
    const type = take(1)[0];
    switch (type) {
      case 0x00: return BigInt.asIntN(128, BigInt(`0x${hexOf(take(16))}`));
      case 0x01: return BigInt(`0x${hexOf(take(16))}`);
      case 0x02: return hexOf(take(size()));
      case 0x03: return true;
      case 0x04: return false;
      case 0x05: return { version: take(1)[0], hash: hexOf(take(20)) };
      case 0x06: return { version: take(1)[0], hash: hexOf(take(20)), name: text(take(1)[0]) };
      case 0x07: return { ok: value() };
      case 0x08: return { err: value() };
      case 0x09: return null;
      case 0x0a: return value();
      case 0x0b: return Array.from({ length: size() }, value);
      case 0x0c: {
        const out = {};
        for (let n = size(); n > 0; n--) {
          const name = text(take(1)[0]);
          out[name] = value();
        }
        return out;
      }
      case 0x0d: case 0x0e: return text(size());
      default: throw new Error(`unknown Clarity type ${type}`);
    }
  }
  const v = value();
  if (at !== bytes.length) throw new Error("the value has bytes left over");
  return v;
}
