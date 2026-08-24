/**
 * The crypto model pool.
 *
 * SEVEN OF NINE: the plan's crypto ensemble (§10) is nine models. The seven
 * quantitative ones live here and run today. The remaining two — the
 * SENTIMENT model (entity-level news sentiment) and the MACRO model (rates,
 * dollar index, risk appetite) — depend on the news engine and the FRED
 * pipeline that arrive in a later phase (plan §17, phases 4 and 8). They will
 * be appended to this array and nothing else changes: the ensemble combiner,
 * the skill-weighting and the prediction builder are all agnostic to pool
 * size, and until then those models are simply absent rather than stubbed —
 * a stub emitting 50% would be a fabricated vote (see engines/model.ts).
 */

import type { PredictionModel } from '@/engines/model'
import type { CryptoFeatures } from '../features'
import { technicalModel } from './technical'
import { momentumModel } from './momentum'
import { structureModel } from './structure'
import { orderflowModel } from './orderflow'
import { derivativesModel } from './derivatives'
import { volatilityRegimeModel } from './volatility-regime'
import { meanReversionModel } from './meanreversion'

export const CRYPTO_MODELS: readonly PredictionModel<CryptoFeatures>[] = [
  technicalModel,
  momentumModel,
  structureModel,
  orderflowModel,
  derivativesModel,
  volatilityRegimeModel,
  meanReversionModel,
]

export { technicalModel } from './technical'
export { momentumModel } from './momentum'
export { structureModel } from './structure'
export { orderflowModel } from './orderflow'
export { derivativesModel } from './derivatives'
export { volatilityRegimeModel } from './volatility-regime'
export { meanReversionModel } from './meanreversion'
export { UP_DOWN_KEYS } from './shared'
