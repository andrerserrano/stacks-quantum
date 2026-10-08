;; Lamport verification over SHA-256, as in the 1979 paper. One-time: a key
;; must sign one digest only.
;;
;; A key pair is 256 pairs of 32-byte secrets, one pair per bit of the digest.
;;
;;   pub_i_b = SHA256(secret_i_b)                                  b = 0, 1
;;   H_0 = 32 zero bytes,  H_(i+1) = SHA256(H_i || pub_i_0 || pub_i_1),  key = H_256
;;
;; The key folds the pairs into a running hash because building one 16 KB
;; buffer costs about ten times more in Clarity than 256 short hashes.
;;
;; To sign, the owner reveals secret_i_b for each bit b of the digest, most
;; significant bit first.
;;
;; A signature is 512 words: the 256 revealed secrets, then the hash of each
;; secret that stays hidden, so the verifier can rebuild `key`.

(impl-trait .pq-verifier-trait.pq-verifier)

(define-private (is-word (x (buff 32)) (acc bool))
  (and acc (is-eq (len x) u32)))

(define-private (bits (b (buff 1)) (acc (list 256 bool)))
  (let ((v (buff-to-uint-be b)))
    (unwrap-panic (as-max-len? (concat acc (list
      (> (bit-and v u128) u0) (> (bit-and v u64) u0) (> (bit-and v u32) u0) (> (bit-and v u16) u0)
      (> (bit-and v u8) u0) (> (bit-and v u4) u0) (> (bit-and v u2) u0) (> (bit-and v u1) u0))) u256))))

;; Both hashes of pair i, in order: the revealed side is recomputed and the
;; hidden side is taken from the signature.
(define-private (pair (secret (buff 32)) (other (buff 32)) (bit bool))
  (if bit (concat other (sha256 secret)) (concat (sha256 secret) other)))

(define-private (join (p (buff 64)) (acc (buff 32)))
  (sha256 (concat acc p)))

(define-read-only (check (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
  (let ((secrets (unwrap! (slice? sig u0 u256) false))
        (others (unwrap! (slice? sig u256 u512) false)))
    (and
      (is-eq (len sig) u512)
      (is-eq (len digest) u32)
      (fold is-word sig true)
      (is-eq key (fold join (map pair secrets others (fold bits digest (list)))
        0x0000000000000000000000000000000000000000000000000000000000000000)))))

(define-public (verify (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
  (ok (check key digest sig)))
