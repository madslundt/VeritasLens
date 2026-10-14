# Lens focus and validation

Each lens should provide the smallest useful output for its own task, anchored to the latest complete speech. Five claims is a ceiling, not a target. For claim-style lenses, clear speech can legitimately yield no result. An empty claims array means “nothing relevant for this lens”; `noSpeech=true` means no clear speech. These outcomes do not create history entries, and completed G2 analyses consume their audio snapshot. Translation retains its existing noSpeech flag for source-language filtering as well; its schema now permits empty reply starters on that path.

| Lens | Focus | Boundary |
| --- | --- | --- |
| Fact Check | Verify an exact factual assertion, including its numbers and qualifiers. | Changing facts need current evidence; uncertainty stays UNVERIFIED. |
| Trivia | Answer an explicit factual question directly. | Do not convert assertions or rhetorical questions into trivia. Omit weak answers. |
| Fallacy Check | Examine the relationship between premises and conclusion. | Disagreement, false facts, and emotion alone do not establish a fallacy. |
| Framing Check | Identify observable loaded wording or selective framing; offer a neutral restatement. | Do not infer hidden motives or vocal tone from text. Emotion alone is not bias. |
| Simplify | Explain the spoken concept in context using plain language. | Preserve qualifiers and causality; avoid adding advice or endorsing the claim. |
| Devil’s Advocate | Offer one credible counterargument to the latest position. | Represent the position fairly; do not invent evidence or create false balance. |
| Key Questions | Surface material unanswered questions for the next decision. | Do not re-ask answered questions or pad with generic follow-ups. |
| Companion | Add a supported, relevant fact, statistic, story, or connection. | Omit weak tidbits; do not force an anecdote because a topic exists. |
| Translate | Faithfully translate the latest complete utterance; optionally offer reply starters. | Do not answer the utterance or invent commitments for the wearer. |
| Meeting Prep | Answer the current question or proposal using prepared context. | Preserve source attribution; calculations require supplied inputs. Offers are not agreements. |
| Summary | Record what participants discussed, decided, and left unresolved. | Do not invent owners, deadlines, consensus, or completed actions. |
| Auto | Route current speech to an enabled lens according to the task. | Explicit explanation requests favor Simplify; unknown or disabled selections fail rather than silently becoming Fact Check. |

G2 flow now scopes deduplication to the selected lens and allows changed qualifiers, follow-ups, and explicit requests to revisit an answer. Translate and Meeting Prep have no hard prior-answer suppression. Auto skips classification when exactly one lens is enabled. With multiple candidates, the existing previous-winner speculation remains; misses can still cost an extra request.

Hands-free mode suppresses obvious filler, while substantive speech reaches the selected lens for semantic relevance checking. Translate and Meeting Prep also receive acknowledgments. This avoids false negatives from English keyword patterns, at the cost of more requests for speech that a specialized lens ultimately rejects. Voice detection and existing trigger timing still apply.

## Repeatable live evaluation

Unit tests verify parsing, routing constraints, relevance gating, empty-result handling, history, and audio cursor behavior. They do not measure model quality. Use these cases with recorded audio and the configured provider before claiming a quality or latency improvement:

| Input / scenario | Lens | Expected behavior |
| --- | --- | --- |
| “A kilometre is 100 metres.” | Fact Check / Auto | Correct to 1,000 metres; preserve the spoken number in the quote. |
| “Who wrote Hamlet?” | Trivia / Auto | Answer directly without producing follow-up questions. |
| “Explain compound interest in simple terms.” | Simplify / Auto | Explain compounding; avoid routing to fact verification. |
| “Her proposal fails because she dresses badly.” | Fallacy Check | Identify the irrelevant personal attack, with a tactful call-out. |
| “The engineer has relevant experience, so we should hear her assessment.” | Fallacy Check | Do not label expertise itself as a fallacy. |
| “I’m excited about this project.” | Framing Check | Avoid treating enthusiasm alone as bias. |
| “The parasites running this company.” | Framing Check | Identify the loaded label; neutralize it rather than escalating rhetoric. |
| A niche topic with no supported tidbit | Companion | Empty result rather than an invented story or statistic. |
| A Spanish acknowledgment, with Spanish selected as the source | Translate | Preserve and translate the acknowledgment. |
| Mortgage offer of 4.2% versus a prepared 4.8% rate, without balance | Meeting Prep | Give the 0.6 percentage point difference; do not invent monthly savings. |
| “Maybe Alex could send it Friday,” followed by disagreement | Summary | Record a proposal and disagreement, not an assigned task or agreement. |
| Revisit a topic through a different lens | G2 flow | The prior lens does not suppress the new task. |
| An unclear name, number, or clipped sentence | Every lens | Omit the uncertain content or acknowledge insufficient evidence. |
| Background music without clear speech | Every lens | No-speech feedback, without an answer or history entry. |

Compare the same recordings across Gemini, Claude, and the configured OpenAI-compatible host. Include English and Danish, multiple speakers, negative examples, changing facts, repeated topics, and cancellation. Score correct lens choice, groundedness, preserved qualifiers, usefulness of the first displayed item, false accusations, and time to first useful display. Record model IDs and grounding availability; model self-rated confidence is not an independently calibrated probability.

The shared prompts also apply to Ray-Ban, whose separate runtime still needs equivalent Auto and Meeting Prep dispatch before those special lenses have G2 feature parity. This change only adds handling of empty and no-speech results to that runtime.
