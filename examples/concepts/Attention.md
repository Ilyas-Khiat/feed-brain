---
type: concept
aliases: [Attention mechanism, Self-attention]
summary: "The operation inside a transformer that lets every token's vector exchange information with every other token, refining each token's meaning from context."
tags: [deep-learning, nlp, architecture]
created: 2026-09-25
updated: 2026-09-25
---

# Attention

## Definition
Attention is the operation that gives a transformer its power. It lets each token's list of numbers "talk to" every other token in parallel and update itself based on the surrounding context, so a word like "bank" can be disambiguated to "riverbank" from the words nearby.

## Seen in
### [[videos/Large Language Models explained briefly|3Blue1Brown: Large Language Models explained briefly]] · 2026-09-25
- Lets token vectors exchange info in parallel; e.g. "bank" gets refined to "riverbank" from context. [04:54](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=294s)

## Related
- [[concepts/Transformer|Transformer]]: attention is its defining operation, interleaved with feed-forward layers.
