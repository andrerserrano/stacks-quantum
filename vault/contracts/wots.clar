;; WOTS+ verification over SHA-256. One-time: a key must sign one digest only.
;;
;; Parameters: 32-byte values, w = 16, so 64 message digits and 3 checksum
;; digits, 67 hash chains of 15 steps each.
;;
;;   F(seed, i, s, x) = SHA256(seed || byte(i) || byte(s) || x)    chain i, step s
;;   end_i            = F applied to the secret value of chain i for s = 0..14
;;   H_0 = seed,  H_(i+1) = SHA256(H_i || end_i),  key = H_67
;;
;; The key folds the chain ends into a running hash because building one
;; 2 KB buffer costs more in Clarity than 67 short hashes.
;;
;; To sign, the owner publishes each chain's value after d_i steps, where d_i
;; is that chain's digit. The verifier runs the remaining 15 - d_i steps and
;; compares the result with `key`. The checksum digits fall when a message
;; digit rises, so a signature cannot be walked forward to another digest.
;;
;; A signature is 68 words: the public seed, then one value per chain.

(impl-trait .pq-verifier-trait.pq-verifier)

(define-constant STEPS (list 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 0x0a 0x0b 0x0c 0x0d 0x0e))
(define-constant CHAINS (list
  0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 0x0a 0x0b 0x0c 0x0d 0x0e 0x0f
  0x10 0x11 0x12 0x13 0x14 0x15 0x16 0x17 0x18 0x19 0x1a 0x1b 0x1c 0x1d 0x1e 0x1f
  0x20 0x21 0x22 0x23 0x24 0x25 0x26 0x27 0x28 0x29 0x2a 0x2b 0x2c 0x2d 0x2e 0x2f
  0x30 0x31 0x32 0x33 0x34 0x35 0x36 0x37 0x38 0x39 0x3a 0x3b 0x3c 0x3d 0x3e 0x3f
  0x40 0x41 0x42))

(define-private (is-word (x (buff 32)) (acc bool))
  (and acc (is-eq (len x) u32)))

;; One step of a chain. `p` is seed || byte(i) and does not change.
(define-private (step (s (buff 1)) (acc {p: (buff 33), v: (buff 32)}))
  {p: (get p acc), v: (sha256 (concat (concat (get p acc) s) (get v acc)))})

;; Digit i of the message: the 64 nibbles of the digest, high nibble first,
;; then the checksum as three nibbles, most significant first.
(define-private (digit (digest (buff 32)) (csum uint) (i uint))
  (if (< i u64)
    (let ((b (buff-to-uint-be (unwrap-panic (element-at? digest (/ i u2))))))
      (if (is-eq (mod i u2) u0) (/ b u16) (mod b u16)))
    (mod (/ csum (pow u16 (- u66 i))) u16)))

;; Finish chain i from the published value `x` and fold its end into the key.
(define-private (walk (x (buff 32))
    (acc {seed: (buff 32), digest: (buff 32), i: uint, csum: uint, h: (buff 32)}))
  (let ((i (get i acc))
        (d (digit (get digest acc) (get csum acc) i))
        (end (get v (fold step
          (default-to (list) (slice? STEPS d u15))
          {p: (concat (get seed acc) (unwrap-panic (element-at? CHAINS i))), v: x}))))
    (merge acc {
      i: (+ i u1),
      csum: (if (< i u64) (+ (get csum acc) (- u15 d)) (get csum acc)),
      h: (sha256 (concat (get h acc) end))})))

(define-read-only (check (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
  (let ((seed (unwrap! (element-at? sig u0) false))
        (values (unwrap! (slice? sig u1 u68) false)))
    (and
      (is-eq (len sig) u68)
      (is-eq (len digest) u32)
      (fold is-word sig true)
      (is-eq key (get h (fold walk values {seed: seed, digest: digest, i: u0, csum: u0, h: seed}))))))

(define-public (verify (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
  (ok (check key digest sig)))
