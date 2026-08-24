/**
 * THE LLM SEAM (plan §12).
 *
 * No LLM API key exists in this deployment, so every language-adjacent task in
 * the news engine runs on deterministic mechanisms that are labelled as what
 * they are: extractive "summaries" (the article's own lead), dictionary NER,
 * lexicon sentiment, TF-IDF clustering. This file is the single seam where a
 * real language model slots in later — implement the interface, wire it into
 * the orchestrator, and each deterministic mechanism becomes the fallback
 * rather than the only path.
 *
 * TWO RULES that survive the upgrade, enforced by these types:
 *
 *   1. The LLM NEVER produces or adjusts a probability or an importance score
 *      (plan §12: no code path from an LLM string to a numeric signal). Note
 *      the absence of any numeric-score field below.
 *   2. LLM outputs augment, never replace, the deterministic provenance: a
 *      generated summary is displayed AS a generated summary, and the
 *      extractive fallback remains available.
 *
 * TODO(llm): implement against a provider once a key ships. Candidate wiring:
 * `lib/ai/` adapter → NewsLanguageModel → NewsOrchestrator constructor param.
 */

export interface LlmEntityCandidate {
  /** Canonical name as the model understood it. */
  readonly name: string
  /** Best-effort mapping onto the curated dictionary id, null when novel. */
  readonly dictionaryId: string | null
}

export interface LlmClusterSummary {
  /** 1–2 sentence abstractive summary of the cluster. */
  readonly text: string
  /** Must be true — the UI labels generated text as generated. */
  readonly generated: true
}

export interface NewsLanguageModel {
  /**
   * Recall-upgrade for entity extraction (entities.ts is high-precision,
   * dictionary-limited). Results are MERGED with dictionary matches.
   */
  extractEntities(text: string): Promise<readonly LlmEntityCandidate[]>

  /**
   * Abstractive cluster summary to replace the extractive headline+lead.
   * Displayed with a "generated" label; never silently swapped in.
   */
  summarizeCluster(params: {
    readonly headlines: readonly string[]
    readonly leads: readonly (string | null)[]
  }): Promise<LlmClusterSummary>

  /**
   * Dense embeddings to replace TF-IDF token vectors in cluster.ts. Same
   * cosine machinery, better recall on paraphrases.
   */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}
