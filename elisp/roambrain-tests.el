;;; roambrain-tests.el --- ERT tests for roambrain.el  -*- lexical-binding: t; -*-

;; Run: emacs -Q --batch -L elisp -l elisp/roambrain-tests.el -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'json)
(add-to-list 'load-path
             (file-name-directory
              (or load-file-name buffer-file-name)))
(require 'roambrain)

;; --- Pure helpers ---

(ert-deftest roambrain-test-parse-link-line/with-title ()
  (should (equal (roambrain--parse-link-line "- [[id:abc][Hello]]")
                 (cons "id:abc" "Hello"))))

(ert-deftest roambrain-test-parse-link-line/no-title ()
  (should (equal (roambrain--parse-link-line "- [[id:abc]]")
                 (cons "id:abc" nil))))

(ert-deftest roambrain-test-parse-link-line/leading-whitespace ()
  (should (equal (roambrain--parse-link-line "   -   [[id:x][T]]")
                 (cons "id:x" "T"))))

(ert-deftest roambrain-test-parse-link-line/garbage ()
  (should-not (roambrain--parse-link-line "not a link"))
  (should-not (roambrain--parse-link-line "- [[bad]"))
  (should-not (roambrain--parse-link-line "")))

(ert-deftest roambrain-test-normalize-target/uppercase ()
  (should (equal (roambrain--normalize-target "ID:ABC123") "id:ABC123")))

(ert-deftest roambrain-test-normalize-target/passthrough ()
  (should (equal (roambrain--normalize-target "id:abc") "id:abc"))
  (should (equal (roambrain--normalize-target "https://x.test") "https://x.test")))

(ert-deftest roambrain-test-render-link/with-title ()
  (should (equal (roambrain--render-link '("id:a" . "T")) "- [[id:a][T]]")))

(ert-deftest roambrain-test-render-link/no-title ()
  (should (equal (roambrain--render-link '("id:a" . nil)) "- [[id:a]]"))
  (should (equal (roambrain--render-link '("id:a" . "")) "- [[id:a]]")))

(ert-deftest roambrain-test-upsert-link/insert ()
  (should (equal (roambrain--upsert-link nil "id:a" "A")
                 '(("id:a" . "A")))))

(ert-deftest roambrain-test-upsert-link/update-title ()
  (should (equal (roambrain--upsert-link '(("id:a" . "old")) "id:a" "new")
                 '(("id:a" . "new")))))

(ert-deftest roambrain-test-upsert-link/keep-old-title-when-nil ()
  (should (equal (roambrain--upsert-link '(("id:a" . "old")) "id:a" nil)
                 '(("id:a" . "old")))))

(ert-deftest roambrain-test-upsert-link/append-new ()
  (should (equal (roambrain--upsert-link '(("id:a" . "A")) "id:b" "B")
                 '(("id:a" . "A") ("id:b" . "B")))))

;; --- Buffer-driven helpers ---

(defmacro roambrain-test--with-buffer (text &rest body)
  (declare (indent 1))
  `(with-temp-buffer
     (insert ,text)
     (goto-char (point-min))
     ,@body))

(ert-deftest roambrain-test-top-properties/parses ()
  (roambrain-test--with-buffer
      ":PROPERTIES:\n:ID:      abc-123\n:FOO:     bar baz\n:END:\n#+title: T\n"
    (should (equal (roambrain--top-properties)
                   '(("ID" . "abc-123") ("FOO" . "bar baz"))))))

(ert-deftest roambrain-test-top-properties/missing ()
  (roambrain-test--with-buffer "#+title: T\n* Heading\n"
    (should (null (roambrain--top-properties)))))

(ert-deftest roambrain-test-find-h1/finds ()
  (roambrain-test--with-buffer "* Other\n* Related\nbody\n* Changelog\n"
    (should (numberp (roambrain--find-h1 "Related")))))

(ert-deftest roambrain-test-find-h1/with-tags ()
  (roambrain-test--with-buffer "* Related   :tag1:tag2:\n"
    (should (numberp (roambrain--find-h1 "Related")))))

(ert-deftest roambrain-test-find-h1/missing ()
  (roambrain-test--with-buffer "* Other\n"
    (should (null (roambrain--find-h1 "Related")))))

(ert-deftest roambrain-test-read-related-links/parses ()
  (roambrain-test--with-buffer
      "* Related\n- [[id:a][A]]\n- [[id:b]]\n* Changelog\n- entry\n"
    (should (equal (roambrain--read-related-links)
                   '(("id:a" . "A") ("id:b" . nil))))))

(ert-deftest roambrain-test-read-related-links/none ()
  (roambrain-test--with-buffer "* Body\n"
    (should (null (roambrain--read-related-links)))))

(ert-deftest roambrain-test-write-related-links/insert-before-changelog ()
  (roambrain-test--with-buffer "* Body\ntext\n* Changelog\n- old\n"
    (roambrain--write-related-links '(("id:a" . "A")))
    (let ((s (buffer-string)))
      (should (string-match-p "\\* Related\n- \\[\\[id:a\\]\\[A\\]\\]" s))
      (should (string-match-p "\\* Changelog" s))
      (should (< (string-match "\\* Related" s)
                 (string-match "\\* Changelog" s))))))

(ert-deftest roambrain-test-write-related-links/replace-existing ()
  (roambrain-test--with-buffer
      "* Related\n- [[id:a][A]]\n\n* Changelog\n"
    (roambrain--write-related-links '(("id:b" . "B")))
    (let ((s (buffer-string)))
      (should-not (string-match-p "id:a" s))
      (should (string-match-p "id:b" s)))))

(ert-deftest roambrain-test-write-related-links/remove-when-empty ()
  (roambrain-test--with-buffer
      "* Body\n* Related\n- [[id:a][A]]\n\n* Changelog\n"
    (roambrain--write-related-links nil)
    (should-not (string-match-p "Related" (buffer-string)))
    (should (string-match-p "Changelog" (buffer-string)))))

(ert-deftest roambrain-test-write-related-links/append-when-no-changelog ()
  (roambrain-test--with-buffer "* Body\n"
    (roambrain--write-related-links '(("id:a" . "A")))
    (should (string-match-p "\\* Related" (buffer-string)))))

(ert-deftest roambrain-test-round-trip-read-after-write ()
  (roambrain-test--with-buffer "* Body\n* Changelog\n"
    (roambrain--write-related-links '(("id:a" . "A") ("id:b" . nil)))
    (goto-char (point-min))
    (should (equal (roambrain--read-related-links)
                   '(("id:a" . "A") ("id:b" . nil))))))

(provide 'roambrain-tests)
;;; roambrain-tests.el ends here
