import { createCandidateScoreModel } from './candidate-score.js';
import { createOpenAIDecisionsModel } from './decisions.js';
import { createGenerativeModel } from './generative.js';
import { createMockModel } from './mock.js';

export { getResearchModelStatus } from './provider-http.js';

export function createResearchModel(config, options = {}) {
  switch (config?.kind) {
    case 'mock':
    case 'fixed':
    case 'random':
    case 'rule':
      return createMockModel(config);
    case 'generative':
      return createGenerativeModel(config);
    case 'openai-decisions':
      return createOpenAIDecisionsModel(config);
    case 'candidate-score':
      return createCandidateScoreModel(config, options.score);
    default:
      throw new TypeError('Unknown research model');
  }
}
