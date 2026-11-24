import { SEQUENCE_ACTION_PROFILE } from './action-sequence.js';
import { ResearchModelError, researchNow, timedModel } from './common.js';

export function createCandidateScoreModel(config, score) {
  const { provider, model, connection_ref: connectionRef } = config;
  if (typeof score !== 'function' || !provider || !model || !connectionRef) {
    throw new TypeError('Candidate scoring requires an explicitly configured backend and connection');
  }
  const metadata = {
    provider, model, connection_ref: connectionRef, batch_mode: 'one-request-for-all-candidates',
    simulated: config.simulated === true,
  };
  return timedModel({ kind: 'candidate-score', ...metadata, timeout_ms: config.timeout_ms },
    async (input, signal) => {
      const startedAt = researchNow();
      const reply = await score({ ...input, signal });
      return {
        raw_response: reply ?? null,
        usage: reply?.usage ?? null,
        backend_metadata: {
          ...reply?.backend_metadata,
          ...metadata,
          candidate_count: input.candidates.length,
          transport_elapsed_ms: researchNow() - startedAt,
        },
      };
    },
    (reply, candidates, actionProfile) => {
      const scores = new Map();
      const invalid = () => new ResearchModelError('invalid_scores', 'Expected one finite score per candidate');
      if (!Array.isArray(reply?.scores) || reply.scores.length !== candidates.length) throw invalid();
      for (const row of reply.scores) {
        if (typeof row?.id !== 'string' || !Number.isFinite(row.score) || scores.has(row.id)) throw invalid();
        scores.set(row.id, row.score);
      }
      let best = null;
      let bestScore = -Infinity;
      for (const { id } of candidates) {
        if (!scores.has(id)) throw invalid();
        if (scores.get(id) > bestScore) {
          best = id;
          bestScore = scores.get(id);
        }
      }
      return actionProfile === SEQUENCE_ACTION_PROFILE ? [best] : best;
    },
    {
      metadata,
      transportKind: 'candidate_scorer',
      prepare: input => {
        if (input.image !== undefined) {
          throw new ResearchModelError('visual_backend_unsupported', 'The configured scorer supports text observations only');
        }
        return input;
      },
    },
  );
}
