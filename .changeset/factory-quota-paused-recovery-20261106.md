---
'@mastra/factory': patch
---

Keep Factory work recoverable when a provider exhausts its quota. Persist the pause, honour a bounded provider retry deadline, and recheck through the existing leased dispatcher after restart without treating quota waits as engineering failures.
