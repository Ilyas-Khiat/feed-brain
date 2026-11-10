---
type: concept
aliases: [Transformer architecture, Transformers]
summary: "A 2017 neural network architecture that processes all tokens of an input in parallel and uses attention to let each token's representation be refined by context."
tags: [deep-learning, nlp, architecture]
created: 2026-09-25
updated: 2026-09-25
---

# Transformer

## Definition
The transformer is a neural network architecture introduced by Google researchers in 2017. Unlike earlier language models that processed text one word at a time, it ingests all tokens in parallel and repeatedly interleaves attention with feed-forward layers so each token's vector can be enriched by the surrounding context.

## Seen in
### [[videos/Large Language Models explained briefly|3Blue1Brown: Large Language Models explained briefly]] · 2026-09-25
- Introduced by Google in 2017; reads text in parallel rather than word-by-word. [04:32](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=272s)
- Alternates attention with feed-forward networks; only the last vector is used for the next-word prediction. [05:41](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=341s)

## Related
- [[concepts/Attention|Attention]]: the operation inside a transformer that lets tokens exchange information.
- [[concepts/Large language model|Large language model]]: transformers are the standard implementation of modern LLMs.
