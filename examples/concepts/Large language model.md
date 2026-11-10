---
type: concept
aliases: [LLM, Large language models]
summary: "A mathematical function with billions of parameters that assigns a probability to every possible next word given a piece of text, trained on huge text corpora."
tags: [ai, nlp, deep-learning]
created: 2026-09-25
updated: 2026-09-25
---

# Large language model

## Definition
A large language model is a function, usually parameterised by hundreds of billions of tunable weights, that maps a piece of text to a probability distribution over the next word. Chatbots are built by seeding it with a scripted user/assistant dialogue and sampling the next word repeatedly.

## Seen in
### [[videos/Large Language Models explained briefly|3Blue1Brown: Large Language Models explained briefly]] · 2026-09-25
- Same prompt gives different answers because output is sampled, not the top-1 word. [01:13](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=73s)
- Training the largest LLMs would take >100 million years at 1 billion ops/sec. [03:03](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=183s)

## Related
- [[concepts/Transformer|Transformer]]: the dominant architecture used to implement modern LLMs.
- [[concepts/Pre-training|Pre-training]]: the first phase where LLM parameters are tuned on internet text.
- [[concepts/Reinforcement learning from human feedback|Reinforcement learning from human feedback]]: post-training stage that turns a raw LLM into an assistant.
