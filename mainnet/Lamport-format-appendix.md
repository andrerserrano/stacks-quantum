## Appendix A. Lamport encoding and key derivation

This defines the prototype's exact encoding, including the public-key commitment and deterministic key derivation. H is SHA-256, MAC(key, message) is HMAC-SHA256 with no truncation, and || concatenates raw bytes. Hex strings below display bytes; their ASCII characters are not hashed.

### A.1 Inputs and key derivation

The master, per-key seed, each secret value, each public hash, commitment and digest are each exactly 32 bytes. A signature is exactly 512 words of 32 bytes: 16,384 raw bytes, excluding Clarity list/buffer encoding and the carrying transaction. The interface admits a list of up to 1,024 buffers, but this verifier accepts only 512 words, each of length 32.

Let V be the vault contract principal as configured text, C the chain ID (1 on mainnet), a the account index (0 for this demo), and k the key index. The signer uses the current vault nonce for k and derives the successor at k + 1. Numeric path components use unsigned base-10 text without leading zeros. Principal strings use their configured spelling. The UTF-8 path has no trailing newline, NUL or extra spaces.

```text
issuer = the address part of V, before the period
U = "lamport" if verifier is omitted or equals issuer + ".lamport"
    otherwise "lamport@" + verifier
path = "pq-vault/v1/" + C + "/" + V + "/" + U + "/" + a + "/" + k
K = MAC(master, UTF8(path))
X[i,b] = MAC(K, bytes([0x6c, i, b]))
P[i,b] = H(X[i,b])
```

Here i ranges from 0 through 255 and b is 0 or 1. The three-byte HMAC label is the literal byte 0x6c followed by one unsigned byte for i and one for b, not decimal text or multi-byte integers. The reference signer requires C, a and k to be integers from 0 through 9007199254740991 and validates V and an explicitly supplied verifier against the pattern below. Derivation is performed off-chain; the verifier does not receive the master or K.

```text
^S[0-9A-Z]{20,}\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$
```

### A.2 Commitment and verification

The commitment folds pairs in increasing i, always with the zero-bit public hash before the one-bit public hash:

```text
A[0] = 32 zero bytes
A[i+1] = H(A[i] || P[i,0] || P[i,1])   for i = 0..255
key = A[256]
```

Each fold hashes exactly 96 bytes. The starting value is zero bytes, not H(empty). Pairs are never reordered according to the signed digest.

D is the 32-byte SHA-256 digest of the typed Clarity consensus serialization of the withdrawal tuple in section 3.2, matching to-consensus-buff? / serializeCV. It is not JSON or the carrying transaction's ID. Process digest bytes in their returned order, starting with byte 0, and bits within each byte from most significant to least significant.

```text
b[i] = (D[i // 8] >> (7 - (i % 8))) & 1
S[i] = X[i,b[i]]                      for i = 0..255
S[256+i] = P[i,1-b[i]]                for i = 0..255

check(key, D, S):
  if len(key) != 32 or len(D) != 32: return false
  if len(S) != 512 or any len(word) != 32: return false
  A = 32 zero bytes
  for i = 0..255:
    bit = (D[i // 8] >> (7 - (i % 8))) & 1
    revealed_hash = H(S[i])
    other_hash = S[256+i]
    if bit == 0: p0, p1 = revealed_hash, other_hash
    else:        p0, p1 = other_hash, revealed_hash
    A = H(A || p0 || p1)
  return A == key
```

The signature layout is all 256 revealed secrets followed by all 256 complementary public hashes; the two groups are not interleaved. Among inputs accepted by the Clarity types, check returns false for malformed lengths or a commitment mismatch; the public verify function returns (ok check-result). Values exceeding the declared types can fail before verification. These rules do not permit a key to sign a second distinct instruction.

### A.3 Public conformance vector

This synthetic fixture exercises derivation and verification without a real withdrawal or custody key. The master and D are the same 32 bytes 00, 01, ... 1f. Set C = 1, a = 0, k = 0, V = SP000000000000000000002Q6VF78.pq-vault and verifier = SP000000000000000000002Q6VF78.lamport.

```text
path = pq-vault/v1/1/SP000000000000000000002Q6VF78.pq-vault/lamport/0/0
master = D = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
K = 1302574cb60210fbe20172f97328e7c24dc458340e654c1dfd5ab96f8807c440
key = 42cc3dbfb86e27820ffb40a7eb597436a0e134a10d5fc8e056e6f8fe5b750ee8
H(S[0] || S[1] || ... || S[511]) =
  d50b2196f26757c74130241a307f816229f29cbf6423945801f45ef9a2f3cc78
check(key, D, S) = true
```

An independent Python calculation matches the JavaScript derivation/signature and the Clarity verifier. Reversing digest bit order, removing a word, or shortening a word is rejected. This checks implementation agreement, not cryptographic security.
