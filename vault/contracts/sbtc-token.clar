;; Stand-in for sbtc-token on simnet and testnet. The transfer check is the one
;; the mainnet contract makes, so a contract can send its own balance without
;; as-contract. On mainnet the vault would point at
;; SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token instead.

(define-fungible-token sbtc)

(define-constant ERR-NOT-OWNER (err u4))

(define-public (mint (amount uint) (to principal))
  (ft-mint? sbtc amount to))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR-NOT-OWNER)
    (try! (ft-transfer? sbtc amount sender recipient))
    (match memo to-print (print to-print) 0x)
    (ok true)))

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance sbtc who)))
