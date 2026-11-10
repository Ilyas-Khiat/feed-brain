---
type: concept
aliases: [Pretraining, LLM pre-training]
summary: "The first training stage of an LLM: parameters start random and are tuned via backpropagation to predict the next word across trillions of internet text examples."
tags: [ai, deep-learning, training]
created: 2026-09-25
updated: 2026-09-25
---

# Pre-training

## Definition
Pre-training is the first stage of building an LLM. Parameters start at random and are repeatedly nudged, via backpropagation on trillions of example passages, to make the true next word more likely and other words less likely. The goal is autocomplete of arbitrary text, not being an assistant.

## Seen in
### [[videos/Large Language Models explained briefly|3Blue1Brown: Large Language Models explained briefly]] · 2026-09-25
- Uses backpropagation to nudge parameters toward the true next word on many trillions of examples. [02:43](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=163s)
- Its goal (autocomplete random internet text) differs from being a helpful assistant, so RLHF follows. [03:47](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=227s)

## Related
- [[concepts/Reinforcement learning from human feedback|Reinforcement learning from human feedback]]: the follow-up stage that turns a pre-trained model into an assistant.
- [[concepts/Large language model|Large language model]]: pre-training is how the LLM's parameters are initially fit.
