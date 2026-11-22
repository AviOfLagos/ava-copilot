# english-words.txt

About 83,000 English words and common names, one per line, lower case, letters only. Used by the vocabulary correction to tell a real
word ("ilium") from a misheard name ("illum"): a real word is never changed by itself.

- **Source:** SCOWL (Spell Checker Oriented Word Lists) 2020.12.07, <http://wordlist.aspell.net/>, files
  `english-words`, `american-words` and `british-words` at sizes 10, 20, 35, 40, 50, 55 and 60, plus the
  `*-proper-names` files at sizes 10 to 50 (common first names and places, so that "Ellen" is never taken for "Ellum").
  Abbreviations, contractions and words with punctuation are left out.
- **Licence:** SCOWL's own permissive licence (copy, modify and distribute for any purpose, keeping the notice), in
  `SCOWL-COPYRIGHT.txt`. Parts of SCOWL come from public-domain and permissively licensed lists named there.
- **Rebuild:** download the SCOWL tarball, take those files, lower-case them, keep `^[a-z]+$` (two letters or more, plus
  "a" and "i"), sort and de-duplicate.
