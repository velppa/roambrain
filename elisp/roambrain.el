;;; roambrain.el --- Emacs-side helpers for RoamBrain  -*- lexical-binding: t; -*-

;; Copyright (C) 2025 Pavel Popov

;; Author: Pavel Popov
;; URL: https://github.com/velppa/VELPA
;; Version: 0.1.0
;; Package-Requires: ((emacs "30.1"))
;; Keywords: tools, workflow

;; This file is not part of GNU Emacs.

;; This program is free software; you can redistribute it and/or modify
;; it under the terms of the GNU General Public License as published by
;; the Free Software Foundation, either version 3 of the License, or
;; (at your option) any later version.

;; This program is distributed in the hope that it will be useful,
;; but WITHOUT ANY WARRANTY; without even the implied warranty of
;; MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
;; GNU General Public License for more details.

;; You should have received a copy of the GNU General Public License
;; along with this program.  If not, see <http://www.gnu.org/licenses/>.

;;; Commentary:

;; Helpers invoked by the RoamBrain TypeScript client over `emacsclient -e'.
;; Every public function returns a JSON-encoded string so the client can
;; round-trip values cleanly (no ad-hoc parsing of elisp printed-form).

;;; Code:

(require 'json)
(require 'subr-x)
(require 'cl-lib)
(require 'rx)

(defconst roambrain-changelog-heading "Changelog"
  "Top-level heading whose subtree is treated as the page's timeline.")

(defconst roambrain-related-heading "Related"
  "Top-level heading whose subtree holds outbound related links.")

(defcustom roambrain-executable "roambrain"
  "Path to the `roambrain' CLI binary."
  :type 'string
  :group 'roambrain)

(defcustom roambrain-db nil
  "Absolute path to the PGLite brain DB. When non-nil, exported as
`ROAMBRAIN_DB' for every CLI invocation. Nil = use CLI default
(~/.config/roambrain/brain.pglite)."
  :type '(choice (const :tag "Default (brain.pglite)" nil) string)
  :group 'roambrain)

;; --- Internal helpers ---

(defun roambrain--top-properties ()
  "Parse the top-of-buffer :PROPERTIES: drawer, return alist of (KEY . VALUE)."
  (let (acc)
    (save-excursion
      (goto-char (point-min))
      (when (looking-at (rx bol ":PROPERTIES:" (* (any " \t")) "\n"))
        (let ((pend (save-excursion
                      (re-search-forward
                       (rx bol ":END:" (* (any " \t")) eol) nil t))))
          (when pend
            (forward-line 1)
            (while (re-search-forward
                    (rx bol ":" (group (+ (not (any ":")))) ":"
                        (+ (any " \t")) (group (* nonl)) eol)
                    pend t)
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
    (json-encode secret)))

;; --- Related-links editor ---

(defun roambrain--find-h1 (heading-text)
  "Search forward from point-min for an H1 line `* HEADING-TEXT'.
Leaves point at the heading line and returns its beginning, or nil."
  (goto-char (point-min))
  (let ((re (rx-to-string
             `(seq bol "* " ,heading-text
                   (? (+ (any " \t")) ":" (* (not (any "\n"))) ":")
                   (* (any " \t")) eol)
             t)))
    (when (re-search-forward re nil t)
      (line-beginning-position))))

(defun roambrain--related-bounds ()
  "Return (HEAD-BEG . SUBTREE-END) covering the * Related heading + body, or nil."
  (save-excursion
    (when (roambrain--find-h1 roambrain-related-heading)
      (let ((head-beg (line-beginning-position))
            (subtree-end (save-excursion
                           (forward-line 1)
                           (if (re-search-forward (rx bol "* ") nil t)
                               (line-beginning-position)
                             (point-max)))))
        (cons head-beg subtree-end)))))

(defun roambrain--parse-link-line (line)
  "Parse `- [[TARGET][TITLE]]' or `- [[TARGET]]'. Return (TARGET . TITLE) or nil."
  (cond
   ((string-match (rx string-start (* (any " \t")) "-" (+ (any " \t"))
                      "[[" (group (+ (not (any "][")))) "]"
                      "[" (group (+ (not (any "][")))) "]]"
                      (* (any " \t")) string-end)
                  line)
    (cons (match-string 1 line) (match-string 2 line)))
   ((string-match (rx string-start (* (any " \t")) "-" (+ (any " \t"))
                      "[[" (group (+ (not (any "][")))) "]]"
                      (* (any " \t")) string-end)
                  line)
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
   ((string-match (rx string-start "ID:" (group (+ nonl)) string-end) target)
    (concat "id:" (match-string 1 target)))
   (t target)))

(defun roambrain--upsert-link (links target title)
  (let* ((found nil)
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
                    (when (string-match (rx string-start "id:" (group (+ nonl)) string-end) normalized)
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

;; --- CLI bridge ---

(defun roambrain--call-tool (tool params)
  "Invoke `roambrain call TOOL JSON' and return parsed JSON.
PARAMS is an alist; passed to the CLI as JSON. Signals on non-zero exit."
  (let* ((json-params (json-encode (or params '())))
         (out-buf (generate-new-buffer " *roambrain-call*"))
         (err-file (make-temp-file "roambrain-err-"))
         (process-environment
          (let ((env process-environment))
            (when roambrain-db
              (push (concat "ROAMBRAIN_DB=" (expand-file-name roambrain-db)) env))
            (when (and (boundp 'org-roam-db-location) org-roam-db-location)
              (push (concat "ROAMBRAIN_ORG_ROAM_DB="
                            (expand-file-name org-roam-db-location))
                    env))
            env))
         exit)
    (unwind-protect
        (progn
          (setq exit (call-process roambrain-executable nil
                                   (list out-buf err-file) nil
                                   "call" tool json-params))
          (unless (zerop exit)
            (error "roambrain call %s exit %d: %s"
                   tool exit
                   (with-temp-buffer
                     (insert-file-contents err-file)
                     (buffer-string))))
          (with-current-buffer out-buf
            (goto-char (point-min))
            (let ((json-object-type 'alist)
                  (json-array-type 'list)
                  (json-key-type 'symbol)
                  (json-false nil)
                  (json-null nil))
              (json-read))))
      (kill-buffer out-buf)
      (delete-file err-file))))

;;;###autoload
(cl-defun roambrain-query (query &key (limit 20) tag (offset 0))
  "Run RoamBrain `query' search for QUERY. Return parsed result (alist).
Keys: :limit (default 20, max 100), :tag, :offset (default 0)."
  (interactive
   (list (read-string "RoamBrain query: ")
         :limit (if current-prefix-arg (read-number "Limit: " 20) 20)))
  (let ((params `(("query"  . ,query)
                  ("limit"  . ,limit)
                  ("offset" . ,offset))))
    (when (and tag (not (string-empty-p tag)))
      (setq params (append params `(("tag" . ,tag)))))
    (let ((result (roambrain--call-tool "query" params)))
      (when (called-interactively-p 'any)
        (with-current-buffer (get-buffer-create "*RoamBrain Query*")
          (erase-buffer)
          (insert (pp-to-string result))
          (goto-char (point-min))
          (display-buffer (current-buffer))))
      result)))

(provide 'roambrain)
;;; roambrain.el ends here
