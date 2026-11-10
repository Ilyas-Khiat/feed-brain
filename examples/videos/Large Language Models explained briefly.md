---
type: video
title: "Large Language Models explained briefly"
channel: "3Blue1Brown"
url: https://www.youtube.com/watch?v=LPZh9BOjkQs
video_id: LPZh9BOjkQs
published: 2024-11-20
duration: "07:58"
captured: 2026-09-25
verdict: watch
signal: 4
novelty: new
tags: [youtube, llm, transformers, deep-learning, ai]
---

# Large Language Models explained briefly

> [!tldr] Spoiler
> An LLM is a function that assigns probabilities to the next word; chatbots sample it repeatedly to complete a scripted dialogue. Transformers make this tractable by processing all tokens in parallel via attention.

## Key claims
- **LLMs pick the next word by sampling from a probability distribution, not by picking the top one, which is why the same prompt gives different answers.** [01:13](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=73s)
  - e.g. output looks more natural when the model occasionally picks less likely words at random.
- **Training the largest LLMs takes over 100 million years of compute at 1 billion ops/sec.** [03:03](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=183s)
  - e.g. GPT-3's training corpus alone would take a human 2,600 years to read non-stop.
- **Pre-training only teaches autocomplete; RLHF is a separate stage where human workers flag bad predictions to shape assistant behavior.** [03:47](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=227s)
- **Transformers process all words in parallel via attention, letting each word's vector be refined by context (e.g. "bank" → "riverbank").** [04:32](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=272s)

## Sources
- Google's 2017 transformer paper (introduced the transformer architecture) [04:32](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=272s)
- 3Blue1Brown deep learning series on transformers and attention [06:53](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=413s)

## Concepts
- [[concepts/Large language model|Large language model]] · new
- [[concepts/Transformer|Transformer]] · new
- [[concepts/Attention|Attention]] · new
- [[concepts/Pre-training|Pre-training]] · new
- [[concepts/Reinforcement learning from human feedback|Reinforcement learning from human feedback]] · new

## Verdict
**Watch** · signal 4/5 · novelty new · trust solid
The visuals are the value: this is a fluent, non-technical intro to LLMs, sampling, pre-training vs RLHF, and the transformer. Skim [04:32–05:41](https://www.youtube.com/watch?v=LPZh9BOjkQs&t=272s) if you only want the transformer/attention sketch.
