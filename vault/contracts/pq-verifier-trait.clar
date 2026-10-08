;; A signature check the vault can call.
;;
;; `key` is the 32-byte commitment the vault stores, `digest` is the 32-byte
;; message, and `sig` is the signature as 32-byte words. A verifier returns
;; (ok true) for a valid signature and (ok false) for anything else.
;;
;; 1024 words is room for the schemes we expect to add: WOTS+ uses 68, Lamport
;; uses 512, and SLH-DSA-SHA2-256s would use 931.

(define-trait pq-verifier
  ((verify ((buff 32) (buff 32) (list 1024 (buff 32))) (response bool uint))))
