;; A vault for STX and sBTC. A withdrawal needs a hash-based one-time
;; signature, and nothing else: the account that submits the transaction has
;; no say over where the funds go.
;;
;; Each vault stores a 32-byte key and the verifier contract that checks
;; signatures against it. A vault's id is the hash of its first key and its
;; verifier, so nobody can open a look-alike under the id a depositor expects.
;;
;; A withdrawal is signed over this contract, the chain, the vault, its nonce,
;; the asset, the amount, the recipient and the key that takes over next. Once
;; it succeeds the old key is gone, so the same signature cannot be used again.
;;
;; There is no owner, admin or upgrade path. Whoever can sign for a vault's
;; current key controls it.

(use-trait pq-verifier .pq-verifier-trait.pq-verifier)

(define-constant ERR-NO-VAULT (err u200))
(define-constant ERR-KEY (err u201))
(define-constant ERR-VERIFIER (err u202))
(define-constant ERR-NONCE (err u203))
(define-constant ERR-BALANCE (err u204))
(define-constant ERR-SIGNATURE (err u205))
(define-constant ERR-EXISTS (err u206))

(define-map vaults (buff 32)
  {key: (buff 32), verifier: principal, nonce: uint, stx: uint, sbtc: uint})

(define-read-only (get-vault (id (buff 32)))
  (map-get? vaults id))

;; The id of the vault opened under `key` and checked by `verifier`.
(define-read-only (vault-id (key (buff 32)) (verifier principal))
  (sha256 (unwrap-panic (to-consensus-buff? {key: key, verifier: verifier}))))

;; What the owner signs. `nonce` is the vault's current nonce.
(define-read-only (withdrawal-digest
    (id (buff 32)) (nonce uint) (asset (string-ascii 4)) (amount uint) (recipient principal) (next-key (buff 32)))
  (sha256 (unwrap-panic (to-consensus-buff?
    {vault: current-contract, chain: chain-id, id: id, nonce: nonce,
     asset: asset, amount: amount, recipient: recipient, next-key: next-key}))))

;; Open a vault under `key`, checked by `verifier` for the vault's lifetime.
;; A key and verifier can open one vault, once.
(define-public (open (key (buff 32)) (verifier <pq-verifier>))
  (let ((id (vault-id key (contract-of verifier))))
    (asserts! (is-eq (len key) u32) ERR-KEY)
    (asserts! (map-insert vaults id {key: key, verifier: (contract-of verifier), nonce: u0, stx: u0, sbtc: u0}) ERR-EXISTS)
    (print {event: "open", id: id, key: key, verifier: (contract-of verifier)})
    (ok id)))

;; Anyone can deposit into any vault.
(define-public (deposit-stx (id (buff 32)) (amount uint))
  (let ((vault (unwrap! (map-get? vaults id) ERR-NO-VAULT)))
    (try! (stx-transfer? amount tx-sender current-contract))
    (map-set vaults id (merge vault {stx: (+ (get stx vault) amount)}))
    (print {event: "deposit", id: id, asset: "stx", amount: amount})
    (ok true)))

(define-public (deposit-sbtc (id (buff 32)) (amount uint))
  (let ((vault (unwrap! (map-get? vaults id) ERR-NO-VAULT)))
    (try! (contract-call? .sbtc-token transfer amount tx-sender current-contract none))
    (map-set vaults id (merge vault {sbtc: (+ (get sbtc vault) amount)}))
    (print {event: "deposit", id: id, asset: "sbtc", amount: amount})
    (ok true)))

;; Check a withdrawal, debit the vault and install the next key.
;;
;; The cheap checks run first because the signature check is the expensive
;; step, so a replayed request fails on its nonce before any hashing.
;;
;; The vault's new state is written before the verifier runs, so a verifier
;; that calls back into this contract sees it. A refused signature fails the
;; transaction and undoes the write.
;;
;; The verifier runs as this contract with no allowances. It has none of the
;; submitter's authority and cannot move this contract's assets.
(define-private (spend
    (id (buff 32)) (nonce uint) (asset (string-ascii 4)) (amount uint) (recipient principal)
    (next-key (buff 32)) (verifier <pq-verifier>) (sig (list 1024 (buff 32))))
  (let ((vault (unwrap! (map-get? vaults id) ERR-NO-VAULT))
        (key (get key vault))
        (is-stx (is-eq asset "stx"))
        (balance (if is-stx (get stx vault) (get sbtc vault))))
    (asserts! (is-eq (contract-of verifier) (get verifier vault)) ERR-VERIFIER)
    (asserts! (is-eq nonce (get nonce vault)) ERR-NONCE)
    (asserts! (and (is-eq (len next-key) u32) (not (is-eq next-key key))) ERR-KEY)
    (asserts! (and (> amount u0) (<= amount balance)) ERR-BALANCE)
    (map-set vaults id (merge vault {
      key: next-key,
      nonce: (+ nonce u1),
      stx: (if is-stx (- balance amount) (get stx vault)),
      sbtc: (if is-stx (get sbtc vault) (- balance amount))}))
    (asserts!
      (unwrap! (as-contract? ()
        (unwrap! (contract-call? verifier verify key
          (withdrawal-digest id nonce asset amount recipient next-key) sig) ERR-SIGNATURE))
        ERR-SIGNATURE)
      ERR-SIGNATURE)
    (print {event: "withdraw", id: id, nonce: nonce, asset: asset, amount: amount,
            recipient: recipient, next-key: next-key})
    (ok true)))

;; Anyone can submit a signed withdrawal. The funds go to the recipient the
;; owner signed for.
(define-public (withdraw-stx
    (id (buff 32)) (nonce uint) (amount uint) (recipient principal) (next-key (buff 32))
    (verifier <pq-verifier>) (sig (list 1024 (buff 32))))
  (begin
    (try! (spend id nonce "stx" amount recipient next-key verifier sig))
    (as-contract? ((with-stx amount)) (try! (stx-transfer? amount tx-sender recipient)))))

(define-public (withdraw-sbtc
    (id (buff 32)) (nonce uint) (amount uint) (recipient principal) (next-key (buff 32))
    (verifier <pq-verifier>) (sig (list 1024 (buff 32))))
  (begin
    (try! (spend id nonce "sbtc" amount recipient next-key verifier sig))
    (contract-call? .sbtc-token transfer amount current-contract recipient none)))
