Operating Rules:
- do not wrap trivial expressions as helpers, if it's one expression inline it rather than extract even if it repeats elsewhere
- Do not write fetch and throw wrappers, inline them
- Functions need to mean something and have clear lifecycle role, they must be verbs rather than nouns. Functions must not hide branches, orchestration belongs at call site.

If you are uncertain about something, task is ambigous ask a question do not assume
Never edit .md files
