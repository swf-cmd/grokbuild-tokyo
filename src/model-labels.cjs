'use strict';

// Verified 2026-09-07 with Grok Build 1.0.13 using grok.com authentication:
// ACP selects grok-4, while turn_completed.usage.modelUsage and the assistant's
// persisted model_id identify grok-4.3. The public retirement guide corroborates
// the older Grok 4 model's migration: https://docs.x.ai/developers/migration/may-15-retirement
// This is a display fallback for the legacy picker label only. Never substitute
// the request ID, override a newer explicit CLI name, or infer other aliases.
const VERIFIED_LEGACY_ALIAS = Object.freeze({ id: 'grok-4', resolvedModelId: 'grok-4.3', verifiedAt: '2026-09-07' });

function isLegacyGrok4Label(model) {
  const id = model?.modelId || model?.id;
  const label = model?.cliName || model?.name || id;
  return id === VERIFIED_LEGACY_ALIAS.id && /^(?:grok[- ]?4)$/i.test(label);
}

function displayModelId(id) {
  return id.replace(/^grok-/i, 'Grok ');
}

function labelModel(model, observedModelId) {
  const id = model.modelId || model.id;
  const cliName = model.cliName || model.name || id;
  const result = { ...model, id, modelId: id, name: cliName, cliName };
  // A modern/custom model label is authoritative; do not apply a mapping based
  // solely on an ID that a user may also use in a custom provider configuration.
  if (!isLegacyGrok4Label(result)) {
    delete result.resolvedModelId;
    delete result.modelIdentitySource;
    delete result.modelIdentityVerifiedAt;
    return result;
  }
  const resolvedModelId = observedModelId || VERIFIED_LEGACY_ALIAS.resolvedModelId;
  return {
    ...result,
    name: `${displayModelId(resolvedModelId)} (${id})`,
    resolvedModelId,
    modelIdentitySource: observedModelId ? 'usage' : 'verified-alias',
    modelIdentityVerifiedAt: observedModelId ? undefined : VERIFIED_LEGACY_ALIAS.verifiedAt,
  };
}

// Per-turn usage can include multiple models (for example, subagents). Only a
// single identified model can establish the route for this session's selection.
function servedModelFromUsage(usage) {
  const modelUsage = usage?.modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return undefined;
  const ids = Object.keys(modelUsage);
  return ids.length === 1 && /^grok-[a-z0-9][a-z0-9._-]*$/i.test(ids[0]) ? ids[0] : undefined;
}

module.exports = { labelModel, isLegacyGrok4Label, servedModelFromUsage };
