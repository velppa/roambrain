;;; roambrain.el --- Emacs-side helpers for RoamBrain  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Pavel Popov
;; License: MIT

;;; Commentary:

;; Helpers invoked by the RoamBrain TypeScript client over `emacsclient -e'.
;; Every public function returns a JSON-encoded string so the client can
;; round-trip values cleanly (no ad-hoc parsing of elisp printed-form).

;;; Code:

(require 'json)
(require 'subr-x)

(defconst roambrain-changelog-heading "Changelog"
  "Top-level heading whose subtree is treated as the page's timeline.")

;; --- Internal helpers ---

(defun roambrain--top-properties ()
  "Parse the top-of-buffer :PROPERTIES: drawer, return alist of (KEY . VALUE)."
  (let (acc)
    (save-excursion
      (goto-char (point-min))
      (when (looking-at "^:PROPERTIES:[ \t]*\n")
        (let ((pend (save-excursion
                      (re-search-forward "^:END:[ \t]*$" nil t))))
          (when pend
            (forward-line 1)
            (while (re-search-forward
                    "^:\\([^:]+\\):[ \t]+\\(.*\\)$" pend t)
              (push (cons (match-string-no-properties 1)
                          (match-string-no-properties 2))
                    acc))))))
    (nreverse acc)))

(defun roambrain--split-changelog ()
  "Return (TRUTH . TIMELINE) strings for the current Org buffer.
TRUTH is the buffer minus the first level-1 `Changelog' heading
subtree; TIMELINE is the body of that heading (without the heading line)."
  (require 'org)
  (require 'org-element)
  (let* ((tree (org-element-parse-buffer))
         (changelog nil))
    (org-element-map tree 'headline
      (lambda (hl)
        (when (and (= 1 (org-element-property :level hl))
                   (string= roambrain-changelog-heading
                            (org-element-property :raw-value hl))
                   (not changelog))
          (setq changelog hl))))
    (if changelog
        (let* ((b  (org-element-property :begin changelog))
               (e  (org-element-property :end   changelog))
               (cb (org-element-property :contents-begin changelog))
               (ce (org-element-property :contents-end   changelog))
               (timeline (if (and cb ce)
                             (string-trim
                              (buffer-substring-no-properties cb ce))
                           ""))
               (truth (string-trim
                       (concat (buffer-substring-no-properties (point-min) b)
                               (buffer-substring-no-properties e (point-max))))))
          (cons truth timeline))
      (cons (string-trim (buffer-substring-no-properties (point-min) (point-max)))
            ""))))

;; --- Public API (all return JSON strings) ---

;;;###autoload
(defun roambrain-org-roam-directory ()
  "JSON-encoded string with `org-roam-directory' (or empty)."
  (json-encode
   (or (and (boundp 'org-roam-directory) org-roam-directory) "")))

;;;###autoload
(defun roambrain-org-roam-db-location ()
  "JSON-encoded absolute path to the org-roam SQLite DB (or empty)."
  (json-encode
   (or (and (boundp 'org-roam-db-location)
            (expand-file-name org-roam-db-location))
       "")))

;;;###autoload
(defun roambrain-org-roam-db-sync ()
  "Run `org-roam-db-sync'. Return JSON-encoded t."
  (require 'org-roam)
  (org-roam-db-sync)
  (json-encode t))

;;;###autoload
(defun roambrain-node-file (id)
  "JSON-encoded absolute file path for org-roam node ID, or empty."
  (require 'org-roam)
  (let* ((node (org-roam-node-from-id id))
         (file (and node (org-roam-node-file node))))
    (json-encode (or file ""))))

;;;###autoload
(defun roambrain-node-contents (id)
  "JSON-encoded full text of the file containing org-roam node ID."
  (require 'org-roam)
  (let* ((node (org-roam-node-from-id id))
         (file (and node (org-roam-node-file node))))
    (json-encode
     (if (and file (file-readable-p file))
         (with-current-buffer (find-file-noselect file)
           (save-restriction
             (widen)
             (buffer-substring-no-properties (point-min) (point-max))))
       ""))))

;;;###autoload
(defun roambrain-read-file (path)
  "JSON-encoded full text of PATH (via Emacs find-file-noselect)."
  (json-encode
   (with-current-buffer (find-file-noselect path)
     (save-restriction
       (widen)
       (buffer-substring-no-properties (point-min) (point-max))))))

;;;###autoload
(defun roambrain-parse-file (path)
  "JSON-encode a plist describing the Org page at PATH.
Plist keys: :title :tags :properties :compiled_truth :timeline."
  (with-current-buffer (find-file-noselect path)
    (require 'org)
    (save-restriction
      (widen)
      (let* ((kws (org-collect-keywords '("TITLE" "FILETAGS")))
             (title (car (cdr (assoc "TITLE" kws))))
             (filetags (car (cdr (assoc "FILETAGS" kws))))
             (tags (and filetags (split-string filetags ":" t)))
             (props (roambrain--top-properties))
             (split (roambrain--split-changelog)))
        (json-encode
         (list :title (or title "")
               :tags  (or tags  [])
               :properties (or props [])
               :compiled_truth (car split)
               :timeline       (cdr split)))))))

(provide 'roambrain)
;;; roambrain.el ends here
