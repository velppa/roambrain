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
(require 'cl-lib)

(defconst roambrain-changelog-heading "Changelog"
  "Top-level heading whose subtree is treated as the page's timeline.")

(defconst roambrain-related-heading "Related"
  "Top-level heading whose subtree holds outbound related links.")

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

;;;###autoload
(defun roambrain-openai-key (&optional host login)
  "JSON-encoded OpenAI API key from auth-source, or empty.
Defaults: HOST=\"api.openai.com\", LOGIN=\"hotter-token\"."
  (require 'auth-source)
  (let* ((h (or host "api.openai.com"))
         (l (or login "hotter-token"))
         (pair (auth-source-user-and-password h l))
         (secret (cadr pair)))
    (json-encode (or (and (functionp secret) (funcall secret))
                     secret
                     ""))))

;; --- Related-links editor ---

(defun roambrain--find-h1 (heading-text)
  "Search forward from point-min for an H1 line `* HEADING-TEXT'.
Leaves point at the heading line and returns its beginning, or nil."
  (goto-char (point-min))
  (let ((re (format "^\\* %s\\(?:[ \t]+:[^\n]*:\\)?[ \t]*$"
                    (regexp-quote heading-text))))
    (when (re-search-forward re nil t)
      (line-beginning-position))))

(defun roambrain--related-bounds ()
  "Return (HEAD-BEG . SUBTREE-END) covering the * Related heading + body, or nil."
  (save-excursion
    (when (roambrain--find-h1 roambrain-related-heading)
      (let ((head-beg (line-beginning-position))
            (subtree-end (save-excursion
                           (forward-line 1)
                           (if (re-search-forward "^\\* " nil t)
                               (line-beginning-position)
                             (point-max)))))
        (cons head-beg subtree-end)))))

(defun roambrain--parse-link-line (line)
  "Parse `- [[TARGET][TITLE]]' or `- [[TARGET]]'. Return (TARGET . TITLE) or nil."
  (cond
   ((string-match "\\`[ \t]*-[ \t]+\\[\\[\\([^][]+\\)\\]\\[\\([^][]+\\)\\]\\][ \t]*\\'" line)
    (cons (match-string 1 line) (match-string 2 line)))
   ((string-match "\\`[ \t]*-[ \t]+\\[\\[\\([^][]+\\)\\]\\][ \t]*\\'" line)
    (cons (match-string 1 line) nil))))

(defun roambrain--read-related-links ()
  "Return a list of (TARGET . TITLE) parsed from the * Related body."
  (let ((bounds (roambrain--related-bounds)))
    (when bounds
      (let* ((text (buffer-substring-no-properties (car bounds) (cdr bounds)))
             acc)
        (dolist (line (split-string text "\n"))
          (let ((p (roambrain--parse-link-line line)))
            (when p (push p acc))))
        (nreverse acc)))))

(defun roambrain--render-link (entry)
  (let ((target (car entry)) (title (cdr entry)))
    (if (and title (not (string-empty-p title)))
        (format "- [[%s][%s]]" target title)
      (format "- [[%s]]" target))))

(defun roambrain--write-related-links (links)
  "Replace (or remove) the * Related subtree to contain LINKS.
If LINKS is empty and the heading exists, the whole subtree is removed.
If LINKS is non-empty and the heading is missing, insert it before
* Changelog (or at end of buffer)."
  (let ((bounds (roambrain--related-bounds)))
    (cond
     ((and bounds (null links))
      (delete-region (car bounds) (cdr bounds)))
     (bounds
      (let ((body (mapconcat #'roambrain--render-link links "\n")))
        (delete-region (car bounds) (cdr bounds))
        (goto-char (car bounds))
        (insert (format "* %s\n%s\n\n" roambrain-related-heading body))))
     (links
      (let* ((body (mapconcat #'roambrain--render-link links "\n"))
             (insert-pt (save-excursion
                          (or (and (roambrain--find-h1 roambrain-changelog-heading)
                                   (line-beginning-position))
                              (point-max)))))
        (goto-char insert-pt)
        (unless (or (bobp)
                    (save-excursion (forward-char -1) (bolp)))
          (insert "\n"))
        (insert (format "* %s\n%s\n\n" roambrain-related-heading body)))))))

(defun roambrain--normalize-target (target)
  "Lowercase the `id:' / `ID:' scheme; otherwise return TARGET unchanged."
  (cond
   ((string-match "\\`ID:\\(.+\\)\\'" target) (concat "id:" (match-string 1 target)))
   (t target)))

(defun roambrain--upsert-link (links target title)
  (let ((found nil)
        (out (mapcar (lambda (e)
                       (if (string= (car e) target)
                           (progn (setq found t)
                                  (cons target (or title (cdr e))))
                         e))
                     links)))
    (if found out (append out (list (cons target title))))))

;;;###autoload
(defun roambrain-add-link (from-id target &optional title)
  "Add a related link from FROM-ID's page to TARGET (with optional TITLE).
Inserts/updates a `* Related' H1 placed before `* Changelog', saves the
buffer, and runs `org-roam-db-sync'. Returns JSON-encoded t."
  (require 'org-roam)
  (let* ((node (org-roam-node-from-id from-id))
         (file (and node (org-roam-node-file node))))
    (unless file (error "roambrain-add-link: unknown node id %s" from-id))
    (with-current-buffer (find-file-noselect file)
      (save-restriction
        (widen)
        (let* ((normalized (roambrain--normalize-target target))
               (resolved-title
                (or (and title (not (string-empty-p title)) title)
                    (when (string-match "\\`id:\\(.+\\)\\'" normalized)
                      (let ((tnode (org-roam-node-from-id (match-string 1 normalized))))
                        (and tnode (org-roam-node-title tnode))))))
               (existing (roambrain--read-related-links))
               (updated  (roambrain--upsert-link existing normalized resolved-title)))
          (roambrain--write-related-links updated)
          (save-buffer)))))
  (org-roam-db-sync)
  (json-encode t))

;;;###autoload
(defun roambrain-remove-link (from-id target)
  "Remove the related link from FROM-ID's page to TARGET (matched by target).
Saves the buffer and runs `org-roam-db-sync'. Returns JSON-encoded t."
  (require 'org-roam)
  (let* ((node (org-roam-node-from-id from-id))
         (file (and node (org-roam-node-file node))))
    (unless file (error "roambrain-remove-link: unknown node id %s" from-id))
    (with-current-buffer (find-file-noselect file)
      (save-restriction
        (widen)
        (let* ((normalized (roambrain--normalize-target target))
               (existing (roambrain--read-related-links))
               (filtered (cl-remove-if (lambda (e) (string= (car e) normalized)) existing)))
          (roambrain--write-related-links filtered)
          (save-buffer)))))
  (org-roam-db-sync)
  (json-encode t))

;;;###autoload
(defun roambrain-write-result (path expr-string)
  "Eval EXPR-STRING (which must return a string), write it to PATH.
Used to bypass emacsclient's broken framing for large outputs.
Returns JSON-encoded t on success."
  (let ((result (eval (car (read-from-string expr-string)) t)))
    (with-temp-file path
      (set-buffer-file-coding-system 'utf-8-unix)
      (insert (if (stringp result) result (format "%S" result)))))
  (json-encode t))

(provide 'roambrain)
;;; roambrain.el ends here
