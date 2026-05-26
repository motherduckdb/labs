**Catalog Context — status**

Per Ryan's call in the thread: kept the naming axis but stripped `manual.md` from the prompt. Real warehouses don't ship with a cheat sheet.

Train (n=36):

- No prose, raw schema: **2/36 (5.6%)**
- No prose, named schema: **15/36 (41.7%)** — one shy of the with-manual baseline (16/36), at 55% the cost.

The sign reversed. Naming hurt with the manual loaded; it's the whole game without it.

Side-find: bumping reasoning from medium to high made it *worse* (-3 correct, +45% cost). Bottleneck isn't thinking; it's whether the schema told the model the answer.

Next: T1/T2 on the 418-Q test set (~$45, ~1hr/arm at c=16), then draft. Dropped the comments tier — too small to bother. Brief is updated.
