---
type: concept
aliases: [RLHF, Reinforcement learning with human feedback]
summary: "A post-pre-training stage where human workers flag unhelpful or problematic model outputs, and those corrections tweak the parameters toward preferred responses."
tags: [ai, training, alignment]
created: 2026-09-25
updated: 2026-09-25
---

# Reinforcement learning from human feedback

## Definition
RLHF is a training stage applied after pre-training to convert a raw next-word predictor into a usable assistant. Human workers flag unhelpful or problematic predictions and their corrections further change the model's parameters so it becomes more likely to produce responses users prefer.

## Seen in
### [[videos/Large Language Models explained briefly|3Blue1Brown: Large Language Models explained briefly]] · 2026-09-25
- Human labellers flag bad predictions; corrections adjust parameters toward preferred outputs. [03:47](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=227s)

## Related
- [[concepts/Pre-training|Pre-training]]: the preceding stage; RLHF fixes its mismatch with assistant behavior.
- [[concepts/Large language model|Large language model]]: RLHF is what makes an LLM behave like a chatbot.
