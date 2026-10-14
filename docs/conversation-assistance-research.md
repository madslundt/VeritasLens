# Conversation assistance: product research

Research date: 2026-10-14. Scope: primary sources relevant to VeritasLens product direction. Recommendations below are product hypotheses, not validated outcomes for this app. No application code was changed.

## Published evidence

### The native product already covers the generic assistant baseline

Even's current Conversate documentation describes contextual cues (concepts, biographies, answers, suggestions), live transcription and translation, prepared notes including document imports, and saved sessions with summaries, cues, transcripts, and exports. Summary next steps can be added to QuickList. Cue expansion and display duration are configurable. These are documented capabilities, not an independent quality evaluation. [Even Support: Conversate](https://support.evenrealities.com/hc/en-us/articles/14273795154319-Conversate).

**Product inference:** more generic explanation, trivia, and summary lenses alone provide weak differentiation. VeritasLens should make its chosen-provider model, controlled analysis, precise task selection, evidence, and wearer goals useful in actual conversational decisions.

### An invisible screen does not imply an invisible attention cost

A three-week qualitative study of six Focals users reported distraction, social reactions, and difficulty splitting attention. Some conversation partners noticed reduced engagement. This small exploratory study used different glasses and predates current LLM assistance; it establishes design concerns, not an effect estimate for G2. [Orchard et al., *Augmented Reality Smart Glasses in Focus*, CHI EA 2022](https://criticalbydesign.ca/wp-content/uploads/2024/06/Augmented_Reality_Smart_Glasses_in_Focus.pdf).

A separate study with 32 participants in 16 pairs tested notification position and alignment during conversation on HoloLens. Aligning notifications with the conversation partner reduced perceived task load and intrusiveness. G2 lacks the corresponding spatial tracking, so that particular solution does not transfer directly. [Rzayev et al., NordiCHI 2020, author publication page](https://vali.de/en/publication/rzayev2020a/), [paper](https://vali.de/wp-content/uploads/2020/10/rufatNordiCHI2020.pdf).

**Product inference:** test one useful first cue, short glance time, expiry of outdated cues, quiet-mode controls, and details on demand. Do not assume that increasing output or automatic cue frequency improves usefulness. No study here establishes an ideal word count or timing threshold.

### Correction and dismissal are core interaction requirements

The CHI 2019 Human-AI Interaction guidelines cover contextual timing and relevance, efficient invocation, dismissal and correction, graceful narrowing under uncertainty, recent interaction memory, and global controls. They were evaluated across products with 49 design practitioners; they are design guidance rather than proof of a specific glasses flow. [Amershi et al., *Guidelines for Human-AI Interaction*](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf).

**Product inference:** a result should support “shorter,” “help me reply,” “explain that,” “wrong speaker/word,” or “not useful,” anchored to the same captured evidence. Returning to the lens picker and capturing a new audio window is a poor fit for correcting the previous result. A visible microphone pause/resume state and predictable dismissal also deserve priority.

### Meeting memory should answer specific questions and expose its evidence

QMSum defines query-focused meeting summarization: select relevant meeting spans and summarize them in response to a question. Its authors motivate this by the difficulty of covering every user's needs in one short general summary. [Zhong et al., NAACL 2021](https://aclanthology.org/2021.naacl-main.472/).

ExplainMeetSum adds evidence-sentence annotations that support summaries and evaluates evidence extraction. It does not establish guaranteed hallucination prevention. [Kim et al., ACL 2023](https://aclanthology.org/2023.acl-long.731/).

**Product inference:** “What did we decide?”, “What do I owe?”, and “What changed since the previous proposal?” are valuable memory operations. Preserve source snippets or timestamps, separate proposed actions from agreed commitments, and allow editing names and deadlines. Explicit absence is useful: “No deadline agreed.” Only answer from captured or deliberately supplied context.

### The device constrains what can be inferred and displayed

Even's developer overview specifies a 576×288 app display, monochrome green output, a single 16 kHz PCM microphone stream, touch gestures, and no camera or speaker. The consumer specification sheet reports different physical resolution figures; use the developer canvas for application layout. [Even Hub developer overview](https://hub.evenrealities.com/docs/get-started/overview), [consumer specifications](https://support.evenrealities.com/hc/en-us/articles/13499229138959-Specs).

**Product inference:** prioritize text comprehension and conversational repair. Do not promise visual emotion reading, eye-contact coaching, or reliable named-speaker attribution from this hardware stream alone. Preserve uncertainty around speaker identity and transcription.

## Recommended product experiments

1. **Goal-aware reply assistance:** one concise response or clarification question based on the latest exchange and an explicit wearer objective. Example: “Before I agree, who owns deployment and what is the deadline?” Extend Key Questions and Meeting Prep rather than immediately adding several narrowly different coaches.
2. **Commitments and decisions:** structured, editable session state for decision, proposal, owner, deadline, unresolved issue, and supporting utterance. Integrate with Summary and end-of-session review.
3. **Catch up and refine:** a fast catch-up request plus refinement of the same evidence, with concise initial output and optional detail.

Use the same capabilities under three session profiles: **Everyday** prioritizes follow-up questions, tactful replies, and recall; **Work** prioritizes prepared context, decisions, and commitments; **Understand** prioritizes captions, translation, concise explanations, and catch-up. A transcript retained for model context is not equivalent to live readable captions. Real-time captions need a separate latency, accuracy, and display experiment, especially with overlapping speakers and unclear names.

Keep Fact Check, Simplify, Translate, and goal-aware assistance easy to discover. Treat Fallacy, Framing, Devil's Advocate, Trivia, and Companion as optional specialist behavior until wearer studies show sustained value; the research does not justify deleting them outright.

Evaluate with conversation pairs, including the partner's experience. Measure useful-cue rate, time to useful first cue, stale/wrong interventions, ability to repair errors, recall of the actual conversation, and agreed-action accuracy. Compare the revised flows to current VeritasLens and native Conversate on the same tasks. Treat preferred cue size, timing, and lens consolidation as experiment results rather than assumed truths.
